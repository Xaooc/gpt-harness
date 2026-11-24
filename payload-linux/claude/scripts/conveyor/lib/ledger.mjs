import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { entryText, isGenuineHumanEntry } from '../../learning/extract.mjs';
import { readJsonl, sanitizeQuote } from '../../learning/common.mjs';
import { withLock } from './orchestration.mjs';
import { repositorySurface, uiFile } from './profile.mjs';
import { deliveryInputs, deliveryReview, unansweredFindings } from './delivery.mjs';
import { home, platform, processAlive, readProcessStat, shell } from './platform.mjs';
import { clauseHints, foldLedger, latestMessages } from './request-state.mjs';
import { collectTaskScope, inside, worktreeFor } from './task-scope.mjs';
import { homePaths as diskHomePaths, localDate, parseLock, worktrees } from '../../disk/lib.mjs';

export { foldLedger } from './request-state.mjs';

const execute = promisify(execFile);
const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stopVersion = 2;
const turnCheckVersion = 1;
const fingerprint = (value) => hash(JSON.stringify(value));
const sortedIdentities = (values) => values.sort((a, b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const left = '(?<![\\p{L}\\p{N}_])';
const right = '(?![\\p{L}\\p{N}_])';

// Deliberately deterministic, rather than a language model classifier. Tests pin this rule table.
export const CLAUSE_RULES = {
  firstWords: 2,
  russianEndings: ['й', 'йте', 'и', 'ите'],
  russianVerbs: ['сделай', 'добавь', 'проверь', 'убери', 'напиши', 'перепиши', 'поставь', 'запусти', 'давай'],
  russianMarkers: [
    'надо', 'нужно', 'должен', 'должна', 'должно', 'необходимо', 'хочу', 'пусть', 'обязательно',
    'не забудь', 'нельзя', 'не надо', 'никогда', 'всегда', 'чтобы'
  ],
  englishMarkers: [
    'please', 'must', 'should', 'need to', 'make', 'add', 'fix', 'remove', 'ensure', "don't", 'never', 'always', 'I want'
  ]
};

const markers = [...CLAUSE_RULES.russianMarkers, ...CLAUSE_RULES.englishMarkers];
const markerPattern = new RegExp(left + '(?:' + markers.map((word) => word.replace(/ /g, '\\s+')).join('|') + ')' + right, 'iu');
const endingPattern = new RegExp('(?:' + CLAUSE_RULES.russianEndings.join('|') + ')$', 'iu');

function withoutPastes(text) {
  return text.replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content\s*>|$)/gi, '\n');
}

function withoutFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    if (marker) { fence = marker; return ''; }
    return line;
  }).join('\n');
}

export function humanWords(text, stripAssistant = true) {
  const clean = withoutFences(withoutPastes(String(text))).replace(/^[ \t]*>[^\n]*/gm, '');
  if (!stripAssistant) return clean;
  return clean.replace(/<transcript\b[^>]*>[\s\S]*?(?:<\/transcript\s*>|$)/gi, '\n')
    .replace(/^[ \t]*\[(user|assistant)(?:[ \t]+[^\]\r\n]+)?\][\s\S]*?\[\/\1\]/gim, '\n')
    .replace(/^[ \t]*[-*•][ \t]+L\d+[ \t]+(?:[✓✗]|waived\b)[^\n]*/gm, '')
    .replace(/^[ \t]*(?:[-*•✻⏺●][ \t]+)?Выполнено[ \t]+\d+[ \t]+команд[^\n]*/gim, '')
    .replace(/^[ \t]*(?:[-*•✻⏺●][ \t]+)?Хук отправил Claude повторный запрос[^\n]*/gim, '');
}

export function extractClauses(text, message = 'M1', stripAssistant = true) {
  const clean = humanWords(text, stripAssistant)
    .replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '').replace(/•/g, '\n');
  const sentences = clean.match(/[^.!?\r\n]+[.!?]?/gu) || [];
  const clauses = [];
  for (const sentence of sentences) {
    const value = sentence.trim();
    if (value.endsWith('?')) continue;
    const words = value.match(/[\p{L}]+/gu) || [];
    const imperative = markerPattern.test(value) || words.slice(0, CLAUSE_RULES.firstWords)
      .some((word) => CLAUSE_RULES.russianVerbs.includes(word.toLowerCase()) || /^[а-яё]+$/iu.test(word) && endingPattern.test(word));
    if (value && imperative) clauses.push({ id: `${message}.c${clauses.length + 1}`, text: value });
  }
  return clauses;
}

export function eligiblePrompt(text) {
  return typeof text === 'string' && !!withoutPastes(text).trim() && !text.trimStart().startsWith('/');
}

export function claudeHome() {
  return process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), '.claude');
}

const validSession = (session) => typeof session === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(session);

export function ledgerHome() {
  return path.resolve(process.env.CONVEYOR_HOME || path.join(claudeHome(), 'conveyor'));
}

export function ledgerPaths(session) {
  if (!validSession(session)) throw new Error('invalid or missing session id');
  const home = ledgerHome();
  return {
    home, ledger: path.join(home, 'ledgers', `${session}.jsonl`), runs: path.join(home, 'sessions', `${session}.jsonl`),
    context: path.join(home, 'sessions', `${session}.ledger.json`), bases: path.join(home, 'sessions', `${session}.base.json`),
    calibration: path.join(home, 'gate-calibration-start'),
    stops: path.join(home, 'gate-state', `${session}.json`)
  };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n');
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function appendRecord(session, record) {
  const file = ledgerPaths(session).ledger;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: now(), ...record }) + '\n');
  return record;
}

export function rememberContext(event) {
  const session = event.session_id;
  const file = ledgerPaths(session).context;
  const previous = readJson(file, {});
  const context = {
    ...previous, session, transcript: event.transcript_path || previous.transcript,
    cwd: path.resolve(event.cwd || previous.cwd || process.cwd())
  };
  writeJson(file, context);
  return context;
}

export function sessionContext(session) {
  const saved = readJson(ledgerPaths(session).context, {});
  let transcript = process.env.CLAUDE_CODE_TRANSCRIPT_PATH || saved.transcript;
  if (!transcript) {
    const projects = path.join(claudeHome(), 'projects');
    if (fs.existsSync(projects)) {
      for (const directory of fs.readdirSync(projects, { withFileTypes: true })) {
        const candidate = path.join(projects, directory.name, `${session}.jsonl`);
        if (directory.isDirectory() && fs.existsSync(candidate)) { transcript = candidate; break; }
      }
    }
  }
  return { session, transcript, cwd: path.resolve(saved.cwd || process.cwd()) };
}

// extract.mjs's offset iterator is private. Read complete JSONL rows as bytes, retaining UTF-8 offsets.
export function transcriptRows(context) {
  if (!context.transcript) throw new Error('session transcript unavailable; run prompt capture first');
  const buffer = fs.readFileSync(context.transcript);
  const rows = [];
  for (let offset = 0, end; (end = buffer.indexOf(10, offset)) !== -1; offset = end + 1) {
    let entry;
    try { entry = JSON.parse(buffer.subarray(offset, end).toString('utf8')); } catch { continue; }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const session = entry.sessionId ?? entry.session_id;
    if (session && session !== context.session) continue;
    rows.push({ entry, offset, end: end + 1 });
  }
  return rows;
}

