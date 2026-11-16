import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const hook = fileURLToPath(new URL('../conveyor-subagent-gate.mjs', import.meta.url));
const timeout = 600_000;

test('SubagentStop blocks a red gate and allows repeated failures when the stop hook is active', { timeout }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor hook test-'));
  try {
    const repo = path.join(root, 'repo'), home = path.join(root, 'conveyor'), bin = path.join(root, 'bin');
    const calls = path.join(root, 'checks.jsonl'), checker = path.join(root, 'check.mjs');
    await fs.mkdir(repo);
    await fs.mkdir(bin);
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(repo, 'existing.test.js'), 'original test\n');
    await fs.writeFile(path.join(home, 'sessions', 'session.jsonl'), JSON.stringify({
      at: new Date().toISOString(), session: 'session', repo, base: 'recorded-base', out: 'answer.md', tier: 'complex', mode: 'block'
    }) + '\n');
    await fs.writeFile(path.join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(4);
if (args[0] === 'rev-parse') {
  process.stdout.write(args[1] === '--show-toplevel' ? ${JSON.stringify(repo)} : 'current-head');
} else if (args[0] === 'log') process.stdout.write('committed.js\\0');
else if (args[0] === 'diff') process.stdout.write('changed.js\\0');
else if (args[0] === 'ls-files' && args.includes('--cached')) process.stdout.write('existing.test.js\\0new.test.js\\0');
else if (args[0] !== 'ls-files') throw new Error('unexpected fake git arguments');
`, { mode: 0o755 });
    await fs.writeFile(checker, `import * as fs from 'node:fs';
const args = process.argv.slice(2), option = (name) => args[args.indexOf(name) + 1];
const file = ${JSON.stringify(calls)};
fs.appendFileSync(file, JSON.stringify(args) + '\\n');
const durationMs = fs.readFileSync(file, 'utf8').trim().split('\\n').length;
process.stdout.write(JSON.stringify({
  ok: false, level: option('--level'), repo: option('--dir'), base: option('--base'),
  changed: option('--files').split(','),
  results: [{ name: option('--level') + '-check', cmd: ['fake', 'check'], status: process.env.FAKE_STATUS || 'fail',
    rc: process.env.FAKE_STATUS === 'timeout' ? null : 1, durationMs,
    outputTail: process.env.FAKE_TAIL || 'subagent failure tail' }], hygiene: { ok: true, grew: [] }
}));
process.exitCode = 1;
`);
    const input = {
      session_id: 'session', transcript_path: path.join(root, 'parent.jsonl'), cwd: repo, stop_hook_active: false,
      agent_id: 'agent-1', agent_transcript_path: path.join(root, 'agent-1.jsonl'), hook_event_name: 'SubagentStop'
    };
    const run = (payload, extra = {}) => {
      const result = spawnSync(process.execPath, [hook], {
        env: {
          ...process.env, HOME: root, CONVEYOR_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          CONVEYOR_CHECK_CMD: JSON.stringify([process.execPath, checker]), ...extra
        }, input: JSON.stringify(payload), encoding: 'utf8', timeout
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };
    const blocked = run(input);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /fast-check[\s\S]*turn-check/);
    assert.match(blocked.reason, /subagent failure tail/);
    assert.match(blocked.reason, /Do not weaken, skip or delete checks, tests, lint rules or hygiene counters/);
    assert.match(blocked.reason, /Do not revert the requested change/);
    const repeated = run({ ...input, stop_hook_active: true });
    assert.equal(repeated.decision, undefined);
    assert.match(repeated.systemMessage, /gate failed again; allowing stop to avoid a loop/);
    const checks = (await fs.readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(checks.map((args) => args[args.indexOf('--level') + 1]), ['fast', 'turn', 'fast', 'turn']);
    for (const args of checks) {
      assert.equal(args[args.indexOf('--base') + 1], 'recorded-base');
      assert.equal(args[args.indexOf('--files') + 1], 'changed.js,committed.js');
    }
    const active = { ...input, stop_hook_active: true };
    const timedOut = run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'first timeout diagnostic' });
    assert.equal(timedOut.decision, 'block');
    assert.match(timedOut.reason, /fast-check: timeout[\s\S]*first timeout diagnostic/);
    const changedTimeout = run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'different timeout diagnostic' });
    assert.equal(changedTimeout.decision, 'block', 'different timeout diagnostics must change the fingerprint');
    assert.match(run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'different timeout diagnostic' }).systemMessage,
      /gate failed again/);
    await fs.writeFile(path.join(repo, 'new.test.js'), 'new tests are allowed\n');
    assert.equal(run(active).decision, 'block');
    await fs.writeFile(path.join(repo, 'existing.test.js'), 'edited test\n');
    const count = (await fs.readFile(calls, 'utf8')).trim().split('\n').length;
    assert.equal(run(active).systemMessage, '## Gate: fail (fix round modified tests: existing.test.js)');
    await fs.rm(path.join(repo, 'existing.test.js'));
    assert.equal(run(active).systemMessage, '## Gate: fail (fix round modified tests: existing.test.js)');
    assert.equal((await fs.readFile(calls, 'utf8')).trim().split('\n').length, count);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
