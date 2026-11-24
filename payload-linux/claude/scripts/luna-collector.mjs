#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { home, platform, processAlive, readProcessStat } from './conveyor/lib/platform.mjs';
import { readSessions } from './conveyor/lib/sessions.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LEASE_MS = 90 * SECOND;
const DEADLINE = 120 * SECOND;
const SHUTDOWN_GRACE_MS = 3000;
const QUIET_MS = 30 * SECOND;
const MAX_SNAPSHOT = 3 * 1024 * 1024;
const MAX_BEAT = 16 * 1024;
const FAST_SECTIONS = ['daemon', 'jobs', 'orchestration', 'mlai'];
const QUIET_SECTIONS = new Set(['sessions', 'codexAccounts', 'codexLimits']);
const iso = (time = Date.now()) => new Date(time).toISOString();
const message = (error) => String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function configuration() {
  const claudeHome = path.resolve(home(), '.claude');
  const runDir = path.resolve(process.env.LUNA_RUN_DIR || path.join(claudeHome, 'luna-run'));
  const directory = path.join(runDir, 'collector'), local = path.join(claudeHome, 'luna-run', 'collector');
  return { claudeHome, runDir, directory, lock: path.join(local, 'collector.lock'), stopped: path.join(local, 'stopped'),
    supervisorEpoch: path.join(local, 'supervisor-epoch'),
    discovery: path.join(directory, 'discovery.json'), snapshot: path.join(directory, 'snapshot.json'),
    widget: path.join(directory, 'leases', 'widget.json') };
}