function nextId(records, prefix) {
  return prefix + (records.reduce((maximum, record) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(record.id || record.successor?.id || '');
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1);
}

function messageRecord(id, text, meta = {}) {
  return { type: 'message', id, at: now(), uuid: meta.uuid || `hook:${randomUUID()}`, text: text.slice(0, 4000),
    clauses: extractClauses(text, id), digest: hash(text), ...meta };
}

export function ledgerTransaction(context, work) {
  const file = ledgerPaths(context.session).ledger;
  return withLock(file, () => {
    const records = readJsonl(file);
    const firstNew = records.length;
    const put = (record) => records.push({ at: now(), ...record });
    const result = work(records, put);
    if (records.length > firstNew) {
      fs.appendFileSync(file, records.slice(firstNew).map((record) => JSON.stringify(record) + '\n').join(''));
    }
    return result;
  });
}

function hasImage(entry) {
  const content = entry.message?.content ?? entry.content;
  return Array.isArray(content) && content.some((block) => block?.type === 'image');
}

function ownerRow({ entry }) {
  const text = entryText(entry);
  return isGenuineHumanEntry(entry) && (eligiblePrompt(text) || (!text.trim() && hasImage(entry)));
}

function syncMessages(records, put, rows) {
  const stored = [...latestMessages(records).values()];
  const used = new Set();
  for (const row of rows) {
    if (!ownerRow(row)) continue;
    const text = entryText(row.entry), digest = hash(text);
    const uuid = row.entry.uuid || `transcript:${row.offset}`;
    const message = stored.find((value) => !used.has(value.id) && value.uuid === uuid)
      || stored.find((value) => !used.has(value.id) && value.digest === digest && value.offset === row.offset)
      || stored.find((value) => !used.has(value.id) && value.pending && value.digest === digest
        && (value.offset < row.offset || value.offset === row.end));
    const id = message?.id || nextId(records, 'M');
    used.add(id);
    if (!message || message.pending || message.digest !== digest || message.offset !== row.offset) {
      put(messageRecord(id, text, {
        uuid, hookId: message?.hookId, offset: row.offset, pending: false, at: row.entry.timestamp || message?.at || now(),
        ...(message?.digest === digest ? { clauses: message.clauses } : {})
      }));
    }
  }
}

function startRecord(context, records, message, origin, note) {
  return { type: 'start', id: nextId(records, 'T'), version: 2, origin, at: now(),
    messageId: message.id, uuid: message.uuid, offset: message.offset, transcript: context.transcript, note };
}

export async function capturePrompt(event) {
  const context = rememberContext(event);
  if ((event.source && !['user', 'sdk'].includes(event.source)) || !eligiblePrompt(event.prompt)) return null;
  const human = { type: 'user', message: { content: event.prompt } };
  if (event.source === 'user' || event.source === 'sdk') human.origin = { kind: 'human' };
  if (!isGenuineHumanEntry(human)) return null;
  await recordSessionBases(context);
  return ledgerTransaction(context, (records, put) => {
    const state = foldLedger(records);
    let record = event.prompt_id && state.allMessages.find((message) =>
      message.uuid === event.prompt_id || message.hookId === event.prompt_id);
    if (record && !state.delivered) return null;
    if (state.delivered) {
      // The transcript may have been synchronized before the hook acquired the lock.
      const beforeDelivery = latestMessages(records.slice(0, records.indexOf(state.delivery)));
      if (record && beforeDelivery.has(record.id)) return null;
      if (!event.prompt_id) {
        const digest = hash(event.prompt);
        record = state.allMessages.find((message) => message.digest === digest && !message.pending && !beforeDelivery.has(message.id));
      }
    }
    if (!record) {
      const offset = context.transcript && fs.existsSync(context.transcript) ? fs.statSync(context.transcript).size : 0;
      record = messageRecord(nextId(records, 'M'), event.prompt, {
        hookId: event.prompt_id, offset, pending: true, ...(event.prompt_id ? { uuid: event.prompt_id } : {})
      });
      put(record);
    }
    const started = state.delivered ? startRecord(context, records, record, 'auto') : null;
    if (started) put(started);
    return { record, started, taskOpen: !!state.task };
  });
}

export function quoteVerified(context, task, quote, rows = transcriptRows(context)) {
  return !!task && typeof quote === 'string' && quote.trim().length >= 12 && rows.some(({ entry, offset }) => {
    return offset >= task.offset && isGenuineHumanEntry(entry) && humanWords(entryText(entry)).includes(quote);
  });
}

function liveState(context, records, rows) {
  // Recheck recorded waivers against the transcript of the request in which they were written.
  let task = null;
  const tasks = new Map(), byId = latestMessages(records);
  const starts = records.filter((record) => record.type === 'start').map((record) => ({
    ...record, offset: byId.get(record.messageId)?.offset ?? record.offset
  }));
  for (const [index, start] of starts.entries()) {
    tasks.set(start.id, { start, end: starts[index + 1]?.offset ?? Infinity });
  }
  const verified = records.map((record) => {
    if (record.type === 'start') task = tasks.get(record.id);
    if (record.type !== 'waive') return record;
    if (record.verified !== true) return { ...record, verified: false };
    const request = record.taskId === undefined ? task : tasks.get(record.taskId);
    const requestRows = rows.filter(({ offset }) => offset < request?.end);
    return { ...record, verified: quoteVerified(context, request?.start, record.quote, requestRows) };
  });
  const state = foldLedger(verified);
  const byOffset = new Map(rows.filter(ownerRow).map((row) => [row.offset, row.entry]));
  const primary = new Map();
  for (const message of state.messages) {
    const entry = byOffset.get(message.offset);
    if (!entry || message.pending || message.uuid !== (entry.uuid || `transcript:${message.offset}`)) continue;
    const text = entryText(entry);
    if (!eligiblePrompt(text)) continue;
    primary.set(message.id, { ...message, text, clauses: extractClauses(text, message.id, !state.legacy) });
  }
  state.primaryMessages = [...primary.values()];
  if (!state.legacy) {
    state.messages = state.messages.map((message) => {
      const source = primary.get(message.id);
      return source ? { ...source, text: source.text.slice(0, 4000) } : message;
    });
    state.hints = clauseHints(state, state.messages);
  }
  return state;
}

export function withSyncedLedger(context, work, rows) {
  return ledgerTransaction(context, (records, put) => {
    rows ??= transcriptRows(context);
    syncMessages(records, put, rows);
    return work(liveState(context, records, rows), records, put, rows);
  });
}

export function loadLedger(context, rows) {
  return withSyncedLedger(context, (state) => state, rows);
}

export async function startTask(context, note) {
  await recordSessionBases(context);
  return withSyncedLedger(context, (state, records, put, rows) => {
    const first = state.allMessages.findLast((message) => message.pending || rows.some((row) =>
      row.offset === message.offset && ownerRow(row)));
    if (!first) throw new Error('no genuine user prompt in this session');
    if (state.task?.messageId === first.id) return state;
    put(startRecord(context, records, first, 'manual', note));
    return liveState(context, records, rows);
  });
}

function findItem(state, id) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`unknown item: ${id}`);
  if (item.status === 'superseded') throw new Error(`item was superseded: ${id}`);
  return item;
}

function requireTask(state) {
  if (!state.task) throw new Error('start the ledger and play back the requirements');
}

function knownSource(state, id) {
  return [...state.messages, ...state.primaryMessages].some((message) =>
    message.id === id || message.clauses.some((clause) => clause.id === id))
    || state.findings.some((finding) => finding.id === id)
    || state.crosschecks.some((check) => check.findings?.some((finding) => finding.id === id));
}

