import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const gate = fileURLToPath(new URL('../conveyor-stop-gate.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../conveyor-prompt-capture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/conveyor/ledger.mjs', import.meta.url));
const timeout = 600_000;

function fixture(t, { writeRun = true, changed = writeRun, gitRepo = true } = {}) {
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
  const fake = path.join(root, 'fake.mjs');
  fs.writeFileSync(fake, [
    "import fs from 'node:fs';",
    'const [kind, ...args] = process.argv.slice(2);',
    "fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({kind, args}) + '\\n');",
    "if (kind === 'check') {",
    "  process.stdout.write(JSON.stringify({ok: process.env.FAKE_CHECK_OK === '1', results: [], hygiene: {}}));",
    '  process.exit(Number(process.env.FAKE_CHECK_RC));',
    "} else if (kind === 'overview') process.stdout.write(JSON.stringify({jobs: JSON.parse(process.env.FAKE_JOBS)}));",
    "else if (kind === 'crosscheck') {",
    '  if (process.env.FAKE_CROSSCHECK_RC) {',
    "    process.stderr.write('scout unavailable'); process.exit(Number(process.env.FAKE_CROSSCHECK_RC));",
    '  }',
    "  fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_RESPONSE);",
    '}'
  ].join('\n'));
  env.CONVEYOR_CHECK_CMD = JSON.stringify([process.execPath, fake, 'check']);
  env.CONVEYOR_OVERVIEW_CMD = JSON.stringify([process.execPath, fake, 'overview']);
  env.CONVEYOR_CROSSCHECK_CMD = JSON.stringify([process.execPath, fake, 'crosscheck']);
  fs.writeFileSync(path.join(bin, 'git'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    'const args = process.argv.slice(4);',
    "fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({kind: 'git', args}) + '\\n');",
    "if (process.env.FAKE_NONGIT === '1') process.exit(128);",
    "const changed = process.env.FAKE_CHANGED === '1'",
    '  && (!process.env.FAKE_CHANGED_REPO || process.env.FAKE_CHANGED_REPO === process.argv[3]);',
    "if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') process.stdout.write(process.argv[3]);",
    "else if (args[0] === 'rev-parse' && args[1] === 'HEAD') process.stdout.write(process.env.FAKE_HEAD);",
    "else if (args[0] === 'rev-parse') process.stdout.write('');",
    "else if (args[0] === 'ls-files') process.stdout.write(JSON.parse(process.env.FAKE_UNTRACKED || '[]').join('\\0'));",
    "else if (args[0] === 'log' && args.includes('--format=%H')) {",
    "  process.stdout.write(process.env.FAKE_NO_NEW_COMMITS === '1' ? '' : process.env.FAKE_HEAD);",
    '}',
    "else if (args[0] === 'log') process.stdout.write(JSON.parse(process.env.FAKE_COMMITTED || '[]').join('\\0'));",
    "else if (args.includes('--name-only')) {",
    "  const files = args.includes('--cached') ? JSON.parse(process.env.FAKE_STAGED || '[]') : changed ? ['worker.mjs'] : [];",
    "  process.stdout.write(files.length ? files.join('\\0') + '\\0' : '');",
    '}',
    "else if (args.includes('--stat')) process.stdout.write(' worker.mjs | 1 +\\n');",
    "else if (args.includes('diff')) process.stdout.write('+export const result = true;\\n');",
    "else if (args.includes('worktree')) process.stdout.write(process.env.FAKE_WORKTREES);"
  ].join('\n'), { mode: 0o755 });
  let sequence = 0;
  const append = (entry) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: session, ...entry }) + '\n');
  const user = (text) => append({ type: 'user', uuid: `u${++sequence}`, origin: { kind: 'human' }, message: { content: text } });
  const assistant = (text) => append({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const run = (program, args, extra = {}, input) => {
    const result = spawnSync(process.execPath, [program, ...args], {
      env: { ...env, ...extra }, cwd: repo, encoding: 'utf8', input, timeout
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const command = (args, extra = {}, rc = 0) => {
    const result = run(cli, args, extra);
    assert.equal(result.status, rc, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const event = { session_id: session, transcript_path: transcript, cwd: repo, stop_hook_active: false };
  const stop = (extra = {}, fields = {}) => {
    const result = run(gate, [], extra, JSON.stringify({ ...event, ...fields }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const write = (mode = 'write', fields = {}) => fs.appendFileSync(path.join(home, 'sessions', `${session}.jsonl`),
    JSON.stringify({ at: new Date().toISOString(), session, repo, base: gitRepo ? 'task-base' : null, out: proof,
      tier: 'complex', mode, ...fields }) + '\n');
  user('Please fix the worker.');
  const captured = run(capture, [], {}, JSON.stringify({ ...event, source: 'user', prompt: 'Please fix the worker.' }));
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(captured.stdout, '');
  if (writeRun) write();
  const complete = ({ semantic = true, final = true } = {}) => {
    assert.match(command(['start']), /requirements playback/);
    command(['add', 'Fix the worker', '--from', 'M1']);
    command(['evidence', 'L1', '--artifact', proof]);
    command(['done', 'L1']);
    if (semantic) command(['crosscheck']);
    if (final) assistant(command(['checklist']).trim());
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

test('no code changes means silent success, including read runs and prose-only writes', { timeout }, (t) => {
  const f = fixture(t, { writeRun: false });
  assert.equal(f.stop(), null);
  f.write('read');
  f.write('write', { session: 'another-session' });
  f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'README.md' } }] } });
  assert.equal(f.stop(), null);
  assert.equal(f.calls('check').length, 0);
  assert.equal(f.calls('overview').length, 0);
});

test('actual code changes without a ledger start block on reason 1, including transcript edits', { timeout }, (t) => {
  const f = fixture(t);
  blocked(f.stop(), 1, 'start the ledger and play back the requirements');
  const transcriptOnly = fixture(t, { writeRun: false });
  transcriptOnly.env.FAKE_CHANGED = '1';
  for (const name of ['Write', 'Edit', 'MultiEdit']) {
    transcriptOnly.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name,
      input: { file_path: transcriptOnly.worker } }] } });
    blocked(transcriptOnly.stop(), 1, 'start the ledger');
  }
  assert.equal(f.calls('check').length, 0);
  assert.ok(transcriptOnly.calls('git').some((call) => call.args.includes('--name-only')));
});

