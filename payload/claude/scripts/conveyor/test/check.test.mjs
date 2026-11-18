import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile } from '../lib/profile.mjs';
import { main as checkMain } from '../check.mjs';
import { invoke } from './process-fixture.mjs';

const timeout = 600_000;
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const command = (source) => `${quote(process.execPath)} -e ${quote(source)}`;
const counter = { name: 'eslint-disable', pattern: 'eslint-disable', glob: 'src/**/*.{ts,tsx}' };
const profile = (fast = [], counters = []) => ({ version: 1, fast, hygiene: { counters } });
let template;

after(async () => { if (template) await fs.rm(template, { recursive: true, force: true }); });

function git(repo, args, env) {
  const result = spawnSync('git', [
    '-c', 'user.name=Conveyor test', '-c', 'user.email=conveyor@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args
  ], { cwd: repo, env, encoding: 'utf8', timeout });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

async function repositoryTemplate(env) {
  if (!template) {
    template = await fs.mkdtemp(path.join(tmpdir(), 'conveyor-check-template-'));
    git(template, ['init', '--quiet'], env);
    await fs.writeFile(path.join(template, 'README.md'), 'A check fixture.\n');
    git(template, ['add', '--all'], env);
    git(template, ['commit', '--quiet', '-m', 'template'], env);
  }
  return template;
}

async function environment(t, config, files = { 'src/example.ts': 'export const value = 1;\n' }) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor check test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const home = path.join(root, 'conveyor');
  const env = { ...process.env, HOME: root, CONVEYOR_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const fixture = {
    root, repo, home,
    async write(file, value) {
      const target = path.join(repo, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
    },
    async profile(value, trusted = true) {
      const raw = JSON.stringify(value);
      await this.write('.claude/conveyor.json', raw);
      if (trusted) {
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(home, 'trusted-profiles.json'), JSON.stringify({
          [repo]: createHash('sha256').update(raw).digest('hex')
        }));
      }
    },
    git(args) {
      git(repo, args, env);
    },
    async load(directory = repo) {
      let loaded;
      const result = await invoke(async () => { loaded = await loadProfile(directory); }, [], { cwd: directory, env });
      assert.equal(result.status, 0, result.stderr);
      return loaded;
    },
    async command(args, extraEnv = {}, directory = repo) {
      const result = await invoke(checkMain, [args[0], '--dir', directory, '--json', ...args.slice(1)], {
        cwd: directory, env: { ...env, ...extraEnv }, prefix: 'conveyor check', errorCode: 2
      });
      assert.ifError(result.error);
      return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
    }
  };
  fixture.git(['clone', '--local', '--quiet', await repositoryTemplate(env), '.']);
  for (const [file, value] of Object.entries(files)) await fixture.write(file, value);
  if (config !== undefined) await fixture.profile(config);
  fixture.git(['add', '--all']);
  fixture.git(['commit', '--quiet', '-m', 'fixture']);
  return fixture;
}

test('profile rejects unknown keys and autodetects Node and Python checks', { timeout }, async (t) => {
  const env = await environment(t, { version: 1, unexpected: true });
  await assert.rejects(loadProfile(env.repo), /unknown profile key: unexpected/);
  await env.profile({ version: 1, hygiene: { surprise: true } });
  await assert.rejects(loadProfile(env.repo), /unknown hygiene key: surprise/);
  await fs.rm(path.join(env.repo, '.claude/conveyor.json'));
  await env.write('package.json', JSON.stringify({
    scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'never-run-the-full-suite' }
  }));
  await env.write('eslint.config.mjs', 'export default [];\n');
  await env.write('tsconfig.json', '{}');
  const node = await loadProfile(env.repo);
  assert.deepEqual(node.fast, [{
    name: 'eslint', glob: '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', run: 'npx eslint --max-warnings=0 {files}'
  }]);
  assert.deepEqual(node.turn, [{ name: 'types', when: '**/*.{ts,tsx,mts,cts}', run: 'npm run typecheck' }]);
  assert.deepEqual(node.budgets, { fast_s: 20, turn_s: 300 });
  await env.write('package.json', JSON.stringify({ devDependencies: { vitest: '1.0.0' } }));
  const vitest = await loadProfile(env.repo);
  assert.equal(vitest.turn[0].run, 'npx tsc --noEmit');
  assert.equal(vitest.turn[1].run, 'npx vitest related --run {files}');
  await fs.rm(path.join(env.repo, 'eslint.config.mjs'));
  await env.write('package.json', JSON.stringify({ scripts: { lint: 'custom-lint', test: 'never-run-the-full-suite' } }));
  const lint = await loadProfile(env.repo);
  assert.deepEqual(lint.fast, []);
  assert.deepEqual(lint.turn.map((entry) => entry.run), ['npm run lint', 'npx tsc --noEmit']);

  const python = await environment(t);
  await python.write('pyproject.toml', '[tool.ruff]\nline-length = 100\n\n[tool.mypy]\n\n[tool.pytest.ini_options]\n');
  const detected = await loadProfile(python.repo);
  assert.deepEqual(detected.fast, [{ name: 'ruff', glob: '**/*.py', run: 'ruff check {files}' }]);
  assert.deepEqual(detected.turn.map((entry) => entry.run), [
    'uv run mypy {files}', 'python3 ~/.claude/scripts/pytest_gate.py -n 2 -- -q {tests_for_files}'
  ]);
  await python.write('uv.lock', 'version = 1\n');
  assert.equal((await loadProfile(python.repo)).fast[0].run, 'uv run ruff check {files}');
});