function ownerMessage(state, rows, id) {
  const message = state.messages.find((entry) => entry.id === id && !entry.pending);
  const row = message && rows.find(({ offset }) => offset === message.offset);
  if (!row || !ownerRow(row) || message.uuid !== (row.entry.uuid || `transcript:${row.offset}`)) {
    throw new Error(`unknown genuine owner message: ${id}`);
  }
  return row;
}

export function linkSource(context, clause, target, reason) {
  return withSyncedLedger(context, (state, records, put) => {
    requireTask(state);
    if (!knownSource(state, clause) || /^M\d+$/.test(clause)) throw new Error(`unknown clause or finding: ${clause}`);
    if (target === 'none') {
      if (!reason?.trim()) throw new Error('link none requires --reason');
    } else findItem(state, target);
    const answer = state.links[clause];
    if (state.findings.some(({ id }) => id === clause) && answer) {
      if (answer.item === target && answer.reason === reason) return;
      throw new Error(`finding already answered: ${clause}`);
    }
    put({ type: 'link', taskId: state.task.id, clause, item: target, reason });
  });
}

function outcomePaths(context, files) {
  return [...new Set(files.map((file) => path.resolve(context.cwd, file)))].sort();
}

export function addItem(context, text, sources, files) {
  return withSyncedLedger(context, (state, records, put) => {
    requireTask(state);
    if (!text?.trim() || !sources.length) throw new Error('add requires text and --from sources');
    for (const source of sources) {
      if (!knownSource(state, source)) throw new Error(`unknown source: ${source}`);
      if (state.findings.some(({ id }) => id === source) && state.links[source]) {
        throw new Error(`finding already answered: ${source}`);
      }
    }
    const id = nextId(records, 'L');
    put({ type: 'item', taskId: state.task.id, id, text, sources, status: 'open',
      ...(files && { paths: outcomePaths(context, files) }) });
    return id;
  });
}

export function amendItem(context, id, source, text, files) {
  return withSyncedLedger(context, (state, records, put, rows) => {
    const item = findItem(state, id);
    ownerMessage(state, rows, source);
    if (!text?.trim()) throw new Error('amend requires corrected outcome text');
    const paths = files && outcomePaths(context, files);
    if (text.trim() !== item.text.trim() || (paths && JSON.stringify(paths) !== JSON.stringify(item.paths))) {
      put({ type: 'amend', taskId: state.task.id, item: id, revision: item.revision, source, text: text.trim(),
        ...(paths && { paths }) });
    }
  });
}

export function markPending(context, id, reason) {
  return withSyncedLedger(context, (state, records, put, rows) => {
    const item = findItem(state, id);
    if (!reason?.trim()) throw new Error('pending requires --reason');
    if (item.status === 'waived') throw new Error(`item is waived: ${id}`);
    if (item.pending?.reason === reason.trim()) return;
    put({ type: 'pending-owner', taskId: state.task.id, item: id, revision: item.revision,
      reason: reason.trim(), offset: rows.at(-1)?.end ?? 0 });
  });
}

export function resolvePending(context, id, source, result) {
  return withSyncedLedger(context, (state, records, put, rows) => {
    requireTask(state);
    const request = [state, ...state.archived].find(({ items }) => items.some((item) => item.id === id));
    const item = request?.items.find((entry) => entry.id === id);
    if (!item?.pending) throw new Error(`item is not pending owner verification: ${id}`);
    if (!['accepted', 'needs-work'].includes(result)) throw new Error('--result must be accepted or needs-work');
    const { entry, offset } = ownerMessage(state, rows, source);
    const reply = humanWords(entryText(entry)).trim();
    if (offset < item.pending.offset || !reply || /^(?:thanks|thank you|спасибо)[.! ]*$/iu.test(reply)) {
      throw new Error('resolution requires a later owner reply');
    }
    const successor = result === 'needs-work' ? {
      type: 'item', id: nextId(records, 'L'), taskId: state.task.id, text: item.text,
      sources: [source], previousItem: id, status: 'open'
    } : undefined;
    put({ type: 'pending-resolution', taskId: request.task.id, item: id, revision: item.revision, source, result, successor });
    return successor?.id;
  });
}

export async function runCommand(command, args = [], cwd = process.cwd()) {
  let argv;
  if (Array.isArray(command)) argv = [...command, ...args];
  else if (command.trim().startsWith('[')) argv = [...JSON.parse(command), ...args];
  else if (fs.existsSync(command)) argv = [command, ...args];
  else argv = [...shell(), `${command} "$@"`, 'conveyor', ...args];
  if (!argv.length || argv.some((value) => typeof value !== 'string')) throw new Error('invalid command');
  try {
    const result = await execute(argv[0], argv.slice(1), {
      cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 600_000, maxBuffer: 32 * 1024 * 1024
    });
    return { rc: 0, ...result };
  } catch (error) {
    return { rc: typeof error.code === 'number' ? error.code : 2, stdout: error.stdout || '',
      stderr: error.stderr || error.message };
  }
}

function evidenceRecord(context, state, id, kind, value) {
  const item = findItem(state, id);
  return { type: 'evidence', taskId: state.task.id, item: id, revision: item.revision, kind, value, at: now(),
    offset: context.transcript ? fs.statSync(context.transcript).size : null };
}

export async function addEvidence(context, id, kind, value, expectedRc = 0) {
  if (kind !== 'command') {
    return withSyncedLedger(context, (state, records, put, rows) => {
      const record = evidenceRecord(context, state, id, kind, value);
      if (kind === 'owner-message') {
        const { entry, offset } = ownerMessage(state, rows, value);
        if (!hasImage(entry)) throw new Error(`owner message has no image: ${value}`);
        record.offset = offset;
      } else if (['file', 'artifact', 'check'].includes(kind)) {
        record.value = path.resolve(context.cwd, value);
        record.mtime = fs.statSync(record.value).mtimeMs;
        if (kind === 'check') record.ok = checkEvidencePassed(record.value);
      }
      put(record);
      return record.ok === false ? 1 : 0;
    });
  }
  const record = evidenceRecord(context, await loadLedger(context), id, kind, value);
  const result = await runCommand(value, [], context.cwd);
  record.rc = result.rc;
  record.expectedRc = expectedRc;
  record.cwd = context.cwd;
  record.at = now();
  record.output = sanitizeQuote(result.stdout || result.stderr, 800);
  await withSyncedLedger(context, (current, records, put) => {
    if (current.task?.id !== record.taskId || findItem(current, id).revision !== record.revision) {
      throw new Error(`request or outcome changed while recording evidence for ${id}`);
    }
    put(record);
  });
  return result.rc === expectedRc ? 0 : 1;
}

export function markDone(context, id) {
  return withSyncedLedger(context, (state, records, put) => {
    const item = findItem(state, id);
    put({ type: 'done', taskId: state.task.id, item: id, revision: item.revision });
  });
}

export async function waive(context, target, quote) {
  if (target === 'crosscheck') target = 'deliver';
  let snapshot;
  if (target === 'deliver') {
    const state = await loadLedger(context);
    requireTask(state);
    snapshot = await deliveryInputs(context, state);
  }
  return withSyncedLedger(context, (state, records, put, rows) => {
    requireTask(state);
    const item = ['gate', 'deliver'].includes(target) ? null : findItem(state, target);
    if (snapshot && (state.task.id !== snapshot.taskId || deliveryReview(state, snapshot.fingerprint)?.status !== 'unavailable')) {
      throw new Error('only an unavailable review for the current delivery may be waived');
    }
    const first = state.messages.find((message) => message.id === state.task.messageId);
    const verified = quoteVerified(context, { ...state.task, offset: first?.offset ?? state.task.offset }, quote, rows);
    const id = nextId(records, 'W');
    put({ type: 'waive', taskId: state.task.id, id, target, revision: item?.revision, quote, verified,
      ...(snapshot && { fingerprint: snapshot.fingerprint }) });
    return { id, verified };
  });
}

