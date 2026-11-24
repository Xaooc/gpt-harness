#!/usr/bin/env node
// UserPromptSubmit: record genuine prompts, roll over delivered requests, and surface clause hints. Always fail open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const { capturePrompt } = await import('../scripts/conveyor/lib/ledger.mjs');
  const result = await capturePrompt(event);
  if (result?.started || (result?.taskOpen && result.record.clauses.length)) {
    const hints = result.record.clauses.map(({ id, text }) => `${id}: ${text}`).join(', ');
    const started = result.started ? `New request ${result.started.id} started with ${result.record.id}.` : '';
    const additionalContext = [started, hints && `possible requirements: ${hints} — record outcomes with ledger add`]
      .filter(Boolean).join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit', additionalContext
    } }) + '\n');
  }
} catch (error) {
  try {
    const directory = path.join(process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), '.claude'), 'logs');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'conveyor-gate.log'), `${new Date().toISOString()} prompt capture: ${error.message}\n`);
  } catch { /* A prompt must never be blocked, even when logging fails. */ }
}
process.exitCode = 0;
