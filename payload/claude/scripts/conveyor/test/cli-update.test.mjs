import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchRecipes, planPatch } from '../lib/patch-recipes.mjs';

const cli = fileURLToPath(new URL('../cli-update.mjs', import.meta.url));
const timeout = 300_000;
const registry = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const manifest = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json';
const releaseUrl = (version, archive = false) => 'https://storage.googleapis.com/antigravity-public/antigravity-cli/' +
  `${version}-123456789/linux-x64/cli_linux_x64${archive ? '.tar.gz' : ''}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const executable = (file, text) => fs.writeFile(file, text, { mode: 0o700 });

function fakeAgy(version, fail = false) {
  return `#!/usr/bin/env node
const version = ${JSON.stringify(version)};
if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true' || !process.env.HOME.endsWith('/data/home') ||
    !process.env.DBUS_SESSION_BUS_ADDRESS || process.env.HTTPS_PROXY !== 'http://127.0.0.1:10809') process.exit(9);
if (process.argv[2] === 'models') {
  if (${fail}) { process.stderr.write('candidate smoke failed\\n'); process.exit(2); }
  console.log('gemini-fixture-model');
} else if (process.argv[2] === 'acp') {
  process.stdin.on('data', () => {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version } } }));
  });
} else process.exit(2);
`;
}

async function environment() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor cli update-'));
  const home = path.join(root, 'home'), agy = path.join(root, 'agy');
  const codex = path.join(root, 'fake codex'), npm = path.join(root, 'fake npm');
  const npmLog = path.join(root, 'npm.jsonl'), state = path.join(root, 'codex-version');
  const settings = path.join(agy, 'config', 'settings.json'), binary = path.join(agy, 'bin', 'agy');
  const daemon = path.join(home, '.claude', 'scripts', 'luna-daemon.mjs');
  for (const directory of [path.dirname(daemon), path.join(home, 'dev/gpt-harness'),
    path.join(agy, 'config'), path.join(agy, 'bin'), path.join(agy, 'data/home')]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(state, '0.164.0');
  await fs.writeFile(path.join(home, 'dev/gpt-harness/install.mjs'), '// install @openai/codex@0.164.0\n');
  await executable(codex, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
console.log('codex-cli ' + readFileSync(${JSON.stringify(state)}, 'utf8').trim());
`);
  await executable(npm, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const requested = process.argv.at(-1).split('@').at(-1);
const latest = JSON.parse(process.env.CLI_UPDATE_FAKE_FETCH)[${JSON.stringify(registry)}].version;
writeFileSync(${JSON.stringify(state)}, requested === 'latest' ? latest : requested);
`);
  const original = fakeAgy('1.5.9');
  await executable(binary, original);
  await executable(path.join(agy, 'bin', 'agy.original'), original);
  await fs.writeFile(settings, '{\n\t"agy_bin": ' + JSON.stringify(binary) + ',\n' +
    `\t"agy_sha256" : "${sha256(original)}",\n\t"concurrency": 24,\n\t"extra": {"keep": true}\n}\n`);
  await executable(path.join(agy, 'run-agy'), `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const settings = JSON.parse(readFileSync(${JSON.stringify(settings)}, 'utf8'));