export function checklist(state, { showRevision = false } = {}) {
  return state.items.map((item) => {
    const status = item.status === 'waived' ? 'waived' : item.status === 'done' ? '✓' : '✗';
    const marker = showRevision ? `(revision ${item.revision}, ${item.status})` : status;
    const evidence = item.status === 'waived' ? state.waivers.findLast((waiver) => waiver.target === item.id && waiver.verified)?.quote
      : item.evidence.map((entry) => `${entry.kind}: ${entry.value}${entry.rc === undefined ? '' : ` (rc ${entry.rc})`}`).join('; ');
    const detail = showRevision && (item.pending?.reason || item.resolution?.source);
    return `- ${item.id} ${marker} ${item.text.replace(/\s+/g, ' ')} — ${sanitizeQuote(detail || evidence || 'no evidence', 500)}`;
  }).join('\n');
}

// Non-Git changes and provisional requests apply only to code paths.
export const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.fish', '.rs', '.go', '.java',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.lua', '.pl', '.r',
  '.sql', '.css', '.scss', '.less', '.sass', '.html', '.htm', '.vue', '.svelte', '.astro', '.json', '.jsonc',
  '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.gradle', '.proto', '.tf', '.hcl', '.ex', '.exs',
  '.erl', '.hrl', '.clj', '.cljs', '.edn', '.ps1', '.psm1', '.bat', '.cmd', '.dockerfile', '.make', '.ipynb'
]);

function codePath(file) {
  return CODE_EXTENSIONS.has(path.extname(file).toLowerCase())
    || /^(Dockerfile|Makefile|CMakeLists\.txt|Gemfile)$/i.test(path.basename(file));
}

function codeWrites(rows, cwd) {
  const files = new Set();
  const add = (file) => {
    if (typeof file !== 'string') return;
    if (codePath(file)) files.add(path.resolve(cwd, file));
  };
  for (const { entry } of rows) {
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Bash' && typeof block.input?.command === 'string') {
        const command = block.input.command;
        const token = /"([^"\n]*)"|'([^'\n]*)'|([^\s;&|<>]+)/g;
        for (const match of command.matchAll(/>>?\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|<>]+))/g)) {
          add(match[1] ?? match[2] ?? match[3]);
        }
        for (const match of command.matchAll(/(?:^|[;&|\n])\s*(?:sed\s+-[^\s]*i[^\s]*|tee\b)([^;&|\n]*)/g)) {
          for (const value of match[1].matchAll(token)) add(value[1] ?? value[2] ?? value[3]);
        }
      }
      if (!['Write', 'Edit', 'MultiEdit'].includes(block.name)) continue;
      const inputs = [block.input, ...(block.input?.edits || [])];
      for (const input of inputs) {
        add(input?.file_path);
      }
    }
  }
  return [...files];
}

export async function git(repo, args) {
  const result = await runCommand(['git', '-C', repo, ...args]);
  if (result.rc !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout;
}

function checkPassed(check) {
  return check?.gate?.status === 'pass' && (check.code === undefined || check.code === 0);
}

function checkEvidencePassed(file) {
  try { return checkPassed(readJson(file)); }
  catch { return false; }
}

function sessionRuns(context) {
  return readJsonl(ledgerPaths(context.session).runs).filter((run) => run.session === context.session
    && typeof run.repo === 'string');
}

async function repositoryRoot(directory) {
  const result = await runCommand(['git', '-C', directory, 'rev-parse', '--show-toplevel']);
  if (result.rc === 128) return null;
  if (result.rc !== 0) throw new Error(`git rev-parse: ${result.stderr.trim()}`);
  return result.stdout.trim() || null;
}

export async function recordSessionBases(context) {
  const file = ledgerPaths(context.session).bases, bases = readJson(file, {});
  const captured = {};
  const root = await repositoryRoot(context.cwd);
  const candidates = [...sessionRuns(context), ...(root ? [{ repo: root }] : [])];
  for (const candidate of candidates) {
    const directory = path.resolve(context.cwd, candidate.repo);
    const repo = directory === root ? root : await repositoryRoot(directory);
    if (!repo) continue;
    if (bases[repo] || captured[repo]) continue;
    const base = candidate.base || (await git(repo, ['rev-parse', 'HEAD'])).trim();
    if (base) captured[repo] = base;
  }
  if (Object.keys(captured).length) {
    await withLock(file, () => writeJson(file, { ...captured, ...readJson(file, {}) }));
  }
}

async function changedNames(repo, base) {
  const tracked = await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, '--']);
  const staged = await git(repo, ['diff', '--cached', '--name-only', '--no-renames', '-z', base, '--']);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const committed = await git(repo, ['log', '--format=', '--name-only', '--no-renames', '-m', '-z', `${base}..HEAD`, '--']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  return { files: [...new Set((tracked + staged + untracked + committed).split('\0').filter(Boolean))].sort(),
    untracked: [...new Set(untracked.split('\0').filter(Boolean))].sort(), head };
}

