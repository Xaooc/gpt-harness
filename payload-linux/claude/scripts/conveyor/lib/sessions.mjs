import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { platform, readProcessStat } from './platform.mjs';

const MAX_READ_BYTES = 256 * 1024;
const MAX_PLAN_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OPEN_TOOLS = 256;
const CHECKPOINT_BYTES = 64;
const UNVERIFIED_MS = 10 * 60_000;
const IDLE_TOOL_MAX_AGE_MS = 30 * 60_000;
const BACKGROUND_AGENT_MAX_AGE_MS = 6 * 60 * 60_000;
const BACKGROUND_MAX_AGE_MS = 6 * 60 * 60_000;
const MONITOR_MAX_AGE_MS = 31 * 60_000;
const sessionIdentities = Symbol('session identities');
const BACKGROUND_RESULT = /^(?:Async agent launched|(?:Agent|Task) (?:started|launched) in (?:the )?background)/i;
const TERMINAL_TASK_STATUS = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);
const TERMINAL_BACKGROUND_STATUS = new Set([...TERMINAL_TASK_STATUS, 'timeout', 'error']);
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);

const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function timestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isFinite(time) ? time : undefined;
}

async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return []; throw error; }
}

async function openFile(file) {
  try { return await open(file, 'r'); }
  catch (error) {
    if (missing(error) || ['EISDIR', 'ENAMETOOLONG'].includes(error.code)) return null;
    throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function linuxStarts(pids) {
  return new Map(pids.map((pid) => {
    const stat = readProcessStat(pid);
    return [pid, stat?.state === 'Z' ? null : stat?.started];
  }));
}

async function registryRows(directory, now, identities = new Map(), lookupStarts) {
  const candidates = [];
  const buffer = Buffer.alloc(64 * 1024);
  for (const entry of await entries(directory)) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const handle = await openFile(path.join(directory, entry.name));
    if (!handle) continue;
    let row;
    try {
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === buffer.length) continue;
      row = JSON.parse(buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, ''));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    } finally {
      await handle.close();
    }
    if (typeof row?.sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.sessionId) ||
        !pidAlive(row.pid)) continue;
    candidates.push(row);
  }
  const pids = [...new Set(candidates.map(({ pid }) => pid))];
  const nextIdentities = new Map();
  const pending = [];
  for (const pid of pids) {
    const cached = identities.get(pid);
    if (cached && now - cached.checkedAt < UNVERIFIED_MS) nextIdentities.set(pid, cached);
    else pending.push(pid);
  }
  const identity = platform === 'win32' && pids.length ? await import('../../lib/process-identity.mjs') : null;
  if (pending.length) {
    const starts = await (lookupStarts ?? identity?.processStartsAsync ?? linuxStarts)(pending);
    for (const pid of pending) {
      const actual = starts.get(pid);
      if (actual !== null && pidAlive(pid)) nextIdentities.set(pid, { actual, checkedAt: now });
    }
  }
  const rows = new Map();
  for (const row of candidates) {
    const cached = nextIdentities.get(row.pid);
    if (!cached) continue;
    const expected = row.procStart ? String(row.procStart) : '';
    let { verified } = cached;
    if (cached.expected !== expected) {
      verified = Boolean(expected && cached.actual &&
        (identity ? identity.sameStart(cached.actual, expected) : cached.actual === expected));
      nextIdentities.set(row.pid, { ...cached, expected, verified });
    }
    if (cached.actual) {
      if (!verified) continue;
    } else {
      const updated = Math.max(timestamp(row.statusUpdatedAt) ?? 0, timestamp(row.updatedAt) ?? 0);
      if (!(updated > now - UNVERIFIED_MS)) continue;
    }
    const previous = rows.get(row.sessionId);
    if (!previous || (timestamp(row.updatedAt) ?? 0) >= (timestamp(previous.row.updatedAt) ?? 0)) {
      rows.set(row.sessionId, { row, verified });
    }
  }
  return { rows, identities: nextIdentities };
}

export async function hasLiveSession(claudeHome, now = Date.now()) {
  return (await registryRows(path.join(claudeHome, 'sessions'), now)).rows.size > 0;
}

