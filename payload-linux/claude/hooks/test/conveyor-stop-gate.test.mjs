import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main as ledgerMain } from '../../scripts/conveyor/ledger.mjs';
import { invoke, invokeHook, shellList, shellLog } from '../../scripts/conveyor/test/process-fixture.mjs';

const gate = fileURLToPath(new URL('../conveyor-stop-gate.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../conveyor-prompt-capture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/conveyor/ledger.mjs', import.meta.url));
const timeout = 600_000;

async function fixture(t, { writeRun = true, changed = writeRun, gitRepo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-stop-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'conveyor'), bin = path.join(root, 'bin');
  const transcript = path.join(root, 'transcript.jsonl'), calls = path.join(root, 'calls.jsonl');
  const proof = path.join(root, 'proof.log'), worker = path.join(repo, 'worker.mjs');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(worker, 'export const result = true;\n');
  fs.writeFileSync(proof, 'Fresh verification\n');
  fs.utimesSync(worker, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  const session = 'stop-test';
  const env = {
    ...process.env, HOME: root, CLAUDE_HOME_DIR: path.join(root, 'claude'), CONVEYOR_HOME: home,
    CLAUDE_CODE_SESSION_ID: session, CLAUDE_CODE_TRANSCRIPT_PATH: transcript, CONVEYOR_GATE_MODE: 'block',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CALLS: calls, FAKE_CHECK_OK: '1', FAKE_CHECK_RC: '0',
    FAKE_JOBS: '[]', FAKE_WORKTREES: '', FAKE_RESPONSE: '{"missing":[],"misread":[]}',
    FAKE_CHANGED: changed ? '1' : '0', FAKE_NONGIT: gitRepo ? '0' : '1', FAKE_HEAD: 'task-base'
  };
  const fake = path.join(root, 'fake.sh');
  fs.writeFileSync(fake, `#!/bin/bash
${shellLog}
kind=$1
shift
log_call "$kind" "$@"
case "$kind" in
  check)
    ok=false
    if [ "$FAKE_CHECK_OK" = 1 ]; then ok=true; fi
    printf '{"ok":%s,"results":[],"hygiene":{}}' "$ok"
    exit "$FAKE_CHECK_RC" ;;
  overview) printf '{"jobs":%s}' "$FAKE_JOBS" ;;
  crosscheck)
    if [ -n "$FAKE_CROSSCHECK_RC" ]; then printf 'scout unavailable' >&2; exit "$FAKE_CROSSCHECK_RC"; fi
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -o ]; then printf '%s' "$FAKE_RESPONSE" > "$2"; break; fi
      shift
    done ;;
esac
`, { mode: 0o755 });
  env.CONVEYOR_CHECK_CMD = JSON.stringify([fake, 'check']);
  env.CONVEYOR_OVERVIEW_CMD = JSON.stringify([fake, 'overview']);
  env.CONVEYOR_CROSSCHECK_CMD = JSON.stringify([fake, 'crosscheck']);
  // A shell fake avoids starting Node for every git query made by the real gate.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
${shellLog}
repo=$2
shift 2
log_call git "$@"
[ "$FAKE_NONGIT" != 1 ] || exit 128
changed=$FAKE_CHANGED
if [ -n "$FAKE_CHANGED_REPO" ] && [ "$FAKE_CHANGED_REPO" != "$repo" ]; then changed=0; fi
nul_list() { eval "set -- $1"; if [ "$#" -gt 0 ]; then printf '%s\\0' "$@"; fi; }
case "$1" in
  rev-parse)
    case "$2" in --show-toplevel) printf '%s' "$repo";; HEAD) printf '%s' "$FAKE_HEAD";; esac ;;
  ls-files) nul_list "$FAKE_UNTRACKED_ARGS" ;;
  log)
    if [[ " $* " == *' --format=%H '* ]]; then
      [ "$FAKE_NO_NEW_COMMITS" = 1 ] || printf '%s' "$FAKE_HEAD"
    else nul_list "$FAKE_COMMITTED_ARGS"; fi ;;
  diff)
    if [[ " $* " == *' --name-only '* ]]; then
      if [[ " $* " == *' --cached '* ]]; then nul_list "$FAKE_STAGED_ARGS"
      elif [ "$changed" = 1 ]; then printf 'worker.mjs\\0'; fi
    elif [[ " $* " == *' --stat '* ]]; then printf ' worker.mjs | 1 +\\n'
    else printf '+export const result = true;\\n'; fi ;;
  worktree) printf '%s' "$FAKE_WORKTREES" ;;
