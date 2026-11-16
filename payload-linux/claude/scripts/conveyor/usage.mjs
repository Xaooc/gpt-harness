#!/usr/bin/env node
// Incremental, local-only token accounting. State contains counters and metadata, never message text.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalRepo, projectKeyForCwd } from '../learning/common.mjs';
import { matchingProcess, readProcess } from '../lib/luna-runtime.mjs';

const providers = ['claude', 'codex', 'gemini'];
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'messages'];
const numeric = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const counters = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 });
const totals = () => ({ total: 0, input: 0, output: 0, cached: 0 });
const dictionary = () => Object.create(null);
const localPath = (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const cacheDigest = (cache) => createHash('sha256').update(JSON.stringify([cache.days, cache.topJobs])).digest('hex');
const jobKey = (out, values) => JSON.stringify([out, values.started || '']);
const hasUsage = (values) => ['usage_input', 'usage_output', 'usage_total'].some((key) => values[key] !== undefined);
const jobLog = (file) => file.endsWith('.log') && !['daemon.log', 'clean.log'].includes(path.basename(file));

export function usagePaths(env = process.env) {
  const home = path.resolve(env.HOME || homedir());
  const claude = path.resolve(env.CLAUDE_HOME_DIR || path.join(home, '.claude'));
  const cacheHome = path.resolve(env.CONVEYOR_HOME || path.join(claude, 'conveyor'));
  return {
    home: cacheHome, state: path.join(cacheHome, 'usage-state.json'), cache: path.join(cacheHome, 'usage-cache.json'),
    archive: path.join(cacheHome, 'usage-archive.json'),
    lock: path.join(cacheHome, 'usage-state.json.lock'), projects: path.join(claude, 'projects'),
    sessions: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    registry: path.join(claude, 'learning', 'jobs.jsonl'),
    run: path.resolve(env.LUNA_RUN_DIR || path.join(claude, 'luna-run'))
  };
}

export function localDay(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysBefore(now, count) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - count);
  return localDay(date);
}

function project(value, cwd = false) {
  if (!value || /scratch-workspaces|(?:^|[/-])luna-run(?:[/-]|$)/i.test(value)) return 'без папки';
  const key = cwd ? projectKeyForCwd(value) : value;
  if (/^-?(?:home|Users)-[^-]+-?$/i.test(key) || /^[A-Za-z]--?$/.test(key)) return 'без папки';
  return canonicalRepo(key) || 'без папки';
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

const messageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'messages', 'at', 'model'];
const unpackMessage = (value) => Array.isArray(value) ? {
  input: value[0], output: value[1], cacheRead: value[2], cacheWrite: value[3], total: value[4],
  messages: value[5], at: value[6], model: value[7]
} : value;
const packMessage = (value) => Array.isArray(value) ? value : messageKeys.map((key) => value[key]);

// A Bloom filter is only a restore hint. False positives reopen the exact ledger; they never change counts.
function archiveFilter(ids) {
  const size = 2 ** Math.ceil(Math.log2(Math.max(64, ids.length * 64))), bits = Buffer.alloc(size / 8);
  for (const id of ids) filterContains({ bits, mask: size - 1 }, id, true);
  return { bits: bits.toString('base64'), mask: size - 1 };
}

function filterContains(filter, id, insert = false) {
  const hash = createHash('sha256').update(id).digest(), first = hash.readUInt32LE(0), step = hash.readUInt32LE(4) | 1;
  for (let index = 0; index < 8; index++) {
    const bit = (first + index * step) & filter.mask, byte = bit >>> 3, mask = 1 << (bit & 7);
    if (insert) filter.bits[byte] |= mask;
    else if (!(filter.bits[byte] & mask)) return false;
  }
  return true;
}