function oneLine(value, max = 80) {
  if (typeof value !== 'string') return '';
  const clean = value.split(/\r?\n/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const basename = (value) => typeof value === 'string' ? value.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
const isAgent = (name) => name === 'Agent' || name === 'Task';

function toolDetail(name, input) {
  if (name === 'Bash') return oneLine(input?.command);
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) {
    return oneLine(basename(input?.file_path ?? input?.notebook_path));
  }
  if (name === 'Grep' || name === 'Glob') return oneLine(input?.pattern, 60);
  if (isAgent(name)) return oneLine(input?.description, 60);
  if (name === 'WebSearch') return oneLine(input?.query, 60);
  if (name === 'WebFetch') {
    try { return oneLine(new URL(input?.url).host); } catch { return ''; }
  }
  return '';
}

function planOperation(block, since) {
  if (block?.type !== 'tool_use' || typeof block.name !== 'string') return;
  const { name, input } = block;
  if (name.endsWith('__wrap_up')) return { type: 'wrap', since };
  const isTodo = name === 'TodoWrite';
  if (!isTodo && !name.endsWith('__update_plan')) return;
  const steps = isTodo ? input?.todos : input?.items;
  if (Array.isArray(steps) && steps.every(item => typeof item?.content === 'string' && PLAN_STATUSES.has(item.status))) {
    const items = steps.map(item => ({
      content: oneLine(item.content, 120), status: item.status, activeForm: isTodo ? oneLine(item.activeForm, 120) : ''
    }));
    return { type: 'replace', items, since };
  }
  if (isTodo) return;
  if (input?.advance === true) return { type: 'advance', since };
  if (Array.isArray(input?.done) || Number.isInteger(input?.start)) {
    return { type: 'update', done: new Set(Array.isArray(input.done) ? input.done : []), start: input.start, since };
  }
}

function applyPlan(plan, operation) {
  const { type, since } = operation;
  if (type === 'replace') return { items: operation.items, updatedAt: since };
  if (!plan) return plan;

  let current = -1;
  let next = -1;
  if (type === 'advance') {
    current = plan.items.findIndex(item => item.status === 'in_progress');
    next = plan.items.findIndex((item, index) => index > current && item.status === 'pending');
  }
  let changed = false;
  const items = plan.items.map((item, index) => {
    let { status } = item;
    if ((type === 'wrap' && status === 'in_progress') || index === current || operation.done?.has(index + 1)) {
      status = 'completed';
    }
    if (index === next || index + 1 === operation.start) status = 'in_progress';
    if (status === item.status) return item;
    changed = true;
    return { ...item, status };
  });
  return changed ? { items, updatedAt: since } : plan;
}

function publishedPlan(plan) {
  if (!plan) return null;
  const { items, updatedAt } = plan;
  const current = items.find(item => item.status === 'in_progress');
  return {
    total: items.length, done: items.filter(item => item.status === 'completed').length,
    current: current ? current.activeForm || current.content : null,
    items: items.slice(0, 12).map(({ content, status }) => ({ content, status })), updatedAt
  };
}

function backgroundTool(name, input) {
  if (name === 'Monitor') return { kind: 'monitor', text: oneLine(input?.description, 120) };
  if (name !== 'Bash' || input?.run_in_background !== true) return;
  const command = typeof input.command === 'string' ? input.command : '';
  const kind = /conveyor\/exec\.mjs run|luna(?:-panel)?\.sh/.test(command) ? 'executor' : 'command';
  return { kind, text: oneLine(input.description || command.slice(0, 80), 120) };
}

function completeBackground(text, background) {
  if (!background.size || typeof text !== 'string') return;
  for (const [, notice] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const status = /<status>([^<]+)<\/status>/.exec(notice)?.[1]?.trim();
    if (!TERMINAL_BACKGROUND_STATUS.has(status)) continue;
    const id = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1]?.trim();
    background.delete(id);
  }
}

function completeAgents(text, tools) {
  if (typeof text !== 'string' || !text.startsWith('<task-notification>')) return;
  for (const [, notice] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const status = /<status>([^<]+)<\/status>/.exec(notice)?.[1];
    if (!TERMINAL_TASK_STATUS.has(status)) continue;
    const toolId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1];
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1];
    for (const [id, tool] of tools) {
      if (isAgent(tool.name) && (id === toolId || taskId && tool.backgroundId === taskId)) tools.delete(id);
    }
  }
}

