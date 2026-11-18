#!/usr/bin/env node
// Offline account admission checks. Every process uses a disposable HOME and fake Codex server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'payload-linux/claude/scripts');
const leaseScript = path.join(scripts, 'account-lease.mjs');
const daemonScript = path.join(scripts, 'luna-daemon.mjs');
const stub = path.join(scripts, 'lib/luna-daemon-stub.mjs');
const hook = path.join(root, 'payload-linux/claude/hooks/codex-review-gate-run.mjs');
const leaseWait = 180;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 120_000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`timed out after ${timeout}ms waiting for condition`);
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pidStart = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const monotonic = () => Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-lease-test-'));
  const run = path.join(home, '.claude/luna-run');
  const dir = path.join(run, 'account-lease');
  const children = new Set();
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), LUNA_DAEMON_HOME: run,
    LUNA_DAEMON_PROFILE: 'default', LUNA_RAM_RESERVE_MB: '0', LUNA_DAEMON_TURN_MB: '0',
    LUNA_DAEMON_RAMP_MS: '10', LUNA_DAEMON_IDLE_S: '0', LUNA_ADMIT_LOCK: path.join(run, 'admit.lock'),
    LUNA_DAEMON_APP_SERVER_CMD: JSON.stringify([process.execPath, stub, path.join(home, 'audit')]) };
  function start(command, args, overrides = {}, options = {}) {
    const child = spawn(command, args, { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    child.fixtureDetached = Boolean(options.detached);
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
    });
    child.output = () => stdout;
    child.errors = () => stderr;
    return child;
  }
  const cli = (...args) => start(process.execPath, [leaseScript, ...args]);
  const invoke = async (...args) => cli(...args).done;
  const leases = async () => {
    try {
      const lock = path.join(dir, 'lease.lock');
      const generations = fs.existsSync(lock) ? fs.readdirSync(lock).filter((name) => name.startsWith('g-')) : [];
      const sources = [dir, ...generations.map((name) => path.join(lock, name))];
      return sources.flatMap((source) => fs.readdirSync(source).filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(source, name))).filter(Boolean));
    } catch { return []; }
  };
  const cleanup = async () => {
    for (const child of children) {
      if (child.fixtureDetached) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else child.kill('SIGKILL');
    }
    for (const lease of await leases()) {
      for (const [pid, start, group] of [[lease.child_pid, lease.child_pid_start, true],
        [lease.pid, lease.pid_start, false]]) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
        try { if (pidStart(pid) === String(start)) process.kill(group ? -pid : pid, 'SIGKILL'); } catch {}
      }
    }
    await Promise.allSettled([...children].map((child) => child.done));
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, run, dir, env, start, cli, invoke, leases, cleanup };
}

async function withFixture(fn) {
  const f = fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    f.api = await import(`${pathToFileURL(leaseScript).href}?home=${encodeURIComponent(f.home)}`);
    f.acquire = async (mode, purpose, ...args) => {
      const waitIndex = args.indexOf('--wait');
      const ownerIndex = args.indexOf('--owner');
      const lease = await f.api.acquire({ mode, purpose, pid: process.pid,
        ...(waitIndex < 0 ? {} : { wait: Number(args[waitIndex + 1]) }),
        ...(ownerIndex < 0 ? {} : { owner: args[ownerIndex + 1] }) });
      assert.ok(lease);
      return lease.id;
    };
    f.release = async (id) => assert.equal(await f.api.releaseLease(id), true);
    await fn(f);
  } finally {
    process.env.HOME = previousHome;
    await f.cleanup();
  }
}