export async function sessionRepos(context, rows = transcriptRows(context)) {
  const runs = sessionRuns(context), bases = readJson(ledgerPaths(context.session).bases, {});
  const repos = [];
  const add = async (repo, base) => {
    if (repos.some((entry) => entry.repo === repo)) return;
    const revision = bases[repo] || base || (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const changes = await changedNames(repo, revision);
    const changed = changes.files.length > 0 || (changes.head !== revision
      && !!(await git(repo, ['log', '--format=%H', '--max-count=1', `${revision}..HEAD`, '--'])).trim());
    repos.push({ repo, base: revision, ...changes, changed });
  };
  const root = await repositoryRoot(context.cwd);
  if (root) await add(root, runs.find((run) => path.resolve(context.cwd, run.repo) === root)?.base);
  for (const run of runs) {
    const repo = await repositoryRoot(path.resolve(context.cwd, run.repo));
    if (repo) await add(repo, run.base);
  }
  const writes = codeWrites(rows, context.cwd);
  for (const file of writes) {
    if (repos.some(({ repo }) => inside(repo, file))) continue;
    let directory = path.dirname(file);
    while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
    const repo = await repositoryRoot(directory);
    if (repo) await add(repo);
  }
  const nonGit = !root && writes.length > 0;
  return { applies: nonGit || repos.some((repo) => repo.changed), repos, nonGit, writes };
}

export async function ownedScope(context, state, rows = transcriptRows(context)) {
  const boundary = state.task
    ? state.messages.find((message) => message.id === state.task.messageId) || state.task
    : state.primaryMessages.at(-1);
  return collectTaskScope(context, boundary && { offset: boundary.offset, uuid: boundary.uuid,
    at: boundary.at, id: state.task?.id }, rows);
}

export async function scopedRepos(context, scope) {
  const file = ledgerPaths(context.session).bases;
  const bases = readJson(file, {}), runs = sessionRuns(context);
  const repos = [];
  for (const [repo, paths] of scope.repos) {
    let base = bases[repo];
    if (!base) {
      const captured = runs.find((run) => run.repo === repo && run.base)?.base
        || (await git(repo, ['rev-parse', 'HEAD'])).trim();
      base = await withLock(file, () => {
        const current = readJson(file, {});
        if (!current[repo]) writeJson(file, { ...current, [repo]: captured });
        return current[repo] || captured;
      });
    }
    repos.push({ repo, base, files: [...paths.keys()].map((file) => path.relative(repo, file)).sort() });
  }
  return repos;
}

export function latestEvidence(item) {
  return [...new Map(item.evidence.map((entry) => [JSON.stringify([entry.kind, entry.value]), entry])).values()];
}

function proofRecorded(evidence) {
  return (evidence.kind === 'command' && evidence.rc === 0) || evidence.kind === 'owner-message'
    || (evidence.kind === 'artifact' && Number.isFinite(evidence.mtime))
    || (evidence.kind === 'check' && evidence.ok === true);
}

function artifactTime(evidence) {
  let stat;
  try { stat = fs.statSync(evidence.value); } catch { /* An inaccessible artifact cannot qualify. */ }
  if (!stat?.isFile()) return null;
  return Number.isFinite(evidence.mtime) ? Math.min(stat.mtimeMs, evidence.mtime) : stat.mtimeMs;
}

const disposed = (item) => ['waived', 'pending-owner', 'superseded'].includes(item.status);
const itemIdentity = (item) => [item.id, item.revision];

async function outcomeProblems(state, scope) {
  const open = [], lost = [];
  for (const item of state.items) {
    if (disposed(item) || item.resolution?.result === 'accepted') continue;
    const failures = [];
    let supported = false;
    for (const evidence of latestEvidence(item)) {
      const failure = await proofProblem(item, evidence, scope);
      if (!failure) { supported = true; break; }
      failures.push({ ...failure, evidence });
    }
    if (supported) continue;
    const initiallyStale = new Set(failures.filter((failure) => failure.initiallyStale).map(({ evidence }) => evidence));
    if (item.status === 'done' || item.evidence.some((entry) => proofRecorded(entry) && !initiallyStale.has(entry))
      || item.previousEvidence.some(proofRecorded)) {
      lost.push({ item, failures });
    } else open.push(item);
  }
  return { open, lost };
}

async function proofProblem(item, evidence, scope) {
  if (evidence.kind === 'command') return evidence.rc === 0 ? null : { type: 'command failed' };
  if (evidence.kind === 'owner-message') return null;
  if (!['artifact', 'check'].includes(evidence.kind)) return { type: 'supporting evidence only' };
  let jobDir;
  if (evidence.kind === 'check') {
    let dispatch;
    try { dispatch = readJson(evidence.value); } catch { /* An unreadable report is red. */ }
    if (evidence.ok === false || !checkPassed(dispatch)) return { type: 'check evidence is red' };
    jobDir = dispatch.gate.last?.repo ?? dispatch.dir;
  }
  const mtime = artifactTime(evidence);
  if (mtime === null) return { type: 'file/artifact evidence missing', where: evidence.value };
  const newer = (writes) => [...(writes || [])].filter(([file, at]) => at > mtime && (!item.paths || item.paths.includes(file)));
  const allNewer = [...scope.repos.values(), scope.nonGit].flatMap(newer);
  if (!allNewer.length) return null;
  const repo = typeof jobDir === 'string' && path.isAbsolute(jobDir)
    ? await worktreeFor(jobDir, jobDir) : await worktreeFor(evidence.value);
  const related = repo ? newer(scope.repos.get(repo)) : allNewer;
  return related.length ? { type: 'stale evidence in', where: repo || evidence.value, paths: related.map(([file]) => file),
    initiallyStale: related.some(([, at]) => at > evidence.mtime && at <= Date.parse(evidence.at)) } : null;
}

async function pathVersions(files, root) {
  const versions = [];
  for (const file of [...new Set(files)].sort()) {
    const version = await fileDigest(root ? path.join(root, file) : file);
    versions.push([file, version?.mode ?? null, version?.digest ?? null]);
  }
  return versions;
}

async function lostProofInputs(lost) {
  const inputs = [];
  for (const { item, failures } of lost) {
    const proofs = [];
    for (const { type, evidence, paths } of failures) {
      if (type === 'supporting evidence only') continue;
      const { kind, value, rc } = evidence;
      const artifacts = kind === 'artifact' ? await pathVersions([value]) : [];
      proofs.push([kind, value, rc, type, artifacts, await pathVersions(paths || [])]);
    }
    const previous = item.previousEvidence.filter(proofRecorded).map(({ revision, kind, value }) => [revision, kind, value]);
    inputs.push([itemIdentity(item), sortedIdentities(proofs), sortedIdentities(previous)]);
  }
  return sortedIdentities(inputs);
}

export async function fileDigest(file) {
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) return { mode: stat.mode, digest: hash(fs.readlinkSync(file, { encoding: 'buffer' })) };
    if (!stat.isFile()) return { mode: stat.mode };
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return { mode: stat.mode, digest: digest.digest('hex') };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

const liveJobState = /^(?:running|starting|pending|queued|waiting(?:-.*)?)$/;

function readJobFile(file, limit = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(`invalid job file: ${file}`);
    return { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function jobProcessCheck(pids) {
  let identity, starts, identityError, linuxClock;
  if (platform === 'win32' && pids.length) {
    try {
      identity = await import('../../lib/process-identity.mjs');
      starts = await identity.processStartsAsync(pids);
    } catch (error) {
      identityError = error;
    }
  }
  return (pid, expected, pointerTime) => {
    if (!processAlive(pid)) return false;
    if (identityError) throw identityError;
    const actual = platform === 'win32' ? starts?.get(pid) : readProcessStat(pid)?.started;
    if (!actual) throw new Error(`cannot read start time for live PID ${pid}`);
    if (expected) return identity ? identity.sameStart(actual, expected) : actual === String(expected);
    if (pointerTime === undefined) throw new Error('missing live daemon start time');

    let startedAt;
    if (identity) {
      startedAt = identity.processStartMillis(actual);
    } else {
      linuxClock ??= {
        boot: Date.now() - os.uptime() * 1000,
        ticks: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2500 }).trim())
      };
      if (linuxClock.ticks > 0) startedAt = linuxClock.boot + Number(actual) * 1000 / linuxClock.ticks;
    }
    if (!Number.isFinite(startedAt)) throw new Error(`cannot read start time for live PID ${pid}`);
    return startedAt <= pointerTime;
  };
}

function indexedJob(directory, entry, gemini, session) {
  const pointer = readJobFile(path.join(directory, entry), 32 * 1024);
  if (!pointer) return;
  const gem = gemini ? JSON.parse(pointer.text) : null;
  if (gemini && gem?.v !== 1) throw new Error(`invalid Gemini pointer: ${entry}`);
  const [out, pid, start] = gemini ? [gem.out, gem.wrapper_pid] : pointer.text.split(/\r?\n/, 3).map((line) => line.trim());
  if (typeof out !== 'string' || !path.isAbsolute(out) || out.startsWith('//') || out.includes('\0')) {
    throw new Error(`invalid output path: ${entry}`);
  }
  const status = readJobFile(`${out}.status`);
  if (!status) {
    if (pid && !processAlive(Number(pid))) return;
    throw new Error(`status file is missing: ${out}.status`);
  }
  const fields = new Map();
  for (const line of status.text.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals);
    if (!fields.has(key)) fields.set(key, line.slice(equals + 1));
  }
  const state = fields.get('state');
  if (!state) throw new Error(`missing job state: ${out}.status`);
  if ((fields.get('owner') || gem?.owner) !== session || !liveJobState.test(state)) return;
  if (gemini && (fields.get('provider') !== 'gemini' || !pid)) return;

  const statusPid = fields.get('wrapper_pid');
  const wrapperPid = Number(pid || statusPid);
  if (pid || statusPid) {
    if (!Number.isSafeInteger(wrapperPid) || wrapperPid < 1) throw new Error(`invalid wrapper PID: ${out}.status`);
    // On Windows the active pointer uses the native PID, while the status may name Bash's PID.
    const expected = start || (wrapperPid === Number(statusPid) ? fields.get('wrapper_start') : undefined);
    return { out, state, id: fields.get('daemon_job'), pid: wrapperPid, expected, pointerTime: pointer.mtimeMs };
  }
  const time = Date.now();
  if (Date.parse(fields.get('started')) < time - os.uptime() * 1000 || time - status.mtimeMs > 600_000) return;
  return { out, state, id: fields.get('daemon_job') };
}