function resultText(block) {
  return Array.isArray(block.content) ? block.content.map((item) => item?.text ?? '').join('\n') : block.content;
}

function backgroundAgentId(block, result, singleResult) {
  if (block.is_error) return undefined;
  const text = resultText(block);
  const asyncResult = singleResult && (result?.isAsync === true || result?.status === 'async_launched');
  if (!asyncResult && (typeof text !== 'string' || !BACKGROUND_RESULT.test(text))) return undefined;
  return (asyncResult && (result.taskId ?? result.agentId)) ||
    /\b(?:agentId|taskId):\s*([\w-]+)/i.exec(text)?.[1] || block.tool_use_id;
}

function readToolBlocks(line, state, unbasedPlanOperations) {
  let row;
  try { row = JSON.parse(line.toString('utf8')); } catch { return; }
  const content = row?.message?.content;
  // A task notification delivered while the session is mid-turn is queued, not sent as a user message: it is written
  // as an `attachment` row (queued_command prompt) and a `queue-operation` row (content), never as a user entry.
  const queued = row?.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt
    : row?.type === 'queue-operation' ? row.content : undefined;
  if (!row?.isSidechain && typeof queued === 'string' && queued.startsWith('<task-notification>')) {
    completeAgents(queued, state.tools);
    completeBackground(queued, state.background);
    return;
  }
  if (row?.isSidechain || !['user', 'assistant'].includes(row?.type)) return;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) return;
  const since = timestamp(row.timestamp);
  const { tools, background } = state;
  for (const block of blocks) {
    if (row.type === 'user' && block?.type === 'tool_result') {
      const id = block.tool_use_id;
      const tool = tools.get(id);
      if (tool?.background && !block.is_error) {
        const start = tool.background.kind === 'monitor' ? /Monitor started \(task ([\w-]+),/ :
          /Command running in background with ID: ([\w-]+)\./;
        const taskId = start.exec(resultText(block))?.[1];
        if (taskId) {
          background.delete(taskId);
          background.set(taskId, { id: taskId, ...tool.background, since: tool.since });
        }
      }
      const backgroundId = isAgent(tool?.name) && backgroundAgentId(block, row.toolUseResult, blocks.length === 1);
      if (backgroundId) tools.set(id, { ...tool, backgroundId });
      else tools.delete(id);
    } else if (row.type === 'user' && block?.type === 'text') {
      completeAgents(block.text, tools);
      completeBackground(block.text, background);
    } else if (row.type === 'assistant' && block?.type === 'tool_use' && typeof block.name === 'string') {
      if (block.name === 'TaskStop') background.delete(block.input?.task_id || block.input?.shell_id);
      if (since === undefined) continue;
      const operation = planOperation(block, since);
      if (operation) {
        state.plan = applyPlan(state.plan, operation);
        if (!state.plan) unbasedPlanOperations?.push(operation);
      }
      if (typeof block.id !== 'string' || block.id.length > 128) continue;
      const name = oneLine(block.name);
      if (!name) continue;
      const pendingBackground = backgroundTool(name, block.input);
      tools.delete(block.id);
      tools.set(block.id, { name, detail: toolDetail(name, block.input), since, background: pendingBackground });
      if (tools.size > MAX_OPEN_TOOLS) tools.delete(tools.keys().next().value);
    }
  }
  return since;
}

function parseChunk(chunk, previous, skipPartialLine, unbasedPlanOperations) {
  const data = previous?.partial ? Buffer.concat([previous.partial, chunk]) : chunk;
  const state = { tools: new Map(previous?.tools), plan: previous?.plan ?? null, background: new Map(previous?.background) };
  let droppingLine = previous?.droppingLine ?? skipPartialLine;
  let updatedAt = previous?.updatedAt ?? 0;
  let start = 0;
  for (let end; (end = data.indexOf(10, start)) !== -1; start = end + 1) {
    if (!droppingLine && end - start <= MAX_LINE_BYTES) {
      updatedAt = Math.max(updatedAt, readToolBlocks(data.subarray(start, end), state, unbasedPlanOperations) ?? 0);
    }
    droppingLine = false;
  }
  // Skip the remainder of an oversized row before resuming at the next line.
  droppingLine ||= data.length - start > MAX_LINE_BYTES;
  const partial = !droppingLine && start < data.length ? Buffer.from(data.subarray(start)) : null;
  return { ...state, tools: [...state.tools], partial, droppingLine, updatedAt };
}

