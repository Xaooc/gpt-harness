import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { processAlive } from './platform.mjs';

const MAX_READ_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OPEN_TOOLS = 256;
const CHECKPOINT_BYTES = 64;

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

async function registryRows(directory) {
  const rows = new Map();
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
        !processAlive(row.pid)) continue;
    const previous = rows.get(row.sessionId);
    if (!previous || (timestamp(row.updatedAt) ?? 0) >= (timestamp(previous.updatedAt) ?? 0)) {
      rows.set(row.sessionId, row);
    }
  }
  return rows;
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

function readToolBlocks(line, tools, statusSince) {
  let row;
  try { row = JSON.parse(line.toString('utf8')); } catch { return; }
  const blocks = row?.message?.content;
  if (row?.isSidechain || !Array.isArray(blocks)) return;
  const since = timestamp(row.timestamp) ?? statusSince;
  for (const block of blocks) {
    if (row.type === 'user' && block?.type === 'tool_result') {
      tools.delete(block.tool_use_id);
    } else if (row.type === 'assistant' && block?.type === 'tool_use' &&
        typeof block.id === 'string' && block.id.length <= 128 && typeof block.name === 'string') {
      const name = oneLine(block.name);
      if (!name) continue;
      tools.delete(block.id);
      tools.set(block.id, { name, detail: toolDetail(name, block.input), since });
      if (tools.size > MAX_OPEN_TOOLS) tools.delete(tools.keys().next().value);
    }
  }
}

function parseChunk(chunk, previous, statusSince) {
  const data = previous?.partial ? Buffer.concat([previous.partial, chunk]) : chunk;
  const tools = new Map(previous?.tools);
  let droppingLine = previous?.droppingLine ?? false;
  let start = 0;
  for (let end; (end = data.indexOf(10, start)) !== -1; start = end + 1) {
    if (!droppingLine && end - start <= MAX_LINE_BYTES) readToolBlocks(data.subarray(start, end), tools, statusSince);
    droppingLine = false;
  }
  // Skip the remainder of an oversized row before resuming at the next line.
  droppingLine ||= data.length - start > MAX_LINE_BYTES;
  const partial = !droppingLine && start < data.length ? Buffer.from(data.subarray(start)) : null;
  return { tools: [...tools], partial, droppingLine };
}

async function tailTranscript(file, handle, previous, statusSince) {
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
  const offset = previous?.offset ?? 0;
  const chunk = Buffer.alloc(Math.min(budget, size - offset));
  const { bytesRead } = chunk.length ? await handle.read(chunk, 0, chunk.length, offset) : { bytesRead: 0 };
  const data = chunk.subarray(0, bytesRead);
  const checkpoint = bytesRead ? Buffer.from(data.subarray(-CHECKPOINT_BYTES)) : previous?.checkpoint ?? Buffer.alloc(0);
  return {
    file, dev, ino, birthtimeMs, mtimeMs, offset: offset + bytesRead, checkpoint,
    ...parseChunk(data, previous, statusSince)
  };
}

export async function readSessions({ claudeHome, now = Date.now(), cursors = {} }) {
  const rows = await registryRows(path.join(claudeHome, 'sessions'));
  const projects = path.join(claudeHome, 'projects');
  let projectEntries;
  const sessions = [];
  const nextCursors = [];
  for (const sessionId of [...rows.keys()].sort()) {
    const row = rows.get(sessionId);
    const cwd = typeof row.cwd === 'string' ? row.cwd : '';
    const statusSince = timestamp(row.statusUpdatedAt) ?? timestamp(row.updatedAt) ?? timestamp(row.startedAt) ?? now;
    const previous = Object.hasOwn(cursors, sessionId) ? cursors[sessionId] : undefined;
    const filename = `${sessionId}.jsonl`;
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
    let cursor;
    if (handle) {
      try {
        cursor = await tailTranscript(file, handle, previous, statusSince);
      } finally {
        await handle.close();
      }
    }
    if (cursor) nextCursors.push([sessionId, cursor]);
    const openTools = cursor?.tools ?? [];
    const agents = openTools.filter(([, tool]) => isAgent(tool.name)).slice(-20)
      .map(([id, tool]) => ({ id, description: tool.detail, since: tool.since }));
    const busy = row.status === 'busy';
    const tool = busy ? openTools.at(-1)?.[1] ?? null : null;
    const name = oneLine(row.name) || (/scratch-workspaces/i.test(cwd) ? '' : basename(cwd));
    sessions.push({
      v: 1, sessionId, name, cwd, updatedAt: now,
      state: tool ? 'tool' : busy ? 'thinking' : 'idle',
      tool, turnSince: busy ? statusSince : 0, idleSince: busy ? 0 : statusSince, agents
    });
  }
  return { sessions, cursors: Object.fromEntries(nextCursors) };
}
