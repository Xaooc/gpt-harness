#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const state = process.env.FAKE_MLAI_STATE_DIR;
const counter = path.join(state, 'attempts');
const attempt = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(attempt));

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(path.join(state, `prompt-${attempt}.md`), prompt);
writeFileSync(path.join(state, `args-${attempt}.json`), JSON.stringify(process.argv.slice(2)));
writeFileSync(path.join(state, `checkpoints-${attempt}.txt`), process.env.MINI_STEP_CHECKPOINTS ?? 'unset');
writeFileSync(path.join(state, `env-${attempt}.json`), JSON.stringify(Object.fromEntries(['MINI_MLAI_FINAL_GATES',
  'MINI_VERIFY_BASELINE', 'MINI_CHECKER', 'PYTEST_GATE_LAUNCHER', 'PATH'].map((key) => [key, process.env[key] ?? null]))));

const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
send({ type: 'stage', content: 'Loading project context' });

switch (process.env.FAKE_MLAI_SCENARIO) {
  case 'retry': {
    send({ type: 'session', id: `fake-session-${attempt}` });
    send({ type: 'stage', content: 'Starting the agent' });
    send({ type: 'tool', name: 'read_file', target: 'greeting.txt' });
    if (attempt === 1) {
      send({ type: 'result', exitCode: 1, error: 'Transient network error',
        usage: { errorCode: 'connection_interrupted' }, credits: 0.125, changedFiles: [] });
      process.exitCode = 1;
    } else {
      const text = '## Changes\nUpdated greeting.txt.\n\n## Verification\nChecks passed.\n\n' +
        '## Deviations\nNone\n\n## Not done\nNone\n';
      send({ type: 'answer', content: text });
      send({ type: 'result', exitCode: 0, text, credits: 0.25, changedFiles: ['greeting.txt'] });
    }
    break;
  }
  case 'steps': {
    send({ type: 'stage', content: 'Starting the agent' });
    send({ type: 'tool', name: 'edit_file', target: 'greeting.txt' });
    if (attempt === 1) {
      const args = process.argv.slice(2);
      const id = args[args.indexOf('--session-id') + 1];
      mkdirSync(path.join(process.env.MLAI_HOME, 'sessions', id), { recursive: true });
      send({ type: 'result', exitCode: 3, subtype: 'error_max_turns', text: 'Done so far: half.',
        credits: 0.5, changedFiles: ['greeting.txt'] });
      process.exitCode = 3;
    } else {
      const text = 'Changes:\nFinished greeting.txt.\n\nVerification:\nChecks passed.\n\nDeviations:\nNone\n\nNot done:\nNone\n';
      send({ type: 'result', exitCode: 0, text, credits: 0.25, changedFiles: ['greeting.txt'] });
    }
    break;
  }
  case 'auth':
    send({ type: 'result', state: 'error', error: 'Not signed in. Run `mlai login`.', exitCode: 4 });
    process.exitCode = 4;
    break;
  case 'checks': {
    const text = '> **Not verified.** The final checks did not confirm this work. Any claims are unconfirmed.\n\n' +
      'The flow is in rpg_master/x.py:3.';
    send({ type: 'answer', content: text });
    send({ type: 'result', exitCode: 7, subtype: 'error_checks_failed', text, error: 'Some final checks did not pass' });
    process.exitCode = 7;
    break;
  }
  case 'daily':
    send({ type: 'result', state: 'error', code: 'daily_run_limit', error: '[object Object]', exitCode: 1 });
    process.exitCode = 1;
    break;
  default:
    throw new Error(`Unknown fake scenario: ${process.env.FAKE_MLAI_SCENARIO}`);
}
