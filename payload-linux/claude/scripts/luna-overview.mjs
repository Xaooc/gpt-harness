#!/usr/bin/env node
// Read the Luna collector snapshot or collect a diagnostic sample in-process.
// Usage: node luna-overview.mjs [--json | --pretty | --human] [--collect | --self-test]
import * as fs from 'node:fs/promises';
import { freemem, totalmem, homedir, tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { availableMemory, matchingProcess, readProcess } from './lib/luna-runtime.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  codexLimitsSnapshot, loadConfigWithSource, paths as orchestrationPaths, providerState, resolveChain, resolvePanel
} from './conveyor/lib/orchestration.mjs';
import { codexAccounts, stamp, validAccountId } from './conveyor/lib/codex-accounts.mjs';
import { summarizeUsage, usagePaths } from './conveyor/usage.mjs';
import { quotaPaths } from './conveyor/gemini-quota.mjs';

const DEADLINE_MS = 1750;
const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const ACTIVE_LIMIT = 200;
const LEGACY_MAX_AGE_MS = 10 * 60 * 1000;
const terminal = new Set(['done', 'failed', 'incomplete', 'stalled', 'completed', 'cancelled', 'unavailable', 'stopped']);
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

async function allReads(reads) {
  const results = await Promise.allSettled(reads);
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

function runDirectory(claudeHome) {
  return path.resolve(process.env.LUNA_RUN_DIR || process.env.LUNA_OVERVIEW_HOME || path.join(claudeHome, 'luna-run'));
}

function snapshotFile(run) {
  return path.join(run, 'collector', 'snapshot.json');
}

function configuration(claudeHome = path.join(homedir(), '.claude'), platform = process.platform, run = runDirectory(claudeHome)) {
  return {
    claudeHome, platform, run, localPath, daemon: path.resolve(process.env.LUNA_DAEMON_HOME || run),
    registry: path.join(claudeHome, 'learning', 'jobs.jsonl'),
    codexConfig: path.join(process.env.CODEX_HOME || path.join(path.dirname(claudeHome), '.codex'), 'config.toml'),
    geminiStatus: platform === 'linux' ? '/srv/docker/compose/antigravity-parallel/data/status.json' : null
  };
}

function empty(now = Date.now()) {
  return {
    v: 1, at: new Date(now).toISOString(),
    ram: { freeMb: null, totalMb: null },
    daemon: { running: false, appServer: null, healthy: false }, jobs: [], codexLimits: null, codexAccounts: [], build: null,
    sessions: [],
    orchestration: { source: null, chains: {}, panels: {}, threshold: null, marks: {}, presets: [], catalog: {}, configError: null },
    switches: [], gemini: { available: false, reason: 'orchestration unavailable', tokensToday: 0, jobsToday: 0, mcp: null,
      quota: { available: false, buckets: [], at: null } },
    mlai: null,
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

async function activeJobs(run, now, boot = Date.now() - uptime() * 1000, signal) {
  const directory = path.join(run, 'active');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const recent = [];
  let cursor = 0;
  await allReads(Array.from({ length: Math.min(8, entries.length) }, async () => {
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
  await allReads(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length && !signal?.aborted) {
      const { file } = entries[cursor++];
      const text = await readText(file, 32 * 1024);
      const [out, pidLine, pidStart] = text?.split(/\r?\n/).map((line) => line.trim()) || [];
      // Validate before any access to paths supplied by the index or job data.
      if (!localPath(out)) continue;
      if (pidLine) {
        const pid = Number(pidLine);
        if (Number.isSafeInteger(pid) && pid > 0) {
          if (!matchingProcess(pid, pidStart)) continue;
        }
      } else {
        let stat;
        try { stat = await fs.stat(`${out}.status`); } catch {}
        if (!stat || now - stat.mtimeMs > LEGACY_MAX_AGE_MS) continue;
      }
      const status = await readText(`${out}.status`, TAIL_BYTES);
      if (status === null) continue;
      const values = statusValues(status);
      if (Date.parse(values.started) < boot) continue;
      if (terminal.has(values.state)) continue;
      const queue = values.queue_pos;
      const activity = await logActivity(`${out}.log`, now, values.state || '');
      jobs.push({
        out, state: values.state || '', model: values.model || '', effort: values.effort || '',
        sandbox: values.sandbox || '', engine: values.engine || '', ageS: seconds(values.started, now),
        dir: values.dir || '', error: values.error || '',
        queuePos: /^\d+$/.test(queue || '') && Number.isSafeInteger(Number(queue)) ? Number(queue) : null,
        owner: values.owner || '', idleS: activity.idleS, activity: activity.activity, provider: 'codex',
        ...(values.daemon_profile ? { daemonProfile: values.daemon_profile } : {}),
        ...(values.account !== 'main' && validAccountId(values.account) ? { account: values.account } : {})
      });
    }
  }));
  return jobs.sort(newest).slice(0, 40);
}

async function providerActiveJobs(config, provider, now, wrapperStart, signal) {
  const directory = path.join(config.run, provider === 'gemini' ? 'gem-active' : 'mlai-active');
  let names;
  try { names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).slice(0, ACTIVE_LIMIT); }
  catch { return { jobs: [], statuses: new Map() }; }
  const jobs = [], statuses = new Map();
  let cursor = 0;
  await allReads(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (cursor < names.length && !signal.aborted) {
      const file = path.join(directory, names[cursor++]);
      const pointer = await readJson(file);
      if (!pointer || pointer.v !== 1 || !config.localPath(pointer.out)) continue;
      const text = await readText(`${pointer.out}.status`, TAIL_BYTES);
      if (text === null) continue;
      const values = statusValues(text);
      if (!(await wrapperStart(pointer.wrapper_pid, values.wrapper_start))) continue;
      if (values.provider !== provider) continue;
      statuses.set(pointer.out, values);
      if (terminal.has(values.state)) continue;
      const stat = await fs.stat(`${pointer.out}.log`).catch(() => null);
      const idleS = stat?.isFile() ? Math.max(0, Math.floor((now - stat.mtimeMs) / 1000)) : null;
      const queued = values.state === 'queued' || string(values.state).startsWith('waiting-');
      const note = cleanText(values.last_note || '', 200);
      jobs.push({
        out: pointer.out, state: values.state || '', model: (provider === 'gemini' ? values.acp_model : values.model) || '',
        effort: values.effort || '',
        sandbox: values.sandbox || '', engine: values.engine || '', ageS: seconds(values.started || pointer.started, now),
        dir: values.dir || '', error: values.error || '', queuePos: null, owner: values.owner || string(pointer.owner),
        idleS, activity: { kind: queued ? 'queued' : values.state === 'starting' ? 'starting' : note ? 'writing' : 'unknown',
          text: note, sinceS: idleS }, provider,
        ...(provider === 'mlai' && values.account && values.account !== 'main' ? { account: values.account } : {})
      });
    }
  }));
  return { jobs: jobs.sort(newest).slice(0, 40), statuses };
}

