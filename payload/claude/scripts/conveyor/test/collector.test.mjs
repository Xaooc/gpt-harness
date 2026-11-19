import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
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

async function fixture(work, { idle = 60_000, live = true, pure = false, hangUsage = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'luna-collector-test-'));
  const claude = path.join(root, '.claude'), scripts = path.join(claude, 'scripts'), sessions = path.join(claude, 'sessions');
  const runDir = path.join(root, 'run'), directory = path.join(runDir, 'collector');
  const discovery = path.join(directory, 'discovery.json'), lock = path.join(directory, 'collector.lock');
  const snapshot = path.join(directory, 'snapshot.json'), cli = path.join(scripts, 'luna-collector.mjs');
  const env = { ...process.env, HOME: root, USERPROFILE: root, LUNA_RUN_DIR: runDir, LUNA_COLLECTOR_IDLE_MS: String(idle) };
  delete env.CONVEYOR_PLATFORM;
  delete env.LUNA_OVERVIEW_HOME;
  const command = async (action) => {
    const { stdout } = await execute(process.execPath, [cli, action], { env, windowsHide: true, timeout });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const request = (info, route, options = {}) => fetch(`http://127.0.0.1:${info.port}${route}`, {
    signal: AbortSignal.timeout(5000), ...options
  });
  const snapshotWhen = (accept) => until(() => json(snapshot), accept, 'snapshot');
  try {
    await Promise.all([fs.mkdir(sessions, { recursive: true }), fs.mkdir(directory, { recursive: true })]);
    const files = ['luna-collector.mjs', 'lib/supervised-run.mjs', 'lib/luna-runtime.mjs', 'conveyor/lib/platform.mjs',
      'conveyor/lib/sessions.mjs'];
    if (process.platform === 'win32') files.push('lib/process-identity.mjs');
    if (live) {
      const procStart = process.platform === 'win32'
        ? await (await import('../../lib/process-identity.mjs')).processStartAsync(process.pid)
        : readProcessStat(process.pid)?.started;
      await fs.writeFile(path.join(sessions, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: 'self', procStart, updatedAt: Date.now()
      }));
    }
    for (const name of files) {
      const file = path.join(scripts, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(path.join(sources, name), file);
    }
    const fakeOverview = `const values = { ram: { freeMb: 100, totalMb: 200 }, daemon: { running: false },
      jobs: [{ id: 'first' }], codexLimits: null, orchestration: {}, gemini: {} };\n`;
    await Promise.all(Object.entries({
      'luna-overview.mjs': fakeOverview + (pure ? `
        import { existsSync } from 'node:fs';
        import path from 'node:path';
        export function collect({ claudeHome }) {
          if (existsSync(path.join(claudeHome, 'overview-fails'))) throw new Error('fixture overview failed');
          if (existsSync(path.join(claudeHome, 'overview-stale'))) return {
            ...values, sections: { jobs: { status: 'stale', reason: 'fixture used cached jobs' } }
          };
          return values;
        }
      ` : 'process.stdout.write(JSON.stringify(values), () => process.exit(0));'),
      'luna-reap-brokers.mjs': '',
      'conveyor/usage.mjs': (hangUsage ? `
        import { writeFileSync } from 'node:fs';
        import path from 'node:path';
        export function collectUsage() {
          writeFileSync(path.join(process.env.LUNA_RUN_DIR, 'usage-started'), '');
          while (true) {}
        }
      ` : 'export const collectUsage = () => ({ locked: false });') + `
        export const readUsageSummary = () => ({ at: new Date().toISOString() });`,
      'conveyor/exec.mjs': `console.log(JSON.stringify({ ok: true, note: 'fixture' }));`,
      'conveyor/cli-update.mjs': `console.log(JSON.stringify({ codex: {}, agy: {}, checkedAt: new Date().toISOString() }));`
    }).map(([name, code]) => fs.writeFile(path.join(scripts, name), code)));
    await work({ command, request, snapshotWhen, discovery, lock, claude, cli, env });
  } finally {
    try {
      const owner = await json(lock);
      if (owner && owner.pid !== process.pid && processAlive(owner.pid)) {
        try { await command('stop'); }
        catch { if (processAlive(owner.pid)) process.kill(owner.pid, 'SIGTERM'); }
        await until(() => processAlive(owner.pid), (alive) => !alive, 'collector exit');
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
}

function beatBody(limits = []) {
  return JSON.stringify({ sessionId: 'panel-one', visible: true, limits });
}

test('concurrent ensure calls share a collector and subsequent ensure reuses it', { timeout }, async () => {
  await fixture(async ({ command, discovery, lock, cli, claude }) => {
    await fs.writeFile(lock, JSON.stringify({
      pid: process.pid, instance: 'd2a30991-4497-4651-a4dd-df0d09014144', startedAt: new Date().toISOString(), procStart: '1'
    }));
    const launches = path.join(claude, 'launches');
    const source = await fs.readFile(cli, 'utf8');
    const countRuns = `import { appendFileSync } from 'node:fs';
      if (process.argv[2] === 'run') appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');\n`;
    await fs.writeFile(cli, source.replace('\n', `\n${countRuns}`));
    const [first, ...others] = await Promise.all(Array.from({ length: 5 }, () => command('ensure')));
    for (const info of others) assert.deepEqual(info, first);
    assert.notEqual(first.pid, process.pid);
    assert.deepEqual(await json(discovery), first);
    assert.equal((await json(lock)).instance, first.instance);
    const start = performance.now();
    assert.deepEqual(await command('ensure'), first);
    assert.ok(performance.now() - start < 2000);
    assert.equal((await fs.readFile(launches, 'utf8')).trim(), String(first.pid));
  });
});

test('beat requires the discovery token and publishes Claude limits', { timeout }, async () => {
  await fixture(async ({ command, request, snapshotWhen }) => {
    const info = await command('ensure');
    const limit = { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(Date.now() + 60_000).toISOString() };
    const beat = { method: 'POST', body: beatBody([limit]) };
    assert.equal((await request(info, '/beat', beat)).status, 403);
    assert.equal((await request(info, '/beat', { ...beat, headers: { 'x-luna-token': info.token } })).status, 204);
    const result = await snapshotWhen((value) => value?.claudeLimits.length && value.sections.jobs.status === 'ok');
    const [actual] = result.claudeLimits;
    assert.deepEqual(actual, { ...limit, sessionId: 'panel-one', observedAt: actual.observedAt });
    assert.ok(Number.isFinite(Date.parse(actual.observedAt)));
  });
});

test('an idle foreground collector exits cleanly and removes its lock and discovery', { timeout }, async () => {
  await fixture(async ({ cli, env, discovery, lock }) => {
    const child = spawn(process.execPath, [cli, 'run'], { env, windowsHide: true, stdio: 'ignore' });
    const closed = once(child, 'close');
    const info = await until(() => json(discovery), Boolean, 'discovery');
    assert.equal(info.pid, child.pid);
    await until(() => child.exitCode, (value) => value !== null, 'idle shutdown', 3500);
    assert.deepEqual(await closed, [0, null]);
    assert.equal(await json(discovery), null);
    assert.equal(await json(lock), null);
  }, { idle: 700, live: false });
});

test('shutdown terminates a hung usage worker and removes discovery and the lock', { timeout }, async () => {
  await fixture(async ({ command, cli, env, discovery, lock }) => {
    const child = spawn(process.execPath, [cli, 'run'], { env, windowsHide: true, stdio: 'ignore' });
    const closed = once(child, 'close');
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
  await fixture(async ({ command, request, snapshotWhen, claude }) => {
    const info = await command('ensure');
    const previous = await snapshotWhen((value) => value?.sections.jobs.status === 'ok' && value.sections.ram.status === 'ok');
    await fs.writeFile(path.join(claude, 'overview-fails'), '');
    const headers = { 'x-luna-token': info.token };
    assert.equal((await request(info, '/beat', { method: 'POST', headers, body: beatBody() })).status, 204);
    const next = await snapshotWhen((value) => value?.sections.jobs.status === 'stale' &&
      value.sections.ram.okAt > previous.sections.ram.okAt);
    assert.deepEqual(next.jobs, previous.jobs);
    assert.equal(next.sections.jobs.okAt, previous.sections.jobs.okAt);
    assert.equal(next.sections.jobs.reason, 'fixture overview failed');
    assert.equal(next.sections.ram.status, 'ok');
  }, { pure: true });
});

test('a stale overview section retains the cached jobs, success time and reason', { timeout }, async () => {
  await fixture(async ({ command, request, snapshotWhen, claude }) => {
    const info = await command('ensure');
    const previous = await snapshotWhen((value) => value?.sections.jobs.status === 'ok');
    await fs.writeFile(path.join(claude, 'overview-stale'), '');
    const headers = { 'x-luna-token': info.token };
    assert.equal((await request(info, '/beat', { method: 'POST', headers, body: beatBody() })).status, 204);
    const value = await snapshotWhen((result) => result?.sections.jobs.status === 'stale');
    assert.deepEqual(value.jobs, previous.jobs);
    assert.equal(value.sections.jobs.okAt, previous.sections.jobs.okAt);
    assert.equal(value.sections.jobs.reason, 'fixture used cached jobs');
    assert.equal(value.gemini, null);
    assert.equal(value.sections.gemini.status, 'unavailable');
    assert.equal(value.sections.gemini.reason, 'Gemini is not used');
  }, { pure: true });
});