esac
exit 0
`, { mode: 0o755 });
  let sequence = 0;
  const append = (entry) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: session, ...entry }) + '\n');
  const user = (text) => append({ type: 'user', uuid: `u${++sequence}`, origin: { kind: 'human' }, message: { content: text } });
  const assistant = (text) => append({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const run = async (program, args, extra = {}, input) => {
    const callEnv = { ...env, ...extra };
    for (const key of ['FAKE_UNTRACKED', 'FAKE_COMMITTED', 'FAKE_STAGED']) {
      callEnv[`${key}_ARGS`] = shellList(JSON.parse(callEnv[key] || '[]'));
    }
    const options = { env: callEnv, cwd: repo, input };
    const result = program === cli ? await invoke(ledgerMain, args, options) : await invokeHook(program, options);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const command = async (args, extra = {}, rc = 0) => {
    const result = await run(cli, args, extra);
    assert.equal(result.status, rc, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const event = { session_id: session, transcript_path: transcript, cwd: repo, stop_hook_active: false };
  const stop = async (extra = {}, fields = {}) => {
    const result = await run(gate, [], extra, JSON.stringify({ ...event, ...fields }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const write = (mode = 'write', fields = {}) => fs.appendFileSync(path.join(home, 'sessions', `${session}.jsonl`),
    JSON.stringify({ at: new Date().toISOString(), session, repo, base: gitRepo ? 'task-base' : null, out: proof,
      tier: 'complex', mode, ...fields }) + '\n');
  user('Please fix the worker.');
  const captured = await run(capture, [], {}, JSON.stringify({ ...event, source: 'user', prompt: 'Please fix the worker.' }));
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(captured.stdout, '');
  if (writeRun) write();
  const complete = async ({ semantic = true, final = true } = {}) => {
    assert.match(await command(['start']), /requirements playback/);
    await command(['add', 'Fix the worker', '--from', 'M1']);
    await command(['evidence', 'L1', '--artifact', proof]);
    await command(['done', 'L1']);
    if (semantic) await command(['crosscheck']);
    if (final) assistant((await command(['checklist'])).trim());
  };
  return { root, repo, home, transcript, worker, proof, session, env, append, user, assistant, command, stop, write, complete,
    calls: (kind) => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((entry) => entry.kind === kind) : [] };
}

function blocked(output, number, phrase) {
  assert.equal(output?.decision, 'block', JSON.stringify(output));
  assert.match(output.reason, new RegExp(`^${number}\\. `));
  assert.ok(output.reason.includes(phrase), output.reason);
  assert.ok(output.reason.length <= 1500);
  assert.deepEqual(Object.keys(output).sort(), ['decision', 'reason']);
}

test('no code changes means silent success, including read runs and prose-only writes', { timeout }, async (t) => {
  const f = await fixture(t, { writeRun: false });
  assert.equal(await f.stop(), null);
  f.write('read');
  f.write('write', { session: 'another-session' });
  f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'README.md' } }] } });
  assert.equal(await f.stop(), null);
  assert.equal(f.calls('check').length, 0);
  assert.equal(f.calls('overview').length, 0);
});

test('actual code changes without a ledger start block on reason 1, including transcript edits', { timeout }, async (t) => {
  const f = await fixture(t);
  blocked(await f.stop(), 1, 'start the ledger and play back the requirements');
  const transcriptOnly = await fixture(t, { writeRun: false });
  transcriptOnly.env.FAKE_CHANGED = '1';
  for (const name of ['Write', 'Edit', 'MultiEdit']) {
    transcriptOnly.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name,
      input: { file_path: transcriptOnly.worker } }] } });
    blocked(await transcriptOnly.stop(), 1, 'start the ledger');
  }
  assert.equal(f.calls('check').length, 0);
  assert.ok(transcriptOnly.calls('git').some((call) => call.args.includes('--name-only')));
});

test('write runs and tool calls alone are silent; tracked, staged, untracked, and committed changes apply', { timeout }, async (t) => {
  const f = await fixture(t, { changed: false });
  f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write',
    input: { file_path: f.worker } }] } });
  assert.equal(await f.stop(), null);
  for (const extra of [
    { FAKE_CHANGED: '1' }, { FAKE_STAGED: '["worker.mjs"]' }, { FAKE_UNTRACKED: '["worker.mjs"]' },
    { FAKE_HEAD: 'committed-after-base', FAKE_COMMITTED: '["worker.mjs"]' }
  ]) blocked(await f.stop(extra), 1, 'start the ledger');
  // Even a later commit with no remaining working-tree diff still applies.
  blocked(await f.stop({ FAKE_HEAD: 'committed-after-base' }), 1, 'start the ledger');
  assert.equal(await f.stop({ FAKE_HEAD: 'earlier-commit', FAKE_NO_NEW_COMMITS: '1' }), null);
  assert.equal(await f.stop(), null, 'reverted edits and ignored files produce no git changes');
  const second = path.join(f.root, 'second-repo');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'worker.mjs'), 'changed\n');
  f.write('write', { repo: second });
  blocked(await f.stop({ FAKE_CHANGED: '1', FAKE_CHANGED_REPO: second }), 1, 'start the ledger');
});

test('prompt capture records the earliest base and ledger start fills missing repository bases', { timeout }, async (t) => {
  const f = await fixture(t, { writeRun: false });
  const file = path.join(f.home, 'sessions', `${f.session}.base.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'task-base' });
  f.env.FAKE_HEAD = 'later-head';
  await f.command(['start']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'task-base' });
  blocked(await f.stop(), 2, 'M1.c1');
  fs.rmSync(file);
  await f.command(['start']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'later-head' });
  assert.equal(await f.stop(), null);
});

