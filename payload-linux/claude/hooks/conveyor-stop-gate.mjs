#!/usr/bin/env node
// Stop: enforce the first incomplete acceptance/cleanup step, with calibration and a repeated-stop loop guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const { rememberContext, gateStatus, stopOutput } = await import('../scripts/conveyor/lib/ledger.mjs');
  const context = rememberContext(event);
  const output = stopOutput(context, await gateStatus(context), event.stop_hook_active);
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
} catch (error) {
  try {
    const directory = path.join(process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), '.claude'), 'logs');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'conveyor-gate.log'), `${new Date().toISOString()} stop gate: ${error.message}\n`);
  } catch { /* Internal errors always fail open, including logging errors. */ }
}
process.exitCode = 0;