function observeCodexScan(f, binary) {
  const preload = path.join(f.home, 'observe-scan.cjs');
  const marker = path.join(f.home, 'scan-complete');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const readlink = fs.readlinkSync;\n` +
    `fs.readlinkSync = function () {\n` +
    `  const result = readlink.apply(this, arguments);\n` +
    `  if (result === ${JSON.stringify(binary)}) setImmediate(() => fs.writeFileSync(${JSON.stringify(marker)}, 'yes'));\n` +
    `  return result;\n};\n`);
  return { marker, env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim() } };
}

test('shared holders coexist; exclusive waits and pending excludes later shared holders', () => withFixture(async (f) => {
  const a = await f.acquire('shared', 'first', '--owner', 'session-a');
  const b = await f.acquire('shared', 'second');
  const writer = f.api.acquire({ mode: 'exclusive', purpose: 'probe', pid: process.pid, wait: leaseWait });
  await until(async () => (await f.leases()).some((item) => item.pending && item.purpose === 'probe'));
  const denied = await f.api.acquire({ mode: 'shared', purpose: 'late', pid: process.pid, wait: 0 });
  assert.equal(denied, null);
  assert.equal((await f.invoke('pending-exclusive')).code, 0);
  await f.release(a);
  assert.equal((await f.leases()).find((item) => item.purpose === 'probe').pending, true);
  const releasedAt = Date.now();
  await f.release(b);
  const granted = await writer;
  assert.ok(granted);
  const record = (await f.leases()).find((item) => item.id === granted.id);
  for (const key of ['id', 'mode', 'owner', 'pid', 'pid_start', 'purpose', 'started', 'expires', 'boot_id',
    'started_mono', 'expires_mono', 'generation']) assert.ok(Object.hasOwn(record, key), key);
  assert.equal(record.mode, 'exclusive');
  assert.ok(record.started >= releasedAt);
  await f.release(record.id);
  assert.equal((await f.invoke('pending-exclusive')).code, 1);
}));

test('CLI acquire stores the requested owner and parent pid', () => withFixture(async (f) => {
  const result = await f.invoke('acquire', '--mode', 'shared', '--purpose', 'cli', '--owner', 'session-123');
  assert.equal(result.code, 0, result.stderr);
  const record = (await f.leases()).find((entry) => entry.id === result.stdout.trim());
  assert.equal(record.owner, 'session-123');
  assert.equal(record.pid, process.pid);
  await f.release(record.id);
}));

test('CLI status and release report and remove the lease', () => withFixture(async (f) => {
  const id = await f.acquire('shared', 'cli');
  const status = await f.invoke('status', '--json');
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).leases.find((entry) => entry.id === id).purpose, 'cli');
  assert.equal((await f.invoke('release', id)).code, 0);
  assert.equal((await f.leases()).length, 0);
}));

test('CLI zero-wait admission times out when the lock is held', () => withFixture(async (f) => {
  fs.mkdirSync(f.dir, { recursive: true });
  const lock = path.join(f.dir, 'lease.lock');
  fs.mkdirSync(lock);
  const generation = `g-${bootId.replaceAll('-', '')}-${process.pid}-${pidStart(process.pid)}-${monotonic()}-` +
    '12345678901234567890123456789012';
  fs.mkdirSync(path.join(lock, generation));
  assert.equal((await f.invoke('acquire', '--mode', 'shared', '--purpose', 'blocked', '--wait', '0')).code, 75);
}));

test('a killed or interrupted exclusive waiter does not leave a pending lease', () => withFixture(async (f) => {
  const shared = await f.acquire('shared', 'busy');
  const killed = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'killed waiter', '--wait', String(leaseWait));
  await until(async () => (await f.leases()).some((item) => item.pending));
  killed.kill('SIGKILL');
  await killed.done;
  const successor = await f.acquire('shared', 'after killed waiter', '--wait', '0');
  await f.release(successor);
  const signalled = f.cli('run', '--mode', 'exclusive', '--purpose', 'signalled waiter', '--wait', String(leaseWait), '--',
    process.execPath, '-e', 'process.exit(0)');
  await until(async () => (await f.leases()).some((item) => item.pending));
  signalled.kill('SIGTERM');
  assert.equal((await signalled.done).code, 143);
  assert.equal((await f.leases()).some((item) => item.pending), false);
  await f.release(shared);
}));

test('dead, reused and expired holder records are reclaimed and logged', () => withFixture(async (f) => {
  fs.mkdirSync(f.dir, { recursive: true });
  for (const [id, pid, start, expires] of [
    ['dead', 2147483647, '1', Date.now() + 600_000],
    ['reused', process.pid, 'wrong', Date.now() + 600_000],
    ['frozen', process.pid, pidStart(process.pid), Date.now() - 1]
  ]) {
    fs.writeFileSync(path.join(f.dir, `${id}.json`), JSON.stringify({ id, mode: 'exclusive', owner: 'test', pid,
      pid_start: start, purpose: id, started: Date.now() - 1000, expires, boot_id: bootId,
      started_mono: monotonic() - 1000, expires_mono: monotonic() + (expires - Date.now()) }));
  }
  const id = await f.acquire('shared', 'after reclaim', '--wait', '0');
  const log = fs.readFileSync(path.join(f.dir, 'lease.log'), 'utf8');
  assert.match(log, /reclaimed exclusive dead: holder is dead/);
  assert.match(log, /reclaimed exclusive reused: holder is dead or pid was reused/);
  assert.match(log, /reclaimed exclusive frozen: expired heartbeat\/TTL/);
  await f.release(id);
}));

test('run propagates a non-zero exit and cleans up', () => withFixture(async (f) => {
  const failure = await f.invoke('run', '--mode', 'exclusive', '--purpose', 'failure', '--',
    process.execPath, '-e', 'process.exit(23)');
  assert.equal(failure.code, 23, failure.stderr);
  assert.equal((await f.leases()).length, 0);
}));

test('run heartbeats and SIGTERM ends its child and releases', () => withFixture(async (f) => {
  const runner = f.cli('run', '--mode', 'exclusive', '--purpose', 'signal', '--ttl', '10', '--',
    process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)');
  await until(() => runner.output().includes('ready'));
  const initial = await until(async () => (await f.leases()).find((item) => item.purpose === 'signal'));
  const refreshed = await until(async () => {
    const matches = (await f.leases()).filter((item) => item.purpose === 'signal');
    const current = matches[0];
    const now = monotonic();
    return matches.length === 1 && current.id === initial.id && current.expires_mono > now &&
      current.expires_mono > initial.expires_mono && now >= initial.expires_mono && matches;
  });
  assert.equal(refreshed.length, 1, 'heartbeat refreshes TTL');
  runner.kill('SIGTERM');
  assert.equal((await runner.done).code, 143);
  assert.equal((await f.leases()).length, 0);
}));

test('a SIGKILLed holder and its command stop excluding the account', () => withFixture(async (f) => {
  const runner = f.cli('run', '--mode', 'exclusive', '--purpose', 'killed', '--ttl', '30', '--',
    process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)');
  const childPid = Number(await until(() => /^\d+\n/.test(runner.output()) && runner.output().trim()));
  runner.kill('SIGKILL');
  await runner.done;
  await until(() => {
    try { return fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
  const id = await f.acquire('shared', 'after SIGKILL', '--wait', '0');
  await f.release(id);
}));

test('an alive but frozen holder stops its command before a successor is admitted', () => withFixture(async (f) => {
  const term = path.join(f.home, 'term-received');
  const frozen = f.cli('run', '--mode', 'exclusive', '--purpose', 'frozen holder', '--ttl', '10', '--',
    process.execPath, '-e', 'const fs = require("node:fs"); ' +
      'process.on("SIGTERM", () => fs.writeFileSync(process.argv[1], "term")); ' +
      'console.log(process.pid); setInterval(() => {}, 1000)', term);
  const frozenChildPid = Number(await until(() => /^\d+\n/.test(frozen.output()) && frozen.output().trim()));
  frozen.kill('SIGSTOP');
  await until(() => {
    try { return fs.readFileSync(`/proc/${frozen.pid}/stat`, 'utf8').split(') ')[1].startsWith('T '); }
    catch { return false; }
  });
  const frozenLease = await until(async () => (await f.leases()).find((item) => item.purpose === 'frozen holder'));
  await until(() => monotonic() >= frozenLease.expires_mono);
  const successor = f.cli('acquire', '--mode', 'shared', '--purpose', 'after TTL', '--wait', String(leaseWait));
  await until(() => fs.existsSync(term) || successor.output());
  assert.equal(fs.existsSync(term), true, 'the command receives SIGTERM before lease reclamation');
  const childAlive = () => {
    try { return !fs.readFileSync(`/proc/${frozenChildPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return false; }
  };
  if (childAlive()) {
    assert.equal(successor.output(), '', 'a live command still excludes the successor');
    assert.ok((await f.leases()).some((item) => item.id === frozenLease.id));
  }
  const admitted = await successor.done;
  assert.equal(admitted.code, 0, admitted.stderr);
  assert.equal(childAlive(), false, 'SIGKILL stops the TERM-resistant command before admission');
  await f.release(admitted.stdout.trim());
  frozen.kill('SIGKILL');
  await frozen.done;
  assert.match(fs.readFileSync(path.join(f.dir, 'lease.log'), 'utf8'), /expired heartbeat\/TTL/);
}));

test('releasing an expired lease waits for a surviving child after its group leader exits', () => withFixture(async (f) => {
  const ready = path.join(f.home, 'descendant-ready');
  const exit = path.join(f.home, 'exit-leader');
  const term = path.join(f.home, 'descendant-term');
  const descendant = 'const fs = require("node:fs"); ' +
    'process.on("SIGTERM", () => fs.writeFileSync(process.argv[2], "term")); ' +
    'fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
  const leader = f.start(process.execPath, ['-e', 'const fs = require("node:fs"); ' +
    'const { spawn } = require("node:child_process"); ' +
    'spawn(process.execPath, ["-e", process.argv[1], process.argv[2], process.argv[3]], { stdio: "ignore" }).unref(); ' +
    'setInterval(() => { if (fs.existsSync(process.argv[4])) process.exit(0); }, 25)', descendant, ready, term, exit],
  {}, { detached: true });
  let childPid;
  let childStart;
  try {
    childPid = Number(await until(() => { try { return fs.readFileSync(ready, 'utf8'); } catch { return null; } }));
    childStart = pidStart(childPid);
    const lease = await f.api.acquire({ mode: 'exclusive', purpose: 'expired release', pid: process.pid, ttl: 10,
      wait: leaseWait });
    assert.ok(lease);
    assert.equal(await f.api.bindLeaseChild(lease, leader.pid), true);
    fs.writeFileSync(exit, 'exit');
    assert.equal((await leader.done).code, 0);
    await until(() => monotonic() >= lease.expires_mono);
    assert.equal(await f.api.releaseLease(lease.id), true);
    let alive;
    try { alive = !fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { alive = false; }
    assert.equal(alive, false, 'a surviving group member must stop before release');
    assert.equal(fs.existsSync(term), true, 'the surviving group member receives SIGTERM');
  } finally {
    try {
      const stat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].split(' ');
      if (stat[19] === childStart && Number(stat[2]) === leader.pid) process.kill(-leader.pid, 'SIGKILL');
    } catch {}
  }
}));