// Each edit form exercises the full ledger sequence and reports its own duration.
for (const [group, edits] of [
  ['tools', ['Write', 'Edit', 'MultiEdit'].map((name) => ({ name, input: { file_path: 'worker.mjs' } }))],
  ['Bash', ["printf code > worker.mjs", "sed -i 's/true/false/' worker.mjs", 'printf code | tee worker.mjs']
    .map((command) => ({ name: 'Bash', input: { command } }))]
]) {
  for (const [index, edit] of edits.entries()) {
    const name = `non-git code edits enforce ledger checks 1–4, 6, and 7 without turn checks (${group} ${index + 1})`;
    test(name, { timeout }, async (t) => {
      const f = await fixture(t, { gitRepo: false });
      f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', ...edit }] } });
      blocked(await f.stop(), 1, 'non-git code edits: ledger checks only, turn checks unavailable');
      await f.command(['start']);
      blocked(await f.stop(), 2, 'M1.c1');
      await f.command(['add', 'Fix the worker', '--from', 'M1']);
      blocked(await f.stop(), 3, 'L1');
      await f.command(['evidence', 'L1', '--note', 'Reviewed']);
      await f.command(['done', 'L1']);
      blocked(await f.stop(), 4, 'evidence required');
      await f.command(['evidence', 'L1', '--artifact', f.proof]);
      blocked(await f.stop(), 6, 'run ledger crosscheck');
      await f.command(['crosscheck']);
      blocked(await f.stop(), 7, 'include the ledger checklist');
      f.assistant((await f.command(['checklist'])).trim());
      assert.equal(await f.stop(), null);
      assert.equal(f.calls('check').length, 0);
    });
  }
}

test('owned running jobs allow a pause until the assistant includes a completion checklist', { timeout }, async (t) => {
  const f = await fixture(t);
  const jobs = ['running', 'queued', 'waiting-provider'].map((state) => ({ owner: f.session, state, out: `/tmp/${state}` }));
  jobs.push({ owner: 'someone-else', state: 'running', out: '/tmp/other' });
  const extra = { FAKE_JOBS: JSON.stringify(jobs) };
  assert.deepEqual(await f.stop(extra), { systemMessage: 'conveyor: work in progress, 3 jobs running' });
  f.assistant('Still working on L1.');
  assert.deepEqual(await f.stop(extra), { systemMessage: 'conveyor: work in progress, 3 jobs running' });
  f.assistant('- [x] Claimed complete');
  blocked(await f.stop(extra), 1, 'start the ledger');
  f.assistant('- L99 ✓ Claimed complete');
  blocked(await f.stop(extra), 1, 'start the ledger');
  assert.equal(f.calls('check').length, 0);
});

