#!/usr/bin/env node
// Fast Luna/Codex status with stale-index cleanup; Node 20, no dependencies; starts the detached broker reaper.
// Usage: node luna-overview.mjs [--pretty | --human | --self-test] [--beat  (heartbeat JSON on stdin)]
// LUNA_OVERVIEW_HOME overrides the run root; LUNA_DAEMON_HOME independently overrides daemon discovery.
import * as fs from 'node:fs/promises';
import { totalmem, homedir, tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { availableMemory, matchingProcess, readProcess } from './lib/luna-runtime.mjs';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEADLINE_MS = 1750;
const TAIL_BYTES = 64 * 1024;
const ACTIVE_LIMIT = 200;
const LEGACY_MAX_AGE_MS = 10 * 60 * 1000;
const terminal = new Set(['done', 'failed', 'incomplete', 'stalled', 'completed', 'cancelled']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' ? value : '';
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const seconds = (value, now) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null;
};
const newest = (a, b) => (a.ageS ?? Infinity) - (b.ageS ?? Infinity);
const cleanText = (value, max) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  .trim().slice(0, max);
const localPath = (value) => typeof value === 'string' && path.isAbsolute(value) &&
  !value.startsWith('//') && !value.includes('\0');

function configuration() {
  const home = path.resolve(process.env.HOME || homedir());
  const run = path.resolve(process.env.LUNA_OVERVIEW_HOME || path.join(home, '.claude', 'luna-run'));
  return {
    run,
    daemon: path.resolve(process.env.LUNA_DAEMON_HOME || run)
  };
}

function empty(now = Date.now()) {
  return {
    v: 1, at: new Date(now).toISOString(),
    ram: { freeMb: null, totalMb: null },
    daemon: { running: false, appServer: null, healthy: false }, jobs: [], codexLimits: null, build: null,
    sessions: []
  };
}

async function readText(file, limit = 1024 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function readJson(file) {
  try {
    const value = JSON.parse(await readText(file));
    return object(value) ? value : null;
  } catch { return null; }
}

function statusValues(text) {
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index);
    if (!Object.hasOwn(values, key)) values[key] = line.slice(index + 1);
  }
  return values;
}

async function activeJobs(run, now, boot = Date.now() - uptime() * 1000) {
  const directory = path.join(run, 'active');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const recent = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      try { recent.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs }); }
      catch {}
    }
  }));
  entries = recent.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, ACTIVE_LIMIT);
  const jobs = [];
  cursor = 0;
  // Bound filesystem concurrency even when many stale wrapper entries remain.
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const { file } = entries[cursor++];
      const text = await readText(file, 32 * 1024);
      const [out, pidLine, pidStart] = text?.split(/\r?\n/).map((line) => line.trim()) || [];
      // Validate before any access to paths supplied by the index or job data.
      if (!localPath(out)) continue;
      if (pidLine) {
        const pid = Number(pidLine);
        if (Number.isSafeInteger(pid) && pid > 0) {
          if (!matchingProcess(pid, pidStart)) {
            await fs.unlink(file).catch(() => {});
            continue;
          }
        }
      } else {
        let stat;
        try { stat = await fs.stat(`${out}.status`); } catch {}
        if (!stat || now - stat.mtimeMs > LEGACY_MAX_AGE_MS) {
          await fs.unlink(file).catch(() => {});
          continue;
        }
      }
      const status = await readText(`${out}.status`, TAIL_BYTES);
      if (status === null) continue;
      const values = statusValues(status);
      if (Date.parse(values.started) < boot) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      if (terminal.has(values.state)) continue;
      const queue = values.queue_pos;
      const activity = await logActivity(`${out}.log`, now, values.state || '');
      jobs.push({
        out, state: values.state || '', model: values.model || '', effort: values.effort || '',
        sandbox: values.sandbox || '', engine: values.engine || '', ageS: seconds(values.started, now),
        dir: values.dir || '', error: values.error || '',
        queuePos: /^\d+$/.test(queue || '') && Number.isSafeInteger(Number(queue)) ? Number(queue) : null,
        owner: values.owner || '', idleS: activity.idleS, activity: activity.activity,
        ...(values.daemon_profile ? { daemonProfile: values.daemon_profile } : {})
      });
    }
  }));
  return jobs.sort(newest).slice(0, 40);
}

