#!/usr/bin/env node
// One local app-server for all luna.sh callers; no npm dependencies.
// LUNA_DAEMON_MAX: concurrent turns (default 12); queued jobs favor owners with fewer running turns.
// LUNA_DAEMON_OWNER_MAX: concurrent turns per owner (default 0, unlimited); FIFO among eligible jobs per owner.
// LUNA_DAEMON_IDLE_S: idle shutdown seconds (default 600; 0 disables).
// LUNA_DAEMON_ORPHAN_GRACE_S: keep orphaned jobs running (default 600 seconds; 0 cancels immediately).
// LUNA_DAEMON_CLIENT_CHECK_MS: client liveness check interval (default 15000 ms, minimum 50).
// LUNA_DAEMON_TEST_HOOKS=1: tests only, enable the authenticated event-loop block route.
// LUNA_DAEMON_HOME: state directory override for tests (default ~/.claude/luna-run).
// LUNA_DAEMON_LIMITS_POLL_S: account rate-limit poll interval (default 300 seconds, minimum 1).
// LUNA_DAEMON_INIT_TIMEOUT_MS: app-server initialization timeout (default 60000 ms, minimum 1).
// LUNA_DAEMON_APP_SERVER_CMD: tests only, JSON argv array replacing codex app-server.
// LUNA_DAEMON_START_MB: client admission surcharge when starting this daemon (default 150 MB).
// LUNA_DAEMON=0: client forces codex exec; otherwise node and curl enable this daemon.
// LUNA_LOW_PRIORITY=1: lower only the app-server tree's CPU priority (default: inherited).
// LUNA_JOB_TEMP=0: keep inherited TEMP instead of the daemon's small dedicated directory.
// LUNA_CODEX_BIN / LUNA_DIRECT_EXE=0: override native resolution / use the shim.
// LUNA_CODEX_SHELL_PATH: existing busybox sh.exe enables the custom build's shell configuration.
// LUNA_WINDOWS_SANDBOX: defaults to unelevated; empty preserves Codex configuration.
// LUNA_POOL_ALLOW_MCP=1: preserve configured MCP servers, as in luna-pool.mjs.
// LUNA_FULL and LUNA_MCP are ignored here, as in the pool; plugins/apps stay disabled.
// LUNA_KEEP_SESSION=1: preserve history; finished threads are still unsubscribed.
// CODEX_HOME selects config.toml; HOME selects the user's home directory.
// Per-job idleMaxS/timeoutS and turn RAM admission are enforced here, even after clients disappear.
// Thread lifecycle: thread/start -> turn/start -> turn/completed -> thread/unsubscribe.
// thread_unload_delay_secs=0 releases unsubscribed threads without the default grace period.
// Edge cases: (1) daemon.lock serializes launch; (2) dead discovery is atomically replaced.
// (3) idle-exit/submit races are retried once by the client; marker id recovers lost responses.
// (4) crash fails accepted jobs; client replays read-only once via exec, never write jobs.
// (5) max=12 and 15 submissions leaves three queued turns, scheduled fairly across owners.
// (6) client watchdog cancels, then reports stalled/124; slot releases after interrupt/unsubscribe.
// (7) client SIGINT cancels its turn only; (8) non-local/wrong token => 401; unsafe sandbox => 400.
// (9) native exe resolves on every new app-server spawn; (10) model/effort/tier/sandbox belong to each job.
// Jobs may include ephemeral (boolean) so each caller's LUNA_KEEP_SESSION setting is preserved.
// Terminal metadata expires after 600 s; no prompt, final answer, or child process is retained.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { appendFile, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import * as os from 'node:os';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(process.env.HOME || homedir());
const RUN = path.resolve(process.env.LUNA_DAEMON_HOME || path.join(HOME, '.claude', 'luna-run'));
const INFO = path.join(RUN, 'daemon.json');
const LIMITS = path.join(RUN, 'codex-limits.json');
const LOG = path.join(RUN, 'daemon.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanValue = (value) => String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const nowIso = () => new Date().toISOString();
const terminal = (job) => ['completed', 'failed', 'cancelled', 'stalled'].includes(job.state);
const pathKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const outputPaths = (job) => [job.out, job.log, `${job.out}.daemon`, `${job.out}.tmp`, `${job.out}.daemon.tmp`]
  .map(pathKey);
const queuedPromptBytes = (queue) => queue.reduce((bytes, job) => bytes + Buffer.byteLength(job.prompt), 0);

function canonicalOutKey(out) {
  try {
    return pathKey(path.join(realpathSync(path.dirname(path.resolve(out))), path.basename(out)));
  } catch { return pathKey(path.resolve(out)); }
}

function jobIdentity(body) {
  return createHash('sha256').update(JSON.stringify([
    body.prompt, pathKey(realpathSync(body.cwd)), body.sandbox, body.model, body.effort, body.tier,
    pathKey(path.resolve(body.log))
  ])).digest('hex');
}

function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const done = (settled) => { clearTimeout(timer); resolve(settled); };
    const timer = setTimeout(() => done(false), ms);
    void Promise.resolve(promise).then(() => done(true), () => done(true));
  });
}

function normalizeOwner(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[^A-Za-z0-9._:-]/.test(value) ? value : 'default';
}

function ownerCounts(jobs) {
  const owners = new Map();
  for (const job of jobs) {
    if (!job.slot && job.state !== 'queued') continue;
    if (!owners.has(job.owner)) owners.set(job.owner, { running: 0, queued: 0 });
    const counts = owners.get(job.owner);
    if (job.slot) counts.running++;
    if (job.state === 'queued') counts.queued++;
  }
  return owners;
}

function fairQueue(queue, owners) {
  // Stable sort preserves submission order for equal counts, including FIFO within each owner.
  return [...queue].sort((a, b) => (owners.get(a.owner)?.running || 0) - (owners.get(b.owner)?.running || 0));
}

function jobView(job) {
  return job.publishing ? { state: job.shownState, rc: null, error: '' }
    : { state: job.state, rc: job.rc, error: job.error };
}

function pruneTerminalJobs(jobs, now = Date.now()) {
  const ended = [...jobs.values()].filter(terminal);
  let excess = ended.length - 500;
  for (const job of ended) {
    if (job.publishing === true) continue;
    if (job.expiry <= now || excess > 0) {
      jobs.delete(job.id);
      excess--;
    }
  }
}

function expiredLimit(job, now) {
  if (job.state !== 'running') return '';
  if (job.timeoutS && now - job.startedAt >= job.timeoutS * 1000) {
    return `exceeded total timeout ${job.timeoutS}s`;
  }
  if (job.idleMaxS && now - job.lastActivity >= job.idleMaxS * 1000) {
    return `no events for ${job.idleMaxS}s`;
  }
  return '';
}

function limitWindow(window) {
  if (!window || !Number.isInteger(window.usedPercent)) return null;
  const reset = Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null;
  return {
    usedPercent: window.usedPercent,
    windowMins: Number.isInteger(window.windowDurationMins) ? window.windowDurationMins : null,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null
  };
}

function limitsTurnDue(last, now = Date.now()) {
  return last === null || now - last >= 60_000;
}

function limitsSnapshot(data, reason, previous = null, mainLimitId = null, sparse = false) {
  const snapshot = data?.rateLimits;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('missing rateLimits snapshot');
  }
  const text = (value) => typeof value === 'string' ? value : null;
  const bucket = (value, old) => ({
    name: text(value.limitName) ?? old?.name ?? null,
    primary: limitWindow(value.primary) ?? old?.primary ?? null,
    secondary: limitWindow(value.secondary) ?? old?.secondary ?? null,
    reached: text(value.rateLimitReachedType) ?? old?.reached ?? null
  });
  let byLimitId = Object.fromEntries(Object.entries(data.rateLimitsByLimitId || {})
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([id, value]) => [id, bucket(value)]));
  if (sparse) {
    byLimitId = { ...previous?.byLimitId, ...byLimitId };
    if (typeof snapshot.limitId === 'string') {
      byLimitId = { ...byLimitId, [snapshot.limitId]: bucket(snapshot, previous?.byLimitId?.[snapshot.limitId]) };
    }
  }
  const main = sparse && previous && mainLimitId && snapshot.limitId && snapshot.limitId !== mainLimitId
    ? {} : snapshot;
  const old = sparse ? previous : null;
  return {
    v: 1, at: nowIso(), source: reason,
    planType: text(main.planType) ?? old?.planType ?? null,
    ordinaryUsageAllowed: typeof data.ordinaryUsageAllowed === 'boolean'
      ? data.ordinaryUsageAllowed : old?.ordinaryUsageAllowed ?? null,
    reached: text(main.rateLimitReachedType) ?? old?.reached ?? null,
    primary: limitWindow(main.primary) ?? old?.primary ?? null,
    secondary: limitWindow(main.secondary) ?? old?.secondary ?? null,
    byLimitId
  };
}

const writes = new Map();
const secrets = new Set();
let renameFault = null; // In-process self-test hook; never enabled by job input.
let testLog = null;

function atomicWrite(file, content, { beforeRename } = {}) {
  const pending = (writes.get(file) || Promise.resolve()).then(async () => {
    const temp = `${file}.tmp`;
    try {
      await writeFile(temp, content, 'utf8');
      const prepare = async (target) => {
        try { await beforeRename?.(target); }
        catch (error) { event(`before rename failed ${target}: ${error.message}`); }
      };
      await prepare(temp);
      let elapsed = 0;
      for (let delay = 10; ; delay *= 2) {
        try {
          renameFault?.(file);
          await rename(temp, file);
          return true;
        } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          if (elapsed + delay > 1500) {
            event(`atomic rename fallback ${file}: ${error.code}`);
            await writeFile(file, content, 'utf8');
            await prepare(file);
            return true;
          }
          await sleep(delay);
          elapsed += delay;
        }
      }
    } catch (error) {
      event(`write failed ${file}: ${error.message}`);
      return false;
    } finally {
      try { await unlink(temp); } catch {}
    }
  });
  writes.set(file, pending);
  void pending.then(() => { if (writes.get(file) === pending) writes.delete(file); });
  return pending;
}

function readLockOwner(directory) {
  try {
    return Object.fromEntries(readFileSync(path.join(directory, 'owner'), 'utf8').trim().split(/\r?\n/)
      .map((line) => line.split('=')));
  } catch { return null; }
}

function removeLockDirectory(directory) {
  for (const name of ['owner', 'owner.tmp']) {
    try { unlinkSync(path.join(directory, name)); } catch {}
  }
  try { rmdirSync(directory); } catch {}
}

function daemonLock(report = event, directory = path.join(RUN, 'daemon.lock')) {
  let token = null;

  function reclaim() {
    const owner = readLockOwner(directory);
    const judgedToken = owner?.token ?? '';
    const now = Date.now();
    let reason;
    let orphanMtime;
    if (owner) {
      const age = /^\d+$/.test(owner.since ?? '') ? now / 1000 - Number(owner.since) : 0;
      if (age > 600) {
        reason = 'owner age exceeds 600s';
      } else if (age > 5 && /^[1-9]\d*$/.test(owner.pid ?? '') && Number.isSafeInteger(Number(owner.pid))) {
        try { process.kill(Number(owner.pid), 0); } catch (error) {
          if (error.code === 'ESRCH') reason = `owner pid ${owner.pid} is dead`;
        }
      }
    } else {
      try {
        orphanMtime = statSync(directory).mtimeMs;
        if (now - orphanMtime > 10_000) reason = 'missing owner older than 10s';
      } catch {}
    }
    if (!reason) return false;

    const parent = path.dirname(directory);
    const prefixes = ['stale', 'rel'].map((kind) => `${path.basename(directory)}.${kind}.`);
    for (const name of readdirSync(parent)) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const leftover = path.join(parent, name);
      try {
        if (statSync(leftover).isDirectory() && now - statSync(leftover).mtimeMs > 600_000) {
          removeLockDirectory(leftover);
        }
      } catch {}
    }
    const stale = `${directory}.stale.${randomBytes(8).toString('hex')}`;
    try { renameSync(directory, stale); } catch { return false; }
    let changed = (readLockOwner(stale)?.token ?? '') !== judgedToken;
    if (orphanMtime !== undefined) {
      try { changed ||= statSync(stale).mtimeMs !== orphanMtime; } catch { changed = true; }
    }
    if (changed) {
      try {
        // Never replace a directory that a new caller has already acquired.
        if (existsSync(directory)) throw new Error('lock already exists');
        renameSync(stale, directory);
      } catch {
        report(`warning: fresh owner moved during reclaim; retained ${stale}`);
      }
      return false;
    }
    report(`reclaimed admission lock: ${reason}`);
    removeLockDirectory(stale);
    return true;
  }

  return {
    get held() { return token !== null; },
    details() {
      const owner = readLockOwner(directory);
      let since = owner && /^\d+$/.test(owner.since ?? '') ? Number(owner.since) : Date.now() / 1000;
      if (!owner) {
        try { since = statSync(directory).mtimeMs / 1000; } catch {}
      }
      return { lock_kind: owner?.kind || 'unknown', lock_age_s: Math.max(0, Math.floor(Date.now() / 1000 - since)) };
    },
    acquire() {
      if (token !== null) return false;
      mkdirSync(path.dirname(directory), { recursive: true });
      try { mkdirSync(directory); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        reclaim();
        return false;
      }
      token = randomBytes(8).toString('hex');
      try {
        const ownerPath = path.join(directory, 'owner');
        writeFileSync(`${ownerPath}.tmp`,
          `pid=${process.pid}\nkind=luna-daemon\nsince=${Math.floor(Date.now() / 1000)}\ntoken=${token}\n`);
        renameSync(`${ownerPath}.tmp`, ownerPath);
      } catch (error) {
        token = null;
        // No published owner: subsequent callers use the 10s orphan rule.
        throw error;
      }
      return true;
    },
    release() {
      if (token === null) return;
      const released = `${directory}.rel.${token}`;
      const myToken = token;
      token = null;
      try { renameSync(directory, released); } catch { return; }
      if (readLockOwner(released)?.token === myToken) {
        removeLockDirectory(released);
      } else {
        try {
          if (existsSync(directory)) throw new Error('lock already exists');
          renameSync(released, directory);
        } catch {
          report(`warning: foreign owner moved during release; retained ${released}`);
        }
      }
    }
  };
}

function loadConfigMcpNames(configPath) {
  if (!existsSync(configPath)) return [];
  const text = readFileSync(configPath, 'utf8');
  return [...text.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((match) => match[1]);
}

function buildLeanArgs(configPath) {
  const args = [];
  if (process.env.LUNA_POOL_ALLOW_MCP !== '1') {
    for (const name of loadConfigMcpNames(configPath)) {
      args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
  }
  args.push('--disable', 'plugins', '--disable', 'apps');
  // Codex CLI 0.162.x: elevated Windows sandbox setup fails while the desktop app holds
  // node_repl.exe open; LUNA_WINDOWS_SANDBOX="" keeps config.toml's value.
  const winSandbox = process.env.LUNA_WINDOWS_SANDBOX ?? 'unelevated';
  if (winSandbox) args.push('-c', `windows.sandbox="${winSandbox}"`);
  return args;
}

function spawnServer(home, leanArgs, environment = process.env) {
  if (process.platform === 'win32') {
    const override = process.env.LUNA_CODEX_BIN || '';
    let executable = override && existsSync(override)
      ? override
      : '';
    let env = environment;
    if (!executable && process.env.LUNA_DIRECT_EXE !== '0') {
      const candidates = [
        'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
        'vendor/x86_64-pc-windows-msvc/bin/codex.exe'
      ];
      for (const entry of (process.env.PATH || '').split(path.delimiter)) {
        if (!['codex', 'codex.cmd'].some((name) => {
          const shim = path.join(entry, name);
          return existsSync(shim) && statSync(shim).isFile();
        })) continue;
        const packageRoot = path.join(entry, 'node_modules', '@openai', 'codex');
        if (!existsSync(packageRoot)) continue;
        const nativeExe = candidates.map((candidate) => path.join(packageRoot, candidate))
          .find((candidate) => existsSync(candidate));
        if (!nativeExe) continue;
        executable = nativeExe;
        env = { ...environment };
        env.CODEX_MANAGED_PACKAGE_ROOT = packageRoot;
        env.CODEX_MANAGED_BY_NPM = '1';
        delete env.CODEX_MANAGED_BY_BUN;
        delete env.CODEX_MANAGED_BY_PNPM;
        delete env.CODEX_MANAGED_BY_VITE_PLUS;
        break;
      }
    }
    if (executable && !/\.(cmd|bat)$/i.test(executable)) {
      return spawn(executable, ['app-server', ...leanArgs], {
        cwd: home,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(env ? { env } : {})
      });
    }
    if (!override && process.env.LUNA_DIRECT_EXE !== '0' && !executable) {
      const warning = 'luna-daemon: native codex.exe not found under the npm package; ' +
        'using the codex shim (+~40 MB per job)\n';
      process.stderr.write(warning);
    }
    const command = [executable ? `"${executable}"` : 'codex', 'app-server', ...leanArgs].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, env
    });
  }
  return spawn('codex', ['app-server', ...leanArgs], {
    cwd: home,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'], env: environment
  });
}

function killTreeSync(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 10_000
    });
    terminateRoot(child);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }
}

// Under heavy load taskkill can exceed its timeout and kill nothing; a surviving app-server keeps the daemon (and
// its piped stdio) alive forever. ChildProcess.kill() targets the process handle, so it cannot hit a reused PID.
function terminateRoot(child) {
  if (typeof child.kill !== 'function' || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch {}
}

// Non-blocking tree kill: the daemon's event loop serves every session, and taskkill takes 0.25-4 s.
function killTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    try {
      if (process.platform !== 'win32') { killTreeSync(child); resolve(); return; }
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch {}
        terminateRoot(child);
        resolve();
      }, 10_000);
      timer.unref();
      const done = () => { clearTimeout(timer); terminateRoot(child); resolve(); };
      killer.once('exit', done);
      killer.once('error', done);
    } catch { resolve(); }
  });
}



function integer(name, fallback, minimum = 0) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

// turn/interrupt gets a short timeout: an unanswered interrupt must not hold a slot (and the owner's share)
// for a whole RPC timeout. Measured 2026-10-21: app-server sometimes never answers an interrupt.
function interruptTimeoutMs() {
  return Math.min(integer('LUNA_DAEMON_INTERRUPT_TIMEOUT_MS', 10_000, 1),
    integer('LUNA_DAEMON_RPC_TIMEOUT_MS', 60_000, 1));
}

