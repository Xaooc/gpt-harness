import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CODE_EXTENSIONS, eligiblePrompt, humanWords, latestEvidence
} from '../../payload-linux/claude/scripts/conveyor/lib/ledger.mjs';
import { unansweredFindings } from '../../payload-linux/claude/scripts/conveyor/lib/delivery.mjs';
import { foldLedger } from '../../payload-linux/claude/scripts/conveyor/lib/request-state.mjs';
import { inside } from '../../payload-linux/claude/scripts/conveyor/lib/task-scope.mjs';
import { entryText, isGenuineHumanEntry } from '../../payload-linux/claude/scripts/learning/extract.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const fingerprint = (value) => digest(JSON.stringify(value));
const canonical = (values) => values.map((value) => JSON.stringify(value)).sort().map((value) => JSON.parse(value));
const stopCommand = (command) => /(?:^|[\s"'\\/])conveyor-stop-gate\.mjs(?=$|[\s"'])/.test(command ?? '');
const editorTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const decisionChecks = [1, 3, 4, 5, 6, 8, 9];

export async function snapshot(file) {
  if (!file) return null;
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? { file, size: stat.size } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Read the captured prefix with byte offsets and discard an incomplete final line.
export async function* jsonl(input) {
  if (!input?.size) return;
  let offset = 0, fragments = [];
  for await (const chunk of fs.createReadStream(input.file, { end: input.size - 1 })) {
    let index = 0;
    for (let end; (end = chunk.indexOf(10, index)) !== -1; index = end + 1) {
      fragments.push(chunk.subarray(index, end));
      const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
      fragments = [];
      const start = offset;
      offset += line.length + 1;
      let entry;
      try { entry = JSON.parse(line.toString('utf8')); } catch { continue; }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) yield { entry, offset: start, end: offset };
    }
    if (index < chunk.length) fragments.push(chunk.subarray(index));
  }
}

function hookOutcome(attachment) {
  const { type, stdout, blockingError } = attachment;
  if (type === 'hook_cancelled') return { kind: 'cancelled', rank: 3 };
  let output;
  try { output = JSON.parse(stdout); } catch { /* A system message can also be recorded as plain text. */ }
  const message = output?.systemMessage ?? attachment.systemMessage ?? attachment.message ?? (attachment.content || stdout || '');
  const reason = (typeof message === 'string' ? message : entryText({ content: message })).trim();
  const block = type === 'hook_blocking_error' || output?.decision === 'block';
  const text = block ? (blockingError?.blockingError ?? blockingError?.reason ?? output?.reason ?? reason) : reason;
  const check = Number(String(text).match(/^(?:conveyor gate: )?(\d+)\./)?.[1]) || null;
  if (block) return { kind: 'block', check, rank: 4 };
  if (/allowed after \d+ repeats|unchanged blocker, turn allowed/i.test(reason)) return { kind: 'allowance', check, rank: 3 };
  if (/conveyor: work in progress\b/i.test(reason)) return { kind: 'wip', rank: 3 };
  if (/^conveyor gate:/i.test(reason) || check) return { kind: 'warning', check, rank: 3 };
  if (reason || attachment.exitCode > 0) return { kind: 'message', rank: 2 };
  return { kind: 'quiet', rank: 1 };
}

function recordStop(stops, row, assistant) {
  const { entry, offset, at } = row;
  const summary = entry.type === 'system' && entry.subtype === 'stop_hook_summary';
  const attachment = entry.type === 'attachment' ? entry.attachment : null;
  const id = summary ? entry.toolUseID : attachment?.toolUseID;
  if (!id) return;
  const stop = stops.get(id) ?? { id, offset, at, assistant, foreignBlock: false };
  if (summary) {
    if (entry.hookInfos?.some(({ command }) => stopCommand(command))) {
      stop.summary = true;
      if (!stop.old) Object.assign(stop, { offset, at, assistant });
    }
    stop.preventedContinuation = entry.preventedContinuation;
  } else {
    if (!['hook_success', 'hook_system_message', 'hook_blocking_error', 'hook_cancelled'].includes(attachment.type) ||
      (attachment.hookEvent ?? attachment.hookName ?? 'Stop') !== 'Stop') return;
    if (stopCommand(attachment.blockingError?.command) || stopCommand(attachment.command)) {
      if (!stop.old) Object.assign(stop, { offset, at, assistant });
      const observed = hookOutcome(attachment);
      if (!stop.old || (observed.rank ?? 0) > (stop.old.rank ?? 0)) stop.old = observed;
    } else if (attachment.type === 'hook_blocking_error') {
      stop.foreignBlock = true;
    }
  }
  stops.set(id, stop);
}

function editorChange(tool, result, structured, cwd) {
  const input = tool.input ?? {};
  const { filePath, originalFile, structuredPatch, type, content } = structured ?? {};
  const full = typeof content === 'string' ? content : tool.name === 'Write' ? input.content : undefined;
  if (typeof originalFile === 'string' && originalFile === full) return null;
  if (Array.isArray(structuredPatch) && type !== 'create' &&
    !structuredPatch.some(({ lines }) => lines?.some((line) => /^[+-]/.test(line)))) return null;
  const edits = tool.name === 'MultiEdit' ? input.edits : tool.name === 'Edit' ? [input] : null;
  if (edits?.length && edits.every(({ old_string, new_string }) => typeof old_string === 'string' && old_string === new_string)) {
    return null;
  }
  const target = filePath || input.file_path || input.notebook_path;
  if (!target || typeof target !== 'string' || (!cwd && !path.isAbsolute(target))) return { unknown: true };
  const file = path.resolve(cwd || '', target);
  return { file, ...(tool.name === 'Write' && typeof full === 'string' ? { digest: digest(full) } : {}) };
}

const completionChecklist = /^\s*[-*]\s*(L\d+)\s+(?:[✓✗](?=\s|$)|waived\b)/gm;

export async function transcriptHistory(input, expectedSession, cutoff) {
  const stops = new Map(), calls = new Map(), prompts = [], changes = [], cleanup = [], images = new Map();
  let session = expectedSession, assistant = null, hadRows = false;
  for await (const row of jsonl(input)) {
    const { entry, offset } = row;
    if (entry.isSidechain) continue;
    const id = entry.sessionId ?? entry.session_id;
    session ??= id;
    if (id && id !== session) continue;
    const at = Date.parse(entry.timestamp);
    if ((!Number.isFinite(at) && cutoff !== Infinity) || at > cutoff) continue;
    row.at = at;
    hadRows = true;
    if (entry.type === 'system' || entry.type === 'attachment') recordStop(stops, row, assistant);
    const owner = isGenuineHumanEntry(entry);
    if (owner) {
      const text = entryText(entry);
      if (eligiblePrompt(text)) prompts.push({ uuid: entry.uuid ?? `transcript:${offset}`, offset, at, text });
    }
    const content = entry.message?.content ?? entry.content;
    if (entry.type === 'assistant') {
      const text = entryText(entry);
      const items = [...text.matchAll(completionChecklist)].map((match) => match[1]);
      assistant = { items, checklist: !!items.length || /^\s*(?:[-*]|\d+[.)])\s+\[[ xX]\](?=\s|$)/m.test(text) };
    }
    if (!Array.isArray(content)) continue;
    if (owner && content.some((block) => block?.type === 'image')) images.set(offset, entry.uuid);
    const results = entry.type === 'user' ? content.filter((block) => block.type === 'tool_result') : [];
    for (const block of content) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.id &&
        (editorTools.has(block.name) || block.name === 'Bash')) {
        calls.set(block.id, { tool: block, offset, cwd: entry.cwd });
      }
    }
    for (const result of results) {
      const call = calls.get(result.tool_use_id);
      if (!call) continue;
      calls.delete(result.tool_use_id);
      const structured = result.toolUseResult ?? (results.length === 1 ? entry.toolUseResult : null);
      const output = typeof structured?.stdout === 'string' ? structured.stdout : entryText({ content: result.content });
      if (call.tool.name === 'Bash') {
        const command = call.tool.input?.command ?? '';
        if (/\bgit\b[^\r\n]*\bcommit\b/.test(command) && /^\[[^\r\n]+ [a-f0-9]{4,64}\]/mi.test(output)) {
          changes.push({ offset, start: call.offset, at, unknown: true });
        }
        if (!result.is_error && /\bwt-new\.mjs\b/.test(command)) cleanup.push(offset);
        continue;
      }
      if (result.is_error || /^(?:<tool_use_error>|(?:Error|Denied|Rejected):|The user (?:rejected|denied)\b)/i.test(output.trim())) {
        continue;
      }
      const change = editorChange(call.tool, result, structured, call.cwd ?? entry.cwd);
      if (change) changes.push({ ...change, offset, start: call.offset, at });
    }
  }
  return { session, hadRows, prompts, changes, cleanup, images, stops: [...stops.values()]
    .filter((stop) => stop.summary || stop.old).sort((left, right) => left.offset - right.offset) };
}