async function logActivity(file, now, state = '') {
  if (!localPath(file)) return missingActivity(state);
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return missingActivity(state);
    const idleS = Math.max(0, Math.floor((now - stat.mtimeMs) / 1000));
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // The first tail line may be cut and cannot be a reliable marker.
    let current = { kind: bytesRead ? 'unknown' : 'starting', text: '' };
    let pending = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === 'exec') { pending = 'exec'; continue; }
      if (line === 'codex') { pending = 'codex'; continue; }
      if (pending) {
        if (pending === 'exec') {
          const command = line.replace(/\s+in\s+.+$/, '');
          current = { kind: 'command', text: cleanText(command, 120) };
        } else {
          current = { kind: 'writing', text: cleanText(line, 80) };
        }
        pending = '';
        continue;
      }
      if (/^ succeeded in \d+ms:|^ exited \d+ in \d+ms:/.test(line) ||
          /^item\/completed type=commandExecution\b/.test(line)) {
        current = { kind: 'thinking', text: '' };
      } else if (/^item\/started type=reasoning\b/.test(line)) {
        current = { kind: 'thinking', text: '' };
      } else if (/^(apply patch|apply_patch|file update)\b/.test(line)) {
        const next = lines[i + 1] || '';
        const pathMatch = next.match(/(?:\*\*\*\s*(?:Update|Add|Delete) File:\s*|(?:file|path):\s*)(.+)$/i) ||
          next.match(/^((?:[A-Za-z]:[\\/]|\.\.?[\\/]|[^\s]+[\\/])[^\s]+)$/);
        current = { kind: 'editing', text: cleanText(pathMatch?.[1] || '', 120) };
      } else if (/^item\/started type=fileChange\b/.test(line)) {
        const pathMatch = line.match(/\b(?:path|file)=([^\s]+)/);
        current = { kind: 'editing', text: cleanText(pathMatch?.[1] || '', 120) };
      } else if (/^item\/started type=agentMessage\b/.test(line)) {
        current = { kind: 'writing', text: cleanText(line.replace(/^.*?type=agentMessage\s*/, ''), 80) };
      } else if (/^(?:turn|job) start\b/.test(line)) {
        current = { kind: 'starting', text: '' };
      }
    }
    // Logs have no timestamps; use log mtime as the best available sinceS estimate.
    if (state === 'queued' || state.startsWith('waiting-')) current = { kind: 'queued', text: state };
    return { idleS, activity: { ...current, sinceS: idleS } };
  } catch { return missingActivity(state); }
  finally { if (handle) await handle.close().catch(() => {}); }
}

function missingActivity(state = '') {
  const queued = state === 'queued' || state.startsWith('waiting-');
  return { idleS: null, activity: { kind: queued ? 'queued' : 'unknown',
    text: queued ? state : '', sinceS: null } };
}

async function fetchJson(info, route) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      headers: { 'X-Luna-Token': info.token }, signal: AbortSignal.timeout(1000), redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = await response.json();
    return object(value) ? value : null;
  } catch { return null; }
}

function daemonJobs(list, now, profile) {
  if (!Array.isArray(list)) return [];
  return list.filter((job) => object(job) &&
    (job.state === 'running' || job.state === 'queued' || string(job.state).startsWith('waiting-')))
    .map((job) => ({
      id: string(job.id), state: string(job.state), model: string(job.model), effort: string(job.effort),
      sandbox: string(job.sandbox), owner: string(job.owner),
      ageS: seconds(job.queuedAt, now) ?? number(job.ageS), cwd: string(job.cwd), reason: string(job.reason),
      idleS: null, activity: { kind: job.state === 'queued' || string(job.state).startsWith('waiting-')
        ? 'queued' : 'unknown', text: job.state === 'queued' || string(job.state).startsWith('waiting-')
          ? string(job.state) : '', sinceS: null },
      ...(profile ? { daemonProfile: profile } : {})
    })).sort(newest).slice(0, 30);
}

