#!/usr/bin/env node
// Read the Luna collector snapshot or collect a diagnostic sample in-process.
// Usage: node luna-overview.mjs [--json | --pretty | --human] [--collect | --self-test]
import * as fs from 'node:fs/promises';
import { freemem, totalmem, homedir, tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { sameStart } from './lib/process-identity.mjs';
import { killTree } from './conveyor/lib/platform.mjs';
import { availableMemory, readProcess } from './lib/luna-runtime.mjs';
import assert from 'node:assert/strict';
import {
  mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfigWithSource, paths as orchestrationPaths, providerState, resolveChain, resolvePanel
} from './conveyor/lib/orchestration.mjs';
import { summarizeUsage, usagePaths } from './conveyor/usage.mjs';
import { quotaPaths } from './conveyor/gemini-quota.mjs';

const DEADLINE_MS = 3750;
const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const ACTIVE_LIMIT = 200;
const LEGACY_MAX_AGE_MS = 10 * 60 * 1000;
const terminal = new Set(['done', 'failed', 'incomplete', 'stalled', 'completed', 'cancelled']);
const geminiTerminal = new Set([...terminal, 'unavailable', 'stopped']);
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
const localPath = (value) => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) &&
  !value.includes('\0');

const nativeLocalPath = (value) => typeof value === 'string' && path.isAbsolute(value) &&
  !value.startsWith('//') && !value.includes('\0');

function runDirectory(claudeHome) {
  return path.resolve(process.env.LUNA_RUN_DIR || process.env.LUNA_OVERVIEW_HOME || path.join(claudeHome, 'luna-run'));
}

function snapshotFile(run) {
  return path.join(run, 'collector', 'snapshot.json');
}

function configuration(claudeHome = path.join(homedir(), '.claude'), platform = process.platform) {
  const run = runDirectory(claudeHome);
  return {
    claudeHome, platform, run, localPath: platform === 'win32' ? localPath : nativeLocalPath,
    daemon: path.resolve(process.env.LUNA_DAEMON_HOME || run),
    registry: path.join(claudeHome, 'learning', 'jobs.jsonl'),
    codexConfig: path.join(process.env.CODEX_HOME || path.join(path.dirname(claudeHome), '.codex'), 'config.toml'),
    geminiStatus: platform === 'linux' ? '/srv/docker/compose/antigravity-parallel/data/status.json' : null
  };
}

async function customBuildRoot(claudeHome) {
  if (process.env.LUNA_CUSTOM_CODEX_ROOT) return path.resolve(process.env.LUNA_CUSTOM_CODEX_ROOT);
  const env = await readText(path.join(claudeHome, 'luna-harness.env'));
  const build = env?.split(/\r?\n/).find((line) => line.startsWith('LUNA_CUSTOM_CODEX_ROOT='))
    ?.slice('LUNA_CUSTOM_CODEX_ROOT='.length);
  return path.resolve(build || path.join(path.dirname(claudeHome), 'codex-build'));
}

function empty(now = Date.now()) {
  const daemon = { running: false, appServer: null, healthy: false, degraded: false };
  return {
    v: 1, at: new Date(now).toISOString(),
    ram: { freeMb: null, totalMb: null },
    daemon, daemons: { default: daemon, net: { ...daemon } },
    jobs: [], codexLimits: null, build: null,
    sessions: [],
    orchestration: { source: null, chains: {}, panels: {}, threshold: null, marks: {}, presets: [], catalog: {}, configError: null },
    switches: [], gemini: { available: false, reason: 'orchestration unavailable', tokensToday: 0, jobsToday: 0, mcp: null,
      quota: { available: false, buckets: [], at: null } },
    usage: { ...summarizeUsage(null, now), stale: true }
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

async function readJson(file, limit) {
  try {
    const value = JSON.parse(await readText(file, limit));
    return object(value) ? value : null;
  } catch { return null; }
}

async function usageStatus(now, config) {
  const cache = await readJson(usagePaths({ ...process.env, CLAUDE_HOME_DIR: config.claudeHome }).cache);
  const usage = summarizeUsage(cache?.v === 1 ? cache : null, now);
  usage.stale = !Number.isFinite(Date.parse(usage.at)) || now - Date.parse(usage.at) > 120_000;
  return usage;
}

async function geminiQuotaStatus(now, config) {
  if (config.platform !== 'linux') {
    return { available: false, reason: 'live Gemini quota is Linux-only', buckets: [], at: null };
  }
  const cache = await readJson(quotaPaths({
    ...process.env, CONVEYOR_HOME: process.env.CONVEYOR_HOME || path.join(config.claudeHome, 'conveyor')
  }).cache);
  const age = now - Date.parse(cache?.at);
  const quota = {
    available: cache?.available === true, buckets: Array.isArray(cache?.buckets) ? cache.buckets.map((bucket) => ({
      name: string(bucket.name),
      ...(number(bucket.remainingFraction) !== null ? { remainingFraction: bucket.remainingFraction } : {}),
      ...(number(bucket.usedPercent) !== null ? { usedPercent: bucket.usedPercent } : {}),
      ...(string(bucket.resetAt) ? { resetAt: bucket.resetAt } : {})
    })) : [], at: string(cache?.at) || null,
    ...(string(cache?.reason) ? { reason: cache.reason } : {}),
    ...(string(cache?.lastExhaustedAt || cache?.proxy?.lastExhaustedAt)
      ? { lastExhaustedAt: cache.lastExhaustedAt || cache.proxy.lastExhaustedAt } : {})
  };
  if (!Number.isFinite(age) || age < 0 || age > 600_000) quota.stale = true;
  return quota;
}

async function readTail(file, limit = TAIL_BYTES) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - limit);
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
    return start ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text;
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

function jsonLines(text) {
  return (text || '').trimEnd().split(/\r?\n/).flatMap((line) => {
    try { const value = JSON.parse(line); return object(value) ? [value] : []; }
    catch { return []; }
  });
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

const identityCache = new Map();

async function cachedStart(run, pid, expected, identity = '', now = Date.now(), probe) {
  const key = JSON.stringify([run, pid, expected, identity]);
  const cached = identityCache.get(key);
  if (cached && now >= cached.at && now - cached.at < 120_000) return cached.actual;
  const actual = await probe(pid);
  if (actual) {
    identityCache.delete(key);
    identityCache.set(key, { actual, at: now });
    if (identityCache.size > 512) identityCache.delete(identityCache.keys().next().value);
  }
  return actual;
}

async function probeStarts(deadline) {
  const timeoutMs = Math.min(1500, deadline - performance.now());
  if (timeoutMs <= 0) throw new Error('PowerShell identity probe deadline exceeded');
  // One CIM query supplies all the identities needed by this sample.
  const command = 'Get-CimInstance Win32_Process | ForEach-Object {' +
    'if ($_.CreationDate) { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" } }';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  });
  let stdout = '', timedOut = false, exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => { stdout += text; });
  child.on('error', () => {});
  child.once('exit', () => { exited = true; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!exited && child.pid) {
      try { killTree(child, 'SIGKILL'); } catch {}
      child.kill('SIGKILL');
    }
    child.stdout.destroy();
  }, timeoutMs);
  let code;
  try { code = await new Promise((resolve) => child.once('close', resolve)); }
  finally { clearTimeout(timer); }
  if (timedOut) throw new Error('PowerShell identity probe timed out');
  if (code !== 0) throw new Error('PowerShell identity probe failed');
  const starts = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const fields = /^(\d+) (\d+)$/.exec(line.trim());
    if (fields) starts.set(Number(fields[1]), fields[2]);
  }
  return starts;
}

