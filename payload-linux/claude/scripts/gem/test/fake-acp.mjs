#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const [scenario = 'success-with-headings', traceFile, pidFile] = process.argv.slice(2);
const sessionId = `fake-session-${process.pid}`;
const trace = (message) => appendFileSync(traceFile, JSON.stringify(message) + '\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result = {}) => send({ id, result });
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
const models = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'];
let promptId;
let sleeper;

function pids() {
  writeFileSync(pidFile, JSON.stringify({ agent: process.pid, children: sleeper ? [sleeper.pid] : [] }));
}

function finish() {
  let text = scenario === 'success-missing-headings' ? 'Привет, 世界: finished without headings.\n' :
    '## Changes\nUpdated Привет, 世界. ' + 'λ'.repeat(90_000) + '\n\n## Verification\nTests passed.\n\n' +
    '## Deviations\nNone\n\n## Not done\n' + '✅'.repeat(240) + '\n';
  if (scenario === 'answer-diagnostics') {
    text += 'quota exceeded; sign in required; RESOURCE_EXHAUSTED; Eligibility check failed\n' +
      '⚠ You have exhausted your capacity on this model.\n';
  }
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought, never log this' } });
  if (scenario !== 'message-only') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read greeting.txt', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Read greeting.txt',
      status: 'completed' });
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, 40) } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(40) } });
  update({ sessionUpdate: 'usage_update', inputTokens: 64, outputTokens: 128, totalTokens: 192 });
  reply(promptId, { stopReason: 'end_turn', usage: { inputTokens: 64, outputTokens: 128, totalTokens: 192 } });
}

function receive(message) {
  trace({ type: 'received', ...message });
  if (!message.method) {
    if (message.id === 'permission-1') {
      assert.deepEqual(message.result, { outcome: { outcome: 'selected', optionId: 'once-first' } });
      send({ id: 'unsupported-1', method: 'fs/read_text_file', params: { sessionId, path: '/outside' } });
    } else if (message.id === 'unsupported-1') {
      assert.equal(message.error?.code, -32601);
      finish();
    }
    return;
  }
  switch (message.method) {
    case 'initialize':
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, {});
      for (let index = 1; index <= 7; index += 1) process.stdout.write(`startup noise ${index}\n`);
      reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
      break;
    case 'session/new':
      assert.equal(message.params.cwd, process.cwd());
      assert.deepEqual(message.params.mcpServers, []);
      reply(message.id, { sessionId, models: {
        availableModels: models.map((modelId) => ({ modelId, name: modelId }))
      } });
      break;
    case 'session/set_model':
      assert.ok(models.includes(message.params.modelId));
      reply(message.id);
      break;
    case 'session/set_mode':
      assert.equal(message.params.modeId, 'auto');
      reply(message.id);
      break;
    case 'session/prompt':
      promptId = message.id;
      if (scenario === 'hang') {
        sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        pids();
      } else if (scenario === 'provider-exhausted') {
        update({ sessionUpdate: 'agent_message_chunk', content: {
          type: 'text', text: '⚠ You have exhausted your capacity on this model.\n'
        } });
        process.stderr.write('⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429)\n');
        send({ id: promptId, error: { code: 429, message: 'RESOURCE_EXHAUSTED',
          data: { status: 'RESOURCE_EXHAUSTED' } } });
      } else if (scenario === 'permission-request') {
        send({ id: 'permission-1', method: 'session/request_permission', params: {
          sessionId, toolCall: { toolCallId: 'permission-tool', title: 'Run cat greeting.txt' }, options: [
            { optionId: 'reject', kind: 'reject_once' }, { optionId: 'always', kind: 'allow_always' },
            { optionId: 'once-first', kind: 'allow_once' }, { optionId: 'once-second', kind: 'allow_once' }
          ]
        } });
      } else {
        assert.ok(['success-with-headings', 'success-missing-headings', 'answer-diagnostics', 'message-only']
          .includes(scenario));
        finish();
      }
      break;
    case 'session/cancel': break;
    default: send({ id: message.id, error: { code: -32601, message: 'Unknown method' } });
  }
}

trace({ type: 'environment', cwd: process.cwd(), keys: Object.keys(process.env).sort(), env: process.env });
pids();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try { receive(JSON.parse(line)); }
  catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; input.close(); }
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (sleeper && sleeper.exitCode === null) {
    sleeper.once('exit', () => process.exit(0));
    sleeper.kill('SIGTERM');
  } else process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
input.on('close', stop);
