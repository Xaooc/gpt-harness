#!/usr/bin/env node
// agy supplies quota to its documented statusLine hook, even when print mode is region-blocked.
// https://antigravity.google/docs/cli/statusline/ — no model prompt or credential access is needed.
import * as fs from 'node:fs/promises';
import {
  constants, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, statSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonAtomic } from './lib/orchestration.mjs';
import { home as userHomeDir, listProcesses, lockOwnerAlive, lockOwnerStart, platform, shell } from './lib/platform.mjs';

const cli = fileURLToPath(import.meta.url);
const AGY_ROOT = '/srv/docker/compose/antigravity-parallel';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 90_000;
const SOURCE = 'agy-statusline';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

export function quotaPaths(env = process.env) {
  const home = path.resolve(env.CONVEYOR_HOME || path.join(userHomeDir(env), '.claude', 'conveyor'));
  return { home, cache: path.join(home, 'gemini-quota.json'), lock: path.join(home, 'gemini-quota.lock') };
}

function lockOwners(lock) {
  try {
    return readdirSync(lock).filter((name) => /^owner(?:\..+)?\.json$/.test(name)).map((name) => {
      try { return { name, ...JSON.parse(readFileSync(path.join(lock, name), 'utf8')) }; }
      catch { return { name }; }
    });
  } catch { return []; }
}

export function quotaRefreshLocked(env = process.env) {
  const { lock } = quotaPaths(env), owners = lockOwners(lock);
  if (owners.some((owner) => lockOwnerAlive(owner.pid, owner.start))) return true;
  // Cover the mkdir -> owner publication gap without permanently retaining an abandoned lock.
  try { return (!owners.length || owners.some((owner) => !owner.pid || !owner.start)) &&
    Date.now() - statSync(lock).mtimeMs < 60_000; }
  catch { return false; }
}

export function acquireQuotaRefreshLock(env = process.env) {
  const { home, lock } = quotaPaths(env);
  mkdirSync(home, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (quotaRefreshLocked(env)) return null;
      // A unique owner marker prevents concurrent stale reapers from deleting a new live lock.
      // Never recursively remove this directory: rmdir must fail while any live marker exists.
      for (const owner of lockOwners(lock)) {
        if (lockOwnerAlive(owner.pid, owner.start)) return null;
        try { unlinkSync(path.join(lock, owner.name)); } catch {}
      }
      try { rmdirSync(lock); } catch { return null; }
      continue;
    }
    const owner = { pid: process.pid, start: lockOwnerStart(), nonce: randomUUID() };
    const marker = path.join(lock, `owner.${owner.nonce}.json`);
    try {
      writeFileSync(marker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } catch {
      try { unlinkSync(marker); } catch {}
      continue;
    }
    return () => {
      try { unlinkSync(path.join(lock, 'owner.json')); } catch {}
      try { unlinkSync(marker); } catch {}
      try { rmdirSync(lock); } catch {}
    };
  }
  return null;
}

// Only quota fractions are usage limits. context_window and ACP used/size are deliberately ignored.
export function parseStatuslineQuota(data, now = Date.now()) {
  const buckets = [];
  if (object(data?.quota)) {
    for (const [name, value] of Object.entries(data.quota)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(name) || !object(value) || value.disabled === true) continue;
      const fraction = value.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const bucket = { name, remainingFraction: fraction };
      let reset = iso(value.reset_time);
      if (!reset && typeof value.reset_in_seconds === 'number' && Number.isFinite(value.reset_in_seconds) &&
          value.reset_in_seconds >= 0 && value.reset_in_seconds <= 365 * 24 * 60 * 60) {
        reset = new Date(now + value.reset_in_seconds * 1000).toISOString();
      }
      if (reset) bucket.resetAt = reset;
      buckets.push(bucket);
    }
  }
  return { available: buckets.length > 0, source: SOURCE, buckets, at: new Date(now).toISOString() };
}