for (const kind of ['note', 'file', 'command', 'check']) {
  test('done items need runnable or artifact evidence; notes and successful wrappers without a passing gate do not qualify'
    + ` (${kind})`, { timeout }, async (t) => {
    const f = await fixture(t);
    await f.command(['start']);
    await f.command(['add', 'Fix the worker', '--from', 'M1']);
    if (kind === 'note') await f.command(['evidence', 'L1', '--note', 'Looks correct']);
    if (kind === 'file') await f.command(['evidence', 'L1', '--file', f.proof]);
    if (kind === 'command') await f.command(['evidence', 'L1', '--cmd', 'exit 1', '--rc', '1']);
    if (kind === 'check') {
      fs.writeFileSync(f.proof, '{"code":0,"gate":{"status":"fail"}}');
      await f.command(['evidence', 'L1', '--check', f.proof], {}, 1);
    }
    await f.command(['done', 'L1']);
    blocked(await f.stop(), 4, 'refresh evidence');
    if (kind === 'command') await f.command(['evidence', 'L1', '--cmd', 'exit 1', '--rc', '0'], {}, 1);
    else if (kind === 'check') {
      fs.writeFileSync(f.proof, '{"code":0,"gate":{"status":"pass"}}');
      await f.command(['evidence', 'L1', '--check', f.proof]);
      blocked(await f.stop(), 6, 'run ledger crosscheck');
      fs.writeFileSync(f.proof, 'malformed dispatch JSON');
      blocked(await f.stop(), 4, 'check evidence is red');
    } else {
      await f.command(['evidence', 'L1', '--cmd', 'printf verified']);
      blocked(await f.stop(), 6, 'run ledger crosscheck');
    }
  });
}

for (const code of ['4', '5']) {
  test(`unavailable scout crosschecks keep check 6 blocking (exit ${code})`, { timeout }, async (t) => {
    const f = await fixture(t);
    await f.complete({ semantic: false });
    await f.command(['crosscheck'], { FAKE_CROSSCHECK_RC: code });
    blocked(await f.stop(), 6, 'cross-check unavailable: scout unavailable; run it again or waive');
  });
}

test('unavailable scout crosschecks require a verified snapshot-specific waiver', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete({ semantic: false });
  await f.command(['crosscheck'], { FAKE_CROSSCHECK_RC: '5' });
  const quote = 'You may waive the unavailable cross-check for this task.';
  f.user(quote);
  await f.command(['waive', 'gate', '--quote', quote]);
  await f.command(['crosscheck'], { FAKE_CROSSCHECK_RC: '5' });
  blocked(await f.stop(), 6, 'cross-check unavailable');
  await f.command(['waive', 'crosscheck', '--quote', quote]);
  assert.equal(await f.stop(), null);
  f.env.FAKE_HEAD = 'new-commit';
  blocked(await f.stop(), 6, 'cross-check unavailable');
});

test('unlinked imperative clauses block on reason 2, recomputed from genuine transcript messages', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.command(['start']);
  const file = path.join(f.home, 'ledgers', `${f.session}.jsonl`);
  const message = JSON.parse(await f.command(['show', '--json'])).messages[0];
  fs.appendFileSync(file, JSON.stringify({ ...message, clauses: [] }) + '\n');
  blocked(await f.stop(), 2, 'M1.c1');
  await f.command(['link', 'M1.c1', 'none', '--reason', 'Handled as a question in the agreed scope']);
  f.user('Always preserve fresh evidence.');
  blocked(await f.stop(), 2, 'M2.c1');
  assert.equal(f.calls('check').length, 0);
});