test('write runs and tool calls alone are silent; tracked, staged, untracked, and committed changes apply', { timeout }, (t) => {
  const f = fixture(t, { changed: false });
  f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write',
    input: { file_path: f.worker } }] } });
  assert.equal(f.stop(), null);
  for (const extra of [
    { FAKE_CHANGED: '1' }, { FAKE_STAGED: '["worker.mjs"]' }, { FAKE_UNTRACKED: '["worker.mjs"]' },
    { FAKE_HEAD: 'committed-after-base', FAKE_COMMITTED: '["worker.mjs"]' }
  ]) blocked(f.stop(extra), 1, 'start the ledger');
  // Even a later commit with no remaining working-tree diff still applies.
  blocked(f.stop({ FAKE_HEAD: 'committed-after-base' }), 1, 'start the ledger');
  assert.equal(f.stop({ FAKE_HEAD: 'earlier-commit', FAKE_NO_NEW_COMMITS: '1' }), null);
  assert.equal(f.stop(), null, 'reverted edits and ignored files produce no git changes');
  const second = path.join(f.root, 'second-repo');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'worker.mjs'), 'changed\n');
  f.write('write', { repo: second });
  blocked(f.stop({ FAKE_CHANGED: '1', FAKE_CHANGED_REPO: second }), 1, 'start the ledger');
});

