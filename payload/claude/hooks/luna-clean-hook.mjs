#!/usr/bin/env node
// SessionStart janitor launcher. Never print output or block session startup.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function launch(script, args = [], env = process.env) {
  try {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Fail-safe: maintenance failures must never prevent a Claude session.
  }
}

function hourly(directory, name, script, args) {
  const hour = 60 * 60 * 1000;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = (sequence) => path.join(directory, `${name}.${sequence}.stamp`);
    const sequences = fs.readdirSync(directory).filter(file => file.startsWith(`${name}.`) && file.endsWith('.stamp'))
      .map(file => Number(file.split('.')[1])).filter(Number.isSafeInteger);
    const previous = Math.max(0, ...sequences);
    if (previous && Date.now() - fs.statSync(stamp(previous)).mtimeMs < hour) return;
    // Concurrent hooks claim the same next timestamp with exclusive creation.
    fs.writeFileSync(stamp(previous + 1), '', { flag: 'wx', mode: 0o600 });
    if (previous) fs.rmSync(stamp(previous), { force: true });
    // The detached helper owns its CLI probes and waits for tree cleanup at its deadline.
    launch(script, args, { ...process.env, LUNA_SESSION_MAINTENANCE: '1' });
  } catch {
    // Another session may have claimed or replaced the timestamp.
  }
}

try {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const scripts = path.join(home, 'scripts');
  launch(path.join(scripts, 'luna-clean.mjs'));
  const patcher = path.join(scripts, 'luna-harness-plugin-patch.mjs');
  if (fs.existsSync(patcher)) launch(patcher);
  const directory = path.join(process.env.LUNA_RUN_DIR || path.join(home, 'luna-run'), 'collector');
  hourly(directory, 'catalog-refresh', path.join(scripts, 'conveyor', 'exec.mjs'),
    ['catalog', 'refresh', '--provider', 'all', '--actor', 'panel']);
  hourly(directory, 'cli-status', path.join(scripts, 'conveyor', 'cli-update.mjs'), ['status', '--json']);
} catch {
  // Keep the hook silent even when the home cannot be inspected.
}

process.exit(0);
