#!/usr/bin/env node
// SessionStart janitor launcher. Never print output or block session startup.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

try {
  const cleaner = path.join(os.homedir(), '.claude', 'scripts', 'luna-clean.mjs');
  const child = spawn(process.execPath, [cleaner], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.on('error', () => {});
  child.unref();
} catch {
  // Fail-safe: janitor failures must never prevent a Claude session.
}
process.exit(0);
