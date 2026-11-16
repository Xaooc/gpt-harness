import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const cli = fileURLToPath(new URL('../interrogate.mjs', import.meta.url));
const defaults = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t, { claude = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'interrogate-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), out = path.join(root, 'out'), bin = path.join(root, 'bin');
  const home = path.join(root, '.claude', 'scripts'), conveyor = path.join(root, 'conveyor');
  for (const dir of [repo, bin, home, conveyor]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'untracked repro input\n');
  const intent = path.join(root, 'intent.md');
  await fs.writeFile(intent, 'Preserve the intended result.\n');
  const config = await readJson(defaults);
  config.panels.review = claude ? [{ provider: 'claude', model: 'haiku', effort: 'medium' }]
    : config.panels.review.slice(0, 2);
  await fs.writeFile(path.join(conveyor, 'orchestration.json'), JSON.stringify(config));
  const calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(calls, '');
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/bash
repo=$2
shift 2
case "$1" in
  rev-parse)
    if [ "$2" = --show-toplevel ]; then printf '%s\\n' "$repo"
    elif [ "$3" = 'fixture-base^{commit}' ]; then printf 'fixture-base\\n'
    else printf 'fixture-head\\n'; fi ;;
  show-ref|reset|clean|branch) exit 0 ;;
  merge-base) printf 'fixture-base\\n' ;;
  log) printf 'abc123 committed change\\n' ;;
  diff)
    printf 'fixture git warning\\n' >&2
    if [ "$2" = --stat ]; then printf 'tracked.txt | 1 +\\n'; else printf 'fixture binary patch\\n'; fi ;;
  ls-files) printf 'untracked.txt\\0' ;;
  apply) cat > "$repo/applied.patch" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const fake = path.join(root, 'fake.mjs');
  await fs.writeFile(fake, `import fs from 'node:fs';
import path from 'node:path';
const [kind, ...args] = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
const calls = ${JSON.stringify(calls)};
fs.appendFileSync(calls, JSON.stringify({kind, args}) + '\\n');
if (kind === 'new') {
  fs.mkdirSync(get('--path'));
} else if (kind === 'done') {
  fs.rmSync(args[0], {recursive: true});
} else if (kind === 'exec') {
  const out = get('-o'), worktree = get('-C');
  const brief = fs.readFileSync(get('-f'), 'utf8');
  if (!brief.includes('Break this change. Prove each finding with a run') || !brief.includes('abc123 committed change')
      || fs.readFileSync(path.join(worktree, 'applied.patch'), 'utf8') !== 'fixture binary patch\\n'
      || !fs.readFileSync(path.join(worktree, 'untracked.txt'), 'utf8').includes('repro input')) process.exit(19);
  if (${JSON.stringify(claude)}) {
    fs.writeFileSync(out + '.dispatch.json', JSON.stringify({action: 'claude-subagent', model: 'haiku', brief: get('-f')}));
    process.exit(4);
  }
  const seat = Number(get('--seat'));
  fs.writeFileSync(path.join(worktree, 'proof.txt'), 'observed failure\\n');
  const findings = seat === 0 ? [{title: 'Reproduced',
    command: 'test -z "$INTERROGATE_TEST_SECRET" && cat proof.txt && exit 9',
    output: 'observed failure', expected: 'intended result'}]
    : [{title: 'No command', output: 'an unsupported claim', expected: 'intended result'}];
  fs.writeFileSync(out, '\x60\x60\x60json\\n' + JSON.stringify({findings}) + '\\n\x60\x60\x60\\n');
}
`);
  await fs.writeFile(path.join(home, 'heavy-gate.mjs'),
    `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, '{"kind":"gate"}\\n');\n`);
  const override = (kind) => JSON.stringify([process.execPath, fake, kind]);
  const env = { ...process.env, HOME: root, CONVEYOR_HOME: conveyor, LUNA_RUN_DIR: path.join(root, 'luna-run'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CONVEYOR_LUNA_SH: fake, CONVEYOR_GEM_SH: fake,
    CONVEYOR_EXEC_CMD: override('exec'), CONVEYOR_WT_NEW: override('new'), CONVEYOR_WT_DONE: override('done'),
    INTERROGATE_TEST_SECRET: 'must not reach the repro' };
  return {
    root, repo, out, intent, conveyor,
    run() {
      return spawnSync(process.execPath, [cli, '--repo', repo, '--intent', intent, '--out', out],
        { env, encoding: 'utf8', timeout: 300_000 });
    },
    async calls() { return (await fs.readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); },
    result() { return readJson(path.join(out, 'findings.json')); }
  };
}

test('two seats keep run evidence, drop claims without a command, and remove both worktrees', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const result = await f.result();
  assert.equal(result.scope.base, 'fixture-base');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rerun_exit, 9);
  assert.equal(result.findings[0].rerun_output, 'observed failure\n');
  assert.deepEqual(result.dropped, [{ seat: 1, title: 'No command', reason: 'no run' }]);
  assert.deepEqual(result.seats.map((seat) => seat.status), ['done', 'done']);
  const calls = await f.calls();
  assert.equal(calls.filter((call) => call.kind === 'done').length, 2);
  assert.equal(calls.filter((call) => call.kind === 'gate').length, 1);
  for (const call of calls.filter((item) => item.kind === 'new')) {
    assert.match(call.args[call.args.indexOf('--owner') + 1], /^interrogate-/);
    assert.ok(call.args.includes('--no-public'));
    const worktree = call.args[call.args.indexOf('--path') + 1];
    await assert.rejects(fs.stat(worktree), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(worktree)), { code: 'ENOENT' });
  }
  const report = await fs.readFile(path.join(f.out, 'report.md'), 'utf8');
  assert.match(report, /# Intent[\s\S]*# Findings[\s\S]*# Dropped/);
});

test('unavailable seats are recorded and skipped; all unavailable exits 5', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const mark = { until: '2099-01-01T00:00:00Z', reason: 'auth', note: 'fixture unavailable' };
  const providers = path.join(f.conveyor, 'providers.json');
  await fs.writeFile(providers, JSON.stringify({ gemini: mark }));
  assert.equal(f.run().status, 0);
  let result = await f.result();
  assert.equal(result.seats[1].status, 'unavailable');
  assert.match(result.seats[1].reason, /auth/);
  assert.equal((await f.calls()).filter((call) => call.kind === 'new').length, 1);
  await fs.writeFile(providers, JSON.stringify({ codex: mark, gemini: mark }));
  assert.equal(f.run().status, 5);
  result = await f.result();
  assert.ok(result.seats.every((seat) => seat.status === 'unavailable'));
  assert.equal((await f.calls()).filter((call) => call.kind === 'new').length, 1);
});

test('exit 4 preserves the Claude dispatch and brief for the orchestrator', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { claude: true });
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const result = await f.result();
  assert.equal(result.seats[0].status, 'claude-handoff');
  assert.equal(result.seats[0].handoff.model, 'haiku');
  assert.match(await fs.readFile(result.seats[0].brief, 'utf8'), /Preserve the intended result/);
  assert.equal((await readJson(result.seats[0].dispatch)).action, 'claude-subagent');
  assert.equal((await f.calls()).filter((call) => call.kind === 'done').length, 1);
  assert.deepEqual(result.findings, []);
});