test('exclusive checks the running status of both daemon profiles', () => withFixture(async (f) => {
  let running = 1;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: process.pid, jobs: { running } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const net = path.join(f.run, 'daemon-net');
    fs.mkdirSync(net, { recursive: true });
    fs.writeFileSync(path.join(net, 'daemon.json'), JSON.stringify({ pid: process.pid, pid_start: pidStart(process.pid),
      port: server.address().port, token: 'test' }));
    const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'daemon health', '--wait', String(leaseWait));
    await until(async () => (await f.leases()).some((item) => item.pending));
    running = 0;
    const result = await writer.done;
    assert.equal(result.code, 0, result.stderr);
    await f.release(result.stdout.trim());
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('a slow daemon health response does not hold the lease lock', () => withFixture(async (f) => {
  let requestArrived = false;
  let shared;
  let finishHealth;
  const gate = new Promise((resolve) => { finishHealth = resolve; });
  const server = http.createServer(async (req, res) => {
    shared ||= f.api.tryShared({ purpose: 'after pending' });
    requestArrived = true;
    await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: process.pid, jobs: { running: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(f.run, { recursive: true });
    fs.writeFileSync(path.join(f.run, 'daemon.json'), JSON.stringify({ pid: process.pid,
      pid_start: pidStart(process.pid), port: server.address().port, token: 'test' }));
    const writer = f.api.acquire({ mode: 'exclusive', purpose: 'slow health', pid: process.pid, wait: leaseWait });
    await until(() => requestArrived);
    assert.equal(shared.busy, undefined);
    assert.equal(shared.blocking?.purpose, 'slow health');
    finishHealth();
    const lease = await writer;
    assert.ok(lease);
    await f.release(lease.id);
  } finally {
    finishHealth();
    await new Promise((resolve) => server.close(resolve));
  }
}));

async function request(info, route, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Luna-Token': info.token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('exclusive probes document the active-session gate procedure and report requirements', () => {
  // Since 2026-11-16 the executor infrastructure details live in the luna skill; CLAUDE.md points there.
  for (const file of ['payload-linux/claude/skills/luna/SKILL.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    // Wrapped prose: compare on single spaces so a line break inside a sentence does not matter.
    const section = text.slice(text.indexOf('**Codex account lease (Linux):')).split(/\n\n|\n- \*\*/)[0].replace(/\s+/g, ' ');
    assert.match(section, /every active Claude session/i, file);
    assert.match(section, /\/codex:setup --disable-review-gate/, file);
    assert.match(section, /SessionStart[^.]*running sessions/i, file);
    assert.match(section, /--report <report\.json>/, file);
    assert.match(section, /zero `intrusions`[^;\n]*zero `sampling_errors`/i, file);
    assert.match(section, /re-enable[^.\n]*gate/i, file);
  }
});

test('an idle daemon Codex group permits an exclusive probe and does not contaminate its report',
  () => withFixture(async (f) => {
    const shim = path.join(f.home, 'node_modules/@openai/codex/bin/codex.js');
    const binary = path.join(f.home, 'child/codex');
    const childFile = path.join(f.home, 'codex-child');
    const detachedFile = path.join(f.home, 'codex-detached-child');
    const report = path.join(f.home, 'idle-report.json');
    const finish = path.join(f.home, 'finish-probe');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.copyFileSync('/bin/sleep', binary);
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(shim, 'const { spawn } = require("node:child_process"); const fs = require("node:fs");\n' +
      `const child = spawn(${JSON.stringify(binary)}, ['infinity'], { stdio: 'ignore' });\n` +
      `fs.writeFileSync(${JSON.stringify(childFile)}, String(child.pid));\n` +
      `const detached = spawn(${JSON.stringify(binary)}, ['infinity'], { detached: true, stdio: 'ignore' });\n` +
      `fs.writeFileSync(${JSON.stringify(detachedFile)}, String(detached.pid)); detached.unref();\n` +
      `import(${JSON.stringify(pathToFileURL(stub).href)});\n`);
    const daemon = f.start(process.execPath, [daemonScript, '--serve'], {
      LUNA_DAEMON_APP_SERVER_CMD: JSON.stringify([process.execPath, shim, path.join(f.home, 'audit')])
    });
    let writer;
    let detachedPid;
    let info;
    try {
      info = await until(() => readJson(path.join(f.run, 'daemon.json')));
      const serverPid = (await request(info, '/health')).appServerPid;
      assert.equal(info.appServerPid, serverPid);
      assert.equal(info.appServerStart, pidStart(serverPid));
      const childPid = Number(await until(() => { try { return fs.readFileSync(childFile, 'utf8'); } catch { return null; } }));
      detachedPid = Number(await until(() => { try { return fs.readFileSync(detachedFile, 'utf8'); } catch { return null; } }));
      await until(async () => (await f.leases()).length === 0);
      writer = f.cli('run', '--mode', 'exclusive', '--purpose', 'idle daemon probe', '--report', report,
        '--wait', String(leaseWait), '--', process.execPath, '-e',
        'const fs = require("node:fs"); console.log("probe started"); ' +
        'setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 25)', finish);
      const observed = await until(async () => {
        const pending = (await f.leases()).find((item) => item.purpose === 'idle daemon probe');
        return writer.output().includes('probe started') ? { started: true } : pending?.waiting && { note: pending.waiting };
      });
      assert.equal(observed.started, true, observed.note);
      assert.equal((await request(info, '/health')).appServerPid, serverPid);
      assert.ok(fs.existsSync(`/proc/${childPid}`));
      assert.ok(fs.existsSync(`/proc/${detachedPid}`));
      const out = path.join(f.home, 'queued.md');
      const { id } = await request(info, '/jobs', { prompt: 'WAIT queued', cwd: f.home, sandbox: 'read-only',
        model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0 });
      await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === id)?.reason.includes('exclusive'));
      fs.writeFileSync(finish, 'finish');
      const result = await writer.done;
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(readJson(report), { intrusions: [], sampling_errors: [] });
      await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === id)?.state === 'running');
      await request(info, `/jobs/${id}/cancel`, {});
    } finally {
      if (writer && writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGTERM'); await writer.done; }
      try {
        detachedPid ||= Number(fs.readFileSync(detachedFile, 'utf8'));
        if (fs.readlinkSync(`/proc/${detachedPid}/exe`) === binary) process.kill(-detachedPid, 'SIGKILL');
      } catch {}
      if (info) { await request(info, '/stop', {}); await daemon.done; }
    }
  }));

test('a stale daemon app-server identity cannot hide an unmanaged Codex process', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const unmanaged = f.start(binary, ['infinity'], {}, { detached: true });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: process.pid, idle: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let writer;
  try {
    await until(() => { try { return fs.readlinkSync(`/proc/${unmanaged.pid}/exe`) === binary; } catch { return false; } });
    fs.mkdirSync(f.run, { recursive: true });
    fs.writeFileSync(path.join(f.run, 'daemon.json'), JSON.stringify({ pid: process.pid, pid_start: pidStart(process.pid),
      port: server.address().port, token: 'test', appServerPid: unmanaged.pid, appServerStart: 'wrong' }));
    writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'stale daemon identity', '--wait', String(leaseWait));
    const pending = await until(async () => (await f.leases())
      .find((item) => item.purpose === 'stale daemon identity' && item.waiting?.includes(String(unmanaged.pid))));
    assert.match(pending.waiting, /unmanaged codex/);
    unmanaged.kill('SIGTERM');
    await unmanaged.done;
    const result = await writer.done;
    assert.equal(result.code, 0, result.stderr);
    await f.release(result.stdout.trim());
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGTERM'); await writer.done; }
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('unmanaged Codex blocks an exclusive lease and appears in its pending status', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const shared = await f.acquire('shared', 'already running');
  const unmanaged = f.start(binary, ['infinity'], {}, { detached: true });
  await until(() => {
    try { return fs.readlinkSync(`/proc/${unmanaged.pid}/exe`) === binary; } catch { return false; }
  });
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'blocked by codex', '--wait', String(leaseWait));
  await until(async () => (await f.leases()).some((lease) => lease.pending && lease.waiting?.includes(String(unmanaged.pid))));
  const status = JSON.parse((await f.invoke('status', '--json')).stdout);
  const pending = status.leases.find((lease) => lease.purpose === 'blocked by codex');
  assert.match(pending.waiting, new RegExp(`pid ${unmanaged.pid}.*codex`));
  unmanaged.kill('SIGTERM');
  await unmanaged.done;
  await f.release(shared);
  const result = await writer.done;
  assert.equal(result.code, 0, result.stderr);
  await f.release(result.stdout.trim());
}));

test('a Codex process at pid 1 blocks exclusive admission', () => withFixture(async (f) => {
  const readFile = fs.readFileSync;
  const readLink = fs.readlinkSync;
  let note = '';
  fs.readFileSync = (file, ...args) => file === '/proc/1/cmdline' ? 'codex\0app-server\0' : readFile(file, ...args);
  fs.readlinkSync = (file, ...args) => file === '/proc/1/exe' ? '/usr/bin/codex' : readLink(file, ...args);
  try {
    const lease = await f.api.acquire({ mode: 'exclusive', purpose: 'pid 1 codex', pid: process.pid, wait: 1,
      onWait: (_blocking, detail) => { if (detail) note = detail; } });
    assert.equal(lease, null);
    assert.match(note, /unmanaged codex pid 1 codex app-server/);
  } finally {
    fs.readFileSync = readFile;
    fs.readlinkSync = readLink;
  }
}));

