import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, shellLog } from '../../scripts/conveyor/test/process-fixture.mjs';

const hook = fileURLToPath(new URL('../conveyor-subagent-gate.mjs', import.meta.url));
const timeout = 600_000;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor hook test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'conveyor'), bin = path.join(root, 'bin');
  const calls = path.join(root, 'checks.jsonl'), checker = path.join(root, 'check.sh');
  await fs.mkdir(repo);
  await fs.mkdir(bin);
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(repo, 'existing.test.js'), 'original test\n');
  await fs.writeFile(path.join(home, 'sessions', 'session.jsonl'), JSON.stringify({
    at: new Date().toISOString(), session: 'session', repo, base: 'recorded-base', out: 'answer.md', tier: 'complex', mode: 'block'
  }) + '\n');
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/bash
shift 2
case "$1" in
  rev-parse)
    if [ "$2" = --show-toplevel ]; then printf '%s' ${shellQuote(repo)}; else printf 'current-head'; fi ;;
  log) printf 'committed.js\\0' ;;
  diff) printf 'changed.js\\0' ;;
  ls-files) if [[ " $* " == *' --cached '* ]]; then printf 'existing.test.js\\0new.test.js\\0'; fi ;;
  *) printf 'unexpected fake git arguments: %s\\n' "$*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  await fs.writeFile(checker, `#!/bin/bash
${shellLog}
calls=${shellQuote(calls)}
json_args "$@" >> "$calls"
printf '\\n' >> "$calls"
duration=$(wc -l < "$calls")
while [ "$#" -gt 1 ]; do
  case "$1" in --level) level=$2;; --dir) repo=$2;; --base) base=$2;; --files) files=$2;; esac
  shift
done
status=${'${'}FAKE_STATUS:-fail}
rc=1
if [ "$status" = timeout ]; then rc=null; fi
printf '{"ok":false,"level":'; json_string "$level"
printf ',"repo":'; json_string "$repo"
printf ',"base":'; json_string "$base"
printf ',"changed":'; IFS=, read -ra names <<< "$files"; json_args "${'${'}names[@]}"
printf ',"results":[{"name":'; json_string "$level-check"
printf ',"cmd":["fake","check"],"status":'; json_string "$status"
printf ',"rc":%s,"durationMs":%s,"outputTail":' "$rc" "$duration"
json_string "${'${'}FAKE_TAIL:-subagent failure tail}"
printf '}],"hygiene":{"ok":true,"grew":[]}}'
exit 1
`, { mode: 0o755 });
  const input = {
    session_id: 'session', transcript_path: path.join(root, 'parent.jsonl'), cwd: repo, stop_hook_active: false,
    agent_id: 'agent-1', agent_transcript_path: path.join(root, 'agent-1.jsonl'), hook_event_name: 'SubagentStop'
  };
  const run = (payload, extra = {}) => {
    const result = spawnSync(process.execPath, [hook], {
      env: {
        ...process.env, HOME: root, CONVEYOR_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CONVEYOR_CHECK_CMD: JSON.stringify([checker]), ...extra
      }, input: JSON.stringify(payload), encoding: 'utf8', timeout
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  return { repo, calls, input, run };
}

test('SubagentStop blocks a red gate and allows repeated failures when the stop hook is active', { timeout }, async (t) => {
  const { run, input, calls } = await fixture(t);
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
});

test('SubagentStop fingerprints timeout diagnostics while ignoring variable durations', { timeout }, async (t) => {
  const { run, input } = await fixture(t);
  const active = { ...input, stop_hook_active: true };
  const timedOut = run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'first timeout diagnostic' });
  assert.equal(timedOut.decision, 'block');
  assert.match(timedOut.reason, /fast-check: timeout[\s\S]*first timeout diagnostic/);
  const changedTimeout = run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'different timeout diagnostic' });
  assert.equal(changedTimeout.decision, 'block', 'different timeout diagnostics must change the fingerprint');
  assert.match(run(active, { FAKE_STATUS: 'timeout', FAKE_TAIL: 'different timeout diagnostic' }).systemMessage,
    /gate failed again/);
});

test('SubagentStop permits new tests but rejects edits and deletions during a fix round', { timeout }, async (t) => {
  const { run, input, repo, calls } = await fixture(t);
  const active = { ...input, stop_hook_active: true };
  // Establish the original protected-file snapshot before adding a new test in the continuation.
  assert.equal(run(input, { FAKE_STATUS: 'timeout' }).decision, 'block');
  await fs.writeFile(path.join(repo, 'new.test.js'), 'new tests are allowed\n');
  assert.equal(run(active).decision, 'block');
  await fs.writeFile(path.join(repo, 'existing.test.js'), 'edited test\n');
  const count = (await fs.readFile(calls, 'utf8')).trim().split('\n').length;
  assert.equal(run(active).systemMessage, '## Gate: fail (fix round modified tests: existing.test.js)');
  await fs.rm(path.join(repo, 'existing.test.js'));
  assert.equal(run(active).systemMessage, '## Gate: fail (fix round modified tests: existing.test.js)');
  assert.equal((await fs.readFile(calls, 'utf8')).trim().split('\n').length, count);
});