async function indexedJobs(run, index, session) {
  const directory = path.join(run, index);
  const gemini = index === 'gem-active';
  const jobs = [], errors = [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { jobs, errors };
    throw new Error(`live ${index} index: ${error.message}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || (gemini && !entry.name.endsWith('.json'))) continue;
    try {
      const job = indexedJob(directory, entry.name, gemini, session);
      if (job) jobs.push(job);
    } catch (error) {
      errors.push(`${index}/${entry.name}: ${error.message}`);
    }
  }
  return { jobs, errors };
}

async function daemonDiscovery(directory) {
  const file = path.join(directory, 'daemon.json');
  try {
    const discovery = readJobFile(file);
    if (!discovery) return;
    const info = JSON.parse(discovery.text);
    if (!Number.isSafeInteger(info?.pid) || info.pid < 1) throw new Error('invalid daemon PID');
    return { file, info };
  } catch (error) {
    throw new Error(`daemon jobs (${file}): ${error.message}`);
  }
}

function listedJobs(jobs, session, source, errors) {
  return jobs.filter((job) => {
    if (typeof job?.owner !== 'string' || typeof job.state !== 'string') {
      errors.push(`${source} has an invalid job entry`);
      return false;
    }
    return job.owner === session && liveJobState.test(job.state);
  });
}

async function daemonOwnedJobs({ file, info }, session, liveProcess, errors) {
  try {
    if (!liveProcess(info.pid, info.pid_start)) return [];
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !info.token || typeof info.token !== 'string') {
      throw new Error('invalid daemon port or token');
    }
    const response = await fetch(`http://127.0.0.1:${info.port}/jobs`, {
      headers: { 'X-Luna-Token': info.token }, signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`/jobs returned HTTP ${response.status}`);
    }
    const list = await response.json();
    if (!Array.isArray(list?.jobs)) throw new Error('/jobs response has no jobs array');
    return listedJobs(list.jobs, session, `daemon jobs (${file})`, errors);
  } catch (error) {
    throw new Error(`daemon jobs (${file}): ${error.message}`);
  }
}

async function ownedJobs(context) {
  const jobs = new Map();
  const errors = [];
  const result = (list) => ({ jobs: list, ...(errors.length ? { error: errors.join('; ') } : {}) });
  const settled = (results) => results.flatMap((entry) => {
    if (entry.status === 'fulfilled') return entry.value === undefined ? [] : [entry.value];
    errors.push(entry.reason.message);
    return [];
  });
  try {
    const command = process.env.CONVEYOR_OVERVIEW_CMD;
    if (command) {
      const output = await runCommand(command, [], context.cwd);
      if (output.rc !== 0) throw new Error(`executor overview: ${output.stderr}`);
      const overview = JSON.parse(output.stdout);
      if (!Array.isArray(overview.jobs)) throw new Error('executor overview has no jobs array');
      return result(listedJobs(overview.jobs, context.session, 'executor overview', errors));
    }
    const defaultRun = path.resolve(process.env.HOME || home(), '.claude', 'luna-run');
    const run = path.resolve(process.env.LUNA_RUN_DIR || process.env.LUNA_OVERVIEW_HOME || path.join(claudeHome(), 'luna-run'));
    const daemon = path.resolve(process.env.LUNA_DAEMON_HOME || run);
    const directories = [...new Set([daemon, defaultRun].flatMap((directory) => [directory, path.join(directory, 'daemon-net')]))];
    // The learning registry records terminal jobs. The live indexes have no display limits here.
    const [discoveries, indexes] = await Promise.all([
      Promise.allSettled(directories.map(daemonDiscovery)),
      Promise.allSettled([...new Set([run, defaultRun])].flatMap((root) =>
        ['active', 'gem-active'].map((index) => indexedJobs(root, index, context.session))))
    ]);
    const daemons = settled(discoveries);
    const indexed = settled(indexes).flatMap((index) => {
      errors.push(...index.errors);
      return index.jobs;
    });
    const pids = [...new Set([...daemons.map(({ info }) => info.pid), ...indexed.map(({ pid }) => pid)])].filter(processAlive);
    const checkProcess = await jobProcessCheck(pids);
    for (const { out, state, id, pid, expected, pointerTime } of indexed) {
      try {
        if (!pid || checkProcess(pid, expected, pointerTime)) jobs.set(out, { out, state, id });
      } catch (error) {
        errors.push(`${out}: ${error.message}`);
      }
    }
    const listings = settled(await Promise.allSettled(
      daemons.map((discovery) => daemonOwnedJobs(discovery, context.session, checkProcess, errors))));
    const wrappedIds = new Set([...jobs.values()].map((job) => job.id).filter(Boolean));
    return result([...jobs.values(), ...listings.flat().filter((job) => !wrappedIds.has(job.id))]);
  } catch (error) {
    errors.push(error.message);
    return result([...jobs.values()]);
  }
}

function registeredWorktrees(rows, session) {
  const calls = new Set(), paths = new Set();
  for (const { entry } of rows) {
    const content = entry.message?.content ?? entry.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && block.id &&
        /\bwt-new\.mjs\b/.test(block.input?.command)) calls.add(block.id);
      if (entry.type !== 'user' || block.type !== 'tool_result' || !calls.delete(block.tool_use_id) || block.is_error) continue;
      const output = block.toolUseResult?.stdout ?? entry.toolUseResult?.stdout ?? entryText({ content: block.content });
      const lines = String(output).split(/\r?\n/);
      for (let index = 1; index < lines.length; index++) {
        const file = lines[index - 1];
        if (path.isAbsolute(file) && parseLock(lines[index])?.owner === session) paths.add(file);
      }
    }
  }
  return paths;
}

async function cleanupProblem(context, state, scope, rows) {
  const remaining = [...new Set(state.temps)].sort().filter((file) => {
    try { return fs.lstatSync(file, { throwIfNoEntry: false }); }
    catch { return true; } // The registration makes a lookup failure attributable to this session.
  });
  if (remaining.length) return { reason: `remove registered temporary paths: ${remaining.join(', ')}`, inputs: remaining };
  const bases = readJson(ledgerPaths(context.session).bases, {});
  let configured;
  try { configured = readJson(diskHomePaths().config)?.repos; }
  catch (error) { logGate(`${context.session}: cannot read disk audit configuration: ${error.message}`); }
  const root = await repositoryRoot(context.cwd);
  const roots = new Set([...scope.repos.keys(), ...Object.keys(bases), ...registeredWorktrees(rows, context.session),
    ...(root ? [root] : []),
    ...(Array.isArray(configured) ? configured.filter((repo) => typeof repo === 'string' && path.isAbsolute(repo)) : [])]);
  const expired = new Map(), today = localDate();
  for (const repo of [...roots].sort()) {
    try {
      for (const entry of worktrees(repo)) {
        const lock = parseLock(entry.locked);
        if (lock?.owner === context.session && lock.until < today) expired.set(entry.path, lock);
      }
    } catch (error) {
      logGate(`${context.session}: cannot inspect worktrees in ${repo}: ${error.message}`);
    }
  }
  if (!expired.size) return null;
  const files = [...expired.keys()].sort();
  return { reason: `clean up expired worktrees: ${files.join(', ')}`,
    inputs: files.map((file) => [file, expired.get(file).owner, expired.get(file).until]) };
}