function recordedAt(record) {
  return Date.parse(record.at);
}

const byStop = (record, stop) => recordedAt(record) <= stop.at;
const oldPassedEvidence = (stop) => ['block', 'warning', 'allowance'].includes(stop.old?.kind) &&
  stop.old.check >= 5 && stop.old.check <= 10;
const oldProof = (entry) => (entry.kind === 'command' && entry.rc === 0) ||
  (entry.kind === 'check' && entry.ok === true) || (entry.kind === 'artifact' && Number.isFinite(entry.mtime));

function project(records, history, stop, rollovers) {
  const atStop = records.filter((record) => byStop(record, stop) &&
    (!['evidence', 'start', 'message'].includes(record.type) || !Number.isFinite(record.offset) || record.offset <= stop.offset));
  const raw = foldLedger(atStop);
  const projected = [];
  let index = 0;
  for (const record of atStop) {
    while (rollovers[index] && recordedAt(rollovers[index]) < recordedAt(record)) {
      projected.push(rollovers[index++]);
    }
    projected.push(record.type === 'start' ? { ...record, version: 2 } : record);
  }
  projected.push(...rollovers.slice(index));
  const messages = new Map(projected.filter(({ type }) => type === 'message').map((message) => [message.id, message]));
  const starts = projected.filter(({ type }) => type === 'start');
  let active = -1;
  const verified = projected.map((record) => {
    if (record.type === 'start') active++;
    if (record.type !== 'waive' || record.verified !== true) return record;
    const position = record.taskId === undefined ? active : starts.findIndex(({ id }) => id === record.taskId);
    const offset = (start) => messages.get(start?.messageId)?.offset ?? start?.offset;
    const start = offset(starts[position]), end = offset(starts[position + 1]) ?? Infinity;
    const verified = Number.isFinite(start) && typeof record.quote === 'string' && record.quote.trim().length >= 12 &&
      history.prompts.some((prompt) => prompt.offset >= start && prompt.offset < end && prompt.offset < stop.offset &&
        prompt.at <= stop.at && humanWords(prompt.text).includes(record.quote));
    return { ...record, verified };
  });
  return { raw, state: foldLedger(verified), records: atStop };
}

