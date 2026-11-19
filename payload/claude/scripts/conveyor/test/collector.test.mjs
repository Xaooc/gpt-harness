import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { processAlive, readProcessStat } from '../lib/platform.mjs';
import { run } from '../../lib/supervised-run.mjs';

const execute = promisify(execFile);
const sources = fileURLToPath(new URL('../../', import.meta.url));
const timeout = 300_000;

async function json(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function until(read, accept, description, ms = 15_000) {
  const deadline = performance.now() + ms;
  do {
    const value = await read();
    if (accept(value)) return value;
    await sleep(30);
  } while (performance.now() < deadline);
  assert.fail(`timed out waiting for ${description}`);
}

async function fixture(work, { realOverview = false, hangUsage = false, sessionFaults = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'luna-collector-test-'));
  const claude = path.join(root, '.claude'), scripts = path.join(claude, 'scripts'), sessions = path.join(claude, 'sessions');
  const runDir = path.join(root, 'run'), directory = path.join(runDir, 'collector');
  const discovery = path.join(directory, 'discovery.json');
  const lock = path.join(claude, 'luna-run', 'collector', 'collector.lock');
  const snapshot = path.join(directory, 'snapshot.json'), cli = path.join(scripts, 'luna-collector.mjs');
  const env = { ...process.env, HOME: root, USERPROFILE: root, LUNA_RUN_DIR: runDir,
    CONVEYOR_HOME: path.join(claude, 'conveyor'), CLAUDE_HOME_DIR: claude, CODEX_HOME: path.join(root, '.codex') };
  for (const name of ['CONVEYOR_PLATFORM', 'LUNA_OVERVIEW_HOME', 'LUNA_DAEMON_HOME', 'LUNA_COLLECTOR_LOCK_RETRY_MS']) delete env[name];
  const command = async (action, options = {}) => {
    const { stdout } = await execute(process.execPath, [cli, action], { env, windowsHide: true, timeout, ...options });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const request = (info, route, options = {}) => fetch(`http://127.0.0.1:${info.port}${route}`, {
    signal: AbortSignal.timeout(5000), ...options
  });
  const discover = () => until(() => json(discovery), Boolean, 'discovery');
  const snapshotWhen = (accept) => until(() => json(snapshot), accept, 'snapshot');
  const clock = path.join(root, 'clock'), audit = path.join(root, 'audit'), preload = path.join(root, 'preload.mjs');
  let launched;
  let advanceMs = 0;
  const advance = async (ms) => {
    advanceMs += ms;
    await fs.writeFile(clock, String(advanceMs));
  };
  const launch = () => {
    const child = spawn(process.execPath, ['--import', preload, cli, 'run'], { env, windowsHide: true, stdio: 'ignore' });
    launched = { child, closed: once(child, 'close') };
    return launched;
  };
  try {
    await Promise.all([sessions, directory, path.dirname(lock)].map(dir => fs.mkdir(dir, { recursive: true })));
    const files = ['luna-collector.mjs', 'conveyor/lib/platform.mjs', 'conveyor/lib/sessions.mjs'];
    if (process.platform === 'win32') files.push('lib/process-identity.mjs');
    if (realOverview) {
      await Promise.all(['conveyor', 'lib', 'learning'].map(name => fs.cp(path.join(sources, name),
        path.join(scripts, name), { recursive: true })));
      await fs.mkdir(path.join(claude, 'conveyor'), { recursive: true });
      await fs.copyFile(new URL('../../../conveyor/orchestration.default.json', import.meta.url),
        path.join(claude, 'conveyor', 'orchestration.default.json'));
      files.push('luna-overview.mjs');
    }
    for (const name of files) {
      const file = path.join(scripts, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(path.join(sources, name), file);
    }
    if (sessionFaults) {
      const sessionsModule = path.join(scripts, 'conveyor/lib/sessions.mjs');
      await fs.rename(sessionsModule, path.join(path.dirname(sessionsModule), 'sessions-original.mjs'));
      await fs.writeFile(sessionsModule, `
        import { appendFileSync } from 'node:fs';
        import { readSessions as sample } from './sessions-original.mjs';
        export const readSessions = (options) => sample({ ...options, lookupStarts(pids) {
          appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ identities: pids }) + '\\n');
          return new Map(pids.map(pid => [pid, 'fixture-start']));
        } });`);
    }
    if (!realOverview) await fs.writeFile(path.join(scripts, 'luna-overview.mjs'), `
      import { appendFileSync, existsSync } from 'node:fs';
      import path from 'node:path';
      const values = { daemon: { running: false }, jobs: [{ id: 'first' }], codexLimits: null, orchestration: {} };
      export async function collect({ claudeHome }) {
        appendFileSync(path.join(claudeHome, 'overview-attempts'), 'read\\n');
        if (existsSync(path.join(claudeHome, 'overview-pending'))) await new Promise(() => {});
        if (existsSync(path.join(claudeHome, 'overview-fails'))) throw new Error('fixture overview failed');
        if (existsSync(path.join(claudeHome, 'overview-stale'))) return {
          ...values, sections: { jobs: { status: 'stale', reason: 'fixture used cached jobs' } }
        };
        return values;
      }`);
    if (!realOverview) await fs.writeFile(path.join(scripts, 'conveyor/usage.mjs'), (hangUsage ? `
      import { writeFileSync } from 'node:fs';
      import path from 'node:path';
      export function collectUsage() {
        writeFileSync(path.join(process.env.LUNA_RUN_DIR, 'usage-started'), '');
        while (true) {}
      }
    ` : 'export const collectUsage = () => ({ locked: false });') + `
      export const summarizeUsage = () => ({});
      export const usagePaths = () => ({});
      export const readUsageSummary = () => ({ at: new Date().toISOString() });`);
    await fs.writeFile(clock, '0');
    await fs.writeFile(preload, `
      import childProcess from 'node:child_process';
      import { appendFileSync, existsSync, readFileSync } from 'node:fs';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import path from 'node:path';
      const audit = (value) => appendFileSync(${JSON.stringify(audit)}, JSON.stringify(value) + '\\n');
      const realNow = Date.now;
      Date.now = () => realNow() + (Number(readFileSync(${JSON.stringify(clock)}, 'utf8')) || 0);
      for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
        const original = childProcess[name];
        childProcess[name] = function (...args) { audit({ child: name }); return original.apply(this, args); };
      }
      const threads = createRequire(import.meta.url)('node:worker_threads');
      threads.Worker = class extends threads.Worker {
        constructor(file, options) {
          audit({ worker: options.workerData });
          super(file, options);
        }
      };
      if (${sessionFaults}) {
        const fs = createRequire(import.meta.url)('node:fs/promises');
        const denied = () => Object.assign(new Error('fixture permission denied'), { code: 'EACCES', errno: -13 });
        const { open, readdir } = fs;
        fs.open = (file, ...args) => path.basename(file) === 'blocked.jsonl' ? Promise.reject(denied()) : open(file, ...args);
        fs.readdir = (dir, ...args) => dir === ${JSON.stringify(sessions)} &&
          existsSync(${JSON.stringify(path.join(claude, 'registry-denied'))}) ? Promise.reject(denied()) : readdir(dir, ...args);
      }
      syncBuiltinESMExports();
    `);
    await work({ command, request, launch, discover, snapshotWhen, discovery, lock, claude, env, advance, audit });
  } finally {
    try {
      if (launched?.child.exitCode === null) {
        try { await command('stop'); }
        catch { launched.child.kill(); }
        await launched.closed;
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
}

async function beat(request, info, limits = []) {
  const result = await request(info, '/beat', {
    method: 'POST', headers: { 'x-luna-token': info.token }, body: beatBody(limits)
  });
  assert.equal(result.status, 204);
}

function beatBody(limits = []) {
  return JSON.stringify({ sessionId: 'panel-one', visible: true, limits });
}

test('a second foreground collector exits with code 3 and leaves the first owner in place', { timeout }, async () => {
  await fixture(async ({ command, launch, discover, lock, discovery, env }) => {
    await fs.writeFile(lock, JSON.stringify({ pid: 999_999_999, instance: 'd2a30991-4497-4651-a4dd-df0d09014144' }));
    const { child } = launch();
    const first = await discover();
    assert.equal(first.pid, child.pid);
    await assert.rejects(command('run', { env: { ...env, LUNA_RUN_DIR: path.join(env.LUNA_RUN_DIR, 'other') } }), { code: 3 });
    assert.deepEqual(await json(discovery), first);
    assert.equal((await json(lock)).instance, first.instance);
  });
});

test('a live PID without collector health loses its stale lock after the retry window', { timeout }, async () => {
  await fixture(async ({ launch, discover, lock, discovery, env }) => {
    const instance = 'd2a30991-4497-4651-a4dd-df0d09014144';
    const retryMs = 200;
    let probedAt;
    const server = createServer((_req, res) => {
      probedAt ??= performance.now();
      res.writeHead(503).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, instance }));
      await fs.writeFile(discovery, JSON.stringify({
        version: 1, pid: process.pid, instance, token: 'a'.repeat(32), port: server.address().port
      }));
      env.LUNA_COLLECTOR_LOCK_RETRY_MS = String(retryMs);
      const { child } = launch();
      const replacement = await until(() => json(discovery), (info) => info?.pid === child.pid, 'replacement discovery');
      assert.notEqual(replacement.instance, instance);
      assert.equal((await discover()).instance, (await json(lock)).instance);
      assert.ok(performance.now() - probedAt >= retryMs - 50);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('beat requires the discovery token and publishes Claude limits', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen }) => {
    launch();
    const info = await discover();
    const limit = { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(Date.now() + 60_000).toISOString() };
    assert.equal((await request(info, '/beat', { method: 'POST', body: beatBody([limit]) })).status, 403);
    await beat(request, info, [limit]);
    const result = await snapshotWhen((value) => value?.claudeLimits.length && value.sections.jobs.status === 'ok');
    const [actual] = result.claudeLimits;
    assert.deepEqual(actual, { ...limit, sessionId: 'panel-one', observedAt: actual.observedAt });
    assert.ok(Number.isFinite(Date.parse(actual.observedAt)));
  });
});

test('a quiet foreground collector stays resident and releases discovery and lock on stop', { timeout }, async () => {
  await fixture(async ({ launch, discover, command, snapshotWhen, advance, discovery, lock }) => {
    const { child, closed } = launch();
    const info = await discover();
    assert.equal(info.pid, child.pid);
    const first = await snapshotWhen((value) => value?.sections.sessions.status === 'ok');
    await advance(90_000);
    const second = await snapshotWhen((value) => value?.sections.sessions.okAt > first.sections.sessions.okAt);
    assert.equal(second.sections.jobs.status, 'idle');
    assert.equal(second.sections.jobs.attemptAt, null);
    assert.equal(child.exitCode, null);
    await command('stop');
    assert.deepEqual(await closed, [0, null]);
    assert.equal(await json(discovery), null);
    assert.equal(await json(lock), null);
  });
});

test('shutdown stops a hung usage worker and removes discovery and the lock', { timeout }, async () => {
  await fixture(async ({ command, launch, discover, request, env, discovery, lock }) => {
    const { child, closed } = launch();
    await beat(request, await discover());
    const started = path.join(env.LUNA_RUN_DIR, 'usage-started');
    await until(() => fs.stat(started).catch(() => null), Boolean, 'usage worker start');
    const start = performance.now();
    await command('stop');
    await until(() => child.exitCode, (code) => code !== null, 'shutdown with hung usage', 5250);
    assert.ok(performance.now() - start < 5500);
    assert.deepEqual(await closed, [0, null]);
    assert.equal(await json(discovery), null);
    assert.equal(await json(lock), null);
  }, { hangUsage: true });
});

test('supervised timeout kills the child and a grandchild that ignores SIGTERM', {
  timeout, skip: process.platform !== 'linux'
}, async () => {
  const childCode = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"]);
    grandchild.stdout.once('data', () => console.log(JSON.stringify([process.pid, grandchild.pid])));
    setInterval(() => {}, 1000);
  `;
  const result = await run([process.execPath, '-e', childCode], { deadlineMs: 1000 });
  assert.equal(result.timedOut, true);
  const pids = JSON.parse(result.stdout);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.equal(processAlive(pid), false, `pid ${pid} is still alive`);
});

test('supervised timeout still kills the grandchild when the root exits with stdout open', {
  timeout, skip: process.platform !== 'linux'
}, async () => {
  const root = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ['ignore', 1, 2] });
    console.log(JSON.stringify([process.pid, child.pid]));
    process.exit(0);
  `;
  const start = performance.now();
  const result = await run([process.execPath, '-e', root], { deadlineMs: 1000 });
  assert.ok(performance.now() - start < 3500);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, true);
  for (const pid of JSON.parse(result.stdout)) assert.equal(processAlive(pid), false, `pid ${pid} is still alive`);
});

test('a throwing overview keeps last good jobs and RAM continues advancing', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, claude, advance }) => {
    launch();
    const info = await discover();
    await beat(request, info);
    const previous = await snapshotWhen((value) => value?.sections.jobs.status === 'ok' && value.sections.ram.status === 'ok');
    await fs.writeFile(path.join(claude, 'overview-fails'), '');
    await advance(6000);
    const next = await snapshotWhen((value) => value?.sections.jobs.status === 'stale' &&
      value.sections.ram.okAt > previous.sections.ram.okAt);
    assert.deepEqual(next.jobs, previous.jobs);
    assert.equal(next.sections.jobs.okAt, previous.sections.jobs.okAt);
    assert.equal(next.sections.jobs.reason, 'fixture overview failed');
    assert.equal(next.sections.ram.status, 'ok');
  });
});

