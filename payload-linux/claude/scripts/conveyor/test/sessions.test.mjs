import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSessions } from '../lib/sessions.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
const statusUpdatedAt = now - 5_000;
const toolSince = now - 2_000;

function fixture(t, status = 'busy') {
  const claudeHome = mkdtempSync(path.join(tmpdir(), 'conveyor-sessions-'));
  t.after(() => rmSync(claudeHome, { recursive: true, force: true }));
  const cwd = path.join(claudeHome, 'example');
  const registry = path.join(claudeHome, 'sessions');
  const project = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(registry);
  mkdirSync(project, { recursive: true });
  function register(pid, sessionId) {
    writeFileSync(path.join(registry, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status, statusUpdatedAt }));
  }
  register(process.pid, 'live');
  return {
    cwd, register, transcript: path.join(project, 'live.jsonl'),
    read: (cursors) => readSessions({ claudeHome, now, cursors })
  };
}

function entry(type, block, time = toolSince) {
  return JSON.stringify({ type, timestamp: new Date(time).toISOString(), message: { content: [block] } }) + '\n';
}

function tool(id, name, input, time) {
  return entry('assistant', { type: 'tool_use', id, name, input }, time);
}

test('a busy session shows its Bash tool until the tool result arrives', async (t) => {
  const f = fixture(t);
  writeFileSync(f.transcript, tool('bash', 'Bash', { command: 'echo café\nprintf done' }));
  const open = await f.read();
  assert.deepEqual(open.sessions, [{
    v: 1, sessionId: 'live', name: 'example', cwd: f.cwd, updatedAt: now, state: 'tool',
    tool: { name: 'Bash', detail: 'echo café', since: toolSince },
    turnSince: statusUpdatedAt, idleSince: 0, agents: []
  }]);

  const result = entry('user', { type: 'tool_result', tool_use_id: 'bash', content: 'done' }, now);
  appendFileSync(f.transcript, result.slice(0, -1));
  const partial = await f.read(open.cursors);
  assert.equal(partial.sessions[0].state, 'tool');
  appendFileSync(f.transcript, result.slice(-1));
  const closed = await f.read(partial.cursors);
  assert.equal(closed.sessions[0].state, 'thinking');
  assert.equal(closed.sessions[0].tool, null);
});

test('an idle session is listed and registry entries for dead processes are skipped', async (t) => {
  const f = fixture(t, 'idle');
  f.register(2 ** 31 - 1, 'dead');
  const { sessions, cursors } = await f.read({ dead: {} });
  assert.deepEqual(sessions, [{
    v: 1, sessionId: 'live', name: 'example', cwd: f.cwd, updatedAt: now, state: 'idle',
    tool: null, turnSince: 0, idleSince: statusUpdatedAt, agents: []
  }]);
  assert.equal(Object.hasOwn(cursors, 'dead'), false);
});

test('a shorter transcript resets the cursor and clears old open tools', async (t) => {
  const f = fixture(t);
  writeFileSync(f.transcript, tool('old-agent', 'Agent', { description: 'x'.repeat(1000) }));
  const old = await f.read();
  assert.equal(old.sessions[0].agents[0].id, 'old-agent');
  writeFileSync(f.transcript, tool('edit', 'Edit', { file_path: 'dir\\file.mjs' }, now));
  const fresh = await f.read(old.cursors);
  assert.deepEqual(fresh.sessions[0].tool, { name: 'Edit', detail: 'file.mjs', since: now });
  assert.deepEqual(fresh.sessions[0].agents, []);
});

test('the newest overlapping tool is displayed and an open Agent is listed', async (t) => {
  const f = fixture(t);
  writeFileSync(f.transcript, tool('agent', 'Agent', { description: 'Check the inputs' }) +
    tool('grep', 'Grep', { pattern: 'readSessions' }, now));
  const { sessions } = await f.read();
  assert.equal(sessions[0].state, 'tool');
  assert.deepEqual(sessions[0].tool, { name: 'Grep', detail: 'readSessions', since: now });
  assert.deepEqual(sessions[0].agents, [{ id: 'agent', description: 'Check the inputs', since: toolSince }]);
});