function scopeAt(history, runs, records, stop, boundary, taskId) {
  const files = new Map();
  let unknown = false;
  const add = (change) => {
    const old = files.get(change.file);
    if (!old || !(old.at > change.at)) files.set(change.file, { ...change, repo: change.repo ?? old?.repo });
  };
  for (const change of history.changes) {
    if (change.offset >= stop.offset) break;
    if (change.start < (boundary?.offset ?? 0) || change.at > stop.at) continue;
    if (change.unknown || !Number.isFinite(change.at)) unknown = true;
    else add(change);
  }
  for (const run of runs) {
    if (!byStop(run, stop) || run.event !== 'end' || run.mode !== 'write') continue;
    const data = run.acceptance;
    if (!data) {
      if (recordedAt(run) >= (boundary?.at ?? -Infinity)) unknown = true;
      continue;
    }
    if (data.session !== history.session || data.task !== (taskId ?? null) ||
      (!taskId && !(Date.parse(data.startedAt) >= boundary?.at))) continue;
    unknown ||= data.truncated === true || !Array.isArray(data.changed);
    for (const change of data.changed ?? []) {
      const at = Date.parse(change.at ?? run.at);
      if (typeof change.path === 'string' && path.isAbsolute(change.path) &&
        typeof data.repo === 'string' && path.isAbsolute(data.repo) && inside(data.repo, change.path) &&
        Number.isFinite(at) && at <= stop.at && change.before !== change.after) {
        add({ file: change.path, at, repo: data.repo, digest: change.after });
      }
    }
  }
  for (const record of records.filter((entry) => entry.type === 'turn-check' && entry.taskId === taskId)) {
    const [repo, , versions] = record.inputs ?? [];
    if (!path.isAbsolute(repo ?? '') || !Array.isArray(versions)) continue;
    for (const [relative] of versions) {
      const change = files.get(path.resolve(repo, relative));
      if (change && !change.repo) change.repo = repo;
    }
  }
  return { files, unknown };
}