test('file placeholders pass literal positional arguments, including legacy quotes and shell syntax', { timeout }, async (t) => {
  const env = await environment(t);
  const files = ['a$(touch PWNED).ts', "a';touch PWNED;'.ts", '-option.ts', 'a b.ts'];
  for (const file of files) await env.write(file, 'export {};\n');
  // Changed files are sorted before they become positional arguments.
  const expected = [...files].sort().map((file) => file.startsWith('-') ? `./${file}` : file);
  const check = command(`require('node:assert/strict').deepEqual(process.argv.slice(1), ${JSON.stringify(expected)})`);
  for (const placeholder of ['{files}', '"{files}"', "'{files}'"]) {
    await env.profile(profile([{ name: 'argv', run: `${check} -- ${placeholder}` }]));
    const result = await env.command(['run', '--level', 'fast', '--files', files.join(',')]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.report.results[0].cmd.includes('"$@"'));
    await assert.rejects(fs.stat(path.join(env.repo, 'PWNED')), { code: 'ENOENT' });
  }
});

test('untrusted profiles use autodetection and default hygiene until the reviewed SHA-256 is trusted', { timeout }, async (t) => {
  const env = await environment(t);
  const bin = path.join(env.root, 'bin'), log = path.join(env.root, 'npm.jsonl');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
  const fakePath = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  await env.write('package.json', JSON.stringify({ scripts: { lint: 'custom-lint', test: 'never-run-the-full-suite' } }));
  const config = { ...profile([{ name: 'repo-fast', run: 'touch PROFILE_RAN' }], [counter]),
    turn: [{ name: 'repo-turn', run: 'touch PROFILE_RAN' }] };
  await env.profile(config, false);
  await env.write('src/example.ts', '// eslint-disable\n');
  for (const level of ['fast', 'turn']) {
    const result = await env.command(['run', '--level', level], fakePath);
    assert.equal(result.status, 1);
    assert.equal(result.report.profileTrust, 'untrusted');
    assert.equal(result.report.profile, 'untrusted (run check.mjs trust after review)');
    assert.deepEqual(result.report.results.map((entry) => entry.name), level === 'turn' ? ['lint'] : []);
    assert.equal(result.report.hygiene.grew[0].counter, 'eslint-disable');
    await assert.rejects(fs.stat(path.join(env.repo, 'PROFILE_RAN')), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(log, 'utf8'), '["run","lint"]\n');
  const trusted = await env.command(['trust']);
  assert.equal(trusted.status, 0, trusted.stderr);
  const raw = await fs.readFile(path.join(env.repo, '.claude/conveyor.json'));
  const identity = await fs.realpath(path.join(env.repo, '.git'));
  assert.deepEqual(trusted.report, {
    ok: true, repo: env.repo, identity, profileTrust: 'trusted', sha256: createHash('sha256').update(raw).digest('hex')
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.home, 'trusted-profiles.json'), 'utf8')), {
    [identity]: [trusted.report.sha256]
  });
  for (const level of ['fast', 'turn']) {
    const result = await env.command(['run', '--level', level]);
    assert.equal(result.report.profileTrust, 'trusted');
    assert.equal(result.report.results[0].status, 'pass');
    await fs.rm(path.join(env.repo, 'PROFILE_RAN'));
  }
  await fs.appendFile(path.join(env.repo, '.claude/conveyor.json'), '\n');
  assert.equal((await env.command(['run', '--level', 'fast'])).report.profileTrust, 'untrusted');
  await assert.rejects(fs.stat(path.join(env.repo, 'PROFILE_RAN')), { code: 'ENOENT' });
});

