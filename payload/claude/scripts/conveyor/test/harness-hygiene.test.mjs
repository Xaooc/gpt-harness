import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';

const cli = fileURLToPath(new URL('../harness-hygiene.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../../../hooks/conveyor-hygiene-session-start.mjs', import.meta.url));
const factsFile = fileURLToPath(new URL('../../../conveyor/harness-facts.json', import.meta.url));
const timeout = 300_000;
const day = 24 * 60 * 60 * 1000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

async function environment(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'harness hygiene-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claude = path.join(root, 'claude'), conveyor = path.join(root, 'conveyor'), repo = path.join(root, 'repo');
  const reports = path.join(conveyor, 'hygiene'), manifestFile = path.join(repo, 'payload-linux/manifest.json');
  const facts = await readJson(factsFile);
  const entries = [];
  const env = { ...process.env, CLAUDE_HOME_DIR: claude, CONVEYOR_HOME: conveyor, HARNESS_REPO: repo };
  delete env.HYGIENE_RUN_CMD;
  const doc = 'The shared heavy-gate defaults\nto 3 slots.\nThe gate caps workers per run (default 4).\n';
  async function packaged(dest, text) {
    const src = `claude/${dest}`;
    await write(path.join(repo, 'payload-linux', src), text);
    await write(path.join(claude, dest), text);
    entries.push({ src, dest, kind: 'file', sha256: digest(text) });
    await writeJson(manifestFile, { version: 1, files: entries });
  }
  await packaged('scripts/heavy-gate.mjs', 'const DEFAULTS = { max: 3 };\n');
  await packaged('scripts/pytest_gate.py', 'MAX_WORKERS = max(1, int(os.environ.get("CAP", str(min(4, POOL_SIZE)))))\n');
  await packaged('hooks/present.mjs', '// readable hook\n');
  await packaged('skills/demo/SKILL.md', '---\nname: demo\ndescription: A fixture skill\n---\n');
  await write(path.join(claude, 'CLAUDE.md'), doc);
  await writeJson(path.join(claude, 'settings.json'), { hooks: {} });
  await writeJson(path.join(claude, 'conveyor/orchestration.json'), {
    catalog: { codex: [{ model: 'gpt-6.1-sol' }], gemini: [{ model: 'gemini-current' }], claude: [{ model: 'claude-current' }] }
  });
  await writeJson(path.join(conveyor, 'harness-facts.json'), facts);
  function command(file, args = [], overrides = {}) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [file, ...args], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024
    });
    assert.ifError(result.error);
    return { ...result, elapsed: performance.now() - start };
  }
  return {
    root, claude, conveyor, repo, reports, manifestFile, facts, doc, entries, packaged,
    async run(extra = [], overrides = {}) {
      const result = command(cli, ['run', '--json', '--repo', repo, ...extra], overrides);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(await readJson(path.join(reports, 'latest.json')), report);
      assert.match(await fs.readFile(path.join(reports, `harness-${report.at.slice(0, 10)}.md`), 'utf8'), /Harness hygiene:/);
      return { ...result, report };
    },
    start(overrides = {}) { return command(hook, [], overrides); }
  };
}

