#!/usr/bin/env node
// SessionStart janitor launcher. Never print output or block session startup.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function launch(script) {
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Fail-safe: maintenance failures must never prevent a Claude session.
  }
}

try {
  const scripts = path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'scripts');
  launch(path.join(scripts, 'luna-clean.mjs'));
  const patcher = path.join(scripts, 'luna-harness-plugin-patch.mjs');
  if (fs.existsSync(patcher)) launch(patcher);
} catch {
  // Keep the hook silent even when the home cannot be inspected.
}

process.exit(0);