const bytes = readFileSync(settings.agy_bin);
if (createHash('sha256').update(bytes).digest('hex') !== settings.agy_sha256) process.exit(8);
if (process.env.CLI_UPDATE_TEST_WRAPPER_FAIL === '1' && bytes.includes(Buffer.from('1.6.0'))) {
  console.error('installed smoke failed');
  process.exit(7);
}
const result = spawnSync(settings.agy_bin, process.argv.slice(2), { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`);
  const env = { ...process.env, HOME: home, LUNA_RUN_DIR: path.join(home, '.claude/luna-run'),
    LUNA_DAEMON_HOME: path.join(home, '.claude/luna-run'), CLI_UPDATE_CODEX_CMD: codex,
    CLI_UPDATE_NPM_CMD: npm, CLI_UPDATE_AGY_DIR: agy,
    CLI_UPDATE_FAKE_FETCH: JSON.stringify({
      [registry]: { version: '0.165.0' },
      [manifest]: { version: '1.6.0', url: releaseUrl('1.6.0', true), sha512: 'a'.repeat(128) }
    }) };
  delete env.CLI_UPDATE_TEST_WRAPPER_FAIL;
  return {
    root, home, agy, state, npmLog, settings, binary, daemon, original, env,
    async daemonState(state = null) {
      const health = JSON.stringify({ ok: true, profile: 'default', running: state === 'running' ? 1 : 0 });
      const row = state ? `fixture-job\t${state}\tgpt-fixture\thigh\tread-only\n` : '';
      const output = `${health}\nid\tstate\tmodel\teffort\tsandbox\n${row}owner\trunning\tqueued\n`;
      await fs.writeFile(daemon, `process.stdout.write(${JSON.stringify(output)});\n`);
    },
    command(args, extra = {}) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...env, ...extra }, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024
      });
      assert.ifError(result.error);
      let json;
      try { json = JSON.parse(result.stdout); }
      catch { assert.fail(`invalid JSON: ${result.stdout}\n${result.stderr}`); }
      return { ...result, json };
    },
    async cleanup() { await fs.rm(root, { recursive: true, force: true }); }
  };
}

test('status parses versions, caches six hours, refreshes, and refuses non-allowlisted hosts', { timeout }, async () => {
  const fixture = await environment();
  try {
    await fixture.daemonState();
    const cache = path.join(fixture.home, '.claude/conveyor/cli-cache.json');
    const first = fixture.command(['status', '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.codex.installed, '0.164.0');
    assert.equal(first.json.codex.latest, '0.165.0');
    assert.equal(first.json.codex.expectedByHarness, '0.164.0');
    assert.equal(first.json.codex.updateAvailable, true);
    assert.equal(first.json.codex.busy.jobs, 0);
    assert.equal(first.json.agy.installed, '1.5.9');
    assert.equal(first.json.agy.latest, '1.6.0');
    assert.equal(first.json.agy.latestUrl, releaseUrl('1.6.0', true));
    assert.equal(first.json.agy.sha256, sha256(fixture.original));
    assert.equal(first.json.agy.pinnedSha256, sha256(fixture.original));
    assert.equal(first.json.agy.checksumOk, true);
    assert.equal(first.json.agy.updateAvailable, true);
    assert.equal(first.json.agy.rollbackAvailable, false);
    assert.equal((await readJson(cache)).codex.latest, '0.165.0');
    const changed = { CLI_UPDATE_FAKE_FETCH: JSON.stringify({
      [registry]: { version: '0.166.0' },
      [manifest]: { version: '1.7.0', url: releaseUrl('1.7.0', true), sha512: 'b'.repeat(128) }
    }) };
    const cached = fixture.command(['status', '--json'], changed);
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(cached.json.codex.latest, '0.165.0');
    assert.equal(cached.json.agy.latest, '1.6.0');
    const refreshed = fixture.command(['status', '--json', '--refresh'], changed);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.json.codex.latest, '0.166.0');
    assert.equal(refreshed.json.agy.latest, '1.7.0');
    assert.equal((await readJson(cache)).agy.latest, '1.7.0');
    const refused = fixture.command(['update', 'agy', '--url', 'https://example.com/agy', '--confirm']);
    assert.equal(refused.status, 1);
    assert.match(refused.json.reason, /non-allowlisted/);
  } finally { await fixture.cleanup(); }
});

test('Codex refuses running and queued daemon jobs; unconfirmed updates change nothing', { timeout }, async () => {
  const fixture = await environment();
  try {
    for (const state of ['running', 'queued']) {
      await fixture.daemonState(state);
      const result = fixture.command(['update', 'codex', '--version', '0.165.0', '--confirm']);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(result.json.ok, false);
      assert.match(result.json.reason, /daemon has running or queued jobs/);
      assert.ok(result.json.busy.jobs > 0);
    }
    const before = await fs.readdir(fixture.home);
    const dry = fixture.command(['update', 'codex', '--version', '0.165.0']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.from, '0.164.0');
    assert.equal(dry.json.to, '0.165.0');
    assert.match(dry.json.note, /update install.mjs and commit/);
    assert.equal(await fs.readFile(fixture.state, 'utf8'), '0.164.0');
    await assert.rejects(fs.stat(fixture.npmLog), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(fixture.home, '.claude/conveyor')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(fixture.home), before);
  } finally { await fixture.cleanup(); }
});

test('agy smoke failure preserves the install; replacement pins SHA, retains previous copy, and rolls back',
  { timeout }, async () => {
    const fixture = await environment();
    try {
      const settings = await fs.readFile(fixture.settings, 'utf8');
      const staging = path.join(fixture.agy, '.staging'), url = releaseUrl('1.6.0');
      const args = ['update', 'agy', '--url', url, '--confirm'];
      const bad = { CLI_UPDATE_FAKE_FETCH: JSON.stringify({ [url]: fakeAgy('1.6.0', true) }) };
      const goodBinary = fakeAgy('1.6.0'), good = { CLI_UPDATE_FAKE_FETCH: JSON.stringify({ [url]: goodBinary }) };
      const dry = fixture.command(args.slice(0, -1), good);
      assert.equal(dry.status, 0, dry.stderr);
      assert.equal(dry.json.dryRun, true);
      await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
      const gemActive = path.join(fixture.env.LUNA_RUN_DIR, 'gem-active');
      await fs.mkdir(gemActive, { recursive: true });
      const pointer = path.join(gemActive, 'fixture.json');
      await fs.writeFile(pointer, JSON.stringify({ id: 'fixture', wrapper_pid: process.pid }));
      assert.equal(fixture.command(args, good).status, 3);
      await fs.rm(pointer);
      const mcp = path.join(fixture.agy, 'data/status.json');
      await fs.writeFile(mcp, JSON.stringify({ active_items: 1 }));
      assert.equal(fixture.command(args, good).status, 3);
      await fs.writeFile(mcp, JSON.stringify({ active_items: 0 }));
      const failed = fixture.command(args, bad);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.json.reason, /candidate smoke failed/);
      assert.equal(await fs.readFile(fixture.binary, 'utf8'), fixture.original);
      assert.equal(await fs.readFile(fixture.settings, 'utf8'), settings);
      assert.deepEqual(await fs.readdir(staging), []);
      assert.deepEqual((await fs.readdir(path.join(fixture.agy, 'bin'))).sort(), ['agy', 'agy.original']);
      const installedFailure = fixture.command(args, { ...good, CLI_UPDATE_TEST_WRAPPER_FAIL: '1' });
      assert.equal(installedFailure.status, 1, installedFailure.stderr);
      assert.match(installedFailure.json.reason, /installed smoke failed/);
      assert.equal(installedFailure.json.restored, true);
      assert.equal(await fs.readFile(fixture.binary, 'utf8'), fixture.original);
      assert.equal(await fs.readFile(fixture.settings, 'utf8'), settings);
      assert.deepEqual(await fs.readdir(staging), []);
      const updated = fixture.command(args, good);
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(updated.json.ok, true);
      assert.equal(await fs.readFile(fixture.binary, 'utf8'), goodBinary);
      assert.equal((await readJson(fixture.settings)).agy_sha256, sha256(goodBinary));
      assert.equal(await fs.readFile(fixture.settings, 'utf8'), settings.replace(sha256(fixture.original), sha256(goodBinary)));
      assert.equal((await fs.stat(fixture.binary)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(staging)).mode & 0o777, 0o700);
      const previous = path.join(fixture.agy, 'bin', `agy.prev-${sha256(fixture.original).slice(0, 12)}`);
      assert.equal(await fs.readFile(previous, 'utf8'), fixture.original);
      assert.deepEqual(await fs.readdir(staging), []);
      const rolledBack = fixture.command(['rollback', 'agy', '--confirm'], good);
      assert.equal(rolledBack.status, 0, rolledBack.stderr);
      assert.equal(rolledBack.json.ok, true);
      assert.equal(await fs.readFile(fixture.binary, 'utf8'), fixture.original);
      assert.equal(await fs.readFile(fixture.settings, 'utf8'), settings);
      assert.equal(await fs.readFile(path.join(fixture.agy, 'bin', 'agy.original'), 'utf8'), fixture.original);
      assert.equal(await fs.readFile(path.join(fixture.agy, 'bin', `agy.prev-${sha256(goodBinary).slice(0, 12)}`), 'utf8'),
        goodBinary);
      assert.deepEqual(await fs.readdir(staging), []);
    } finally { await fixture.cleanup(); }
  });

test('patch plans verify synthetic recipes, reject unknown hashes and counts, and recognize patched bytes', () => {
  assert.equal(patchRecipes.length, 2);
  for (const count of [14, 15]) {
    const original = Buffer.from(`header\0${'ineligible\0'.repeat(count)}trailer`);
    const patched = Buffer.from(original.toString().replaceAll('ineligible', 'inexigible'));
    const recipe = { version: 'fixture', originalSha256: sha256(original), patchedSha256: sha256(patched), replacements: count };
    const before = Buffer.from(original), plan = planPatch(original, recipe);
    assert.equal(plan.status, 'ok');
    assert.equal(plan.replacements, count);
    assert.deepEqual(plan.candidate, patched);
    assert.equal(plan.candidate.length, original.length);
    assert.equal(plan.sha256, recipe.patchedSha256);
    assert.deepEqual(original, before);
    assert.equal(planPatch(Buffer.from('unknown'), recipe).status, 'unknown-build');
    assert.equal(planPatch(patched, recipe).status, 'already-patched');
    const wrong = planPatch(original, { ...recipe, replacements: count + 1 });
    assert.equal(wrong.status, 'verification-failed');
    assert.match(wrong.reason, /expected .* occurrences/);
  }
});