test('a stale overview section retains the cached jobs, success time and reason', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, claude, advance }) => {
    launch();
    const info = await discover();
    await beat(request, info);
    const previous = await snapshotWhen((value) => value?.sections.jobs.status === 'ok');
    await fs.writeFile(path.join(claude, 'overview-stale'), '');
    await advance(6000);
    const value = await snapshotWhen((result) => result?.sections.jobs.status === 'stale');
    assert.deepEqual(value.jobs, previous.jobs);
    assert.equal(value.sections.jobs.okAt, previous.sections.jobs.okAt);
    assert.equal(value.sections.jobs.reason, 'fixture used cached jobs');
    assert.equal(value.gemini, null);
    assert.equal(value.sections.gemini.status, 'unavailable');
    assert.equal(value.sections.gemini.reason, 'Gemini is not used');
  });
});


test('a running collector never launches a subprocess and reuses its usage worker', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, advance, audit }) => {
    launch();
    const info = await discover();
    await beat(request, info);
    const first = await snapshotWhen((value) => value?.sections.usage.status === 'ok' && value.sections.jobs.status === 'ok');
    let jobsAt = first.sections.jobs.okAt;
    for (const ms of [30_000, 30_000, 30_000, 31_000]) {
      await advance(ms);
      await beat(request, info);
      const sample = await snapshotWhen((value) => value?.sections.jobs.okAt > jobsAt);
      jobsAt = sample.sections.jobs.okAt;
    }
    await snapshotWhen((value) => value?.sections.usage.okAt > first.sections.usage.okAt);
    const calls = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, [{ worker: 'usage' }]);
  }, { realOverview: true });
});

