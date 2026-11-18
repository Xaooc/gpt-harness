#!/usr/bin/env node
// UserPromptSubmit: record genuine prompts and remind the model about new requirement clauses. Always fail open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const { capturePrompt } = await import('../scripts/conveyor/lib/ledger.mjs');
  const result = await capturePrompt(event);
  if (result?.taskOpen && result.record.clauses.length) {
    const ids = result.record.clauses.map((clause) => clause.id).join(', ');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit', additionalContext: `new requirements: ${ids}: link them in the ledger`
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