function screenshotCovers(item, paths) {
  if (disposed(item)) return true;
  const newest = Math.max(...paths.values());
  return latestEvidence(item).some((evidence) => evidence.kind === 'owner-message' ||
    (evidence.kind === 'artifact' && /\.(?:png|jpe?g|webp)$/i.test(evidence.value) &&
      (artifactTime(evidence) ?? -Infinity) >= newest));
}

async function screenshotProblems(context, state, scope) {
  const items = state.items.filter((item) => item.status !== 'superseded');
  const explicit = items.filter((item) => item.paths);
  const unassigned = items.filter((item) => !item.paths);
  const byItem = new Map(), missing = [];
  for (const [repo, changes] of [...scope.repos, [context.cwd, scope.nonGit]]) {
    if (!changes.size) continue;
    const { uiDirs } = await repositorySurface(repo);
    const remaining = new Map();
    for (const [file, at] of changes) {
      if (!uiFile(path.relative(repo, file), uiDirs)) continue;
      const related = explicit.filter((item) => item.paths.includes(file));
      if (!related.length) remaining.set(file, at);
      for (const item of related) {
        if (!byItem.has(item)) byItem.set(item, new Map());
        byItem.get(item).set(file, at);
      }
    }
    if (remaining.size && !unassigned.length) missing.push([repo, await pathVersions(remaining.keys())]);
    for (const item of remaining.size ? unassigned : []) {
      if (!byItem.has(item)) byItem.set(item, new Map());
      for (const entry of remaining) byItem.get(item).set(...entry);
    }
  }
  for (const [item, paths] of byItem) {
    if (!screenshotCovers(item, paths)) missing.push([itemIdentity(item), await pathVersions(paths.keys())]);
  }
  return missing;
}

function turnFailures(report) {
  return sortedIdentities([
    ...(Array.isArray(report?.results) ? report.results : []).filter((entry) => entry && !['pass', 'skipped'].includes(entry.status))
      .map(({ name, status, rc }) => ['check', name, status, rc]),
    ...(Array.isArray(report?.hygiene?.grew) ? report.hygiene.grew : []).filter(Boolean)
      .map(({ file, counter }) => ['hygiene', file, counter]),
    ...(report?.tests?.ok === false ? [['test-budget']] : [])
  ]);
}