test('a managed Codex process group is not reported as unmanaged', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const runner = f.cli('run', '--mode', 'shared', '--purpose', 'managed codex', '--', binary, 'infinity');
  await until(async () => (await f.leases()).some((lease) => lease.purpose === 'managed codex' && lease.child_pid));
  await until(() => fs.readdirSync('/proc').some((name) => {
    if (!/^\d+$/.test(name)) return false;
    try { return fs.readlinkSync(`/proc/${name}/exe`) === binary; } catch { return false; }
  }));
  const scan = observeCodexScan(f, binary);
  const writer = f.start(process.execPath, [leaseScript, 'acquire', '--mode', 'exclusive', '--purpose',
    'after managed codex', '--wait', String(leaseWait)], scan.env);
  const pending = await until(async () => (await f.leases()).find((lease) => lease.purpose === 'after managed codex'));
  await until(() => fs.existsSync(scan.marker));
  const status = JSON.parse((await f.invoke('status', '--json')).stdout);
  assert.equal(status.leases.find((lease) => lease.id === pending.id).waiting, undefined);
  runner.kill('SIGTERM');
  await runner.done;
  const result = await writer.done;
  assert.equal(result.code, 0, result.stderr);
  await f.release(result.stdout.trim());
}));

test('an unmanaged plugin Codex app-server shim blocks an exclusive lease', () => withFixture(async (f) => {
  const script = path.join(f.home, 'node_modules/@openai/codex/bin/codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const unmanaged = f.start(process.execPath, [script, 'app-server'], {}, { detached: true });
  await until(() => {
    try { return fs.readFileSync(`/proc/${unmanaged.pid}/cmdline`, 'utf8').includes(script); } catch { return false; }
  });
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'plugin shim', '--wait', String(leaseWait));
  const pending = await until(async () => (await f.leases()).find((lease) => lease.waiting?.includes(String(unmanaged.pid))));
  assert.match(pending.waiting, /@openai\/codex\/bin\/codex\.js app-server/);
  unmanaged.kill('SIGTERM');
  await unmanaged.done;
  const result = await writer.done;
  assert.equal(result.code, 0, result.stderr);
  await f.release(result.stdout.trim());
}));

test('exclusive run records unmanaged Codex intrusions in status, log and report', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  const report = path.join(f.home, 'probe-report.json');
  const finish = path.join(f.home, 'finish-probe');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const runner = f.cli('run', '--mode', 'exclusive', '--purpose', 'intrusion probe', '--report', report, '--',
    process.execPath, '-e', 'const fs = require("node:fs"); console.log("probe-start"); ' +
      'setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(23); }, 25)', finish);
  await until(() => runner.output().includes('probe-start'));
  const unmanaged = f.start(binary, ['infinity'], {}, { detached: true });
  const status = await until(async () => {
    const result = await f.invoke('status', '--json');
    if (result.code) return null;
    const value = JSON.parse(result.stdout);
    return value.intrusions?.some((entry) => entry.pid === unmanaged.pid) && value;
  });
  const intrusion = status.intrusions.find((entry) => entry.pid === unmanaged.pid);
  assert.equal(intrusion.start, pidStart(unmanaged.pid));
  assert.match(intrusion.cmd_head, /codex/);
  assert.ok(intrusion.first_seen);
  unmanaged.kill('SIGTERM');
  await unmanaged.done;
  fs.writeFileSync(finish, 'finish');
  const result = await runner.done;
  assert.equal(result.code, 23, result.stderr);
  assert.match(result.stderr, /intrusions.*1/i);
  assert.deepEqual(readJson(report).intrusions, [intrusion]);
  assert.match(fs.readFileSync(path.join(f.dir, 'lease.log'), 'utf8'), new RegExp(`intrusion.*${unmanaged.pid}`));
}));

test('exclusive run ignores Codex in its own command group', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  const report = path.join(f.home, 'own-group.json');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const scan = observeCodexScan(f, binary);
  const runner = f.start(process.execPath, [leaseScript, 'run', '--mode', 'exclusive', '--purpose', 'own codex',
    '--report', report, '--', binary, 'infinity'], scan.env);
  const lease = await until(async () => (await f.leases()).find((item) => item.purpose === 'own codex' && item.child_pid));
  await until(() => fs.readdirSync('/proc').some((name) => {
    if (!/^\d+$/.test(name)) return false;
    try { return fs.readlinkSync(`/proc/${name}/exe`) === binary; } catch { return false; }
  }));
  await until(() => fs.existsSync(scan.marker));
  const status = JSON.parse((await f.invoke('status', '--json')).stdout);
  assert.equal(status.leases.some((item) => item.id === lease.id), true);
  assert.deepEqual(status.intrusions, []);
  runner.kill('SIGTERM');
  const result = await runner.done;
  assert.equal(result.code, 143, result.stderr);
  assert.deepEqual(readJson(report).intrusions, []);
}));

test('exclusive run detects a detached Codex descendant', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'codex');
  const report = path.join(f.home, 'detached.json');
  const finish = path.join(f.home, 'finish');
  const pidFile = path.join(f.home, 'detached-pid');
  fs.copyFileSync('/bin/sleep', binary);
  fs.chmodSync(binary, 0o755);
  const program = `const fs = require('node:fs'); const { spawn } = require('node:child_process'); ` +
    `const child = spawn(process.argv[1], ['infinity'], { detached: true, stdio: 'ignore' }); child.unref(); ` +
    `fs.writeFileSync(process.argv[3], String(child.pid)); console.log(child.pid); ` +
    `setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(7); }, 100);`;
  const runner = f.cli('run', '--mode', 'exclusive', '--purpose', 'detached codex', '--report', report, '--',
    process.execPath, '-e', program, binary, finish, pidFile);
  let pid;
  try {
    pid = Number(await until(() => /^\d+\n/.test(runner.output()) && runner.output().trim()));
    await until(async () => (await f.leases()).some((lease) => lease.intrusions?.some((item) => item.pid === pid)));
    fs.writeFileSync(finish, 'finish');
    const result = await runner.done;
    assert.equal(result.code, 7, result.stderr);
    assert.equal(readJson(report).intrusions.some((item) => item.pid === pid), true);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) { runner.kill('SIGKILL'); await runner.done; }
    let childPid = pid;
    try { childPid ||= Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
    let ownChild = false;
    try { ownChild = fs.readlinkSync(`/proc/${childPid}/exe`) === binary; } catch {}
    if (ownChild) {
      try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(() => {
        try { return fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
        catch { return true; }
      });
    }
  }
}));

test('app-server crash releases the running daemon lease and grants a pending exclusive', () => withFixture(async (f) => {
  const daemon = f.start(process.execPath, [daemonScript, '--serve']);
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const out = path.join(f.home, 'crash.md');
  const { id } = await request(info, '/jobs', { prompt: 'WAIT lease test', cwd: f.home, sandbox: 'read-only',
    model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0 });
  const active = await until(async () => (await f.leases()).find((lease) => lease.purpose.includes(id) && lease.child_pid));
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('turn=turn-'); } catch { return false; }
  });
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'after app crash', '--wait', String(leaseWait));
  await until(async () => (await f.leases()).some((lease) => lease.pending));
  process.kill(active.child_pid, 'SIGKILL');
  const result = await writer.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.leases()).some((lease) => lease.purpose.includes(id)), false);
  assert.equal((await request(info, '/jobs')).jobs.find((job) => job.id === id).state, 'failed');
  await f.release(result.stdout.trim());
  await request(info, '/stop', {});
  await daemon.done;
}));