async function dailyUsage(config, now, active, signal) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const statuses = new Map((await allReads(active)).flatMap(({ statuses }) => [...statuses]));
  // Today's records sit at the end; this runs on every fast collector cycle, so read only the recent tail.
  const records = jsonLines(await readTail(config.registry, 2 * 1024 * 1024));
  const outputs = [...new Set(records.filter((record) => config.localPath(record.out) &&
    !(Date.parse(record.finished) < midnight.getTime())).map((record) => record.out))];
  let cursor = 0;
  await allReads(Array.from({ length: Math.min(8, outputs.length) }, async () => {
    while (cursor < outputs.length && !signal.aborted) {
      const out = outputs[cursor++];
      if (statuses.has(out)) continue;
      const text = await readText(`${out}.status`, TAIL_BYTES);
      if (text !== null) statuses.set(out, statusValues(text));
    }
  }));
  const gemini = { tokensToday: 0, jobsToday: 0 }, mlai = { creditsToday: 0, jobsToday: 0 };
  for (const values of statuses.values()) {
    const finished = Date.parse(values.finished);
    if (!terminal.has(values.state) || !Number.isFinite(finished) || finished < midnight.getTime() || finished > now) continue;
    if (values.provider === 'gemini') {
      gemini.jobsToday++;
      gemini.tokensToday += Math.max(0, number(Number(values.usage_total)) ?? 0);
    } else if (values.provider === 'mlai') {
      mlai.jobsToday++;
      mlai.creditsToday += number(Number(values.credits)) ?? 0;
    }
  }
  return { gemini, mlai };
}

async function geminiMcp(config) {
  if (!config.geminiStatus) return null;
  const [status, toml] = await allReads([readJson(config.geminiStatus), readText(config.codexConfig)]);
  if (!status) return null;
  return {
    configured: /^[ \t]*\[[ \t]*mcp_servers\.(?:antigravity-parallel|"antigravity-parallel"|'antigravity-parallel')[ \t]*\]/m
      .test(toml || ''),
    activeItems: number(status.activeItems), adaptiveLimit: number(status.adaptiveLimit),
    configuredLimit: number(status.configuredLimit), at: string(status.at) || null
  };
}