async function activeJobs(run, now, boot = Date.now() - uptime() * 1000, {
  acceptsPath = process.platform === 'win32' ? localPath : nativeLocalPath, processStart, signal
} = {}) {
  const directory = path.join(run, 'active');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const recent = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length && !signal?.aborted) {
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
    while (cursor < entries.length && !signal?.aborted) {
      const { file } = entries[cursor++];
      const text = await readText(file, 32 * 1024);
      const [out, pidLine, indexStart] = text?.split(/\r?\n/).map((line) => line.trim()) || [];
      // Validate before any access to paths supplied by the index or job data.
      if (!acceptsPath(out)) continue;
      const status = await readText(`${out}.status`, TAIL_BYTES);
      const values = status === null ? {} : statusValues(status);
      if (pidLine) {
        const pid = Number(pidLine);
        if (Number.isSafeInteger(pid) && pid > 0) {
          let live = true;
          try { process.kill(pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') live = false;
          }
          const recordedStart = indexStart || values.wrapper_start;
          if (live && recordedStart && processStart) {
            const actual = await cachedStart(run, pid, recordedStart, out, now, processStart);
            live = sameStart(actual, recordedStart);
          }
          if (!live) continue;
        }
      } else {
        let stat;
        try { stat = await fs.stat(`${out}.status`); } catch {}
        if (!stat || now - stat.mtimeMs > LEGACY_MAX_AGE_MS) continue;
      }
      if (status === null) continue;
      if (Date.parse(values.started) < boot) continue;
      let conflict = null;
      if (terminal.has(values.state)) {
        if (values.state !== 'failed' || values.engine !== 'daemon' ||
            values.error !== 'output or log already in use by another daemon job') continue;
        const markerText = await readText(`${out}.daemon`, TAIL_BYTES);
        const marker = markerText === null ? {} : statusValues(markerText);
        if (!/^[a-f0-9]{32}$/.test(marker.id || '') || !['queued', 'running'].includes(marker.state)) continue;
        conflict = { id: marker.id, profile: values.daemon_profile === 'net' ? 'net' : 'default' };
        values.state = marker.state;
        values.queue_pos = marker.queue_pos;
        values.error = '';
      }
      const queue = values.queue_pos;
      const activity = await logActivity(`${out}.log`, now, values.state || '', acceptsPath);
      jobs.push({
        out, state: values.state || '', model: values.model || '', effort: values.effort || '',
        sandbox: values.sandbox || '', engine: values.engine || '', ageS: seconds(values.started, now),
        dir: values.dir || '', error: values.error || '',
        queuePos: /^\d+$/.test(queue || '') && Number.isSafeInteger(Number(queue)) ? Number(queue) : null,
        owner: values.owner || '', idleS: activity.idleS, activity: activity.activity,
        ...(conflict ? { _conflict: conflict } : {})
      });
    }
  }));
  return jobs.sort(newest).slice(0, 40);
}

async function geminiActiveJobs(config, now, wrapperStart, signal) {
  const directory = path.join(config.run, 'gem-active');
  let names;
  try { names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).slice(0, ACTIVE_LIMIT); }
  catch { return { jobs: [], statuses: new Map() }; }
  const jobs = [], statuses = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (cursor < names.length && !signal.aborted) {
      const file = path.join(directory, names[cursor++]);
      const pointer = await readJson(file);
      if (!pointer || pointer.v !== 1 || !config.localPath(pointer.out)) continue;
      const text = await readText(`${pointer.out}.status`, TAIL_BYTES);
      if (text === null) continue;
      const values = statusValues(text);
      if (!(await wrapperStart(pointer.wrapper_pid, values.wrapper_start))) continue;
      if (values.provider !== 'gemini') continue;
      statuses.set(pointer.out, values);
      if (geminiTerminal.has(values.state)) continue;
      const stat = await fs.stat(`${pointer.out}.log`).catch(() => null);
      const idleS = stat?.isFile() ? Math.max(0, Math.floor((now - stat.mtimeMs) / 1000)) : null;
      const queued = values.state === 'queued' || string(values.state).startsWith('waiting-');
      const note = cleanText(values.last_note || '', 200);
      jobs.push({
        out: pointer.out, state: values.state || '', model: values.acp_model || '', effort: values.effort || '',
        sandbox: values.sandbox || '', engine: values.engine || '', ageS: seconds(values.started || pointer.started, now),
        dir: values.dir || '', error: values.error || '', queuePos: null, owner: values.owner || string(pointer.owner),
        idleS, activity: { kind: queued ? 'queued' : values.state === 'starting' ? 'starting' : note ? 'writing' : 'unknown',
          text: note, sinceS: idleS }, provider: 'gemini'
      });
    }
  }));
  return { jobs: jobs.sort(newest).slice(0, 40), statuses };
}

