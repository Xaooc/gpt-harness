#!/usr/bin/env node
// Machine-wide Codex account leases. All mutations use the same mkdir lock as the Luna admission gate.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchingProcess, processRows, readProcess } from './lib/luna-runtime.mjs';

const home = path.resolve(process.env.HOME || os.homedir());
const run = path.join(home, '.claude', 'luna-run');
const dir = path.join(run, 'account-lease');
const lockDir = path.join(dir, 'lease.lock');
const logFile = path.join(dir, 'lease.log');
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const monotonic = () => Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
const lockLimitMs = 30_000;
const childTermGraceMs = 5000;
const defaultTtl = (mode) => mode === 'exclusive' ? 1800 : 7200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(16).toString('hex');
const safe = (text) => String(text ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const fileFor = (owner, id) => path.join(owner.directory, `${id}.json`);

function log(message) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${safe(message)}\n`, { mode: 0o600 });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

let emptyLockSeen;

function newOwner() {
  const owner = { pid: process.pid, pid_start: readProcess(process.pid)?.started,
    acquired_mono: monotonic(), boot_id: bootId, generation: token() };
  if (!owner.pid_start) throw new Error('cannot identify lease lock owner');
  owner.name = `g-${bootId.replaceAll('-', '')}-${owner.pid}-${owner.pid_start}-${owner.acquired_mono}-${owner.generation}`;
  owner.directory = path.join(lockDir, owner.name);
  return owner;
}

function ownerFromName(name) {
  const match = /^g-([a-f0-9]{32})-(\d+)-(\d+)-(\d+(?:\.\d+)?)-([a-f0-9]{32})$/.exec(name);
  if (!match) throw new Error(`invalid lease lock generation ${name}`);
  return { boot: match[1], pid: Number(match[2]), pid_start: match[3], acquired_mono: Number(match[4]),
    generation: match[5], name, directory: path.join(lockDir, name) };
}

function assertOwner(owner) {
  if (!fs.existsSync(owner.directory)) throw new Error('lease lock generation was fenced');
}

function prepareOwner(owner) {
  assertOwner(owner);
  fs.writeFileSync(path.join(owner.directory, `owner-${owner.generation}`), JSON.stringify({ pid: owner.pid,
    pid_start: owner.pid_start, acquired_mono: owner.acquired_mono, boot_id: bootId, generation: owner.generation }),
  { mode: 0o600 });
  // Old installations stored lease records at the top level. Move them under the same fence before inspecting them.
  for (const name of fs.readdirSync(dir)) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const target = path.join(owner.directory, name);
    if (fs.existsSync(target)) throw new Error(`duplicate lease record ${name}`);
    fs.renameSync(path.join(dir, name), target);
  }
  for (const name of fs.readdirSync(owner.directory)) {
    if ((name.startsWith('owner-') && name !== `owner-${owner.generation}`) || name.startsWith('released-') ||
        /^\..+\.tmp$/.test(name)) {
      try { fs.unlinkSync(path.join(owner.directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  assertOwner(owner);
}

function takeLock() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = newOwner();
  try {
    fs.statSync(lockDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Publish a complete, nonempty initial directory in one rename. A late initializer cannot replace it.
    const stage = `${lockDir}.init.${owner.generation}`;
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      fs.mkdirSync(path.join(stage, owner.name), { mode: 0o700 });
      fs.renameSync(stage, lockDir);
      prepareOwner(owner);
      return owner;
    } catch (caught) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(caught.code)) throw caught;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  let names;
  try { names = fs.readdirSync(lockDir).filter((name) => name.startsWith('g-')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!names.length) {
    emptyLockSeen ??= monotonic();
    if (monotonic() - emptyLockSeen >= lockLimitMs) {
      // rmdir succeeds only while empty; normal initializers publish an already nonempty directory.
      try { fs.rmdirSync(lockDir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
      emptyLockSeen = undefined;
    }
    return null;
  }
  emptyLockSeen = undefined;
  if (names.length !== 1) throw new Error('multiple lease lock generations');
  const current = ownerFromName(names[0]);
  const row = matchingProcess(current.pid, current.pid_start);
  const released = fs.existsSync(path.join(current.directory, `released-${current.generation}`));
  const stale = current.boot !== bootId.replaceAll('-', '') || !row || row.state === 'T' || row.state === 't' ||
    monotonic() - current.acquired_mono >= lockLimitMs;
  if (!released && !stale) return null;
  try { fs.renameSync(current.directory, owner.directory); }
  catch (error) { if (['ENOENT', 'EEXIST'].includes(error.code)) return null; throw error; }
  prepareOwner(owner);
  if (!released) log(`reclaimed stale lease lock (pid ${current.pid}, generation ${current.generation})`);
  return owner;
}

function releaseLock(owner) {
  try { fs.writeFileSync(path.join(owner.directory, `released-${owner.generation}`), '', { mode: 0o600 }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function tryLocked(fn) {
  const owner = takeLock();
  if (!owner) return { busy: true };
  try { const value = fn(owner); assertOwner(owner); return { value }; } finally { releaseLock(owner); }
}

async function locked(fn, stop = () => false) {
  while (true) {
    const owner = takeLock();
    if (owner) {
      try {
        const value = fn(owner);
        if (value && typeof value.then === 'function') throw new Error('lease lock callback must be synchronous');
        assertOwner(owner);
        return value;
      } finally { releaseLock(owner); }
    }
    if (stop()) return null;
    await sleep(25);
  }
}

function groupMembers(pid) {
  return processRows().filter((row) => row.group === pid && row.state !== 'Z');
}

function stopLeaseChild(lease, wait = false) {
  if (lease.child_pid === undefined && lease.child_pid_start === undefined) return true;
  const pid = Number(lease.child_pid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !lease.child_pid_start) return false;
  if (pid === lease.pid || pid === process.pid || readProcess(process.pid)?.group === pid) return false;
  const leader = readProcess(pid);
  if (leader && (leader.started !== lease.child_pid_start || leader.group !== pid)) {
    return groupMembers(pid).length === 0;
  }
  if (groupMembers(pid).length) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (!wait) return groupMembers(pid).length === 0;
  const deadline = monotonic() + 1500;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (groupMembers(pid).length && monotonic() < deadline) Atomics.wait(cell, 0, 0, 25);
  return groupMembers(pid).length === 0;
}

function reclaimLeaseChild(owner, lease) {
  if (lease.child_pid === undefined && lease.child_pid_start === undefined) return true;
  const pid = Number(lease.child_pid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !lease.child_pid_start) return false;
  if (pid === lease.pid || pid === process.pid || readProcess(process.pid)?.group === pid) return false;
  if (!groupMembers(pid).length) return true;
  const leader = readProcess(pid);
  // A reused or unrelated leader must never be signalled; keep excluding until its group is gone.
  if (leader && (leader.started !== lease.child_pid_start || leader.group !== pid)) return false;
  const now = monotonic();
  if (!Number.isFinite(lease.child_term_mono)) {
    assertOwner(owner);
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    lease.child_term_mono = now;
    save(owner, lease);
  } else if (now - lease.child_term_mono >= childTermGraceMs) {
    assertOwner(owner);
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return false;
}

function records(owner) {
  const result = [];
  for (const name of fs.readdirSync(owner.directory)) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const file = path.join(owner.directory, name);
    const lease = readJson(file);
    if (!lease || lease.id !== name.slice(0, -5) || !['shared', 'exclusive'].includes(lease.mode)) {
      // Never silently ignore malformed state: an administrator must inspect it.
      throw new Error(`invalid lease record ${name}`);
    }
    const holder = matchingProcess(lease.pid, lease.pid_start);
    const sameBoot = lease.boot_id === bootId;
    const reason = !sameBoot ? 'boot changed or legacy lease'
      : !holder ? 'holder is dead or pid was reused'
        : !Number.isFinite(lease.expires_mono) || lease.expires_mono <= monotonic() ? 'expired heartbeat/TTL' : '';
    if (reason) {
      if (sameBoot && !reclaimLeaseChild(owner, lease)) {
        result.push(lease); // Keep exclusion until every member of the bound group has stopped.
        continue;
      }
      fs.unlinkSync(file);
      log(`reclaimed ${lease.pending ? 'pending ' : ''}${lease.mode} ${lease.id}: ${reason}`);
    } else result.push(lease);
  }
  return result.sort((a, b) => a.started_mono - b.started_mono || a.id.localeCompare(b.id));
}

function save(owner, lease) {
  assertOwner(owner);
  const target = fileFor(owner, lease.id);
  const temp = path.join(owner.directory, `.${lease.id}.${token()}.tmp`);
  try {
    lease.generation = owner.generation;
    fs.writeFileSync(temp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    assertOwner(owner);
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

function makeLease({ mode, purpose, owner, ttl, pid = process.pid }) {
  const started = Date.now();
  const startedMono = monotonic();
  const pidStart = readProcess(pid)?.started;
  if (!pidStart) throw new Error(`cannot read holder pid ${pid}`);
  return { id: token(), mode, owner: safe(owner || process.env.CLAUDE_CODE_SESSION_ID || 'unknown'), pid,
    pid_start: pidStart, purpose: safe(purpose), started, expires: started + ttl * 1000,
    boot_id: bootId, started_mono: startedMono, expires_mono: startedMono + ttl * 1000 };
}

// A busy lock is an admission refusal, never a reason to start without a lease.
export function tryShared(options) {
  const result = tryLocked((owner) => {
    const blocking = records(owner).find((lease) => lease.mode === 'exclusive');
    if (blocking) return { blocking };
    const lease = makeLease({ ...options, mode: 'shared', ttl: options.ttl || defaultTtl('shared') });
    save(owner, lease);
    log(`acquired shared ${lease.id} ${lease.purpose}`);
    return { lease };
  });
  return result.busy ? { busy: true } : result.value;
}

export async function releaseLease(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('invalid lease id');
  while (true) {
    const released = await locked((owner) => {
      const file = fileFor(owner, id);
      const lease = readJson(file);
      if (!lease) return false;
      const stale = lease.boot_id === bootId && (!matchingProcess(lease.pid, lease.pid_start) ||
        !Number.isFinite(lease.expires_mono) || lease.expires_mono <= monotonic());
      if (stale && !reclaimLeaseChild(owner, lease)) return null;
      fs.unlinkSync(file);
      log(`released ${lease.pending ? 'pending ' : ''}${lease.mode} ${id} ${lease.purpose}`);
      return true;
    });
    if (released !== null) return released;
    await sleep(100);
  }
}

export async function bindLeaseChild(lease, pid) {
  const child = readProcess(pid);
  if (!child || child.state === 'Z' || child.group !== pid) return false;
  const start = child.started;
  return locked((owner) => {
    const current = readJson(fileFor(owner, lease.id));
    if (!current || current.boot_id !== bootId || current.expires_mono <= monotonic() ||
        !matchingProcess(current.pid, current.pid_start)) return false;
    current.child_pid = pid;
    current.child_pid_start = start;
    save(owner, current);
    Object.assign(lease, { child_pid: pid, child_pid_start: start });
    return true;
  });
}

async function transferLease(id, from, to) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id || '')) return null;
  return locked((owner) => {
    const lease = readJson(fileFor(owner, id));
    if (!lease || lease.mode !== 'shared' || lease.pending || lease.pid !== from.pid ||
        lease.pid_start !== from.pid_start || lease.boot_id !== bootId || lease.expires_mono <= monotonic() ||
        !matchingProcess(from.pid, from.pid_start) ||
        !matchingProcess(to.pid, to.pid_start)) return null;
    lease.pid = to.pid;
    lease.pid_start = to.pid_start;
    lease.expires = Date.now() + defaultTtl('shared') * 1000;
    lease.expires_mono = monotonic() + defaultTtl('shared') * 1000;
    delete lease.child_pid;
    delete lease.child_pid_start;
    save(owner, lease);
    return lease;
  });
}

export async function refreshLease(id, ttl, shouldRefresh = () => true) {
  return locked((owner) => {
    const lease = readJson(fileFor(owner, id));
    if (!shouldRefresh() || !lease || lease.boot_id !== bootId || !matchingProcess(lease.pid, lease.pid_start) ||
        lease.expires_mono <= monotonic()) return false;
    lease.expires = Date.now() + ttl * 1000;
    lease.expires_mono = monotonic() + ttl * 1000;
    save(owner, lease);
    return true;
  });
}

export function heartbeat(lease, ttl = defaultTtl(lease.mode), onLost = () => {}) {
  let active = true;
  let refreshing = false;
  const timer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      if (!await refreshLease(lease.id, ttl, () => active) && active) onLost(new Error('lease expired or was removed'));
    } catch (error) {
      if (active) onLost(error);
    } finally { refreshing = false; }
  }, Math.min(60_000, Math.max(100, Math.floor(ttl * 1000 / 3))));
  timer.unref();
  return () => { active = false; clearInterval(timer); };
}

function daemonHealth(info, route = '/account-idle') {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port: info.port, path: route,
      headers: { 'X-Luna-Token': info.token, Connection: 'close' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode === 404 && route === '/account-idle') {
          void daemonHealth(info, '/health').then(resolve);
          return;
        }
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || data.pid !== info.pid) { resolve(false); return; }
          if (typeof data.idle === 'boolean') resolve(data.idle);
          else resolve(Number.isInteger(data.jobs?.running) && data.jobs.running === 0);
        } catch { resolve(false); }
      });
      response.on('error', () => resolve(false));
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function daemonIdle() {
  const base = path.resolve(process.env.LUNA_DAEMON_HOME || run);
  for (const root of [base, path.join(base, 'daemon-net')]) {
    const discovery = path.join(root, 'daemon.json');
    const info = readJson(discovery);
    if (!info) {
      if (fs.existsSync(discovery)) return false;
      continue;
    }
    if (!matchingProcess(info.pid, info.pid_start)) continue;
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string') {
      return false;
    }
    if (!await daemonHealth(info)) return false;
  }
  return true;
}

function exclusiveReady(active, lease) {
  const others = active.filter((item) => item.id !== lease.id);
  const earlier = others.some((item) => item.mode === 'exclusive' && item.pending &&
    (item.started_mono < lease.started_mono || (item.started_mono === lease.started_mono && item.id < lease.id)));
  return !earlier && !others.some((item) => !item.pending);
}

function codexProcesses(rows = processRows()) {
  const found = [];
  try {
    // The shared process helper deliberately excludes pid 1 from signal targets; scanning must include it.
    const stat = fs.readFileSync('/proc/1/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    rows.unshift({ pid: 1, state: fields[0], group: Number(fields[2]), started: fields[19] });
  } catch {}
  for (const row of rows) {
    if (row.state === 'Z') continue;
    try {
      const argv = fs.readFileSync(`/proc/${row.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const exe = fs.readlinkSync(`/proc/${row.pid}/exe`).replace(/ \(deleted\)$/, '');
      // The sandbox launcher shares the Codex executable but does not use the account itself.
      if (path.basename(argv[0] || '') === 'codex-linux-sandbox') continue;
      const executable = path.basename(exe) === 'codex' || path.basename(argv[0] || '') === 'codex';
      const script = path.basename(argv[1] || '') === 'codex' ||
        /(?:^|\/)@openai\/codex\/bin\/codex\.js$/.test(argv[1] || '');
      if (executable || script) found.push({ ...row, cmd_head: safe(argv.join(' ')).slice(0, 240) });
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return found;
}

function unmanagedCodex(active) {
  const rows = processRows();
  const { groups, pids } = managedDaemonProcesses(rows);
  for (const lease of active) {
    if (lease.pending || !lease.child_pid || !matchingProcess(lease.pid, lease.pid_start)) continue;
    const child = matchingProcess(lease.child_pid, lease.child_pid_start);
    if (child?.group === lease.child_pid) groups.add(lease.child_pid);
  }
  return codexProcesses(rows).filter((row) => !groups.has(row.group) && !matchingProcess(row.pid, pids.get(row.pid)));
}

function managedDaemonProcesses(rows) {
  const groups = new Set();
  const pids = new Map();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const base = path.resolve(process.env.LUNA_DAEMON_HOME || run);
  for (const root of [base, path.join(base, 'daemon-net')]) {
    const info = readJson(path.join(root, 'daemon.json'));
    if (!info || !matchingProcess(info.pid, info.pid_start)) continue;
    const server = matchingProcess(info.appServerPid, info.appServerStart);
    if (!server || server.ppid !== info.pid || server.group !== server.pid) continue;
    groups.add(server.pid);
    const pending = [server.pid];
    while (pending.length) {
      const pid = pending.pop();
      if (pids.has(pid)) continue;
      pids.set(pid, byPid.get(pid)?.started);
      pending.push(...(children.get(pid) || []));
    }
  }
  return { groups, pids };
}

export async function acquire(options) {
  const { mode, purpose, ttl = defaultTtl(mode), wait = 1800, onWait = () => {} } = options;
  const lease = makeLease({ ...options, ttl });
  const holder = { pid: lease.pid, pid_start: lease.pid_start };
  const deadline = monotonic() + wait * 1000;
  const expired = () => options.shouldAbort?.() || monotonic() >= deadline;
  let pending = false;
  let stopPendingHeartbeat;
  let nextProcessCheck = 0;
  let lastUnmanaged = [];
  try {
    while (true) {
      let result = await locked((owner) => {
        const active = records(owner);
        if (mode === 'exclusive') {
          if (!pending) {
            lease.pending = true;
            lease.pid = process.pid;
            lease.pid_start = readProcess(process.pid)?.started;
            save(owner, lease);
            pending = true;
            stopPendingHeartbeat = heartbeat(lease, ttl);
            log(`pending exclusive ${lease.id} ${purpose}`);
            active.push(lease);
          } else if (!active.some((item) => item.id === lease.id)) {
            stopPendingHeartbeat?.();
            pending = false;
            return { waiting: true };
          }
          if (monotonic() >= nextProcessCheck) {
            lastUnmanaged = unmanagedCodex(active);
            nextProcessCheck = monotonic() + 500;
          }
          const current = active.find((item) => item.id === lease.id);
          const first = lastUnmanaged[0];
          const note = first ? `waiting: unmanaged codex pid ${first.pid} ${first.cmd_head}` : '';
          if ((current.waiting || '') !== note) {
            if (note) current.waiting = note;
            else delete current.waiting;
            save(owner, current);
          }
          if (note) return { waiting: true, note };
          return exclusiveReady(active, lease) ? { checkDaemon: true } : { waiting: true };
        }
        const blocking = active.find((item) => item.mode === 'exclusive');
        if (blocking) return { waiting: true, blocking };
        lease.started = Date.now();
        lease.expires = lease.started + ttl * 1000;
        lease.started_mono = monotonic();
        lease.expires_mono = lease.started_mono + ttl * 1000;
        save(owner, lease);
        log(`acquired shared ${lease.id} ${purpose}`);
        return { lease };
      }, expired);
      if (!result) return null;
      if (result.checkDaemon && await daemonIdle()) {
        // The pending record prevents new daemon turns while the unlocked health check is in flight.
        result = await locked((owner) => {
          const active = records(owner);
          const current = active.find((item) => item.id === lease.id);
          if (!current) {
            stopPendingHeartbeat?.();
            pending = false;
            return { waiting: true };
          }
          if (!exclusiveReady(active, lease)) return { waiting: true };
          const unmanaged = unmanagedCodex(active);
          if (unmanaged.length) {
            const first = unmanaged[0];
            const note = `waiting: unmanaged codex pid ${first.pid} ${first.cmd_head}`;
            if (current.waiting !== note) { current.waiting = note; save(owner, current); }
            return { waiting: true, note };
          }
          Object.assign(lease, current);
          delete lease.pending;
          delete lease.waiting;
          Object.assign(lease, holder);
          lease.started = Date.now();
          lease.expires = lease.started + ttl * 1000;
          lease.started_mono = monotonic();
          lease.expires_mono = lease.started_mono + ttl * 1000;
          save(owner, lease);
          stopPendingHeartbeat?.();
          pending = false;
          log(`acquired exclusive ${lease.id} ${purpose}`);
          return { lease };
        }, expired);
        if (!result) return null;
      }
      if (result.lease) return result.lease;
      onWait(result.blocking, result.note);
      if (expired()) return null;
      await sleep(Math.min(100, Math.max(0, deadline - monotonic())));
    }
  } finally {
    stopPendingHeartbeat?.();
    if (pending && lease.pending) await releaseLease(lease.id);
  }
}

function parseOptions(args) {
  const result = {};
  while (args.length && args[0] !== '--') {
    const key = args.shift();
    if (!['--mode', '--purpose', '--ttl', '--wait', '--owner', '--report'].includes(key) || !args.length) {
      throw new Error(`invalid option ${key}`);
    }
    result[key.slice(2)] = args.shift();
  }
  if (!['shared', 'exclusive'].includes(result.mode) || !safe(result.purpose)) {
    throw new Error('--mode shared|exclusive and --purpose are required');
  }
  for (const key of ['ttl', 'wait']) {
    if (result[key] === undefined) continue;
    if (!/^\d+$/.test(result[key]) || !Number.isSafeInteger(Number(result[key])) ||
        (key === 'ttl' && Number(result[key]) < 1)) throw new Error(`invalid --${key}`);
    result[key] = Number(result[key]);
  }
  return result;
}

async function sampleIntrusions(lease) {
  const rows = processRows();
  const { groups, pids } = managedDaemonProcesses(rows);
  const found = codexProcesses(rows)
    .filter((row) => row.group !== lease.child_pid && !groups.has(row.group) && !matchingProcess(row.pid, pids.get(row.pid)));
  if (!found.length) return null;
  return locked((owner) => {
    const current = readJson(fileFor(owner, lease.id));
    if (!current || current.pending || current.pid !== lease.pid || current.pid_start !== lease.pid_start) {
      throw new Error('exclusive lease was lost while sampling');
    }
    const known = new Set((current.intrusions || []).map((item) => `${item.pid}:${item.start}`));
    const added = [];
    for (const row of found) {
      if (known.has(`${row.pid}:${row.started}`)) continue;
      const intrusion = { pid: row.pid, start: row.started, cmd_head: row.cmd_head, first_seen: new Date().toISOString() };
      known.add(`${row.pid}:${row.started}`);
      added.push(intrusion);
    }
    if (added.length) {
      current.intrusions = [...(current.intrusions || []), ...added];
      save(owner, current);
      for (const item of added) log(`intrusion exclusive ${lease.id} pid ${item.pid} ${item.cmd_head}`);
    }
    return current.intrusions || [];
  });
}

function writeReport(file, intrusions, samplingErrors) {
  const target = path.resolve(file);
  const temp = `${target}.${process.pid}.${token()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ intrusions, sampling_errors: samplingErrors })}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

async function runCommand(options, command) {
  let child;
  let signal;
  let killTimer;
  const forward = (name) => {
    signal ||= name;
    if (child?.pid) {
      try { process.kill(-child.pid, name); } catch {}
      killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    }
  };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => [name, () => forward(name)]));
  for (const [name, handler] of handlers) process.on(name, handler);
  let lease;
  let stopHeartbeat;
  let parentTimer;
  let intrusionTimer;
  let sampling = Promise.resolve();
  let samplingStarted = false;
  let intrusions = [];
  const samplingErrors = [];
  const sample = () => {
    sampling = sampling.then(async () => { intrusions = await sampleIntrusions(lease) || intrusions; }).catch((error) => {
      samplingErrors.push(error.message);
    });
    return sampling;
  };
  let releaseSafe = true;
  const inheritedId = process.env.LUNA_LEASE_INHERIT_ID;
  const parent = inheritedId ? { pid: Number(process.env.LUNA_LEASE_WRAPPER_PID),
    pid_start: process.env.LUNA_LEASE_WRAPPER_START } : null;
  const self = { pid: process.pid, pid_start: readProcess(process.pid)?.started };
  try {
    if (inheritedId && options.mode !== 'shared') throw new Error('inherited lease must be shared');
    lease = inheritedId ? await transferLease(inheritedId, parent, self)
      : await acquire({ ...options, shouldAbort: () => Boolean(signal) });
    if (!lease) {
      if (inheritedId) process.stderr.write('account-lease: cannot transfer wrapper lease\n');
      return signal ? 128 + os.constants.signals[signal] : 75;
    }
    if (parent) {
      parentTimer = setInterval(() => { if (!matchingProcess(parent.pid, parent.pid_start)) forward('SIGTERM'); }, 1000);
      parentTimer.unref();
    }
    if (signal) return 128 + os.constants.signals[signal];
    stopHeartbeat = heartbeat(lease, options.ttl || defaultTtl(options.mode), (error) => {
      process.stderr.write(`account-lease: heartbeat lost: ${error.message}\n`);
      forward('SIGTERM');
    });
    // The helper waits for IPC before starting the command, so a killed runner cannot leave an unrecorded child.
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_child'],
      { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: true });
    const result = new Promise((resolve) => {
      child.once('error', (error) => { process.stderr.write(`account-lease: ${error.message}\n`); resolve(127); });
      child.once('exit', (code, childSignal) => resolve(code ?? 128 + (os.constants.signals[childSignal] || 0)));
    });
    if (child.pid && await bindLeaseChild(lease, child.pid) && !signal) {
      if (options.mode === 'exclusive') {
        samplingStarted = true;
        await sample();
        intrusionTimer = setInterval(sample, 5000);
        intrusionTimer.unref();
      }
      child.send({ command });
    }
    else if (child.pid) forward(signal || 'SIGTERM');
    const code = await result;
    // Any background descendants still in this command's group must stop before its lease is released.
    if (lease.child_pid && groupMembers(lease.child_pid).length) {
      try { process.kill(-lease.child_pid, 'SIGKILL'); } catch {}
      if (!stopLeaseChild(lease, true)) {
        releaseSafe = false;
        throw new Error('command process group did not stop');
      }
    }
    return signal ? 128 + os.constants.signals[signal] : code;
  } finally {
    clearTimeout(killTimer);
    clearInterval(parentTimer);
    clearInterval(intrusionTimer);
    if (samplingStarted) await sample();
    stopHeartbeat?.();
    if (lease?.child_pid && groupMembers(lease.child_pid).length && !stopLeaseChild(lease, true)) releaseSafe = false;
    if (lease && releaseSafe) {
      const returned = parent && await transferLease(lease.id, self, parent);
      if (!returned) await releaseLease(lease.id);
    }
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (options.mode === 'exclusive') {
      process.stderr.write(`account-lease: intrusions ${intrusions.length}` +
        `${samplingErrors.length ? `; sampling errors ${samplingErrors.length}` : ''}\n`);
      if (options.report) {
        try { writeReport(options.report, intrusions, samplingErrors); }
        catch (error) { process.stderr.write(`account-lease: cannot write report: ${error.message}\n`); }
      }
    }
  }
}

async function runChild() {
  return new Promise((resolve) => {
    let child;
    const disconnected = () => {
      try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exitCode = 1; }
    };
    const finish = (code) => {
      process.removeListener('disconnect', disconnected);
      if (process.connected) process.disconnect();
      resolve(code);
    };
    const stop = (signal) => {
      if (child?.pid) { try { child.kill(signal); } catch {} }
      else finish(128 + os.constants.signals[signal]);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
    process.once('disconnect', disconnected);
    process.once('message', (message) => {
      if (!Array.isArray(message?.command) || !message.command.length) { finish(2); return; }
      const env = { ...process.env };
      for (const name of ['LUNA_LEASE_INHERIT_ID', 'LUNA_LEASE_WRAPPER_PID', 'LUNA_LEASE_WRAPPER_START']) {
        delete env[name];
      }
      child = spawn(message.command[0], message.command.slice(1), { stdio: 'inherit', env });
      child.once('error', (error) => { process.stderr.write(`account-lease: ${error.message}\n`); finish(127); });
      child.once('exit', (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] || 0)));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === '_child' && !args.length && process.send) return runChild();
  if (command === 'acquire' || command === 'run') {
    const options = parseOptions(args);
    if (command === 'acquire') {
      if (options.report) throw new Error('--report is only available for run');
      if (args.length) throw new Error('unexpected arguments');
      const pid = Number(process.env.LUNA_LEASE_HOLDER_PID || process.ppid);
      let note = 'waiting: account lease lock';
      const lease = await acquire({ ...options, pid, onWait: (blocking, detail) => {
        if (blocking) note = `waiting: exclusive account lease ${blocking.purpose}`;
        else if (detail) note = detail;
      } });
      if (!lease) {
        if (process.env.LUNA_LEASE_WAIT_NOTE === '1') process.stdout.write(`${note}\n`);
        return 75;
      }
      process.stdout.write(`${lease.id}\n`);
      return 0;
    }
    if (args.shift() !== '--' || !args.length) throw new Error('run requires -- <command...>');
    return runCommand(options, args);
  }
  // Internal helper for luna.sh: keep the wrapper-owned shared lease alive during a long exec.
  if (command === 'maintain' && args.length === 3 && /^[a-zA-Z0-9_-]+$/.test(args[0])) {
    const lease = await locked((owner) => readJson(fileFor(owner, args[0])));
    const holder = { pid: Number(args[1]), pid_start: args[2] };
    if (!lease || !matchingProcess(holder.pid, holder.pid_start)) return 1;
    let nextRefresh = monotonic() + 60_000;
    while (matchingProcess(holder.pid, holder.pid_start)) {
      await sleep(1000);
      if (monotonic() >= nextRefresh) {
        if (!await refreshLease(lease.id, defaultTtl(lease.mode))) {
          if (matchingProcess(holder.pid, holder.pid_start)) { try { process.kill(holder.pid, 'SIGTERM'); } catch {} }
          return 1;
        }
        nextRefresh = monotonic() + 60_000;
      }
    }
    return 0;
  }
  if (command === 'release' && args.length === 1) { await releaseLease(args[0]); return 0; }
  if (command === 'status' && (args.length === 0 || (args.length === 1 && args[0] === '--json'))) {
    const leases = await locked(records);
    if (args[0] === '--json') {
      const intrusions = leases.filter((lease) => lease.mode === 'exclusive' && !lease.pending)
        .flatMap((lease) => lease.intrusions || []);
      process.stdout.write(`${JSON.stringify({ leases, intrusions })}\n`);
    }
    else for (const lease of leases) {
      process.stdout.write(`${lease.id} ${lease.mode}${lease.pending ? ' pending' : ''} ${lease.owner} ${lease.purpose}\n`);
      if (lease.waiting) process.stdout.write(`  ${lease.waiting}\n`);
    }
    return 0;
  }
  if (command === 'pending-exclusive' && !args.length) {
    return (await locked(records)).some((lease) => lease.mode === 'exclusive') ? 0 : 1;
  }
  throw new Error('usage: account-lease.mjs acquire|release|status|run|pending-exclusive');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`account-lease: ${error.message}\n`); process.exitCode = 2; }
}
