import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { platform, readProcessStat } from './platform.mjs';

const MAX_READ_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OPEN_TOOLS = 256;
const CHECKPOINT_BYTES = 64;
const UNVERIFIED_MS = 10 * 60_000;
const IDLE_TOOL_MAX_AGE_MS = 30 * 60_000;
const BACKGROUND_AGENT_MAX_AGE_MS = 6 * 60 * 60_000;
const sessionIdentities = Symbol('session identities');
const BACKGROUND_RESULT = /^(?:Async agent launched|(?:Agent|Task) (?:started|launched) in (?:the )?background)/i;
const TERMINAL_TASK_STATUS = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);

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

function backgroundAgentId(block, result, singleResult) {
  if (block.is_error) return undefined;
  const text = Array.isArray(block.content) ? block.content.map((item) => item?.text ?? '').join('\n') : block.content;
  const asyncResult = singleResult && (result?.isAsync === true || result?.status === 'async_launched');
  if (!asyncResult && (typeof text !== 'string' || !BACKGROUND_RESULT.test(text))) return undefined;
  return (asyncResult && (result.taskId ?? result.agentId)) ||
    /\b(?:agentId|taskId):\s*([\w-]+)/i.exec(text)?.[1] || block.tool_use_id;
}

function readToolBlocks(line, tools) {
  let row;
  try { row = JSON.parse(line.toString('utf8')); } catch { return; }
  const content = row?.message?.content;
  if (row?.isSidechain || !['user', 'assistant'].includes(row?.type)) return;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) return;
  const since = timestamp(row.timestamp);
  for (const block of blocks) {
    if (row.type === 'user' && block?.type === 'tool_result') {
      const id = block.tool_use_id;
      const tool = tools.get(id);
      const backgroundId = isAgent(tool?.name) && backgroundAgentId(block, row.toolUseResult, blocks.length === 1);
      if (backgroundId) tools.set(id, { ...tool, backgroundId });
      else tools.delete(id);
    } else if (row.type === 'user' && block?.type === 'text') {
      completeAgents(block.text, tools);
    } else if (row.type === 'assistant' && block?.type === 'tool_use' &&
        since !== undefined && typeof block.id === 'string' && block.id.length <= 128 && typeof block.name === 'string') {
      const name = oneLine(block.name);
      if (!name) continue;
      tools.delete(block.id);
      tools.set(block.id, { name, detail: toolDetail(name, block.input), since });
      if (tools.size > MAX_OPEN_TOOLS) tools.delete(tools.keys().next().value);
    }
  }
  return since;
}

function parseChunk(chunk, previous, skipPartialLine) {
  const data = previous?.partial ? Buffer.concat([previous.partial, chunk]) : chunk;
  const tools = new Map(previous?.tools);
  let droppingLine = previous?.droppingLine ?? skipPartialLine;
  let updatedAt = previous?.updatedAt ?? 0;
  let start = 0;
  for (let end; (end = data.indexOf(10, start)) !== -1; start = end + 1) {
    if (!droppingLine && end - start <= MAX_LINE_BYTES) {
      updatedAt = Math.max(updatedAt, readToolBlocks(data.subarray(start, end), tools) ?? 0);
    }
    droppingLine = false;
  }
  // Skip the remainder of an oversized row before resuming at the next line.
  droppingLine ||= data.length - start > MAX_LINE_BYTES;
  const partial = !droppingLine && start < data.length ? Buffer.from(data.subarray(start)) : null;
  return { tools: [...tools], partial, droppingLine, updatedAt };
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
  return {
    file, dev, ino, birthtimeMs, mtimeMs, offset: offset + bytesRead, checkpoint,
    ...parseChunk(data, previous, skipPartialLine)
  };
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
    if (cursor) nextCursors.push([sessionId, { ...cursor, tools: openTools }]);
    const agents = openTools.filter(([, tool]) => isAgent(tool.name)).slice(-20)
      .map(([id, tool]) => ({ id, description: tool.detail, since: tool.since }));
    const tool = busy ? openTools.findLast(([, entry]) => !entry.backgroundId)?.[1] ?? null : null;
    const name = oneLine(row.name) || (/scratch-workspaces/i.test(cwd) ? '' : basename(cwd));
    const updatedAt = busy && verified ? now : Math.max(statusSince, timestamp(row.updatedAt) ?? 0, cursor?.updatedAt ?? 0);
    sessions.push({
      v: 1, sessionId, name, cwd, updatedAt,
      state: tool ? 'tool' : busy ? 'thinking' : 'idle',
      tool, turnSince: busy ? statusSince : 0, idleSince: busy ? 0 : statusSince, agents
    });
  }
  // Callers that carry forward only cursors also keep the process identity cache.
  const nextCursorState = Object.fromEntries(nextCursors);
  Object.defineProperty(nextCursorState, sessionIdentities, { value: nextIdentities });
  return { sessions, cursors: nextCursorState, identities: nextIdentities };
}