async function geminiUsage(config, now, active, signal) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const statuses = new Map((await active).statuses);
  const records = jsonLines(await readTail(config.registry, 64 * 1024 * 1024));
  const outputs = [...new Set(records.filter((record) => config.localPath(record.out) &&
    !(Date.parse(record.finished) < midnight.getTime())).map((record) => record.out))];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, outputs.length) }, async () => {
    while (cursor < outputs.length && !signal.aborted) {
      const out = outputs[cursor++];
      if (statuses.has(out)) continue;
      const text = await readText(`${out}.status`, TAIL_BYTES);
      if (text !== null) statuses.set(out, statusValues(text));
    }
  }));
  let tokensToday = 0, jobsToday = 0;
  for (const values of statuses.values()) {
    const finished = Date.parse(values.finished);
    if (values.provider !== 'gemini' || !geminiTerminal.has(values.state) ||
        !Number.isFinite(finished) || finished < midnight.getTime() || finished > now) continue;
    jobsToday++;
    tokensToday += Math.max(0, number(Number(values.usage_total)) ?? 0);
  }
  return { tokensToday, jobsToday };
}

async function geminiMcp(config) {
  if (!config.geminiStatus) return null;
  const [status, toml] = await Promise.all([readJson(config.geminiStatus), readText(config.codexConfig)]);
  if (!status) return null;
  return {
    configured: /^[ \t]*\[[ \t]*mcp_servers\.(?:antigravity-parallel|"antigravity-parallel"|'antigravity-parallel')[ \t]*\]/m
      .test(toml || ''),
    activeItems: number(status.activeItems), adaptiveLimit: number(status.adaptiveLimit),
    configuredLimit: number(status.configuredLimit), at: string(status.at) || null
  };
}

async function orchestrationStatus(snapshot, now) {
  const { config, source } = await loadConfigWithSource();
  const state = await providerState(config, { now, persist: false });
  const chains = Object.create(null), panels = Object.create(null);
  for (const tier of Object.keys(config.tiers)) {
    const resolved = await resolveChain(tier, { config, state, now });
    chains[tier] = resolved.chain.map((entry) => ({ ...entry, selected: entry === resolved.selected }));
  }
  for (const panel of Object.keys(config.panels)) {
    panels[panel] = (await resolvePanel(panel, { config, state, now })).seats;
  }
  const marks = Object.fromEntries(Object.entries(state.providers).map(([provider, mark]) => [provider, {
    until: string(mark.until) || null, reason: string(mark.reason) || null
  }]));
  snapshot.orchestration = {
    source, chains, panels, threshold: { ...config.thresholds.codex, switched: state.threshold.switched }, marks,
    presets: Object.entries(config.presets).map(([name, preset]) => ({ name, label: preset.label })),
    catalog: config.catalog, configError: null
  };
  // Resolve an availability probe even when no configured tier or panel currently uses Gemini.
  const model = config.catalog.gemini[0];
  const probe = { tiers: { gemini: [{ provider: 'gemini', model: model.model, effort: model.efforts[0] }] } };
  const entry = (await resolveChain('gemini', { config: probe, state, now })).chain[0];
  Object.assign(snapshot.gemini, { available: entry.available, reason: entry.reason });
}

async function switches() {
  const text = await readTail(orchestrationPaths().switches);
  const lines = (text || '').trimEnd().split(/\r?\n/).slice(-8).reverse().join('\n');
  return jsonLines(lines).filter((event) => ['at', 'tier', 'from', 'to', 'reason']
    .every((key) => typeof event[key] === 'string')).map(({ at, tier, from, to, reason }) => ({ at, tier, from, to, reason }));
}

function reconcileConflictJobs(jobs, daemons) {
  return jobs.filter((job) => {
    if (!job._conflict) return true;
    const live = daemons[job._conflict.profile]?.jobs?.find((item) => item.id === job._conflict.id);
    delete job._conflict;
    if (!live) {
      Object.assign(job, { model: '', effort: '', sandbox: '', owner: '', ageS: null, dir: '', error: '' });
      return true;
    }
    Object.assign(job, {
      state: live.state, model: live.model, effort: live.effort, sandbox: live.sandbox,
      owner: live.owner, ageS: live.ageS, dir: live.cwd, error: ''
    });
    return true;
  }).sort(newest);
}

async function logActivity(file, now, state = '', acceptsPath = process.platform === 'win32' ? localPath : nativeLocalPath) {
  if (!acceptsPath(file)) return missingActivity(state);
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

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function fetchJson(info, route, signal) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      headers: { 'X-Luna-Token': info.token }, signal, redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = await response.json();
    return object(value) ? value : null;
  } catch { return null; }
}

function daemonJobs(list, now) {
  if (!Array.isArray(list)) return [];
  return list.filter((job) => object(job) &&
    (job.state === 'running' || job.state === 'queued' || string(job.state).startsWith('waiting-')))
    .map((job) => ({
      id: string(job.id), state: string(job.state), model: string(job.model), effort: string(job.effort),
      sandbox: string(job.sandbox), owner: string(job.owner),
      ageS: seconds(job.queuedAt, now) ?? number(job.ageS), cwd: string(job.cwd), reason: string(job.reason),
      idleS: null, activity: { kind: job.state === 'queued' || string(job.state).startsWith('waiting-')
        ? 'queued' : 'unknown', text: job.state === 'queued' || string(job.state).startsWith('waiting-')
          ? string(job.state) : '', sinceS: null }
    })).sort(newest).slice(0, 30);
}

