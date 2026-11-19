#!/usr/bin/env node
import childProcess, { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { home, platform, processAlive, readProcessStat } from './conveyor/lib/platform.mjs';
import { availableMemory } from './lib/luna-runtime.mjs';
import { run, sweepOrphans } from './lib/supervised-run.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LEASE_MS = 90 * SECOND;
const DEADLINE = 120 * SECOND;
const SHUTDOWN_GRACE_MS = 4750;
const MAX_SNAPSHOT = 3 * 1024 * 1024;
const MAX_BEAT = 16 * 1024;
const FAST_SECTIONS = ['daemon', 'jobs', 'codexLimits', 'orchestration'];
const iso = (time = Date.now()) => new Date(time).toISOString();
const message = (error) => String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function configuration() {
  const claudeHome = path.resolve(home(), '.claude');
  const runDir = path.resolve(process.env.LUNA_RUN_DIR || path.join(claudeHome, 'luna-run'));
  const directory = path.join(runDir, 'collector');
  return { claudeHome, runDir, directory, lock: path.join(directory, 'collector.lock'),
    starting: path.join(directory, 'starting'),
    discovery: path.join(directory, 'discovery.json'), snapshot: path.join(directory, 'snapshot.json'),
    schedule: path.join(directory, 'schedule.json'), widget: path.join(directory, 'leases', 'widget.json') };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
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

async function processStart(pid) {
  if (platform === 'linux') return readProcessStat(pid)?.started ?? null;
  if (platform !== 'win32') return null;
  const identity = path.join(HERE, 'lib', 'process-identity.mjs');
  if (existsSync(identity)) {
    const { processStartAsync } = await import(pathToFileURL(identity).href);
    if (processStartAsync) return await processStartAsync(pid) || null;
  }
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
    { windowsHide: true, timeout: 2500 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

async function ownerAlive(owner) {
  if (!processAlive(owner?.pid)) return false;
  if (!owner.procStart) return true;
  const actual = await processStart(owner.pid);
  return actual ? String(owner.procStart) === actual : processAlive(owner.pid);
}

async function acquireLock(file, owner) {
  // Publish a complete startup claim with a hard link. Only its owner may create or replace collector.lock.
  // If a claimant dies, the next claim is keyed to that dead instance and has its own exclusive link.
  const root = `${file}.startup`, candidate = `${root}.${owner.instance}.tmp`;
  const chain = [];
  writeFileSync(candidate, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  let held = false;
  try {
    let claim = root;
    for (;;) {
      try {
        linkSync(candidate, claim);
        held = true;
        chain.push([claim, owner.instance]);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const previous = readJson(claim);
      if (!/^[a-f0-9-]{36}$/i.test(previous?.instance) || await ownerAlive(previous)) return false;
      chain.push([claim, previous.instance]);
      claim = `${root}.${previous.instance}`;
    }
    if (!chain.every(([name, instance]) => readJson(name)?.instance === instance)) return false;
    if (await ownerAlive(readJson(file))) return false;
    remove(file);
    try {
      writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') remove(file);
      throw error;
    }
    return true;
  } finally {
    if (held && chain.every(([name, instance]) => readJson(name)?.instance === instance)) {
      for (const [name] of chain) remove(name);
    } else if (held) {
      const [name] = chain.at(-1);
      if (readJson(name)?.instance === owner.instance) remove(name);
    }
    remove(candidate);
  }
}

async function request(info, route, method = 'GET') {
  return fetch(`http://127.0.0.1:${info.port}${route}`, {
    method, headers: { 'x-luna-token': info.token }, signal: AbortSignal.timeout(200), redirect: 'error'
  });
}

async function healthy(config) {
  const info = readJson(config.discovery);
  const owner = readJson(config.lock);
  if (info?.version !== 1 || info.pid !== owner?.pid || info.instance !== owner?.instance ||
      typeof info.instance !== 'string' || !processAlive(info.pid) ||
      !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{32}$/.test(info.token)) return null;
  try {
    const response = await request(info, '/health');
    const health = response.ok ? await response.json() : null;
    return health?.ok === true && health.instance === info.instance &&
      readJson(config.lock)?.instance === info.instance ? info : null;
  } catch { return null; }
}

async function claimStartup(file) {
  const owner = { pid: process.pid, instance: randomUUID() };
  const claim = () => {
    try {
      writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      return owner.instance;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  const claimed = claim();
  if (claimed) return claimed;
  const stale = () => {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat && Date.now() - stat.mtimeMs >= 10 * SECOND;
  };
  // Serialize stale-claim removal so one contender cannot remove another's new claim.
  const recovery = `${file}.recovery`;
  if (!stale() || !await acquireLock(recovery, owner)) return;
  try {
    if (stale()) remove(file);
    return claim();
  } finally {
    remove(recovery);
  }
}

async function ensure(config) {
  const until = performance.now() + 5 * SECOND;
  let info = await healthy(config);
  if (info) return info;
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const claim = await claimStartup(config.starting);
  const release = () => {
    if (claim && readJson(config.starting)?.instance === claim) remove(config.starting);
  };
  let launchError;
  if (claim) {
    info = await healthy(config);
    if (info) { release(); return info; }
    if (!await ownerAlive(readJson(config.lock))) {
      const launching = spawn(process.execPath, [SELF, 'run'], { cwd: config.directory,
        detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LUNA_RUN_DIR: config.runDir } });
      launching.once('error', (error) => { launchError = error; });
      launching.unref();
    }
  }
  do {
    await sleep(Math.min(80, Math.max(0, until - 200 - performance.now())));
    info = await healthy(config);
    if (info) { release(); return info; }
    if (launchError) { release(); throw launchError; }
  } while (performance.now() < until - 200);
  throw new Error('collector discovery and health timed out');
}

const helper = (name) => path.join(HERE, name);
const overview = helper('luna-overview.mjs');
const helpers = new Set([overview, helper('luna-reap-brokers.mjs'), helper('conveyor/gemini-quota.mjs'),
  helper('conveyor/exec.mjs'), helper('conveyor/cli-update.mjs'), helper('conveyor/usage.mjs')]);

// The legacy CLI owns three detached schedules. In its private fallback process, suppress those
// launches so only the collector's supervised schedules run. The standalone CLI is unaffected.
export function suppressLegacyOverviewLaunches() {
  const originalSpawn = childProcess.spawn, originalExecFile = childProcess.execFile;
  const originalExit = process.exit.bind(process);
  const probes = new Set();
  let exitPending = false, exitCode;
  const track = (child) => {
    probes.add(child);
    child.once('close', () => {
      probes.delete(child);
      if (exitPending && !probes.size) originalExit(exitCode);
    });
    return child;
  };
  const auxiliary = new Set([helper('luna-reap-brokers.mjs'),
    process.env.LUNA_USAGE_COLLECTOR || helper('conveyor/usage.mjs'),
    process.env.LUNA_GEMINI_QUOTA_CMD || helper('conveyor/gemini-quota.mjs')]);
  childProcess.spawn = function (command, args, options) {
    if (command === process.execPath && options?.detached && auxiliary.has(args?.[0])) {
      throw new Error('scheduled by luna-collector');
    }
    return track(originalSpawn.apply(this, arguments));
  };
  childProcess.execFile = function (...args) {
    return track(originalExecFile.apply(this, args));
  };
  // Keep the root available to taskkill if the legacy formatter finishes while a probe is still alive.
  process.exit = (code) => {
    if (!probes.size) originalExit(code);
    exitPending = true;
    exitCode = code;
  };
  syncBuiltinESMExports();
}

function markerFor(directory) {
  const id = createHash('sha256').update(directory).digest('hex');
  const source = `/* luna-collector:${id} */ if (process.argv[1] === ${JSON.stringify(overview)}) ` +
    `(await import(${JSON.stringify(import.meta.url)})).suppressLegacyOverviewLaunches();`;
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

async function hasOverviewExport() {
  // Importing the legacy CLI evaluates its main routine, which calls process.exit().
  const source = await readFile(overview, 'utf8');
  const declaration = /\bexport\s+(?:(?:async\s+)?function\s+collect\b|(?:const|let|var)\s+collect\b)/;
  const named = /\bexport\s*\{[^}]*\bcollect\b[^}]*\}/;
  return declaration.test(source) || named.test(source);
}

async function runWorkerJob({ task, options, env }) {
  if (task === 'overview') {
    const { collect } = await import('./luna-overview.mjs');
    return typeof collect === 'function' ? { snapshot: await collect(options) } : null;
  }
  if (task === 'sessions') {
    const { readSessions } = await import('./conveyor/lib/sessions.mjs');
    // readSessions returns { sessions, cursors }; the cursors come back to the collector for the next pass.
    return typeof readSessions === 'function' ? await readSessions(options) : null;
  }
  const { now, lockNonce } = options;
  const { collectUsage, readUsageSummary } = await import('./conveyor/usage.mjs');
  if ((await collectUsage({ now, env, lockNonce })).locked) throw new Error('usage collection already running');
  return { ...await readUsageSummary({ now, env }), stale: false };
}

function collectInWorker(workers, task, options, env, deadline) {
  if (!workers.has(task)) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { task }, env, execArgv: [] });
    workers.set(task, worker);
    worker.on('error', () => {}); // The active request handles errors; an idle worker can also exit.
    worker.once('exit', () => { if (workers.get(task) === worker) workers.delete(task); });
  }
  const worker = workers.get(task);
  return new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      worker.off('message', receive);
      worker.off('exit', exit);
    };
    const receive = ({ value, error }) => {
      clear();
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const exit = (code) => {
      clear();
      reject(new Error(`${task} worker exited with code ${code}`));
    };
    const timer = setTimeout(() => { void worker.terminate(); }, deadline);
    worker.once('message', receive);
    worker.once('exit', exit);
    worker.postMessage(options);
  });
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
      res.once('finish', stop);
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

async function serve(config, owner) {
  const env = { ...process.env, LUNA_RUN_DIR: config.runDir };
  // The old Windows overview uses LUNA_OVERVIEW_HOME for its run root.
  const overviewEnv = { ...env, LUNA_OVERVIEW_HOME: env.LUNA_OVERVIEW_HOME || config.runDir };
  const marker = markerFor(config.directory);
  const token = randomBytes(16).toString('hex');
  const defaults = {
    v: 1, ram: { freeMb: null, totalMb: null }, daemon: { running: false, appServer: null, healthy: false },
    jobs: [], codexLimits: null, build: null, sessions: [], orchestration: null, switches: [], gemini: null, usage: null
  };
  if (platform === 'win32') defaults.daemons = {};
  const values = { ...defaults, cli: null };
  const beats = new Map(), limits = new Map(), jobs = [], pending = new Set();
  const workers = new Map();
  const shutdown = new AbortController();
  const metadata = Object.fromEntries(
    [...FAST_SECTIONS, 'ram', 'sessions', 'usage', 'cli', 'catalog', 'gemini'].map((name) => [name, section(0)]));
  metadata.gemini.reason = 'Gemini is not used';
  let seq = 0, dirty = true, stopping = false;
  let overviewExport;
  let idleSince = Date.now(), liveSession = false, nextSessionCheck = 0, fastMs = MINUTE;
  let schedule = readJson(config.schedule) || {};
  let lastSections, timer;
  let wakeStop;
  const stopped = new Promise((resolve) => { wakeStop = resolve; });
  const stop = () => { stopping = true; shutdown.abort(); wakeStop(); };
  const log = (error) => process.stderr.write(`luna-collector: ${message(error)}\n`);
  const meta = (name) => metadata[name];

  const server = assembleServer(token, () => ({ ok: true, instance: owner.instance, seq }), (body) => {
    if (stopping || typeof body?.sessionId !== 'string' || !body.sessionId ||
        typeof body.visible !== 'boolean' || !Array.isArray(body.limits)) throw new Error('invalid beat');
    const now = Date.now();
    beats.set(body.sessionId, { at: now, visible: body.visible });
    idleSince = null;
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

  function register({ names = [], interval, deadline = DEADLINE, work, merge, hourly }) {
    const saved = hourly && schedule[hourly];
    const job = { names, interval, deadline, work, merge, hourly, last: 0, busy: false, failures: 0, dueAt: 0 };
    if (Number.isFinite(saved?.dueAt)) {
      job.dueAt = saved.dueAt;
      job.failures = Number.isSafeInteger(saved.failures) ? saved.failures : 0;
      if (saved.section) Object.assign(metadata[hourly], saved.section);
      if (hourly === 'cli') values.cli = saved.value ?? null;
    }
    jobs.push(job);
  }

  function attempt(job, now) {
    const { names, deadline, work, merge, hourly } = job;
    job.busy = true;
    job.last = now;
    for (const name of names) meta(name).attemptAt = iso(now);
    dirty = true;
    const fail = (error) => {
      for (const name of names) report(name, meta(name).okAt ? 'stale' : 'error', Date.now(), message(error));
      if (!names.length) log(error);
      job.failures++;
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      fail(new Error(`deadline exceeded after ${deadline} ms`));
    }, deadline);
    const done = Promise.resolve().then(() => work(now)).then((result) => {
      if (timedOut) return;
      merge?.(result, Date.now());
      job.failures = 0;
    }).catch((error) => {
      if (!timedOut) fail(error);
    }).finally(() => {
      // Keep the job's slot until its worker or supervised process has finished.
      clearTimeout(timeout);
      job.busy = false;
      if (!job.failures) job.dueAt = job.last + job.interval();
      else {
        const retry = Math.min(job.interval(), SECOND * 2 ** Math.min(job.failures, 16));
        job.dueAt = Date.now() + retry;
      }
      if (hourly) {
        schedule = { ...schedule, [hourly]: { dueAt: job.dueAt, failures: job.failures, section: { ...metadata[hourly] },
          ...(hourly === 'cli' ? { value: values.cli } : {}) } };
        try { writeAtomic(config.schedule, JSON.stringify(schedule) + '\n'); }
        catch (error) { log(error); }
      }
      pending.delete(done);
    });
    pending.add(done);
  }

  async function runHelper(file, args, { deadlineMs = DEADLINE, childEnv = env, maxOutput } = {}) {
    const result = await run([process.execPath, marker, file, ...args], {
      cwd: config.directory, env: childEnv, deadlineMs, maxOutput, signal: shutdown.signal
    });
    if (result.timedOut) throw new Error(`${path.basename(file)} timed out`);
    if (result.code !== 0) throw new Error(`${path.basename(file)} exited ${result.code}: ${message(result.stderr)}`);
    return result.stdout;
  }

  const fast = () => fastMs;
  const probeDeadline = 4 * SECOND;
  const probeOptions = (now) => ({ now, platform, claudeHome: config.claudeHome });
  register({ names: ['ram'], interval: fast, deadline: SECOND,
    work: () => ({ freeMb: Math.round((platform === 'linux' ? availableMemory() : freemem()) / 1048576),
      totalMb: Math.round(totalmem() / 1048576) }),
    merge: (result, now) => { values.ram = result; report('ram', 'ok', now); } });
  register({ names: FAST_SECTIONS, interval: fast, deadline: probeDeadline,
    async work(now) {
      overviewExport ??= await hasOverviewExport();
      if (overviewExport) {
        const result = await collectInWorker(workers, 'overview', { ...probeOptions(now), includeGemini: false }, env, probeDeadline);
        if (result) return result.snapshot;
        overviewExport = false;
      }
      // The legacy producer can include 100 session files of up to 64 KiB each.
      return JSON.parse(await runHelper(overview, ['--json'], {
        deadlineMs: probeDeadline, childEnv: overviewEnv, maxOutput: 8 * 1024 * 1024
      }));
    },
    merge(result, now) {
      if (!object(result)) throw new Error('overview returned no snapshot');
      // RAM has its own live sampler and never uses the overview's cached fallback.
      if (result.sections?.ram?.status !== 'stale' &&
          Number.isFinite(result.ram?.freeMb) && Number.isFinite(result.ram?.totalMb)) {
        values.ram = result.ram;
        report('ram', 'ok', now);
      }
      for (const name of FAST_SECTIONS) {
        const supplied = Object.hasOwn(result, name) && (name !== 'jobs' || Array.isArray(result.jobs));
        const stale = result.sections?.[name];
        if (stale?.status === 'stale') {
          if (supplied) values[name] = result[name];
          metadata[name].okAt ??= stale.okAt ?? null;
          report(name, 'stale', now, stale.reason);
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
        if (Object.hasOwn(result, name)) values[name] = result[name];
      }
    } });
  let sessionCursors = {};
  register({ names: ['sessions'], interval: fast, deadline: probeDeadline,
    async work(now) {
      if (!existsSync(helper('conveyor/lib/sessions.mjs'))) return null;
      return collectInWorker(workers, 'sessions', { ...probeOptions(now), runDir: config.runDir, cursors: sessionCursors },
        env, probeDeadline);
    },
    merge(result, now) {
      if (result === null) {
        values.sessions = [];
        report('sessions', 'unavailable', now, 'readSessions is unavailable');
        return;
      }
      if (!Array.isArray(result.sessions)) throw new Error('readSessions did not return a session list');
      if (result.cursors && typeof result.cursors === 'object') sessionCursors = result.cursors;
      values.sessions = result.sessions;
      report('sessions', 'ok', now);
    } });
  register({ names: ['usage'], interval: () => 2 * MINUTE, async work(now) {
    const lockNonce = randomUUID();
    try { return await collectInWorker(workers, 'usage', { now, lockNonce }, env, DEADLINE); }
    catch (error) {
      const { usagePaths } = await import('./conveyor/usage.mjs');
      if (usagePaths) {
        const { lock } = usagePaths(env);
        if (readJson(path.join(lock, 'owner.json'))?.nonce === lockNonce) rmSync(lock, { recursive: true, force: true });
      }
      throw error;
    }
  },
    merge: (result, now) => { values.usage = result; report('usage', 'ok', now); } });
  register({ interval: () => 10 * MINUTE, work: () => runHelper(helper('luna-reap-brokers.mjs'), []) });
  register({ names: ['cli'], hourly: 'cli', interval: () => HOUR,
    work: async () => JSON.parse(await runHelper(helper('conveyor/cli-update.mjs'), ['status', '--json'])),
    merge(result, now) {
      if (!object(result) || result.ok === false) throw new Error(result?.reason || 'CLI status returned no data');
      values.cli = result;
      report('cli', 'ok', now);
    } });
  register({ names: ['catalog'], hourly: 'catalog', interval: () => HOUR,
    work: async () => JSON.parse(await runHelper(helper('conveyor/exec.mjs'),
      ['catalog', 'refresh', '--provider', 'all', '--actor', 'panel'])),
    merge(result, now) {
      if (result?.ok !== true) throw new Error(result?.reason || 'catalog refresh failed');
      report('catalog', 'ok', now, result.note ? message(result.note) : null);
    } });
  register({ interval: () => 10 * MINUTE, deadline: 4 * SECOND, work: () => sweepOrphans(helpers, marker) });

  function publish(now) {
    const sections = Object.fromEntries(Object.entries(metadata).map(([name, state]) => [name, sectionView(state, now)]));
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

  const idleMs = Number(process.env.LUNA_COLLECTOR_IDLE_MS);
  const idlePeriod = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : MINUTE;
  const pollMs = Math.min(SECOND, Math.max(25, Math.floor(idlePeriod / 4)));

  async function tick() {
    const now = Date.now();
    for (const [sessionId, lease] of beats) if (now - lease.at >= LEASE_MS) beats.delete(sessionId);
    for (const [kind, limit] of limits) {
      const expires = limit.resetsAt ? Date.parse(limit.resetsAt) : Date.parse(limit.observedAt) + LEASE_MS;
      if (expires <= now) { limits.delete(kind); dirty = true; }
    }
    const widgetAge = now - Date.parse(readJson(config.widget)?.at);
    const widget = widgetAge >= 0 && widgetAge < LEASE_MS;
    const nextFast = widget || [...beats.values()].some((lease) => lease.visible) ? 5 * SECOND : MINUTE;
    if (nextFast !== fastMs) {
      fastMs = nextFast;
      for (const job of jobs) {
        if (job.interval === fast && !job.failures) job.dueAt = job.last + fastMs;
      }
    }
    if (widget || beats.size) {
      idleSince = null;
      nextSessionCheck = 0;
    } else {
      if (now >= nextSessionCheck || idleSince !== null && now - idleSince >= idlePeriod) {
        try {
          const { hasLiveSession } = await import('./conveyor/lib/sessions.mjs');
          liveSession = await hasLiveSession(config.claudeHome, now);
        }
        catch (error) { log(error); liveSession = true; }
        nextSessionCheck = now + Math.min(5 * SECOND, idlePeriod / 4);
      }
      if (stopping) return;
      if (liveSession || beats.size) idleSince = null;
      else idleSince ??= now;
      if (idleSince !== null && now - idleSince >= idlePeriod) {
        stop();
        return;
      }
    }
    for (const job of jobs) {
      for (const name of job.names) meta(name).staleAfterMs = job.interval() + job.deadline;
      if (!job.busy && now >= job.dueAt) attempt(job, now);
    }
    publish(now);
  }

  const poll = async () => {
    try { await tick(); } catch (error) { log(error); }
    if (!stopping) timer = setTimeout(poll, pollMs);
  };
  const serverError = (error) => { log(error); stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let forcedExit = false;
  try {
    await listen(server);
    server.on('error', serverError);
    if (stopping) return;
    const info = { version: 1, pid: owner.pid, instance: owner.instance, port: server.address().port, token,
      startedAt: owner.startedAt };
    writeAtomic(config.discovery, JSON.stringify(info) + '\n');
    void poll();
    await stopped;
  } finally {
    stop();
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    const terminateWorkers = () => Promise.allSettled([...workers.values()].map((worker) => worker.terminate()));
    const grace = new AbortController();
    await Promise.race([
      Promise.allSettled(pending).then(terminateWorkers),
      sleep(SHUTDOWN_GRACE_MS, undefined, { signal: grace.signal }).then(() => {
        forcedExit = true;
        void terminateWorkers();
      })
    ]);
    grace.abort();
    if (!forcedExit && (seq || dirty && Object.values(metadata).some((state) => state.attemptAt))) {
      try { publish(Date.now()); } catch (error) { log(error); }
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return forcedExit;
}

async function runCollector(config) {
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, instance: randomUUID(), startedAt: iso(), procStart: await processStart(process.pid) };
  if (!owner.procStart && (platform === 'linux' || platform === 'win32')) throw new Error('cannot read collector process start time');
  if (!await acquireLock(config.lock, owner)) return;
  let forcedExit;
  try {
    remove(config.discovery);
    mkdirSync(path.dirname(config.widget), { recursive: true, mode: 0o700 });
    forcedExit = await serve(config, owner);
  } finally {
    if (readJson(config.lock)?.instance === owner.instance) {
      try { remove(config.discovery); } finally { remove(config.lock); }
    }
  }
  if (forcedExit) process.exit(0);
}

async function main(command) {
  const config = configuration();
  const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  switch (command) {
    case 'ensure':
      print(await ensure(config));
      break;
    case 'run':
      await runCollector(config);
      break;
    case 'status': {
      const data = readJson(config.snapshot);
      const snapshot = data && { version: data.version, at: data.at, collector: data.collector, sections: data.sections,
        ...(data.truncated ? { truncated: true } : {}) };
      print({ discovery: readJson(config.discovery), snapshot });
      break;
    }
    case 'stop': {
      const info = await healthy(config);
      if (info) {
        if (!(await request(info, '/stop', 'POST')).ok) throw new Error('collector refused stop');
      } else if (await ownerAlive(readJson(config.lock))) throw new Error('collector is not answering health');
      break;
    }
    default:
      throw new Error('usage: luna-collector.mjs ensure | run | status | stop');
  }
}

if (!isMainThread && workerData?.task) {
  parentPort.on('message', async (options) => {
    try { parentPort.postMessage({ value: await runWorkerJob({ ...workerData, options, env: process.env }) }); }
    catch (error) { parentPort.postMessage({ error: message(error) }); }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { await main(process.argv[2]); }
  catch (error) {
    process.stderr.write(`luna-collector: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