test('prompt capture records the earliest base and ledger start fills missing repository bases', { timeout }, (t) => {
  const f = fixture(t, { writeRun: false });
  const file = path.join(f.home, 'sessions', `${f.session}.base.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'task-base' });
  f.env.FAKE_HEAD = 'later-head';
  f.command(['start']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'task-base' });
  blocked(f.stop(), 2, 'M1.c1');
  fs.rmSync(file);
  f.command(['start']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [f.repo]: 'later-head' });
  assert.equal(f.stop(), null);
});

test('non-git code edits enforce ledger checks 1–4, 6, and 7, including Bash edits, without turn checks', { timeout }, (t) => {
  const edits = [
    ...['Write', 'Edit', 'MultiEdit'].map((name) => ({ name, input: { file_path: 'worker.mjs' } })),
    ...["printf code > worker.mjs", "sed -i 's/true/false/' worker.mjs", 'printf code | tee worker.mjs']
      .map((command) => ({ name: 'Bash', input: { command } }))
  ];
  for (const edit of edits) {
    const f = fixture(t, { gitRepo: false });
    f.append({ type: 'assistant', message: { content: [{ type: 'tool_use', ...edit }] } });
    blocked(f.stop(), 1, 'non-git code edits: ledger checks only, turn checks unavailable');
    f.command(['start']);
    blocked(f.stop(), 2, 'M1.c1');
    f.command(['add', 'Fix the worker', '--from', 'M1']);
    blocked(f.stop(), 3, 'L1');
    f.command(['evidence', 'L1', '--note', 'Reviewed']);
    f.command(['done', 'L1']);
    blocked(f.stop(), 4, 'evidence required');
    f.command(['evidence', 'L1', '--artifact', f.proof]);
    blocked(f.stop(), 6, 'run ledger crosscheck');
    f.command(['crosscheck']);
    blocked(f.stop(), 7, 'include the ledger checklist');
    f.assistant(f.command(['checklist']).trim());
    assert.equal(f.stop(), null);
    assert.equal(f.calls('check').length, 0);
  }
});

test('owned running jobs allow a pause until the assistant includes a completion checklist', { timeout }, (t) => {
  const f = fixture(t);
  const jobs = ['running', 'queued', 'waiting-provider'].map((state) => ({ owner: f.session, state, out: `/tmp/${state}` }));
  jobs.push({ owner: 'someone-else', state: 'running', out: '/tmp/other' });
  const extra = { FAKE_JOBS: JSON.stringify(jobs) };
  assert.deepEqual(f.stop(extra), { systemMessage: 'conveyor: work in progress, 3 jobs running' });
  f.assistant('Still working on L1.');
  assert.deepEqual(f.stop(extra), { systemMessage: 'conveyor: work in progress, 3 jobs running' });
  f.assistant('- [x] Claimed complete');
  blocked(f.stop(extra), 1, 'start the ledger');
  f.assistant('- L99 ✓ Claimed complete');
  blocked(f.stop(extra), 1, 'start the ledger');
  assert.equal(f.calls('check').length, 0);
});

test('done items need runnable or artifact evidence; notes and successful wrappers without a passing gate do not qualify',
  { timeout }, (t) => {
    for (const kind of ['note', 'file', 'command', 'check']) {
      const f = fixture(t);
      f.command(['start']);
      f.command(['add', 'Fix the worker', '--from', 'M1']);
      if (kind === 'note') f.command(['evidence', 'L1', '--note', 'Looks correct']);
      if (kind === 'file') f.command(['evidence', 'L1', '--file', f.proof]);
      if (kind === 'command') f.command(['evidence', 'L1', '--cmd', 'exit 1', '--rc', '1']);
      if (kind === 'check') {
        fs.writeFileSync(f.proof, '{"code":0,"gate":{"status":"fail"}}');
        f.command(['evidence', 'L1', '--check', f.proof], {}, 1);
      }
      f.command(['done', 'L1']);
      blocked(f.stop(), 4, 'refresh evidence');
      if (kind === 'command') f.command(['evidence', 'L1', '--cmd', 'exit 1', '--rc', '0'], {}, 1);
      else if (kind === 'check') {
        fs.writeFileSync(f.proof, '{"code":0,"gate":{"status":"pass"}}');
        f.command(['evidence', 'L1', '--check', f.proof]);
        blocked(f.stop(), 6, 'run ledger crosscheck');
        fs.writeFileSync(f.proof, 'malformed dispatch JSON');
        blocked(f.stop(), 4, 'check evidence is red');
      } else {
        f.command(['evidence', 'L1', '--cmd', 'printf verified']);
        blocked(f.stop(), 6, 'run ledger crosscheck');
      }
    }
  });

test('unavailable scout crosschecks keep check 6 blocking with a retry or user-waiver reason', { timeout }, (t) => {
  const f = fixture(t);
  f.complete({ semantic: false });
  for (const code of ['4', '5']) {
    f.command(['crosscheck'], { FAKE_CROSSCHECK_RC: code });
    blocked(f.stop(), 6, 'cross-check unavailable: scout unavailable; run it again or waive');
  }
  const quote = 'You may waive the unavailable cross-check for this task.';
  f.user(quote);
  f.command(['waive', 'gate', '--quote', quote]);
  f.command(['crosscheck'], { FAKE_CROSSCHECK_RC: '5' });
  blocked(f.stop(), 6, 'cross-check unavailable');
  f.command(['waive', 'crosscheck', '--quote', quote]);
  assert.equal(f.stop(), null);
  f.env.FAKE_HEAD = 'new-commit';
  blocked(f.stop(), 6, 'cross-check unavailable');
});

test('unlinked imperative clauses block on reason 2, recomputed from genuine transcript messages', { timeout }, (t) => {
  const f = fixture(t);
  f.command(['start']);
  const file = path.join(f.home, 'ledgers', `${f.session}.jsonl`);
  const message = JSON.parse(f.command(['show', '--json'])).messages[0];
  fs.appendFileSync(file, JSON.stringify({ ...message, clauses: [] }) + '\n');
  blocked(f.stop(), 2, 'M1.c1');
  f.command(['link', 'M1.c1', 'none', '--reason', 'Handled as a question in the agreed scope']);
  f.user('Always preserve fresh evidence.');
  blocked(f.stop(), 2, 'M2.c1');
  assert.equal(f.calls('check').length, 0);
});

test('stale evidence blocks on reason 4 using current file mtimes instead of recorded claims', { timeout }, (t) => {
  const f = fixture(t);
  f.complete({ semantic: false });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(f.proof, old, old);
  const file = path.join(f.home, 'ledgers', `${f.session}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'evidence', item: 'L1', kind: 'artifact', value: f.proof,
    mtime: Date.now() + 86400_000, at: new Date().toISOString() }) + '\n');
  blocked(f.stop(), 4, 'refresh evidence');
  assert.equal(f.calls('check').length, 0);
  const fresh = new Date();
  fs.utimesSync(f.proof, fresh, fresh);
  blocked(f.stop(), 6, 'run ledger crosscheck');
  const dispatch = path.join(f.root, 'dispatch.json');
  fs.writeFileSync(dispatch, '{"code":0}');
  f.command(['evidence', 'L1', '--check', dispatch], {}, 1);
  blocked(f.stop(), 4, 'check evidence is red');
  fs.writeFileSync(dispatch, '{"code":0,"gate":{"status":"pass"}}');
  f.command(['evidence', 'L1', '--check', dispatch]);
  blocked(f.stop(), 6, 'run ledger crosscheck');
  const rerun = ['evidence', 'L1', '--cmd', 'test "$CONVEYOR_EVIDENCE_OK" = yes'];
  f.command(rerun, { CONVEYOR_EVIDENCE_OK: 'no' }, 1);
  blocked(f.stop(), 4, 'command failed');
  f.command(rerun, { CONVEYOR_EVIDENCE_OK: 'yes' });
  blocked(f.stop(), 6, 'run ledger crosscheck');
});