async function daemonStatus(directory, now, snapshot, profile) {
  const info = await readJson(path.join(directory, 'daemon.json'));
  if (!info || !matchingProcess(info.pid, info.pid_start)) return;
  const result = {
    running: true, pid: info.pid, uptimeS: seconds(info.startedAt, now), max: null,
    runningJobs: null, queuedJobs: null, owners: [], jobs: [], appServer: null, healthy: false
  };
  snapshot.daemon = result;
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string') {
    return;
  }
  // The independent 1 s deadlines overlap, rather than consuming the entire 2 s budget in sequence.
  await Promise.all([
    fetchJson(info, '/health').then((health) => {
      result.healthy = health?.ok === true;
      result.appServer = ['up', 'down', 'restarting'].includes(health?.appServer) ? health.appServer : null;
      result.uptimeS = number(health?.uptimeS) ?? result.uptimeS;
      result.max = number(health?.max);
      result.runningJobs = number(health?.jobs?.running);
      result.queuedJobs = number(health?.jobs?.queued);
    }),
    fetchJson(info, '/jobs').then((list) => {
      result.jobs = daemonJobs(list?.jobs, now, profile);
      if (object(list?.owners)) {
        result.owners = Object.entries(list.owners).map(([owner, counts]) => ({
          owner, running: number(counts?.running), queued: number(counts?.queued)
        }));
      }
    })
  ]);
}

async function daemonProfiles(directory, now, snapshot) {
  const defaults = empty(now), net = empty(now);
  await Promise.all([
    daemonStatus(directory, now, defaults, 'default'),
    daemonStatus(path.join(directory, 'daemon-net'), now, net, 'net')
  ]);
  const profiles = { default: defaults.daemon, net: net.daemon };
  const running = Object.values(profiles).filter((daemon) => daemon.running);
  if (!running.length) return;
  const sum = (key) => running.every((daemon) => typeof daemon[key] === 'number')
    ? running.reduce((total, daemon) => total + daemon[key], 0) : null;
  const primary = defaults.daemon.running ? defaults.daemon : net.daemon;
  const owners = new Map();
  for (const daemon of running) {
    for (const entry of daemon.owners) {
      const current = owners.get(entry.owner) || { owner: entry.owner, running: 0, queued: 0 };
      for (const key of ['running', 'queued']) {
        current[key] = current[key] === null || entry[key] === null ? null : current[key] + entry[key];
      }
      owners.set(entry.owner, current);
    }
  }
  snapshot.daemon = {
    ...primary, healthy: running.every((daemon) => daemon.healthy),
    appServer: running.some((daemon) => daemon.appServer === 'down') ? 'down'
      : running.some((daemon) => daemon.appServer === 'restarting') ? 'restarting'
        : running.every((daemon) => daemon.appServer === 'up') ? 'up' : null,
    max: sum('max'), runningJobs: sum('runningJobs'), queuedJobs: sum('queuedJobs'), owners: [...owners.values()],
    jobs: running.flatMap((daemon) => daemon.jobs).sort(newest).slice(0, 30), profiles
  };
}

// Claude session heartbeats written by the luna-panel plugin of each session: <run>/sessions/<sessionId>.json.
// Beats older than 15 min are skipped (session closed or asleep); files older than a day are deleted.
async function sessionBeats(run, now) {
  const dir = path.join(run, 'sessions');
  let names = [];
  try { names = (await fs.readdir(dir)).filter((n) => /^[A-Za-z0-9._-]{1,128}.json$/.test(n)).slice(0, 100); } catch { return []; }
  const beats = [];
  await Promise.allSettled(names.map(async (name) => {
    const file = path.join(dir, name);
    const st = await fs.stat(file);
    if (now - st.mtimeMs > 86_400_000) { await fs.unlink(file).catch(() => {}); return; }
    if (st.size > 65_536) return;
    const beat = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!beat || beat.v !== 1 || typeof beat.sessionId !== 'string') return;
    if (now - Number(beat.updatedAt) > 900_000) return;
    beats.push(beat);
  }));
  return beats.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
}