test('session transcript and registry failures preserve the live PID identity cache', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, claude, advance, audit }) => {
    await fs.writeFile(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({
      sessionId: 'blocked', pid: process.pid, procStart: 'fixture-start', cwd: '/fixture', status: 'busy',
      updatedAt: Date.now()
    }));
    launch();
    await beat(request, await discover());
    const first = await snapshotWhen((value) => value?.sessions[0]?.sessionId === 'blocked');
    assert.equal(first.sessions[0].state, 'thinking');
    assert.equal(first.sessions[0].tool, null);
    const fault = path.join(claude, 'registry-denied');
    await fs.writeFile(fault, '');
    await advance(6000);
    await snapshotWhen((value) => value?.sections.sessions.status === 'stale');
    await fs.unlink(fault);
    await advance(6000);
    const recovered = await snapshotWhen((value) => value?.sections.sessions.okAt > first.sections.sessions.okAt);
    assert.equal(recovered.sessions[0].sessionId, 'blocked');
    const calls = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(call => call.identities), [{ identities: [process.pid] }]);
  }, { sessionFaults: true });
});

test('an outstanding overview read becomes stale at its next due time without starting again', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, claude, advance }) => {
    await fs.writeFile(path.join(claude, 'overview-pending'), '');
    launch();
    await beat(request, await discover());
    await snapshotWhen((value) => value?.sections.jobs.attemptAt);
    await advance(6000);
    const stale = await snapshotWhen((value) => value?.sections.jobs.status === 'stale');
    assert.equal(stale.sections.jobs.reason, 'previous read still running');
    assert.equal(await fs.readFile(path.join(claude, 'overview-attempts'), 'utf8'), 'read\n');
  });
});

