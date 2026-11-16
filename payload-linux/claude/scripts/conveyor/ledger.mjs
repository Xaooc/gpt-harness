#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionContext, loadLedger, startTask, addItem, linkSource, addEvidence, markDone, waive,
  crosscheck, checklist, gateStatus, gateMode, registerTemporary
} from './lib/ledger.mjs';

function argumentsOf(args) {
  const flags = {}, positional = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    if (Object.hasOwn(flags, argument)) throw new Error(`duplicate option: ${argument}`);
    if (argument === '--json') flags[argument] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${argument} requires a value`);
      flags[argument] = args[++index];
    }
  }
  return { flags, positional };
}

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

export async function main(args = process.argv.slice(2)) {
  const { flags, positional } = argumentsOf(args);
  const [command, ...values] = positional;
  const context = sessionContext(flags['--session'] || process.env.CLAUDE_CODE_SESSION_ID);
  const allowed = {
    start: ['--note'], add: ['--from'], link: ['--reason'], evidence: ['--cmd', '--rc', '--file', '--artifact', '--check', '--note'],
    done: [], waive: ['--quote'], crosscheck: [], checklist: [], show: ['--json'], status: ['--json'], tmp: []
  };
  if (!Object.hasOwn(allowed, command)) {
    throw new Error('usage: ledger start|add|link|evidence|done|waive|crosscheck|checklist|show|status|tmp');
  }
  for (const flag of Object.keys(flags)) {
    if (flag !== '--session' && !allowed[command].includes(flag)) throw new Error(`unknown option: ${flag}`);
  }
  const arity = (count) => { if (values.length !== count) throw new Error(`${command} requires ${count} arguments`); };
  if (command === 'start') {
    arity(0);
    const state = startTask(context, flags['--note']);
    print(`${state.task.id}: requirements playback\n` + state.messages.map((message) => {
      return `${message.id}: ${message.text}\n${message.clauses.map((clause) => `- ${clause.id}: ${clause.text}`).join('\n')}`;
    }).join('\n') + '\nLink every clause, then include ledger checklist in the final message.');
  } else if (command === 'add') {
    arity(1);
    print(addItem(context, values[0], (flags['--from'] || '').split(/[\s,]+/).filter(Boolean)));
  } else if (command === 'link') {
    arity(2);
    linkSource(context, values[0], values[1], flags['--reason']);
  } else if (command === 'evidence') {
    arity(1);
    const choices = ['--cmd', '--file', '--artifact', '--check', '--note'].filter((flag) => flags[flag] !== undefined);
    if (choices.length !== 1) throw new Error('evidence requires exactly one of --cmd, --file, --artifact, --check, --note');
    if (flags['--rc'] !== undefined && (choices[0] !== '--cmd' || !/^\d+$/.test(flags['--rc']))) {
      throw new Error('--rc requires --cmd and a non-negative integer');
    }
    const kind = choices[0] === '--cmd' ? 'command' : choices[0].slice(2);
    return addEvidence(context, values[0], kind, flags[choices[0]], Number(flags['--rc'] || 0));
  } else if (command === 'done') {
    arity(1);
    markDone(context, values[0]);
  } else if (command === 'waive') {
    arity(1);
    if (!flags['--quote']) throw new Error('waive requires --quote');
    const result = waive(context, values[0], flags['--quote']);
    print(result);
    return result.verified ? 0 : 1;
  } else if (command === 'crosscheck') {
    arity(0);
    const result = await crosscheck(context);
    print(result);
    return result.ok === false ? 1 : 0;
  } else if (command === 'checklist') {
    arity(0);
    print(checklist(loadLedger(context)));
  } else if (command === 'show') {
    arity(0);
    const state = loadLedger(context);
    print(flags['--json'] ? state : `${state.task?.id || 'no task'}\n${checklist(state)}`);
  } else if (command === 'status') {
    arity(0);
    const result = await gateStatus(context);
    print({ ...result, mode: gateMode(context.session) });
    return result.ok ? 0 : 1;
  } else if (command === 'tmp') {
    arity(2);
    if (values[0] !== 'register') throw new Error('usage: ledger tmp register <path>');
    registerTemporary(context, values[1]);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`ledger: ${error.message}\n`); process.exitCode = 1; }
}