async function collect(config, snapshot, now) {
  try {
    snapshot.ram = { freeMb: Math.round(availableMemory() / 1048576), totalMb: Math.round(totalmem() / 1048576) };
  } catch {}
  await Promise.allSettled([
    daemonProfiles(config.daemon, now, snapshot),
    activeJobs(config.run, now).then((jobs) => { snapshot.jobs = jobs; }),
    Promise.all([
      readJson(path.join(config.run, 'codex-limits.json')),
      readJson(path.join(config.daemon, 'daemon-net', 'codex-limits.json'))
    ]).then((candidates) => {
      const limits = candidates.filter(Boolean).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
      snapshot.codexLimits = limits ? { ...limits, ageS: seconds(limits.at, now) } : null;
    }),
    sessionBeats(config.run, now).then((sessions) => { snapshot.sessions = sessions; })
  ]);
  return snapshot;
}

function human(snapshot) {
  const { ram, daemon, jobs, codexLimits: limits } = snapshot;
  return [
    `RAM ${ram.freeMb ?? '?'} / ${ram.totalMb ?? '?'} MB free`,
    daemon.running
      ? `Daemon ${daemon.pid}: ${daemon.runningJobs ?? '?'} running, ${daemon.queuedJobs ?? '?'} queued`
      : 'Daemon stopped',
    `Active ${jobs.length}${jobs.length ? ': ' + jobs.map((job) => `${job.state} ${job.model}`).join(', ') : ''}`,
    limits ? `Codex limits: reached=${limits.reached ?? '?'}, age=${limits.ageS ?? '?'}s` : 'Codex limits unknown',
    'Shell bash'
  ].join('\n');
}