export async function scopedTurnChecks(context, task, repos) {
  const ledger = ledgerPaths(context.session).ledger;
  const results = [];
  for (const { repo, base, files } of repos) {
    const inputs = [repo, base, await pathVersions(files, repo)];
    const key = fingerprint([turnCheckVersion, inputs]);
    results.push(await withLock(`${ledger}.${key}.turn-check`, async () => {
      const cached = readJsonl(ledger).findLast((record) => record.type === 'turn-check' &&
        record.taskId === task.id && record.fingerprint === key);
      if (cached) return cached;
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-turn-check-'));
      try {
        const list = path.join(temporary, 'files.json');
        fs.writeFileSync(list, JSON.stringify(files));
        const command = process.env.CONVEYOR_CHECK_CMD || [process.execPath, path.join(claudeHome(), 'scripts/conveyor/check.mjs')];
        const result = await runCommand(command, ['run', '--dir', repo, '--level', 'turn', '--base', base,
          '--files-from', list, '--json'], repo);
        let report;
        try { report = JSON.parse(result.stdout); } catch { /* A missing or invalid report is red. */ }
        const record = { type: 'turn-check', taskId: task.id, fingerprint: key, inputs,
          rc: result.rc, ok: result.rc === 0 && report?.ok === true, failures: turnFailures(report) };
        await ledgerTransaction(context, (records, put) => put(record));
        return record;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }));
  }
  return results;
}

function redTurnProblem(checks) {
  const red = checks.filter((check) => !check.ok);
  if (!red.length) return null;
  const [repo, base] = red[0].inputs;
  return { reason: `fix red turn checks in ${repo}; run check --level turn --base ${base}`,
    inputs: red.map(({ inputs, rc, failures }) => [inputs, rc, failures]) };
}

async function recordedScreenshots(context, state, { scope, fingerprint: deliveryFingerprint }) {
  const ledger = ledgerPaths(context.session).ledger;
  const coverage = state.items.map((item) => latestEvidence(item).filter(({ kind, value }) =>
    kind === 'artifact' && /\.(?:png|jpe?g|webp)$/i.test(value)).map((entry) => [entry.value, artifactTime(entry)]));
  const writes = [...scope.repos.values(), scope.nonGit].map((changes) => [...changes]);
  const key = fingerprint([deliveryFingerprint, writes, coverage]);
  return withLock(`${ledger}.${key}.screenshots`, async () => {
    const cached = readJsonl(ledger).findLast((record) => record.type === 'screenshot-check' &&
      record.taskId === state.task.id && record.fingerprint === key);
    if (cached) return cached.missing;
    const missing = await screenshotProblems(context, state, scope);
    await ledgerTransaction(context, (records, put) =>
      put({ type: 'screenshot-check', taskId: state.task.id, fingerprint: key, missing }));
    return missing;
  });
}

function screenshotReason(missing) {
  const targets = sanitizeQuote(missing.map(([target]) => Array.isArray(target) ? target[0] : target).join(', '), 1200);
  return `user-facing change without a screenshot: ${targets}. `
    + 'Use the project verify skill and record `ledger evidence <L> --artifact <screenshot>`.';
}

export async function requireDeliveryChecks(context, state, inputs) {
  const { open, lost } = await outcomeProblems(state, inputs.scope);
  if (open.length || lost.length) {
    throw new Error(`refresh evidence for ${[...open, ...lost.map(({ item }) => item)].map(({ id }) => id).join(', ')}`);
  }
  if (state.gateWaived) return;
  const red = redTurnProblem(await scopedTurnChecks(context, state.task, inputs.repos));
  if (red) throw new Error(`5. ${red.reason}`);
  const missing = await recordedScreenshots(context, state, inputs);
  if (missing.length) throw new Error(`9. ${screenshotReason(missing)}`);
}

export function hasApproachReviewTiers(config) {
  return Object.hasOwn(config.tiers, 'approach') || Object.hasOwn(config.tiers, 'architect');
}

export function validReviewSkip(reason) {
  return typeof reason === 'string' && !!reason.trim() && [...reason].length <= 300;
}

function approachReviewRuns(session, task) {
  const started = Date.parse(task.at);
  return readJsonl(ledgerPaths(session).runs).filter((run) => run.session === session && Date.parse(run.at) >= started);
}

function approachReviewRequirement(runs, before = Infinity) {
  let review = -Infinity, approach = -Infinity, architect = -Infinity, planner = -Infinity, failure = -Infinity;
  let plannerModel = null;
  const approaches = [];
  for (const run of runs) {
    const at = Date.parse(run.at);
    if (run.event !== 'end' || at >= before) continue;
    if (run.code === 0) {
      const reviewer = run.panel ?? run.tier;
      if (reviewer === 'architect') architect = Math.max(architect, at);
      if (!run.panel && reviewer === 'approach') {
        approach = Math.max(approach, at);
        approaches.push({ at, model: run.model ?? null });
      }
      if (!run.panel && reviewer === 'planner' && at >= planner) {
        planner = at;
        plannerModel = run.model ?? null;
      }
      if (reviewer === 'architect' || (!run.panel && reviewer === 'approach')) review = Math.max(review, at);
    }
    if (run.code === 6 && run.gate?.status === 'fail') failure = Math.max(failure, at);
  }
  if (failure !== -Infinity && architect <= failure) return 'retry';
  // A plan written by the planner tier (Astra) is reviewed by a different model: tier approach, after the plan.
  // The reviewer must be another model in fact, not just another tier: a fallback can make both the same model.
  if (planner !== -Infinity && !approaches.some((entry) => entry.at > planner
    && (!plannerModel || !entry.model || entry.model !== plannerModel))) return 'independent';
  return review === -Infinity ? 'initial' : null;
}

export function taskApproachReviewRequirement(session) {
  if (!validSession(session)) return null;
  const task = readJsonl(ledgerPaths(session).ledger).findLast((record) => record.type === 'start');
  return task ? approachReviewRequirement(approachReviewRuns(session, task)) : null;
}

export function activeTaskId(session) {
  if (!validSession(session)) return null;
  return readJsonl(ledgerPaths(session).ledger).findLast((record) => record.type === 'start')?.id ?? null;
}

export async function gateStatus(context) {
  const rows = transcriptRows(context);
  const state = await loadLedger(context, rows);
  const requestKey = state.task?.id ?? state.primaryMessages.at(-1)?.id ?? null;
  const ok = (applies, extra) => ({ applies, ok: true, requestKey, ...extra });
  if (state.legacy) return ok(false);
  // For orchestrator-only sessions, acceptance is held by the orchestrating session (owner 2026-11-24).
  if (!state.task && !rows.some(({ entry }) => isGenuineHumanEntry(entry) && eligiblePrompt(entryText(entry)))) {
    return ok(true, { systemMessage: 'conveyor: no owner prompt in this session; acceptance is held by the orchestrating session' });
  }

  const { jobs, error } = await ownedJobs(context);
  if (error) logGate(`${context.session}: cannot verify executor jobs: ${error}`);
  if (jobs.length) return ok(true, { wip: true, systemMessage: `conveyor: work in progress, ${jobs.length} jobs running` });

  const scope = await ownedScope(context, state, rows);
  const code = [...scope.repos.values(), scope.nonGit].flatMap((files) => [...files.keys()].filter(codePath));
  const suffix = !scope.repos.size && code.length ? '; non-git code edits: ledger checks only, turn checks unavailable' : '';
  const block = (check, reason, inputs) => ({ applies: true, ok: false, requestKey, check,
    reason: check === 9 ? `${check}. ${reason}${suffix}` : sanitizeQuote(`${check}. ${reason}${suffix}`, 1500),
    fingerprint: fingerprint([stopVersion, context.session, requestKey, check, inputs]) });

  if (!state.task && code.length) {
    return block(1, 'start the ledger and play back the requirements: ledger start', await pathVersions(code));
  }
  const applies = !!state.task;
  let delivery;
  if (applies) {
    const { open, lost } = await outcomeProblems(state, scope);
    if (open.length) {
      return block(3, `finish or obtain a user waiver for open items: ${open.map((item) => item.id).join(', ')}`,
        sortedIdentities(open.map(itemIdentity)));
    }
    if (lost.length) {
      const { item, failures } = lost[0];
      const failure = failures.find(({ type }) => type !== 'supporting evidence only');
      const detail = failure ? [failure.type, failure.where].filter(Boolean).join(' ')
        : 'runnable command, fresh artifact, or passing dispatch gate evidence required';
      return block(4, `refresh evidence: ${item.id}: ${detail}`, await lostProofInputs(lost));
    }
    if (!state.gateWaived) {
      const red = redTurnProblem(await scopedTurnChecks(context, state.task, await scopedRepos(context, scope)));
      if (red) return block(5, red.reason, red.inputs);
    }
    delivery = await deliveryInputs(context, state, scope);
    const unanswered = unansweredFindings(state, delivery.fingerprint);
    if (!state.ready || !state.deliveries.some(({ fingerprint }) => fingerprint === delivery.fingerprint) || unanswered.length) {
      const finish = state.ready ? '' : 'mark verified outcomes done, then ';
      const findings = unanswered.length ? ` and answer findings: ${unanswered.join(', ')}` : '';
      return block(6, `${finish}run ledger deliver${findings}`, [delivery.fingerprint, unanswered]);
    }
  }
  if (!state.gateWaived) {
    const cleanup = await cleanupProblem(context, state, scope, rows);
    if (cleanup) return block(8, cleanup.reason, cleanup.inputs);
    if (delivery) {
      const missing = await recordedScreenshots(context, state, delivery);
      if (missing.length) return block(9, screenshotReason(missing), sortedIdentities(missing));
    }
  }
  return ok(applies);
}

export function gateMode(session) {
  return calibrationMode(ledgerPaths(session).calibration);
}

function calibrationMode(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, `${now()}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const override = process.env.CONVEYOR_GATE_MODE;
  if (override) {
    if (!['warn', 'block'].includes(override)) throw new Error('invalid CONVEYOR_GATE_MODE');
    return override;
  }
  const stat = fs.statSync(file);
  const date = Date.parse(fs.readFileSync(file, 'utf8').trim());
  const start = Math.min(Number.isFinite(date) && date <= stat.mtimeMs ? date : stat.mtimeMs,
    stat.birthtimeMs || stat.mtimeMs);
  return Date.now() - start < 7 * 86400_000 ? 'warn' : 'block';
}

export function logGate(message) {
  const file = path.join(claudeHome(), 'logs', 'conveyor-gate.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${now()} ${sanitizeQuote(message, 2000)}\n`);
  } catch { /* Logging must never block a hook. */ }
}

export function stopOutput(context, status) {
  const file = ledgerPaths(context.session).stops;
  return withLock(file, () => {
    const previous = readJson(file);
    const sameRequest = previous?.version === stopVersion && previous.requestKey === status.requestKey;
    if (status.ok) {
      if (previous && (!status.wip || !sameRequest)) fs.rmSync(file, { force: true });
      return status.systemMessage ? { systemMessage: status.systemMessage } : null;
    }
    if (gateMode(context.session) === 'warn') {
      if (previous && !sameRequest) fs.rmSync(file, { force: true });
      return { systemMessage: `conveyor gate: ${status.reason}` };
    }
    if (sameRequest && previous.lastBlockedFingerprint === status.fingerprint) {
      const systemMessage = `conveyor gate: unchanged blocker, turn allowed — ${status.reason}`;
      logGate(`${context.session}: ${systemMessage}`);
      return { systemMessage };
    }
    writeJson(file, { version: stopVersion, requestKey: status.requestKey,
      lastBlockedCheck: status.check, lastBlockedFingerprint: status.fingerprint });
    return { decision: 'block', reason: status.reason };
  });
}

export function registerTemporary(context, file) {
  return ledgerTransaction(context, (records, put) => put({ type: 'tmp', path: path.resolve(context.cwd, file) }));
}