function proofAt(evidence, item, scope, recorded, history) {
  if (evidence.kind === 'command') {
    if (!Number.isInteger(evidence.rc)) return { unknown: 'historical command return code unavailable' };
    return evidence.rc === 0 ? {} : { reason: 'command failed' };
  }
  if (evidence.kind === 'owner-message') {
    return history.images.has(evidence.offset) ? {} : { unknown: 'owner image unavailable' };
  }
  if (!['artifact', 'check'].includes(evidence.kind)) return { reason: 'supporting evidence only' };
  if (evidence.kind === 'check' && evidence.ok === false) return { reason: 'recorded dispatch gate is red' };
  const writes = [...scope.files.values()].filter(({ file }) => !item.paths || item.paths.includes(file));
  const relevant = ({ file, repo }) => evidence.kind === 'artifact' &&
    (file === evidence.value || (repo && inside(repo, evidence.value)));
  if (Number.isFinite(evidence.mtime) && writes.some((change) => change.at > evidence.mtime && relevant(change))) {
    return { reason: 'artifact registration predates an attributed write to a related path' };
  }
  if (recorded && !writes.length && !scope.unknown && oldProof(evidence)) return {};
  return { unknown: evidence.kind === 'artifact' ? 'historical artifact availability or freshness' :
    'historical dispatch report or job scope' };
}

function outcomesAt(state, raw, scope, history, stop) {
  const open = [], lost = [], uncertain = [], reopened = [], possible = [];
  for (const item of state.items) {
    if (['waived', 'pending-owner', 'superseded'].includes(item.status) || item.resolution?.result === 'accepted') continue;
    const old = raw.legacy && raw.task?.id === state.task.id &&
      raw.items.find(({ id, status }) => id === item.id && status === 'done');
    const proofs = old ? latestEvidence(old).filter(oldProof) : [];
    const oldAccepted = oldPassedEvidence(stop);
    const results = latestEvidence(item).map((entry) => ({ entry,
      ...proofAt(entry, item, scope, oldAccepted && proofs.includes(entry), history) }));
    if (results.some((result) => !result.reason && !result.unknown)) continue;
    const unknown = results.find((result) => result.unknown)?.unknown;
    const reason = unknown || results.find((result) => result.reason !== 'supporting evidence only')?.reason ||
      (item.previousEvidence.length ? 'proof belongs to an earlier outcome revision' : 'no qualifying v2 proof');
    if (unknown) uncertain.push(item);
    else if (item.status === 'done' || [...item.evidence, ...item.previousEvidence].some(oldProof)) lost.push({ item, results, reason });
    else open.push(item);
    if (proofs.length) {
      const target = unknown || !oldAccepted ? possible : reopened;
      target.push({ task: state.task.id, item: item.id, checkpoint: stop.id, at: stop.at,
        kinds: [...new Set(proofs.map(({ kind }) => kind))].sort().join(', '),
        reason: oldAccepted ? reason : `v1 evidence acceptance unobserved, ${reason}` });
    }
  }
  return { open, lost, uncertain, reopened, possible };
}