async function selfTest() {
  const saved = Object.fromEntries(['LUNA_OVERVIEW_HOME', 'LUNA_DAEMON_HOME'].map((key) => [key, process.env[key]]));
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'luna-overview-test-'));
  const now = Date.now();
  const result = { passed: 0, failed: 0, errors: [] };
  const check = (name, fn) => {
    try { fn(); result.passed++; }
    catch (error) { result.failed++; result.errors.push(`${name}: ${error.message}`); }
  };
  try {
    process.env.LUNA_OVERVIEW_HOME = directory;
    process.env.LUNA_DAEMON_HOME = path.join(directory, 'daemon');
    const config = configuration();
    await fs.mkdir(path.join(directory, 'active'));
    await fs.mkdir(config.daemon);
    await fs.writeFile(path.join(config.daemon, 'daemon.json'), JSON.stringify({
      pid: 0, port: 1, token: 'SECRET-NEVER-PRINT', startedAt: new Date(now).toISOString()
    }));
    const limits = { v: 1, at: new Date(now - 5000).toISOString(), source: 'test', planType: 'pro',
      ordinaryUsageAllowed: true, reached: false, primary: null, secondary: null, byLimitId: {} };
    await fs.writeFile(path.join(directory, 'codex-limits.json'), JSON.stringify(limits));
    const states = ['running', 'queued', 'waiting-capacity', 'done', 'failed', 'incomplete', 'stalled'];
    for (const [index, state] of states.entries()) {
      const out = path.join(directory, `job-${index}`);
      await fs.writeFile(path.join(directory, 'active', `${index + 100}`),
        `${out}\r\n${process.pid}\r\n${readProcess(process.pid).started}\r\n`);
      const started = new Date(now - (index + 1) * 1000).toISOString().replace('Z', '+00:00');
      await fs.writeFile(`${out}.status`, [
        `state=${state}`, 'state=done', `started=${started}`, 'model=test', 'effort=high', 'sandbox=read-only',
        'engine=daemon', `dir=${directory}/work=a`, 'error=a=b', 'queue_pos=2', 'owner=owner-a', ''
      ].join('\n'));
    }
    await fs.writeFile(path.join(directory, 'active', '999'), path.join(directory, 'missing'));
    const snapshot = JSON.parse(JSON.stringify(await collect(config, empty(now), now)));
    check('root overrides', () => {
      assert.equal(config.run, directory);
      assert.equal(config.daemon, path.join(directory, 'daemon'));
      delete process.env.LUNA_DAEMON_HOME;
      assert.equal(configuration().daemon, directory);
    });
    check('JSON shape', () => {
      assert.deepEqual(Object.keys(snapshot), ['v', 'at', 'ram', 'daemon', 'jobs', 'codexLimits', 'build', 'sessions']);
      assert.equal(snapshot.v, 1);
      assert.equal(snapshot.at, new Date(now).toISOString());
      assert.deepEqual(Object.keys(snapshot.ram), ['freeMb', 'totalMb']);
      assert.equal(typeof snapshot.ram.freeMb, 'number');
      assert.deepEqual(snapshot.daemon, { running: false, appServer: null, healthy: false });
      assert.deepEqual(Object.keys(snapshot.jobs[0]), [
        'out', 'state', 'model', 'effort', 'sandbox', 'engine', 'ageS', 'dir', 'error', 'queuePos',
        'owner', 'idleS', 'activity'
      ]);
      assert.equal(snapshot.build, null);
    });
    check('terminal filtering and newest first', () => {
      assert.deepEqual(snapshot.jobs.map((job) => job.state), states.slice(0, 3));
      assert.deepEqual(snapshot.jobs.map((job) => job.ageS), [1, 2, 3]);
      assert.equal(snapshot.jobs[0].queuePos, 2);
      assert.equal(snapshot.jobs[0].dir, `${directory}/work=a`);
      assert.equal(snapshot.jobs[0].error, 'a=b');
      assert.equal(snapshot.jobs[0].owner, 'owner-a');
    });
    check('two-line index format', () => {
      assert.equal(snapshot.jobs.length, 3);
      assert.ok(localPath(snapshot.jobs[0].out));
    });
    check('Linux absolute paths including spaces', () => {
      for (const value of ['/tmp/job', `${directory}/some path/job`]) assert.equal(localPath(value), true);
      for (const value of ['//server/share/job', 'job', '']) assert.equal(localPath(value), false);
    });
    const staleOut = path.join(directory, 'stale-job');
    const deadEntry = path.join(directory, 'active', 'dead-pid');
    const legacyEntry = path.join(directory, 'active', 'legacy-stale');
    const liveEntry = path.join(directory, 'active', 'live-pid');
    await fs.writeFile(`${staleOut}.status`, 'state=running\n');
    await fs.utimes(`${staleOut}.status`, new Date(now - 601_000), new Date(now - 601_000));
    await fs.writeFile(deadEntry, `${staleOut}\n2147483647\n`);
    await fs.writeFile(legacyEntry, `${staleOut}\n`);
    await fs.writeFile(liveEntry, `${staleOut}\n${process.pid}\n${readProcess(process.pid).started}\n`);
    const rejected = ['//server/share/job', 'relative/job'];
    for (const [index, out] of rejected.entries()) {
      await fs.writeFile(path.join(directory, 'active', `unc-${index}`), `${out}\n2147483647\n`);
    }
    const indexed = await activeJobs(directory, now);
    check('live two-line entry survives an old status mtime', () => {
      assert.equal(indexed.filter((job) => job.out === staleOut).length, 1);
    });
    check('UNC entries rejected', () => {
      assert.ok(!indexed.some((job) => rejected.includes(job.out)));
    });
    const remaining = await fs.readdir(path.join(directory, 'active'));
    check('stale pid and legacy entries removed without touching UNC entries', () => {
      assert.ok(!remaining.includes('dead-pid'));
      assert.ok(!remaining.includes('legacy-stale'));
      assert.ok(!remaining.includes('999'));
      assert.ok(remaining.includes('live-pid'));
      assert.ok(rejected.every((_, index) => remaining.includes(`unc-${index}`)));
    });
    await fs.writeFile(deadEntry, `${staleOut}\n${process.pid}\nreused\n`);
    const reused = await activeJobs(directory, now);
    check('reused PID is rejected despite being alive', () => {
      assert.equal(reused.filter((job) => job.out === staleOut).length, 1);
    });
    for (const file of [deadEntry, liveEntry, ...rejected.map((_, index) =>
      path.join(directory, 'active', `unc-${index}`))]) await fs.unlink(file).catch(() => {});
    const freshLegacy = path.join(directory, 'active', 'legacy-fresh');
    await fs.utimes(`${staleOut}.status`, new Date(now), new Date(now));
    await fs.writeFile(freshLegacy, `${staleOut}\n`);
    const legacy = await activeJobs(directory, now);
    check('recent one-line index retained', () => assert.ok(legacy.some((job) => job.out === staleOut)));
    await fs.unlink(freshLegacy);
    const boot = now - 60_000;
    for (const [name, started, keep] of [
      ['before-boot', boot - 86_400_000, false],
      ['just-before-boot', boot - 1, false],
      ['at-boot', boot, true],
      ['after-boot', boot + 1, true],
      ['invalid-started', 'invalid', true]
    ]) {
      const out = path.join(directory, name);
      const entry = path.join(directory, 'active', name);
      const stamp = typeof started === 'number' ? new Date(started).toISOString() : started;
      await fs.writeFile(`${out}.status`, `state=running\nstarted=${stamp}\n`);
      await fs.writeFile(entry, `${out}\n${process.pid}\n${readProcess(process.pid).started}\n`);
      const jobs = await activeJobs(directory, now, boot);
      const present = (await fs.readdir(path.dirname(entry))).includes(name);
      check(`live pid ${name}: index and listing`, () => {
        assert.equal(present, keep);
        assert.equal(jobs.some((job) => job.out === out), keep);
      });
      if (present) await fs.unlink(entry);
    }
    const scan = path.join(directory, 'scan');
    await fs.mkdir(path.join(scan, 'active'), { recursive: true });
    await Promise.all(Array.from({ length: ACTIVE_LIMIT + 1 }, async (_, index) => {
      const file = path.join(scan, 'active', String(index));
      const entry = `${staleOut}\n${process.pid}\n${readProcess(process.pid).started}\n`;
      await fs.writeFile(file, index ? 'relative-path\n' : entry);
      const at = new Date(now - (index ? 1000 : 2000));
      await fs.utimes(file, at, at);
    }));
    const excluded = await activeJobs(scan, now);
    check('scan capped at 200 newest entries', () => assert.deepEqual(excluded, []));
    await fs.utimes(path.join(scan, 'active', '0'), new Date(now), new Date(now));
    const included = await activeJobs(scan, now);
    check('newest entry is scanned first', () => assert.equal(included.length, 1));
    const originalFetch = globalThis.fetch;
    try {
      await fs.writeFile(path.join(config.daemon, 'daemon.json'), JSON.stringify({
        pid: process.pid, pid_start: readProcess(process.pid).started, port: 1,
        token: 'SECRET-NEVER-PRINT', startedAt: new Date(now).toISOString()
      }));
      for (const [ok, appServer, expected] of [
        [true, 'up', 'up'], [true, 'down', 'down'], [true, 'restarting', 'restarting'],
        [false, 'up', 'up'], [true, 'unknown', null], [undefined, undefined, null]
      ]) {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok, appServer }) });
        const projected = empty(now);
        await daemonStatus(config.daemon, now, projected);
        check(`daemon health projection ${ok}/${appServer}`, () => {
          assert.equal(projected.daemon.healthy, ok === true);
          assert.equal(projected.daemon.appServer, expected);
        });
      }
      globalThis.fetch = async () => { throw new Error('health unavailable'); };
      const unavailable = empty(now);
      await daemonStatus(config.daemon, now, unavailable);
      check('unavailable health stays unhealthy with unknown app-server', () => {
        assert.equal(unavailable.daemon.running, true);
        assert.equal(unavailable.daemon.healthy, false);
        assert.equal(unavailable.daemon.appServer, null);
      });
      await fs.mkdir(path.join(config.daemon, 'daemon-net'));
      await fs.writeFile(path.join(config.daemon, 'daemon-net', 'daemon.json'), JSON.stringify({
        pid: process.pid, pid_start: readProcess(process.pid).started, port: 2,
        token: 'OTHER-SECRET', startedAt: new Date(now).toISOString()
      }));
      globalThis.fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/health')
        ? { ok: true, appServer: 'up', jobs: { running: 1, queued: 0 } }
        : { jobs: [{ id: url.includes(':2/') ? 'net-job' : 'default-job', state: 'running' }] } });
      const both = empty(now);
      await daemonProfiles(config.daemon, now, both);
      check('overview collects both profiles and labels their jobs', () => {
        assert.equal(both.daemon.runningJobs, 2);
        assert.equal(both.daemon.profiles.default.running, true);
        assert.equal(both.daemon.profiles.net.running, true);
        assert.deepEqual(both.daemon.jobs.map((job) => job.daemonProfile).sort(), ['default', 'net']);
        assert.ok(!JSON.stringify(both).includes('SECRET'));
      });
      await fs.unlink(path.join(config.daemon, 'daemon-net', 'daemon.json'));
    } finally {
      globalThis.fetch = originalFetch;
      await fs.writeFile(path.join(config.daemon, 'daemon.json'), JSON.stringify({ pid: 0 }));
    }
    const activityLog = path.join(directory, 'activity.log');
    const activityFor = async (text, state = 'running') => {
      await fs.writeFile(activityLog, text);
      return logActivity(activityLog, now, state);
    };
    const activityCases = [
      ['exec command', `exec\r\nrg -n auth src/ in ${directory}/work\r\n`, 'command', 'rg -n auth src/'],
      ['exec completion', `exec\nrg -n auth src/ in ${directory}/work\n succeeded in 123ms:\n`, 'thinking', ''],
      ['reasoning', 'item/started type=reasoning\n', 'thinking', ''],
      ['file edit', 'apply patch\n*** Update File: src/main.mjs\n', 'editing', 'src/main.mjs'],
      ['agent writing', 'codex\nWriting a concise update\n', 'writing', 'Writing a concise update'],
      ['daemon command completion', 'item/completed type=commandExecution id=1\n', 'thinking', ''],
      ['daemon file change', 'item/started type=fileChange path=src/next.mjs\n', 'editing', 'src/next.mjs'],
      ['daemon agent message', 'item/started type=agentMessage Here is the update\n', 'writing',
        'Here is the update'],
      ['job start', 'job start 123\n', 'starting', ''],
      ['turn start', 'turn start 123\n', 'starting', ''],
      ['empty log', '', 'starting', ''],
      ['unknown', 'plain output\n', 'unknown', ''],
      ['queued state', 'plain output\n', 'queued', 'waiting-capacity']
    ];
    for (const [name, text, kind, message, state] of activityCases) {
      const actual = await activityFor(text, state || (name === 'queued state' ? 'waiting-capacity' : 'running'));
      check(name, () => {
        assert.equal(actual.activity.kind, kind);
        assert.equal(actual.activity.text, message);
        assert.equal(actual.activity.sinceS, actual.idleS);
      });
    }
    await fs.writeFile(activityLog, 'exec\n' + 'x'.repeat(TAIL_BYTES + 100) +
      '\ncodex\r\nNewest message\r\n');
    const largeTail = await logActivity(activityLog, now, 'running');
    check('large log, cut first line, and CRLF', () => {
      assert.equal(largeTail.activity.kind, 'writing');
      assert.equal(largeTail.activity.text, 'Newest message');
    });
    await fs.rm(activityLog);
    const missingLog = await logActivity(activityLog, now, 'queued');
    check('missing log age', () => {
      assert.equal(missingLog.idleS, null);
      assert.deepEqual(missingLog.activity, { kind: 'queued', text: 'queued', sinceS: null });
    });
    check('token absent', () => {
      assert.ok(!JSON.stringify(snapshot).includes('SECRET-NEVER-PRINT'));
      assert.ok(!JSON.stringify(snapshot).includes('token'));
    });
    check('limits pass through', () => assert.deepEqual(snapshot.codexLimits, { ...limits, ageS: 5 }));
    await Promise.all(Array.from({ length: 45 }, async (_, index) => {
      const out = path.join(directory, `extra-${index}`);
      await fs.writeFile(path.join(directory, 'active', `${index + 1000}`), `${out}\n`);
      await fs.writeFile(`${out}.status`, `state=running\nstarted=${new Date(now).toISOString()}\n`);
    }));
    const capped = await activeJobs(directory, now);
    check('active cap and missing fields', () => {
      assert.equal(capped.length, 40);
      assert.ok(capped.every((job) => job.ageS === 0 && job.owner === '' && job.queuePos === null));
    });
    await fs.writeFile(path.join(directory, 'codex-limits.json'), '{broken');
    const missing = { ...config, run: path.join(directory, 'absent') };
    check('first occurrence wins', () => assert.equal(statusValues('x=first\nx=second\nx=third').x, 'first'));
    const invalid = await collect(config, empty(now), now);
    const absent = await collect(missing, empty(now), now);
    check('missing and corrupt inputs', () => {
      assert.equal(invalid.codexLimits, null);
      assert.deepEqual(absent.jobs, []);
      assert.equal(absent.codexLimits, null);
      assert.equal(absent.build, null);
    });
    check('daemon projection and cap without networking', () => {
      const list = Array.from({ length: 35 }, (_, index) => ({
        id: String(index), state: 'queued', ageS: 35 - index, token: 'SECRET-NEVER-PRINT'
      }));
      const jobs = daemonJobs([...list, { state: 'completed' }, { state: 'failed' }, null], now);
      assert.equal(jobs.length, 30);
      assert.equal(jobs[0].id, '34');
      assert.ok(!JSON.stringify(jobs).includes('token'));
      assert.deepEqual(Object.keys(jobs[0]), [
        'id', 'state', 'model', 'effort', 'sandbox', 'owner', 'ageS', 'cwd', 'reason', 'idleS',
        'activity'
      ]);
    });
    check('human summary', () => assert.ok(human(snapshot).includes('Daemon stopped')));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Delete only the exact directory created above, after verifying its parent and task prefix.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('luna-overview-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
  return result;
}

