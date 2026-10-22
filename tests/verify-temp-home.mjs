/** Usage: node tests/verify-temp-home.mjs [--keep]. Requires a complete repository payload. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders } from '../install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function runInstaller(home) {
  const result = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'install.mjs'), '--home', home, '--check', '--yes',
    '--codex-build-root', path.join(home, 'codex-build'),
  ], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`[FAIL] ${result.error.message}`);
  return { code: result.status ?? 2, output: result.stdout ?? '' };
}

function verifyHookCommands(home) {
  const claudeHome = path.join(home, '.claude');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'payload/manifest.json'), 'utf8'));
  const fragment = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'payload', manifest.settings), 'utf8'));
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

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--keep')) {
    console.error('[FAIL] Usage: node tests/verify-temp-home.mjs [--keep]');
    return 2;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-harness-verify-'));
  let exitCode = 0;
  console.log(`[ok] Temporary home: ${home}`);
  try {
    const first = runInstaller(home);
    exitCode = first.code;
    if (exitCode !== 0) return exitCode;
    const before = backupFiles(home);
    console.log('[ok] Running installer again to verify idempotency');
    const second = runInstaller(home);
    exitCode = second.code;
    if (exitCode !== 0) return exitCode;
    assert.match(second.output, /Summary: 0 files written; \d+ skipped; 0 backups created\./);
    assert.deepEqual(backupFiles(home), before, 'Second run must not create or alter backups');
    verifyHookCommands(home);
    console.log('[ok] PASS idempotency, unchanged backups, and hook commands present exactly once per event');
    return 0;
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    return exitCode || 2;
  } finally {
    if (args.includes('--keep')) console.log(`[ok] Kept temporary home: ${home}`);
    else fs.rmSync(home, { recursive: true, force: true });
  }
}

process.exitCode = main();