test('profile trust is shared across worktrees but excludes unreviewed edits', { timeout }, async (t) => {
  const env = await environment(t, profile());
  const worktree = path.join(env.root, 'worktree');
  env.git(['worktree', 'add', '--quiet', '--detach', worktree]);
  const trusted = await env.command(['trust']);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal((await env.load(worktree)).profileTrust, 'trusted');
  const alias = path.join(env.root, 'worktree-alias');
  await fs.symlink(worktree, alias, 'dir');
  const shared = await env.command(['trust'], {}, alias);
  assert.equal(shared.status, 0, shared.stderr);
  assert.equal(shared.report.identity, trusted.report.identity);
  await fs.appendFile(path.join(worktree, '.claude/conveyor.json'), '\n');
  assert.equal((await env.load(worktree)).profileTrust, 'untrusted');
  assert.equal((await env.load()).profileTrust, 'trusted');
});

test('legacy profile trust applies only to its path and migrates while preserving the reviewed digest', { timeout }, async (t) => {
  const env = await environment(t, profile());
  const worktree = path.join(env.root, 'worktree');
  env.git(['worktree', 'add', '--quiet', '--detach', worktree]);
  const file = path.join(env.home, 'trusted-profiles.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'))[env.repo];
  assert.equal((await env.load()).profileTrust, 'trusted');
  assert.equal((await env.load(worktree)).profileTrust, 'untrusted');
  await env.profile({ ...profile(), gate: { mode: 'warn' } }, false);
  const trusted = await env.command(['trust']);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    [trusted.report.identity]: [legacy, trusted.report.sha256]
  });
  assert.equal((await env.load()).profileTrust, 'trusted');
  assert.equal((await env.load(worktree)).profileTrust, 'trusted');
});

test('profile trust retains five distinct digests in order of their latest review', { timeout }, async (t) => {
  const env = await environment(t);
  const digests = [];
  let identity;
  for (let index = 0; index < 6; index++) {
    await env.profile({ ...profile(), budgets: { fast_s: index + 1 } }, false);
    const trusted = await env.command(['trust']);
    assert.equal(trusted.status, 0, trusted.stderr);
    identity = trusted.report.identity;
    digests.push(trusted.report.sha256);
  }
  const file = path.join(env.home, 'trusted-profiles.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { [identity]: digests.slice(1) });
  await env.profile({ ...profile(), budgets: { fast_s: 1 } }, false);
  assert.equal((await env.load()).profileTrust, 'untrusted');
  await env.profile({ ...profile(), budgets: { fast_s: 2 } }, false);
  assert.equal((await env.load()).profileTrust, 'trusted');
  const trusted = await env.command(['trust']);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    [identity]: [...digests.slice(2), digests[1]]
  });
});

test('non-git profile trust keeps the directory path as its identity', { timeout }, async (t) => {
  const env = await environment(t);
  const directory = path.join(env.root, 'plain');
  await fs.mkdir(path.join(directory, '.claude'), { recursive: true });
  await fs.writeFile(path.join(directory, '.claude/conveyor.json'), JSON.stringify(profile()));
  const trusted = await env.command(['trust'], {}, directory);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(trusted.report.identity, directory);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.home, 'trusted-profiles.json'), 'utf8')), {
    [directory]: [trusted.report.sha256]
  });
  assert.equal((await env.load(directory)).profileTrust, 'trusted');
});

test('runner skips entries with no matching changed files and excludes deleted files', { timeout }, async (t) => {
  const env = await environment(t, profile([{ name: 'lint', glob: 'src/**/*.ts', run: command('process.exit(9)') }]));
  await fs.rm(path.join(env.repo, 'src/example.ts'));
  const { status, stderr, report } = await env.command(['run', '--level', 'fast', '--files', 'README.md,src/example.ts']);
  assert.equal(status, 0, stderr);
  assert.deepEqual(report.changed, ['README.md']);
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(report.results[0].outputTail, 'skipped: no matching files');
  assert.equal(report.results[0].rc, null);
  assert.equal(report.ok, true);
});