async function readText(file, limit = 128 * 1024, tail = false) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (!tail && stat.size > limit)) return null;
    const start = tail ? Math.max(0, stat.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(limit, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function readJson(file) {
  try { return JSON.parse(await readText(file)); } catch { return null; }
}

function snapshot(value) {
  if (!object(value) || value.source !== SOURCE || !iso(value.at) || !Array.isArray(value.buckets)) return null;
  const quota = Object.fromEntries(value.buckets.filter(object).map((bucket) => [bucket.name, {
    remaining_fraction: bucket.remainingFraction, reset_time: bucket.resetAt
  }]));
  const result = parseStatuslineQuota({ quota }, Date.parse(value.at));
  return value.available === result.available ? result : null;
}

async function names(directory) {
  try { return await fs.readdir(directory); } catch { return []; }
}

// This is an observation of exhaustion, not a percentage or a provider reset prediction.
async function exhaustionProxy(env, home, deadline) {
  const userHome = userHomeDir(env);
  const run = env.LUNA_RUN_DIR || path.join(userHome, '.claude', 'luna-run');
  const files = new Set();
  const proxy = { source: 'gem-job-statuses', lastExhaustedAt: null };
  const expired = () => {
    if (performance.now() < deadline) return false;
    proxy.incomplete = true;
    return true;
  };
  const registry = await readText(path.join(userHome, '.claude', 'learning', 'jobs.jsonl'), 4 * 1024 * 1024, true);
  for (const line of (registry || '').split('\n')) {
    if (expired()) return proxy;
    try {
      const record = JSON.parse(line);
      if (typeof record.out === 'string' && path.isAbsolute(record.out) && !record.out.includes('\0')) {
        files.add(`${record.out}.status`);
      }
    } catch {}
  }
  for (const name of await names(path.join(run, 'gem-active'))) {
    if (expired()) return proxy;
    if (!name.endsWith('.json')) continue;
    const pointer = await readJson(path.join(run, 'gem-active', name));
    if (typeof pointer?.out === 'string' && path.isAbsolute(pointer.out) && !pointer.out.includes('\0')) {
      files.add(`${pointer.out}.status`);
    }
  }
  for (const name of await names(tmpdir())) {
    if (expired()) return proxy;
    if (/^gem-out\..+\.status$/.test(name)) files.add(path.join(tmpdir(), name));
  }
  for (const file of files) {
    if (expired()) return proxy;
    const text = await readText(file);
    if (!text) continue;
    const fields = Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    if (fields.provider !== 'gemini' || fields.unavailable_reason !== 'quota') continue;
    const at = iso(fields.finished) || iso(fields.started);
    if (at && Date.parse(at) <= Date.now() && (!proxy.lastExhaustedAt || at > proxy.lastExhaustedAt)) {
      proxy.lastExhaustedAt = at;
    }
  }
  const mark = (await readJson(path.join(home, 'providers.json')))?.gemini;
  // Conveyor's retry cooldown is not the actual Google quota reset time.
  if (mark?.reason === 'quota' && iso(mark.until) && Date.parse(mark.until) > Date.now()) {
    proxy.cooldownUntil = iso(mark.until);
  }
  return proxy;
}

async function queryAgy(env, timeoutMs, overallDeadline) {
  if (platform !== 'linux') throw new Error('agy status-line quota refresh unavailable: process inspection requires Linux');
  const deadline = overallDeadline - 1500;
  if (performance.now() >= deadline) throw new Error('Quota reader overall deadline reached before starting agy');
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'gemini-quota-'));
  const capture = path.join(temporary, 'quota.json');
  let child, tracking;
  const members = new Map();
  const track = () => {
    const rows = listProcesses();
    const owned = new Set(rows.filter((row) => row.pid === child?.pid ||
      members.get(row.pid)?.started === row.started).map((row) => row.pid));
    const groups = new Set(rows.filter((row) => owned.has(row.pid)).map((row) => row.group));
    const ownGroup = rows.find((row) => row.pid === process.pid)?.group;
    groups.delete(ownGroup);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!owned.has(row.pid) && (owned.has(row.ppid) || groups.has(row.group))) {
          owned.add(row.pid);
          changed = true;
        }
      }
    }
    for (const row of rows) if (owned.has(row.pid)) members.set(row.pid, row);
  };
  const signalTree = (signal) => {
    const current = new Map(listProcesses().map((row) => [row.pid, row]));
    for (const row of [...members.values()].reverse()) {
      if (current.get(row.pid)?.started !== row.started || current.get(row.pid)?.state === 'Z') continue;
      try { process.kill(row.pid, signal); } catch {}
    }
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    let command = [path.join(AGY_ROOT, 'run-agy')];
    if (env.GEMINI_QUOTA_AGY_CMD) {
      try { command = JSON.parse(env.GEMINI_QUOTA_AGY_CMD); }
      catch { command = [env.GEMINI_QUOTA_AGY_CMD]; }
      if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
        throw new Error('GEMINI_QUOTA_AGY_CMD must be an executable path or JSON argv');
      }
    }
    const settings = { statusLine: { type: 'command', enabled: true,
      command: [process.execPath, cli, '--statusline', capture].map(quote).join(' ') } };
    const agentEnv = {
      PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      HOME: path.join(AGY_ROOT, 'data', 'home'), XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      AGY_CLI_MODEL_API_MAX_RETRIES: '1', HTTP_PROXY: 'http://127.0.0.1:10809', HTTPS_PROXY: 'http://127.0.0.1:10809',
      NO_PROXY: 'localhost,127.0.0.1,::1', TERM: 'xterm-256color', SHELL: shell()[0]
    };
    if (performance.now() >= deadline) throw new Error('Quota reader overall deadline reached before starting agy');
    // script gives agy a terminal. The hook exports structured JSON; terminal output is discarded.
    child = spawn('/usr/bin/script', ['-qef', '-E', 'never', '-c',
      [...command, '--settings', JSON.stringify(settings)].map(quote).join(' '), '/dev/null'], {
      cwd: temporary, env: agentEnv, detached: true, stdio: ['pipe', 'ignore', 'ignore']
    });
    let failed = false, exited = false, code;
    child.on('error', () => { failed = true; });
    child.on('exit', (value) => { exited = true; code = value; });
    child.stdin.on('error', () => {});
    track();
    tracking = setInterval(track, 100);
    while (performance.now() < deadline) {
      if (interrupted) throw new Error('agy quota query interrupted');
      const result = snapshot(await readJson(capture));
      if (result?.available) return result;
      if (failed) throw new Error('Cannot start /usr/bin/script for the agy status-line hook');
      if (exited) throw new Error(`agy exited before supplying quota to its status-line hook (exit ${code ?? 'signal'})`);
      await delay(100);
    }
    throw new Error(`agy status-line quota timed out (overall limit ${timeoutMs} ms, including cleanup)`);
  } finally {
    clearInterval(tracking);
    try {
      if (child?.pid) {
        track();
        signalTree('SIGTERM');
        await delay(300);
        track();
        signalTree('SIGKILL');
        const stoppedBy = performance.now() + 300;
        while (performance.now() < stoppedBy) {
          const live = listProcesses().some((row) => members.get(row.pid)?.started === row.started && row.state !== 'Z');
          if (!live) break;
          await delay(20);
          track();
          signalTree('SIGKILL');
        }
        child.stdin.destroy();
        child.unref();
      }
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function getGeminiQuota({ refresh = false, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const budget = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(TIMEOUT_MS, timeoutMs)) : TIMEOUT_MS;
  const deadline = performance.now() + budget;
  const { home, cache } = quotaPaths(env);
  const cached = await readJson(cache);
  const age = Date.now() - Date.parse(cached?.at);
  if (!refresh && age >= 0 && age < CACHE_MS) {
    const valid = snapshot(cached);
    if (valid?.available) return valid;
    if (valid && typeof cached.reason === 'string') {
      return { ...valid, reason: cached.reason,
        proxy: await exhaustionProxy(env, home, Math.min(deadline, performance.now() + 500)) };
    }
  }
  let result;
  try {
    result = await queryAgy(env, budget, deadline);
  } catch (error) {
    result = { available: false, source: SOURCE, buckets: [], at: new Date().toISOString(),
      reason: error.message, proxy: await exhaustionProxy(env, home, Math.min(deadline, performance.now() + 500)) };
  }
  try { await writeJsonAtomic(cache, result); } catch {}
  return result;
}

async function captureStatusline(file) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Status-line payload exceeds 1 MiB');
  }
  const result = parseStatuslineQuota(JSON.parse(input));
  // Empty initialization updates must not overwrite a populated quota snapshot.
  if (result.available) await writeJsonAtomic(file, result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === cli) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--statusline' && args.length === 2) await captureStatusline(args[1]);
    else {
      if (args.some((arg) => !['--json', '--refresh'].includes(arg))) {
        throw new Error('usage: gemini-quota.mjs [--json] [--refresh]');
      }
      const release = acquireQuotaRefreshLock();
      try {
        const result = release ? await getGeminiQuota({ refresh: args.includes('--refresh') })
          : await readJson(quotaPaths().cache) || { available: false, buckets: [], at: null, reason: 'refresh in progress' };
        process.stdout.write(`${JSON.stringify(result, null, args.includes('--json') ? 0 : 2)}\n`);
      } finally { release?.(); }
    }
  } catch (error) {
    process.stderr.write(`gemini-quota: ${error.message}\n`);
    process.exitCode = 1;
  }
}
