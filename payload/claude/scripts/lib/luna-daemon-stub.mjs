#!/usr/bin/env node
// Fake app-server used only by luna-daemon.mjs --self-test. argv[2] is its audit log.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

let sequence = 0;
let limitsReads = 0;
let limitsFailed = false;
const threads = new Map();
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => send({ method, params });
const audit = (value) => {
  if (process.argv[2]) appendFileSync(process.argv[2], `${JSON.stringify({ at: Date.now(), ...value })}\n`, 'utf8');
};
audit({ event: 'spawn', pid: process.pid, args: process.argv.slice(3),
  managedPackageRoot: process.env.CODEX_MANAGED_PACKAGE_ROOT, managedByNpm: process.env.CODEX_MANAGED_BY_NPM });

const rateLimits = {
  limitId: 'codex', limitName: 'Codex', planType: 'plus', rateLimitReachedType: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: null },
  credits: { balance: 'private-credit-details' }
};
const rollingLimits = { rateLimits: { limitId: 'codex', planType: null,
  primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 2_000_000_060 } } };

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const { id, method, params: p = {} } = message;
  audit({ method, params: p, pid: process.pid });
  const reply = (result) => send({ id, result });
  if (method === 'initialize') reply({ userAgent: 'luna-test' });
  else if (method === 'account/rateLimits/read') {
    const read = ++limitsReads;
    const fail = process.env.LUNA_STUB_LIMITS_FAIL_READ;
    if (fail === 'all' || (fail === 'running' && threads.size > 0 && !limitsFailed)) {
      limitsFailed = true;
      audit({ event: 'limits-failure', pid: process.pid, read });
      send({ id, error: { code: -32000, message: 'fake limits read failure' } });
    } else {
      if (read === 1 && process.env.LUNA_STUB_LIMITS_NOTIFY_DURING_READ === '1') {
        notify('account/rateLimits/updated', rollingLimits);
      }
      reply({
        accountId: 'private-account-id', accessToken: 'private-access-token', ordinaryUsageAllowed: false,
        rateLimits, rateLimitsByLimitId: {
          codex: rateLimits,
          fast: { limitName: 'Fast', primary: null, secondary: null, rateLimitReachedType: 'rate_limit_reached' }
        }
      });
    }
  } else if (method === 'thread/start') {
    if (p.model === 'hang-thread') return;
    const threadId = `thread-${++sequence}`;
    threads.set(threadId, { model: p.model });
    reply({ thread: { id: threadId } });
  } else if (method === 'turn/start') {
    const threadId = p.threadId;
    const turnId = `turn-${++sequence}`;
    const thread = threads.get(threadId);
    thread.turnId = turnId;
    const prompt = p.input[0].text;
    thread.prompt = prompt;
    if (prompt.startsWith('RPC_TIMEOUT')) {
      notify('turn/started', { threadId, turn: { id: turnId } });
      return;
    }
    const started = () => {
      reply({ turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      if (prompt === 'LIMITS_NOTIFY' || prompt === 'LIMITS_NOTIFY_EMPTY') {
        notify('account/rateLimits/updated', prompt === 'LIMITS_NOTIFY_EMPTY' ? {} : rollingLimits);
      }
      if (prompt.startsWith('CRASH')) {
        thread.timer = setTimeout(() => process.exit(7), 300);
        return;
      }
      if (prompt.startsWith('FLOOD')) {
        notify('item/commandExecution/outputDelta', { threadId, turnId, delta: 'x'.repeat(8192) });
      }
      if (prompt.startsWith('WAIT') || prompt.startsWith('SLOW_START') ||
          prompt.startsWith('FLOOD_WAIT') || thread.model === 'hang') return;
      thread.timer = setTimeout(() => {
        notify('item/started', { threadId, item: { id: 'cmd', type: 'commandExecution', command: 'echo fake' } });
        notify('item/commandExecution/outputDelta', { threadId, itemId: 'cmd', turnId, delta: 'streaming output' });
        notify('item/completed', { threadId, item: {
          id: 'cmd', type: 'commandExecution', command: 'echo fake', exitCode: 0, aggregatedOutput: 'fake output'
        } });
        const item = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `answer ${prompt}` };
        notify('item/completed', { threadId, item });
        notify('turn/completed', { threadId, turn: {
          id: turnId, status: prompt === 'FAIL' ? 'failed' : 'completed', items: [item],
          error: prompt === 'FAIL' ? { message: 'fake failure' } : null
        } });
      }, Number(/^DELAY:(\d+)/.exec(prompt)?.[1] || process.env.LUNA_STUB_DELAY_MS || 80));
    };
    if (prompt.startsWith('SLOW_START')) thread.timer = setTimeout(started, 300);
    else started();
  } else if (method === 'turn/interrupt') {
    const thread = threads.get(p.threadId);
    if (thread?.model === 'hang-interrupt') return;
    if (thread) clearTimeout(thread.timer);
    reply({});
    notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [] } });
  } else if (method === 'thread/unsubscribe') {
    const thread = threads.get(p.threadId);
    if (thread?.model === 'hang-unsubscribe') return;
    if (thread) clearTimeout(thread.timer);
    threads.delete(p.threadId);
    reply({ status: thread ? 'unsubscribed' : 'notLoaded' });
    notify('thread/closed', { threadId: p.threadId });
  } else send({ id, error: { code: -32601, message: `unsupported fake RPC ${method}` } });
});
process.stdin.on('end', () => process.exit(0));