const eventBuffer = [];
let eventBytes = 0;
let eventWriter = null;
let eventFile = null;
let eventSize = 0;
let eventLost = 0;

async function drainEvents() {
  while (eventBuffer.length) {
    const file = eventBuffer[0].file;
    const lines = [];
    let bytes = 0;
    let count = 0;
    while (eventBuffer[count]?.file === file) count++;
    for (const entry of eventBuffer.splice(0, count)) {
      lines.push(entry.drop
        ? `[${entry.drop.at}] event log: dropped ${entry.drop.count} lines\n` : entry.line);
      bytes += entry.bytes;
    }
    try {
      if (eventFile !== file) {
        eventFile = null;
        try { eventSize = (await stat(file)).size; }
        catch (error) { if (error.code !== 'ENOENT') throw error; eventSize = 0; }
        eventFile = file;
      }
      if (eventLost) lines.unshift(`[${nowIso()}] event log: lost ${eventLost} lines to write errors\n`);
      const text = lines.join('');
      await appendFile(file, text, 'utf8');
      eventLost = 0;
      count = 0; // Written: a rotation failure below loses nothing.
      eventSize += Buffer.byteLength(text);
      if (eventSize > 2 * 1024 * 1024) {
        const tail = (await readFile(file, 'utf8')).split(/\r?\n/).slice(-2000).join('\n');
        const trimmed = Buffer.from(`${tail}\n`).subarray(-1024 * 1024);
        await writeFile(file, trimmed);
        eventSize = trimmed.length;
      }
    } catch { eventFile = null; eventLost += count; } // Logging cannot take down a shared daemon.
    finally { eventBytes -= bytes; }
  }
}

function event(message) {
  let text = cleanValue(message);
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
  const file = testLog || LOG;
  const at = nowIso();
  const line = `[${at}] ${text}\n`;
  const bytes = Buffer.byteLength(line);
  if (eventBytes + bytes > 4 * 1024 * 1024) {
    const last = eventBuffer.at(-1);
    if (last?.file === file && last.drop) last.drop.count++;
    else eventBuffer.push({ file, drop: { at, count: 1 }, bytes: 0 });
  } else {
    eventBuffer.push({ file, line, bytes }); // Capture the target before testLog can change.
    eventBytes += bytes;
  }
  startEvents();
}

function startEvents() {
  if (eventWriter || !eventBuffer.length) return;
  eventWriter = Promise.resolve().then(drainEvents).finally(() => {
    eventWriter = null;
    startEvents();
  });
}

async function flushEvents() {
  while (eventWriter) await eventWriter;
}

function readInfo() {
  try {
    const info = JSON.parse(readFileSync(INFO, 'utf8'));
    if (info.version !== 1 || !Number.isInteger(info.pid) || info.pid <= 0) return null;
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return null;
    if (!/^[a-f0-9]{32}$/.test(info.token)) return null;
    return info;
  } catch { return null; }
}

function httpJson(info, method, route, body, token = info.token, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    let responding = false;
    const req = request({
      hostname: '127.0.0.1', port: info.port, method, path: route,
      headers: { 'X-Luna-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      responding = true;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP timeout')), timeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.on('error', (error) => { if (!responding) reject(new Error(`${method} ${route}: ${error.message}`)); });
    req.end(data);
  });
}

async function health(info = readInfo(), timeoutMs = 3000) {
  if (!info) return null;
  try {
    process.kill(info.pid, 0);
    const result = await httpJson(info, 'GET', '/health', undefined, info.token, timeoutMs);
    return result.status === 200 && result.body.ok && result.body.pid === info.pid ? result.body : null;
  } catch { return null; }
}