test('a daemon /jobs 503 preserves the last good listing and its success time', { timeout }, async () => {
  await fixture(async ({ launch, discover, request, snapshotWhen, advance, env }) => {
    let unavailable = false;
    const server = createServer((req, res) => {
      assert.equal(req.headers['x-luna-token'], 'fixture-token');
      if (req.url === '/jobs' && unavailable) res.writeHead(503).end();
      else res.end(JSON.stringify(req.url === '/jobs' ? { jobs: [{ id: 'first', state: 'running' }] } : { ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await fs.writeFile(path.join(env.LUNA_RUN_DIR, 'daemon.json'), JSON.stringify({
        pid: process.pid, pid_start: readProcessStat(process.pid)?.started, token: 'fixture-token', port: server.address().port
      }));
      launch();
      await beat(request, await discover());
      const first = await snapshotWhen((value) => value?.sections.jobs.status === 'ok' &&
        value.daemon.profiles?.default.jobs[0]?.id === 'first');
      unavailable = true;
      await advance(6000);
      const next = await snapshotWhen((value) => value?.sections.jobs.status === 'stale');
      assert.deepEqual(next.daemon.profiles.default.jobs, first.daemon.profiles.default.jobs);
      assert.equal(next.sections.jobs.okAt, first.sections.jobs.okAt);
      assert.match(next.sections.jobs.reason, /HTTP 503/);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }, { realOverview: true });
});
