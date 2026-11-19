import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readProcessStat } from '../lib/platform.mjs';
import { hasLiveSession, readSessions } from '../lib/sessions.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
const statusUpdatedAt = now - 5_000;
const toolSince = now - 2_000;
const procStart = process.platform === 'win32'
  ? await (await import('../../lib/process-identity.mjs')).processStartAsync(process.pid)
  : readProcessStat(process.pid)?.started;

function fixture(t, status = 'busy') {
  const claudeHome = mkdtempSync(path.join(tmpdir(), 'conveyor-sessions-'));
  t.after(() => rmSync(claudeHome, { recursive: true, force: true }));
  const cwd = path.join(claudeHome, 'example');
  const registry = path.join(claudeHome, 'sessions');
  const project = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(registry);
  mkdirSync(project, { recursive: true });
  function register(pid, sessionId, start = procStart) {
    writeFileSync(path.join(registry, `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd, status, statusUpdatedAt, procStart: start
    }));
  }
  register(process.pid, 'live');
  return {
    cwd, register, transcript: path.join(project, 'live.jsonl'),
    hasLiveSession: () => hasLiveSession(claudeHome, now),
    read: (cursors, options) => readSessions({ claudeHome, now, cursors, ...options })
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
    turnSince: statusUpdatedAt, idleSince: 0, agents: [], plan: null, background: []
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
    v: 1, sessionId: 'live', name: 'example', cwd: f.cwd, updatedAt: statusUpdatedAt, state: 'idle',
    tool: null, turnSince: 0, idleSince: statusUpdatedAt, agents: [], plan: null, background: []
  }]);
  assert.equal(Object.hasOwn(cursors, 'dead'), false);
});

test('a recycled registry PID with a different process start is rejected', async (t) => {
  assert.ok(procStart);
  const f = fixture(t);
  f.register(process.pid, 'recycled', String(BigInt(procStart) - 1n));
  assert.deepEqual((await f.read()).sessions, []);
  assert.equal(await f.hasLiveSession(), false);
});

test('session identity is reused across samples and dropped when the PID dies', async (t) => {
  const f = fixture(t);
  const lookups = [];
  const lookupStarts = (pids) => {
    lookups.push(pids);
    return new Map([[process.pid, procStart]]);
  };
  const first = await f.read(undefined, { lookupStarts });
  const second = await f.read(first.cursors, { now: now + 1_000, lookupStarts });
  assert.deepEqual(lookups, [[process.pid]]);
  assert.equal(second.identities.get(process.pid).verified, true);
  assert.equal(second.sessions[0].updatedAt, now + 1_000);

  const kill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === process.pid && signal === 0) throw Object.assign(new Error('PID exited'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  const third = await f.read(second.cursors, { now: now + 2_000, lookupStarts });
  assert.deepEqual(third.sessions, []);
  assert.equal(third.identities.has(process.pid), false);
  assert.deepEqual(lookups, [[process.pid]]);
});

test('a new cursor starts at a line boundary in the recent transcript tail', async (t) => {
  const f = fixture(t);
  const tail = tool('recent', 'Bash', { command: 'echo recent' }, toolSince - 500);
  const old = tool('old', 'Agent', { description: 'Outside the initial tail' });
  const filler = entry('user', { type: 'text', text: 'x'.repeat(256 * 1024) }, toolSince - 1000);
  const text = old + filler + tail;
  writeFileSync(f.transcript, text);
  const { sessions, cursors } = await f.read();
  assert.equal(cursors.live.offset, Buffer.byteLength(text));
  assert.deepEqual(sessions[0].agents, []);
  assert.deepEqual(sessions[0].tool, { name: 'Bash', detail: 'echo recent', since: toolSince - 500 });
  assert.equal(sessions[0].updatedAt, now);
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

test('desktop plan operations update the plan across passes and on a fresh cursor', async (t) => {
  const f = fixture(t);
  const name = 'mcp__ccd_turn__update_plan';
  const items = [
    { content: 'Read the fixture', status: 'in_progress' },
    { content: 'Fix the gate', status: 'pending' },
    { content: 'Verify the change', status: 'pending' },
    { content: 'Summarize the work', status: 'pending' }
  ];
  writeFileSync(f.transcript, tool('plan', name, { items }));
  let result = await f.read();
  assert.deepEqual(result.sessions[0].plan, { total: 4, done: 0, current: items[0].content, items, updatedAt: toolSince });

  for (const [index, operation] of [
    [1, { input: { advance: true }, done: 1, current: items[1].content }],
    [2, { input: { done: [2, 3], start: 4 }, done: 3, current: items[3].content }],
    [3, { name: 'mcp__ccd_turn__wrap_up', input: {}, done: 4, current: null }]
  ]) {
    const time = toolSince + index;
    if (index === 2) appendFileSync(f.transcript, entry('user', { type: 'text', text: 'x'.repeat(256 * 1024) }));
    appendFileSync(f.transcript, tool(`plan-${index}`, operation.name ?? name, operation.input, time));
    result = await f.read(result.cursors);
    // The incremental cursor may need another pass to read through the padding.
    result = await f.read(result.cursors);
    const { total, done, current, updatedAt } = result.sessions[0].plan;
    assert.deepEqual({ total, done, current, updatedAt }, { total: 4, done: operation.done, current: operation.current, updatedAt: time });
  }

  assert.deepEqual((await f.read()).sessions[0].plan, result.sessions[0].plan);
});

test('completed background commands disappear while monitors and executors remain visible', async (t) => {
  const f = fixture(t);
  const result = (id, content) => entry('user', { type: 'tool_result', tool_use_id: id, content }, now);
  const bash = { id: 'shell-1', kind: 'command', text: 'Run the build', since: toolSince };
  const monitor = { id: 'monitor-1', kind: 'monitor', text: 'Watch the build', since: toolSince + 1 };
  writeFileSync(f.transcript,
    tool('bash', 'Bash', { command: 'make', description: bash.text, run_in_background: true }) +
    result('bash', `Command running in background with ID: ${bash.id}.`) +
    tool('monitor', 'Monitor', { description: monitor.text }, monitor.since) +
    result('monitor', [{ type: 'text', text: `Monitor started (task ${monitor.id}, expires in 30m).` }]));
  const started = await f.read();
  assert.deepEqual(started.sessions[0].background, [monitor, bash]);

  appendFileSync(f.transcript, JSON.stringify({
    type: 'user', timestamp: new Date(now).toISOString(), origin: { kind: 'task-notification' },
    message: { content: `<task-notification><task-id>${bash.id}</task-id><status>completed</status></task-notification>` }
  }) + '\n');
  const completed = await f.read(started.cursors);
  assert.deepEqual(completed.sessions[0].background, [monitor]);

  const command = 'node ~/.claude/scripts/conveyor/exec.mjs run';
  appendFileSync(f.transcript, tool('exec', 'Bash', { command, run_in_background: true }, toolSince + 2) +
    result('exec', 'Command running in background with ID: shell-2.'));
  const withExecutor = await f.read(completed.cursors);
  assert.deepEqual(withExecutor.sessions[0].background, [
    { id: 'shell-2', kind: 'executor', text: command, since: toolSince + 2 }, monitor
  ]);

  // A notification that arrives mid-turn is queued: written as an attachment row, not as a user message.
  appendFileSync(f.transcript, JSON.stringify({
    type: 'attachment', timestamp: new Date(now).toISOString(),
    attachment: { type: 'queued_command', prompt: `<task-notification><task-id>${monitor.id}</task-id><status>completed</status></task-notification>` }
  }) + '\n');
  assert.deepEqual((await f.read(withExecutor.cursors)).sessions[0].background, [
    { id: 'shell-2', kind: 'executor', text: command, since: toolSince + 2 }
  ]);
});