async function orchestrationStatus(snapshot, now, includeGemini, codexDirectories) {
  const { config, source } = await loadConfigWithSource();
  const state = await providerState(config, { now, persist: false, codexDirectories });
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
  if (state.mlai) {
    const model = config.catalog.mlai?.[0];
    const probe = model && { tiers: { mlai: [{ provider: 'mlai', model: model.model, effort: model.efforts[0] }] } };
    const entry = probe ? (await resolveChain('mlai', { config: probe, state, now })).chain[0] : null;
    const mark = state.providers.mlai;
    const until = new Date(stamp(mark?.until));
    const { installed, signedIn, expiresAt, reason, slots, accounts } = state.mlai;
    snapshot.mlai = {
      installed, signedIn, expiresAt, reason,
      slots: { ...slots, holders: slots.holders.map(({ index, out, at }) => ({ index, out: string(out), at: string(at) })) },
      accounts: (accounts ?? []).map(({ id, label, home, proxy, signedIn: accountSignedIn, expiresAt: accountExpiresAt,
        reason: accountReason, slots: accountSlots, mark }) => ({
        id, label, home, proxy: proxy ?? null, signedIn: accountSignedIn, expiresAt: accountExpiresAt ?? null,
        reason: accountReason ?? null,
        slots: {
          limit: accountSlots.limit, used: accountSlots.used,
          holders: accountSlots.holders.map(({ index, out, at }) => ({ index, out: string(out), at: string(at) }))
        },
        mark: mark ? { reason: string(mark.reason), until: string(mark.until) } : null
      })),
      available: entry?.available ?? false, availability: entry?.reason ?? 'no mlai models in catalog',
      mark: until.getTime() > now ? { reason: string(mark.reason), until: string(mark.until) || until.toISOString() } : null
    };
  }
  if (!includeGemini) return state;
  // Resolve an availability probe even when no configured tier or panel currently uses Gemini.
  const model = config.catalog.gemini[0];
  const probe = { tiers: { gemini: [{ provider: 'gemini', model: model.model, effort: model.efforts[0] }] } };
  const entry = (await resolveChain('gemini', { config: probe, state, now })).chain[0];
  Object.assign(snapshot.gemini, { available: entry.available, reason: entry.reason });
  return state;
}