function writeJson(file, value, header = null) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const prefix = header ? JSON.stringify(header).slice(0, -1) + ',\n' : '';
    fs.writeFileSync(temporary, prefix + (header ? JSON.stringify(value).slice(1) : JSON.stringify(value)) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// A live collector never loses its lock on a timer, including during a large first scan.
export function acquireUsageLock(paths = usagePaths()) {
  fs.mkdirSync(paths.home, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(paths.lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(paths.lock, 'owner.json'));
      if (owner ? matchingProcess(owner.pid, owner.start) : Date.now() - fs.statSync(paths.lock).mtimeMs < 60_000) {
        return null;
      }
      const retired = `${paths.lock}.${randomUUID()}.stale`;
      try { fs.renameSync(paths.lock, retired); }
      catch (caught) { if (caught.code === 'ENOENT') continue; throw caught; }
      // Recheck after renaming so a competing stale-lock reaper cannot evict a new owner.
      const moved = readJson(path.join(retired, 'owner.json'));
      if (moved && matchingProcess(moved.pid, moved.start)) {
        try { fs.renameSync(retired, paths.lock); } catch {}
        return null;
      }
      fs.rmSync(retired, { recursive: true, force: true });
      continue;
    }
    const nonce = randomUUID();
    try { writeJson(path.join(paths.lock, 'owner.json'), { pid: process.pid, start: readProcess(process.pid)?.started, nonce }); }
    catch (error) { fs.rmSync(paths.lock, { recursive: true, force: true }); throw error; }
    return () => {
      if (readJson(path.join(paths.lock, 'owner.json'))?.nonce === nonce) fs.rmSync(paths.lock, { recursive: true, force: true });
    };
  }
  return null;
}

function walk(directory, visit) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, visit);
    else if (entry.isFile()) visit(file);
  }
}

function fields(text) {
  const values = dictionary();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !Object.hasOwn(values, line.slice(0, index))) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

const metadataKeys = ['out', 'effort', 'model', 'acp_model', 'provider', 'dir', 'started', 'finished', 'state', 'thread',
  'usage_input', 'usage_output', 'usage_total', 'usage_cached', 'name'];
function metadata(value) {
  return Object.fromEntries(metadataKeys.filter((key) => ['string', 'number'].includes(typeof value[key]))
    .map((key) => [key, value[key]]));
}

function metrics(usage, claude = false) {
  const input = numeric(usage.input_tokens), output = numeric(usage.output_tokens);
  const cacheRead = numeric(claude ? usage.cache_read_input_tokens : usage.cached_input_tokens);
  const cacheWrite = numeric(claude ? usage.cache_creation_input_tokens : usage.cache_write_input_tokens);
  return { input, output, cacheRead, cacheWrite,
    total: claude ? input + output + cacheRead + cacheWrite : numeric(usage.total_tokens ?? input + output), messages: 1 };
}

function mergeMessage(previous, next) {
  if (!previous) return next;
  for (const key of tokenKeys) previous[key] = Math.max(previous[key], next[key]);
  if (Date.parse(next.at) < Date.parse(previous.at)) previous.at = next.at;
  return previous;
}

// Read complete lines only. An unfinished UTF-8/JSON line stays on disk until the next append.
// Large non-usage lines are discarded before JSON parsing; memory is bounded by the largest line.
function scanLines(fd, start, end, visit, stats) {
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, end - start));
  let position = start, offset = start, fragments = [];
  while (position < end) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
    if (!read) break;
    stats.bytesRead += read;
    let left = 0, newline;
    while ((newline = buffer.indexOf(10, left)) >= 0 && newline < read) {
      const part = buffer.subarray(left, newline);
      const line = fragments.length ? Buffer.concat([...fragments, part]).toString('utf8') : part.toString('utf8');
      visit(line.replace(/\r$/, ''));
      fragments = [];
      offset = position + newline + 1;
      left = newline + 1;
    }
    if (left < read) fragments.push(Buffer.from(buffer.subarray(left, read)));
    position += read;
  }
  return offset;
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function claudeLine(record, line, since) {
  if (!line.includes('"usage"') || !/"type"\s*:\s*"assistant"/.test(line)) return;
  const entry = parseLine(line), message = entry?.message;
  if (entry?.type !== 'assistant' || !message?.id || !message.usage || !Number.isFinite(Date.parse(entry.timestamp))) return;
  if (localDay(entry.timestamp) < since) return;
  const next = { ...metrics(message.usage, true), at: entry.timestamp, model: message.model || 'unknown' };
  record.messages[message.id] = packMessage(mergeMessage(unpackMessage(record.messages[message.id]), next));
}

