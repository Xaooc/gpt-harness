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

async function fixture({ scenario, worktree = false }, verify) {
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
    writeFileSync(path.join(root, 'projects', 'ADMIN_ACCESS.txt'), 'x\n');
    writeFileSync(path.join(root, 'shared', 'notes.txt'), 'context\n');
    writeFileSync(brief, `Update greeting.txt and summarize the changes. Context: ${path.join(root, 'shared', 'notes.txt')}.\n`);
    writeFileSync(path.join(mlaiHome, 'auth.json'), JSON.stringify({
      expires: Date.now() + 86_400_000
    }));
    const child = spawn('bash', [entry, '-w', '-C', dir, '-f', brief, '-o', out], {
      env: {
        ...process.env, HOME: home, MLAI_HOME: mlaiHome, MLAI_BIN: fake, MLAI_SLOT: slot,
        LUNA_RUN_DIR: run, LUNA_NO_REGISTRY: '1', MLAI_RETRIES: '2', MLAI_RETRY_DELAY_MS: '10',
        LUNA_IDLE_MAX_S: '30', LUNA_TIMEOUT_S: '30', MLAI_READ_ROOTS: worktree ? root : path.join(root, 'projects'), FAKE_MLAI_SCENARIO: scenario, FAKE_MLAI_STATE_DIR: state
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