test('pool app-server crash releases the turn lease before a pending exclusive is granted', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-codex');
  fs.writeFileSync(binary, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(path.join(f.home, 'pool-audit'))}\n`);
  fs.chmodSync(binary, 0o755);
  const briefs = path.join(f.home, 'briefs');
  fs.mkdirSync(briefs);
  fs.writeFileSync(path.join(briefs, 'a.brief.md'), 'WAIT crash pool');
  const pool = f.start(process.execPath, [path.join(scripts, 'luna-pool.mjs'), briefs, f.home, '--max', '1'], {
    LUNA_NO_GATE: '1', LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_POOL_RAMP_MS: '0'
  });
  const lease = await until(async () => (await f.leases())
    .find((item) => item.purpose === 'luna pool a.brief.md' && item.child_pid));
  await until(() => {
    try { return fs.readFileSync(path.join(f.home, 'pool-audit'), 'utf8').includes('turn/start'); }
    catch { return false; }
  });
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'after pool crash', '--wait', String(leaseWait));
  await until(async () => (await f.leases()).some((item) => item.pending));
  process.kill(lease.child_pid, 'SIGKILL');
  const result = await writer.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.leases()).some((item) => item.id === lease.id), false);
  assert.equal((await pool.done).code, 1);
  await f.release(result.stdout.trim());
}));

test('a stopped lock owner is fenced before a competing exclusive grant', () => withFixture(async (f) => {
  const preload = path.join(f.home, 'stop-at-rename.cjs');
  const marker = path.join(f.home, 'stopped');
  fs.writeFileSync(preload, `const fs = require('node:fs');\nconst rename = fs.renameSync;\n` +
    `fs.renameSync = function (from, to) {\n` +
    `  if (String(to).endsWith('.json') && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
    `    fs.writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.kill(process.pid, 'SIGSTOP');\n` +
    `  }\n  return rename.apply(this, arguments);\n};\n`);
  const stale = f.start(process.execPath, [leaseScript, 'acquire', '--mode', 'shared', '--purpose', 'stale writer',
    '--wait', '0'], { NODE_OPTIONS: `--require=${preload}` });
  await until(() => fs.existsSync(marker));
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'fenced winner', '--wait', String(leaseWait));
  let result;
  void writer.done.then((value) => { result = value; });
  await until(() => result);
  assert.equal(result.code, 0, result.stderr);
  stale.kill('SIGCONT');
  const staleResult = await stale.done;
  assert.notEqual(staleResult.code, 0, 'a fenced writer must not report a grant');
  const active = await f.leases();
  assert.equal(active.filter((lease) => !lease.pending).length, 1);
  assert.equal(active[0].purpose, 'fenced winner');
  await f.release(result.stdout.trim());
}));

test('a forward wall-clock jump does not expire a live lease or kill its child', () => withFixture(async (f) => {
  const runner = f.cli('run', '--mode', 'shared', '--purpose', 'clock holder', '--ttl', '30', '--',
    process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)');
  const childPid = Number(await until(() => /^\d+\n/.test(runner.output()) && runner.output().trim()));
  const preload = path.join(f.home, 'clock-jump.cjs');
  fs.writeFileSync(preload, 'const original = Date.now; Date.now = () => original() + 7200000;\n');
  const status = await f.start(process.execPath, [leaseScript, 'status', '--json'],
    { NODE_OPTIONS: `--require=${preload}` }).done;
  assert.equal(status.code, 0, status.stderr);
  assert.ok(JSON.parse(status.stdout).leases.some((lease) => lease.purpose === 'clock holder'));
  assert.notEqual(fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1][0], 'Z');
  runner.kill('SIGTERM');
  await runner.done;
}));

function jumpingNodeClock(f, intervalMs) {
  const marker = path.join(f.home, 'clock-jumped');
  const checked = path.join(f.home, 'clock-checked');
  const preload = path.join(f.home, 'clock-switch.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const original = Date.now;\n` +
    `Date.now = () => original() + (fs.existsSync(${JSON.stringify(marker)}) ? 7200000 : 0);\n` +
    `const interval = global.setInterval;\n` +
    `global.setInterval = function (fn, ms, ...args) {\n` +
    `  if (ms !== ${intervalMs}) return interval(fn, ms, ...args);\n` +
    `  return interval(function (...values) {\n` +
    `    const result = fn.apply(this, values);\n` +
    `    if (fs.existsSync(${JSON.stringify(marker)})) fs.writeFileSync(${JSON.stringify(checked)}, 'checked');\n` +
    `    return result;\n  }, ms, ...args);\n};\n`);
  return { marker, checked, preload };
}

test('a forward wall-clock jump does not time out a running daemon job', () => withFixture(async (f) => {
  const { marker, checked, preload } = jumpingNodeClock(f, 500);
  const daemon = f.start(process.execPath, [daemonScript, '--serve'], { NODE_OPTIONS: `--require=${preload}` });
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const out = path.join(f.home, 'clock-daemon.md');
  const { id } = await request(info, '/jobs', { prompt: 'WAIT clock daemon', cwd: f.home, sandbox: 'read-only',
    model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 3600, timeoutS: 3600 });
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('turn=turn-'); } catch { return false; }
  });
  fs.writeFileSync(marker, 'jump');
  await until(() => fs.existsSync(checked));
  assert.equal((await request(info, '/jobs')).jobs.find((job) => job.id === id).state, 'running');
  assert.ok((await f.leases()).some((lease) => lease.purpose.includes(id)));
  fs.unlinkSync(marker);
  await request(info, `/jobs/${id}/cancel`, {});
  await request(info, '/stop', {});
  await daemon.done;
}));