test('red turn checks block on reason 5 with the session repository and base', { timeout }, (t) => {
  const f = fixture(t);
  f.complete({ semantic: false });
  blocked(f.stop({ FAKE_CHECK_OK: '0', FAKE_CHECK_RC: '1' }), 5, 'fix red turn checks');
  assert.deepEqual(f.calls('check')[0].args, ['run', '--dir', f.repo, '--level', 'turn', '--base', 'task-base', '--json']);
  blocked(f.stop({ FAKE_CHECK_OK: '1', FAKE_CHECK_RC: '2' }), 5, 'fix red turn checks');
  assert.equal(f.calls('overview').length, 0);
});

test('a missing checklist in the last assistant message blocks on reason 7', { timeout }, (t) => {
  const f = fixture(t);
  f.complete({ final: false });
  f.assistant('All done.');
  blocked(f.stop(), 7, 'include the ledger checklist');
  f.assistant('L10 was finished earlier.');
  blocked(f.stop(), 7, 'L1');
  for (const mention of ['L1 was finished.', '- L1 done', '- L1 ✓suffix', 'Earlier: - L1 ✓ finished']) {
    f.assistant(mention);
    blocked(f.stop(), 7, 'L1');
  }
  f.assistant(f.command(['checklist']).trim());
  assert.equal(f.stop(), null);
});

test('running owned jobs, registered temporary paths, and expired owned worktrees block cleanup on reason 8', { timeout }, (t) => {
  const f = fixture(t);
  f.complete();
  const other = { owner: 'another-session', state: 'running', out: '/tmp/other' };
  const own = { owner: f.session, state: 'running', out: '/tmp/owned' };
  blocked(f.stop({ FAKE_JOBS: JSON.stringify([other, own]) }), 8, 'finish executor jobs: /tmp/owned');
  assert.equal(f.stop({ FAKE_JOBS: JSON.stringify([other]) }), null);
  const scratch = path.join(f.root, 'scratch');
  fs.mkdirSync(scratch);
  f.command(['tmp', 'register', scratch]);
  blocked(f.stop(), 8, 'remove registered temporary paths');
  fs.rmSync(scratch, { recursive: true });
  const expired = `worktree ${f.repo}-old\nHEAD abc\nlocked owner=${f.session} until=2000-01-01\n\n`;
  blocked(f.stop({ FAKE_WORKTREES: expired }), 8, 'clean up expired worktree');
  const future = `worktree ${f.repo}-new\nHEAD abc\nlocked owner=${f.session} until=2999-01-01\n\n`;
  assert.equal(f.stop({ FAKE_WORKTREES: future }), null);
});