async function switches() {
  const text = await readTail(orchestrationPaths().switches);
  const lines = (text || '').trimEnd().split(/\r?\n/).slice(-8).reverse().join('\n');
  return jsonLines(lines).filter((event) => ['at', 'tier', 'from', 'to', 'reason']
    .every((key) => typeof event[key] === 'string')).map(({ at, tier, from, to, reason }) => ({ at, tier, from, to, reason }));
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

async function readDaemonJobs(info, signal) {
  const response = await fetch(`http://127.0.0.1:${info.port}/jobs`, {
    headers: { 'X-Luna-Token': info.token }, signal, redirect: 'error'
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`/jobs returned HTTP ${response.status}`);
  }
  const list = await response.json().catch(() => null);
  if (!Array.isArray(list?.jobs) || !list.jobs.every((job) => object(job) && string(job.id) && string(job.state))) {
    throw new Error('/jobs returned an invalid job listing');
  }
  return list;
}

async function sampleDaemonJobs(info, signal, now, profile, result, previous, failures, account) {
  try {
    const list = await readDaemonJobs(info, signal);
    result.jobs = daemonJobs(list.jobs, now, profile.split('/').at(-1), account);
    if (object(list.owners)) {
      result.owners = Object.entries(list.owners).map(([owner, counts]) => ({
        owner, running: number(counts?.running), queued: number(counts?.queued)
      }));
    }
  } catch (error) {
    result.jobs = previous?.jobs ?? [];
    result.owners = previous?.owners ?? [];
    failures[profile] = `${profile} daemon ${error.message}`;
  }
}

function markDaemonJobs(snapshot, previous, failures) {
  const reasons = Object.values(failures);
  if (!reasons.length) return;
  const prior = previous?.sections?.jobs;
  const existing = snapshot.sections?.jobs;
  (snapshot.sections ??= {}).jobs = {
    attemptAt: snapshot.at, okAt: prior?.okAt ?? null, staleAfterMs: prior?.staleAfterMs ?? DEADLINE_MS,
    status: prior?.okAt ? 'stale' : 'unavailable', reason: [...reasons, existing?.reason].filter(Boolean).join('; ')
  };
}

function daemonJobs(list, now, profile, account) {
  if (!Array.isArray(list)) return [];
  return list.filter((job) => object(job) &&
    (job.state === 'running' || job.state === 'queued' || string(job.state).startsWith('waiting-')))
    .map((job) => ({
      id: string(job.id), state: string(job.state), model: string(job.model), effort: string(job.effort),
      sandbox: string(job.sandbox), owner: string(job.owner),
      ageS: seconds(job.queuedAt, now) ?? number(job.ageS), cwd: string(job.cwd), reason: string(job.reason),
      idleS: null, activity: { kind: job.state === 'queued' || string(job.state).startsWith('waiting-')
        ? 'queued' : 'unknown', text: job.state === 'queued' || string(job.state).startsWith('waiting-')
          ? string(job.state) : '', sinceS: null }, provider: 'codex',
      ...(profile ? { daemonProfile: profile } : {}), ...(account ? { account } : {})
    })).sort(newest).slice(0, 30);
}

async function daemonStatus(directory, now, snapshot, profile, signal, previous, failures = {}, account) {
  const info = await readJson(path.join(directory, 'daemon.json'));
  if (!info || !matchingProcess(info.pid, info.pid_start)) return;
  const result = {
    running: true, pid: info.pid, uptimeS: seconds(info.startedAt, now), max: null,
    runningJobs: null, queuedJobs: null, owners: [], jobs: [], appServer: null, healthy: false
  };
  snapshot.daemon = result;
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string') {
    failures[profile] = `${profile} daemon discovery has no valid /jobs endpoint`;
    result.jobs = previous?.jobs ?? [];
    return;
  }
  const timeout = AbortSignal.timeout(1000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await allReads([
    fetchJson(info, '/health', fetchSignal).then((health) => {
      result.healthy = health?.ok === true;
      result.appServer = ['up', 'down', 'restarting'].includes(health?.appServer) ? health.appServer : null;
      result.uptimeS = number(health?.uptimeS) ?? result.uptimeS;
      result.max = number(health?.max);
      result.runningJobs = number(health?.jobs?.running);
      result.queuedJobs = number(health?.jobs?.queued);
    }),
    sampleDaemonJobs(info, fetchSignal, now, profile, result, previous, failures, account)
  ]);
}

async function daemonProfiles(directory, now, snapshot, signal, previous, failures) {
  const { config } = await loadConfigWithSource().catch(() => ({ config: {} }));
  const roots = [['main', directory], ...codexAccounts(config).filter(({ id }) => id !== 'main')
    .map(({ id }) => [id, path.join(directory, 'accounts', id)])];
  const locations = roots.flatMap(([id, root]) => [
    ['default', root], ['net', path.join(root, 'daemon-net')]
  ].map(([profile, dir]) => id === 'main' ? [profile, dir] : [`${id}/${profile}`, dir, id]));
  const profiles = Object.fromEntries(await allReads(locations.map(async ([profile, dir, account]) => {
    const sample = { daemon: { running: false, appServer: null, healthy: false } };
    const prior = previous?.profiles?.[profile] ?? (profile === 'default' ? previous : undefined);
    await daemonStatus(dir, now, sample, profile, signal, prior, failures, account);
    return [profile, sample.daemon];
  })));
  const running = Object.values(profiles).filter((daemon) => daemon.running);
  if (!running.length) return;
  const sum = (key) => running.every((daemon) => typeof daemon[key] === 'number')
    ? running.reduce((total, daemon) => total + daemon[key], 0) : null;
  const [primary] = running;
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

// Keep each probe's result local until it completes. An overdue probe cannot mutate the returned snapshot.
async function collectSections(snapshot, probes, previous, signal) {
  await allReads(probes.map(async ([name, fields, probe]) => {
    const controller = new AbortController();
    const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('collection deadline exceeded');
        controller.abort(error);
        if (!signal) reject(error);
      }, DEADLINE_MS);
    });
    try {
      const result = probe(probeSignal);
      // A resident caller keeps ownership of an aborted read until the underlying work settles.
      const value = await (signal ? result : Promise.race([result, timeout]));
      probeSignal.throwIfAborted();
      Object.assign(snapshot, value);
    } catch (error) {
      for (const field of fields) {
        if (Object.hasOwn(previous || {}, field)) snapshot[field] = previous[field];
      }
      const reason = cleanText(String(error?.message || error), 500);
      for (const section of name === 'orchestration' ? fields : [name]) {
        const prior = previous?.sections?.[section];
        (snapshot.sections ??= {})[section] = {
          attemptAt: snapshot.at, okAt: prior?.okAt || null, staleAfterMs: prior?.staleAfterMs ?? DEADLINE_MS,
          status: 'stale', reason
        };
      }
      if (name === 'orchestration' && !previous?.orchestration) {
        snapshot.orchestration = { ...snapshot.orchestration, configError: reason };
      }
    } finally {
      clearTimeout(timer);
    }
  }));
}