test('turn test budget counts net additions across changed, new and deleted files', { timeout }, async (t) => {
  const python = (start, count) => Array.from({ length: count }, (_, index) => `def test_${start + index}():\n    pass\n`).join('');
  const env = await environment(t, { ...profile(), budgets: { new_tests: 10 } }, {
    'tests/test_existing.py': python(1, 2),
    'source.spec.ts': "it('exists', () => {});\n"
  });
  // Cases inside a one-line describe count too, and the JS file lives under tests/ without a .test suffix.
  await env.write('tests/widget.js', "describe('w', () => { it('a', () => {}); test.each([1, 2])('b %s', () => {}); });\n");
  await env.write('tests/test_existing.py', python(1, 6));
  await env.write('tests/test_new.py', python(1, 3));
  await fs.rm(path.join(env.repo, 'source.spec.ts'));

  const turn = ['run', '--level', 'turn'];
  const pass = await env.command([...turn, '--test-budget', '8']);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.report.ok, true);
  const fail = await env.command([...turn, '--test-budget', '7']);
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(fail.report.ok, false);
  assert.deepEqual(fail.report.tests, {
    budget: 7, added: 8, ok: false, files: [
      { file: 'source.spec.ts', before: 1, after: 0 },
      { file: 'tests/test_existing.py', before: 2, after: 6 },
      { file: 'tests/test_new.py', before: 0, after: 3 },
      { file: 'tests/widget.js', before: 0, after: 2 }
    ]
  });
  const configured = await env.command([...turn, '--test-budget', 'profile']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(configured.report.ok, true);
  assert.deepEqual(configured.report.tests, { ...fail.report.tests, budget: 10, ok: true });
  for (const args of [turn, ['run', '--level', 'fast', '--test-budget', '0']]) {
    const unchecked = await env.command(args);
    assert.equal(unchecked.status, 0, unchecked.stderr);
    assert.equal(unchecked.report.ok, true);
    assert.equal(Object.hasOwn(unchecked.report, 'tests'), false);
  }
});

test('runner returns exit 1 and the last 60 ANSI-free output lines on failure', { timeout }, async (t) => {
  const run = command(String.raw`
    for (let index = 0; index < 65; index++) console.log('\x1b[31mline ' + index + '\x1b[0m');
    process.exit(7);
  `.trim().replaceAll('\n', ' '));
  const env = await environment(t, profile([{ name: 'failure', glob: 'src/**/*.ts', run }]));
  const { status, report } = await env.command(['run', '--level', 'fast', '--files', 'src/example.ts']);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, 'fail');
  assert.equal(report.results[0].rc, 7);
  assert.deepEqual(report.results[0].outputTail.split('\n'), Array.from({ length: 60 }, (_, index) => `line ${index + 5}`));
  assert.equal(report.results[0].cmd, run);
});