test('a forward wall-clock jump does not time out a running pool job', () => withFixture(async (f) => {
  const { marker, checked, preload } = jumpingNodeClock(f, 5000);
  const binary = path.join(f.home, 'fake-codex');
  fs.writeFileSync(binary, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(path.join(f.home, 'pool-audit'))}\n`);
  fs.chmodSync(binary, 0o755);
  const briefs = path.join(f.home, 'briefs');
  fs.mkdirSync(briefs);
  fs.writeFileSync(path.join(briefs, 'a.brief.md'), 'WAIT clock pool');
  const pool = f.start(process.execPath, [path.join(scripts, 'luna-pool.mjs'), briefs, f.home, '--max', '1'], {
    NODE_OPTIONS: `--require=${preload}`, LUNA_NO_GATE: '1', LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1',
    LUNA_NO_PREAMBLE: '1', LUNA_POOL_RAMP_MS: '0', LUNA_IDLE_MAX_S: '30', LUNA_TURN_TIMEOUT_S: '3600'
  });
  const status = path.join(briefs, 'a.out.md.status');
  await until(() => { try { return fs.readFileSync(status, 'utf8').includes('state=running'); } catch { return false; } });
  fs.writeFileSync(marker, 'jump');
  await until(() => fs.existsSync(checked));
  assert.match(fs.readFileSync(status, 'utf8'), /^state=running$/m);
  assert.ok((await f.leases()).some((lease) => lease.purpose === 'luna pool a.brief.md'));
  fs.unlinkSync(marker);
  pool.kill('SIGTERM');
  await pool.done;
}));

function jumpingDate(f) {
  const bin = path.join(f.home, 'clock-bin');
  const jump = path.join(f.home, 'clock-jump');
  const checked = path.join(f.home, 'watchdog-checks');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'date'), '#!/bin/bash\n' +
    'if [ -e "$CLOCK_JUMP_FILE" ] && [ "${1:-}" = +%s ]; then\n' +
    '  printf "%s\\n" "$(( $(/bin/date +%s) + 7200 ))"\n  exit\nfi\n' +
    'exec /bin/date "$@"\n');
  fs.chmodSync(path.join(bin, 'date'), 0o755);
  fs.writeFileSync(path.join(bin, 'wc'), '#!/bin/bash\n' +
    'if [ -e "$CLOCK_JUMP_FILE" ] && [ "${1:-}" = -c ]; then printf ".\\n" >> "$CLOCK_CHECKED_FILE"; fi\n' +
    'exec /usr/bin/wc "$@"\n');
  fs.chmodSync(path.join(bin, 'wc'), 0o755);
  return { jump, checked, env: { PATH: `${bin}:${process.env.PATH}`, CLOCK_JUMP_FILE: jump, CLOCK_CHECKED_FILE: checked } };
}

async function waitForWatchdog(clock) {
  // Two log-size checks show that a complete watchdog iteration ran after the jump.
  await until(() => {
    try { return fs.readFileSync(clock.checked, 'utf8').split('\n').length >= 3; } catch { return false; }
  });
}

test('a forward wall-clock jump does not stop a running exec wrapper job', () => withFixture(async (f) => {
  const clock = jumpingDate(f);
  const binary = path.join(f.home, 'fake-codex');
  const started = path.join(f.home, 'started');
  const prompt = path.join(f.home, 'prompt');
  const out = path.join(f.home, 'clock-exec.md');
  fs.writeFileSync(prompt, 'clock exec');
  fs.writeFileSync(binary, '#!/bin/bash\nprintf started > "$STARTED_FILE"\nwhile :; do /usr/bin/sleep 1; done\n');
  fs.chmodSync(binary, 0o755);
  const wrapper = f.start('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', f.home, '-o', out, '-f', prompt], {
    ...clock.env, LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_CODEX_BIN: binary,
    STARTED_FILE: started, LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_NO_PREAMBLE: '1',
    LUNA_MODEL_RETRIES: '0', LUNA_IDLE_MAX_S: '30', LUNA_TIMEOUT_S: '30'
  }, { detached: true });
  await until(() => fs.existsSync(started));
  await until(() => { try { return fs.readFileSync(`${out}.status`, 'utf8').includes('state=running'); } catch { return false; } });
  fs.writeFileSync(clock.jump, 'jump');
  await waitForWatchdog(clock);
  assert.equal(wrapper.exitCode, null, wrapper.errors());
  assert.ok((await f.leases()).some((lease) => lease.purpose.startsWith('luna exec')));
}));

test('a forward wall-clock jump does not stop a running daemon wrapper job', () => withFixture(async (f) => {
  const clock = jumpingDate(f);
  const daemon = f.start(process.execPath, [daemonScript, '--serve']);
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const out = path.join(f.home, 'clock-wrapper.md');
  const prompt = path.join(f.home, 'prompt');
  fs.writeFileSync(prompt, 'WAIT clock wrapper');
  const wrapper = f.start('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', f.home, '-o', out, '-f', prompt], {
    ...clock.env, LUNA_DAEMON: '1', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_NO_REGISTRY: '1',
    LUNA_NO_REFUSAL_RETRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_MODEL_RETRIES: '0', LUNA_IDLE_MAX_S: '30',
    LUNA_TIMEOUT_S: '30'
  }, { detached: true });
  const id = await until(() => {
    try {
      if (!fs.readFileSync(`${out}.status`, 'utf8').includes('state=running')) return null;
      const marker = fs.readFileSync(`${out}.daemon`, 'utf8');
      return /^turn=turn-/m.test(marker) && /^id=(.+)$/m.exec(marker)?.[1];
    } catch { return null; }
  });
  fs.writeFileSync(clock.jump, 'jump');
  await waitForWatchdog(clock);
  assert.equal(wrapper.exitCode, null, wrapper.errors());
  assert.equal((await request(info, `/jobs/${id}`)).state, 'running');
  fs.unlinkSync(clock.jump);
  await request(info, `/jobs/${id}/cancel`, {});
  await wrapper.done;
  await request(info, '/stop', {});
  await daemon.done;
}));

test('dead, reused and over-bound lock owners are reclaimed', () => withFixture(async (f) => {
  fs.mkdirSync(f.dir, { recursive: true });
  const lock = path.join(f.dir, 'lease.lock');
  for (const [pid, start, acquired] of [
    [2147483647, '1', monotonic()],
    [process.pid, '1', monotonic()],
    [process.pid, pidStart(process.pid), monotonic() - 31000]
  ]) {
    fs.mkdirSync(lock);
    const name = `g-${bootId.replaceAll('-', '')}-${pid}-${start}-${acquired}-` +
      '12345678901234567890123456789012';
    fs.mkdirSync(path.join(lock, name));
    const id = await f.acquire('shared', 'after stale lock', '--wait', '0');
    await f.release(id);
    fs.rmSync(lock, { recursive: true });
  }
  assert.equal((fs.readFileSync(path.join(f.dir, 'lease.log'), 'utf8').match(/reclaimed stale lease lock/g) || []).length, 3);
}));

test('a lease from another boot is invalidated without killing a live child', () => withFixture(async (f) => {
  const runner = f.cli('run', '--mode', 'shared', '--purpose', 'old boot', '--',
    process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)');
  const childPid = Number(await until(() => /^\d+\n/.test(runner.output()) && runner.output().trim()));
  const lease = (await f.leases()).find((item) => item.purpose === 'old boot');
  const lock = path.join(f.dir, 'lease.lock');
  const generation = fs.readdirSync(lock).find((name) => name.startsWith('g-'));
  const file = path.join(lock, generation, `${lease.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...lease, boot_id: 'previous-boot' }));
  const result = await f.invoke('status', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).leases.some((item) => item.id === lease.id), false);
  assert.notEqual(fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1][0], 'Z');
  runner.kill('SIGTERM');
  await runner.done;
}));

test('daemon queues under an exclusive lease and starts after release', () => withFixture(async (f) => {
  const held = await f.acquire('exclusive', 'live probe');
  const daemon = f.start(process.execPath, [daemonScript, '--serve']);
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const out = path.join(f.home, 'job.md');
  const { id } = await request(info, '/jobs', { prompt: 'WAIT lease test', cwd: f.home, sandbox: 'read-only',
    model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0 });
  const job = await until(async () => {
    const item = (await request(info, '/jobs')).jobs.find((row) => row.id === id);
    return item?.reason.includes('exclusive account lease') && item;
  });
  assert.equal(job.state, 'queued');
  assert.match(job.reason, /exclusive account lease live probe/);
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('last_note=waiting: exclusive account lease live probe'); }
    catch { return false; }
  });
  assert.equal(fs.existsSync(path.join(f.home, 'audit')), false, 'no app-server starts while exclusive');
  await f.release(held);
  await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === id)?.state === 'running');
  await request(info, `/jobs/${id}/cancel`, {});
  await request(info, '/stop', {});
  await daemon.done;
}));

test('daemon stops an app-server whose launcher execs a new executable', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-server');
  fs.writeFileSync(binary, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(path.join(f.home, 'audit'))}\n`);
  fs.chmodSync(binary, 0o755);
  const daemon = f.start(process.execPath, [daemonScript, '--serve'], {
    LUNA_DAEMON_APP_SERVER_CMD: JSON.stringify([binary])
  });
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const serverPid = (await request(info, '/health')).appServerPid;
  assert.ok(serverPid);
  await request(info, '/stop', {});
  await daemon.done;
  await until(() => {
    try { return fs.readFileSync(`/proc/${serverPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
}));