test('package sync detects manifest-stale, installed-drift and unpackaged; clean tree has none', { timeout }, async (t) => {
  const fixture = await environment(t);
  const clean = await fixture.run();
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.report.findings, []);
  assert.deepEqual(clean.report.counts, { high: 0, medium: 0, low: 0 });
  const source = path.join(fixture.repo, 'payload-linux/claude/hooks/present.mjs');
  const installed = path.join(fixture.claude, 'hooks/present.mjs');
  await write(source, '// changed payload\n');
  await write(installed, '// changed installed hook\n');
  const older = new Date(Date.now() - day);
  await fs.utimes(source, older, older);
  await write(path.join(fixture.claude, 'scripts/orphan.mjs'), '// unpackaged harness script\n');
  for (const ignored of ['hooks/old.mjs.bak-1', 'hooks/old.mjs.prev', 'hooks/old.mjs.next',
    'scripts/__pycache__/old.py', 'scripts/test/fixtures/fake.mjs']) {
    await write(path.join(fixture.claude, ignored), '// excluded\n');
  }
  const dirty = await fixture.run();
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.deepEqual(dirty.report.findings.map((item) => item.check).sort(), ['installed-drift', 'manifest-stale', 'unpackaged']);
  assert.match(dirty.report.findings.find((item) => item.check === 'installed-drift').detail, /installed file is newer/);
  for (const finding of dirty.report.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['check', 'detail', 'severity', 'suggestion', 'where']);
  }
  const failed = await fixture.run(['--fail-on', 'high']);
  assert.equal(failed.status, 1, failed.stderr);
  await fs.utimes(installed, older, older);
  await fs.utimes(source, new Date(), new Date());
  const newerPayload = await fixture.run();
  assert.match(newerPayload.report.findings.find((item) => item.check === 'installed-drift').detail, /payload file is newer/);
  const skipped = await fixture.run(['--repo', path.join(fixture.root, 'missing-repo')]);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(skipped.report.findings.map((item) => item.check), ['package-sync-skipped']);
});

test('hooks detect dead scripts and duplicate commands within the same event', { timeout }, async (t) => {
  const fixture = await environment(t);
  const present = `node "${path.join(fixture.claude, 'hooks/present.mjs')}"`;
  const missing = 'node ~/.claude/hooks/missing.mjs';
  const registration = (command) => ({ type: 'command', command });
  await writeJson(path.join(fixture.claude, 'settings.json'), { hooks: {
    SessionStart: [
      { hooks: [registration(present), registration(missing)] },
      { matcher: 'startup', hooks: [registration(present)] }
    ],
    Stop: [{ hooks: [registration(present)] }]
  } });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.findings.map((item) => item.check), ['dead-hook', 'duplicate-hook']);
  assert.match(result.report.findings[0].detail, /hooks\/missing\.mjs/);
  assert.ok(result.report.findings.every((item) => item.where.includes('SessionStart')));
});

test('facts detect default slot mismatch and accept equal captured defaults', { timeout }, async (t) => {
  const fixture = await environment(t);
  await write(path.join(fixture.claude, 'CLAUDE.md'), fixture.doc.replace('to 3 slots', 'to 2 slots'));
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.findings.length, 1);
  assert.equal(result.report.findings[0].check, 'fact-mismatch');
  assert.match(result.report.findings[0].detail, /heavy-gate-slots: prose says 2, source says 3/);
  await write(path.join(fixture.claude, 'CLAUDE.md'), fixture.doc);
  assert.deepEqual((await fixture.run()).report.findings, []);
});

test('prose checks missing paths and retired models, ignoring placeholders and allowlisted models', { timeout }, async (t) => {
  const fixture = await environment(t);
  await write(path.join(fixture.claude, 'CLAUDE.md'), fixture.doc
    + '`~/.claude/hooks/present.mjs` exists; ~/.claude/hooks/absent.mjs does not.\n'
    + '~/.claude/skills/<name>/SKILL.md ~/.claude/skills/*/SKILL.md ~/.claude/{hooks,scripts}/anything\n'
    + 'Use gpt-6.1-sol, gemini-current and claude-current. Never gpt-6-astra. Old: gpt-5-retired.\n');
  await fixture.packaged('skills/luna/SKILL.md', '---\nname: luna\ndescription: |\n  A multiline description.\n---\n'
    + 'Missing `~/.claude/scripts/absent.py`. Retired gemini-old.\n');
  await fixture.packaged('skills/broken/SKILL.md', '---\nname: broken\n---\n# Missing description\n');
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.findings.map((item) => item.check),
    ['missing-path', 'missing-path', 'retired-model', 'retired-model', 'skill-frontmatter']);
  const details = result.report.findings.map((item) => item.detail).join('\n');
  assert.match(details, /absent\.mjs/);
  assert.match(details, /absent\.py/);
  assert.match(details, /gpt-5-retired/);
  assert.match(details, /gemini-old/);
  assert.doesNotMatch(details, /gpt-6-astra|gpt-6\.1-sol|gemini-current|claude-current|<name>/);
  assert.ok(result.report.findings.filter((item) => item.check === 'retired-model').every((item) => item.severity === 'medium'));
});