function readJson(file, maxBytes) {
  try {
    if (maxBytes && statSync(file).size > maxBytes) return null;
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

const remove = (file) => rmSync(file, { force: true });

function writeAtomic(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally { remove(temp); }
}

function ownerPidAlive(owner) {
  return processAlive(owner?.pid) && (!owner.procStart || platform !== 'linux' ||
    String(owner.procStart) === readProcessStat(owner.pid)?.started);
}

async function acquireLock(config, owner) {
  const file = config.lock;
  const write = (target) => {
    try { writeFileSync(target, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  const create = () => write(file) ? 0 : 1;
  if (write(file)) return 0;
  const freshEmptyLock = (stat) => Date.now() - stat?.mtimeMs < 10 * SECOND;
  const lockStat = statSync(file, { throwIfNoEntry: false });
  if (!lockStat) return create();
  const previous = readJson(file);
  if (!previous && freshEmptyLock(lockStat)) return 1;
  if (ownerPidAlive(previous)) {
    const maxWait = Math.min(20 * SECOND, Math.max(1, Number(process.env.LUNA_COLLECTOR_LOCK_RETRY_MS) || 20 * SECOND));
    const until = performance.now() + maxWait;
    do {
      const started = performance.now();
      if (await healthy(config, previous, Math.max(1, Math.floor(Math.min(2 * SECOND, until - started))))) return 3;
      const remaining = until - performance.now();
      if (remaining <= 0 || !ownerPidAlive(previous) || readJson(file)?.instance !== previous.instance) break;
      await sleep(Math.max(0, Math.min(remaining, started + 2 * SECOND - performance.now())));
    } while (performance.now() < until);
  }

  // Serialize replacement of a dead owner's lock, including recovery if a reclaimer dies.
  const instance = (value) => /^[a-f0-9-]{36}$/i.test(value?.instance) ? value.instance : 'unknown';
  const candidate = `${file}.${owner.instance}.tmp`;
  write(candidate);
  const claims = [];
  try {
    let claim = `${file}.reclaim.${instance(previous)}`;
    for (;;) {
      try {
        linkSync(candidate, claim);
        break;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const reclaimer = readJson(claim);
      if (instance(reclaimer) === 'unknown' || ownerPidAlive(reclaimer)) return 1;
      claims.push(claim);
      claim = `${file}.reclaim.${reclaimer.instance}`;
    }
    claims.push(claim);
    const current = readJson(file);
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat) return create();
    if (current?.instance !== previous?.instance || !current && freshEmptyLock(stat)) return 1;
    remove(file);
    return create();
  } finally {
    if (claims.length && readJson(claims.at(-1))?.instance === owner.instance) {
      for (const claim of claims) remove(claim);
    }
    remove(candidate);
  }
}

function releaseLock(config, owner) {
  const claim = `${config.lock}.reclaim.${owner.instance}`;
  try { linkSync(config.lock, claim); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return;
    throw error;
  }
  try {
    if (readJson(config.lock)?.instance !== owner.instance) return;
    try {
      if (readJson(config.discovery)?.instance === owner.instance) remove(config.discovery);
    } finally { remove(config.lock); }
  } finally { remove(claim); }
}

async function request(info, route, method = 'GET', timeout = 2 * SECOND) {
  return fetch(`http://127.0.0.1:${info.port}${route}`, {
    method, headers: { 'x-luna-token': info.token }, signal: AbortSignal.timeout(timeout), redirect: 'error'
  });
}

async function healthy(config, owner = readJson(config.lock), timeout = 2 * SECOND) {
  try {
    const info = readJson(typeof owner?.discovery === 'string' ? owner.discovery : config.discovery);
    if (info?.version !== 1 || info.pid !== owner?.pid || info.instance !== owner?.instance ||
        typeof info.instance !== 'string' || !ownerPidAlive(owner) ||
        !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{32}$/.test(info.token)) return null;
    const response = await request(info, '/health', 'GET', timeout);
    const health = response.ok ? await response.json() : null;
    return health?.ok === true && health.instance === info.instance &&
      readJson(config.lock)?.instance === info.instance ? info : null;
  } catch { return null; }
}

async function runUsage({ now }) {
  const { collectUsage, readUsageSummary } = await import('./conveyor/usage.mjs');
  if ((await collectUsage({ now })).locked) throw new Error('usage collection already running');
  return { ...await readUsageSummary({ now }), stale: false };
}

// The round reads the limits files at the pane's pace, but starts an app-server for an account at most once per
// PROBE_EVERY_MS: a probe that keeps failing must not respawn Codex every few seconds.
const PROBE_EVERY_MS = 5 * MINUTE;
const probedAt = new Map();

async function collectCodexAccounts(now, signal) {
  const { codexLimitsSnapshot, loadConfig, providerState } = await import('./conveyor/lib/orchestration.mjs');
  const { accountPaths } = await import('./conveyor/lib/codex-accounts.mjs');
  const { probeLimits } = await import('./lib/codex-limits-probe.mjs');
  const config = await loadConfig();
  const initial = await providerState(config, { now, persist: false });
  for (const { id, loggedIn } of initial.threshold.accounts) {
    signal.throwIfAborted();
    const { ageS } = initial.usage.codexAccounts[id];
    if (!loggedIn || (ageS !== null && ageS <= 10 * MINUTE / SECOND)) continue;
    // Windows has one account and an unverified app-server launch here: it only reads what its daemon wrote.
    if (platform === 'win32' || now - (probedAt.get(id) ?? -Infinity) < PROBE_EVERY_MS) continue;
    probedAt.set(id, now);
    const { codexHome, runRoot } = accountPaths(id);
    await probeLimits({ codexHome, out: path.join(runRoot, 'codex-limits.probe.json'), signal });
  }
  signal.throwIfAborted();
  return codexLimitsSnapshot(await providerState(config, { persist: false }));
}

async function readProbeJson(file) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function section(staleAfterMs) {
  return { attemptAt: null, okAt: null, staleAfterMs, status: 'unavailable', reason: 'waiting for first attempt' };
}

function sectionView(value, now) {
  if (value.status === 'ok' && now - Date.parse(value.okAt) > value.staleAfterMs) {
    return { ...value, status: 'stale', reason: 'last success exceeded freshness window' };
  }
  return value;
}

function snapshotText(snapshot, defaults) {
  const encode = (value) => JSON.stringify(value) + '\n';
  const fits = (text) => Buffer.byteLength(text) <= MAX_SNAPSHOT;
  const full = encode(snapshot);
  if (fits(full)) return full;
  const trim = (list, size) => Array.isArray(list) ? list.slice(0, size) : list;
  const trimDaemon = (daemon, size) => {
    if (!object(daemon)) return daemon;
    const result = { ...daemon };
    if (Array.isArray(daemon.jobs)) result.jobs = trim(daemon.jobs, size);
    if (object(daemon.profiles)) result.profiles = trimDaemons(daemon.profiles, size);
    return result;
  };
  const trimDaemons = (daemons, size) => Object.fromEntries(
    Object.entries(daemons).map(([name, value]) => [name, trimDaemon(value, size)]));
  const reduced = { ...snapshot, truncated: true };
  const withLists = (size) => ({
    ...reduced, jobs: trim(reduced.jobs, size), sessions: trim(reduced.sessions, size),
    daemon: trimDaemon(reduced.daemon, size),
    ...(object(reduced.daemons) ? { daemons: trimDaemons(reduced.daemons, size) } : {})
  });
  const count = (list) => Array.isArray(list) ? list.length : 0;
  const daemonCount = (daemon) => Math.max(count(daemon?.jobs), ...Object.values(daemon?.profiles || {}).map(daemonCount));
  let low = 0, high = Math.max(count(snapshot.jobs), count(snapshot.sessions), daemonCount(snapshot.daemon),
    ...Object.values(snapshot.daemons || {}).map(daemonCount));
  const best = withLists(0);
  let text = encode(best);
  if (fits(text)) {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = encode(withLists(mid));
      if (fits(candidate)) { low = mid; text = candidate; }
      else high = mid - 1;
    }
    return text;
  }
  // Oversized non-list fields are exceptional. Restore their empty values in order of size.
  const fields = Object.keys(defaults).concat(['cli', 'claudeLimits']).sort((a, b) =>
    Buffer.byteLength(encode(best[b])) - Buffer.byteLength(encode(best[a])));
  for (const name of fields) {
    best[name] = name === 'claudeLimits' ? [] : defaults[name] ?? null;
    text = encode(best);
    if (fits(text)) return text;
  }
  throw new Error('collector snapshot metadata exceeded 3 MiB');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function assembleServer(token, health, beat, stop) {
  const expected = Buffer.from(token);
  const server = createServer((req, res) => {
    const reply = (code, value) => {
      res.writeHead(code, value ? { 'content-type': 'application/json' } : {});
      res.end(value ? JSON.stringify(value) : undefined);
    };
    const given = Buffer.from(String(req.headers['x-luna-token'] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      req.resume();
      return reply(403);
    }
    if (req.method === 'GET' && req.url === '/health') return reply(200, health());
    if (req.method === 'POST' && req.url === '/stop') {
      res.once('finish', () => stop('stop requested over HTTP'));
      req.resume();
      return reply(204);
    }
    if (req.method !== 'POST' || req.url !== '/beat') {
      req.resume();
      return reply(404);
    }
    if (Number(req.headers['content-length']) > MAX_BEAT) {
      req.resume();
      res.setHeader('connection', 'close');
      return reply(413);
    }
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_BEAT) chunks.push(chunk);
      else if (!res.writableEnded) {
        chunks.length = 0;
        res.setHeader('connection', 'close');
        reply(413);
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        beat(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        reply(204);
      } catch { reply(400); }
    });
    req.on('error', () => {});
  });
  server.requestTimeout = 10 * SECOND;
  server.headersTimeout = 5 * SECOND;
  server.setTimeout(10 * SECOND, (socket) => socket.destroy());
  return server;
}

function reclaim(config, owner) {
  try { writeFileSync(config.lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

async function serve(config, owner, result = {}) {
  const token = randomBytes(16).toString('hex');
  const defaults = {
    v: 1, ram: { freeMb: null, totalMb: null }, daemon: { running: false, appServer: null, healthy: false },
    jobs: [], codexLimits: null, codexAccounts: [], build: null, sessions: [], orchestration: null,
    switches: [], gemini: null, mlai: null, usage: null
  };
  if (platform === 'win32') defaults.daemons = {};
  const values = { ...defaults, cli: null };
  const beats = new Map(), limits = new Map(), jobs = [], pending = new Set();
  const shutdown = new AbortController();
  const metadata = Object.fromEntries(
    [...FAST_SECTIONS, ...QUIET_SECTIONS, 'ram', 'usage', 'cli', 'catalog', 'gemini'].map((name) => [name, section(0)]));
  metadata.gemini.reason = 'Gemini is not used';
  const saved = readJson(config.snapshot, MAX_SNAPSHOT);
  if (saved?.version === 2) {
    for (const name of Object.keys(values)) if (Object.hasOwn(saved, name)) values[name] = saved[name];
    for (const [name, state] of Object.entries(metadata)) {
      if (object(saved.sections?.[name])) Object.assign(state, saved.sections[name]);
    }
  }
  let seq = 0, dirty = true, stopping = false, quiet = true, liveSession = false, fastMs = MINUTE;
  let lastSections, timer, usageWorker, widgetRead, nextWidgetAt = 0;
  let widgetAt = NaN;
  let wakeStop;
  const stopped = new Promise((resolve) => { wakeStop = resolve; });
  const log = (error) => process.stderr.write(`luna-collector: ${message(error)}\n`);
  // Every stop says why in the journal: a collector that exits silently cannot be diagnosed.
  const stop = (reason) => {
    if (!stopping && typeof reason === 'string') log(`stopping: ${reason}`);
    stopping = true; shutdown.abort(); wakeStop();
  };
  const meta = (name) => metadata[name];

  const server = assembleServer(token, () => ({ ok: true, instance: owner.instance, seq }), (body) => {
    if (stopping || typeof body?.sessionId !== 'string' || !body.sessionId ||
        typeof body.visible !== 'boolean' || !Array.isArray(body.limits)) throw new Error('invalid beat');
    const now = Date.now();
    beats.set(body.sessionId, { at: now, visible: body.visible });
    for (const item of body.limits) {
      if (typeof item?.kind !== 'string' || !item.kind.trim() || !Number.isFinite(item.percentUsed)) continue;
      const resetsAt = item.resetsAt ?? null;
      if (resetsAt !== null && (typeof resetsAt !== 'string' || !Number.isFinite(Date.parse(resetsAt)))) continue;
      if (resetsAt !== null && Date.parse(resetsAt) <= now) {
        dirty = limits.delete(item.kind) || dirty;
        continue;
      }
      limits.set(item.kind, { kind: item.kind, percentUsed: item.percentUsed, resetsAt,
        observedAt: iso(now), sessionId: body.sessionId });
      dirty = true;
    }
  }, stop);

  function report(name, status, now, reason = null) {
    const state = meta(name);
    state.status = status;
    state.reason = reason;
    if (status === 'ok') state.okAt = iso(now);
    dirty = true;
  }

  function register({ names, interval, deadline = DEADLINE, work, merge }) {
    const job = { names, interval, deadline, work, merge, last: -Infinity, dueAt: 0, busy: false };
    jobs.push(job);
    return job;
  }

  function attempt(job, now) {
    const { names, deadline, work, merge } = job;
    job.busy = true;
    job.last = now;
    job.dueAt = now + job.interval();
    for (const name of names) meta(name).attemptAt = iso(now);
    dirty = true;
    const fail = (error) => {
      for (const name of names) report(name, meta(name).okAt ? 'stale' : 'unavailable', Date.now(), message(error));
    };
    const controller = new AbortController();
    const timeout = deadline === null ? null : setTimeout(() => {
      const error = new Error(`deadline exceeded after ${deadline} ms`);
      controller.abort(error);
      fail(error);
    }, deadline);
    const signal = AbortSignal.any([controller.signal, shutdown.signal]);
    const done = Promise.resolve().then(() => work(now, signal)).then((result) => {
      if (!controller.signal.aborted) merge(result, Date.now());
    }).catch((error) => {
      if (!signal.aborted) fail(error);
    }).finally(() => {
      clearTimeout(timeout);
      job.busy = false;
      pending.delete(done);
    });
    pending.add(done);
  }

  const fast = () => fastMs;
  const probeDeadline = 4 * SECOND;
  // Each app-server read has its own deadline, so a round can visit every account sequentially.
  const codexAccountsJob = register({ names: ['codexAccounts', 'codexLimits'], interval: () => quiet ? PROBE_EVERY_MS : fastMs, deadline: null,
    work: collectCodexAccounts,
    merge(result, now) {
      Object.assign(values, result);
      report('codexAccounts', 'ok', now);
      report('codexLimits', 'ok', now);
    } });
  register({ names: ['ram'], interval: fast, deadline: SECOND,
    async work() {
      let available = freemem();
      if (platform === 'linux') {
        const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
        const match = /^MemAvailable:\s+(\d+)/m.exec(meminfo);
        if (match) available = Number(match[1]) * 1024;
      }
      return { freeMb: Math.round(available / 1048576), totalMb: Math.round(totalmem() / 1048576) };
    },
    merge: (result, now) => { values.ram = result; report('ram', 'ok', now); } });
  register({ names: FAST_SECTIONS, interval: fast, deadline: probeDeadline,
    async work(now, signal) {
      const { collect } = await import('./luna-overview.mjs');
      return collect({ now, platform, claudeHome: config.claudeHome, includeGemini: false, signal, runDir: config.runDir,
        previous: { ...values, sections: { jobs: { ...meta('jobs') } } } });
    },
    merge(result, now) {
      for (const name of FAST_SECTIONS) {
        const supplied = Object.hasOwn(result, name) && (name !== 'jobs' || Array.isArray(result.jobs));
        const state = result.sections?.[name];
        if (state?.status === 'stale' || state?.status === 'unavailable') {
          report(name, state.status === 'unavailable' && meta(name).okAt ? 'stale' : state.status, now, state.reason);
          continue;
        }
        if (!supplied) {
          report(name, meta(name).okAt ? 'stale' : 'unavailable', now, 'overview did not supply this section');
          continue;
        }
        values[name] = result[name];
        report(name, 'ok', now);
      }
      for (const name of ['build', 'switches', 'daemons']) {
        if (Object.hasOwn(result, name) && !result.sections?.[name]) values[name] = result[name];
      }
    } });
  let sessionCursors = {}, sessionIdentities;
  register({ names: ['sessions'], interval: () => quiet ? QUIET_MS : fastMs, deadline: probeDeadline,
    async work(now) {
      const result = await readSessions({ now, claudeHome: config.claudeHome, cursors: sessionCursors,
        identities: sessionIdentities });
      sessionIdentities = result.identities ?? sessionIdentities;
      return result;
    },
    merge(result, now) {
      if (!Array.isArray(result.sessions)) throw new Error('readSessions did not return a session list');
      sessionCursors = result.cursors ?? sessionCursors;
      values.sessions = result.sessions;
      liveSession = result.sessions.length > 0;
      report('sessions', 'ok', now);
    } });
  register({ names: ['usage'], interval: () => 2 * MINUTE,
    work(now) {
      if (!usageWorker) {
        const worker = new Worker(new URL(import.meta.url), { workerData: 'usage', execArgv: [],
          env: { ...process.env, LUNA_RUN_DIR: config.runDir } });
        worker.on('error', () => {}); // An idle worker can also exit.
        worker.once('exit', () => { usageWorker = undefined; });
        usageWorker = worker;
      }
      const worker = usageWorker;
      return new Promise((resolve, reject) => {
        const receive = ({ value, error }) => {
          worker.off('exit', exit);
          if (error) reject(new Error(error));
          else resolve(value);
        };
        const exit = (code) => {
          worker.off('message', receive);
          reject(new Error(`usage worker exited with code ${code}`));
        };
        worker.once('message', receive);
        worker.once('exit', exit);
        worker.postMessage({ now });
      });
    },
    merge: (result, now) => { values.usage = result; report('usage', 'ok', now); } });
  const conveyor = process.env.CONVEYOR_HOME || path.join(config.claudeHome, 'conveyor');
  register({ names: ['cli'], interval: () => MINUTE,
    work: () => readProbeJson(path.join(config.claudeHome, 'conveyor', 'cli-cache.json')),
    merge(result, now) {
      const at = Date.parse(result?.checkedAt);
      if (!object(result?.codex) || !object(result?.agy) || !Number.isFinite(at)) {
        report('cli', meta('cli').okAt ? 'stale' : 'unavailable', now, 'CLI cache missing or invalid');
        return;
      }
      values.cli = result;
      report('cli', 'ok', at);
    } });
  register({ names: ['catalog'], interval: () => MINUTE,
    work: () => readProbeJson(path.join(conveyor, 'orchestration.json')),
    merge(result, now) {
      const at = Date.parse(result?.catalogUpdatedAt);
      if (Number.isFinite(at)) report('catalog', 'ok', at);
      else report('catalog', 'unavailable', now, 'orchestration.json has no catalog timestamp');
    } });

  function publish(now) {
    const sections = Object.fromEntries(Object.entries(metadata).map(([name, state]) => [
      name, quiet && !QUIET_SECTIONS.has(name) ? { ...state, status: 'idle', reason: null } : sectionView(state, now)
    ]));
    const serialized = JSON.stringify(sections);
    if (!dirty && lastSections === serialized) return;
    const snapshot = { ...values, at: iso(now), version: 2,
      collector: { pid: owner.pid, instance: owner.instance, seq: seq + 1, publishedAt: iso(now) },
      sections, claudeLimits: [...limits.values()] };
    writeAtomic(config.snapshot, snapshotText(snapshot, defaults));
    lastSections = serialized;
    seq++;
    dirty = false;
  }

  function tick() {
    const now = Date.now();
    for (const [sessionId, lease] of beats) if (now - lease.at >= LEASE_MS) beats.delete(sessionId);
    for (const [kind, limit] of limits) {
      const expires = limit.resetsAt ? Date.parse(limit.resetsAt) : Date.parse(limit.observedAt) + LEASE_MS;
      if (expires <= now) { limits.delete(kind); dirty = true; }
    }
    if (!widgetRead && now >= nextWidgetAt) {
      nextWidgetAt = now + (quiet ? QUIET_MS : 5 * SECOND);
      widgetRead = readProbeJson(config.widget).then((lease) => { widgetAt = Date.parse(lease?.at); })
        .catch(log).finally(() => { pending.delete(widgetRead); widgetRead = undefined; });
      pending.add(widgetRead);
    }
    const widget = now >= widgetAt && now - widgetAt < LEASE_MS;
    const nextQuiet = !widget && !beats.size && !liveSession;
    const nextFast = widget || [...beats.values()].some((lease) => lease.visible) ? 5 * SECOND : MINUTE;
    const waking = quiet && !nextQuiet;
    if (quiet !== nextQuiet || fastMs !== nextFast) {
      quiet = nextQuiet;
      fastMs = nextFast;
      dirty = true;
      for (const job of jobs) {
        if (job !== codexAccountsJob) job.dueAt = waking ? now : job.last + job.interval();
      }
    }
    for (const job of jobs) {
      if (quiet && !job.names.every((name) => QUIET_SECTIONS.has(name))) continue;
      for (const name of job.names) {
        meta(name).staleAfterMs = name === 'cli' ? 6 * HOUR : name === 'catalog' ? HOUR : job.interval() + job.deadline;
      }
      if (now < job.dueAt) continue;
      if (job.busy) {
        job.dueAt = now + job.interval();
        for (const name of job.names) report(name, 'stale', now, 'previous read still running');
      } else attempt(job, now);
    }
    publish(now);
  }

  const poll = () => {
    try {
      const current = readJson(config.lock);
      if (current?.instance !== owner.instance) {
        // A vanished lock (deleted by a cleaner or by hand) is ours to recreate; only another owner's lock ends us.
        if (!current && reclaim(config, owner)) log('lock file was missing; recreated it');
        else { result.code = 3; stop(`lock now names ${current?.instance ?? 'nothing'}`); return; }
      }
      tick();
    } catch (error) { log(error); }
    if (!stopping) timer = setTimeout(poll, SECOND);
  };
  const signals = ['SIGINT', 'SIGTERM', ...(platform === 'win32' ? ['SIGHUP'] : [])];
  const onSignal = (signal) => stop(`signal ${signal}`);
  for (const signal of signals) process.on(signal, onSignal);
  try {
    await listen(server);
    server.on('error', (error) => { log(error); stop('server error'); });
    if (stopping) return;
    const info = { version: 1, pid: owner.pid, instance: owner.instance, port: server.address().port, token,
      startedAt: owner.startedAt };
    writeAtomic(config.discovery, JSON.stringify(info) + '\n');
    poll();
    await stopped;
  } finally {
    stop();
    clearTimeout(timer);
    const grace = new AbortController();
    try {
      await usageWorker?.terminate();
      await Promise.race([Promise.allSettled(pending), sleep(SHUTDOWN_GRACE_MS, undefined, { signal: grace.signal })]);
      dirty = true;
      if (readJson(config.lock)?.instance === owner.instance) publish(Date.now());
    } catch (error) { log(error); }
    finally {
      grace.abort();
      server.close();
      server.closeAllConnections();
      for (const signal of signals) process.removeListener(signal, onSignal);
    }
  }
}

function newOwner(config) {
  return { pid: process.pid, instance: randomUUID(), startedAt: iso(), discovery: config.discovery,
    procStart: readProcessStat(process.pid)?.started };
}

function supervisorStopped(config, epoch) {
  if (platform !== 'win32') return false;
  if (existsSync(config.stopped)) return true;
  if (epoch === undefined) return false;
  let current = '-';
  try { current = readFileSync(config.supervisorEpoch, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return current !== epoch;
}

async function runCollector(config, epoch) {
  if (supervisorStopped(config, epoch)) return 0;
  mkdirSync(path.dirname(config.lock), { recursive: true, mode: 0o700 });
  const owner = newOwner(config);
  const code = await acquireLock(config, owner);
  if (code) return code;
  try {
    if (supervisorStopped(config, epoch)) return 0;
    mkdirSync(path.dirname(config.widget), { recursive: true, mode: 0o700 });
    const result = {};
    await serve(config, owner, result);
    // Exit 3 (another collector owns the lock) is the one exit the supervisors do not restart.
    return result.code ?? 0;
  } finally { releaseLock(config, owner); }
}

function systemctl(action) {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', action, 'luna-collector.service'], { timeout: 30 * SECOND },
      (error) => error ? reject(error) : resolve());
  });
}

async function start(config) {
  remove(config.stopped);
  if (platform === 'win32') {
    const script = path.join(HERE, 'luna-collector-supervisor.vbs');
    const child = spawn('wscript.exe', ['//B', '//NoLogo', script], { detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    process.stdout.write('Started the Luna collector supervisor.\n');
  } else if (platform === 'linux') {
    await systemctl('start');
    process.stdout.write('Asked systemd to start luna-collector.service.\n');
  } else throw new Error('collector supervision is unavailable on this platform');
}

async function main(command) {
  const config = configuration();
  const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  switch (command) {
    case 'ensure':
      process.stderr.write('Use luna-collector.mjs start to start the collector.\n');
      return 2;
    case 'start':
      await start(config);
      break;
    case 'run':
      return runCollector(config, process.argv[3]);
    case 'status': {
      const data = readJson(config.snapshot, MAX_SNAPSHOT);
      const snapshot = data && { version: data.version, at: data.at, collector: data.collector, sections: data.sections,
        ...(data.truncated ? { truncated: true } : {}) };
      // The discovery token authenticates /beat and /stop: never print it.
      const owner = readJson(config.lock);
      const { token, ...discovery } = readJson(owner?.discovery ?? config.discovery) ?? {};
      print({ discovery: Object.keys(discovery).length ? { ...discovery, token: token ? 'hidden' : null } : null,
        snapshot, running: Boolean(await healthy(config, owner)) });
      break;
    }
    case 'stop': {
      if (platform === 'win32') {
        mkdirSync(path.dirname(config.stopped), { recursive: true, mode: 0o700 });
        writeAtomic(config.stopped, '');
        writeAtomic(config.supervisorEpoch, randomUUID());
      }
      if (platform === 'linux' && existsSync(path.join(path.dirname(config.claudeHome), '.config', 'systemd', 'user',
        'luna-collector.service'))) await systemctl('stop');
      const owner = readJson(config.lock);
      const info = await healthy(config, owner);
      if (info) {
        if (!(await request(info, '/stop', 'POST')).ok) throw new Error('collector refused stop');
        const deadline = performance.now() + 4 * SECOND;
        while (ownerPidAlive(owner) && performance.now() < deadline) await sleep(50);
        if (ownerPidAlive(owner)) throw new Error('collector stop timed out');
      } else if (ownerPidAlive(owner)) throw new Error('collector is not answering health');
      else if (existsSync(config.lock)) {
        // Reclaim the dead owner's lock using the same arbitration as a foreground launch.
        const cleanup = newOwner(config);
        if (await acquireLock(config, cleanup)) throw new Error('collector lock changed during stop');
        releaseLock(config, cleanup);
      }
      break;
    }
    default:
      throw new Error('usage: luna-collector.mjs start | run | status | stop');
  }
}

if (!isMainThread && workerData === 'usage') {
  parentPort.on('message', async (options) => {
    try { parentPort.postMessage({ value: await runUsage(options) }); }
    catch (error) { parentPort.postMessage({ error: message(error) }); }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    const action = process.argv[2];
    const code = await main(action);
    if (action === 'run') process.exit(code ?? 0);
    process.exitCode = code ?? 0;
  } catch (error) {
    process.stderr.write(`luna-collector: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