test('a killed daemon cannot leave its app-server using the account', () => withFixture(async (f) => {
  const daemon = f.start(process.execPath, [daemonScript, '--serve']);
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const serverPid = (await request(info, '/health')).appServerPid;
  const out = path.join(f.home, 'job.md');
  const { id } = await request(info, '/jobs', { prompt: 'WAIT killed daemon', cwd: f.home, sandbox: 'read-only',
    model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0 });
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('turn=turn-'); } catch { return false; }
  });
  assert.ok((await f.leases()).some((lease) => lease.purpose.includes(id) && lease.child_pid === serverPid));
  daemon.kill('SIGKILL');
  await daemon.done;
  const exclusive = await f.acquire('exclusive', 'after killed daemon', '--wait', String(leaseWait));
  await until(() => {
    try { return fs.readFileSync(`/proc/${serverPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
  await f.release(exclusive);
}));

test('a pending exclusive waits for a running daemon turn and blocks the next turn', () => withFixture(async (f) => {
  const daemon = f.start(process.execPath, [daemonScript, '--serve']);
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const submit = async (name) => {
    const out = path.join(f.home, `${name}.md`);
    return (await request(info, '/jobs', { prompt: `WAIT ${name}`, cwd: f.home, sandbox: 'read-only',
      model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0 })).id;
  };
  const first = await submit('first');
  await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === first)?.state === 'running');
  const writer = f.cli('acquire', '--mode', 'exclusive', '--purpose', 'waiting probe', '--wait', String(leaseWait));
  await until(async () => (await f.leases()).some((item) => item.pending));
  const next = await submit('next');
  await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === next)?.reason.includes('exclusive'));
  await request(info, `/jobs/${first}/cancel`, {});
  const granted = await writer.done;
  assert.equal(granted.code, 0, granted.stderr);
  assert.equal((await request(info, '/jobs')).jobs.find((row) => row.id === next).state, 'queued');
  await f.release(granted.stdout.trim());
  await until(async () => (await request(info, '/jobs')).jobs.find((row) => row.id === next)?.state === 'running');
  await request(info, `/jobs/${next}/cancel`, {});
  await request(info, '/stop', {});
  await daemon.done;
}));

test('daemon model retries wait for a pending exclusive before starting another turn', () => withFixture(async (f) => {
  const finish = path.join(f.home, 'finish-failed-turn');
  const daemon = f.start(process.execPath, [daemonScript, '--serve'], { LUNA_STUB_FINISH_FILE: finish });
  const info = await until(() => readJson(path.join(f.run, 'daemon.json')));
  const out = path.join(f.home, 'retry.md');
  const { id } = await request(info, '/jobs', { prompt: 'MODEL_FAIL_ONCE:Selected model is at capacity', cwd: f.home,
    sandbox: 'read-only', model: 'gpt-6-luna', effort: 'max', tier: 'default', out, log: `${out}.log`,
    idleMaxS: 0, timeoutS: 0, modelRetries: 1, modelRetryDelayS: 1 });
  const starts = () => {
    try {
      return fs.readFileSync(path.join(f.home, 'audit'), 'utf8').split('\n')
        .filter((line) => line.includes('"method":"turn/start"')).length;
    } catch { return 0; }
  };
  await until(() => starts() === 1);
  const writer = f.api.acquire({ mode: 'exclusive', purpose: 'retry probe', pid: process.pid, wait: leaseWait });
  await until(async () => (await f.leases()).some((item) => item.pending));
  fs.writeFileSync(finish, 'finish');
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('retry_waiting=1'); } catch { return false; }
  });
  const exclusive = await writer;
  assert.ok(exclusive);
  await until(() => {
    try { return fs.readFileSync(`${out}.daemon`, 'utf8').includes('last_note=waiting: exclusive account lease retry probe'); }
    catch { return false; }
  });
  assert.equal(starts(), 1);
  await f.release(exclusive.id);
  await until(async () => (await request(info, `/jobs/${id}`)).state === 'completed');
  assert.equal(starts(), 2);
  await request(info, '/stop', {});
  await daemon.done;
}));

test('exec fallback waits for exclusive release before starting Codex', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-codex');
  const started = path.join(f.home, 'started');
  fs.writeFileSync(binary, `#!/bin/bash\nprintf started > "$STARTED_FILE"\nwhile [ "$#" -gt 0 ]; do\n` +
    'if [ "$1" = -o ]; then printf "answer\\n" > "$2"; break; fi; shift; done\n');
  fs.chmodSync(binary, 0o755);
  const held = await f.acquire('exclusive', 'fallback probe');
  const out = path.join(f.home, 'out.md');
  const prompt = path.join(f.home, 'prompt');
  fs.writeFileSync(prompt, 'hello');
  const wrapper = f.start('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', f.home, '-o', out, '-f', prompt], {
    LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_CODEX_BIN: binary, STARTED_FILE: started,
    LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_MODEL_RETRIES: '0'
  }, { detached: true });
  try {
    await until(() => {
      try { return fs.readFileSync(`${out}.status`, 'utf8').includes('exclusive account lease fallback probe'); }
      catch { return false; }
    });
  } catch (error) {
    let status = '';
    try { status = fs.readFileSync(`${out}.status`, 'utf8'); } catch {}
    throw new Error(`${error.message}: status=${status} stderr=${wrapper.errors()}`);
  }
  assert.equal(fs.existsSync(started), false);
  await f.release(held);
  await until(() => fs.existsSync(started) && fs.existsSync(out));
  if (wrapper.exitCode === null) { try { process.kill(-wrapper.pid, 'SIGTERM'); } catch {} }
  await wrapper.done;
  await until(async () => !(await f.leases()).some((item) => item.purpose.startsWith('luna exec')));
}));

test('exec model retries wait for a pending exclusive before resuming', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-codex');
  const first = path.join(f.home, 'first');
  const resume = path.join(f.home, 'resume');
  const trigger = path.join(f.home, 'finish-first');
  const prompt = path.join(f.home, 'prompt');
  fs.writeFileSync(prompt, 'hello');
  fs.writeFileSync(binary, '#!/bin/bash\n' +
    'if [ "${2:-}" = resume ]; then\n' +
    'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf answer > "$2"; break; fi; shift; done\n' +
    'printf yes > "$RESUME_FILE"; exit 0; fi\n' +
    'printf yes > "$FIRST_FILE"; while [ ! -e "$TRIGGER_FILE" ]; do /usr/bin/sleep 0.02; done\n' +
    'printf "session id: 01a17d4c-b215-70f3-a2f0-a56ba9c1e238\\n" >&2\n' +
    'printf "ERROR: Selected model is at capacity. Please try a different model.\\n" >&2; exit 1\n');
  fs.chmodSync(binary, 0o755);
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nif [ "$1" = 5 ] || [ "$1" = 1 ]; then exec /usr/bin/sleep 0.005; fi\n' +
    'exec /usr/bin/sleep "$@"\n');
  fs.chmodSync(path.join(bin, 'sleep'), 0o755);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\nif [[ "$1" == */lib/luna-runtime.mjs ]]; then\n` +
    `case "$2" in --resolve) printf '%s\\n' "$LUNA_CODEX_BIN"; exit ;; --package-root) exit ;;\n` +
    `--retry-delay) printf '0.000 0\\n'; exit ;; --start) stat=$(<"/proc/$3/stat"); stat=\${stat##*) };\n` +
    `read -r -a fields <<< "$stat"; printf '%s\\n' "\${fields[19]}"; exit ;; esac; fi\n` +
    `exec ${JSON.stringify(process.execPath)} "$@"\n`);
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  const out = path.join(f.home, 'out.md');
  const wrapper = f.start('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', f.home, '-o', out, '-f', prompt], {
    PATH: `${bin}:${process.env.PATH}`, LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0',
    LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_NO_PREAMBLE: '1',
    FIRST_FILE: first, RESUME_FILE: resume, TRIGGER_FILE: trigger, LUNA_MODEL_RETRIES: '1', LUNA_MODEL_RETRY_DELAY_S: '0'
  }, { detached: true });
  await until(() => fs.existsSync(first));
  const writer = f.api.acquire({ mode: 'exclusive', purpose: 'exec retry probe', pid: process.pid, wait: leaseWait });
  await until(async () => (await f.leases()).some((item) => item.pending));
  fs.writeFileSync(trigger, 'finish');
  const lease = await writer;
  assert.ok(lease);
  await until(() => {
    try { return fs.readFileSync(`${out}.status`, 'utf8').includes('exclusive account lease exec retry probe'); }
    catch { return false; }
  });
  assert.equal(fs.existsSync(resume), false);
  await f.release(lease.id);
  try { await until(() => fs.existsSync(resume)); }
  catch (error) {
    let log = '';
    let status = '';
    try { log = fs.readFileSync(`${out}.log`, 'utf8'); } catch {}
    try { status = fs.readFileSync(`${out}.status`, 'utf8'); } catch {}
    let leaseLog = '';
    try { leaseLog = fs.readFileSync(path.join(f.dir, 'lease.log'), 'utf8'); } catch {}
    throw new Error(`${error.message}: status=${status} log=${log} lease=${leaseLog} stderr=${wrapper.errors()}`);
  }
  if (wrapper.exitCode === null) { try { process.kill(-wrapper.pid, 'SIGKILL'); } catch {} }
  await wrapper.done;
}));