function knownDeliveryFingerprint(state, scope) {
  if (scope.unknown || scope.files.size) return null;
  const outcomes = [];
  for (const item of state.items.filter(({ status }) => status !== 'superseded')) {
    const { id, text, revision, sources, paths, status, amendments, pending, resolution } = item;
    const evidence = latestEvidence(item).map(({ kind, value, cwd, rc, expectedRc, ok }) => ({ kind, value, cwd, rc, expectedRc, ok }));
    if (evidence.some(({ kind }) => ['artifact', 'file', 'check'].includes(kind))) return null;
    outcomes.push({ id, text, revision, sources: [...(sources || [])].sort(), paths: paths && [...paths].sort(), status,
      amendments: amendments.map(({ source, text, paths }) => ({ source, text, paths })),
      pending: pending?.reason, resolution: resolution && { source: resolution.source, result: resolution.result },
      waivers: [...new Set(state.waivers.filter((waiver) => waiver.target === id && waiver.verified &&
        (waiver.revision ?? 1) === revision).map(({ quote }) => quote))].sort(),
      evidence: canonical(evidence) });
  }
  return fingerprint([state.task.id, { git: [], nonGit: [] }, outcomes]);
}

function turnDecision(state, records, scope) {
  const repos = new Map();
  if (scope.unknown) return { unknown: 'unrecorded commit or executor write scope' };
  for (const change of scope.files.values()) {
    if (!change.repo) return { unknown: 'historical Git membership for editor changes' };
    if (!repos.has(change.repo)) repos.set(change.repo, new Map());
    repos.get(change.repo).set(path.relative(change.repo, change.file), change);
  }
  const checks = [...repos].sort(([left], [right]) => left.localeCompare(right)).map(([repo, files]) =>
    records.findLast((record) => {
      const [root, , versions] = record.inputs ?? [];
      return record.type === 'turn-check' && record.taskId === state.task.id && root === repo &&
        Array.isArray(versions) && versions.length === files.size && new Set(versions.map(([file]) => file)).size === files.size &&
        versions.every(([file, , hash]) => files.has(file) && files.get(file).digest === hash &&
          files.get(file).at <= recordedAt(record));
    }));
  if (checks.some((check) => !check)) return { unknown: 'no recorded turn check matching the owned path versions' };
  const red = checks.filter(({ ok }) => !ok).map(({ inputs, rc, failures }) => [inputs, rc, failures]);
  return { red };
}