function codexLine(record, line) {
  if (!/"(?:session_meta|turn_context|token_count|token_usage_record)"/.test(line)) return;
  const entry = parseLine(line), payload = entry?.payload;
  if (!payload) return;
  if (entry.type === 'session_meta') {
    record.session = payload.id || payload.session_id || record.session;
    record.cwd = payload.cwd || record.cwd;
    record.model = payload.model || record.model;
  } else if (entry.type === 'turn_context') {
    record.cwd = payload.cwd || record.cwd;
    record.model = payload.model || record.model;
  }
  const usage = entry.type === 'event_msg' && payload.type === 'token_count' ? payload.info?.total_token_usage
    : entry.type === 'token_usage_record' ? payload.thread_token_usage : null;
  if (usage && Number.isFinite(Date.parse(entry.timestamp))) {
    record.usage = { ...metrics(usage), at: entry.timestamp, model: record.model || 'unknown' };
  }
}

function logLine(record, line) {
  // Exec's human log footer is a total only; no input/output split can be recovered from it.
  if (record.footer && /^[\d,]+\s*$/.test(line)) record.total = numeric(line.replaceAll(',', '').trim());
  record.footer = line === 'tokens used';
  const session = /^session id: ([a-z0-9-]+)$/i.exec(line);
  const thread = /^(?:\[[^\]]+\] )?turn start thread=([a-z0-9-]+) .*?model=(\S+)/i.exec(line);
  if (session) record.session = session[1];
  if (thread) { record.session = thread[1]; record.model = thread[2]; }
}

