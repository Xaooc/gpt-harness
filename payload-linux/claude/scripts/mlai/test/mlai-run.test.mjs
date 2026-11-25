import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../mlai.sh');
const fake = path.join(here, 'fake-mlai.mjs');

async function fixture({ scenario, worktree = false, write = true, env: extra = {} }, verify) {
  const root = mkdtempSync(path.join(tmpdir(), 'mlai-test-'));
  const dir = path.join(root, 'project with spaces');
  const out = path.join(root, 'result.md');
  const brief = path.join(root, 'brief.md');
  const home = path.join(root, 'home');
  const mlaiHome = path.join(root, 'auth');
  const run = path.join(root, 'run');
  const slot = path.join(run, 'mlai/slots/0');
  const state = path.join(root, 'fake');
  try {
    for (const directory of [dir, home, mlaiHome, slot, state]) mkdirSync(directory, { recursive: true });
    if (worktree) {
      // A worktree keeps its git directory in the main repo, outside the job folder.
      const main = path.join(root, 'main');
      const git = (...args) => execFileSync('git', args, { env: { ...process.env, HOME: home }, timeout: 300_000 });
      git('init', '--quiet', main);
      git('-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'base');
      rmSync(dir, { recursive: true, force: true });
      git('-C', main, 'worktree', 'add', '--quiet', '--detach', dir);
    } else execFileSync('git', ['init', '--quiet', dir], { env: { ...process.env, HOME: home }, timeout: 300_000 });
    mkdirSync(path.join(root, 'shared'), { recursive: true });
    mkdirSync(path.join(root, 'projects'), { recursive: true });
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(path.join(home, '.claude', 'scripts'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'scripts', 'pytest_gate.py'), 'import glob, os, sys\n' +
      "bridge = os.environ.get('PYTEST_GATE_BRIDGE', '')\n" +
      "granted = 'granted' if glob.glob(os.path.join(bridge, 'grant-*')) else 'ungranted'\n" +
      "open(os.path.join(os.environ['FAKE_MLAI_STATE_DIR'], 'inner.txt'), 'w').write(granted + ' ' + ' '.join(sys.argv[1:]))\n");
    writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    writeFileSync(path.join(root, 'projects', 'ADMIN_ACCESS.txt'), 'x\n');
    writeFileSync(path.join(root, 'shared', 'notes.txt'), 'context\n');
    writeFileSync(brief, `Update greeting.txt and summarize the changes. Context: ${path.join(root, 'shared', 'notes.txt')}.\n`);
    writeFileSync(path.join(mlaiHome, 'auth.json'), JSON.stringify({
      expires: Date.now() + 86_400_000
    }));
    const child = spawn('bash', [entry, write ? '-w' : '-r', '-C', dir, '-f', brief, '-o', out], {
      env: {
        ...process.env, HOME: home, MLAI_HOME: mlaiHome, MLAI_BIN: fake, MLAI_SLOT: slot,
        LUNA_RUN_DIR: run, LUNA_NO_REGISTRY: '1', MLAI_RETRIES: '2', MLAI_RETRY_DELAY_MS: '10',
        LUNA_IDLE_MAX_S: '30', LUNA_TIMEOUT_S: '30', MLAI_READ_ROOTS: worktree ? root : path.join(root, 'projects'), FAKE_MLAI_SCENARIO: scenario, FAKE_MLAI_STATE_DIR: state, ...extra
      },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const rc = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const status = Object.fromEntries(readFileSync(`${out}.status`, 'utf8').trimEnd().split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    verify({ rc, stdout, stderr, status, output: readFileSync(out, 'utf8'), slot, state, mlaiHome, root, dir, home });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a started write attempt retries after a connection interruption', { timeout: 300_000 }, async () => {
  await fixture({ scenario: 'retry' }, ({ rc, stdout, stderr, status, output, slot, state }) => {
    assert.equal(rc, 0, stderr);
    assert.equal(status.state, 'done');
    assert.equal(status.attempts, '2');
    assert.equal(status.reached_running, '1');
    assert.equal(status.mlai_session, 'fake-session-2');
    const args = JSON.parse(readFileSync(path.join(state, 'args-1.json'), 'utf8'));
    assert.ok(args.some((arg, i) => args[i - 1] === '--add-dir' && arg.endsWith('/shared')), 'brief path is readable');
    assert.ok(args.some((arg, i) => args[i - 1] === '--add-dir' && arg.endsWith('/projects')), 'project root is readable');
    assert.ok(args.some((arg, i) => args[i - 1] === '--disallowedTools' && arg.endsWith('/projects/ADMIN_ACCESS.txt)')),
      'secret-looking files at the top of a project tree are denied');
    assert.equal(readFileSync(path.join(state, 'checkpoints-1.txt'), 'utf8'), 'unset', 'checkpoints stay on in a plain repo');
    assert.equal(status.credits, '0.375');
    assert.equal(status.changed_files, '1');
    assert.equal(output, '## Changes\nUpdated greeting.txt.\n\n## Verification\nChecks passed.\n\n' +
      '## Deviations\nNone\n\n## Not done\nNone\n');
    assert.equal(stdout, output);
    const recovery = /A previous attempt of this exact task was interrupted by a network error/;
    assert.doesNotMatch(readFileSync(path.join(state, 'prompt-1.md'), 'utf8'), recovery);
    assert.match(readFileSync(path.join(state, 'prompt-2.md'), 'utf8'), recovery);
    const child = JSON.parse(readFileSync(path.join(slot, 'child.json'), 'utf8'));
    assert.equal(child.pid, Number(status.pid));
    assert.equal(child.pgid, child.pid);
    assert.match(child.pid_start, /^\d+$/);
    assert.equal(child.pid_start, status.pid_start);
  });
});

test('a sign-in or daily-limit failure before the agent starts is unavailable', { timeout: 300_000 }, async () => {
  await fixture({ scenario: 'auth' }, ({ rc, stderr, status }) => {
    assert.equal(rc, 3, stderr);
    assert.equal(status.state, 'unavailable');
    assert.equal(status.unavailable_reason, 'auth');
    assert.notEqual(status.reached_running, '1');
  });
  // The CLI's own failed final checks are not the owner's decision: a read-only report stands, marked unconfirmed, and
  // its engine ran without final gates and baseline tests; unfinished write work is left for the next executor.
  await fixture({ scenario: 'checks', write: false }, ({ rc, stderr, status, output, state }) => {
    assert.equal(rc, 0, stderr);
    assert.equal(status.state, 'done');
    assert.equal(status.cli_subtype, 'error_checks_failed');
    assert.match(output, /^The flow is in rpg_master\/x\.py:3[\s\S]*final checks did not confirm/, 'engine banner dropped');
    const env = JSON.parse(readFileSync(path.join(state, 'env-1.json'), 'utf8'));
    assert.deepEqual([env.MINI_MLAI_FINAL_GATES, env.MINI_VERIFY_BASELINE, env.MINI_CHECKER], ['0', '0', '0']);
  });
  await fixture({ scenario: 'checks' }, ({ rc, stderr, status, state }) => {
    assert.equal(rc, 1, stderr);
    assert.equal(status.state, 'incomplete');
    assert.match(status.error, /final checks did not pass/);
    const env = JSON.parse(readFileSync(path.join(state, 'env-1.json'), 'utf8'));
    assert.deepEqual([env.MINI_MLAI_FINAL_GATES, env.MINI_VERIFY_BASELINE], [null, '0']);
    // The agent's `pytest` is the gate shim, first on PATH.
    assert.match(env.PATH, /\/scripts\/mlai\/bin:/);
  });
  // A write report that lost headings keeps the CLI's own texts next to the output for diagnosis.
  await fixture({ scenario: 'headings' }, ({ rc, stderr, status, state }) => {
    assert.equal(rc, 0, stderr);
    assert.equal(status.state, 'incomplete');
    const out = JSON.parse(readFileSync(path.join(state, '..', 'result.md.headings.json'), 'utf8'));
    assert.deepEqual(out.missing, ['## Deviations', '## Not done']);
    assert.match(out.answer, /## Deviations\nNone/);
  });
  // The agent's plain `pytest` waits for the host's machine-wide gate (here a fake that runs its launcher, the holder),
  // then runs the gate inside the sandbox with a basetemp that carries the request id; the bridge folder is removed.
  const fakes = mkdtempSync(path.join(tmpdir(), 'mlai-gate-'));
  try {
    const host = path.join(fakes, 'host-gate.py');
    writeFileSync(host, 'import json, os, subprocess, sys\n' +
      "open(os.path.join(os.environ['FAKE_MLAI_STATE_DIR'], 'host.txt'), 'w').write(' '.join(sys.argv[1:]))\n" +
      "sys.exit(subprocess.call(json.loads(os.environ['PYTEST_GATE_LAUNCHER']) + ['-n', '0', '--basetemp=x']))\n");
    await fixture({ scenario: 'gate', env: { MLAI_PYTEST_GATE: host, FAKE_INNER_GATE: '1' } }, ({ rc, stderr, state }) => {
      assert.equal(rc, 0, stderr);
      assert.match(readFileSync(path.join(state, 'shim-exit.txt'), 'utf8'), /^0 /);
      assert.equal(readFileSync(path.join(state, 'host.txt'), 'utf8'), '-n 0 -- tests/x.py::t');
      assert.match(readFileSync(path.join(state, 'inner.txt'), 'utf8'),
        /^granted -n 0 -- --basetemp=\S+\/mlai-gate-bridge\/[\w-]+\/run-[\d-]+ tests\/x\.py::t$/);
    });
  } finally { rmSync(fakes, { recursive: true, force: true }); }
  // The daily start limit is the account's quota, and the CLI's unreadable error keeps its code.
  await fixture({ scenario: 'daily' }, ({ rc, stderr, status }) => {
    assert.equal(rc, 3, stderr);
    assert.equal(status.unavailable_reason, 'quota');
    assert.equal(status.error, 'mlai: daily_run_limit');
  });
});

test('a run stopped by the step limit continues the same session and then removes it', { timeout: 300_000 }, async () => {
  await fixture({ scenario: 'steps', worktree: true }, ({ rc, stderr, status, output, state, mlaiHome, root, dir, home }) => {
    assert.equal(readFileSync(path.join(state, 'checkpoints-1.txt'), 'utf8'), '0', 'checkpoints off in a worktree');
    // A read root that holds the job folder would be mounted read-only over it as --add-dir: it gets a Read rule instead.
    const args = JSON.parse(readFileSync(path.join(state, 'args-1.json'), 'utf8'));
    const reads = args.filter((arg, i) => args[i - 1] === '--add-dir');
    assert.ok(args.includes(`Read(/${realpathSync(root)}/**)`), `the root holding the job folder has a Read rule: ${args.join(' ')}`);
    assert.ok(reads.includes(realpathSync(path.join(root, 'main'))), 'shell commands can read the sibling main repo');
    // Approvals are answered (--yes); secrets stay closed by deny rules, the job folder never.
    assert.ok(args.includes('--yes'), 'approvals are answered');
    const denies = args.filter((arg, i) => args[i - 1] === '--disallowedTools');
    assert.ok(denies.includes(`Read(/${realpathSync(home)}/.codex/**)`), `provider sign-ins are denied: ${denies.join(' ')}`);
    assert.ok(denies.includes(`Read(/${realpathSync(home)}/.claude/.credentials.json)`), 'Claude sign-in is denied');
    assert.ok(!denies.some((rule) => rule.includes('/.claude)') || rule.includes('/.claude/scripts')),
      'the harness scripts (pytest_gate.py) stay readable');
    assert.ok(!denies.some((rule) => realpathSync(dir).startsWith(rule.slice(6, -1).replace(/\/\*\*$/, '') + '/')),
      'no deny rule covers the job folder');
    assert.ok(!reads.some((target) => realpathSync(dir).startsWith(`${target}/`) || target === realpathSync(dir)),
      `no --add-dir holds the job folder: ${reads.join(' ')}`);
    assert.equal(rc, 0, stderr);
    assert.equal(status.state, 'done');
    assert.equal(status.attempts, '2');
    assert.equal(status.continues, '1');
    const first = JSON.parse(readFileSync(path.join(state, 'args-1.json'), 'utf8'));
    const second = JSON.parse(readFileSync(path.join(state, 'args-2.json'), 'utf8'));
    const id = first[first.indexOf('--session-id') + 1];
    assert.equal(second[second.indexOf('--resume') + 1], id);
    assert.equal(first.includes('--no-session-persistence'), false);
    assert.match(readFileSync(path.join(state, 'prompt-2.md'), 'utf8'), /^continue/);
    assert.match(output, /^## Changes$/m);
    assert.equal(existsSync(path.join(mlaiHome, 'sessions', id)), false);
  });
});

test('the host holder keeps the slots while any process of the run lives and frees them when none is left', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mlai-hold-'));
  const holder = new URL('../gate-hold.mjs', import.meta.url).pathname;
  const exited = (child) => new Promise((resolve) => child.once('exit', resolve));
  try {
    // A process whose command line carries the run's basetemp keeps the slots, though its process group is gone.
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', `${dir}/run-a`], { stdio: 'ignore' });
    const hold = spawn(process.execPath, [holder, dir, 'a', '999999'], { stdio: 'ignore' });
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(dir, 'grant-a')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(path.join(dir, 'grant-a')), 'the run is granted');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(hold.exitCode, null, 'slots held while the worker lives');
    worker.kill('SIGKILL');
    assert.equal(await exited(hold), 0, 'slots freed once nothing of the run is left');
    // A run that said done frees them at once.
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    const second = spawn(process.execPath, [holder, dir, 'b', String(sleeper.pid)], { stdio: 'ignore' });
    writeFileSync(path.join(dir, 'done-b'), '0\n');
    assert.equal(await exited(second), 0);
    sleeper.kill('SIGKILL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