function gateDecision(state, records, history, runs, stop, prompt, scope, outcomes) {
  const key = state.task?.id ?? prompt?.uuid ?? null;
  const pass = (kind = 'clean') => ({ key, kind });
  const unknown = (check, reason) => ({ key, kind: 'unknown', check, reason });
  const block = (check, inputs) => ({ key, kind: 'candidate', check,
    identity: inputs && fingerprint([2, history.session, key, check, inputs]) });
  if (!Number.isFinite(stop.at)) return unknown(1, 'Stop timestamp unavailable');
  if (stop.old?.kind === 'cancelled') return unknown(1, 'old Stop was cancelled');
  if (!state.task && !prompt) return pass();
  if (stop.old?.kind === 'wip') return pass('wip');

  const oldCheckedJobs = stop.old?.check && !stop.assistant?.checklist;
  const activeLaunch = runs.some((start, index) => start.event === 'start' && start.out && byStop(start, stop) &&
    !runs.slice(index + 1).some((end) => end.event === 'end' && end.out === start.out && byStop(end, stop)));
  if (!oldCheckedJobs && activeLaunch) return unknown(state.task ? 3 : 1, 'executor launch without a recorded end by Stop');

  if (!state.task) {
    const code = [...scope.files.values()].filter(({ file }) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()) ||
      /^(Dockerfile|Makefile|CMakeLists\.txt|Gemfile)$/i.test(path.basename(file)));
    if (code.length) return block(1, !scope.unknown && code.every(({ digest: hash }) => hash !== undefined)
      ? canonical(code.map(({ file, digest: hash }) => [file, hash])) : null);
    if (scope.unknown) return unknown(1, 'unrecorded commit or executor write scope');
  } else {
    const { open, lost, uncertain } = outcomes;
    if (uncertain.some((item) => item.status !== 'done')) {
      return unknown(3, 'historical evidence availability, freshness, or dispatch results');
    }
    if (open.length) return block(3, canonical(open.map(({ id, revision }) => [id, revision])));
    if (uncertain.length) return unknown(4, 'historical evidence availability, freshness, or dispatch results');
    if (lost.length) {
      return block(4, lost.some(({ results }) => results.some(({ entry }) => ['artifact', 'check'].includes(entry.kind))) ?
        null : canonical(lost.map(({ item, results }) => [[item.id, item.revision],
          canonical(results.filter(({ reason }) => reason !== 'supporting evidence only')
            .map(({ entry, reason }) => [entry.kind, entry.value, entry.rc, reason])),
          canonical(item.previousEvidence.filter(oldProof).map(({ revision, kind, value }) => [revision, kind, value]))])));
    }
    if (!state.gateWaived) {
      const turn = turnDecision(state, records, scope);
      if (turn.unknown) return unknown(5, turn.unknown);
      if (turn.red.length) return block(5, turn.red);
    }
    const expected = knownDeliveryFingerprint(state, scope);
    const findings = unansweredFindings(state, expected);
    if (!state.ready || !state.deliveries.length || findings.length ||
      (expected && !state.deliveries.some(({ fingerprint: value }) => value === expected))) {
      return block(6, expected && [expected, findings]);
    }
    if (!expected) return unknown(6, 'historical owned diff or mutable proof needed to match delivery');
  }
  if (!state.gateWaived && (state.temps.length || history.cleanup.some((offset) => offset < stop.offset) || scope.files.size)) {
    return unknown(8, 'historical temp paths or worktree locks unavailable');
  }
  // A matched delivery fingerprint is currently reconstructible only for an empty owned diff.
  // Empty scope also has no screenshot requirement.
  return pass();
}

// Preserve all possible previous blockers across unknown checkpoints. The wildcard is scoped to a single check.
function emit(decision, memory) {
  const { key, kind, check, identity, reason } = decision;
  const previous = memory.get(key) ?? new Set([null]);
  let next = previous, emitted = kind;
  if (kind === 'unknown') {
    next = new Set([...previous, null, ...decisionChecks.filter((id) => id >= check).map((id) => `${id}:*`)]);
  } else if (kind === 'clean') {
    next = new Set([null]);
  } else if (kind === 'candidate') {
    const wildcard = `${check}:*`, exact = identity ? `${check}:${identity}` : wildcard;
    const mayRepeat = previous.has(exact) || previous.has(wildcard) ||
      (!identity && [...previous].some((value) => value?.startsWith(`${check}:`)));
    const mustRepeat = identity && previous.size === 1 && previous.has(exact);
    emitted = mustRepeat ? 'allowance' : mayRepeat ? 'unknown' : 'block';
    next = new Set([exact]);
  }
  // A different request resets the allowance state, even if its key appeared earlier in the history.
  memory.clear();
  memory.set(key, next);
  return { kind: emitted, identity, reason: reason ?? (emitted === 'unknown' ? 'prior or current blocker identity unavailable' : null) };
}

function deliveryBoundary(raw, stop) {
  if (!raw.legacy || !raw.ready) return null;
  const crosscheck = raw.crosscheck;
  const reviewed = crosscheck?.ok === true && (crosscheck.findings ?? []).every(({ id }) => raw.links[id]);
  const checklist = raw.items.length && raw.items.every(({ id }) => stop.assistant?.items.includes(id));
  if (stop.old?.kind === 'quiet' && reviewed && checklist && !stop.preventedContinuation && !stop.foreignBlock) return 'supported';
  if (reviewed && (stop.old?.check >= 7 || !stop.old || stop.old.kind === 'quiet')) return 'ambiguous';
  return null;
}

