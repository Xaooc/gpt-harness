#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionContext, loadLedger, startTask, addItem, linkSource, addEvidence, markDone, waive,
  checklist, gateStatus, gateMode, registerTemporary, amendItem, markPending, resolvePending
} from './lib/ledger.mjs';
import { deliver } from './lib/delivery.mjs';

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
    start: ['--note'], add: ['--from', '--paths'], amend: ['--from', '--paths'], pending: ['--reason', '--resolve', '--result'],
    link: ['--reason'], evidence: ['--cmd', '--rc', '--file', '--artifact', '--check', '--note', '--owner-message'],
    done: [], waive: ['--quote'], deliver: [], crosscheck: [], checklist: [], show: ['--json'], status: ['--json'], tmp: []
  };
  if (!Object.hasOwn(allowed, command)) {
    throw new Error('usage: ledger start|add|amend|pending|link|evidence|done|waive|deliver|checklist|show|status|tmp');
  }
  for (const flag of Object.keys(flags)) {
    if (flag !== '--session' && !allowed[command].includes(flag)) throw new Error(`unknown option: ${flag}`);
  }
  const arity = (count) => { if (values.length !== count) throw new Error(`${command} requires ${count} arguments`); };
  const files = flags['--paths']?.split(',').map((file) => file.trim()).filter(Boolean);
  if (files && !files.length) throw new Error('--paths requires at least one file');
  if (command === 'start') {
    arity(0);
    const state = await startTask(context, flags['--note']);
    print(`${state.task.id}: requirements playback\n` + state.messages.map((message) => {
      return `${message.id}: ${message.text}\n${message.clauses.map((clause) => `- ${clause.id}: ${clause.text}`).join('\n')}`;
    }).join('\n') + '\nRecord the request outcomes with ledger add.');
  } else if (command === 'add') {
    arity(1);
    print(await addItem(context, values[0], (flags['--from'] || '').split(/[\s,]+/).filter(Boolean), files));
  } else if (command === 'amend') {
    arity(2);
    if (!flags['--from']) throw new Error('amend requires --from');
    await amendItem(context, values[0], flags['--from'], values[1], files);
  } else if (command === 'pending') {
    arity(1);
    const reason = flags['--reason'], source = flags['--resolve'], result = flags['--result'];
    if (reason && !source && !result) await markPending(context, values[0], reason);
    else if (!reason && source && result) {
      const successor = await resolvePending(context, values[0], source, result);
      if (successor) print(successor);
    } else throw new Error('pending requires --reason or --resolve with --result');
  } else if (command === 'link') {
    arity(2);
    await linkSource(context, values[0], values[1], flags['--reason']);
  } else if (command === 'evidence') {
    arity(1);
    const options = ['--cmd', '--file', '--artifact', '--check', '--note', '--owner-message'];
    const choices = options.filter((flag) => flags[flag] !== undefined);
    if (choices.length !== 1) throw new Error('evidence requires exactly one of ' + options.join(', '));
    if (flags['--rc'] !== undefined && (choices[0] !== '--cmd' || !/^\d+$/.test(flags['--rc']))) {
      throw new Error('--rc requires --cmd and a non-negative integer');
    }
    const kind = choices[0] === '--cmd' ? 'command' : choices[0].slice(2);
    return addEvidence(context, values[0], kind, flags[choices[0]], Number(flags['--rc'] || 0));
  } else if (command === 'done') {
    arity(1);
    await markDone(context, values[0]);
  } else if (command === 'waive') {
    // A delivery waiver is scoped to the current unavailable review.
    arity(1);
    if (!flags['--quote']) throw new Error('waive requires --quote');
    const result = await waive(context, values[0], flags['--quote']);
    print(result);
    return result.verified ? 0 : 1;
  } else if (command === 'deliver' || command === 'crosscheck') {
    arity(0);
    const result = await deliver(context);
    print(result);
    if (result.reviewGap) print('Delivery review gap: independent review was unavailable. Mention this in the final message.');
    return result.delivered ? 0 : 1;
  } else if (command === 'checklist') {
    arity(0);
    print(checklist(await loadLedger(context)));
  } else if (command === 'show') {
    arity(0);
    const state = await loadLedger(context);
    const outcomes = checklist(state, { showRevision: true });
    const findings = state.findings.filter(({ id }) => !state.links[id]).map(({ id, kind, text }) => `- ${id} ${kind}: ${text}`);
    const hints = state.hints.map(({ id, text }) => `- ${id}: ${text}`);
    print(flags['--json'] ? state : [state.task?.id || 'no task', outcomes,
      ...(hints.length ? ['Unlinked clause hints', ...hints] : []),
      ...(findings.length ? ['Unanswered review findings', ...findings] : [])].filter(Boolean).join('\n'));
  } else if (command === 'status') {
    arity(0);
    const result = await gateStatus(context);
    print({ ...result, mode: gateMode(context.session) });
    return result.ok ? 0 : 1;
  } else if (command === 'tmp') {
    arity(2);
    if (values[0] !== 'register') throw new Error('usage: ledger tmp register <path>');
    await registerTemporary(context, values[1]);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`ledger: ${error.message}\n`); process.exitCode = 1; }
}