function collectPlanOperations(line, operations) {
  if (!line.includes('__update_plan') && !line.includes('TodoWrite') && !line.includes('__wrap_up')) return false;
  let row;
  try { row = JSON.parse(line.toString('utf8')); } catch { return false; }
  const since = timestamp(row?.timestamp);
  const blocks = row?.message?.content;
  if (row?.type !== 'assistant' || row.isSidechain || since === undefined || !Array.isArray(blocks)) return false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const operation = planOperation(blocks[index], since);
    if (!operation) continue;
    operations.push(operation);
    if (operation.type === 'replace') return true;
  }
  return false;
}

async function readPlanHistory(handle, offset, limit, partial, operations) {
  const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, offset - limit));
  while (offset > limit) {
    const start = Math.max(limit, offset - buffer.length);
    const length = offset - start;
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) return null;
    const chunk = buffer.subarray(0, length);
    let end = chunk.length;
    // A null fragment marks a row whose end is missing or exceeds the line limit.
    while (end > 0) {
      const newline = chunk.lastIndexOf(10, end - 1);
      if (newline === -1) break;
      if (partial && end - newline - 1 + partial.length <= MAX_LINE_BYTES) {
        const suffix = chunk.subarray(newline + 1, end);
        const line = partial.length ? Buffer.concat([suffix, partial]) : suffix;
        if (collectPlanOperations(line, operations)) return operations.reverse().reduce(applyPlan, null);
      }
      partial = Buffer.alloc(0);
      end = newline;
    }
    partial = partial && end + partial.length <= MAX_LINE_BYTES ? Buffer.concat([chunk.subarray(0, end), partial]) : null;
    offset = start;
  }
  if (partial && collectPlanOperations(partial, operations)) return operations.reverse().reduce(applyPlan, null);
  return null;
}

async function tailTranscript(file, handle, previous) {
  const stat = await handle.stat();
  if (!stat.isFile()) return undefined;
  const { size, dev, ino, birthtimeMs, mtimeMs } = stat;
  if (previous?.file !== file || previous.dev !== dev || previous.ino !== ino ||
      previous.birthtimeMs !== birthtimeMs || size < previous.offset) previous = undefined;
  if (previous?.offset === size && previous.mtimeMs === mtimeMs) return previous;

  let budget = MAX_READ_BYTES;
  if (previous?.checkpoint.length) {
    // Verify the old boundary in case the file was truncated and regrew between reads.
    const boundary = Buffer.alloc(previous.checkpoint.length);
    const { bytesRead } = await handle.read(boundary, 0, boundary.length, previous.offset - boundary.length);
    budget -= bytesRead;
    if (bytesRead !== boundary.length || !boundary.equals(previous.checkpoint)) previous = undefined;
  }
  const offset = previous?.offset ?? Math.max(0, size - budget);
  let skipPartialLine = false;
  if (!previous && offset > 0) {
    const before = Buffer.alloc(1);
    await handle.read(before, 0, 1, offset - 1);
    skipPartialLine = before[0] !== 10;
  }
  const chunk = Buffer.alloc(Math.min(budget, size - offset));
  const { bytesRead } = chunk.length ? await handle.read(chunk, 0, chunk.length, offset) : { bytesRead: 0 };
  const data = chunk.subarray(0, bytesRead);
  const checkpoint = bytesRead ? Buffer.from(data.subarray(-CHECKPOINT_BYTES)) : previous?.checkpoint ?? Buffer.alloc(0);
  const unbasedPlanOperations = !previous && offset > 0 ? [] : null;
  const state = parseChunk(data, previous, skipPartialLine, unbasedPlanOperations);
  if (unbasedPlanOperations && !state.plan) {
    const newline = skipPartialLine ? data.indexOf(10) : 0;
    const fragment = newline === -1 ? null : data.subarray(0, newline);
    state.plan = await readPlanHistory(handle, offset, Math.max(0, size - MAX_PLAN_HISTORY_BYTES),
      fragment, unbasedPlanOperations.reverse());
  }
  return { file, dev, ino, birthtimeMs, mtimeMs, offset: offset + bytesRead, checkpoint, ...state };
}