async function healthCollection(directory, info, health, now = Date.now(), signal) {
  const ok = health?.ok === true;
  const file = path.join(directory, 'daemon-health.json');
  const lock = `${file}.lock`;
  const owner = path.join(lock, String(process.pid));
  const deadline = Date.now() + 500;
  let locked = false;
  // As with the daemon's mkdir lock, only a dead owner or an old empty lock is reclaimed.
  while (!locked && !signal?.aborted) {
    try {
      mkdirSync(lock);
      writeFileSync(owner, '');
      locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) break;
      try {
        const owners = readdirSync(lock);
        if (owners.length === 1 && /^[1-9]\d*$/.test(owners[0])) {
          try { process.kill(Number(owners[0]), 0); }
          catch (cause) { if (cause.code === 'ESRCH') unlinkSync(path.join(lock, owners[0])); }
        }
        if (owners.length || Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  let state;
  try {
    const previous = await readJson(file);
    const same = previous?.pid === info.pid && previous?.startedAt === info.startedAt;
    state = { pid: info.pid, startedAt: info.startedAt,
      lastOkAt: same ? number(previous.lastOkAt) : null,
      firstMissAt: same ? number(previous.firstMissAt) : null,
      degraded: ok ? health.degraded === true : same && previous.degraded === true };
    if (ok) state.lastOkAt = Math.max(now, state.lastOkAt ?? now);
    else if (now > (state.lastOkAt ?? -Infinity) &&
        (state.firstMissAt === null || state.firstMissAt <= (state.lastOkAt ?? -Infinity))) {
      state.firstMissAt = now;
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    if (locked && !signal?.aborted) {
      try {
        await fs.writeFile(temp, JSON.stringify(state));
        await fs.rename(temp, file);
      } catch {}
      finally { await fs.unlink(temp).catch(() => {}); }
    }
  } finally {
    if (locked) {
      try { unlinkSync(owner); rmdirSync(lock); } catch {}
    }
  }
  return { healthy: ok || !(state.firstMissAt !== null &&
    now - state.firstMissAt >= 10_000 &&
    state.firstMissAt > (state.lastOkAt ?? -Infinity)), degraded: state.degraded };
}

async function daemonStatus(directory, now, snapshot, profile = 'default', options = {}) {
  const { cacheRoot = directory, processStart, signal } = options;
  const info = await readJson(path.join(directory, 'daemon.json'));
  if (!info || !alive(info.pid)) return;
  const discovery = await fs.stat(path.join(directory, 'daemon.json')).catch(() => null);
  const identity = `${info.token || ''}:${discovery?.mtimeMs || 0}:${discovery?.size || 0}`;
  if (info.pid_start && processStart) {
    const actual = await cachedStart(cacheRoot, info.pid, info.pid_start, identity, now, processStart);
    if (!sameStart(actual, info.pid_start)) return;
  }
  signal?.throwIfAborted();
  const result = {
    running: true, pid: info.pid, uptimeS: seconds(info.startedAt, now), max: null,
    runningJobs: null, queuedJobs: null, owners: [], jobs: [], appServer: null, healthy: true, degraded: false
  };
  snapshot.daemons[profile] = result;
  if (profile === 'default') snapshot.daemon = result;
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string') {
    Object.assign(result, await healthCollection(directory, info, null, now, signal));
    return;
  }
  const timeout = AbortSignal.timeout(3000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await Promise.all([
    fetchJson(info, '/health', fetchSignal).then(async (health) => {
      if (health?.pid !== undefined && health.pid !== info.pid) health = null;
      Object.assign(result, await healthCollection(directory, info, health, now, signal));
      result.appServer = ['up', 'down', 'restarting'].includes(health?.appServer) ? health.appServer : null;
      result.uptimeS = number(health?.uptimeS) ?? result.uptimeS;
      result.max = number(health?.max);
      result.runningJobs = number(health?.jobs?.running);
      result.queuedJobs = number(health?.jobs?.queued);
    }),
    fetchJson(info, '/jobs', fetchSignal).then((list) => {
      result.jobs = daemonJobs(list?.jobs, now);
      if (object(list?.owners)) {
        result.owners = Object.entries(list.owners).map(([owner, counts]) => ({
          owner, running: number(counts?.running), queued: number(counts?.queued)
        }));
      }
    })
  ]);
  timeout.throwIfAborted();
}

async function buildStatus(directory, now) {
  let handle;
  try {
    handle = await fs.open(path.join(directory, 'build.log'), 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    let start = Math.max(0, stat.size - TAIL_BYTES);
    if (start % 2) start++; // Preserve UTF-16 code-unit alignment without reading outside the tail.
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const tail = buffer.subarray(0, bytesRead);
    // The BOM may be outside the tail; ASCII build markers in UTF-16LE contain odd-position NULs.
    const utf16 = (tail[0] === 0xff && tail[1] === 0xfe) || tail.some((byte, index) => byte === 0 && index % 2);
    const text = tail.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift(); // A partial first line cannot match ^error or a completion marker.
    const matches = lines.filter((line) => /Compiling|Finished|^error|build exit/.test(line));
    let exeAt = null;
    try { exeAt = (await fs.stat(path.join(directory, 'dist', 'bin', 'codex.exe'))).mtime.toISOString(); }
    catch {}
    return {
      line: matches.at(-1)?.trim() || '',
      building: now - stat.mtimeMs < 120_000 && !lines.some((line) => /Finished|build exit/.test(line)),
      exeAt
    };
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

// Keep each probe's result local until it completes. An overdue probe cannot mutate the returned snapshot.
async function collectSections(config, snapshot, probes) {
  let previous;
  const cache = readJson(snapshotFile(config.run), MAX_SNAPSHOT_BYTES).then((value) => { previous = value; });
  await Promise.all(probes.map(async ([name, fields, probe]) => {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('collection deadline exceeded');
        reject(error);
        controller.abort(error);
      }, DEADLINE_MS);
    });
    try {
      Object.assign(snapshot, await Promise.race([probe(controller.signal), timeout]));
    } catch (error) {
      await Promise.race([cache, timeout]).catch(() => {});
      for (const field of fields) {
        if (Object.hasOwn(previous || {}, field)) snapshot[field] = previous[field];
      }
      const prior = previous?.sections?.[name];
      const reason = cleanText(String(error?.message || error), 500);
      (snapshot.sections ??= {})[name] = {
        attemptAt: snapshot.at, okAt: prior?.okAt || null, staleAfterMs: prior?.staleAfterMs ?? DEADLINE_MS,
        status: 'stale', reason
      };
      if (name === 'orchestration' && !previous?.orchestration) {
        snapshot.orchestration = { ...snapshot.orchestration, configError: reason };
      }
    } finally {
      clearTimeout(timer);
    }
  }));
}

async function codexLimits(config, now) {
  const candidates = await Promise.all([
    readJson(path.join(config.run, 'codex-limits.json')),
    readJson(path.join(config.daemon, 'daemon-net', 'codex-limits.json'))
  ]);
  const [limits] = candidates.filter(Boolean).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return { codexLimits: limits ? { ...limits, ageS: seconds(limits.at, now) } : null };
}

function sharedProbes(config, snapshot, now, geminiActive) {
  // Orchestration and Gemini share availability data. Keep the subprobes parallel and commit the Gemini fields together.
  const routing = { orchestration: { ...snapshot.orchestration }, gemini: { ...snapshot.gemini } };
  const orchestration = orchestrationStatus(routing, now);
  const availability = orchestration.then(() => routing.gemini, (error) => ({
    ...routing.gemini, reason: cleanText(String(error.message), 500)
  }));
  return [
    ['codexLimits', ['codexLimits'], () => codexLimits(config, now)],
    ['orchestration', ['orchestration'], async () => {
      await orchestration;
      return { orchestration: routing.orchestration };
    }],
    ['switches', ['switches'], async () => ({ switches: await switches() })],
    ['gemini', ['gemini'], async (signal) => {
      const [status, usage, mcp, quota] = await Promise.all([
        availability, geminiUsage(config, now, geminiActive(signal), signal),
        geminiMcp(config), geminiQuotaStatus(now, config)
      ]);
      return { gemini: { ...status, ...usage, mcp, quota } };
    }],
    ['usage', ['usage'], async () => ({ usage: await usageStatus(now, config) })]
  ];
}

export async function collect({ now = Date.now(), platform = process.platform,
  claudeHome = path.join(homedir(), '.claude') } = {}) {
  return collectOverview(configuration(claudeHome, platform), Number(new Date(now)));
}

async function collectOverview(config, now) {
  const snapshot = empty(now);
  const identityDeadline = performance.now() + 2500;
  let starts;
  const processStart = async (pid, signal) => {
    signal.throwIfAborted();
    if (config.platform !== 'win32') return readProcess(pid)?.started || '';
    starts ??= probeStarts(identityDeadline);
    return (await starts).get(pid) || '';
  };
  let activeGemini;
  const geminiActive = (signal) => activeGemini ??= geminiActiveJobs(config, now, async (pid, expected) => {
    if (!alive(pid)) return false;
    if (config.platform === 'linux') {
      const wrapper = readProcess(pid);
      return wrapper && wrapper.state !== 'Z' && (!expected || wrapper.started === expected);
    }
    return !expected || sameStart(await processStart(pid, signal), expected);
  }, signal);
  const daemon = async (signal) => {
    const { daemon, daemons } = empty(now);
    const result = { daemon, daemons };
    const options = { cacheRoot: config.run, signal, processStart: (pid) => processStart(pid, signal) };
    await Promise.all([
      daemonStatus(config.daemon, now, result, 'default', options),
      daemonStatus(path.join(config.daemon, 'daemon-net'), now, result, 'net', options)
    ]);
    return result;
  };
  let daemonProbe;
  try {
    await collectSections(config, snapshot, [
      ['ram', ['ram'], () => ({
        ram: { freeMb: Math.round((config.platform === 'linux' ? availableMemory() : freemem()) / 1048576),
          totalMb: Math.round(totalmem() / 1048576) }
      })],
      ['daemon', ['daemon', 'daemons'], (signal) => daemonProbe = daemon(signal)],
      ['jobs', ['jobs'], async (signal) => {
        const options = { acceptsPath: config.localPath, signal, processStart: (pid) => processStart(pid, signal) };
        const [jobs, active] = await Promise.all([activeJobs(config.run, now, undefined, options), geminiActive(signal)]);
        const daemons = jobs.some((job) => job._conflict) ? (await daemonProbe.catch(() => snapshot)).daemons : {};
        return { jobs: [...reconcileConflictJobs(jobs, daemons), ...active.jobs].sort(newest).slice(0, 40) };
      }],
      ['build', ['build'], async () => ({ build: await buildStatus(config.build || await customBuildRoot(config.claudeHome), now) })],
      ...sharedProbes(config, snapshot, now, geminiActive)
    ]);
  } finally {
    // Keep ownership of the identity probe until PowerShell and its stdio close.
    await starts?.catch(() => {});
  }
  return snapshot;
}

function human(snapshot) {
  const { ram, daemon, daemons, jobs, codexLimits: limits, build } = snapshot;
  const profiles = { default: daemon, net: { running: false }, ...daemons };
  return [
    `RAM ${ram.freeMb ?? '?'} / ${ram.totalMb ?? '?'} MB free`,
    ...Object.entries(profiles).map(([profile, daemon]) => daemon.running
      ? `Daemon ${profile} ${daemon.pid}: ${daemon.runningJobs ?? '?'} running, ${daemon.queuedJobs ?? '?'} queued`
      : profile === 'default' ? 'Daemon stopped' : `Daemon ${profile} stopped`),
    `Active ${jobs.length}${jobs.length ? ': ' + jobs.map((job) => `${job.state} ${job.model}`).join(', ') : ''}`,
    limits ? `Codex limits: reached=${limits.reached ?? '?'}, age=${limits.ageS ?? '?'}s` : 'Codex limits unknown',
    build ? `Build ${build.building ? 'running' : 'idle'}: ${build.line}` : 'Build unknown'
  ].join('\n');
}

async function selfTest() {
  const envKeys = ['HOME', 'LUNA_OVERVIEW_HOME', 'LUNA_RUN_DIR', 'LUNA_DAEMON_HOME', 'LUNA_CUSTOM_CODEX_ROOT', 'CONVEYOR_HOME'];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'luna-overview-test-'));
  const now = Date.now();
  const result = { passed: 0, failed: 0, errors: [] };
  const check = (name, fn) => {
    try { fn(); result.passed++; }
    catch (error) { result.failed++; result.errors.push(`${name}: ${error.message}`); }
  };
  try {
    process.env.HOME = directory;
    process.env.LUNA_OVERVIEW_HOME = directory;
    process.env.LUNA_RUN_DIR = directory;
    process.env.LUNA_CUSTOM_CODEX_ROOT = path.join(directory, 'build');
    process.env.CONVEYOR_HOME = path.join(directory, 'conveyor');
    process.env.LUNA_DAEMON_HOME = path.join(directory, 'daemon');
    const config = { ...configuration(), build: process.env.LUNA_CUSTOM_CODEX_ROOT };
    await fs.mkdir(path.join(directory, 'active'));
    await fs.mkdir(config.daemon);
    await fs.mkdir(path.join(config.build, 'dist', 'bin'), { recursive: true });
    let probes = 0;
    const probe = async () => { probes++; return 'actual'; };
    const cacheFirst = await cachedStart(directory, 123, 'expected', 'discovery-a', now, probe);
    const cacheAgain = await cachedStart(directory, 123, 'expected', 'discovery-a', now + 119_999, probe);
    const cacheChanged = await cachedStart(directory, 123, 'expected', 'discovery-b', now + 119_999, probe);
    const cacheExpired = await cachedStart(directory, 123, 'expected', 'discovery-a', now + 120_000, probe);
    check('identity cache rechecks only after discovery changes or 120 seconds', () => {
      assert.deepEqual([cacheFirst, cacheAgain, cacheChanged, cacheExpired], Array(4).fill('actual'));
      assert.equal(probes, 3);
    });
    await fs.writeFile(path.join(config.daemon, 'daemon.json'), JSON.stringify({
      pid: 0, port: 1, token: 'SECRET-NEVER-PRINT', startedAt: new Date(now).toISOString()
    }));
    const limits = { v: 1, at: new Date(now - 5000).toISOString(), source: 'test', planType: 'pro',
      ordinaryUsageAllowed: true, reached: false, primary: null, secondary: null, byLimitId: {} };
    await fs.writeFile(path.join(directory, 'codex-limits.json'), JSON.stringify(limits));
    const states = ['running', 'queued', 'waiting-capacity', 'done', 'failed', 'incomplete', 'stalled'];
    for (const [index, state] of states.entries()) {
      const out = path.join(directory, `job-${index}`);
      await fs.writeFile(path.join(directory, 'active', `${index + 100}`), `${out}\r\n${process.pid}\r\n`);
      const started = new Date(now - (index + 1) * 1000).toISOString().replace('Z', '+00:00');
      await fs.writeFile(`${out}.status`, [
        `state=${state}`, 'state=done', `started=${started}`, 'model=test', 'effort=high', 'sandbox=read-only',
        'engine=daemon', 'dir=C:/work=a', 'error=a=b', 'queue_pos=2', 'owner=owner-a', ''
      ].join('\n'));
    }
    await fs.writeFile(path.join(directory, 'active', '999'), path.join(directory, 'missing'));
    const log = path.join(config.build, 'build.log');
    await fs.writeFile(log, Buffer.from('\uFEFF' + 'ignored\r\n'.repeat(10000) + '  Compiling test\r\n', 'utf16le'));
    const exe = path.join(config.build, 'dist', 'bin', 'codex.exe');
    await fs.writeFile(exe, '');
    await fs.utimes(exe, new Date(now - 60_000), new Date(now - 60_000));
    const snapshot = JSON.parse(JSON.stringify(await collect({ now, claudeHome: path.join(directory, '.claude') })));
    check('root overrides', () => {
      assert.equal(config.run, directory);
      assert.equal(config.daemon, path.join(directory, 'daemon'));
      delete process.env.LUNA_DAEMON_HOME;
      assert.equal(configuration().daemon, directory);
    });
    check('JSON shape', () => {
      assert.deepEqual(Object.keys(snapshot), [
        'v', 'at', 'ram', 'daemon', 'daemons', 'jobs', 'codexLimits', 'build', 'sessions',
        'orchestration', 'switches', 'gemini', 'usage'
      ]);
      assert.equal(snapshot.v, 1);
      assert.equal(snapshot.at, new Date(now).toISOString());
      assert.deepEqual(Object.keys(snapshot.ram), ['freeMb', 'totalMb']);
      assert.equal(typeof snapshot.ram.freeMb, 'number');
      assert.deepEqual(snapshot.daemon, { running: false, appServer: null, healthy: false, degraded: false });
      assert.deepEqual(Object.keys(snapshot.jobs[0]), [
        'out', 'state', 'model', 'effort', 'sandbox', 'engine', 'ageS', 'dir', 'error', 'queuePos',
        'owner', 'idleS', 'activity'
      ]);
      assert.deepEqual(Object.keys(snapshot.build), ['line', 'building', 'exeAt']);
    });
    check('terminal filtering and newest first', () => {
      assert.deepEqual(snapshot.jobs.map((job) => job.state), states.slice(0, 3));
      assert.deepEqual(snapshot.jobs.map((job) => job.ageS), [1, 2, 3]);
      assert.equal(snapshot.jobs[0].queuePos, 2);
      assert.equal(snapshot.jobs[0].dir, 'C:/work=a');
      assert.equal(snapshot.jobs[0].error, 'a=b');
      assert.equal(snapshot.jobs[0].owner, 'owner-a');
    });
    check('two-line index format', () => {
      assert.equal(snapshot.jobs.length, 3);
      assert.ok(config.localPath(snapshot.jobs[0].out));
    });
    const conflictOut = path.join(directory, 'conflict-job');
    const conflictIndex = path.join(directory, 'active', 'conflict');
    const conflictId = 'a'.repeat(32);
    await fs.writeFile(conflictIndex, `${conflictOut}\n${process.pid}\n`);
    await fs.writeFile(`${conflictOut}.status`, [
      'state=failed', 'engine=daemon', 'daemon_profile=net', `started=${new Date(now).toISOString()}`,
      'model=rejected', 'error=output or log already in use by another daemon job', ''
    ].join('\n'));
    await fs.writeFile(`${conflictOut}.daemon`, `id=${conflictId}\nstate=running\n`);
    const conflictJob = (await activeJobs(directory, now)).find((job) => job.out === conflictOut);
    check('conflict keeps the live holder available for daemon reconciliation', () => {
      assert.equal(conflictJob?._conflict.id, conflictId);
      assert.equal(conflictJob?._conflict.profile, 'net');
    });
    check('conflict holder uses its own daemon metadata', () => {
      const live = { id: conflictId, state: 'running', model: 'holder', effort: 'high', sandbox: 'read-only',
        owner: 'holder-owner', ageS: 8, cwd: 'C:/holder' };
      const [job] = reconcileConflictJobs([structuredClone(conflictJob)], { net: { jobs: [live] } });
      assert.equal(job.model, 'holder');
      assert.equal(job.owner, 'holder-owner');
      assert.equal(job.dir, 'C:/holder');
      assert.equal(job._conflict, undefined);
      const [unknown] = reconcileConflictJobs([structuredClone(conflictJob)], { net: { jobs: [] } });
      assert.equal(unknown.state, 'running');
      assert.equal(unknown.model, '');
      assert.equal(unknown.owner, '');
    });
    await fs.writeFile(`${conflictOut}.daemon`, `id=${conflictId}\nstate=cancelled\n`);
    const finishedConflicts = await activeJobs(directory, now);
    check('terminal conflict marker is filtered', () => {
      assert.ok(!finishedConflicts.some((job) => job.out === conflictOut));
    });
    await Promise.all([
      fs.unlink(conflictIndex), fs.unlink(`${conflictOut}.status`), fs.unlink(`${conflictOut}.daemon`)
    ]);
    check('local drive paths only', () => {
      for (const value of ['C:/work/job', 'd:\\work\\job']) assert.equal(localPath(value), true);
      for (const value of ['\\\\server\\share\\job', '//server/share/job', '\\\\?\\C:\\job',
        '\\\\.\\C:\\job', 'C:job', '/tmp/job', 'job']) assert.equal(localPath(value), false);
    });
    const staleOut = path.join(directory, 'stale-job');
    const deadEntry = path.join(directory, 'active', 'dead-pid');
    const legacyEntry = path.join(directory, 'active', 'legacy-stale');
    const liveEntry = path.join(directory, 'active', 'live-pid');
    await fs.writeFile(`${staleOut}.status`, 'state=running\n');
    await fs.utimes(`${staleOut}.status`, new Date(now - 601_000), new Date(now - 601_000));
    await fs.writeFile(deadEntry, `${staleOut}\n2147483647\n`);
    await fs.writeFile(legacyEntry, `${staleOut}\n`);
    await fs.writeFile(liveEntry, `${staleOut}\n${process.pid}\n`);
    const rejected = ['\\\\server\\share\\job', '//server/share/job', '\\\\?\\C:\\job'];
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
    check('stale indices are filtered without removing any files', () => {
      assert.ok(remaining.includes('dead-pid'));
      assert.ok(remaining.includes('legacy-stale'));
      assert.ok(remaining.includes('999'));
      assert.ok(remaining.includes('live-pid'));
      assert.ok(rejected.every((_, index) => remaining.includes(`unc-${index}`)));
    });
    const kill = process.kill;
    let denied;
    try {
      process.kill = (pid, signal) => {
        if (pid !== 2147483647) return kill(pid, signal);
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      };
      await fs.writeFile(deadEntry, `${staleOut}\n2147483647\n`);
      denied = await activeJobs(directory, now);
    } finally { process.kill = kill; }
    check('EPERM counts as alive', () => {
      assert.equal(denied.filter((job) => job.out === staleOut).length, 2);
    });
    for (const file of [deadEntry, liveEntry, ...rejected.map((_, index) =>
      path.join(directory, 'active', `unc-${index}`))]) await fs.unlink(file);
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
      await fs.writeFile(entry, `${out}\n${process.pid}\n`);
      const jobs = await activeJobs(directory, now, boot);
      const present = (await fs.readdir(path.dirname(entry))).includes(name);
      check(`live pid ${name}: index and listing`, () => {
        assert.equal(present, true);
        assert.equal(jobs.some((job) => job.out === out), keep);
      });
      await fs.unlink(entry);
    }
    const scan = path.join(directory, 'scan');
    await fs.mkdir(path.join(scan, 'active'), { recursive: true });
    await Promise.all(Array.from({ length: ACTIVE_LIMIT + 1 }, async (_, index) => {
      const file = path.join(scan, 'active', String(index));
      await fs.writeFile(file, index ? 'relative-path\n' : `${staleOut}\n${process.pid}\n`);
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
        pid: process.pid, port: 1, token: 'SECRET-NEVER-PRINT', startedAt: new Date(now).toISOString()
      }));
      for (const [ok, appServer, expected] of [
        [true, 'up', 'up'], [true, 'down', 'down'], [true, 'restarting', 'restarting'],
        [false, 'up', 'up'], [true, 'unknown', null], [undefined, undefined, null]
      ]) {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok, appServer }) });
        const projected = empty(now);
        await daemonStatus(config.daemon, now, projected);
        check(`daemon health projection ${ok}/${appServer}`, () => {
          assert.equal(projected.daemon.healthy, true);
          assert.equal(projected.daemon.appServer, expected);
        });
      }
      const netDir = path.join(config.daemon, 'daemon-net');
      await fs.mkdir(netDir);
      await fs.writeFile(path.join(netDir, 'daemon.json'), JSON.stringify({
        pid: process.pid, port: 2, token: 'SECRET-NET', startedAt: new Date(now).toISOString()
      }));
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, appServer: 'up' }) });
      const profiles = empty(now);
      await Promise.all([
        daemonStatus(config.daemon, now, profiles), daemonStatus(netDir, now, profiles, 'net')
      ]);
      check('default and network daemon statuses are independent', () => {
        assert.equal(profiles.daemon.running, true);
        assert.equal(profiles.daemons.default.running, true);
        assert.equal(profiles.daemons.net.running, true);
        assert.ok(human(profiles).includes('Daemon net'));
      });
      const healthFile = path.join(config.daemon, 'daemon-health.json');
      await fs.unlink(healthFile);
      globalThis.fetch = async () => { throw new Error('health unavailable'); };
      const unavailable = empty(now);
      await daemonStatus(config.daemon, now, unavailable);
      check('one missed health keeps the daemon healthy with unknown app-server', () => {
        assert.equal(unavailable.daemon.running, true);
        assert.equal(unavailable.daemon.healthy, true);
        assert.equal(unavailable.daemon.appServer, null);
      });
      const discovery = await readJson(path.join(config.daemon, 'daemon.json'));
      const firstMissAt = (await readJson(healthFile)).firstMissAt;
      const soon = await healthCollection(config.daemon, discovery, null, firstMissAt + 9999);
      const twice = await healthCollection(config.daemon, discovery, null, firstMissAt + 10_000);
      check('misses become unhealthy only after ten seconds without success', () => {
        assert.equal(soon.healthy, true);
        assert.equal(twice.healthy, false);
        assert.equal(JSON.parse(readFileSync(healthFile)).firstMissAt, firstMissAt);
      });
      const okAt = firstMissAt + 10_001;
      const recovered = await healthCollection(config.daemon, discovery, { ok: true, degraded: true }, okAt);
      check('successful health records lastOkAt and surfaces degraded', () => {
        assert.equal(recovered.healthy, true);
        assert.equal(recovered.degraded, true);
        assert.equal(JSON.parse(readFileSync(healthFile)).lastOkAt, okAt);
      });
      const afterReset = await healthCollection(config.daemon, discovery, null, okAt + 1);
      check('a single miss after success stays healthy and keeps degraded', () => {
        assert.equal(afterReset.healthy, true);
        assert.equal(afterReset.degraded, true);
        assert.equal(JSON.parse(readFileSync(healthFile)).firstMissAt, okAt + 1);
      });
      await fs.unlink(healthFile);
      const concurrent = await Promise.all([
        healthCollection(config.daemon, discovery, null, now),
        healthCollection(config.daemon, discovery, null, now + 1)
      ]);
      const outage = await Promise.all([
        healthCollection(config.daemon, discovery, null, now + 10_000),
        healthCollection(config.daemon, discovery, null, now + 20_000)
      ]);
      check('interleaving collectors preserve the first miss throughout a long outage', () => {
        assert.ok(concurrent.every((sample) => sample.healthy));
        assert.ok(outage.every((sample) => !sample.healthy));
        assert.equal(JSON.parse(readFileSync(healthFile)).firstMissAt, now);
      });
      const interleaved = await Promise.all([
        healthCollection(config.daemon, discovery, { ok: true }, now + 20_001),
        healthCollection(config.daemon, discovery, null, now + 20_002)
      ]);
      const reset = await healthCollection(config.daemon, discovery, null, now + 20_003);
      check('interleaved success resets the outage without losing lastOkAt', () => {
        assert.ok(interleaved.every((sample) => sample.healthy));
        assert.equal(reset.healthy, true);
        assert.equal(JSON.parse(readFileSync(healthFile)).lastOkAt, now + 20_001);
      });
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
      ['exec command', 'exec\r\nrg -n auth src/ in C:/work\r\n', 'command', 'rg -n auth src/'],
      ['exec completion', 'exec\nrg -n auth src/ in C:/work\n succeeded in 123ms:\n', 'thinking', ''],
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
      assert.doesNotMatch(JSON.stringify(snapshot), /"token"\s*:/);
    });
    check('limits pass through', () => assert.deepEqual(snapshot.codexLimits, { ...limits, ageS: 5 }));
    check('UTF-16 tail and executable mtime', () => {
      assert.equal(snapshot.build.line, 'Compiling test');
      assert.equal(snapshot.build.building, true);
      assert.ok(Number.isFinite(Date.parse(snapshot.build.exeAt)));
      assert.equal(snapshot.build.exeAt, new Date(now - 60_000).toISOString());
    });
    await fs.appendFile(log, Buffer.from('    Finished release\r\nbuild exit 0\r\n', 'utf16le'));
    const completed = await buildStatus(config.build, now);
    check('completed UTF-16 build', () => {
      assert.equal(completed.line, 'build exit 0');
      assert.equal(completed.building, false);
    });
    await fs.writeFile(log, 'Compiling utf8\nerror: failed\n');
    const utf8 = await buildStatus(config.build, now);
    check('UTF-8 build', () => assert.equal(utf8.line, 'error: failed'));
    await fs.writeFile(log, '\uFEFFCompiling utf8 BOM\nFinished release\n');
    const utf8Bom = await buildStatus(config.build, now);
    check('UTF-8 BOM build', () => {
      assert.equal(utf8Bom.line, 'Finished release');
      assert.equal(utf8Bom.building, false);
    });
    await fs.writeFile(log, Buffer.from('\uFEFFCompiling short UTF-16\n', 'utf16le'));
    const short = await buildStatus(config.build, now);
    check('UTF-16 BOM build', () => assert.equal(short.line, 'Compiling short UTF-16'));
    await fs.utimes(log, new Date(now - 121_000), new Date(now - 121_000));
    const stale = await buildStatus(config.build, now);
    check('stale build log', () => assert.equal(stale.building, false));
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
    const missing = { ...config, run: path.join(directory, 'absent'), build: path.join(directory, 'absent') };
    check('first occurrence wins', () => assert.equal(statusValues('x=first\nx=second\nx=third').x, 'first'));
    const invalid = await collectOverview(config, now);
    const absent = await collectOverview(missing, now);
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