test('verified gate waivers cover only checks 5 and 8, and verified item waivers count as done', { timeout }, (t) => {
  const f = fixture(t);
  f.complete();
  const quote = 'You may skip turn checks and cleanup for this task.';
  f.command(['waive', 'gate', '--quote', quote], {}, 1);
  const red = { FAKE_CHECK_OK: '0', FAKE_CHECK_RC: '1', FAKE_JOBS: JSON.stringify([
    { owner: f.session, state: 'running', out: '/tmp/owned' }
  ]) };
  blocked(f.stop(red), 5, 'fix red turn checks');
  f.user(quote);
  f.command(['waive', 'gate', '--quote', quote]);
  f.command(['crosscheck']);
  const checks = f.calls('check').length, overviews = f.calls('overview').length;
  const scratch = path.join(f.root, 'scratch.txt');
  fs.writeFileSync(scratch, 'registered');
  f.command(['tmp', 'register', scratch]);
  assert.equal(f.stop(red), null);
  assert.equal(f.calls('check').length, checks);
  assert.equal(f.calls('overview').length, overviews);
  f.command(['add', 'Explicit extra item', '--from', 'M1']);
  blocked(f.stop(red), 3, 'open items: L2');
  f.command(['waive', 'L2', '--quote', quote]);
  blocked(f.stop(red), 6, 'run ledger crosscheck');
  f.command(['crosscheck']);
  blocked(f.stop(red), 7, 'L2');
  f.assistant(f.command(['checklist']).trim());
  assert.equal(f.stop(red), null);
});

test('the stop loop guard allows after the same reason was given for three stops and logs the allowance', { timeout }, (t) => {
  const f = fixture(t);
  blocked(f.stop(), 1, 'start the ledger');
  blocked(f.stop({}, { stop_hook_active: true }), 1, 'start the ledger');
  blocked(f.stop({}, { stop_hook_active: true }), 1, 'start the ledger');
  const allowed = f.stop({}, { stop_hook_active: true });
  assert.deepEqual(Object.keys(allowed), ['systemMessage']);
  assert.match(allowed.systemMessage, /^conveyor gate: .*\(allowed after 3 repeats\)$/);
  const log = fs.readFileSync(path.join(f.root, 'claude/logs/conveyor-gate.log'), 'utf8');
  assert.match(log, /allowed after 3 repeats/);
});

test('warn mode prints only systemMessage, defaults to calibration, and yields to explicit mode overrides', { timeout }, (t) => {
  const f = fixture(t);
  const warning = f.stop({ CONVEYOR_GATE_MODE: 'warn' });
  assert.deepEqual(Object.keys(warning), ['systemMessage']);
  assert.match(warning.systemMessage, /start the ledger/);
  const calibration = f.stop({ CONVEYOR_GATE_MODE: '' });
  assert.deepEqual(Object.keys(calibration), ['systemMessage']);
  const config = path.join(f.home, 'gate.json');
  const start = path.join(f.home, 'gate-calibration-start');
  const recorded = Date.parse(fs.readFileSync(start, 'utf8').trim());
  const created = fs.statSync(start).mtimeMs;
  assert.ok(Math.abs(created - recorded) < 10_000);
  fs.writeFileSync(config, '{"mode":"block"}');
  assert.deepEqual(Object.keys(f.stop({ CONVEYOR_GATE_MODE: '' })), ['systemMessage']);
  const old = new Date(Date.now() - 8 * 86400_000);
  fs.writeFileSync(start, old.toISOString());
  fs.utimesSync(start, old, old);
  fs.writeFileSync(config, '{"mode":"warn"}');
  blocked(f.stop({ CONVEYOR_GATE_MODE: '' }), 1, 'start the ledger');
  fs.writeFileSync(start, new Date(Date.now() + 86400_000).toISOString());
  fs.utimesSync(start, old, old);
  blocked(f.stop({ CONVEYOR_GATE_MODE: '' }), 1, 'start the ledger');
  assert.deepEqual(Object.keys(f.stop({ CONVEYOR_GATE_MODE: 'warn' })), ['systemMessage']);
  assert.equal(f.stop({}, { transcript_path: path.join(f.root, 'missing.jsonl') }), null);
  assert.match(fs.readFileSync(path.join(f.root, 'claude/logs/conveyor-gate.log'), 'utf8'), /stop gate:.*ENOENT/);
});