export async function readSessions({
  claudeHome, now = Date.now(), cursors = {}, identities = cursors[sessionIdentities], lookupStarts
}) {
  const { rows, identities: nextIdentities } = await registryRows(path.join(claudeHome, 'sessions'), now, identities, lookupStarts);
  const projects = path.join(claudeHome, 'projects');
  let projectEntries;
  const sessions = [];
  const nextCursors = [];
  for (const sessionId of [...rows.keys()].sort()) {
    const { row, verified } = rows.get(sessionId);
    const cwd = typeof row.cwd === 'string' ? row.cwd : '';
    const statusSince = timestamp(row.statusUpdatedAt) ?? timestamp(row.updatedAt) ?? timestamp(row.startedAt) ?? 0;
    const previous = Object.hasOwn(cursors, sessionId) ? cursors[sessionId] : undefined;
    const filename = `${sessionId}.jsonl`;
    let cursor;
    try {
      let file = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), filename);
      let handle = await openFile(file);
      if (!handle && previous?.file && previous.file !== file) {
        file = previous.file;
        handle = await openFile(file);
      }
      if (!handle) {
        // Resumed sessions can point at a cwd other than the transcript's original project.
        projectEntries ??= (await entries(projects)).filter((entry) => entry.isDirectory());
        for (const entry of projectEntries) {
          file = path.join(projects, entry.name, filename);
          handle = await openFile(file);
          if (handle) break;
        }
      }
      if (handle) {
        try {
          cursor = await tailTranscript(file, handle, previous);
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (typeof error.errno !== 'number') throw error;
      cursor = undefined;
    }
    const busy = row.status === 'busy';
    const openTools = (cursor?.tools ?? []).filter(([, tool]) => tool.backgroundId
      ? now - tool.since <= BACKGROUND_AGENT_MAX_AGE_MS
      : busy || now - tool.since <= IDLE_TOOL_MAX_AGE_MS);
    const activeBackground = new Map();
    for (const [id, task] of cursor?.background ?? []) {
      const age = now - task.since;
      if (age <= BACKGROUND_MAX_AGE_MS && (task.kind !== 'monitor' || age < MONITOR_MAX_AGE_MS)) {
        activeBackground.set(id, task);
      }
    }
    const background = [...activeBackground.values()].reverse().sort((a, b) => b.since - a.since).slice(0, 10);
    if (cursor) nextCursors.push([sessionId, { ...cursor, tools: openTools, background: activeBackground }]);
    const agents = openTools.filter(([, tool]) => isAgent(tool.name)).slice(-20)
      .map(([id, tool]) => ({ id, description: tool.detail, since: tool.since }));
    const currentTool = busy ? openTools.findLast(([, entry]) => !entry.backgroundId)?.[1] : undefined;
    const tool = currentTool ? { name: currentTool.name, detail: currentTool.detail, since: currentTool.since } : null;
    const name = oneLine(row.name) || (/scratch-workspaces/i.test(cwd) ? '' : basename(cwd));
    const updatedAt = busy && verified ? now : Math.max(statusSince, timestamp(row.updatedAt) ?? 0, cursor?.updatedAt ?? 0);
    sessions.push({
      v: 1, sessionId, name, cwd, updatedAt,
      state: tool ? 'tool' : busy ? 'thinking' : 'idle',
      tool, turnSince: busy ? statusSince : 0, idleSince: busy ? 0 : statusSince, agents,
      plan: publishedPlan(cursor?.plan), background
    });
  }
  // Callers that carry forward only cursors also keep the process identity cache.
  const nextCursorState = Object.fromEntries(nextCursors);
  Object.defineProperty(nextCursorState, sessionIdentities, { value: nextIdentities });
  return { sessions, cursors: nextCursorState, identities: nextIdentities };
}