// `--beat`: the luna-panel plugin of a Claude session sends that session's heartbeat on stdin (the plugin's own file
// writes outside the project are not allowed, its process runs are). Stored atomically as <run>/sessions/<id>.json
// before collecting, so the caller's own session is in the snapshot. Bad input is ignored; never fails the run.
async function storeBeat(run, now) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65_536) return;
      chunks.push(chunk);
    }
    const beat = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!beat || beat.v !== 1 || typeof beat.sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(beat.sessionId)) return;
    const dir = path.join(run, 'sessions');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${beat.sessionId}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ...beat, updatedAt: now }), 'utf8');
    await fs.rename(temp, file).catch(async () => { await fs.writeFile(file, JSON.stringify({ ...beat, updatedAt: now })); });
    await fs.unlink(temp).catch(() => {});
  } catch {}
}

function triggerReaper() {
  if (process.argv.includes('--self-test') || process.argv.includes('--human')) return;
  try {
    const home = process.env.HOME || homedir();
    const stamp = path.join(home, '.claude', 'luna-run', 'reap-brokers.stamp');
    try {
      if (Date.now() - statSync(stamp).mtimeMs < 600_000) return;
    } catch (error) { if (error.code !== 'ENOENT') return; }
    const reaper = fileURLToPath(new URL('./luna-reap-brokers.mjs', import.meta.url));
    const child = spawn(process.execPath, [reaper], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

let snapshot = empty();
let printed = false;
let deadline;
function finish(value = snapshot) {
  if (printed) return;
  printed = true;
  clearTimeout(deadline);
  let output;
  try {
    output = process.argv.includes('--human') && !process.argv.includes('--self-test')
      ? human(value) : JSON.stringify(value, null, process.argv.includes('--pretty') ? 2 : undefined);
  } catch { output = JSON.stringify(empty()); }
  // Explicit exit also releases pending filesystem requests and fetch keep-alive handles at the deadline.
  setTimeout(() => process.exit(0), 30);
  try {
    process.stdout.write(`${output}\n`, () => {
      triggerReaper();
      process.exit(0);
    });
  }
  catch { process.exit(0); }
}

process.stdout.on('error', () => process.exit(0));
process.on('uncaughtException', () => finish());
process.on('unhandledRejection', () => finish());
try {
  if (process.argv.includes('--self-test')) {
    finish(await selfTest().catch(() => ({ passed: 0, failed: 1, errors: ['self-test setup or cleanup failed'] })));
  } else {
    deadline = setTimeout(finish, DEADLINE_MS);
    const now = Date.now();
    snapshot = empty(now);
    const config = configuration();
    if (process.argv.includes('--beat')) await storeBeat(config.run, now);
    await collect(config, snapshot, now);
    finish();
  }
} catch { finish(); }
