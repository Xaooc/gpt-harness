/** Usage: node tests/verify-temp-home.mjs [--keep]. Requires a complete repository payload. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders } from '../install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 300_000;

function backupFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...backupFiles(file));
    else if (/\.(?:bak|orig)-luna-harness$/.test(entry.name)) {
      files.push([file, fs.readFileSync(file).toString('base64')]);
    }
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

function runInstaller(home, { platform = 'win32', check = false, dryRun = false } = {}) {
  const args = [path.join(REPO_ROOT, 'install.mjs'), '--home', home, '--platform', platform, '--yes'];
  if (check) args.push('--check');
  if (dryRun) args.push('--dry-run');
  if (platform === 'win32') args.push('--codex-build-root', path.join(home, 'codex-build'));
  const result = spawnSync(process.execPath, [
    ...args,
  ], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home, LUNA_INSTALL_NO_SUPERVISOR: '1' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`[FAIL] ${result.error.message}`);
  return { code: result.status ?? 2, output: result.stdout ?? '' };
}

function verifyHookCommands(home, payload = 'payload') {
  const claudeHome = path.join(home, '.claude');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, payload, 'manifest.json'), 'utf8'));
  const fragment = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, payload, manifest.settings), 'utf8'));
  const expected = substitutePlaceholders(fragment, claudeHome);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
  for (const [event, entries] of Object.entries(expected.hooks ?? {})) {
    const actual = (settings.hooks?.[event] ?? []).flatMap(entry => entry.hooks ?? []);
    for (const hook of entries.flatMap(entry => entry.hooks ?? [])) {
      if (typeof hook.command !== 'string') continue;
      const count = actual.filter(item => item.command === hook.command).length;
      assert.equal(count, 1, `${event}: expected hook command exactly once: ${hook.command}`);
    }
  }
}

function verifyWindowsPayload(home) {
  const claudeHome = path.join(home, '.claude');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'payload/manifest.json'), 'utf8'));
  for (const { dest, sha256 } of manifest.files) {
    const installed = fs.readFileSync(path.join(claudeHome, dest));
    assert.equal(createHash('sha256').update(installed).digest('hex'), sha256, dest);
  }
  const destinations = new Set(manifest.files.map(file => file.dest));
  for (const dest of [
    'scripts/conveyor/exec.mjs',
    'conveyor/orchestration.default.json',
    'conveyor/harness-facts.json',
    'local-plugins/pstack/.claude-plugin/plugin.json',
    'local-plugins/pstack/skills/poteto-mode/SKILL.md',
    'hooks/test/conveyor-hygiene-session-start.test.mjs',
    'hooks/test/conveyor-stop-gate.test.mjs',
    'hooks/test/conveyor-subagent-gate.test.mjs',
    'hooks/test/harness-guards.test.mjs',
    'hooks/test/luna-skill-autoload.test.mjs',
  ]) {
    assert.ok(destinations.has(dest), `Missing Windows payload file: ${dest}`);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(claudeHome, 'local-plugins/.claude-plugin/marketplace.json'), 'utf8'));
  assert.ok(marketplace.plugins.some(plugin => plugin.name === 'luna-panel' && plugin.source === './luna-panel'));
  assert.ok(marketplace.plugins.some(plugin => plugin.name === 'pstack' && plugin.source === './pstack'));
  assert.equal(settings.enabledPlugins['pstack@luna-local'], true);
  assert.equal(settings.extraKnownMarketplaces['luna-local'].source.path, `${claudeHome.replaceAll('/', '\\')}\\local-plugins`);
  for (const [event, file, timeout, matcher] of [
    ['UserPromptSubmit', 'conveyor-prompt-capture', 10],
    ['Stop', 'conveyor-stop-gate', 600],
    ['SubagentStop', 'conveyor-subagent-gate', 600],
    ['SessionStart', 'conveyor-hygiene-session-start', 10],
    ['SessionStart', 'plugin-quiet', 10],
    ['PreToolUse', 'harness-guards', 10, 'Bash|Write|Edit|MultiEdit'],
  ]) {
    const dest = `hooks/${file}.mjs`;
    assert.ok(destinations.has(dest), `Missing Windows hook: ${dest}`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${claudeHome.replaceAll('\\', '/')}/${dest}"`;
    const matches = Object.entries(settings.hooks).flatMap(([actualEvent, entries]) =>
      entries.flatMap(entry => entry.hooks.filter(hook => hook.command?.replaceAll('\\', '/').includes(`/${dest}`))
        .map(hook => [actualEvent, hook.command, hook.timeout, entry.matcher])));
    assert.deepEqual(matches, [[event, command, timeout, matcher]], file);
  }
  const instructions = fs.readFileSync(path.join(claudeHome, 'CLAUDE.md'), 'utf8');
  const block = /<!-- luna-harness:begin -->([\s\S]*?)<!-- luna-harness:end -->/.exec(instructions);
  assert.ok(block, 'Missing managed CLAUDE.md block');
  for (const section of ['Approach review', 'Acceptance ledger', 'Tests: a budget', 'C:/dev/luna-harness']) {
    assert.ok(block[1].includes(section), `Missing Windows CLAUDE.md text: ${section}`);
  }
  const sync = spawnSync(process.execPath, ['tools/sync-windows.mjs', '--check'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: TIMEOUT, windowsHide: true,
  });
  assert.equal(sync.status, 0, [sync.stdout, sync.stderr, sync.error?.message].filter(Boolean).join('\n'));
}

function verifyConveyor(home) {
  const claudeHome = path.join(home, '.claude');
  const conveyor = path.join(claudeHome, 'conveyor');
  const scripts = path.join(claudeHome, 'scripts/conveyor');
  const config = path.join(conveyor, 'orchestration.json');
  const dispatcher = path.join(scripts, 'exec.mjs');
  const run = (label, args) => {
    const result = spawnSync(process.execPath, args, {
      cwd: scripts, encoding: 'utf8', timeout: TIMEOUT,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, CONVEYOR_HOME: conveyor, CLAUDE_HOME_DIR: claudeHome,
        LUNA_RUN_DIR: path.join(claudeHome, 'luna-run'), CODEX_HOME: path.join(home, '.codex'),
      },
    });
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
    assert.equal(result.status, 0, `${label} failed (${result.status ?? result.signal}):\n${output}`);
    console.log(`[ok] PASS ${label}`);
    return result.stdout;
  };
  assert.equal(fs.existsSync(config), false, 'Fresh home must start without a live orchestration config');
  assert.ok(fs.existsSync(path.join(conveyor, 'orchestration.default.json')), 'Default orchestration config must be shipped');
  run('installed conveyor status', [dispatcher, 'status']);
  assert.equal(run('installed conveyor config validate', [dispatcher, 'config', 'validate']).trim(), 'valid');
  assert.equal(fs.existsSync(config), false, 'Dispatcher checks must preserve the shipped config fallback');

  const testDir = path.join(scripts, 'test');
  if (fs.existsSync(testDir)) run('installed conveyor check.test.mjs', ['--test', path.join(testDir, 'check.test.mjs')]);
  else console.log('[skip] Installed conveyor test/ directory is absent');
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--keep')) {
    console.error('[FAIL] Usage: node tests/verify-temp-home.mjs [--keep]');
    return 2;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-harness-verify-'));
  let exitCode = 0;
  console.log(`[ok] Temporary homes under: ${temp}`);
  try {
    const windowsHome = path.join(temp, 'windows');
    const first = runInstaller(windowsHome, { check: process.platform === 'win32' });
    exitCode = first.code;
    if (exitCode !== 0) return exitCode;
    verifyWindowsPayload(windowsHome);
    console.log('[ok] PASS Windows manifest hashes, conveyor hooks, pstack, managed instructions, and payload sync');
    if (process.platform === 'win32') {
      const before = backupFiles(windowsHome);
      console.log('[ok] Running Windows installer again to verify idempotency');
      const second = runInstaller(windowsHome, { check: true });
      exitCode = second.code;
      if (exitCode !== 0) return exitCode;
      assert.match(second.output, /Summary: 0 files written; \d+ skipped; 0 backups created\./);
      assert.deepEqual(backupFiles(windowsHome), before, 'Second run must not create or alter backups');
      verifyHookCommands(windowsHome);
      console.log('[ok] PASS Windows idempotency, unchanged backups, and hook commands');
    }

    const home = path.join(temp, 'linux');
    const dry = runInstaller(home, { platform: 'linux', dryRun: true });
    exitCode = dry.code;
    if (exitCode !== 0) return exitCode;
    assert.equal(fs.existsSync(home), false, 'Linux dry-run must not create the home');
    if (process.platform !== 'linux') {
      console.log('[skip] Linux PATH, Codex model, and payload runtime checks require Linux binaries');
    }
    const firstLinux = runInstaller(home, { platform: 'linux' });
    exitCode = firstLinux.code;
    if (exitCode !== 0) return exitCode;
    verifyHookCommands(home, 'payload-linux');
    const claudeHome = path.join(home, '.claude');
    assert.equal(fs.existsSync(path.join(claudeHome, 'scripts/lib/luna-linux-test.mjs')), true);
    assert.equal(fs.existsSync(path.join(claudeHome, 'scripts/pytest_gate.py')), true);
    assert.equal(fs.existsSync(path.join(claudeHome, 'luna-harness.env')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'bin/luna-sh')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'luna-harness/codex-plugin-patches')), false);
    if (process.platform === 'linux') verifyConveyor(home);
    const beforeLinux = backupFiles(home);
    const secondLinux = runInstaller(home, { platform: 'linux', check: process.platform === 'linux' });
    exitCode = secondLinux.code;
    assert.match(secondLinux.output, /Summary: 0 files written; \d+ skipped; 0 backups created\./);
    assert.deepEqual(backupFiles(home), beforeLinux, 'Second Linux run must not alter backups');
    console.log('[ok] PASS Linux dry-run, install, idempotency, unchanged backups, and hook commands');
    return exitCode;
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    return exitCode || 2;
  } finally {
    if (args.includes('--keep')) console.log(`[ok] Kept temporary homes: ${temp}`);
    else fs.rmSync(temp, { recursive: true, force: true });
  }
}

process.exitCode = main();