async function publishedSnapshot() {
  const run = runDirectory(path.join(homedir(), '.claude'));
  const file = snapshotFile(run);
  const snapshot = await readJson(file, MAX_SNAPSHOT_BYTES);
  const publishedAt = Date.parse(snapshot?.collector?.publishedAt ?? snapshot?.at);
  if (Number.isFinite(publishedAt) && Date.now() - publishedAt <= 30_000) return snapshot;

  const collector = fileURLToPath(new URL('./luna-collector.mjs', import.meta.url));
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [collector, 'ensure'], {
      stdio: 'ignore', windowsHide: true, env: { ...process.env, LUNA_RUN_DIR: run }
    });
    child.once('error', resolve);
    child.once('close', resolve);
  });
  return await readJson(file, MAX_SNAPSHOT_BYTES) ?? snapshot ?? empty();
}

async function main(args) {
  // Old panes may still pass --beat. The reader has no need for their stdin.
  const testing = args.includes('--self-test');
  const snapshot = testing ? await selfTest() : args.includes('--collect') ? await collect() : await publishedSnapshot();
  const output = !testing && args.includes('--human')
    ? human(snapshot) : JSON.stringify(snapshot, null, args.includes('--pretty') ? 2 : undefined);
  process.stdout.write(output + '\n');
  if (testing && snapshot.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE') process.exitCode = 1;
  });
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`luna-overview: ${error.message}\n`);
    process.exitCode = 1;
  });
}