test('runner times out and kills the process group including the child', { timeout }, async (t) => {
  const env = await environment(t);
  const pidFile = path.join(env.root, 'pids.json');
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
    "process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); });",
    'setInterval(() => {}, 1000);'
  ].join(' ');
  await env.profile({ ...profile([{ name: 'slow', glob: '**/*.ts', run: command(source) }]), budgets: { fast_s: 1 } });
  let pids;
  try {
    const { status, report } = await env.command(['run', '--level', 'fast', '--files', 'src/example.ts']);
    pids = JSON.parse(await fs.readFile(pidFile, 'utf8'));
    assert.equal(status, 1);
    assert.equal(report.results[0].status, 'timeout');
    assert.ok(report.results[0].durationMs >= 1000);
    for (const pid of Object.values(pids)) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally {
    if (pids) {
      for (const pid of Object.values(pids)) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
});

test('runner invokes the heavy-gate wait before a heavy-looking command', { timeout }, async (t) => {
  const env = await environment(t);
  const gate = path.join(env.root, 'heavy-gate.mjs'), log = path.join(env.root, 'admission.json');
  await fs.writeFile(gate, [
    "import * as fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`
  ].join('\n'));
  const source = `require('node:assert/strict').deepEqual(require('node:fs').readFileSync(${JSON.stringify(log)}, 'utf8'), '["wait"]')`;
  await env.profile(profile([{ name: 'types', when: '**/*.ts', run: `${command(source)} tsc` }]));
  const { status, stderr, report } = await env.command(['run', '--level', 'fast', '--files', 'src/example.ts'], {
    CONVEYOR_HEAVY_GATE: gate
  });
  assert.equal(status, 0, stderr);
  assert.equal(report.results[0].status, 'pass');
  assert.deepEqual(JSON.parse(await fs.readFile(log, 'utf8')), ['wait']);
});

test('hygiene fails when one eslint-disable is added to a changed file', { timeout }, async (t) => {
  const env = await environment(t, profile([], [counter]), { 'src/example.ts': '// eslint-disable\n' });
  await env.write('src/example.ts', '// eslint-disable\n// eslint-disable\n');
  const { status, report } = await env.command(['run', '--level', 'fast']);
  assert.equal(status, 1);
  assert.equal(report.hygiene.ok, false);
  assert.deepEqual(report.hygiene.grew, [{ file: 'src/example.ts', counter: 'eslint-disable', before: 1, after: 2 }]);
});

test('hygiene passes when one eslint-disable is removed', { timeout }, async (t) => {
  const env = await environment(t, profile([], [counter]), { 'src/example.ts': '// eslint-disable\n// eslint-disable\n' });
  await env.write('src/example.ts', '// eslint-disable\n');
  const { status, report } = await env.command(['run', '--level', 'turn']);
  assert.equal(status, 0);
  assert.equal(report.hygiene.ok, true);
  assert.deepEqual(report.hygiene.grew, []);
});

test('hygiene counts a new untracked file with a TODO from zero', { timeout }, async (t) => {
  const env = await environment(t);
  await env.write('src/new.ts', '// TODO: finish this module\n');
  const { status, report } = await env.command(['run', '--level', 'fast']);
  assert.equal(status, 1);
  assert.deepEqual(report.changed, ['src/new.ts']);
  assert.deepEqual(report.hygiene.grew, [{ file: 'src/new.ts', counter: 'TODO/FIXME', before: 0, after: 1 }]);
});

test('hygiene fails when a large file crosses the line limit', { timeout }, async (t) => {
  const large = { name: 'large-files', maxLines: 1500, glob: 'src/**/*.ts' };
  const env = await environment(t, profile([], [large]), { 'src/example.ts': 'export {};\n'.repeat(1500) });
  await env.write('src/example.ts', 'export {};\n'.repeat(1501));
  const { status, report } = await env.command(['run', '--level', 'fast']);
  assert.equal(status, 1);
  assert.deepEqual(report.hygiene.grew, [{ file: 'src/example.ts', counter: 'large-files', before: 1500, after: 1501 }]);
});

test('default hygiene creates an external baseline and reports repository totals against it', { timeout }, async (t) => {
  const env = await environment(t, undefined, { 'src/example.ts': '// eslint-disable\n// TODO: finish\n' });
  const written = await env.command(['hygiene', '--write-baseline']);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.report.totals['eslint-disable'], 1);
  assert.equal(written.report.totals['TODO/FIXME'], 1);
  assert.equal(written.report.totals['large-files'], 0);
  const identity = await fs.realpath(path.join(env.repo, '.git'));
  const file = path.join(env.home, 'baselines', `${createHash('sha256').update(identity).digest('hex').slice(0, 16)}.json`);
  assert.equal(written.report.source, 'default');
  assert.equal(written.report.baselineFile, file);
  await assert.rejects(fs.stat(path.join(env.repo, '.conveyor')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, totals: written.report.totals });
  const read = await env.command(['hygiene']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(read.report.totals, written.report.totals);
  assert.deepEqual(read.report.baseline, written.report.totals);
  assert.ok(Object.values(read.report.delta).every((value) => value === 0));
  await env.write('src/example.ts', '// eslint-disable\n// eslint-disable\n// TODO: finish\n');
  const changed = await env.command(['hygiene']);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.report.totals['eslint-disable'], 2);
  assert.equal(changed.report.baseline['eslint-disable'], 1);
  assert.equal(changed.report.delta['eslint-disable'], 1);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});


test('zero-config ratchet seeds the base state and shares its baseline with worktrees', { timeout: 3000 }, async (t) => {
  const env = await environment(t, undefined, { 'src/example.ts': 'export const old = 1 as any;\n' });
  await env.write('src/example.ts', 'export const old = 1 as any;\nexport const added = 2 as any;\n');
  const first = await env.command(['run', '--level', 'fast']);
  assert.equal(first.status, 1, first.stderr);
  assert.deepEqual(first.report.hygiene.grew, [{ file: 'src/example.ts', counter: 'any', before: 1, after: 2 }]);
  const file = first.report.hygiene.baselineFile;
  assert.equal(first.report.hygiene.source, 'default');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).totals.any, 1);
  await env.write('src/example.ts', 'export const old = 1 as any;\n');
  assert.equal((await env.command(['run', '--level', 'turn'])).status, 0);
  const worktree = path.join(env.root, 'worktree');
  env.git(['worktree', 'add', '--quiet', '--detach', worktree]);
  const shared = await env.command(['hygiene'], {}, worktree);
  assert.equal(shared.status, 0, shared.stderr);
  assert.equal(shared.report.baselineFile, file);
  assert.equal(shared.report.baseline.any, 1);
  await assert.rejects(fs.stat(path.join(env.repo, '.claude/conveyor.json')), { code: 'ENOENT' });
});