async function codexLimits(config, now) {
  const candidates = await allReads([
    readJson(path.join(config.run, 'codex-limits.json')),
    readJson(path.join(config.daemon, 'codex-limits.json')),
    readJson(path.join(config.daemon, 'daemon-net', 'codex-limits.json')),
    readJson(path.join(config.daemon, 'codex-limits.probe.json'))
  ]);
  const [limits] = candidates.filter(Boolean).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return { codexLimits: limits ? { ...limits, ageS: seconds(limits.at, now) } : null };
}

function sharedProbes(config, snapshot, now, geminiActive, mlaiActive, includeGemini, standalone) {
  // Orchestration and Gemini share availability data. Keep the subprobes parallel and commit the Gemini fields together.
  const routing = { orchestration: { ...snapshot.orchestration }, gemini: { ...snapshot.gemini }, mlai: null };
  const orchestration = orchestrationStatus(routing, now, includeGemini, standalone ? config : undefined);
  const availability = orchestration.then(() => routing.gemini, (error) => ({
    ...routing.gemini, reason: cleanText(String(error.message), 500)
  }));
  let providerUsage;
  const usage = (signal) => providerUsage ??= dailyUsage(config, now,
    [mlaiActive(signal), ...(includeGemini ? [geminiActive(signal)] : [])], signal);
  return [
    ...(standalone ? [['codexLimits', ['codexLimits', 'codexAccounts'], async () => {
      const state = await orchestration.catch(() => null);
      return state ? codexLimitsSnapshot(state) : codexLimits(config, now);
    }]] : []),
    ['orchestration', ['orchestration', 'mlai'], async (signal) => {
      const [, totals] = await allReads([orchestration, usage(signal)]);
      return { orchestration: routing.orchestration, mlai: routing.mlai && { ...routing.mlai, ...totals.mlai } };
    }],
    ['switches', ['switches'], async () => ({ switches: await switches() })],
    ...(includeGemini ? [['gemini', ['gemini'], async (signal) => {
      const [status, totals, mcp, quota] = await allReads([
        availability, usage(signal),
        geminiMcp(config), geminiQuotaStatus(now, config)
      ]);
      return { gemini: { ...status, ...totals.gemini, mcp, quota } };
    }]] : []),
    ...(standalone ? [['usage', ['usage'], async () => ({ usage: await usageStatus(now, config) })]] : [])
  ];
}

export async function collect({ now = Date.now(), platform = process.platform,
  claudeHome = path.join(homedir(), '.claude'), includeGemini = true, signal, previous, runDir } = {}) {
  return collectOverview(configuration(claudeHome, platform, runDir), Number(new Date(now)), includeGemini, { signal, previous });
}