test('stale evidence blocks on reason 4 using current file mtimes instead of recorded claims', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete({ semantic: false });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(f.proof, old, old);
  const file = path.join(f.home, 'ledgers', `${f.session}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'evidence', item: 'L1', kind: 'artifact', value: f.proof,
    mtime: Date.now() + 86400_000, at: new Date().toISOString() }) + '\n');
  blocked(await f.stop(), 4, 'refresh evidence');
  assert.equal(f.calls('check').length, 0);
  const fresh = new Date();
  fs.utimesSync(f.proof, fresh, fresh);
  blocked(await f.stop(), 6, 'run ledger crosscheck');
  const dispatch = path.join(f.root, 'dispatch.json');
  fs.writeFileSync(dispatch, '{"code":0}');
  await f.command(['evidence', 'L1', '--check', dispatch], {}, 1);
  blocked(await f.stop(), 4, 'check evidence is red');
  fs.writeFileSync(dispatch, '{"code":0,"gate":{"status":"pass"}}');
  await f.command(['evidence', 'L1', '--check', dispatch]);
  blocked(await f.stop(), 6, 'run ledger crosscheck');
  const rerun = ['evidence', 'L1', '--cmd', 'test "$CONVEYOR_EVIDENCE_OK" = yes'];
  await f.command(rerun, { CONVEYOR_EVIDENCE_OK: 'no' }, 1);
  blocked(await f.stop(), 4, 'command failed');
  await f.command(rerun, { CONVEYOR_EVIDENCE_OK: 'yes' });
  blocked(await f.stop(), 6, 'run ledger crosscheck');
});

test('red turn checks block on reason 5 with the session repository and base', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete({ semantic: false });
  blocked(await f.stop({ FAKE_CHECK_OK: '0', FAKE_CHECK_RC: '1' }), 5, 'fix red turn checks');
  assert.deepEqual(f.calls('check')[0].args, ['run', '--dir', f.repo, '--level', 'turn', '--base', 'task-base', '--json']);
  blocked(await f.stop({ FAKE_CHECK_OK: '1', FAKE_CHECK_RC: '2' }), 5, 'fix red turn checks');
  assert.equal(f.calls('overview').length, 0);
});

test('a missing checklist in the last assistant message blocks on reason 7', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete({ final: false });
  f.assistant('All done.');
  blocked(await f.stop(), 7, 'include the ledger checklist');
  f.assistant('L10 was finished earlier.');
  blocked(await f.stop(), 7, 'L1');
  for (const mention of ['L1 was finished.', '- L1 done', '- L1 ✓suffix', 'Earlier: - L1 ✓ finished']) {
    f.assistant(mention);
    blocked(await f.stop(), 7, 'L1');
  }
  f.assistant((await f.command(['checklist'])).trim());
  assert.equal(await f.stop(), null);
});

test('running owned jobs, registered temporary paths, and expired owned worktrees block cleanup on reason 8', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete();
  const other = { owner: 'another-session', state: 'running', out: '/tmp/other' };
  const own = { owner: f.session, state: 'running', out: '/tmp/owned' };
  blocked(await f.stop({ FAKE_JOBS: JSON.stringify([other, own]) }), 8, 'finish executor jobs: /tmp/owned');
  assert.equal(await f.stop({ FAKE_JOBS: JSON.stringify([other]) }), null);
  const scratch = path.join(f.root, 'scratch');
  fs.mkdirSync(scratch);
  await f.command(['tmp', 'register', scratch]);
  blocked(await f.stop(), 8, 'remove registered temporary paths');
  fs.rmSync(scratch, { recursive: true });
  const expired = `worktree ${f.repo}-old\nHEAD abc\nlocked owner=${f.session} until=2000-01-01\n\n`;
  blocked(await f.stop({ FAKE_WORKTREES: expired }), 8, 'clean up expired worktree');
  const future = `worktree ${f.repo}-new\nHEAD abc\nlocked owner=${f.session} until=2999-01-01\n\n`;
  assert.equal(await f.stop({ FAKE_WORKTREES: future }), null);
});

test('verified gate waivers cover only checks 5 and 8, and verified item waivers count as done', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.complete();
  const quote = 'You may skip turn checks and cleanup for this task.';
  await f.command(['waive', 'gate', '--quote', quote], {}, 1);
  const red = { FAKE_CHECK_OK: '0', FAKE_CHECK_RC: '1', FAKE_JOBS: JSON.stringify([
    { owner: f.session, state: 'running', out: '/tmp/owned' }
  ]) };
  blocked(await f.stop(red), 5, 'fix red turn checks');
  f.user(quote);
  await f.command(['waive', 'gate', '--quote', quote]);
  await f.command(['crosscheck']);
  const checks = f.calls('check').length, overviews = f.calls('overview').length;
  const scratch = path.join(f.root, 'scratch.txt');
  fs.writeFileSync(scratch, 'registered');
  await f.command(['tmp', 'register', scratch]);
  assert.equal(await f.stop(red), null);
  assert.equal(f.calls('check').length, checks);
  assert.equal(f.calls('overview').length, overviews);
  await f.command(['add', 'Explicit extra item', '--from', 'M1']);
  blocked(await f.stop(red), 3, 'open items: L2');
  await f.command(['waive', 'L2', '--quote', quote]);
  blocked(await f.stop(red), 6, 'run ledger crosscheck');
  await f.command(['crosscheck']);
  blocked(await f.stop(red), 7, 'L2');
  f.assistant((await f.command(['checklist'])).trim());
  assert.equal(await f.stop(red), null);
});

test('the stop loop guard allows after the same reason was given for three stops and logs the allowance', { timeout }, async (t) => {
  const f = await fixture(t);
  blocked(await f.stop(), 1, 'start the ledger');
  blocked(await f.stop({}, { stop_hook_active: true }), 1, 'start the ledger');
  blocked(await f.stop({}, { stop_hook_active: true }), 1, 'start the ledger');
  const allowed = await f.stop({}, { stop_hook_active: true });
  assert.deepEqual(Object.keys(allowed), ['systemMessage']);
  assert.match(allowed.systemMessage, /^conveyor gate: .*\(allowed after 3 repeats\)$/);
  const log = fs.readFileSync(path.join(f.root, 'claude/logs/conveyor-gate.log'), 'utf8');
  assert.match(log, /allowed after 3 repeats/);
});

test('warn mode prints only systemMessage, defaults to calibration, and yields to explicit mode overrides', { timeout }, async (t) => {
  const f = await fixture(t);
  const warning = await f.stop({ CONVEYOR_GATE_MODE: 'warn' });
  assert.deepEqual(Object.keys(warning), ['systemMessage']);
  assert.match(warning.systemMessage, /start the ledger/);
  const calibration = await f.stop({ CONVEYOR_GATE_MODE: '' });
  assert.deepEqual(Object.keys(calibration), ['systemMessage']);
  const config = path.join(f.home, 'gate.json');
  const start = path.join(f.home, 'gate-calibration-start');
  const recorded = Date.parse(fs.readFileSync(start, 'utf8').trim());
  const created = fs.statSync(start).mtimeMs;
  assert.ok(Math.abs(created - recorded) < 10_000);
  fs.writeFileSync(config, '{"mode":"block"}');
  assert.deepEqual(Object.keys(await f.stop({ CONVEYOR_GATE_MODE: '' })), ['systemMessage']);
  const old = new Date(Date.now() - 8 * 86400_000);
  fs.writeFileSync(start, old.toISOString());
  fs.utimesSync(start, old, old);
  fs.writeFileSync(config, '{"mode":"warn"}');
  blocked(await f.stop({ CONVEYOR_GATE_MODE: '' }), 1, 'start the ledger');
  fs.writeFileSync(start, new Date(Date.now() + 86400_000).toISOString());
  fs.utimesSync(start, old, old);
  blocked(await f.stop({ CONVEYOR_GATE_MODE: '' }), 1, 'start the ledger');
  assert.deepEqual(Object.keys(await f.stop({ CONVEYOR_GATE_MODE: 'warn' })), ['systemMessage']);
  assert.equal(await f.stop({}, { transcript_path: path.join(f.root, 'missing.jsonl') }), null);
  assert.match(fs.readFileSync(path.join(f.root, 'claude/logs/conveyor-gate.log'), 'utf8'), /stop gate:.*ENOENT/);
});