export function replayHistory(records, history, runs) {
  const report = { session: history.session, stops: history.stops.length, summaries: 0, comparable: 0, oldBlocks: 0,
    warnings: 0, oldAllowances: 0, wip: 0, cancelled: 0, unobserved: 0, newBlocks: 0, unknown: 0,
    allowances: 0, identical: 0, adjacent: 0, legacy: 0, inferred: 0, ambiguous: 0, missingDelivery: 0,
    reopened: new Map(), possible: new Map(), reasons: new Map() };
  const memory = new Map(), rollovers = [];
  let previous, priorBoundary;
  for (const stop of history.stops) {
    const prompt = history.prompts.findLast((entry) => entry.offset < stop.offset && entry.at <= stop.at);
    let projection = project(records, history, stop, rollovers);
    const { raw } = projection;
    const explicit = raw.task && raw.task.id !== priorBoundary?.task;
    const deliveredAt = recordedAt(raw.delivery ?? {});
    const boundaryAt = raw.delivered ? deliveredAt : !explicit && priorBoundary?.at;
    const eligible = Number.isFinite(boundaryAt) && history.prompts.find((entry) =>
      entry.offset < stop.offset && entry.at > boundaryAt && entry.at <= stop.at);
    if (eligible && projection.state.task?.id === raw.task?.id) {
      if (raw.delivered || priorBoundary?.kind === 'supported') {
        rollovers.push({ type: 'start', version: 2, id: `inferred-${rollovers.length + 1}`, uuid: eligible.uuid,
          offset: eligible.offset, at: new Date(eligible.at).toISOString() });
        report.inferred++;
        projection = project(records, history, stop, rollovers);
      } else {
        report.ambiguous++;
      }
      priorBoundary = null;
    }
    const { state, records: atStop } = projection;
    const marked = deliveryBoundary(raw, stop);
    if (state.task?.id === raw.task?.id && marked) priorBoundary = { task: raw.task.id, at: stop.at, kind: marked };
    const source = state.task ? state.messages.find(({ id }) => id === state.task.messageId) ?? state.task : prompt;
    const owner = source && history.prompts.find(({ uuid, offset }) => uuid === source.uuid || offset === source.offset);
    const boundary = source && { offset: owner?.offset ?? source.offset,
      at: owner?.at ?? (typeof source.at === 'number' ? source.at : recordedAt(source)) };
    const scope = scopeAt(history, runs, atStop, stop, boundary, state.task?.id);
    const outcomes = outcomesAt(state, raw, scope, history, stop);
    for (const [target, list] of [[report.reopened, outcomes.reopened], [report.possible, outcomes.possible]]) {
      for (const row of list) {
        const id = `${row.task}/${row.item}`;
        if (!target.has(id)) target.set(id, row);
      }
    }
    const decision = gateDecision(state, atStop, history, runs, stop, prompt, scope, outcomes);
    const emitted = emit(decision, memory);
    if (stop.summary) report.summaries++;
    if (raw.legacy) report.legacy++;
    if (stop.old?.kind === 'block') report.oldBlocks++;
    if (stop.old?.kind === 'warning') report.warnings++;
    if (stop.old?.kind === 'allowance') report.oldAllowances++;
    if (stop.old?.kind === 'wip') report.wip++;
    if (stop.old?.kind === 'cancelled') report.cancelled++;
    if (!stop.old) report.unobserved++;
    if (decision.check === 6 && decision.kind === 'candidate' && !state.deliveries.length) report.missingDelivery++;
    if (emitted.kind === 'block') report.newBlocks++;
    if (emitted.kind === 'allowance') report.allowances++;
    if (emitted.kind === 'unknown') {
      report.unknown++;
      report.reasons.set(emitted.reason, (report.reasons.get(emitted.reason) ?? 0) + 1);
    }
    const comparable = !!stop.old && !['cancelled', 'message'].includes(stop.old.kind) && emitted.kind !== 'unknown';
    if (comparable) report.comparable++;
    if (comparable && previous?.comparable && ![emitted, previous].some(({ kind, identity }) => kind === 'block' && !identity)) {
      report.adjacent++;
      if (emitted.kind === 'block' && previous.kind === 'block' && emitted.identity === previous.identity) report.identical++;
    }
    previous = { ...emitted, comparable };
  }
  for (const id of report.reopened.keys()) report.possible.delete(id);
  return report;
}