function scanFile(state, file, kind, stats, since, knownStat) {
  let fd;
  try {
    const stat = knownStat || fs.statSync(file);
    if (!stat.isFile()) return;
    stats.files++;
    stats.scannedBytes += stat.size;
    let record = state.files[file];
    if (record && record.size === stat.size && record.mtimeMs === stat.mtimeMs &&
        record.ino === stat.ino && record.dev === stat.dev) return true;
    fd = fs.openSync(file, 'r');
    const snapshot = ['status', 'daemon', 'pointer', 'active'].includes(kind);
    const reset = snapshot || !record || record.ino !== stat.ino || record.dev !== stat.dev ||
      stat.size < record.size || stat.size === record.size;
    if (reset) record = { kind, offset: 0, messages: dictionary(), records: dictionary() };
    stats.changedFiles++;
    if (snapshot) {
      if (stat.size > 64 * 1024) return;
      const text = fs.readFileSync(fd, 'utf8');
      stats.bytesRead += Buffer.byteLength(text);
      const value = kind === 'pointer' ? parseLine(text) : kind === 'active' ? { out: text.split(/\r?\n/)[0] } : fields(text);
      record.values = value ? metadata(value) : {};
      record.offset = stat.size;
    } else {
      record.offset = scanLines(fd, record.offset, stat.size, (line) => {
        if (kind === 'claude') claudeLine(record, line, since);
        else if (kind === 'codex') codexLine(record, line);
        else if (kind === 'log') logLine(record, line);
        else if (kind === 'registry') {
          const value = parseLine(line);
          if (localPath(value?.out)) {
            const key = jobKey(value.out, value), previous = record.records[key];
            record.records[key] = { ...previous, ...metadata(value) };
          }
        }
      }, stats);
    }
    Object.assign(record, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
    state.files[file] = record;
    return true;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function outputProject(out, cwd) {
  if (cwd) return project(cwd, true);
  const parts = out.split(path.sep), scratch = parts.lastIndexOf('scratchpad');
  return scratch >= 2 ? project(parts[scratch - 2]) : 'без папки';
}

function addCounters(target, source) {
  for (const key of tokenKeys) target[key] += numeric(source[key]);
}

function aggregate(state, paths, now, since, allJobs = false) {
  const days = state.archive ? structuredClone(state.archive.days) : dictionary();
  const messages = new Map(), claudeJobs = new Map(), codex = new Map(), jobs = new Map();
  const candidates = [], today = localDay(now), weekStart = daysBefore(now, 6);
  for (const job of state.archive?.jobs || []) claudeJobs.set(`${job.project}/${job.name}`, { ...job });
  const add = (provider, model, repo, usage, at, countJob = false, day = null) => {
    if (!day && !Number.isFinite(Date.parse(at))) return;
    day ||= localDay(at);
    if (day < since || day > today) return;
    const bucket = days[day] ||= Object.fromEntries(providers.map((name) => [name, {
      byModel: dictionary(), byProject: dictionary(), ...(name === 'claude' ? {} : { jobs: 0 })
    }]));
    const providerDay = bucket[provider];
    addCounters(providerDay.byModel[model] ||= counters(), usage);
    providerDay.byProject[repo] = (providerDay.byProject[repo] || 0) + usage.total;
    if (countJob) providerDay.jobs++;
  };
  for (const [file, record] of Object.entries(state.files)) {
    if (record.kind === 'claude') {
      const parts = path.relative(paths.projects, file).split(path.sep);
      const session = parts[1]?.replace(/\.jsonl$/, '') || path.basename(file, '.jsonl');
      const repo = project(parts[0]);
      for (const [id, packed] of Object.entries(record.messages)) {
        const message = unpackMessage(packed);
        const previous = messages.get(id);
        // Most messages are unique. Copy counters only when a duplicate actually needs merging.
        messages.set(id, previous ? [mergeMessage({ ...previous[0] }, message), previous[1], previous[2]]
          : [message, repo, session]);
      }
    } else if (record.kind === 'codex' && record.usage) {
      const session = record.session || path.basename(file, '.jsonl');
      if (!codex.has(session) || Date.parse(codex.get(session).usage.at) <= Date.parse(record.usage.at)) codex.set(session, record);
    } else if (record.kind === 'registry') {
      for (const values of Object.values(record.records)) {
        const key = jobKey(values.out, values);
        jobs.set(key, { ...jobs.get(key), ...values });
      }
    }
  }
  for (const [file, record] of Object.entries(state.files)) {
    if (record.kind !== 'status') continue;
    const out = file.slice(0, -7), values = record.values, key = jobKey(out, values);
    const legacy = jobs.get(jobKey(out, {}));
    if (values.started && legacy && !hasUsage(legacy)) {
      jobs.delete(jobKey(out, {}));
      jobs.set(key, { ...legacy, ...jobs.get(key) });
    }
    const previous = jobs.get(key);
    jobs.set(key, hasUsage(previous || {}) ? { ...values, ...previous } : { ...previous, out, ...values });
  }
  const byOutput = new Map();
  for (const [key, values] of jobs) byOutput.set(values.out, key);
  for (const [file, record] of Object.entries(state.files)) {
    if (record.kind === 'daemon') {
      const out = file.slice(0, -7), status = state.files[`${out}.status`]?.values;
      const key = status ? jobKey(out, status) : byOutput.get(out) || jobKey(out, record.values);
      const previous = jobs.get(key);
      jobs.set(key, { out, ...record.values, ...previous });
      byOutput.set(out, key);
    } else if (record.kind === 'log' && record.total !== undefined) {
      const out = file.slice(0, -4);
      if (!byOutput.has(out)) {
        const key = jobKey(out, {});
        jobs.set(key, { out });
        byOutput.set(out, key);
      }
    }
  }
  for (const [message, repo, session] of messages.values()) {
    const day = localDay(message.at);
    add('claude', message.model, repo, message, message.at, false, day);
    const key = `${repo}/${session}`;
    const job = claudeJobs.get(key) || { provider: 'claude', model: message.model, name: session,
      project: repo, total: 0, at: message.at };
    if (Date.parse(message.at) > Date.parse(job.at)) { job.at = message.at; job.model = message.model; }
    // Rank sessions by their usage within the seven-day window, including subagents.
    if (day >= weekStart && day <= today) job.total += message.total;
    claudeJobs.set(key, job);
  }
  candidates.push(...claudeJobs.values());
  const claimed = new Set();
  const metered = new Set([...jobs.values()].filter(hasUsage)
    .map((values) => values.thread || state.files[`${values.out}.log`]?.session).filter(Boolean));
  for (const values of jobs.values()) {
    const out = values.out;
    const log = state.files[`${out}.log`];
    const at = values.finished || values.started || (log?.total !== undefined ? new Date(log.mtimeMs).toISOString() : null);
    const session = values.thread || log?.session;
    const rollout = session && codex.get(session);
    const provider = values.provider === 'gemini' || Object.hasOwn(values, 'acp_model') ? 'gemini' : 'codex';
    let usage;
    if (hasUsage(values)) {
      usage = { ...counters(), input: numeric(values.usage_input), output: numeric(values.usage_output),
        cacheRead: numeric(values.usage_cached),
        total: numeric(values.usage_total ?? numeric(values.usage_input) + numeric(values.usage_output)), messages: 1 };
      if (session) claimed.add(session);
    } else if (provider === 'gemini') continue;
    else if (rollout) {
      if (claimed.has(session) || metered.has(session)) continue;
      claimed.add(session);
      usage = rollout.usage;
    } else if (log?.total !== undefined) usage = { ...counters(), total: log.total, messages: 1 };
    else continue;
    const model = values.acp_model || values.model || rollout?.usage.model || log?.model || 'unknown';
    const repo = outputProject(out, values.dir || rollout?.cwd);
    const timestamp = at || rollout?.usage.at;
    add(provider, model, repo, usage, timestamp, true);
    candidates.push({ provider, model, name: values.name || path.basename(out), project: repo, total: usage.total, at: timestamp });
  }
  for (const [session, record] of codex) {
    if (claimed.has(session)) continue;
    const repo = project(record.cwd, true), model = record.usage.model || 'unknown';
    add('codex', model, repo, record.usage, record.usage.at, true);
    candidates.push({ provider: 'codex', model, name: session, project: repo, total: record.usage.total, at: record.usage.at });
  }
  const topJobs = candidates.filter((job) => job.total > 0 && localDay(job.at) >= weekStart &&
    localDay(job.at) <= today).sort((a, b) => b.total - a.total || b.at.localeCompare(a.at)).slice(0, allJobs ? undefined : 10);
  return { v: 1, at: new Date(now).toISOString(), days, topJobs: allJobs ? [...claudeJobs.values()] : topJobs };
}

// Cold transcripts retain offsets and compact daily/session totals in the hot state. Their message IDs live
// in a separate ledger, opened only on day rollover, resumption, or a cross-file duplicate with an active file.
function restoreArchive(state, paths) {
  if (!state.archive) return;
  const archive = readJson(state.archive.file || paths.archive);
  if (!archive?.files) throw new Error('usage archive is missing or corrupt');
  for (const [file, messages] of Object.entries(archive.files)) {
    if (state.files[file]) {
      for (const [id, message] of Object.entries(messages)) state.files[file].messages[id] = packMessage(message);
      delete state.files[file].archived;
    }
  }
  delete state.archive;
}

function compactArchive(state, paths, now, since) {
  if (state.archive) return;
  const active = new Set(), cold = [];
  for (const [file, record] of Object.entries(state.files)) {
    if (record.kind !== 'claude') continue;
    if (now - record.mtimeMs > 2 * 86_400_000) cold.push([file, record]);
    else for (const id of Object.keys(record.messages)) active.add(id);
  }
  const files = dictionary(), ids = dictionary(), archiveState = { files: dictionary() };
  for (const [file, record] of cold) {
    const messages = dictionary();
    for (const [id, message] of Object.entries(record.messages)) {
      // A message duplicated into a live file stays in the hot ledger on both sides for max-counter merging.
      if (active.has(id)) continue;
      messages[id] = message;
      ids[id] = true;
    }
    if (!Object.keys(messages).length) continue;
    files[file] = messages;
    archiveState.files[file] = { kind: 'claude', messages };
  }
  if (!Object.keys(files).length) return;
  const summary = aggregate(archiveState, paths, now, since, true);
  // Publish the ledger before its reference. An interrupted compaction leaves the original hot state recoverable.
  const file = `${paths.archive}.${randomUUID()}`;
  writeJson(file, { files });
  state.archive = { file, day: localDay(now), days: summary.days, jobs: summary.topJobs, ids: archiveFilter(Object.keys(ids)) };
  for (const [file, messages] of Object.entries(files)) {
    const record = state.files[file];
    for (const id of Object.keys(messages)) delete record.messages[id];
    record.archived = true;
  }
}

export function collectUsage({ env = process.env, now = Date.now() } = {}) {
  const started = performance.now(), paths = usagePaths(env), release = acquireUsageLock(paths);
  if (!release) return { locked: true, bytesRead: 0 };
  try {
    const index = readStateIndex(paths.state);
    let inspected;
    if (index && localDay(index.at) === localDay(now)) {
      const stats = inspected = inspectSources(index, paths);
      const cache = stats.changedFiles ? null : readJson(paths.cache);
      if (cache?.v === 1 && cacheDigest(cache) === index.digest) {
        cache.at = new Date(now).toISOString();
        writeJson(paths.cache, cache);
        return { ...stats, elapsedMs: Math.round(performance.now() - started) };
      }
    }
    let state = readJson(paths.state);
    if (state?.v !== 1 || !state.files) state = { v: 1, files: dictionary() };
    const previousArchive = state.archive ? state.archive.file || paths.archive : null;
    if (!state.packed) {
      for (const record of Object.values(state.files)) {
        for (const [id, message] of Object.entries(record.messages || {})) record.messages[id] = packMessage(message);
      }
    }
    if (state.archive && (!inspected || state.archive.day !== localDay(now))) restoreArchive(state, paths);
    if (state.archive && [...inspected.sources].some(([file, { stat }]) => {
      const record = state.files[file];
      return record?.archived && (record.size !== stat.size || record.mtimeMs !== stat.mtimeMs ||
        record.ino !== stat.ino || record.dev !== stat.dev);
    })) restoreArchive(state, paths);

    const stats = { locked: false, files: 0, changedFiles: 0, bytesRead: 0, scannedBytes: 0 };
    const since = daysBefore(now, 34);
    const scanned = new Set(), changed = new Set(), present = new Set(inspected?.sources.keys()), activeOutputs = new Set();
    const scan = (file, kind) => {
      if (scanned.has(file) || inspected?.missing.has(file)) return;
      scanned.add(file);
      const count = stats.changedFiles;
      if (scanFile(state, file, kind, stats, since, inspected?.sources.get(file)?.stat)) present.add(file);
      if (stats.changedFiles !== count) changed.add(file);
    };
    const outputs = new Set(inspected?.outputs);
    if (inspected) {
      for (const [file, { kind }] of inspected.sources) scan(file, kind);
    } else {
      scan(paths.registry, 'registry');
      walk(paths.projects, (file) => { if (file.endsWith('.jsonl')) scan(file, 'claude'); });
      walk(paths.sessions, (file) => { if (/^rollout-.*\.jsonl$/.test(path.basename(file))) scan(file, 'codex'); });
      walk(paths.run, (file) => {
        if (file.endsWith('.status') || file.endsWith('.daemon')) outputs.add(file.replace(/\.(?:status|daemon)$/, ''));
        else if (jobLog(file)) outputs.add(file.slice(0, -4));
        else if (path.basename(path.dirname(file)) === 'gem-active' && file.endsWith('.json')) scan(file, 'pointer');
        else if (path.basename(path.dirname(file)) === 'active') scan(file, 'active');
      });
    }
    const sinceTime = Date.parse(`${since}T00:00:00`);
    for (const [file, record] of Object.entries(state.files)) {
      if (record.kind === 'registry') {
        for (const [key, values] of Object.entries(record.records)) {
          if (values.finished && localDay(values.finished) < since) delete record.records[key];
          else if (!inspected || changed.has(file)) outputs.add(values.out);
        }
      } else if (record.kind === 'pointer' || record.kind === 'active') {
        if (localPath(record.values?.out) && present.has(file)) {
          outputs.add(record.values.out);
          activeOutputs.add(record.values.out);
        }
      } else if (record.kind === 'status' && (!inspected || present.has(file))) outputs.add(file.slice(0, -7));
      if (record.kind === 'claude' && !inspected) {
        for (const [id, message] of Object.entries(record.messages)) {
          if (Date.parse(Array.isArray(message) ? message[6] : message.at) < sinceTime) delete record.messages[id];
        }
      } else if (record.kind === 'codex' && record.usage && localDay(record.usage.at) < since) delete record.usage;
    }
    for (const out of outputs) {
      if (!localPath(out)) continue;
      scan(`${out}.status`, 'status');
      scan(`${out}.daemon`, 'daemon');
      scan(`${out}.log`, 'log');
    }
    if (state.archive) {
      const ids = state.archive.ids;
      const filter = ids.bits ? { bits: Buffer.from(ids.bits, 'base64'), mask: ids.mask } : null;
      if ([...changed].some((file) => state.files[file]?.kind === 'claude' &&
          Object.keys(state.files[file].messages).some((id) => filter ? filterContains(filter, id) : ids[id]))) {
        restoreArchive(state, paths);
      }
    }
    const cache = aggregate(state, paths, now, since);
    compactArchive(state, paths, now, since);
    // State is authoritative; a crash between renames is repaired by the next collect.
    const files = Object.fromEntries(Object.entries(state.files).map(([file, record]) =>
      [file, [record.size, record.mtimeMs, record.dev, record.ino]]));
    // Deleted scratch files are historical counters, not permanent filesystem poll targets. A new registry
    // record, run-directory file, or live pointer rediscovers an output if its path is reused later.
    const retainedOutputs = [...outputs].filter((out) => activeOutputs.has(out) ||
      ['status', 'daemon', 'log'].some((extension) => present.has(`${out}.${extension}`)));
    writeJson(paths.state, { files: state.files, ...(state.archive ? { archive: state.archive } : {}) }, {
      v: 1, packed: true, at: cache.at, index: files, outputs: retainedOutputs, digest: cacheDigest(cache)
    });
    writeJson(paths.cache, cache);
    if (previousArchive && previousArchive !== state.archive?.file) fs.rmSync(previousArchive, { force: true });
    return { ...stats, elapsedMs: Math.round(performance.now() - started) };
  } finally { release(); }
}

// The first line is a small JSON prefix with file identities, not the message ledger.
// This keeps an idle scan independent of transcript size and the number of past messages.
function readStateIndex(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024), parts = [];
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      const newline = buffer.subarray(0, length).indexOf(10);
      parts.push(Buffer.from(buffer.subarray(0, newline < 0 ? length : newline)));
      if (newline >= 0) {
        const prefix = Buffer.concat(parts).toString('utf8');
        const value = parseLine(prefix.endsWith(',') ? prefix.slice(0, -1) + '}' : prefix);
        return value?.v === 1 && value.index && Array.isArray(value.outputs) ? value : null;
      }
    }
    return null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inspectSources(index, paths) {
  const stats = { locked: false, files: 0, changedFiles: 0, bytesRead: 0, scannedBytes: 0 }, seen = new Set();
  const outputs = new Set(index.outputs), sources = new Map(), missing = new Set();
  Object.defineProperties(stats, { sources: { value: sources }, outputs: { value: outputs }, missing: { value: missing } });
  const inspect = (file, kind) => {
    if (seen.has(file)) return;
    seen.add(file);
    let stat;
    try { stat = fs.statSync(file); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      missing.add(file);
      return;
    }
    if (!stat.isFile()) return;
    sources.set(file, { stat, kind });
    stats.files++;
    stats.scannedBytes += stat.size;
    const saved = index.index[file];
    if (!saved || saved[0] !== stat.size || saved[1] !== stat.mtimeMs || saved[2] !== stat.dev || saved[3] !== stat.ino) {
      stats.changedFiles++;
    }
  };
  inspect(paths.registry, 'registry');
  walk(paths.projects, (file) => { if (file.endsWith('.jsonl')) inspect(file, 'claude'); });
  walk(paths.sessions, (file) => { if (/^rollout-.*\.jsonl$/.test(path.basename(file))) inspect(file, 'codex'); });
  walk(paths.run, (file) => {
    if (file.endsWith('.status') || file.endsWith('.daemon')) outputs.add(file.replace(/\.(?:status|daemon)$/, ''));
    else if (jobLog(file)) outputs.add(file.slice(0, -4));
    else if (path.basename(path.dirname(file)) === 'gem-active' && file.endsWith('.json')) inspect(file, 'pointer');
    else if (path.basename(path.dirname(file)) === 'active') inspect(file, 'active');
  });
  for (const out of outputs) {
    if (!localPath(out)) continue;
    for (const extension of ['status', 'daemon', 'log']) inspect(`${out}.${extension}`, extension);
  }
  return stats;
}

export function summarizeUsage(cache, now = Date.now()) {
  const today = Object.fromEntries(providers.map((provider) => [provider, totals()]));
  const week = Object.fromEntries(providers.map((provider) => [provider, totals()]));
  const models = new Map(), projects = new Map(), days = [];
  for (let index = 6; index >= 0; index--) {
    const date = daysBefore(now, index), day = { date, claude: 0, codex: 0, gemini: 0 };
    for (const provider of providers) {
      const bucket = cache?.days?.[date]?.[provider];
      for (const [model, usage] of Object.entries(bucket?.byModel || {})) {
        const sum = { total: numeric(usage.total), input: numeric(usage.input), output: numeric(usage.output),
          cached: numeric(usage.cacheRead) + numeric(usage.cacheWrite) };
        day[provider] += sum.total;
        for (const key of Object.keys(sum)) {
          week[provider][key] += sum[key];
          if (index === 0) today[provider][key] += sum[key];
        }
        const id = `${provider}/${model}`, row = models.get(id) || { provider, model, ...totals() };
        for (const key of Object.keys(sum)) row[key] += sum[key];
        models.set(id, row);
      }
      for (const [repo, total] of Object.entries(bucket?.byProject || {})) {
        const row = projects.get(repo) || { project: repo, total: 0, claude: 0, codex: 0, gemini: 0 };
        row.total += numeric(total);
        row[provider] += numeric(total);
        projects.set(repo, row);
      }
    }
    days.push(day);
  }
  const topJobs = (cache?.topJobs || []).filter((job) => Number.isFinite(Date.parse(job.at)) &&
    localDay(job.at) >= days[0].date && localDay(job.at) <= days[6].date).sort((a, b) => b.total - a.total).slice(0, 10);
  return {
    at: cache?.at || null, today, week, days,
    byModel7d: [...models.values()].sort((a, b) => b.total - a.total),
    byProject7d: [...projects.values()].sort((a, b) => b.total - a.total), topJobs
  };
}

// Poll callers read this compact cache only. They never open state, transcripts, logs, or the registry.
export function readUsageSummary({ env = process.env, now = Date.now() } = {}) {
  const cache = readJson(usagePaths(env).cache);
  return summarizeUsage(cache?.v === 1 ? cache : null, now);
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === 'collect' && args.length === 1) return collectUsage();
  if (args[0] === 'summary' && (args.length === 1 || args.length === 2 && args[1] === '--json')) return readUsageSummary();
  throw new Error('usage: usage.mjs collect | summary [--json]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(), null, process.argv.includes('--json') ? undefined : 2) + '\n'); }
  catch (error) { process.stderr.write(`usage: ${error.message}\n`); process.exitCode = 1; }
}