test('SessionStart detaches stale runs, shows each recent report at most twice and stays silent when clean',
  { timeout }, async (t) => {
    const fixture = await environment(t);
    const marker = path.join(fixture.root, 'runs.jsonl'), fake = path.join(fixture.root, 'fake-runner.mjs');
    await write(fake, "import { appendFileSync } from 'node:fs';\n"
      + `setTimeout(() => appendFileSync(${JSON.stringify(marker)}, 'started\\n'), 350);\n`);
    const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
    const override = { HYGIENE_RUN_CMD: `${quote(process.execPath)} ${quote(fake)}` };
    const stateFile = path.join(fixture.reports, 'state.json'), latest = path.join(fixture.reports, 'latest.json');
    await writeJson(stateFile, { lastRunAt: new Date(Date.now() - 2 * day).toISOString() });
    const first = fixture.start(override);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, '');
    assert.equal(first.stderr, '');
    assert.ok(first.elapsed < 200, `SessionStart took ${first.elapsed.toFixed(1)} ms`);
    assert.ok(Date.now() - Date.parse((await readJson(stateFile)).lastRunAt) < day);
    const deadline = Date.now() + timeout;
    while (!(await fs.readFile(marker, 'utf8').catch(() => '')).includes('started')) {
      assert.ok(Date.now() < deadline, 'detached runner did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const at = new Date().toISOString();
    await writeJson(latest, { at, findings: [], counts: { high: 1, medium: 2, low: 1 } });
    for (let shown = 1; shown <= 2; shown++) {
      const result = fixture.start(override);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.elapsed < 200, `SessionStart hot path took ${result.elapsed.toFixed(1)} ms`);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(output.hookEventName, 'SessionStart');
      assert.equal(output.additionalContext, 'Гигиена харнесса: 4 расхождений (1 важных). Отчёт: '
        + `${latest} — предложи пользователю разобрать, ничего не меняй сам.`);
      assert.equal((await readJson(stateFile)).report.shown, shown);
    }
    assert.equal(fixture.start(override).stdout, '');
    assert.equal(await fs.readFile(marker, 'utf8'), 'started\n');
    await writeJson(latest, { at: new Date(Date.now() + 1).toISOString(), counts: { high: 0, medium: 1, low: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(fixture.start(override).stdout, /Гигиена харнесса/);
    assert.equal((await readJson(stateFile)).report.shown, 1);
    await writeJson(latest, { at, counts: { high: 0, medium: 0, low: 0 } });
    assert.equal(fixture.start(override).stdout, '');
    await writeJson(latest, { at: new Date(Date.now() - 3 * day).toISOString(), counts: { high: 1, medium: 0, low: 0 } });
    assert.equal(fixture.start(override).stdout, '');
    await write(latest, 'broken JSON');
    const broken = fixture.start(override);
    assert.equal(broken.status, 0);
    assert.equal(broken.stdout + broken.stderr, '');
  });

test('allowlisted unpackaged file, optional missing path and non-harness skill model produce no findings',
  { timeout }, async (t) => {
    const fixture = await environment(t);
    await write(path.join(fixture.claude, 'hooks/gsd-status.mjs'), '// allowlisted unpackaged hook\n');
    await write(path.join(fixture.claude, 'CLAUDE.md'), fixture.doc
      + 'Configured via `~/.claude/heavy-gate-off` and logged to `~/.claude/logs/audit.log`.\n');
    await fixture.packaged('skills/custom/SKILL.md', '---\nname: custom\ndescription: Non-harness skill\n---\n'
      + 'Mentions retired model gpt-5-retired and gemini-old in custom skill prose.\n');
    const result = await fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.findings, []);
    assert.deepEqual(result.report.counts, { high: 0, medium: 0, low: 0 });
  });