test('a killed exec wrapper cannot leave Codex running without a shared lease', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-codex');
  const started = path.join(f.home, 'exec-pid');
  const prompt = path.join(f.home, 'prompt');
  fs.writeFileSync(prompt, 'hello');
  fs.writeFileSync(binary, '#!/bin/bash\nprintf "%s" "$$" > "$STARTED_FILE"\nwhile :; do sleep 1; done\n');
  fs.chmodSync(binary, 0o755);
  const out = path.join(f.home, 'out.md');
  const wrapper = f.start('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', f.home, '-o', out, '-f', prompt], {
    LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_CODEX_BIN: binary, STARTED_FILE: started,
    LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_MODEL_RETRIES: '0'
  }, { detached: true });
  let codexPid;
  try {
    codexPid = Number(await until(() => { try { return fs.readFileSync(started, 'utf8'); } catch { return null; } }));
  } catch (error) {
    let log = '';
    let status = '';
    try { log = fs.readFileSync(`${out}.log`, 'utf8'); } catch {}
    try { status = fs.readFileSync(`${out}.status`, 'utf8'); } catch {}
    throw new Error(`${error.message}: status=${status} log=${log} stderr=${wrapper.errors()}`);
  }
  const lease = (await f.leases()).find((item) => item.purpose.startsWith('luna exec'));
  assert.ok(lease?.child_pid);
  assert.notEqual(lease.pid, wrapper.pid);
  try { process.kill(-wrapper.pid, 'SIGKILL'); } catch {}
  await wrapper.done;
  const exclusive = await f.acquire('exclusive', 'after killed wrapper', '--wait', String(leaseWait));
  await until(() => {
    try { return fs.readFileSync(`/proc/${codexPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
  await f.release(exclusive);
}));

test('pool waits before starting an app-server while exclusive is held', () => withFixture(async (f) => {
  const binary = path.join(f.home, 'fake-codex');
  fs.writeFileSync(binary, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(path.join(f.home, 'pool-audit'))}\nexit $?\n`);
  fs.chmodSync(binary, 0o755);
  const briefs = path.join(f.home, 'briefs');
  fs.mkdirSync(briefs);
  fs.writeFileSync(path.join(briefs, 'a.brief.md'), 'hello');
  const held = await f.acquire('exclusive', 'pool probe');
  const pool = f.start(process.execPath, [path.join(scripts, 'luna-pool.mjs'), briefs, f.home, '--max', '1'], {
    LUNA_NO_GATE: '1', LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1', LUNA_POOL_RAMP_MS: '0',
    LUNA_STUB_DELAY_MS: '10'
  });
  const status = path.join(briefs, 'a.out.md.status');
  await until(() => {
    try { return fs.readFileSync(status, 'utf8').includes('exclusive account lease pool probe'); } catch { return false; }
  });
  assert.equal(fs.existsSync(path.join(f.home, 'pool-audit')), false);
  await f.release(held);
  const result = await pool.done;
  assert.equal(result.code, 0, result.stderr);
}));

test('a killed pool cannot leave its app-server using the account', () => withFixture(async (f) => {
  const audit = path.join(f.home, 'pool-audit');
  const binary = path.join(f.home, 'fake-codex');
  fs.writeFileSync(binary, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(audit)}\n`);
  fs.chmodSync(binary, 0o755);
  const briefs = path.join(f.home, 'briefs');
  fs.mkdirSync(briefs);
  fs.writeFileSync(path.join(briefs, 'a.brief.md'), 'WAIT killed pool');
  const pool = f.start(process.execPath, [path.join(scripts, 'luna-pool.mjs'), briefs, f.home, '--max', '1'], {
    LUNA_NO_GATE: '1', LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_POOL_RAMP_MS: '0'
  });
  const lease = await until(async () => (await f.leases())
    .find((item) => item.purpose === 'luna pool a.brief.md' && item.child_pid));
  pool.kill('SIGKILL');
  await pool.done;
  const exclusive = await f.acquire('exclusive', 'after killed pool', '--wait', String(leaseWait));
  await until(() => {
    try { return fs.readFileSync(`/proc/${lease.child_pid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
  await f.release(exclusive);
}));

test('pool finishes an active turn but waits before starting the next for a pending exclusive', () => withFixture(async (f) => {
  const audit = path.join(f.home, 'pool-audit');
  const finish = path.join(f.home, 'finish-first-turn');
  const binary = path.join(f.home, 'fake-codex');
  fs.writeFileSync(binary, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ` +
    `${JSON.stringify(audit)}\nexit $?\n`);
  fs.chmodSync(binary, 0o755);
  const briefs = path.join(f.home, 'briefs');
  fs.mkdirSync(briefs);
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(briefs, `${name}.brief.md`), name);
  const pool = f.start(process.execPath, [path.join(scripts, 'luna-pool.mjs'), briefs, f.home, '--max', '1'], {
    LUNA_NO_GATE: '1', LUNA_CODEX_BIN: binary, LUNA_NO_REGISTRY: '1', LUNA_POOL_RAMP_MS: '0',
    LUNA_STUB_FINISH_FILE: finish
  });
  const starts = () => {
    try { return fs.readFileSync(audit, 'utf8').split('\n').filter((line) => line.includes('"method":"turn/start"')); }
    catch { return []; }
  };
  await until(() => starts().length === 1);
  const writer = f.api.acquire({ mode: 'exclusive', purpose: 'pool pending', pid: process.pid, wait: leaseWait });
  await until(async () => (await f.leases()).some((item) => item.pending));
  fs.writeFileSync(finish, 'finish');
  const granted = await writer;
  assert.ok(granted);
  assert.equal(starts().length, 1);
  await f.release(granted.id);
  assert.equal((await pool.done).code, 0);
  assert.equal(starts().length, 2);
}));

test('the code edit hook directs Codex work through Luna admission', () => withFixture(async (f) => {
  const codeHook = path.join(root, 'payload-linux/claude/hooks/codex-code-edit-block.mjs');
  fs.mkdirSync(path.join(f.home, '.planning'));
  const blocked = f.start(process.execPath, [codeHook]);
  blocked.stdin.end(JSON.stringify({ cwd: f.home, tool_name: 'Write',
    tool_input: { file_path: path.join(f.home, 'sample.js') } }));
  const result = await blocked.done;
  assert.equal(result.code, 2);
  assert.match(result.stderr, /bash ~\/\.claude\/scripts\/luna\.sh -w/);
  const allowed = f.start(process.execPath, [codeHook]);
  allowed.stdin.end(JSON.stringify({ cwd: f.home, tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/scripts/luna.sh -w "write > sample.js"' } }));
  assert.equal((await allowed.done).code, 0);
}));

test('a killed harness review hook retains protection until its review stops', () => withFixture(async (f) => {
  const plugin = path.join(f.home, '.claude/plugins/cache/openai-codex/codex/1/scripts');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'lib/state.mjs'), '');
  const mark = path.join(f.home, 'gate-pid');
  fs.writeFileSync(path.join(plugin, 'stop-review-gate-hook.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, String(process.pid)); ` +
    'setInterval(() => {}, 1000);\n');
  const review = f.start(process.execPath, [hook]);
  review.stdin.end('{}');
  const reviewPid = Number(await until(() => { try { return fs.readFileSync(mark, 'utf8'); } catch { return null; } }));
  review.kill('SIGKILL');
  await review.done;
  const exclusive = await f.acquire('exclusive', 'after killed review', '--wait', String(leaseWait));
  await until(() => {
    try { return fs.readFileSync(`/proc/${reviewPid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); }
    catch { return true; }
  });
  await f.release(exclusive);
}));

test('the harness Stop review hook fails open while exclusive is held', () => withFixture(async (f) => {
  const plugin = path.join(f.home, '.claude/plugins/cache/openai-codex/codex/1/scripts');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'lib/state.mjs'), '');
  const mark = path.join(f.home, 'gate-ran');
  fs.writeFileSync(path.join(plugin, 'stop-review-gate-hook.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, 'yes');\n`);
  const held = await f.acquire('exclusive', 'review probe');
  const blocked = f.start(process.execPath, [hook]);
  blocked.stdin.end('{}');
  assert.equal((await blocked.done).code, 0);
  assert.equal(fs.existsSync(mark), false);
  await f.release(held);
  const allowed = f.start(process.execPath, [hook]);
  allowed.stdin.end('{}');
  assert.equal((await allowed.done).code, 0);
  assert.equal(fs.existsSync(mark), true);
}));