// The kernel accepts connections even while the daemon's JavaScript loop is blocked.
async function discoveryAlive(info = readInfo()) {
  if (!info) return false;
  try { process.kill(info.pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  if (process.platform === 'linux') {
    try {
      const command = await readFile(`/proc/${info.pid}/cmdline`, 'utf8');
      if (!/luna-daemon\.mjs\0--serve(?:\0|$)/.test(command)) return false;
    } catch { return false; }
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: info.port });
    const finish = (alive) => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

class MemoryHelper {
  constructor(launch, kill = killTree, report = event, clock = Date.now, timeoutMs = 120_000) {
    Object.assign(this, { launch, kill, report, clock, timeoutMs });
    this.interval = 60_000;
    this.next = 0;
    this.active = null;
  }

  tick(pid) {
    if (this.active) { this.report('memory helper skipped: still running'); return; }
    if (this.clock() < this.next) return;
    let child;
    try { child = this.launch(pid); } catch { this.failed(); return; }
    const entry = { child, done: false, started: this.clock() };
    this.active = entry;
    const settle = (ok) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      this.interval = ok ? 60_000 : Math.min(this.interval * 2, 600_000);
      this.next = (ok ? entry.started : this.clock()) + this.interval;
      this.active = null;
    };
    entry.timer = setTimeout(() => {
      entry.killing = true;
      this.report('memory helper killed: timeout');
      void this.kill(child).finally(() => settle(false));
    }, this.timeoutMs);
    child.once('error', () => settle(false));
    child.once('exit', (code) => { if (!entry.killing) settle(code === 0); });
    entry.settle = settle;
    child.unref?.();
  }

  failed() {
    this.interval = Math.min(this.interval * 2, 600_000);
    this.next = this.clock() + this.interval;
  }

  async stop() {
    const entry = this.active;
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.killing = true;
    await this.kill(entry.child);
    entry.settle(false);
  }
}

class AppServer {
  constructor(onEvent, onCrash, memoryHelper, environment = process.env) {
    this.onEvent = onEvent;
    this.onCrash = onCrash;
    this.pending = new Map();
    this.lateThreads = new Set();
    this.memoryHelper = memoryHelper;
    this.nextId = 1;
    this.dead = false;
    this.stopping = false;
    const config = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
    const args = [...buildLeanArgs(config), '-c', 'thread_unload_delay_secs=0'];
    const shellPath = process.env.LUNA_CODEX_SHELL_PATH;
    this.shell = 'default';
    try {
      if (shellPath && statSync(shellPath).isFile()) {
        args.push('-c', 'default_shell="sh"', '-c', `default_shell_path=${JSON.stringify(shellPath)}`,
          '-c', 'allow_login_shell=false');
        this.shell = 'busybox-sh';
      }
    } catch {} // Missing or inaccessible shell files keep the stock shell configuration.
    if (process.env.LUNA_DAEMON_APP_SERVER_CMD) {
      const command = JSON.parse(process.env.LUNA_DAEMON_APP_SERVER_CMD);
      if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
        throw new Error('LUNA_DAEMON_APP_SERVER_CMD must be a nonempty JSON argv array');
      }
      this.child = spawn(command[0], [...command.slice(1), ...args], {
        cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32', env: environment
      });
    } else this.child = spawnServer(HOME, args, environment);
    if (this.child.pid && process.env.LUNA_LOW_PRIORITY === '1') {
      try { os.setPriority(this.child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    }
    this.codexBin = this.child.spawnfile;
    this.child.on('error', (error) => this.crash(`app-server exited (${error.code || error.message})`));
    this.child.on('exit', (code) => this.crash(`app-server exited (${code})`));
    this.child.stdin.on('error', (error) => event(`app-server stdin: ${error.message}`));
    this.child.stdout.on('error', (error) => event(`app-server stdout: ${error.message}`));
    const pipeClosed = () => {
      if (this.pipeTimer || this.dead) return;
      this.pipeTimer = setTimeout(() => {
        if (!this.stopping) this.crash('app-server exited (stdout closed)');
      }, 1000);
      this.pipeTimer.unref();
    };
    this.child.stdout.on('end', pipeClosed);
    this.child.stdout.on('close', pipeClosed);
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr || ''}${chunk}`.slice(-8000); });
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      try { this.message(JSON.parse(line)); } catch (error) {
        event(`app-server protocol: ${cleanValue(error.message)}`);
      }
    });
    const script = path.join(HERE, 'luna-mempri.ps1');
    this.memoryScript = existsSync(script) ? script : null;
    this.memoryPriority();
  }

  memoryPriority() {
    if (process.platform !== 'win32' || !this.memoryScript || !this.child.pid || this.dead) return;
    this.memoryHelper?.tick(this.child.pid);
  }

  send(frame) {
    if (this.dead) throw new Error('app-server exited (not running)');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  rpc(method, params, timeout = integer('LUNA_DAEMON_RPC_TIMEOUT_MS', 60_000, 1)) {
    if (this.dead) return Promise.reject(new Error('app-server exited (not running)'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === 'thread/start') this.lateThreads.add(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  message(message) {
    if (!message.method && this.lateThreads?.delete(message.id)) {
      const threadId = message.result?.thread?.id || message.result?.threadId;
      if (threadId) void this.rpc('thread/unsubscribe', { threadId }).catch((error) => {
        event(`late thread cleanup: ${error.message}`);
      });
    } else if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      const params = message.params || {};
      let result;
      switch (message.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': result = { decision: 'decline' }; break;
        case 'item/permissions/requestApproval': result = { permissions: {}, scope: 'turn' }; break;
        case 'item/tool/requestUserInput':
          result = { answers: Object.fromEntries((params.questions || []).map((q) => [q.id, { answers: [] }])) };
          break;
        case 'mcpServer/elicitation/request': result = { action: 'decline', content: null, _meta: null }; break;
        case 'item/tool/call':
          result = { contentItems: [{ type: 'inputText', text: 'Dynamic tools are disabled.' }], success: false };
          break;
        case 'applyPatchApproval':
        case 'execCommandApproval': result = { decision: { denied: { rejection: 'unattended daemon' } } }; break;
        default: break;
      }
      this.send(result === undefined
        ? { id: message.id, error: { code: -32601, message: 'unattended daemon cannot handle this request' } }
        : { id: message.id, result });
    } else this.onEvent(message);
  }

  async initialize() {
    await this.rpc('initialize', {
      clientInfo: { name: 'luna-daemon', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }, integer('LUNA_DAEMON_INIT_TIMEOUT_MS', 60_000, 1));
    this.send({ method: 'initialized', params: {} });
  }

  crash(error) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.pipeTimer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(error));
    }
    this.pending.clear();
    // A broken pipe can leave the native process and its children alive.
    if (!this.stopping) {
      void killTree(this.child);
      this.onCrash(error, this);
    }
  }

  stop() {
    this.stopping = true;
    this.crash('daemon stopped');
    return killTree(this.child);
  }

  stopSync() {
    this.stopping = true;
    this.crash('daemon stopped');
    if (this.child.exitCode === null && this.child.signalCode === null) killTreeSync(this.child);
  }
}

async function serve() {
  const refuseDuplicate = async () => {
    if (!await discoveryAlive()) return false;
    process.stderr.write('luna-daemon: another daemon is alive\n');
    process.exitCode = 73;
    return true;
  };
  if (await refuseDuplicate()) return;
  const max = integer('LUNA_DAEMON_MAX', 12, 1);
  const ownerMax = integer('LUNA_DAEMON_OWNER_MAX', 0);
  const idleS = integer('LUNA_DAEMON_IDLE_S', 600);
  const orphanGraceS = integer('LUNA_DAEMON_ORPHAN_GRACE_S', 600, 0);
  const clientCheckMs = integer('LUNA_DAEMON_CLIENT_CHECK_MS', 15_000, 50);
  const testHooks = process.env.LUNA_DAEMON_TEST_HOOKS === '1';
  const queueMax = integer('LUNA_DAEMON_QUEUE_MAX', 64, 1);
  const queueBytes = integer('LUNA_DAEMON_QUEUE_BYTES', 32 * 1024 * 1024, 1);
  const logMax = integer('LUNA_DAEMON_LOG_MAX_BYTES', 5 * 1024 * 1024, 1);
  const reserve = integer('LUNA_RAM_RESERVE_MB', Math.max(1024, Math.floor(os.totalmem() / 1048576 * 0.06)));
  const turnMb = integer('LUNA_DAEMON_TURN_MB', 60);
  const rampMs = integer('LUNA_DAEMON_RAMP_MS', 500);
  const limitsPollS = integer('LUNA_DAEMON_LIMITS_POLL_S', 300, 1);
  const admission = daemonLock(event,
    path.resolve(process.env.LUNA_ADMIT_LOCK || path.join(HOME, '.claude', 'luna-run', 'admit.lock')));
  mkdirSync(RUN, { recursive: true });
  const lock = daemonLock();
  const deadline = Date.now() + 30_000;
  while (!lock.acquire()) {
    if (Date.now() >= deadline) throw new Error('daemon start lock timed out');
    await sleep(100);
  }
  if (await refuseDuplicate()) { lock.release(); return; }
  let http;
  let app;
  let starting;
  let stopping = false;
  let crashLoop = false;
  let info;
  let idleTimer;
  let priorityTimer;
  let loopTimer;
  let degraded = false;
  let threadTimeouts = 0;
  let recycling = false;
  let appTemp;
  let appEnvironment = process.env;
  let loopDelay = monitorEventLoopDelay({ resolution: 20 });
  const loopSamples = [];
  const memoryHelper = new MemoryHelper((pid) => spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'luna-mempri.ps1'),
    '-ProcessId', String(pid), '-Tree', '-Level', 'Low'
  ], { detached: true, windowsHide: true, stdio: 'ignore' }));
  let limitsTimer;
  let limits;
  let limitsRead;
  let limitsUpdates;
  let mainLimitId = null;
  let lastTurnLimits = null;
  let shutdownPromise;
  let lastBusy = Date.now();
  let lastHttpActivity = Date.now();
  const connections = new Set();
  const quietShutdowns = new Set();
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const token = randomBytes(16).toString('hex');
  secrets.add(token);
  const jobs = new Map();
  const preparations = new Set();
  const logWriters = new Set();
  const publications = new Set();
  const threads = new Map();
  const queue = [];
  const crashes = [];
  let running = 0;
  let admissionJob;
  let admissionTimer;
  let nextPump = 0;
  let nextClientCheck = Date.now() + clientCheckMs;

  async function saveLimits(data, reason, sparse = false, updates = []) {
    try {
      let snapshot = limitsSnapshot(data, reason, limits, mainLimitId, sparse);
      if (!sparse) {
        mainLimitId = data.rateLimits.limitId ?? null;
        // Reapply rolling updates that arrived during the read, retaining the read's account metadata.
        for (const update of updates) snapshot = limitsSnapshot(update, 'notify', snapshot, mainLimitId, true);
      }
      limits = snapshot;
      await atomicWrite(LIMITS, `${JSON.stringify(snapshot)}\n`);
    } catch (error) { event(`limits ${reason} failed: ${error.message}`); }
  }

  async function refreshLimits(reason) {
    if (stopping || !app || app.dead) return;
    if (reason === 'turn') {
      if (!limitsTurnDue(lastTurnLimits)) return;
      lastTurnLimits = Date.now(); // Throttle failed and coalesced attempts too.
    }
    if (limitsRead) return limitsRead;
    const server = app;
    const updates = [];
    limitsUpdates = updates;
    const pending = (async () => {
      try {
        const data = await server.rpc('account/rateLimits/read', { excludeResetCreditDetails: true }, 15_000);
        if (stopping || app !== server || server.dead) return;
        await saveLimits(data, reason, false, updates);
      } catch (error) { event(`limits ${reason} failed: ${error.message}`); }
    })();
    limitsRead = pending;
    try { await pending; } finally {
      if (limitsRead === pending) { limitsRead = null; limitsUpdates = null; }
    }
  }

  function queueLog(job, text) {
    const bytes = Buffer.byteLength(text);
    job.logPending.push(text);
    job.logPendingBytes += bytes;
    job.logBytes += bytes;
    job.logRevision++;
  }

  function noteLogDrops(job) {
    if (!job.logDropped) return;
    queueLog(job, `... ${job.logDropped} bytes dropped (log write stalled) ...\n`);
    job.logDropped = 0;
  }

  function drainLog(job) {
    if (!job.logInitialized || job.logWriter || (!job.logPending.length && !job.logDropped)) return;
    const pending = Promise.resolve().then(async () => {
      while (job.logPending.length || job.logDropped) {
        if (!job.logPending.length && job.logDropped) {
          noteLogDrops(job);
        }
        const text = job.logPending.splice(0).join('');
        const bytes = Buffer.byteLength(text);
        try {
          await appendFile(job.log, text, 'utf8');
          job.logWrittenBytes += bytes;
          job.logFailed = false;
        } catch (error) {
          if (!job.logFailed) event(`job ${job.id} log failed: ${error.message}`);
          job.logFailed = true;
        } finally { job.logPendingBytes -= bytes; }
      }
    }).finally(() => {
      job.logWriter = null;
      logWriters.delete(pending);
      if (!job.logPending.length && !job.logDropped) job.logStalled = false;
      drainLog(job);
    });
    job.logWriter = pending;
    logWriters.add(pending);
  }

  async function logIdle(job) {
    if (!job.logInitialized) return;
    while (job.logWriter) {
      try { await job.logWriter; } catch {}
    }
  }

  function appendLog(job, text, control = false) {
    if (!control) job.lastActivity = Date.now(); // Activity is from app-server, even if its log is capped.
    if (!control && job.truncated) return;
    const bytes = Buffer.byteLength(text);
    const truncating = !control && !job.logStalled && job.logBytes + bytes > logMax;
    if (!control && !truncating && (job.logStalled || job.logPendingBytes + bytes > 1024 * 1024)) {
      job.logStalled = true;
      job.logDropped += bytes;
      drainLog(job);
      return;
    }
    if (truncating) {
      job.truncated = true;
      job.heartbeatAt = Date.now();
      text = `... log truncated at ${logMax} bytes; job still running ...\n`;
    }
    if (control) noteLogDrops(job);
    queueLog(job, text);
    drainLog(job);
  }

  function progress(job, text, control = false) {
    appendLog(job, `[${nowIso()}] ${cleanValue(text)}\n`, control);
  }

  function marker(job) {
    const values = { state: job.state, id: job.id, thread: job.thread || '', turn: job.turn || '' };
    if (job.state === 'queued') Object.assign(values, {
      queue_pos: queue.indexOf(job) + 1 || 1, reason: job.reason || 'capacity'
    });
    if (job.startedAt) values.started = new Date(job.startedAt).toISOString();
    if (terminal(job)) Object.assign(values, { rc: job.rc, error: job.error, finished: nowIso() });
    return atomicWrite(`${job.out}.daemon`,
      Object.entries(values).map(([k, v]) => `${k}=${cleanValue(v)}\n`).join(''));
  }

  function releaseAdmission(job) {
    if (admissionJob !== job) return;
    clearTimeout(admissionTimer);
    admissionJob = null;
    admission.release();
    nextPump = 0;
    void pump();
  }

  function releaseSlot(job) {
    if (!job.slot) return;
    job.slot = false;
    running--;
    lastBusy = Date.now();
    void pump();
  }

  async function recycleApp() {
    if (!degraded || running || recycling || stopping) return;
    recycling = true;
    const old = app;
    event('app-server recycle: thread/start degraded, running=0');
    clearTimeout(limitsTimer);
    try {
      await old?.stop();
      if (app === old) app = null;
      if (stopping) return;
      await ensureApp();
      degraded = false;
      threadTimeouts = 0;
      event('degraded off: app-server recycled');
    } catch (error) { event(`app-server recycle failed: ${error.message}`); }
    finally { recycling = false; }
  }

  function finish(job, state, rc, error = '') {
    if (terminal(job)) return;
    job.publishing = true;
    job.shownState = job.state;
    job.state = state;
    job.rc = rc;
    job.error = cleanValue(error);
    job.prompt = ''; // Do not retain prompts in the long-lived job registry.
    job.finalMessage = '';
    lastBusy = Date.now();
    try { progress(job, `completion state=${state} rc=${rc} error=${job.error}`, true); } catch {}
    const publication = settleWithin(logIdle(job), 5000).then(() => marker(job)).finally(() => {
      job.publishing = false;
      publications.delete(publication);
    });
    publications.add(publication);
    job.publication = publication;
    // A client that died before its job completed never saw the result: keep it reattachable.
    if (state === 'completed' && orphanGraceS && job.clientPid > 0 && !job.orphanedAt) {
      try { process.kill(job.clientPid, 0); } catch (error) {
        if (error.code === 'ESRCH') {
          job.orphanedAt = Date.now();
          event(`job ${job.id} completed after its client was gone; kept for reattachment`);
        }
      }
    }
    event(`job end id=${job.id} state=${state} rc=${rc} error=${job.error}`);
    // Retain only small terminal metadata for GET /jobs; expire it after ten minutes.
    job.expiry = Date.now() + 600_000;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    pruneTerminalJobs(jobs);
    if (state !== 'completed') releaseAdmission(job);
  }

  async function unload(job) {
    const server = job.server;
    if (job.unloading) return job.unloading;
    job.unloading = (async () => {
      if (job.thread && server && !server.dead) {
        try { await server.rpc('thread/unsubscribe', { threadId: job.thread }); } catch (error) {
          event(`job ${job.id} cleanup unconfirmed: ${error.message}`);
          job.cleanupError = 'thread cleanup unconfirmed';
          if (job.turn) {
            try {
              await server.rpc('turn/interrupt', { threadId: job.thread, turnId: job.turn }, interruptTimeoutMs());
            }
            catch (retryError) { event(`job ${job.id} cleanup interrupt: ${retryError.message}`); }
          }
          try { await server.rpc('thread/unsubscribe', { threadId: job.thread }); }
          catch (retryError) { event(`job ${job.id} cleanup retry: ${retryError.message}`); }
        }
      }
      if (job.thread && threads.get(job.thread) === job) threads.delete(job.thread);
      job.finalMessage = '';
      job.server = null;
      releaseSlot(job);
    })();
    return job.unloading;
  }

  async function interruptAndUnload(job) {
    if (job.interrupting) return;
    job.interrupting = true;
    const server = job.server;
    try {
      if (job.turn && server && !server.dead && !job.turnEnded) {
        for (let attempt = 0; attempt < 2 && !job.turnEnded; attempt++) {
          try { await server.rpc('turn/interrupt', { threadId: job.thread, turnId: job.turn }, interruptTimeoutMs()); }
          catch (error) { event(`job ${job.id} interrupt unconfirmed: ${error.message}`); }
        }
        if (!job.turnEnded) event(`job ${job.id} interrupt completion unconfirmed; moving on`);
      }
    } finally {
      job.ended = null;
      await unload(job);
      job.interrupting = false;
    }
  }

  async function cancel(job, error = '', state = 'cancelled', rc = 130) {
    if (terminal(job)) return;
    job.cancelled = true;
    // Publish cancellation immediately; keep the slot until interrupt/unload has finished.
    finish(job, state, rc, error);
    if (!job.slot) { void pump(); return; }
    if (job.turn && job.server && !job.server.dead) {
      await interruptAndUnload(job);
    }
    // If thread/start or turn/start is pending, startJob observes cancelled and cleans up.
  }

  function notification(message) {
    const p = message.params || {};
    if (message.method === 'account/rateLimits/updated') {
      if (!stopping) {
        if (p.rateLimits && typeof p.rateLimits === 'object' && !Array.isArray(p.rateLimits)) {
          limitsUpdates?.push(p);
          void saveLimits(p, 'notify', true);
        } else void refreshLimits('notify');
      }
      return;
    }
    const job = threads.get(p.threadId || p.conversationId);
    if (!job) return;
    job.lastActivity = Date.now();
    if (message.method === 'turn/completed') {
      void refreshLimits('turn');
      job.turnEnded = true;
      job.ended?.();
    }
    if (terminal(job)) return;
    if (message.method === 'turn/started' && p.turn?.id) {
      job.turn = p.turn.id;
      job.prompt = '';
      void marker(job);
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item || {};
      progress(job, `${message.method} type=${item.type || 'unknown'} ${item.command || ''}`);
      if (message.method === 'item/started' && item.type === 'commandExecution') {
        appendLog(job, `exec\n${item.command || ''}\n`);
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase !== 'commentary') job.finalMessage = item.text;
        appendLog(job, `codex\n${item.text}\n`);
      }
      if (item.aggregatedOutput) progress(job, item.aggregatedOutput);
    } else if (/delta$/i.test(message.method || '') && typeof p.delta === 'string') {
      progress(job, `${message.method} ${p.delta}`);
    } else if (message.method === 'turn/completed') {
      if (job.completing) return;
      job.completing = true;
      const turn = p.turn || {};
      const final = [...(turn.items || [])].reverse()
        .find((item) => item.type === 'agentMessage' && item.phase !== 'commentary');
      if (typeof final?.text === 'string') job.finalMessage = final.text;
      let error = turn.status === 'completed' ? '' : (turn.error?.message || `turn status ${turn.status}`);
      if (!job.finalMessage?.trim() && !error) error = 'empty final message';
      void (async () => {
        if (!await atomicWrite(job.out, job.finalMessage || '')) error = 'final output write failed';
        await unload(job);
        error ||= job.cleanupError || '';
        if (!terminal(job)) finish(job, error ? 'failed' : 'completed', error ? 1 : 0, error);
      })();
    }
  }

  function crashed(error, server) {
    if (stopping || app !== server) return;
    clearTimeout(limitsTimer);
    limitsRead = null;
    limitsUpdates = null;
    app = null;
    event(`crash ${error}`);
    crashes.push(Date.now());
    while (crashes.length && crashes[0] < Date.now() - 600_000) crashes.shift();
    crashLoop = crashes.length >= 3;
    queue.length = 0;
    for (const job of jobs.values()) {
      if (!terminal(job)) finish(job, 'failed', 1, error);
      if (job.slot) { job.slot = false; running--; }
      job.server = null;
    }
    threads.clear();
    lastBusy = Date.now();
    if (crashLoop) {
      event('app-server crash loop');
      // A short drain window gives clients a definite crash-loop failure before exit.
      shutdownWhenQuiet('crash loop');
    }
  }

  function scheduleLimitsPoll(server) {
    const due = Date.now() + limitsPollS * 1000;
    const poll = async () => {
      if (stopping || app !== server || server.dead) return;
      const remaining = due - Date.now();
      if (remaining > 0) { limitsTimer = setTimeout(poll, remaining); return; }
      await refreshLimits('poll');
      if (!stopping && app === server && !server.dead) scheduleLimitsPoll(server);
    };
    limitsTimer = setTimeout(poll, limitsPollS * 1000);
  }

  async function ensureApp() {
    if (starting) return starting;
    if (app && !app.dead) return app;
    starting = (async () => {
      const server = new AppServer(notification, crashed, memoryHelper, appEnvironment);
      app = server;
      try { await server.initialize(); }
      catch (error) {
        await server.stop();
        if (app === server) app = null;
        throw error;
      }
      clearTimeout(limitsTimer);
      void refreshLimits('start').then(() => {
        if (!stopping && app === server && !server.dead) scheduleLimitsPoll(server);
      });
      if (info && !stopping) {
        info.codexBin = server.codexBin;
        info.shell = server.shell;
        await atomicWrite(INFO, `${JSON.stringify(info)}\n`, { beforeRename: secureInfo });
      }
      return server;
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function startJob(job) {
    try {
      const server = await ensureApp();
      job.server = server;
      if (terminal(job) || stopping) { job.server = null; releaseSlot(job); return; }
      if (degraded) throw new Error('thread-start-timeout');
      const response = await server.rpc('thread/start', {
        cwd: job.cwd, sandbox: job.sandbox, approvalPolicy: 'never',
        ephemeral: job.ephemeral ?? (process.env.LUNA_KEEP_SESSION !== '1'),
        model: job.model, serviceTier: job.tier
      });
      job.thread = response?.thread?.id || response?.threadId;
      if (!job.thread) throw new Error('thread/start returned no thread id');
      threadTimeouts = 0;
      threads.set(job.thread, job);
      if (terminal(job) || stopping) { await unload(job); return; }
      await marker(job);
      if (terminal(job) || stopping) { await unload(job); return; }
      const result = await server.rpc('turn/start', {
        threadId: job.thread, model: job.model, effort: job.effort, serviceTier: job.tier,
        input: [{ type: 'text', text: job.prompt, text_elements: [] }]
      });
      job.turn = result?.turn?.id || job.turn;
      job.prompt = '';
      if (!job.turn) throw new Error('turn/start returned no turn id');
      if (job.cancelled || stopping || terminal(job)) {
        await interruptAndUnload(job);
        return;
      }
      if (!terminal(job)) {
        void marker(job);
        progress(job, `turn start thread=${job.thread} turn=${job.turn} model=${job.model} effort=${job.effort}`);
        if (admissionJob === job) admissionTimer = setTimeout(() => releaseAdmission(job), rampMs);
      }
    } catch (error) {
      if (error.message === 'thread/start timed out') {
        error = new Error('thread-start-timeout');
        if (++threadTimeouts >= 2 && !degraded) {
          degraded = true;
          event('degraded on: consecutive thread/start timeouts');
        }
      }
      if (!terminal(job)) finish(job, 'failed', 1, error.message);
      if (job.turn) await interruptAndUnload(job);
      else await unload(job);
    }
  }

  async function pump() {
    if (stopping || crashLoop || admissionJob) return;
    if (degraded) {
      for (const job of [...queue]) {
        if (job.ready) finish(job, 'failed', 1, 'thread-start-timeout');
      }
      void recycleApp();
      return;
    }
    if (recycling) return;
    nextPump = Date.now() + 2000;
    const activeWrites = [...jobs.values()].filter((job) => job.slot && job.sandbox === 'workspace-write');
    const owners = ownerCounts(jobs.values());
    for (const job of fairQueue(queue, owners)) {
      if (!job.ready) continue;
      job.reason = 'capacity';
      if (ownerMax && owners.get(job.owner).running >= ownerMax) {
        job.reason = 'owner';
        void marker(job);
        continue;
      }
      if (job.sandbox === 'workspace-write' && activeWrites.some((other) =>
        other.canonicalCwd === job.canonicalCwd && (job.exclusiveRepo || other.exclusiveRepo))) {
        job.reason = 'repo';
        void marker(job);
        continue;
      }
      if (running >= max) { void marker(job); continue; }
      try {
        if (!admission.acquire()) { job.reason = 'lock'; void marker(job); return; }
        if (Math.floor(os.freemem() / 1048576) < reserve + turnMb) {
          admission.release();
          job.reason = 'ram';
          void marker(job);
          return;
        }
      } catch (error) {
        admission.release();
        event(`job ${job.id} admission failed: ${error.message}`);
        finish(job, 'failed', 1, 'admission failed');
        continue;
      }
      admissionJob = job;
      queue.splice(queue.indexOf(job), 1);
      job.slot = true;
      running++;
      job.state = 'running';
      job.reason = '';
      job.startedAt = job.lastActivity = Date.now();
      void marker(job);
      progress(job, `job start model=${job.model} sandbox=${job.sandbox}`);
      event(`job start id=${job.id} model=${job.model}`);
      void startJob(job);
      return;
    }
  }

  async function secureInfo(file) {
    if (process.platform !== 'win32') return;
    await new Promise((resolve) => {
      let child;
      let timer;
      let done = false;
      const settle = (code, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) event(`daemon.json ACL failed: ${error.message}`);
        else event(`daemon.json ACL rc=${code} `);
        resolve();
      };
      try {
        child = spawn('icacls', [file, '/inheritance:r', '/grant:r',
          `${process.env.USERNAME || os.userInfo().username}:F`, 'SYSTEM:F'],
        { windowsHide: true, stdio: 'ignore' });
        child.once('error', (error) => settle(null, error));
        child.once('exit', (code) => settle(code));
        timer = setTimeout(() => {
          try { child.kill(); } catch {}
          settle(null, new Error('icacls timed out'));
        }, 5000);
      } catch (error) { settle(null, error); }
    });
  }

  function jobList() {
    return [...jobs.values()].map((job) => ({
      id: job.id, state: jobView(job).state, owner: job.owner, model: job.model, effort: job.effort,
      sandbox: job.sandbox, orphaned: Boolean(job.orphanedAt) && !terminal(job),
      cwd: job.cwd, clientPid: job.clientPid || 0, queuedAt: new Date(job.queuedAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      ageS: Math.floor((Date.now() - job.queuedAt) / 1000), logBytes: job.logBytes, reason: job.reason || ''
    }));
  }

  function shutdownWhenQuiet(reason, stillWanted = () => true) {
    if (quietShutdowns.has(reason)) return;
    quietShutdowns.add(reason);
    const started = Date.now();
    const check = () => {
      // Timers can run before I/O after a blocked loop; poll accepted connections before deciding.
      setImmediate(() => {
        if (stopping || !stillWanted()) { quietShutdowns.delete(reason); return; }
        // A crash loop must exit even under non-stop polling; idle exit just waits for a quiet moment.
        const forced = reason !== 'idle exit' && Date.now() - started >= 5000;
        if ((!connections.size && Date.now() - lastHttpActivity >= 250) || forced) {
          quietShutdowns.delete(reason);
          if (reason === 'idle exit') event('idle exit');
          void shutdown(reason);
          return;
        }
        setTimeout(check, 50).unref();
      });
    };
    setTimeout(check, 250).unref();
  }

  function shutdown(reason = 'daemon stopped') {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      clearInterval(idleTimer);
      clearInterval(priorityTimer);
      clearInterval(loopTimer);
      loopDelay.disable();
      clearTimeout(limitsTimer);
      clearTimeout(admissionTimer);
      admission.release();
      admissionJob = null;
      event(`stop ${reason}`);
      const interrupts = [];
      for (const job of jobs.values()) {
        if (!terminal(job)) {
          finish(job, 'failed', 1, 'daemon stopped');
          if (job.turn && app && !app.dead) {
            interrupts.push(app.rpc('turn/interrupt', { threadId: job.thread, turnId: job.turn }, 2000));
          }
        }
      }
      await Promise.allSettled(interrupts);
      await app?.stop();
      await memoryHelper.stop();
      if (appTemp) await rm(appTemp, { recursive: true, force: true }).catch(() => {});
      if (!await settleWithin(Promise.allSettled([starting, ...preparations]), 5000)) {
        event('shutdown: startup and preparations did not settle within 5000 ms');
      }
      if (!await settleWithin(writes.get(INFO), 5000)) {
        event('shutdown: INFO write did not settle within 5000 ms');
      }
      if (!await settleWithin(removeOwnDiscovery(), 3000)) event('shutdown: discovery cleanup did not settle');
      const drainDeadline = Date.now() + 10_000;
      while (writes.size || logWriters.size || publications.size) {
        const remaining = drainDeadline - Date.now();
        const pending = Promise.allSettled([...writes.values(), ...logWriters, ...publications]);
        if (remaining <= 0 || !await settleWithin(pending, remaining)) {
          event('shutdown: writes and logs did not settle within 10000 ms');
          break;
        }
      }
      if (!await settleWithin(flushEvents(), 3000)) {
        event('shutdown: event flush did not settle within 3000 ms');
      }
      // An INFO write that outlived its wait may have republished discovery during the drain.
      await settleWithin(removeOwnDiscovery(), 3000);
      lock.release();
      await new Promise((resolve) => setImmediate(resolve));
      // A connection completing between this I/O yield and listener close can still reset on process exit.
      http?.close();
      // In-flight requests get up to 5 s (POST /jobs answers 503); lingering rejected sockets have their own 5 s cap.
      const deadline = Date.now() + 5000;
      while (connections.size && Date.now() < deadline) await sleep(20);
      http?.closeAllConnections();
      if (!await settleWithin(flushEvents(), 3000)) {
        event('shutdown: final event flush did not settle within 3000 ms');
      }
      process.exitCode = 0;
    })();
    return shutdownPromise;
  }

  async function removeOwnDiscovery() {
    try {
      const current = JSON.parse(await readFile(INFO, 'utf8'));
      if (current?.pid === process.pid && current.token === token) await unlink(INFO);
    } catch (error) {
      if (error.code !== 'ENOENT') event(`discovery cleanup: ${error.message}`);
    }
  }

  function validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('job must be an object');
    body.owner = normalizeOwner(body.owner);
    if (!['read-only', 'workspace-write'].includes(body.sandbox)) throw new Error('invalid sandbox');
    if (typeof body.cwd !== 'string') throw new Error('cwd must be a directory');
    for (const key of ['out', 'log']) {
      if (typeof body[key] !== 'string' || !path.isAbsolute(body[key])) throw new Error(`${key} must be absolute`);
    }
    const outputs = outputPaths(body);
    if (new Set(outputs).size !== outputs.length) throw new Error('out, log and marker paths must differ');
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('prompt must be nonempty');
    for (const key of ['model', 'effort', 'tier']) {
      if (typeof body[key] !== 'string' || !body[key]) throw new Error(`${key} must be nonempty`);
    }
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)) throw new Error('invalid effort');
    if (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean') throw new Error('invalid ephemeral');
    if (body.clientPid !== undefined && (!Number.isSafeInteger(body.clientPid) || body.clientPid < 0)) {
      throw new Error('invalid clientPid');
    }
    if (body.exclusiveRepo !== undefined && typeof body.exclusiveRepo !== 'boolean') {
      throw new Error('invalid exclusiveRepo');
    }
    for (const key of ['idleMaxS', 'timeoutS']) {
      if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw new Error(`${key} must be non-negative seconds`);
    }
  }

  async function prepareJob(job) {
    try {
      await appendFile(job.log, '', 'utf8');
      job.canonicalCwd = pathKey(await realpath(job.cwd));
      const size = (await stat(job.log)).size;
      job.logBytes += size;
      job.logWrittenBytes = size;
      job.logInitialized = true;
      drainLog(job);
      if (stopping) throw new Error('daemon stopped');
      if (!await atomicWrite(job.out, '') || !await marker(job)) {
        throw new Error('cannot write output or marker');
      }
    } catch (error) {
      job.logInitialized = true;
      finish(job, 'failed', 1, error.message);
      drainLog(job);
      throw error;
    }
  }

  const onExit = () => {
    lock.release();
    admission.release();
    app?.stopSync();
    if (memoryHelper.active) killTreeSync(memoryHelper.active.child);
    if (appTemp) { try { rmSync(appTemp, { recursive: true, force: true }); } catch {} }
    const current = readInfo();
    if (current?.pid === process.pid && current.token === token) {
      try { unlinkSync(INFO); } catch {}
    }
  };
  process.on('exit', onExit);
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  try {
    try {
      if (existsSync(LOG)) {
        const lines = readFileSync(LOG, 'utf8').trimEnd().split(/\r?\n/).slice(-2000);
        writeFileSync(LOG, `${lines.join('\n')}\n`, 'utf8');
      }
    } catch (error) { event(`daemon log trim failed: ${error.message}`); }
    event(`start pid=${process.pid}`);
    if (process.env.LUNA_JOB_TEMP !== '0') {
      const tempRoot = path.join(RUN, 'tmp');
      mkdirSync(tempRoot, { recursive: true });
      for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
        const match = /^daemon-([1-9]\d*)$/.exec(entry.name);
        if (!entry.isDirectory() || !match) continue;
        try { process.kill(Number(match[1]), 0); }
        catch (error) {
          if (error.code === 'ESRCH') {
            await rm(path.join(tempRoot, entry.name), { recursive: true, force: true }).catch(() => {});
          }
        }
      }
      appTemp = path.join(tempRoot, `daemon-${process.pid}`);
      mkdirSync(appTemp, { recursive: true });
      appEnvironment = { ...process.env, TEMP: appTemp, TMP: appTemp, TMPDIR: appTemp };
    }
    loopDelay.enable();
    loopTimer = setInterval(() => {
      loopDelay.disable();
      loopSamples.push({ at: Date.now(), p99Ns: loopDelay.count ? loopDelay.percentile(99) : 0,
        count: loopDelay.count });
      while (loopSamples.length && loopSamples[0].at <= Date.now() - 60_000) loopSamples.shift();
      loopDelay = monitorEventLoopDelay({ resolution: 20 });
      loopDelay.enable();
    }, 1000);
    await ensureApp();
    if (stopping) throw new Error('daemon stopped');
    http = createServer(async (req, res) => {
      lastHttpActivity = Date.now();
      req.on('error', (error) => event(`HTTP request: ${error.code || error.message}`));
      res.on('error', (error) => event(`HTTP response: ${error.code || error.message}`));
      const reply = (code, body) => {
        if (res.destroyed || res.writableEnded) return;
        // Every response closes its connection. With keep-alive, Node 22 clients reuse sockets on a 5 s timer while the
        // server drops idle ones on its own 5 s timer: a request sent into a socket the server is closing fails with
        // ECONNRESET (flaky). Our clients (curl, the collector) open a fresh localhost connection per request anyway.
        const headers = { 'Content-Type': 'application/json', Connection: 'close' };
        const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
        const bodyPending = !req.complete && hasBody;
        if (bodyPending) {
          const socket = req.socket;
          let drained = 0;
          let finished = false;
          let ended = false;
          let done = false;
          let timer;
          const destroy = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
          };
          const onEnd = () => { ended = true; if (finished) destroy(); };
          const onData = (chunk) => { drained += chunk.length; if (drained > 8 * 1024 * 1024) destroy(); };
          req.on('data', onData);
          req.once('end', onEnd);
          socket.once('end', onEnd);
          socket.once('close', () => {
            clearTimeout(timer);
            req.removeListener('data', onData);
            req.removeListener('end', onEnd);
            socket.removeListener('end', onEnd);
            onEnd();
          });
          res.once('finish', () => {
            finished = true;
            if (ended) destroy();
            else if (!done) timer = setTimeout(destroy, 5000).unref();
          });
          // On Windows, closing with unread body bytes sends RST and drops the client's unread response.
          socket.destroySoon = () => { if (socket.writable) socket.end(); };
          req.resume();
        }
        res.writeHead(code, headers);
        res.end(JSON.stringify(body));
      };
      const supplied = Buffer.from(String(req.headers['x-luna-token'] || ''));
      const expected = Buffer.from(token);
      if (req.socket.remoteAddress !== '127.0.0.1' || supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)) {
        reply(401, { error: 'unauthorized' });
        return;
      }
      if (Number(req.headers['content-length']) > 2 * 1024 * 1024) {
        reply(413, { error: 'body exceeds 2 MB' });
        return;
      }
      try {
        if (testHooks && req.method === 'POST') {
          const url = new URL(req.url, 'http://x');
          if (url.pathname === '/test/block') {
            const value = url.searchParams.get('ms');
            const ms = Number(value);
            if (!/^\d+$/.test(value || '') || !Number.isInteger(ms) || ms < 1 || ms > 60_000) {
              reply(400, { error: 'ms must be an integer from 1 to 60000' });
              return;
            }
            res.once('finish', () => {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            });
            reply(200, { ok: true });
            return;
          }
        }
        if (req.method === 'GET' && req.url === '/health') {
          reply(200, { ok: !stopping && !crashLoop, pid: process.pid, appServerPid: app?.child.pid || null,
            degraded, loopDelayMs: eventLoopDelayMs(loopDelay, loopSamples),
            appServer: starting ? 'restarting' : app && !app.dead ? 'up' : 'down',
            codexBin: app?.codexBin || info?.codexBin, shell: app?.shell || info?.shell,
            jobs: { running, queued: queue.filter((job) => !terminal(job)).length },
            uptimeS: Math.floor((Date.now() - Date.parse(startedAt)) / 1000) });
          return;
        }
        if (req.method === 'GET' && req.url === '/jobs') {
          reply(200, { jobs: jobList(), owners: Object.fromEntries(ownerCounts(jobs.values())) });
          return;
        }
        if (req.method === 'GET' && req.url === '/limits') {
          let snapshot;
          try { snapshot = JSON.parse(await readFile(LIMITS, 'utf8')); } catch {}
          reply(snapshot ? 200 : 404, snapshot || { error: 'no rate limits yet' });
          return;
        }
        if (req.method === 'POST' && req.url === '/stop') {
          res.once('finish', () => { void shutdown(); });
          reply(200, { ok: true });
          return;
        }
        const match = /^\/jobs\/([a-f0-9]+)(\/cancel)?$/.exec(req.url);
        if (match) {
          const job = jobs.get(match[1]);
          if (!job) { reply(404, { error: 'unknown job' }); return; }
          if (req.method === 'POST' && match[2]) {
            void cancel(job);
            reply(200, jobView(job));
          } else if (req.method === 'GET' && !match[2]) {
            reply(200, jobView(job));
          } else reply(404, { error: 'unknown route' });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/jobs') { reply(404, { error: 'unknown route' }); return; }
        // With no orphan grace there can be no reattachment; retain early streaming rejection.
        if (!orphanGraceS && queue.length >= queueMax) {
          reply(429, { error: 'daemon queue full', retryAfterS: 2 });
          return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            reply(413, { error: 'body exceeds 2 MB' });
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        validate(body);
        if (!(await stat(body.cwd)).isDirectory()) throw new Error('cwd must be a directory');
        if (stopping) { reply(503, { error: 'daemon stopped' }); return; }
        const identity = jobIdentity(body);
        const outKey = canonicalOutKey(body.out);
        const attachClient = Number.isSafeInteger(body.clientPid) && body.clientPid > 0;
        for (const previous of jobs.values()) {
          if (previous.outKey !== outKey || previous.identity !== identity || !attachClient) continue;
          if (orphanGraceS > 0 && !terminal(previous) && !previous.orphanedAt &&
              previous.clientPid > 0 && previous.clientPid !== body.clientPid) {
            try { process.kill(previous.clientPid, 0); } catch (error) {
              if (error.code === 'ESRCH') {
                previous.orphanedAt = Date.now();
                event(`job ${previous.id} client gone; orphaned at resubmission`);
              }
            }
          }
          if (!previous.orphanedAt || (terminal(previous) && previous.state !== 'completed')) continue;
          if (!terminal(previous) && Date.now() - previous.orphanedAt >= orphanGraceS * 1000) {
            await cancel(previous, 'client gone');
            // Its terminal marker is published asynchronously; let it land before a new job reuses the paths.
            await previous.publication;
            continue;
          }
          const orphanedAt = previous.orphanedAt;
          previous.clientPid = body.clientPid;
          event(`job ${previous.id} reattached client=${previous.clientPid}`);
          let written = false;
          try { written = await marker(previous); } catch {}
          if (!written) {
            previous.orphanedAt = orphanedAt;
            reply(400, { error: 'cannot write output or marker' });
            return;
          }
          if (!terminal(previous)) previous.orphanedAt = null;
          reply(200, { id: previous.id, attached: true });
          return;
        }
        const promptBytes = Buffer.byteLength(body.prompt);
        const queuedBytes = queuedPromptBytes(queue);
        if (queue.length >= queueMax || queuedBytes + promptBytes > queueBytes) {
          reply(429, { error: 'daemon queue full', retryAfterS: 2 });
          return;
        }
        for (const previous of jobs.values()) {
          if (!terminal(previous) && outputPaths(previous).some((file) => outputPaths(body).includes(file))) {
            reply(409, { error: 'output or log already in use' });
            return;
          }
        }
        const fields = ['prompt', 'cwd', 'sandbox', 'model', 'effort', 'tier', 'out', 'log',
          'idleMaxS', 'timeoutS', 'ephemeral', 'clientPid', 'exclusiveRepo', 'owner'];
        const job = { ...Object.fromEntries(fields.map((key) => [key, body[key]])),
          identity, outKey,
          id: randomBytes(16).toString('hex'), state: 'queued', rc: null, error: '', queuedAt: Date.now(),
          canonicalCwd: null, logBytes: 0, logWrittenBytes: 0, logPending: [], logPendingBytes: 0,
          logDropped: 0, logRevision: 0, logInitialized: false, ready: false };
        jobs.set(job.id, job);
        queue.push(job); // Reserve queue count/bytes before yielding to any other submission.
        const preparation = prepareJob(job);
        preparations.add(preparation);
        try { await preparation; }
        catch (error) {
          event(`request failed: ${error.message}`);
          if (stopping) { reply(503, { error: 'daemon stopped' }); return; }
          reply(400, { error: cleanValue(error.message) });
          return;
        } finally { preparations.delete(preparation); }
        if (stopping) {
          finish(job, 'failed', 1, 'daemon stopped');
          reply(503, { error: 'daemon stopped' });
          return;
        }
        job.ready = true;
        lastBusy = Date.now();
        if (crashLoop) finish(job, 'failed', 1, 'app-server crash loop');
        else if (degraded) finish(job, 'failed', 1, 'thread-start-timeout');
        reply(200, { id: job.id });
        void pump();
      } catch (error) {
        event(`request failed: ${error.message}`);
        reply(400, { error: cleanValue(error.message) });
      }
    });
    http.on('connection', (socket) => {
      connections.add(socket);
      lastHttpActivity = Date.now();
      socket.once('close', () => {
        connections.delete(socket);
        lastHttpActivity = Date.now();
      });
    });
    http.requestTimeout = 30_000;
    http.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    if (stopping) throw new Error('daemon stopped');
    info = { pid: process.pid, port: http.address().port, token, startedAt,
      codexBin: app.codexBin, shell: app.shell, version: 1 };
    if (!await atomicWrite(INFO, `${JSON.stringify(info)}\n`, { beforeRename: secureInfo })) {
      throw new Error('cannot write discovery');
    }
    lock.release();
    const fatal = (error) => {
      event(`fatal ${error.stack || error}`);
      void shutdown();
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    idleTimer = setInterval(() => {
      const now = Date.now();
      pruneTerminalJobs(jobs);
      for (const job of jobs.values()) {
        if (terminal(job)) continue;
        if (now >= nextClientCheck && job.clientPid && !job.orphanedAt) {
          try { process.kill(job.clientPid, 0); } catch (error) {
            if (error.code === 'ESRCH') {
              if (!orphanGraceS) { void cancel(job, 'client gone'); continue; }
              job.orphanedAt = now;
              event(`job ${job.id} client gone; orphaned for up to ${orphanGraceS}s`);
            }
          }
        }
        if (job.orphanedAt && now - job.orphanedAt >= orphanGraceS * 1000) {
          void cancel(job, 'client gone');
          continue;
        }
        if (job.state !== 'running') continue;
        if (!job.logStatPending && !job.logWriter && !job.logPendingBytes) {
          job.logStatPending = true;
          const revision = job.logRevision;
          void stat(job.log).then(({ size }) => {
            job.logStatFailed = false;
            if (job.state !== 'running' || job.logWriter || job.logPendingBytes ||
                job.logRevision !== revision) return;
            if (size !== job.logWrittenBytes) {
              job.logBytes = job.logWrittenBytes = size;
              job.lastActivity = Date.now();
            }
          }).catch((error) => {
            if (!job.logStatFailed) event(`job ${job.id} log stat failed: ${error.message}`);
            job.logStatFailed = true;
          }).finally(() => { job.logStatPending = false; });
        }
        const expiry = expiredLimit(job, now);
        if (expiry) void cancel(job, expiry, 'stalled', 124);
        if (!terminal(job) && job.truncated && now - job.heartbeatAt >= 30_000) {
          job.heartbeatAt = now;
          appendLog(job, `[${nowIso()}] heartbeat: job still running\n`, true);
        }
      }
      if (now >= nextClientCheck) nextClientCheck = now + clientCheckMs;
      if (now >= nextPump) void pump();
      const idleStillTrue = () => !running && !queue.some((job) => !terminal(job)) && idleS &&
        Date.now() - lastBusy >= idleS * 1000;
      if (idleStillTrue()) shutdownWhenQuiet('idle exit', idleStillTrue);
    }, 500);
    priorityTimer = setInterval(() => { if (running) app?.memoryPriority(); }, 60_000);
  } catch (error) {
    await shutdown();
    throw error;
  } finally { lock.release(); }
}

function eventLoopDelayMs(current, samples, now = Date.now()) {
  let p99Ns = current.count ? current.percentile(99) : 0;
  for (const sample of samples) {
    if (sample.at >= now - 60_000 && sample.at <= now && sample.count > 0) {
      p99Ns = Math.max(p99Ns, sample.p99Ns);
    }
  }
  return Math.round(p99Ns / 1e6);
}

async function unitChecks(root, check) {
  testLog = path.join(root, 'unit.log');
  const identityServer = createServer();
  await new Promise((resolve) => identityServer.listen(0, '127.0.0.1', resolve));
  const identityInfo = { pid: process.pid, port: identityServer.address().port };
  await new Promise((resolve) => identityServer.close(resolve));
  let identityStarted = Date.now();
  check('live non-daemon PID with an unbound port is not alive', !await discoveryAlive(identityInfo));
  check('unbound port identity check finishes within two seconds', Date.now() - identityStarted < 2000);
  identityStarted = Date.now();
  check('dead PID is not alive', !await discoveryAlive({ ...identityInfo, pid: 2147483647 }));
  check('dead PID identity check finishes within two seconds', Date.now() - identityStarted < 2000);
  const currentDelay = monitorEventLoopDelay({ resolution: 10 });
  const rotatedDelay = monitorEventLoopDelay({ resolution: 10 });
  currentDelay.enable();
  rotatedDelay.enable();
  await sleep(60);
  rotatedDelay.disable();
  const rotatedWindow = { at: Date.now(), p99Ns: rotatedDelay.count ? rotatedDelay.percentile(99) : 0,
    count: rotatedDelay.count };
  await sleep(60);
  currentDelay.disable();
  const measuredDelay = eventLoopDelayMs(currentDelay, [rotatedWindow]);
  check('event-loop health delay is numeric with a real rotated window', rotatedWindow.count > 0 &&
    Number.isFinite(measuredDelay) && measuredDelay >= 0);
  check('settleWithin times out without rejecting', !await settleWithin(new Promise(() => {}), 20) &&
    await settleWithin(Promise.reject(new Error('x')), 1000));
  const window = { usedPercent: 0, windowDurationMins: 300, resetsAt: 2_000_000_000 };
  check('turn limits throttle permits the first read and opens exactly at 60 seconds',
    limitsTurnDue(null, 0) && !limitsTurnDue(0, 59_999) && limitsTurnDue(0, 60_000));
  const snapshot = { limitId: 'codex', limitName: 'Codex', planType: 'plus', primary: window,
    secondary: null, rateLimitReachedType: 'rate_limit_reached', credits: { balance: 'private' } };
  const mapped = limitsSnapshot({ rateLimits: snapshot, ordinaryUsageAllowed: false,
    rateLimitsByLimitId: { codex: snapshot }, accountId: 'private', accessToken: 'private' }, 'start');
  check('limits snapshot has exact public keys and converts unix seconds to ISO',
    Object.keys(mapped).join(',') === 'v,at,source,planType,ordinaryUsageAllowed,reached,primary,secondary,byLimitId' &&
    mapped.v === 1 && Number.isFinite(Date.parse(mapped.at)) && mapped.source === 'start' &&
    mapped.planType === 'plus' && mapped.ordinaryUsageAllowed === false &&
    mapped.reached === 'rate_limit_reached' && mapped.secondary === null &&
    JSON.stringify(mapped.primary) ===
      '{"usedPercent":0,"windowMins":300,"resetsAt":"2033-05-18T03:33:20.000Z"}' &&
    Object.keys(mapped.byLimitId.codex).join(',') === 'name,primary,secondary,reached' &&
    !/private|accountId|accessToken|credits/.test(JSON.stringify(mapped)));
  const sparse = limitsSnapshot({ rateLimits: { limitId: 'codex', planType: null,
    primary: { usedPercent: 23, windowDurationMins: null, resetsAt: 0 } } }, 'notify', mapped, 'codex', true);
  check('sparse limits notification keeps metadata, other windows and bucket names',
    sparse.source === 'notify' && sparse.planType === 'plus' && sparse.ordinaryUsageAllowed === false &&
    sparse.reached === 'rate_limit_reached' && sparse.primary.usedPercent === 23 &&
    sparse.primary.windowMins === null && sparse.primary.resetsAt === '1970-01-01T00:00:00.000Z' &&
    sparse.byLimitId.codex.name === 'Codex' && sparse.byLimitId.codex.primary.usedPercent === 23);
  const other = limitsSnapshot({ rateLimits: { limitId: 'fast', limitName: 'Fast', primary: window } },
    'notify', sparse, 'codex', true);
  check('other limits bucket updates preserve the main bucket', other.primary.usedPercent === 23 &&
    other.byLimitId.fast.primary.usedPercent === 0 && other.byLimitId.codex.primary.usedPercent === 23);
  const empty = limitsSnapshot({ rateLimits: {} }, 'notify', sparse, 'codex');
  check('full limits read clears stale metadata and handles missing nullable fields',
    empty.planType === null && empty.ordinaryUsageAllowed === null && empty.reached === null &&
    empty.primary === null && empty.secondary === null && Object.keys(empty.byLimitId).length === 0 &&
    limitWindow({ usedPercent: 1, resetsAt: 1e20 }).resetsAt === null && limitWindow(null) === null);
  check('terminal includes stalled but excludes queued', terminal({ state: 'stalled' }) &&
    !terminal({ state: 'queued' }));
  check('output paths do not alias by default', new Set(outputPaths({
    out: path.join(root, 'answer'), log: path.join(root, 'answer.log')
  })).size === 5);
  check('queue memory counts UTF-8 bytes', queuedPromptBytes([{ prompt: 'hello' }, { prompt: '\u044f' }]) === 7);
  check('owner accepts only 1 to 128 allowed printable characters',
    normalizeOwner('session_A.1:2-3') === 'session_A.1:2-3' && normalizeOwner('x'.repeat(128)).length === 128 &&
    [undefined, null, 1, {}, '', 'x'.repeat(129), 'has space', 'line\n', '\u044f'].every((owner) =>
      normalizeOwner(owner) === 'default'));
  const ownerJobs = [
    { owner: 'A', state: 'running', slot: true }, { owner: 'A', state: 'completed', slot: true },
    { owner: 'B', state: 'queued', id: 'B1' }, { owner: 'A', state: 'queued', id: 'A1' },
    { owner: 'C', state: 'queued', id: 'C1' }, { owner: 'B', state: 'queued', id: 'B2' },
    { owner: '__proto__', state: 'queued', id: 'P1' }, { owner: 'gone', state: 'completed', slot: false }
  ];
  const owners = ownerCounts(ownerJobs);
  check('owner counts include occupied cleanup slots and only active owners', owners.get('A').running === 2 &&
    owners.get('A').queued === 1 && owners.get('B').queued === 2 && !owners.has('gone') &&
    Object.fromEntries(owners).__proto__.queued === 1);
  const ownerQueue = ownerJobs.filter((job) => job.state === 'queued');
  check('fair queue favors fewer running jobs then submission age without reordering its input',
    fairQueue(ownerQueue, owners).map((job) => job.id).join(',') === 'B1,C1,B2,P1,A1' &&
    ownerQueue.map((job) => job.id).join(',') === 'B1,A1,C1,B2,P1');
  const clockJob = { state: 'queued', queuedAt: 0, startedAt: 10000, lastActivity: 10000,
    timeoutS: 5, idleMaxS: 3 };
  check('queued clocks do not expire', expiredLimit(clockJob, 30000) === '');
  clockJob.state = 'running';
  check('wall timeout uses running time rather than queue age', expiredLimit(clockJob, 12000) === '' &&
    expiredLimit(clockJob, 15000) === 'exceeded total timeout 5s');
  check('idle timeout uses thread activity independently', expiredLimit(clockJob, 13000) === 'no events for 3s');
  const retained = new Map(Array.from({ length: 502 }, (_, id) => [id,
    { id, state: 'completed', expiry: Date.now() + 600_000 }]));
  retained.set('active', { id: 'active', state: 'running' });
  retained.set('expired', { id: 'expired', state: 'failed', expiry: 0 });
  pruneTerminalJobs(retained);
  check('terminal metadata is capped at 500 and expires', retained.size <= 501 &&
    retained.has('active') && !retained.has('expired'));
  const publishing = { id: 'publishing', state: 'failed', rc: 1, error: 'failed',
    shownState: 'running', publishing: true, expiry: 0 };
  check('job view hides terminal state and result during publication',
    JSON.stringify(jobView(publishing)) === '{"state":"running","rc":null,"error":""}');
  check('job view exposes terminal state and result after publication',
    JSON.stringify(jobView({ ...publishing, publishing: false })) ===
      '{"state":"failed","rc":1,"error":"failed"}');
  const publishingRetained = new Map([[publishing.id, publishing], ...Array.from({ length: 501 }, (_, id) =>
    [id, { id, state: 'completed', expiry: Date.now() + 600_000 }])]);
  pruneTerminalJobs(publishingRetained);
  check('publishing job survives expiry and terminal metadata cap pruning',
    publishingRetained.has(publishing.id) && publishingRetained.size === 500);
  const file = path.join(root, 'atomic');
  let attempts = 0;
  const faultEnv = process.env.LUNA_DAEMON_TEST_RENAME_FAILURES;
  try {
    // This environment-controlled fault hook is installed only by --self-test[-unit].
    process.env.LUNA_DAEMON_TEST_RENAME_FAILURES = '2';
    renameFault = () => {
      attempts++;
      const remaining = Number(process.env.LUNA_DAEMON_TEST_RENAME_FAILURES);
      if (remaining) {
        if (remaining > 0) process.env.LUNA_DAEMON_TEST_RENAME_FAILURES = String(remaining - 1);
        throw Object.assign(new Error('simulated busy reader'), { code: 'EPERM' });
      }
    };
    check('EPERM rename retries with backoff', await atomicWrite(file, 'retry') && attempts === 3 &&
      readFileSync(file, 'utf8') === 'retry');
    process.env.LUNA_DAEMON_TEST_RENAME_FAILURES = '-1';
    check('busy rename falls back to direct target write', await atomicWrite(file, 'fallback') &&
      readFileSync(file, 'utf8') === 'fallback' && !existsSync(`${file}.tmp`));
    renameFault = null;
    check('filesystem write failure is contained', !await atomicWrite(path.join(root, 'missing', 'out'), 'x'));
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => atomicWrite(file, `v${i}`)));
    check('atomicWrite serialises concurrent writes per file', concurrent.every(Boolean) &&
      readFileSync(file, 'utf8') === 'v19');
    const fresh = path.join(root, 'before-rename');
    let prepared = false;
    const preparedWrite = await atomicWrite(fresh, 'prepared', { beforeRename: (temp) => {
      prepared = temp === `${fresh}.tmp` && existsSync(temp) && !existsSync(fresh);
    } });
    check('atomicWrite beforeRename runs on the temp file before the target appears', preparedWrite && prepared);
    for (let i = 0; i < 500; i++) event(`ordered burst ${i}`);
    await flushEvents();
    const burst = readFileSync(testLog, 'utf8').split('\n').filter((line) => line.includes('ordered burst '));
    check('event log preserves call order under burst', burst.length === 500 &&
      burst.every((line, i) => line.endsWith(`ordered burst ${i}`)));
    const unitLog = testLog;
    testLog = root; // A directory: appends fail with EISDIR.
    event('lost one');
    event('lost two');
    await flushEvents();
    testLog = unitLog;
    event('after loss');
    await flushEvents();
    check('failed event batches are reported once writes resume',
      /event log: lost 2 lines to write errors\n.*after loss/.test(readFileSync(testLog, 'utf8')));
    event('before drop');
    const bufferedBytes = eventBytes;
    eventBytes = 4 * 1024 * 1024;
    try {
      for (let i = 0; i < 3; i++) event(`dropped call ${i}`);
    } finally { eventBytes = bufferedBytes; }
    await flushEvents();
    event('after drop');
    await flushEvents();
    const dropLog = readFileSync(testLog, 'utf8');
    const dropNotices = dropLog.match(/event log: dropped \d+ lines/g) || [];
    const beforeDrop = dropLog.indexOf('before drop');
    const dropNotice = dropLog.indexOf('event log: dropped 3 lines');
    check('event drop notice keeps call order', beforeDrop >= 0 && dropNotice > beforeDrop &&
      dropLog.indexOf('after drop') > dropNotice && dropNotices.length === 1 &&
      dropNotices[0] === 'event log: dropped 3 lines' && !dropLog.includes('dropped call '));
    for (let i = 0; i < 2200; i++) event(`rotation ${i} ${'x'.repeat(1024)}`);
    event('rotation last line');
    await flushEvents();
    check('event log rotates above 2 MiB', statSync(testLog).size <= 1.1 * 1024 * 1024 &&
      readFileSync(testLog, 'utf8').includes('rotation last line'));
    let responsive = false;
    for (let attempt = 0; attempt < 3 && !responsive; attempt++) {
      let lastTick = Date.now();
      let maxLag = 0;
      const lagTimer = setInterval(() => {
        const now = Date.now();
        maxLag = Math.max(maxLag, now - lastTick - 10);
        lastTick = now;
      }, 10);
      let responsiveWrites;
      const responsiveFiles = Array.from({ length: 200 }, (_, i) => path.join(root, `responsive-${i}`));
      try {
        responsiveWrites = await Promise.all(responsiveFiles.map((target) =>
          atomicWrite(target, 'x'.repeat(64 * 1024))));
        await sleep(10);
      } finally {
        clearInterval(lagTimer);
        await Promise.all(responsiveFiles.map((target) => unlink(target).catch(() => {})));
      }
      responsive = responsiveWrites.every(Boolean) && maxLag < 250;
      if (!responsive) {
        process.stderr.write(`responsiveness attempt ${attempt + 1}: maxLag=${maxLag}ms ` +
          `writes=${responsiveWrites.filter(Boolean).length}/${responsiveWrites.length}\n`);
      }
    }
    check('event loop stays responsive during writes', responsive);
    const server = Object.create(AppServer.prototype);
    Object.assign(server, { dead: false, nextId: 1, pending: new Map(), lateThreads: new Set(), send() {},
      crash() { throw new Error('RPC timeout must not crash'); } });
    for (const method of ['thread/start', 'turn/start', 'turn/interrupt', 'thread/unsubscribe',
      'account/rateLimits/read']) {
      let error;
      try { await server.rpc(method, {}, 5); } catch (caught) { error = caught; }
      check(`${method} timeout is local`, error?.message === `${method} timed out` && server.pending.size === 0);
    }
    const cleanup = [];
    server.send = (frame) => {
      cleanup.push(frame);
      queueMicrotask(() => server.message({ id: frame.id, result: {} }));
    };
    server.message({ id: 1, result: { thread: { id: 'late-unit' } } });
    await sleep(0);
    check('late thread/start response is unsubscribed without a turn', cleanup.length === 1 &&
      cleanup[0].method === 'thread/unsubscribe' && cleanup[0].params.threadId === 'late-unit');
    const { EventEmitter } = await import('node:events');
    let clock = 0;
    let launches = 0;
    let kills = 0;
    let killed;
    let fake;
    const helperNotes = [];
    const helper = new MemoryHelper(() => {
      launches++;
      fake = new EventEmitter();
      return fake;
    }, () => { kills++; return new Promise((resolve) => { killed = resolve; }); },
    (line) => helperNotes.push(line), () => clock, 20);
    helper.tick(1);
    helper.tick(1);
    helper.tick(1);
    check('memory helper has at most one child across ticks', launches === 1 &&
      helperNotes.filter((line) => line.includes('skipped')).length === 2);
    await sleep(40);
    helper.tick(1);
    check('memory helper kills on deadline and excludes overlap during tree kill', kills === 1 && launches === 1);
    killed();
    await sleep(0);
    helper.tick(1);
    check('memory helper timeout doubles the base interval and backs off', helper.interval === 120_000 &&
      helper.next === 120_000 && launches === 1 && helperNotes.some((line) => line.includes('killed')));
    for (let i = 0; i < 4; i++) {
      clock = helper.next;
      helper.tick(1);
      fake.emit('exit', 1);
    }
    check('memory helper failure backoff is capped at ten minutes', helper.interval === 600_000);
    clock = helper.next;
    helper.tick(1);
    fake.emit('exit', 0);
    check('memory helper success resets the base interval', helper.interval === 60_000 && !helper.active);
    const lock = daemonLock(() => {}, path.join(root, 'admit.lock'));
    const peer = daemonLock(() => {}, path.join(root, 'admit.lock'));
    check('shared admission lock is nonblocking and exclusive', lock.acquire() && !peer.acquire());
    lock.release();
    check('shared admission lock releases for next caller', peer.acquire());
    peer.release();
  } finally {
    renameFault = null;
    await flushEvents();
    testLog = null;
    if (faultEnv === undefined) delete process.env.LUNA_DAEMON_TEST_RENAME_FAILURES;
    else process.env.LUNA_DAEMON_TEST_RENAME_FAILURES = faultEnv;
  }
}

async function selfTest(unitOnly = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'luna-daemon-test-'));
  const processes = new Set();
  const instances = [];
  const auditPath = path.join(root, 'audit.jsonl');
  let passed = 0;
  let failed = 0;
  let serial = 0;
  const check = (name, condition) => {
    if (condition) passed++; else failed++;
    process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${name}\n`);
  };
  const until = async (predicate, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await predicate();
      if (result) return result;
      await sleep(50);
    }
    throw new Error('self-test wait timed out');
  };
  const audit = () => {
    try { return readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  function launch(instance) {
    const output = openSync(path.join(instance.home, `launcher-${serial++}.log`), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], {
      env: instance.env, stdio: ['ignore', output, output], windowsHide: true
    });
    closeSync(output);
    processes.add(child);
    (instance.children ||= []).push(child);
    child.on('error', (error) => { child.launchError = error; });
    return child;
  }
  async function aliveExit(current) {
    const started = Date.now();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--alive'], {
      env: current.env, stdio: 'ignore', windowsHide: true
    });
    processes.add(child);
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        check(`--alive finishes within two seconds (exit ${code})`, Date.now() - started < 2000);
        resolve(code);
      });
    });
  }
  async function instance(idleS = 0, overrides = {}) {
    const home = path.join(root, `instance-${serial++}`);
    mkdirSync(home);
    const current = {
      home,
      env: {
        ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
        LUNA_DAEMON_HOME: home, LUNA_DAEMON_MAX: '2', LUNA_DAEMON_IDLE_S: String(idleS),
        LUNA_KEEP_SESSION: '0', LUNA_ADMIT_LOCK: path.join(home, 'admit.lock'), LUNA_RAM_RESERVE_MB: '0',
        LUNA_DAEMON_TURN_MB: '0', LUNA_DAEMON_RAMP_MS: '10', LUNA_DAEMON_OWNER_MAX: '0',
        LUNA_DAEMON_LIMITS_POLL_S: '300', LUNA_STUB_LIMITS_FAIL_READ: '',
        LUNA_LOW_PRIORITY: '0', LUNA_JOB_TEMP: '1',
        LUNA_STUB_LIMITS_NOTIFY_DURING_READ: '', LUNA_CODEX_SHELL_PATH: '',
        ...overrides,
        LUNA_DAEMON_APP_SERVER_CMD: JSON.stringify([
          process.execPath, path.join(HERE, 'lib', 'luna-daemon-stub.mjs'), auditPath
        ])
      }
    };
    instances.push(current);
    return current;
  }
  const infoFor = (current) => {
    try { return JSON.parse(readFileSync(path.join(current.home, 'daemon.json'), 'utf8')); } catch { return null; }
  };
  async function ready(current) {
    const info = await until(async () => {
      const launchError = current.children?.find((child) => child.launchError)?.launchError;
      if (launchError) throw launchError;
      const value = infoFor(current);
      const live = value && await health(value);
      if (!live && current.children?.every((child) => child.exitCode !== null)) {
        throw new Error('daemon launchers exited before publishing discovery');
      }
      return live ? value : null;
    });
    current.info = info;
    return info;
  }
  const counts = async (info) => (await httpJson(info, 'GET', '/health')).body.jobs;
  const result = async (info, id) => (await httpJson(info, 'GET', `/jobs/${id}`)).body;
  const finished = (info, id) => until(async () => {
    const job = await result(info, id);
    return terminal(job) ? job : null;
  });
  async function submit(info, prompt, extras = {}) {
    const out = path.join(root, `out-${serial++}.md`);
    const body = {
      prompt, cwd: root, sandbox: 'read-only', model: 'gpt-6-luna', effort: 'max', tier: 'default',
      out, log: `${out}.log`, idleMaxS: 0, timeoutS: 0, ...extras
    };
    const response = await httpJson(info, 'POST', '/jobs', body);
    if (response.status !== 200) throw new Error(JSON.stringify(response));
    return { ...body, id: response.body.id };
  }
  async function cancel(info, job) {
    return httpJson(info, 'POST', `/jobs/${job.id}/cancel`);
  }
  function streamingRequest(info, authenticated, options = {}) {
    return new Promise((resolve, reject) => {
      let responding = false;
      const req = request({ hostname: '127.0.0.1', port: info.port, method: 'POST', path: options.route || '/jobs',
        headers: { ...(authenticated ? { 'X-Luna-Token': info.token } : {}), ...options.headers } }, (res) => {
        responding = true;
        if (res.headers.connection !== 'close') reject(new Error('early rejection must close the connection'));
        res.resume();
        res.on('end', () => { resolve(res.statusCode); req.destroy(); });
        res.on('error', reject);
      });
      req.on('error', (error) => {
        if (responding) return;
        reject(new Error(`streaming POST ${options.route || '/jobs'}: ${error.message}`));
      });
      req.setTimeout(3000, () => req.destroy(new Error('early rejection timed out')));
      req.flushHeaders();
      // Leave the body open: rejection must not wait for EOF or JSON parsing.
      if (options.body !== undefined) req.end(options.body);
      else if (authenticated) req.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    });
  }
  try {
    await unitChecks(root, check);
    if (unitOnly) {
      process.stdout.write(`daemon unit-test: passed=${passed} failed=${failed}\n`);
      return failed ? 1 : 0;
    }
    const main = await instance();
    check('--alive returns 2 for a temporary home without discovery', await aliveExit(main) === 2);
    const staleTemp = path.join(main.home, 'tmp', 'daemon-2147483647');
    const liveTemp = path.join(main.home, 'tmp', `daemon-${process.pid}`);
    mkdirSync(staleTemp, { recursive: true });
    mkdirSync(liveTemp, { recursive: true });
    // A stale discovery record is replaced while two launchers contend for the mkdir lock.
    writeFileSync(path.join(main.home, 'daemon.json'), JSON.stringify({
      pid: 2147483647, port: 1, token: '0'.repeat(32), version: 1
    }));
    check('--alive returns 1 for dead discovery in a temporary home', await aliveExit(main) === 1);
    const first = launch(main);
    const second = launch(main);
    const info = await ready(main);
    await until(() => first.exitCode === 73 || second.exitCode === 73, 45_000);
    const initialHealth = await health(info);
    check('--alive returns 0 for a live daemon in a temporary home', await aliveExit(main) === 0);
    check('double start and stale discovery: one healthy daemon / app-server',
      [first.pid, second.pid].includes(info.pid) && initialHealth.appServerPid &&
      audit().filter((entry) => entry.event === 'spawn').length === 1);
    check('authenticated health', initialHealth.ok && initialHealth.jobs.running === 0 &&
      initialHealth.appServer === 'up');
    if (process.platform === 'win32') {
      check('daemon and app-server keep inherited CPU priority by default',
        os.getPriority(info.pid) === os.getPriority(process.pid) &&
        os.getPriority(initialHealth.appServerPid) === os.getPriority(process.pid));
    } else process.stdout.write('SKIP Windows CPU priority assertion (not win32)\n');
    const daemonTemp = path.join(main.home, 'tmp', `daemon-${info.pid}`);
    const defaultSpawn = audit().find((entry) => entry.event === 'spawn' &&
      entry.pid === initialHealth.appServerPid);
    check('app-server receives dedicated TEMP/TMP/TMPDIR', existsSync(daemonTemp) &&
      [defaultSpawn.temp, defaultSpawn.tmp, defaultSpawn.tmpdir].every((value) => value === daemonTemp));
    check('startup removes dead daemon TEMP and preserves live PID TEMP',
      !existsSync(staleTemp) && existsSync(liveTemp));
    await sleep(200);
    const discoveryBefore = readFileSync(path.join(main.home, 'daemon.json'));
    const logBefore = readFileSync(path.join(main.home, 'daemon.log'));
    const spawnsBefore = audit().filter((entry) => entry.event === 'spawn').length;
    const duplicateLauncher = launch(main);
    await until(() => duplicateLauncher.exitCode !== null);
    const refusalLog = path.join(main.home, `launcher-${serial - 1}.log`);
    check('live discovery refuses duplicate before touching discovery/log or starting app-server',
      duplicateLauncher.exitCode === 73 && readFileSync(refusalLog, 'utf8').includes('another daemon is alive') &&
      discoveryBefore.equals(readFileSync(path.join(main.home, 'daemon.json'))) &&
      logBefore.equals(readFileSync(path.join(main.home, 'daemon.log'))) &&
      audit().filter((entry) => entry.event === 'spawn').length === spawnsBefore);
    const reusedPid = await instance();
    const unusedPortServer = createServer();
    await new Promise((resolve) => unusedPortServer.listen(0, '127.0.0.1', resolve));
    const unusedPort = unusedPortServer.address().port;
    await new Promise((resolve) => unusedPortServer.close(resolve));
    writeFileSync(path.join(reusedPid.home, 'daemon.json'), JSON.stringify({
      ...info, pid: process.pid, port: unusedPort,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }));
    check('--alive rejects a live non-daemon PID', await aliveExit(reusedPid) === 1);
    launch(reusedPid);
    const reusedInfo = await ready(reusedPid);
    check('live non-daemon PID in stale discovery does not prevent startup', reusedInfo.pid !== process.pid);
    await httpJson(reusedInfo, 'POST', '/stop');
    const reusedTemp = path.join(reusedPid.home, 'tmp', `daemon-${reusedInfo.pid}`);
    await until(() => !existsSync(reusedTemp));
    check('daemon removes its dedicated TEMP on shutdown', !existsSync(reusedTemp));
    const inheritedTemp = path.join(root, 'inherited-temp');
    mkdirSync(inheritedTemp);
    const lowPriority = await instance(0, {
      LUNA_LOW_PRIORITY: '1', LUNA_JOB_TEMP: '0',
      TEMP: inheritedTemp, TMP: inheritedTemp, TMPDIR: inheritedTemp
    });
    launch(lowPriority);
    const lowInfo = await ready(lowPriority);
    const lowHealth = await health(lowInfo);
    const lowSpawn = audit().find((entry) => entry.event === 'spawn' && entry.pid === lowHealth.appServerPid);
    check('LUNA_JOB_TEMP=0 preserves inherited TEMP/TMP/TMPDIR',
      [lowSpawn.temp, lowSpawn.tmp, lowSpawn.tmpdir].every((value) => value === inheritedTemp) &&
      !existsSync(path.join(lowPriority.home, 'tmp', `daemon-${lowInfo.pid}`)));
    if (process.platform === 'win32') {
      check('LUNA_LOW_PRIORITY=1 lowers only app-server CPU priority',
        os.getPriority(lowInfo.pid) === os.getPriority(process.pid) &&
        os.getPriority(lowHealth.appServerPid) === os.constants.priority.PRIORITY_BELOW_NORMAL);
    }
    await httpJson(lowInfo, 'POST', '/stop');
    const initialSpawn = audit().find((entry) => entry.event === 'spawn' && entry.pid === initialHealth.appServerPid);
    check('default shell omits custom build keys and reports binary and shell in discovery and health',
      !initialSpawn.args.some((arg) => /^(default_shell|default_shell_path|allow_login_shell)=/.test(arg)) &&
      info.codexBin === process.execPath && initialHealth.codexBin === info.codexBin &&
      info.shell === 'default' && initialHealth.shell === 'default');
    const blockHookAbsent = (await httpJson(info, 'POST', '/test/block?ms=10')).status === 404;
    check('missing token is 401', (await httpJson(info, 'GET', '/health', undefined, '')).status === 401);
    check('wrong token is 401', (await httpJson(info, 'GET', '/health', undefined, 'a'.repeat(32))).status === 401);
    check('danger-full-access is 400', (await httpJson(info, 'POST', '/jobs', {
      sandbox: 'danger-full-access'
    })).status === 400);
    check('missing cwd is 400', (await httpJson(info, 'POST', '/jobs', {
      sandbox: 'read-only', cwd: path.join(root, 'missing-cwd')
    })).status === 400);
    check('relative output is 400', (await httpJson(info, 'POST', '/jobs', {
      sandbox: 'read-only', cwd: root, out: 'relative.md', log: path.join(root, 'relative.log')
    })).status === 400);
    check('body over 2 MB rejected', (await httpJson(info, 'POST', '/jobs', {
      prompt: 'x'.repeat(2 * 1024 * 1024)
    })).status === 413);
    let oversizedFailures = 0;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await httpJson(info, 'POST', '/jobs', { prompt: 'x'.repeat(2 * 1024 * 1024) });
        if (response.status !== 413) oversizedFailures++;
      } catch { oversizedFailures++; }
    }
    check('full 2 MB body rejected by declared size is answered, never reset (x30)', oversizedFailures === 0);
    let unauthorizedFailures = 0;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await httpJson(info, 'POST', '/jobs', {
          prompt: 'x'.repeat(2 * 1024 * 1024)
        }, 'b'.repeat(32));
        if (response.status !== 401) unauthorizedFailures++;
      } catch { unauthorizedFailures++; }
    }
    check('full 2 MB body with a wrong token is answered 401, never reset (x30)', unauthorizedFailures === 0);
    check('unauthenticated request rejected before reading unfinished body',
      await streamingRequest(info, false) === 401);
    check('chunked body over 2 MB rejected before EOF / JSON parse', await streamingRequest(info, true) === 413);
    check('unknown route rejects an unfinished body with 404',
      await streamingRequest(info, true, { route: '/unknown' }) === 404);
    check('unknown job rejects an unfinished body with 404',
      await streamingRequest(info, true, { route: '/jobs/abcdef/cancel' }) === 404);
    check('declared oversized body is rejected before EOF with 413',
      await streamingRequest(info, true, { headers: { 'Content-Length': 3 * 1024 * 1024 } }) === 413);
    check('malformed JSON is flushed with 400 and connection close',
      await streamingRequest(info, true, { body: '{' }) === 400);
    const simple = await submit(info, 'hello');
    const complete = await finished(info, simple.id);
    check('job completes rc=0 and writes output / atomic marker / command and agent log',
      complete.state === 'completed' && complete.rc === 0 &&
      readFileSync(simple.out, 'utf8') === 'answer hello' &&
      readFileSync(`${simple.out}.daemon`, 'utf8').includes('state=completed\n') &&
      /item\/started type=commandExecution/.test(readFileSync(simple.log, 'utf8')) &&
      readFileSync(simple.log, 'utf8').includes('item/commandExecution/outputDelta streaming output') &&
      readFileSync(simple.log, 'utf8').includes('codex\nanswer hello'));
    await until(() => audit().some((entry) => entry.method === 'thread/unsubscribe'));
    check('finished thread unsubscribed', audit().some((entry) => entry.method === 'thread/unsubscribe'));
    const failure = await submit(info, 'FAIL');
    const failedJob = await finished(info, failure.id);
    check('turn failure preserves final answer and error', failedJob.rc === 1 && failedJob.error === 'fake failure' &&
      readFileSync(failure.out, 'utf8') === 'answer FAIL');
    await until(async () => (await counts(info)).running === 0);
    const one = await submit(info, 'WAIT first');
    check('output conflict is flushed with 409 and connection close',
      await streamingRequest(info, true, { body: JSON.stringify(one) }) === 409);
    const two = await submit(info, 'WAIT second', {
      model: 'gpt-6.1-sol', sandbox: 'workspace-write', tier: 'fast', ephemeral: false
    });
    const three = await submit(info, 'WAIT third');
    const four = await submit(info, 'WAIT fourth');
    await until(async () => (await counts(info)).queued === 2);
    const queued = await counts(info);
    check('max=2 queues excess jobs', queued.running === 2 && queued.queued === 2 &&
      readFileSync(`${three.out}.daemon`, 'utf8').startsWith('state=queued\n'));
    await until(() => audit().some((entry) => entry.method === 'turn/start' && entry.params.model === 'gpt-6.1-sol'));
    const sol = audit().find((entry) => entry.method === 'turn/start' && entry.params.model === 'gpt-6.1-sol');
    const solThread = audit().find((entry) => entry.method === 'thread/start' && entry.params.model === 'gpt-6.1-sol');
    check('mixed models, tier and write sandbox remain per job', sol.params.serviceTier === 'fast' &&
      solThread.params.sandbox === 'workspace-write' && solThread.params.approvalPolicy === 'never' &&
      solThread.params.ephemeral === false);
    await cancel(info, one);
    await until(async () => (await result(info, three.id)).state === 'running');
    check('cancel interrupts, returns 130 and releases FIFO slot', (await finished(info, one.id)).rc === 130 &&
      (await result(info, four.id)).state === 'queued' &&
      audit().some((entry) => entry.method === 'turn/interrupt'));
    await cancel(info, four);
    check('queued cancel removes work', (await finished(info, four.id)).state === 'cancelled');
    await cancel(info, two);
    await cancel(info, three);
    await until(async () => (await counts(info)).running === 0);
    const slow = await submit(info, 'SLOW_START');
    await until(() => audit().some((entry) => entry.method === 'turn/start' &&
      entry.params.input[0].text === 'SLOW_START'));
    await cancel(info, slow);
    await until(async () => (await counts(info)).running === 0);
    check('cancel during pending turn/start leaves no orphan slot', (await finished(info, slow.id)).rc === 130);
    const crash = await submit(info, 'CRASH');
    const peer = await submit(info, 'WAIT crash peer');
    const queuedCrash = await submit(info, 'WAIT crash queued');
    const crashedJob = await finished(info, crash.id);
    check('app-server crash fails running and queued jobs', crashedJob.error === 'app-server exited (7)' &&
      (await finished(info, peer.id)).state === 'failed' && (await finished(info, queuedCrash.id)).state === 'failed');
    const degradedHealth = await health(info);
    check('health reports app-server down after crash while daemon remains available',
      degradedHealth.ok === true && degradedHealth.appServer === 'down' && degradedHealth.appServerPid === null);
    const recovery = await submit(info, 'recovery');
    const recoveredResult = await finished(info, recovery.id);
    const recoveredHealth = await health(info);
    check('next submission lazily respawns app-server', recoveredResult.rc === 0 &&
      recoveredHealth.appServerPid !== initialHealth.appServerPid && recoveredHealth.appServer === 'up');
    const crash2 = await submit(info, 'CRASH two');
    await finished(info, crash2.id);
    const crash3 = await submit(info, 'CRASH three');
    await finished(info, crash3.id);
    const loop = await submit(info, 'must fail');
    check('third crash rejects new work with crash loop',
      (await finished(info, loop.id)).error === 'app-server crash loop');
    await until(() => !existsSync(path.join(main.home, 'daemon.json')));
    check('crash loop exits and removes discovery', !existsSync(path.join(main.home, 'daemon.json')));

    const shellPath = path.join(root, 'busybox shell.exe');
    writeFileSync(shellPath, 'stub shell');
    const managedRoot = path.join(root, 'managed codex package');
    const customShell = await instance(0, {
      LUNA_CODEX_SHELL_PATH: shellPath, CODEX_MANAGED_PACKAGE_ROOT: managedRoot, CODEX_MANAGED_BY_NPM: '1'
    });
    launch(customShell);
    const customInfo = await ready(customShell);
    const customHealth = await health(customInfo);
    const customSpawn = audit().find((entry) => entry.event === 'spawn' && entry.pid === customHealth.appServerPid);
    const shellArgs = ['default_shell="sh"', `default_shell_path=${JSON.stringify(shellPath)}`,
      'allow_login_shell=false'];
    check('busybox shell passes all three custom build arguments exactly once',
      shellArgs.every((arg) => customSpawn.args.filter((value) => value === arg).length === 1 &&
        customSpawn.args[customSpawn.args.indexOf(arg) - 1] === '-c') &&
      customSpawn.args.includes('thread_unload_delay_secs=0'));
    check('busybox shell is reported in discovery and health with the binary',
      customInfo.shell === 'busybox-sh' && customHealth.shell === 'busybox-sh' &&
      customInfo.codexBin === process.execPath && customHealth.codexBin === customInfo.codexBin);
    check('app-server inherits managed package environment',
      customSpawn.managedPackageRoot === managedRoot && customSpawn.managedByNpm === '1');
    await httpJson(customInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(customShell.home, 'daemon.json')));

    const limitsFor = (current) => {
      try { return JSON.parse(readFileSync(path.join(current.home, 'codex-limits.json'), 'utf8')); }
      catch { return null; }
    };
    const limitsReads = (pid) => audit().filter((entry) =>
      entry.pid === pid && entry.method === 'account/rateLimits/read');
    const quota = await instance();
    launch(quota);
    const quotaInfo = await ready(quota);
    const quotaPid = (await health(quotaInfo)).appServerPid;
    const startLimits = await until(() => limitsFor(quota));
    check('start writes limits in the daemon home with ISO windows and no account or token',
      Object.keys(startLimits).join(',') ===
        'v,at,source,planType,ordinaryUsageAllowed,reached,primary,secondary,byLimitId' &&
      startLimits.v === 1 && startLimits.source === 'start' && Number.isFinite(Date.parse(startLimits.at)) &&
      startLimits.planType === 'plus' && startLimits.ordinaryUsageAllowed === false && startLimits.reached === null &&
      JSON.stringify(startLimits.primary) ===
        '{"usedPercent":12,"windowMins":300,"resetsAt":"2033-05-18T03:33:20.000Z"}' &&
      JSON.stringify(startLimits.secondary) === '{"usedPercent":34,"windowMins":10080,"resetsAt":null}' &&
      JSON.stringify(startLimits.byLimitId.codex) === JSON.stringify({
        name: 'Codex', primary: startLimits.primary, secondary: startLimits.secondary, reached: null
      }) && JSON.stringify(startLimits.byLimitId.fast) === JSON.stringify({
        name: 'Fast', primary: null, secondary: null, reached: 'rate_limit_reached'
      }) && !/accountId|accessToken|private|credits/.test(JSON.stringify(startLimits)));
    const limitsHttp = await httpJson(quotaInfo, 'GET', '/limits');
    check('authenticated limits returns the persisted snapshot', limitsHttp.status === 200 &&
      JSON.stringify(limitsHttp.body) === JSON.stringify(startLimits));
    check('limits rejects missing and wrong tokens',
      (await httpJson(quotaInfo, 'GET', '/limits', undefined, '')).status === 401 &&
      (await httpJson(quotaInfo, 'GET', '/limits', undefined, 'a'.repeat(32))).status === 401);
    check('start makes one cheap limits read', limitsReads(quotaPid).length === 1 &&
      JSON.stringify(limitsReads(quotaPid)[0].params) === '{"excludeResetCreditDetails":true}');
    const quotaFirst = await submit(quotaInfo, 'limits first turn');
    await finished(quotaInfo, quotaFirst.id);
    await until(() => limitsFor(quota)?.source === 'turn');
    check('completed turn refreshes limits', limitsReads(quotaPid).length === 2);
    const pushed = await submit(quotaInfo, 'LIMITS_NOTIFY');
    const pushedLimits = await until(() => {
      const value = limitsFor(quota);
      return value?.source === 'notify' && value.primary?.usedPercent === 23 ? value : null;
    });
    await finished(quotaInfo, pushed.id);
    check('notification writes directly and preserves sparse metadata and other buckets',
      limitsReads(quotaPid).length === 2 && pushedLimits.primary.resetsAt === '2033-05-18T03:34:20.000Z' &&
      pushedLimits.planType === 'plus' && pushedLimits.ordinaryUsageAllowed === false &&
      pushedLimits.secondary.usedPercent === 34 && pushedLimits.byLimitId.codex.primary.usedPercent === 23 &&
      pushedLimits.byLimitId.fast.name === 'Fast');
    const emptyPush = await submit(quotaInfo, 'LIMITS_NOTIFY_EMPTY');
    await finished(quotaInfo, emptyPush.id);
    await until(() => limitsReads(quotaPid).length >= 3 && limitsFor(quota)?.primary?.usedPercent === 12);
    check('notification without a snapshot refetches limits', limitsReads(quotaPid).length === 3 &&
      limitsFor(quota).source === 'notify');
    for (let i = 0; i < 3; i++) {
      await finished(quotaInfo, (await submit(quotaInfo, `limits throttled ${i}`)).id);
    }
    check('repeated completed turns within 60 seconds do not read again',
      limitsReads(quotaPid).length === 3 && Date.now() - limitsReads(quotaPid)[1].at < 60_000);
    await httpJson(quotaInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(quota.home, 'daemon.json')));

    const racing = await instance(0, { LUNA_STUB_LIMITS_NOTIFY_DURING_READ: '1' });
    launch(racing);
    const racingInfo = await ready(racing);
    const racingLimits = await until(() => {
      const value = limitsFor(racing);
      return value?.source === 'notify' && value.planType === 'plus' ? value : null;
    });
    check('notification during a read retains newer windows and fills account metadata',
      racingLimits.primary.usedPercent === 23 && racingLimits.ordinaryUsageAllowed === false &&
      racingLimits.secondary.usedPercent === 34 && racingLimits.byLimitId.codex.name === 'Codex' &&
      limitsReads((await health(racingInfo)).appServerPid).length === 1);
    await httpJson(racingInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(racing.home, 'daemon.json')));

    const polling = await instance(0, { LUNA_DAEMON_LIMITS_POLL_S: '1', LUNA_STUB_LIMITS_FAIL_READ: 'running' });
    launch(polling);
    const pollingInfo = await ready(polling);
    const pollingPid = (await health(pollingInfo)).appServerPid;
    await until(() => limitsFor(polling));
    const pollingJob = await submit(pollingInfo, 'WAIT limits read failure');
    await until(() => readFileSync(`${pollingJob.out}.daemon`, 'utf8').includes('turn=turn-'));
    const initialLimits = limitsFor(polling);
    await until(() => readFileSync(path.join(polling.home, 'daemon.log'), 'utf8')
      .includes('limits poll failed: fake limits read failure'));
    check('failed poll keeps last snapshot and running job healthy',
      JSON.stringify(limitsFor(polling)) === JSON.stringify(initialLimits) &&
      (await result(pollingInfo, pollingJob.id)).state === 'running' &&
      (await health(pollingInfo)).appServerPid === pollingPid);
    const failedRead = audit().find((entry) => entry.pid === pollingPid && entry.event === 'limits-failure').read;
    await until(() => limitsReads(pollingPid).length > failedRead && limitsFor(polling)?.source === 'poll');
    const pollReads = limitsReads(pollingPid).slice(failedRead - 2, failedRead + 1);
    check('poll interval is respected without retrying failed reads early',
      pollReads[1].at - pollReads[0].at >= 1000 && pollReads[2].at - pollReads[1].at >= 1000 &&
      pollReads.every((entry) => JSON.stringify(entry.params) === '{"excludeResetCreditDetails":true}'));
    check('peer completes normally after failed limits read',
      (await finished(pollingInfo, (await submit(pollingInfo, 'limits failure peer')).id)).rc === 0 &&
      (await result(pollingInfo, pollingJob.id)).state === 'running');
    await httpJson(pollingInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(polling.home, 'daemon.json')));
    const stoppedReads = limitsReads(pollingPid).length;
    await sleep(1100);
    check('polling stops with the app-server', limitsReads(pollingPid).length === stoppedReads);

    const noLimits = await instance(0, { LUNA_STUB_LIMITS_FAIL_READ: 'all' });
    launch(noLimits);
    const noLimitsInfo = await ready(noLimits);
    const noLimitsPid = (await health(noLimitsInfo)).appServerPid;
    await until(() => readFileSync(path.join(noLimits.home, 'daemon.log'), 'utf8')
      .includes('limits start failed: fake limits read failure'));
    check('limits returns 404 before any successful snapshot',
      (await httpJson(noLimitsInfo, 'GET', '/limits')).status === 404 && !limitsFor(noLimits));
    for (let i = 0; i < 3; i++) {
      check(`limits read failure leaves job ${i} successful`,
        (await finished(noLimitsInfo, (await submit(noLimitsInfo, `limits unavailable ${i}`)).id)).rc === 0);
    }
    check('failed turn reads also obey the 60 second throttle', limitsReads(noLimitsPid).length === 2);
    await httpJson(noLimitsInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(noLimits.home, 'daemon.json')));

    const idle = await instance(1);
    launch(idle);
    await ready(idle);
    await until(() => !existsSync(path.join(idle.home, 'daemon.json')));
    check('idle exit removes discovery', !existsSync(path.join(idle.home, 'daemon.json')));
    const stop = await instance();
    launch(stop);
    const stopInfo = await ready(stop);
    const stoppedJob = await submit(stopInfo, 'WAIT stop');
    await until(() => readFileSync(`${stoppedJob.out}.daemon`, 'utf8').includes('turn=turn-'));
    await httpJson(stopInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(stop.home, 'daemon.json')));
    check('graceful stop fails running turn and cleans discovery',
      readFileSync(`${stoppedJob.out}.daemon`, 'utf8').includes('error=daemon stopped\n'));

    const detached = await instance();
    const launcherCode = [
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,${JSON.stringify([fileURLToPath(import.meta.url), '--serve'])},`,
      '{env:process.env,detached:true,windowsHide:true,stdio:"ignore"});',
      'child.unref();'
    ].join('');
    const launcher = spawn(process.execPath, ['-e', launcherCode], {
      env: detached.env, stdio: 'ignore', windowsHide: true
    });
    processes.add(launcher);
    await until(() => launcher.exitCode !== null);
    const detachedInfo = await ready(detached);
    check('detached daemon survives launcher exit', launcher.exitCode === 0 && !!await health(detachedInfo));
    await httpJson(detachedInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(detached.home, 'daemon.json')));

    const degradedTest = await instance(0, { LUNA_DAEMON_RPC_TIMEOUT_MS: '1000' });
    launch(degradedTest);
    const degradedInfo = await ready(degradedTest);
    const beforeDegraded = await health(degradedInfo);
    const streaming = await submit(degradedInfo, 'WAIT_STREAM survivor');
    await until(() => readFileSync(streaming.log, 'utf8').includes('still streaming'));
    const lateThread = await submit(degradedInfo, 'late-thread never turns', { model: 'late-thread' });
    check('thread/start timeout has distinct no-turn error',
      (await finished(degradedInfo, lateThread.id)).error === 'thread-start-timeout');
    await until(() => audit().some((entry) => entry.pid === beforeDegraded.appServerPid &&
      entry.method === 'thread/unsubscribe' && entry.params.threadId === 'thread-3'));
    check('late thread id is unsubscribed and never starts a turn', !audit().some((entry) =>
      entry.pid === beforeDegraded.appServerPid && entry.method === 'turn/start' &&
      entry.params.threadId === 'thread-3'));
    const hanging = await submit(degradedInfo, 'hang-thread never turns', { model: 'hang-thread' });
    check('second consecutive thread/start timeout is also safe to replay',
      (await finished(degradedInfo, hanging.id)).error === 'thread-start-timeout');
    const duringDegraded = await health(degradedInfo);
    check('health exposes degraded and a numeric event-loop p99', duringDegraded.degraded === true &&
      Number.isFinite(duringDegraded.loopDelayMs) && duringDegraded.loopDelayMs >= 0 &&
      duringDegraded.appServerPid === beforeDegraded.appServerPid);
    const startsBefore = audit().filter((entry) => entry.pid === beforeDegraded.appServerPid &&
      entry.method === 'thread/start').length;
    const immediateAt = Date.now();
    const immediate = await submit(degradedInfo, 'degraded immediate', { sandbox: 'workspace-write' });
    check('degraded submissions fail immediately without thread/start',
      (await finished(degradedInfo, immediate.id)).error === 'thread-start-timeout' &&
      Date.now() - immediateAt < 1000 && audit().filter((entry) => entry.pid === beforeDegraded.appServerPid &&
        entry.method === 'thread/start').length === startsBefore);
    const streamBytes = statSync(streaming.log).size;
    await until(() => statSync(streaming.log).size > streamBytes);
    check('running jobs keep streaming during degraded mode', (await result(degradedInfo, streaming.id)).state ===
      'running' && (await health(degradedInfo)).appServerPid === beforeDegraded.appServerPid);
    await cancel(degradedInfo, streaming);
    await until(async () => {
      const current = await health(degradedInfo);
      return current && !current.degraded && current.appServerPid !== beforeDegraded.appServerPid;
    });
    check('app-server recycles after running reaches zero and degraded clears',
      (await finished(degradedInfo, (await submit(degradedInfo, 'healthy again')).id)).rc === 0);
    const degradedLog = readFileSync(path.join(degradedTest.home, 'daemon.log'), 'utf8');
    check('degraded transitions and recycle are logged', degradedLog.includes('degraded on:') &&
      degradedLog.includes('app-server recycle:') && degradedLog.includes('degraded off:'));
    await httpJson(degradedInfo, 'POST', '/stop');

    const local = await instance(0, { LUNA_DAEMON_RPC_TIMEOUT_MS: '1000', LUNA_DAEMON_LOG_MAX_BYTES: '512' });
    launch(local);
    const localInfo = await ready(local);
    const localPid = (await health(localInfo)).appServerPid;
    const badLog = await submit(localInfo, 'WAIT bad-log');
    await until(() => readFileSync(`${badLog.out}.daemon`, 'utf8').includes('turn=turn-'));
    unlinkSync(badLog.log);
    mkdirSync(badLog.log);
    await cancel(localInfo, badLog);
    const badOut = await submit(localInfo, 'DELAY:300 bad-out');
    unlinkSync(badOut.out);
    mkdirSync(badOut.out);
    check('job log/output write failures leave daemon and peer healthy',
      (await finished(localInfo, badOut.id)).rc === 1 &&
      (await finished(localInfo, (await submit(localInfo, 'fs peer')).id)).rc === 0 &&
      (await health(localInfo)).appServerPid === localPid);
    for (const [prompt, extras] of [
      ['thread timeout', { model: 'hang-thread' }], ['RPC_TIMEOUT', {}],
      ['WAIT cleanup', { model: 'hang-unsubscribe' }], ['WAIT interrupt', { model: 'hang-interrupt' }]
    ]) {
      const problem = await submit(localInfo, prompt, extras);
      await until(() => readFileSync(`${problem.out}.daemon`, 'utf8').includes('state=running'));
      const peerJob = await submit(localInfo, `peer ${prompt}`);
      if (prompt.startsWith('WAIT')) {
        await until(() => readFileSync(`${problem.out}.daemon`, 'utf8').includes('turn=turn-'));
        await cancel(localInfo, problem);
      }
      await finished(localInfo, problem.id);
      check(`${prompt} leaves peer and shared app-server alive`, (await finished(localInfo, peerJob.id)).rc === 0 &&
        (await health(localInfo)).appServerPid === localPid);
      await until(async () => (await counts(localInfo)).running === 0);
    }
    const flood = await submit(localInfo, 'FLOOD');
    await finished(localInfo, flood.id);
    const floodLog = readFileSync(flood.log, 'utf8');
    check('log cap truncates once but preserves final output',
      floodLog.split('log truncated at 512 bytes').length === 2 && Buffer.byteLength(floodLog) < 700 &&
      readFileSync(flood.out, 'utf8') === 'answer FLOOD');
    const external = await submit(localInfo, 'WAIT external log');
    await until(() => readFileSync(`${external.out}.daemon`, 'utf8').includes('turn=turn-'));
    await until(() => readFileSync(external.log, 'utf8').includes('turn start thread='));
    const externalBytes = statSync(external.log).size;
    await appendFile(external.log, 'external watchdog note\n', 'utf8');
    await until(async () => (await httpJson(localInfo, 'GET', '/jobs')).body.jobs.some((job) =>
      job.id === external.id && job.logBytes === externalBytes + Buffer.byteLength('external watchdog note\n')));
    await cancel(localInfo, external);
    check('external log append is adopted without disrupting the daemon',
      readFileSync(external.log, 'utf8').includes('external watchdog note\n') &&
      (await finished(localInfo, external.id)).state === 'cancelled' &&
      (await health(localInfo)).appServerPid === localPid);
    for (const [key, expected] of [['idleMaxS', 'no events for 1s'],
      ['timeoutS', 'exceeded total timeout 1s']]) {
      const stalled = await submit(localInfo, `WAIT ${key}`, { [key]: 1 });
      const stalledResult = await finished(localInfo, stalled.id);
      check(`server enforces ${key}`, stalledResult.state === 'stalled' && stalledResult.rc === 124 &&
        stalledResult.error === expected && (await health(localInfo)).appServerPid === localPid);
    }
    const listed = (await httpJson(localInfo, 'GET', '/jobs')).body.jobs;
    check('authenticated job list contains visibility fields without prompt/token', listed.length > 0 &&
      listed.every((job) => ['id', 'state', 'owner', 'model', 'effort', 'sandbox', 'cwd', 'clientPid',
        'queuedAt', 'startedAt', 'ageS', 'logBytes', 'reason'].every((key) => key in job)) &&
      !JSON.stringify(listed).includes(localInfo.token) && listed.every((job) => !('prompt' in job)));
    check('job list rejects wrong token', (await httpJson(localInfo, 'GET', '/jobs', undefined, '')).status === 401);
    for (const alias of ['--status', '--jobs']) {
      const status = spawnSync(process.execPath, [fileURLToPath(import.meta.url), alias], {
        env: local.env, encoding: 'utf8', windowsHide: true, timeout: 5000
      });
      check(`${alias} prints health and job table without token`, status.status === 0 &&
        status.stdout.includes('appServerPid') && status.stdout.includes('clientPid\tageS\tlogBytes') &&
        status.stdout.includes('sandbox\towner\tclientPid') && status.stdout.includes('owner\trunning\tqueued') &&
        !status.stdout.includes(localInfo.token));
    }
    await until(async () => (await counts(localInfo)).running === 0);
    const exclusive = await submit(localInfo, 'WAIT exclusive', {
      sandbox: 'workspace-write', exclusiveRepo: true, cwd: `${root}${path.sep}.`, owner: 'exclusive-owner'
    });
    await until(() => readFileSync(`${exclusive.out}.daemon`, 'utf8').includes('turn=turn-'));
    const exclusivePeer = await submit(localInfo, 'exclusive peer', {
      sandbox: 'workspace-write', owner: 'blocked-owner'
    });
    await until(() => readFileSync(`${exclusivePeer.out}.daemon`, 'utf8').includes('reason=repo'));
    check('opt-in canonical repo exclusivity permits unrelated reads',
      (await finished(localInfo, (await submit(localInfo, 'exclusive read')).id)).rc === 0 &&
      (await result(localInfo, exclusivePeer.id)).state === 'queued');
    await cancel(localInfo, exclusive);
    check('exclusive repo peer starts after owner leaves', (await finished(localInfo, exclusivePeer.id)).rc === 0);
    const parallelOne = await submit(localInfo, 'WAIT parallel one', { sandbox: 'workspace-write' });
    const parallelTwo = await submit(localInfo, 'WAIT parallel two', { sandbox: 'workspace-write' });
    await until(() => readFileSync(`${parallelTwo.out}.daemon`, 'utf8').includes('turn=turn-'));
    check('same repo writes stay parallel by default', (await counts(localInfo)).running === 2);
    await cancel(localInfo, parallelOne);
    await cancel(localInfo, parallelTwo);
    const heartbeat = await submit(localInfo, 'FLOOD_WAIT heartbeat');
    await until(() => readFileSync(heartbeat.log, 'utf8').includes('log truncated'));

    const fair = await instance();
    launch(fair);
    const fairInfo = await ready(fair);
    const ownerA = [];
    for (let i = 1; i <= 6; i++) ownerA.push(await submit(fairInfo, `WAIT owner A${i}`, { owner: 'A' }));
    await until(() => readFileSync(`${ownerA[1].out}.daemon`, 'utf8').includes('turn=turn-'));
    check('one owner can use all slots without a per-owner cap', (await counts(fairInfo)).running === 2);
    const ownerB = [];
    for (let i = 1; i <= 2; i++) ownerB.push(await submit(fairInfo, `WAIT owner B${i}`, { owner: 'B' }));
    const ownerC = await submit(fairInfo, 'WAIT owner C1', { owner: 'C' });
    const fairList = (await httpJson(fairInfo, 'GET', '/jobs')).body;
    check('job list includes owners and per-owner running/queued counts',
      fairList.jobs.every((job) => ['A', 'B', 'C'].includes(job.owner)) &&
      JSON.stringify(fairList.owners) === JSON.stringify({
        A: { running: 2, queued: 4 }, B: { running: 0, queued: 2 }, C: { running: 0, queued: 1 }
      }));
    // Keep A2 running while B/C release the other slot; owners tied at zero still use submission age.
    await cancel(fairInfo, ownerA[0]);
    await until(() => readFileSync(`${ownerB[0].out}.daemon`, 'utf8').includes('turn=turn-'));
    check('idle owner B takes a slot before A third job; equal counts favor oldest queued job',
      (await result(fairInfo, ownerA[2].id)).state === 'queued' &&
      (await result(fairInfo, ownerB[1].id)).state === 'queued' &&
      (await result(fairInfo, ownerC.id)).state === 'queued');
    await cancel(fairInfo, ownerB[0]);
    await until(() => readFileSync(`${ownerB[1].out}.daemon`, 'utf8').includes('turn=turn-'));
    check('equal running counts preserve age and FIFO within an owner',
      (await result(fairInfo, ownerA[2].id)).state === 'queued' &&
      (await result(fairInfo, ownerC.id)).state === 'queued');
    await cancel(fairInfo, ownerB[1]);
    await until(() => readFileSync(`${ownerC.out}.daemon`, 'utf8').includes('turn=turn-'));
    check('idle owner C also takes a slot before A third job',
      (await result(fairInfo, ownerA[2].id)).state === 'queued');
    await cancel(fairInfo, ownerC);
    await until(() => readFileSync(`${ownerA[2].out}.daemon`, 'utf8').includes('turn=turn-'));
    check('remaining owner reclaims all slots and keeps FIFO', (await counts(fairInfo)).running === 2 &&
      (await result(fairInfo, ownerA[3].id)).state === 'queued');
    await httpJson(fairInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(fair.home, 'daemon.json')));

    const capped = await instance(0, { LUNA_DAEMON_OWNER_MAX: '1' });
    launch(capped);
    const cappedInfo = await ready(capped);
    const cappedA = await submit(cappedInfo, 'WAIT capped A1', { owner: 'A' });
    await until(() => readFileSync(`${cappedA.out}.daemon`, 'utf8').includes('turn=turn-'));
    const cappedNext = await submit(cappedInfo, 'WAIT capped A2', { owner: 'A' });
    await until(() => readFileSync(`${cappedNext.out}.daemon`, 'utf8').includes('reason=owner'));
    const cappedB = await submit(cappedInfo, 'WAIT capped B1', { owner: 'B' });
    await until(() => readFileSync(`${cappedB.out}.daemon`, 'utf8').includes('turn=turn-'));
    check('owner cap skips capped jobs so another owner can use a free slot',
      (await counts(cappedInfo)).running === 2 && (await result(cappedInfo, cappedNext.id)).state === 'queued');
    await cancel(cappedInfo, cappedB);
    await until(async () => (await counts(cappedInfo)).running === 1);
    check('owner cap remains enforced with spare global capacity',
      (await result(cappedInfo, cappedNext.id)).state === 'queued');
    await cancel(cappedInfo, cappedA);
    await until(() => readFileSync(`${cappedNext.out}.daemon`, 'utf8').includes('turn=turn-'));
    check('owner cap releases after the prior job unloads', (await counts(cappedInfo)).running === 1);
    await httpJson(cappedInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(capped.home, 'daemon.json')));

    const bounded = await instance(0, {
      LUNA_DAEMON_MAX: '1', LUNA_DAEMON_QUEUE_MAX: '1', LUNA_DAEMON_QUEUE_BYTES: '128',
      LUNA_DAEMON_ORPHAN_GRACE_S: '0'
    });
    launch(bounded);
    const boundedInfo = await ready(bounded);
    const holder = await submit(boundedInfo, 'WAIT bounded');
    await until(() => readFileSync(`${holder.out}.daemon`, 'utf8').includes('turn=turn-'));
    const queuedLimit = await submit(boundedInfo, 'hello', { timeoutS: 1, idleMaxS: 1 });
    const rejectedBody = { ...queuedLimit, out: path.join(root, 'rejected'), log: path.join(root, 'rejected.log') };
    const rejected = await httpJson(boundedInfo, 'POST', '/jobs', rejectedBody);
    check('queued job count is bounded with retry hint', rejected.status === 429 && rejected.body.retryAfterS > 0);
    check('queue full rejects an unfinished chunked body with 429', await streamingRequest(boundedInfo, true) === 429);
    let queueFailures = 0;
    for (let i = 0; i < 20; i++) {
      try {
        const response = await httpJson(boundedInfo, 'POST', '/jobs', {
          ...rejectedBody, prompt: 'q'.repeat(256 * 1024)
        });
        if (response.status !== 429) queueFailures++;
      } catch { queueFailures++; }
    }
    check('full 256 KB body rejected by a full queue is answered 429, never reset (x20)', queueFailures === 0);
    await sleep(1200);
    check('queued watchdog clocks have not started', (await result(boundedInfo, queuedLimit.id)).state === 'queued');
    await cancel(boundedInfo, holder);
    check('queued watchdog begins at running', (await finished(boundedInfo, queuedLimit.id)).rc === 0);
    const bytesRejected = await httpJson(boundedInfo, 'POST', '/jobs', { ...rejectedBody, prompt: 'x'.repeat(129) });
    check('queued prompt bytes are bounded', bytesRejected.status === 429);
    const gone = await submit(boundedInfo, 'WAIT gone', { clientPid: 2147483647 });
    const goneQueued = await submit(boundedInfo, 'WAIT gone queued', { clientPid: 2147483647 });
    const deadResult = await finished(boundedInfo, gone.id);
    const deadQueuedResult = await finished(boundedInfo, goneQueued.id);
    check('dead clients cancel running and queued jobs', deadResult.rc === 130 && deadResult.error === 'client gone' &&
      deadQueuedResult.rc === 130 && deadQueuedResult.error === 'client gone');

    const ram = await instance(0, { LUNA_RAM_RESERVE_MB: '2147483647' });
    launch(ram);
    const ramInfo = await ready(ram);
    const ramJob = await submit(ramInfo, 'WAIT ram');
    await until(() => readFileSync(`${ramJob.out}.daemon`, 'utf8').includes('reason=ram'));
    check('daemon RAM admission keeps job queued and remains responsive',
      (await counts(ramInfo)).running === 0 && (await result(ramInfo, ramJob.id)).state === 'queued');
    await cancel(ramInfo, ramJob);

    const gated = await instance(0, { LUNA_DAEMON_RAMP_MS: '300' });
    launch(gated);
    const gatedInfo = await ready(gated);
    const externalLock = daemonLock(() => {}, path.join(gated.home, 'admit.lock'));
    try {
      externalLock.acquire();
      const blocked = await submit(gatedInfo, 'WAIT shared-lock');
      await until(() => readFileSync(`${blocked.out}.daemon`, 'utf8').includes('reason=lock'));
      check('shared admission owner blocks turn without blocking HTTP', (await counts(gatedInfo)).running === 0);
      externalLock.release();
      const rampPeer = await submit(gatedInfo, 'WAIT ramp-peer');
      await until(() => audit().some((entry) => entry.method === 'turn/start' &&
        entry.params.input[0].text === 'WAIT ramp-peer'));
      const starts = ['WAIT shared-lock', 'WAIT ramp-peer'].map((prompt) => audit().find((entry) =>
        entry.method === 'turn/start' && entry.params.input[0].text === prompt).at);
      check('admission holds ramp lock after each turn start', starts[1] - starts[0] >= 280);
      await cancel(gatedInfo, blocked);
      await cancel(gatedInfo, rampPeer);
      const fast = await submit(gatedInfo, 'DELAY:30 ramp-completed');
      const afterFast = await submit(gatedInfo, 'WAIT ramp-after-completed');
      await until(() => audit().some((entry) => entry.method === 'turn/start' &&
        entry.params.input[0].text === 'WAIT ramp-after-completed'));
      const completedStarts = ['DELAY:30 ramp-completed', 'WAIT ramp-after-completed'].map((prompt) =>
        audit().find((entry) => entry.method === 'turn/start' && entry.params.input[0].text === prompt).at);
      check('successful short turn still holds full ramp', completedStarts[1] - completedStarts[0] >= 280 &&
        (await finished(gatedInfo, fast.id)).rc === 0);
      await cancel(gatedInfo, afterFast);
    } finally { externalLock.release(); }
    await until(() => readFileSync(heartbeat.log, 'utf8').includes('heartbeat: job still running'), 35_000);
    check('truncated running job continues bounded heartbeat growth',
      readFileSync(heartbeat.log, 'utf8').includes('heartbeat: job still running') &&
      (await result(localInfo, heartbeat.id)).state === 'running');
    await cancel(localInfo, heartbeat);

    const orphans = await instance(0, {
      LUNA_DAEMON_CLIENT_CHECK_MS: '100', LUNA_DAEMON_ORPHAN_GRACE_S: '3', LUNA_DAEMON_TEST_HOOKS: '1'
    });
    launch(orphans);
    const orphanInfo = await ready(orphans);
    async function client() {
      const fakeClient = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        stdio: 'ignore', windowsHide: true
      });
      processes.add(fakeClient);
      await new Promise((resolve, reject) => {
        fakeClient.once('spawn', resolve);
        fakeClient.once('error', reject);
      });
      return fakeClient;
    }
    async function killClient(fakeClient) {
      await new Promise((resolve) => {
        fakeClient.once('exit', resolve);
        fakeClient.kill();
      });
      processes.delete(fakeClient);
    }
    const turnStarted = (job) => until(() => readFileSync(`${job.out}.daemon`, 'utf8').includes('turn=turn-'));
    const listedOrphan = (job) => until(async () =>
      (await httpJson(orphanInfo, 'GET', '/jobs')).body.jobs.some((entry) => entry.id === job.id && entry.orphaned));
    const startsFor = (prompt) => audit().filter((entry) =>
      entry.method === 'turn/start' && entry.params.input[0].text === prompt).length;
    async function orphan(prompt) {
      const fakeClient = await client();
      const job = await submit(orphanInfo, prompt, { clientPid: fakeClient.pid });
      await turnStarted(job);
      await killClient(fakeClient);
      await listedOrphan(job);
      return job;
    }

    const rejoin = await orphan('DELAY:2500 orphan');
    unlinkSync(`${rejoin.out}.daemon`);
    const rejoined = await httpJson(orphanInfo, 'POST', '/jobs', { ...rejoin, clientPid: process.pid });
    const restoredMarker = existsSync(`${rejoin.out}.daemon`);
    const rejoinResult = await finished(orphanInfo, rejoin.id);
    check('orphaned job keeps running and a resubmission reattaches to it',
      rejoined.status === 200 && rejoined.body.id === rejoin.id && rejoined.body.attached === true && restoredMarker &&
      rejoinResult.state === 'completed' && rejoinResult.rc === 0 &&
      readFileSync(rejoin.out, 'utf8') === 'answer DELAY:2500 orphan' && startsFor(rejoin.prompt) === 1);

    const mismatch = await orphan('WAIT orphan-mismatch');
    const mismatched = await httpJson(orphanInfo, 'POST', '/jobs', {
      ...mismatch, prompt: 'WAIT other', clientPid: process.pid
    });
    check('orphaned job with a different prompt still conflicts with 409', mismatched.status === 409);
    await cancel(orphanInfo, mismatch);

    const expiry = await orphan('WAIT orphan-expiry');
    const orphanSeenAt = Date.now();
    const expired = await finished(orphanInfo, expiry.id);
    check('orphan without resubmission is cancelled as client gone after the grace period',
      expired.state === 'cancelled' && expired.rc === 130 && expired.error === 'client gone' &&
      Date.now() - orphanSeenAt >= 2500);

    const done = await orphan('DELAY:600 orphan-done');
    const doneResult = await finished(orphanInfo, done.id);
    const doneOutput = readFileSync(done.out, 'utf8');
    unlinkSync(`${done.out}.daemon`);
    const doneAttach = await httpJson(orphanInfo, 'POST', '/jobs', { ...done, clientPid: process.pid });
    check('job finished while orphaned is returned to a resubmission',
      doneResult.state === 'completed' && doneAttach.status === 200 && doneAttach.body.id === done.id &&
      doneAttach.body.attached === true && (await result(orphanInfo, done.id)).state === 'completed' &&
      readFileSync(`${done.out}.daemon`, 'utf8').includes('state=completed') &&
      readFileSync(done.out, 'utf8') === doneOutput && startsFor(done.prompt) === 1);

    const duplicate = await submit(orphanInfo, 'WAIT dup', { clientPid: process.pid });
    const duplicated = await httpJson(orphanInfo, 'POST', '/jobs', duplicate);
    check('live duplicate output path still conflicts with 409', duplicated.status === 409);
    await cancel(orphanInfo, duplicate);

    await httpJson(orphanInfo, 'POST', '/test/block?ms=5000');
    check('--alive returns 0 while the live daemon event loop is frozen', await aliveExit(orphans) === 0);
    await health(orphanInfo, 6000);
    const block = await httpJson(orphanInfo, 'POST', '/test/block?ms=1500');
    const healthStarted = Date.now();
    const blockedHealth = await httpJson(orphanInfo, 'GET', '/health');
    const healthDelay = Date.now() - healthStarted;
    check('test block hook exists only with LUNA_DAEMON_TEST_HOOKS',
      block.status === 200 && block.body.ok === true && blockedHealth.status === 200 && healthDelay >= 1000 &&
      blockHookAbsent);

    const early = await instance();
    launch(early);
    const earlyInfo = await ready(early);
    const earlyClient = await client();
    const earlyJob = await submit(earlyInfo, 'DELAY:1500 early-attach', { clientPid: earlyClient.pid });
    await turnStarted(earlyJob);
    await killClient(earlyClient);
    const earlyAttach = await httpJson(earlyInfo, 'POST', '/jobs', { ...earlyJob, clientPid: process.pid });
    const earlyResult = await finished(earlyInfo, earlyJob.id);
    check('resubmission right after the client died attaches before the periodic check',
      earlyAttach.status === 200 && earlyAttach.body.id === earlyJob.id && earlyAttach.body.attached === true &&
      earlyResult.state === 'completed' && earlyResult.rc === 0);
    const diedClient = await client();
    const diedJob = await submit(earlyInfo, 'DELAY:800 died-before-completion', { clientPid: diedClient.pid });
    await turnStarted(diedJob);
    await killClient(diedClient);
    await finished(earlyInfo, diedJob.id);
    const diedAttach = await httpJson(earlyInfo, 'POST', '/jobs', { ...diedJob, clientPid: process.pid });
    check('job that completed after its client died (before any periodic check) is reattached, not rerun',
      diedAttach.status === 200 && diedAttach.body.id === diedJob.id && diedAttach.body.attached === true &&
      startsFor(diedJob.prompt) === 1);
    const seenJob = await submit(earlyInfo, 'DELAY:300 seen-result', { clientPid: process.pid });
    await finished(earlyInfo, seenJob.id);
    const rerun = await httpJson(earlyInfo, 'POST', '/jobs', { ...seenJob, clientPid: process.pid });
    check('identical resubmission after a normally finished job runs fresh',
      rerun.status === 200 && rerun.body.id !== seenJob.id && rerun.body.attached !== true);
    if (rerun.status === 200) await finished(earlyInfo, rerun.body.id);
    await httpJson(earlyInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(early.home, 'daemon.json')));

    const noPid = await orphan('WAIT orphan-nopid');
    const noPidAttach = await httpJson(orphanInfo, 'POST', '/jobs', { ...noPid, clientPid: 0 });
    check('reattach without a client pid does not attach', noPidAttach.status === 409);
    await cancel(orphanInfo, noPid);

    const late = await orphan('WAIT orphan-late');
    const lateSeenAt = Date.now();
    await until(() => Date.now() - lateSeenAt >= 3200);
    const lateAttach = await httpJson(orphanInfo, 'POST', '/jobs', { ...late, clientPid: process.pid });
    const lateResult = await finished(orphanInfo, late.id);
    check('expired orphan is not revived by a late resubmission',
      !(lateAttach.body.attached === true && lateAttach.body.id === late.id) &&
      lateResult.state === 'cancelled' && lateResult.error === 'client gone');
    if (lateAttach.status === 200) await cancel(orphanInfo, { id: lateAttach.body.id });

    // Queue the short turn so the liveness tick observes its dead client before it can complete.
    const pairHolders = await Promise.all(['WAIT pair-holder-1', 'WAIT pair-holder-2']
      .map((prompt) => submit(orphanInfo, prompt, { clientPid: process.pid })));
    await Promise.all(pairHolders.map(turnStarted));
    const pairClient = await client();
    const pair = await submit(orphanInfo, 'DELAY:400 orphan-pair', { clientPid: pairClient.pid });
    await killClient(pairClient);
    await listedOrphan(pair);
    await Promise.all(pairHolders.map((job) => cancel(orphanInfo, job)));
    const pairResult = await finished(orphanInfo, pair.id);
    const pairBody = { ...pair, clientPid: process.pid };
    const pairAttaches = await Promise.all([
      httpJson(orphanInfo, 'POST', '/jobs', pairBody), httpJson(orphanInfo, 'POST', '/jobs', pairBody)
    ]);
    pairAttaches.push(await httpJson(orphanInfo, 'POST', '/jobs', pairBody));
    check('two identical resubmissions of a completed orphan share its id',
      pairResult.state === 'completed' && pairAttaches.every((response) => response.status === 200 &&
        response.body.id === pair.id && response.body.attached === true) && startsFor(pair.prompt) === 1);
    await httpJson(orphanInfo, 'POST', '/stop');
    await until(() => !existsSync(path.join(orphans.home, 'daemon.json')));
  } catch (error) {
    check(`self-test exception: ${error.stack || error.message}`, false);
    for (const current of instances) {
      for (const name of readdirSync(current.home).filter((name) => name.endsWith('.log'))) {
        const tail = readFileSync(path.join(current.home, name), 'utf8').trim().split('\n').slice(-8).join('\n');
        if (tail) process.stderr.write(`${name}:\n${tail}\n`);
      }
    }
  } finally {
    for (const current of instances) {
      const info = infoFor(current) || current.info;
      if (!info) continue;
      try { await httpJson(info, 'POST', '/stop'); } catch {}
      try { await until(() => !existsSync(path.join(current.home, 'daemon.json')), 3000); } catch {}
      try { process.kill(info.pid, 0); killTreeSync({ pid: info.pid }); } catch {}
    }
    for (const child of processes) {
      if (child.exitCode === null) killTreeSync(child);
    }
    // The only recursive deletion is our own freshly created, absolute temporary root.
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`daemon self-test: passed=${passed} failed=${failed}\n`);
  return failed ? 1 : 0;
}

try {
  const mode = process.argv[2];
  if (mode === '--serve') await serve();
  else if (mode === '--alive') {
    const info = readInfo();
    process.exitCode = info ? (await discoveryAlive(info) ? 0 : 1) : 2;
  }
  else if (mode === '--self-test' || mode === '--self-test-unit') {
    process.exitCode = await selfTest(mode === '--self-test-unit');
  }
  else if (mode === '--status' || mode === '--jobs') {
    const info = readInfo();
    const result = await health(info);
    process.stdout.write(`${JSON.stringify(result || { ok: false })}\n`);
    if (!result) process.exitCode = 1;
    else {
      const response = await httpJson(info, 'GET', '/jobs');
      const columns = ['id', 'state', 'model', 'effort', 'sandbox', 'owner', 'clientPid', 'ageS', 'logBytes',
        'queuedAt', 'startedAt', 'reason', 'cwd'];
      process.stdout.write(`${columns.join('\t')}\n`);
      for (const job of response.body.jobs) {
        const row = columns.map((key) => cleanValue(key === 'owner' ? job.owner.slice(0, 8) : job[key]));
        process.stdout.write(`${row.join('\t')}\n`);
      }
      process.stdout.write('owner\trunning\tqueued\n');
      for (const [owner, counts] of Object.entries(response.body.owners)) {
        process.stdout.write(`${owner}\t${counts.running}\t${counts.queued}\n`);
      }
    }
  } else if (mode === '--stop') {
    const info = readInfo();
    if (info && await health(info)) await httpJson(info, 'POST', '/stop');
  } else throw new Error('usage: node luna-daemon.mjs --serve|--alive|--status|--jobs|--stop|--self-test');
} catch (error) {
  process.stderr.write(`luna-daemon: ${cleanValue(error.message)}\n`);
  process.exitCode = 1;
}