async function collectOverview(config, now, includeGemini = true, { signal, previous } = {}) {
  const snapshot = empty(now);
  previous ??= await readJson(snapshotFile(config.run), MAX_SNAPSHOT_BYTES);
  const jobsFailures = {};
  const wrapperStart = (pid, expected) => {
    const wrapper = readProcess(pid);
    return wrapper && wrapper.state !== 'Z' && (!expected || expected === wrapper.started);
  };
  let activeGemini, activeMlai;
  const geminiActive = (signal) => activeGemini ??= providerActiveJobs(config, 'gemini', now, wrapperStart, signal);
  const mlaiActive = (signal) => activeMlai ??= providerActiveJobs(config, 'mlai', now, wrapperStart, signal);
  await collectSections(snapshot, [
    ...(signal ? [] : [['ram', ['ram'], () => ({
      ram: { freeMb: Math.round((config.platform === 'linux' ? availableMemory() : freemem()) / 1048576),
        totalMb: Math.round(totalmem() / 1048576) }
    })]]),
    ['daemon', ['daemon'], async (signal) => {
      const result = { daemon: snapshot.daemon };
      await daemonProfiles(config.daemon, now, result, signal, previous?.daemon, jobsFailures);
      return result;
    }],
    ['jobs', ['jobs'], async (signal) => {
      const [jobs, gemini, mlai] = await allReads([activeJobs(config.run, now, undefined, signal),
        geminiActive(signal), mlaiActive(signal)]);
      return { jobs: [...jobs, ...gemini.jobs, ...mlai.jobs].sort(newest).slice(0, 40) };
    }],
    ...sharedProbes(config, snapshot, now, geminiActive, mlaiActive, includeGemini, !signal)
  ], previous, signal);
  markDaemonJobs(snapshot, previous, jobsFailures);
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
  const envKeys = ['LUNA_OVERVIEW_HOME', 'LUNA_DAEMON_HOME', 'LUNA_RUN_DIR', 'CONVEYOR_HOME',
    'CONVEYOR_LUNA_SH', 'CONVEYOR_GEM_SH'];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
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
    process.env.LUNA_RUN_DIR = directory;
    process.env.CONVEYOR_HOME = path.join(directory, 'conveyor');
    process.env.CONVEYOR_LUNA_SH = fileURLToPath(import.meta.url);
    process.env.CONVEYOR_GEM_SH = fileURLToPath(import.meta.url);
    const config = configuration();
    config.registry = path.join(directory, 'jobs.jsonl');
    config.codexConfig = path.join(directory, 'config.toml');
    config.geminiStatus = path.join(directory, 'gateway-status.json');
    const fixture = new URL('./conveyor/test/fixtures/orchestration.json', import.meta.url);
    const orchestration = JSON.parse(await fs.readFile(fixture, 'utf8'));
    const defaults = JSON.parse(await fs.readFile(new URL('../conveyor/orchestration.default.json', import.meta.url), 'utf8'));
    await fs.mkdir(orchestrationPaths().home);
    const usageCache = { v: 1, at: new Date(now).toISOString(), days: {}, topJobs: [] };
    await fs.writeFile(usagePaths().cache, JSON.stringify(usageCache));
    const quotaCache = { available: true, source: 'agy-statusline', at: new Date(now).toISOString(),
      buckets: [{ name: 'gemini-5h', remainingFraction: 0.75, resetAt: new Date(now + 60_000).toISOString() }] };
    await fs.writeFile(quotaPaths().cache, JSON.stringify(quotaCache));

    await fs.writeFile(orchestrationPaths().config, JSON.stringify(orchestration));
    await fs.mkdir(path.join(directory, 'active'));
    await fs.mkdir(config.daemon);
    await fs.writeFile(path.join(config.daemon, 'daemon.json'), JSON.stringify({
      pid: 0, port: 1, token: 'SECRET-NEVER-PRINT', startedAt: new Date(now).toISOString()
    }));
    const limits = { v: 1, at: new Date(now - 5000).toISOString(), source: 'test', planType: 'pro',
      ordinaryUsageAllowed: true, reached: false, primary: null, secondary: null, byLimitId: {} };
    await fs.writeFile(path.join(directory, 'codex-limits.json'), JSON.stringify(limits));
    const states = ['running', 'queued', 'waiting-capacity', 'done', 'failed', 'incomplete', 'stalled', 'unavailable'];
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
    const snapshot = JSON.parse(JSON.stringify(await collectOverview(config, now)));
    const exported = await collect({ now, claudeHome: path.join(directory, '.claude') });
    check('root overrides', () => {
      assert.deepEqual(exported.jobs, snapshot.jobs);
      assert.deepEqual(exported.usage, snapshot.usage);
      assert.equal(config.run, directory);
      assert.equal(config.daemon, path.join(directory, 'daemon'));
      delete process.env.LUNA_DAEMON_HOME;
      assert.equal(configuration().daemon, directory);
    });
    check('JSON shape', () => {
      assert.deepEqual(Object.keys(snapshot), [
        'v', 'at', 'ram', 'daemon', 'jobs', 'codexLimits', 'codexAccounts', 'build', 'sessions', 'orchestration', 'switches',
        'gemini', 'mlai', 'usage'
      ]);
      assert.equal(snapshot.v, 1);
      assert.equal(snapshot.at, new Date(now).toISOString());
      assert.deepEqual(Object.keys(snapshot.ram), ['freeMb', 'totalMb']);
      assert.equal(typeof snapshot.ram.freeMb, 'number');
      assert.deepEqual(snapshot.daemon, { running: false, appServer: null, healthy: false });
      assert.deepEqual(Object.keys(snapshot.jobs[0]), [
        'out', 'state', 'model', 'effort', 'sandbox', 'engine', 'ageS', 'dir', 'error', 'queuePos',
        'owner', 'idleS', 'activity', 'provider'
      ]);
      assert.ok(snapshot.jobs.every((job) => job.provider === 'codex'));
      assert.equal(snapshot.build, null);
    });
    check('usage summary comes from the cache', () => {
      assert.deepEqual(snapshot.usage, { ...summarizeUsage(usageCache, now), stale: false });
      assert.equal(snapshot.usage.days.length, 7);
    });
    check('fresh Gemini quota appears in the snapshot', () => {
      assert.deepEqual(snapshot.gemini.quota, {
        available: true, buckets: quotaCache.buckets, at: quotaCache.at
      });
    });
    const staleCache = { ...quotaCache, at: new Date(now - 600_001).toISOString() };
    await fs.writeFile(quotaPaths().cache, JSON.stringify(staleCache));
    const staleQuota = await geminiQuotaStatus(now, config);
    check('stale Gemini quota retains its cached timestamp and values', () => {
      assert.deepEqual(staleQuota, { ...snapshot.gemini.quota, at: staleCache.at, stale: true });
    });
    await fs.writeFile(quotaPaths().cache, JSON.stringify(quotaCache));
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
    check('orchestration uses shared resolution', () => {
      assert.equal(snapshot.orchestration.source, 'user');
      assert.equal(snapshot.orchestration.configError, null);
      assert.equal(snapshot.orchestration.chains.complex[0].selected, true);
      assert.equal(snapshot.orchestration.chains.complex[1].selected, false);
      assert.deepEqual(snapshot.orchestration.panels.design.map((entry) => entry.seat), [0, 1, 2]);
      assert.deepEqual(snapshot.orchestration.threshold, { ...orchestration.thresholds.codex, switched: false });
      assert.deepEqual(snapshot.orchestration.catalog, { ...orchestration.catalog, mlai: defaults.catalog.mlai });
      assert.equal(snapshot.orchestration.presets[0].label, orchestration.presets['max-quality'].label);
      assert.equal(snapshot.gemini.available, true);
      assert.equal(snapshot.gemini.mcp, null);
    });
    const gemOut = path.join(directory, 'gem-job');
    const gemDir = path.join(directory, 'gem-active');
    await fs.mkdir(gemDir);
    const gemPointer = { v: 1, id: '0123456789abcdef', out: gemOut, owner: 'owner-gem',
      started: new Date(now - 4000).toISOString(), pid: process.pid, wrapper_pid: process.pid };
    await fs.writeFile(path.join(gemDir, `${gemPointer.id}.json`), JSON.stringify(gemPointer));
    await fs.writeFile(path.join(gemDir, 'dead.json'), JSON.stringify({ ...gemPointer, wrapper_pid: 2147483647 }));
    await fs.writeFile(`${gemOut}.status`, [
      'provider=gemini', 'state=running', `started=${gemPointer.started}`, 'model=gemini-3.8-flash',
      'acp_model=gemini-3.8-flash-medium', 'effort=medium', 'engine=acp', 'sandbox=read-only',
      `wrapper_start=${readProcess(process.pid).started}`, 'owner=owner-gem', 'last_note=Read greeting.txt'
    ].join('\n'));
    await fs.writeFile(`${gemOut}.log`, 'latest update\n');
    await fs.utimes(`${gemOut}.log`, new Date(now - 2000), new Date(now - 2000));
    const doneOut = path.join(directory, 'gem-done'), finishingOut = path.join(directory, 'gem-finishing');
    const finished = new Date(now).toISOString();
    for (const [out, total] of [[doneOut, 192], [finishingOut, 17]]) {
      await fs.writeFile(`${out}.status`, `provider=gemini\nstate=done\nfinished=${finished}\nusage_total=${total}\n`);
    }
    await fs.writeFile(path.join(gemDir, 'finishing.json'), JSON.stringify({ ...gemPointer, out: finishingOut }));
    await fs.writeFile(config.registry, [
      JSON.stringify({ out: doneOut, finished }), '{broken', JSON.stringify({ out: doneOut, finished })
    ].join('\n') + '\n');
    await fs.writeFile(config.geminiStatus, JSON.stringify({
      activeItems: 2, adaptiveLimit: 3, configuredLimit: 4, at: finished
    }));
    await fs.writeFile(config.codexConfig, '# [mcp_servers.unrelated]\n[mcp_servers.antigravity-parallel]\n');
    const switchEvents = Array.from({ length: 9 }, (_, index) => ({
      at: new Date(now - (9 - index) * 1000).toISOString(), tier: 'simple', from: 'gemini', to: 'codex', reason: String(index)
    }));
    await fs.writeFile(orchestrationPaths().switches,
      switchEvents.map((event) => JSON.stringify(event)).join('\n') + '\n{broken\n');
    const withGemini = await collectOverview(config, now);
    check('gem-active job shown with provider gemini and last_note activity', () => {
      const job = withGemini.jobs.find((entry) => entry.provider === 'gemini');
      assert.equal(job.out, gemOut);
      assert.equal(job.model, 'gemini-3.8-flash-medium');
      assert.equal(job.owner, 'owner-gem');
      assert.equal(job.idleS, 2);
      assert.equal(job.activity.text, 'Read greeting.txt');
      assert.equal(withGemini.jobs.length, 4);
    });
    check('dead Gemini pointer and finished job are filtered', () => {
      assert.ok(!withGemini.jobs.some((job) => job.out === finishingOut));
      assert.equal(withGemini.jobs.filter((job) => job.out === gemOut).length, 1);
    });
    check('Gemini usage deduplicates registry and includes finishing active jobs', () => {
      assert.equal(withGemini.gemini.tokensToday, 209);
      assert.equal(withGemini.gemini.jobsToday, 2);
      assert.deepEqual(withGemini.gemini.mcp, {
        configured: true, activeItems: 2, adaptiveLimit: 3, configuredLimit: 4, at: finished
      });
    });
    check('corrupt switches line skipped; last eight lines newest first', () => {
      assert.deepEqual(withGemini.switches, switchEvents.slice(-7).reverse());
    });
    const pointers = await fs.readdir(gemDir);
    check('dead Gemini pointer remains on disk', () => assert.ok(pointers.includes('dead.json')));
    await fs.unlink(orchestrationPaths().config);
    const noOrchestration = await collectOverview(config, now);
    check('missing orchestration config uses shipped defaults and preserves other sections', () => {
      assert.equal(noOrchestration.orchestration.source, 'default');
      assert.equal(noOrchestration.orchestration.configError, null);
      assert.ok(noOrchestration.orchestration.chains.complex.length > 0);
      assert.deepEqual(noOrchestration.jobs, withGemini.jobs);
      assert.deepEqual(noOrchestration.codexLimits, withGemini.codexLimits);
      assert.deepEqual(noOrchestration.switches, withGemini.switches);
      assert.equal(noOrchestration.gemini.tokensToday, 209);
      assert.deepEqual(noOrchestration.mlai, withGemini.mlai);
    });
    await fs.writeFile(orchestrationPaths().config, '{broken');
    await fs.writeFile(config.geminiStatus, '{broken');
    const corruptOrchestration = await collectOverview(config, now);
    check('corrupt orchestration and gateway status degrade independently', () => {
      assert.ok(corruptOrchestration.orchestration.configError);
      assert.equal(corruptOrchestration.gemini.mcp, null);
      assert.equal(corruptOrchestration.jobs.length, 4);
    });
    await fs.writeFile(orchestrationPaths().config, JSON.stringify(orchestration));
    const mlaiOut = path.join(directory, 'mlai-job'), mlaiDir = path.join(directory, 'mlai-active');
    await fs.mkdir(mlaiDir);
    await fs.writeFile(path.join(mlaiDir, `${gemPointer.id}.json`), JSON.stringify({ ...gemPointer, out: mlaiOut }));
    await fs.writeFile(`${mlaiOut}.status`, [
      'provider=mlai', 'state=running', 'model=pixis-opus', `wrapper_start=${readProcess(process.pid).started}`
    ].join('\n'));
    const withoutGemini = await collectOverview(config, now, false);
    check('mlai-active job is listed with the wrapper model when Gemini collection is disabled', () => {
      const job = withoutGemini.jobs.find((entry) => entry.out === mlaiOut);
      assert.equal(job?.provider, 'mlai');
      assert.equal(job.state, 'running');
      assert.equal(job.model, 'pixis-opus');
    });
    await fs.rm(mlaiDir, { recursive: true });
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
    check('stale indices are filtered without removing any files', () => {
      assert.ok(remaining.includes('dead-pid'));
      assert.ok(remaining.includes('legacy-stale'));
      assert.ok(remaining.includes('999'));
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
        assert.equal(present, true);
        assert.equal(jobs.some((job) => job.out === out), keep);
      });
      await fs.unlink(entry);
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
      assert.ok(!JSON.stringify(snapshot).includes('"token"'));
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
        'activity', 'provider'
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
  const snapshot = await readJson(snapshotFile(run), MAX_SNAPSHOT_BYTES);
  if (!snapshot) {
    process.stderr.write('сборщик не отвечает — запустите: node ~/.claude/scripts/luna-collector.mjs start\n');
  }
  return snapshot ? { codexAccounts: [], ...snapshot } : empty();
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