test('init prints without writing, writes a trusted valid profile and seeded baseline, and refuses overwrite',
  { timeout: 3000 }, async (t) => {
    const env = await environment(t, undefined, { 'src/example.ts': 'export const old = 1 as any;\n' });
    await env.write('package.json', JSON.stringify({ scripts: { lint: 'custom-lint' } }));
    const printed = await env.command(['init']);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.report.turn[0].run, 'npm run lint');
    assert.equal(printed.report.hygiene.baseline, '.conveyor/hygiene-baseline.json');
    await assert.rejects(fs.stat(env.home), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(env.repo, '.claude')), { code: 'ENOENT' });
    const external = await env.command(['hygiene']);
    await env.write('src/example.ts', 'export const old = 1 as any;\nexport const added = 2 as any;\n');
    const written = await env.command(['init', '--write']);
    assert.equal(written.status, 0, written.stderr);
    const baseline = JSON.parse(await fs.readFile(path.join(env.repo, '.conveyor/hygiene-baseline.json'), 'utf8'));
    assert.deepEqual(baseline.totals, external.report.baseline);
    assert.equal(baseline.totals.any, 1);
    assert.equal((await env.load()).profileTrust, 'trusted');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.repo, '.claude/conveyor.json'), 'utf8')), written.report);
    const refused = await env.command(['init', '--write']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /refusing to overwrite/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.repo, '.claude/conveyor.json'), 'utf8')), written.report);
  });

test('default counters cover language debt and exclude dependencies, generated files, and large tests',
  { timeout: 3000 }, async (t) => {
    const env = await environment(t, undefined, { 'src/example.ts': 'export {};\n', 'main.py': 'pass\n' });
    await env.write('src/example.ts', [
      '// TODO FIXME eslint-disable @ts-ignore @ts-expect-error',
      'try {} catch (e) { }', 'const value: any = thing as any;'
    ].join('\n'));
    await env.write('main.py', 'except Exception:\nexcept:\n# type: ignore\n# noqa\n@lru_cache\n@cache\n');
    for (const name of ['node_modules/debt.ts', 'dist/debt.ts', 'src/debt.generated.ts', 'src/debt.min.js']) {
      await env.write(name, '// TODO\nconst value = 1 as any;\n');
    }
    await env.write('tests/large.ts', 'export {};\n'.repeat(1501));
    const result = await env.command(['hygiene']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.totals, {
      'TODO/FIXME': 2, 'large-files': 0, 'empty-catch': 1, 'eslint-disable': 1,
      '@ts-ignore': 1, '@ts-expect-error': 1, any: 2, 'broad-except': 2, 'type-ignore': 1, noqa: 1, 'function-caches': 2
    });
    assert.ok(Object.values(result.report.baseline).every((total) => total === 0));
    await env.profile({ version: 1 });
    assert.equal((await env.command(['hygiene'])).report.source, 'default');
    await env.profile(profile([], []), false);
    const untrusted = await env.command(['run', '--level', 'fast']);
    assert.equal(untrusted.status, 1);
    assert.equal(untrusted.report.hygiene.source, 'default');
    assert.ok(untrusted.report.hygiene.grew.some((entry) => entry.counter === 'any'));
  });


test('init seeds zero debt for a new git repository without a commit', { timeout: 3000 }, async (t) => {
  const env = await environment(t);
  const repo = path.join(env.root, 'new-repo');
  await fs.mkdir(repo);
  git(repo, ['init', '--quiet']);
  await fs.writeFile(path.join(repo, 'main.ts'), 'export const value = 1 as any;\n');
  const result = await env.command(['init', '--write'], {}, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await env.load(repo)).profileTrust, 'trusted');
  const baseline = JSON.parse(await fs.readFile(path.join(repo, '.conveyor/hygiene-baseline.json'), 'utf8'));
  assert.equal(baseline.totals.any, 0);
});
