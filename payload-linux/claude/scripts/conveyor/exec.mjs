#!/usr/bin/env node
// Local tier dispatcher. Claude entries are returned to the orchestrator as exit-code-4 handoffs.
import * as fs from 'node:fs/promises';
import { readFileSync, statSync, watch, constants } from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  loadConfig, saveConfig, providerState, resolveChain, resolvePanel, markUnavailable,
  recordSwitch, renderRoles, wrapperPath, writeJsonAtomic, paths
} from './lib/orchestration.mjs';

// Matches luna.sh's retryable_model_error deny pattern, including usage, auth and invalid-model failures.
const quotaError = new RegExp([
  String.raw`usage limit|quota|insufficient|billing|unauthorized|forbidden|\b40[0134]\b|"status":\s*4\d\d`,
  'model_not_found|not supported|invalid|context window|context_length|too long'
].join('|'), 'i');
const unavailableReasons = ['quota', 'region', 'auth', 'start'];
const execute = promisify(execFile);

function options(args, allowed) {
  const result = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown option: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option: ${key}`);
    if (allowed[key]) {
      if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error(`${key} requires a value`);
      result[key] = args[++index];
    } else result[key] = true;
  }
  return result;
}

function required(opts, names) {
  for (const name of names) if (!opts[name]) throw new Error(`${name} is required`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonPath(value) {
  const parts = value.replace(/^\$\./, '').split('.');
  if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error('json-path must be a dotted path of keys or array indexes');
  }
  return parts;
}

function valueAt(config, parts) {
  let value = config;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      throw new Error(`unknown json-path: ${parts.join('.')}`);
    }
    value = value[part];
  }
  return value;
}

function actorArguments(args) {
  const rest = [...args];
  let actor = 'cli';
  const index = rest.indexOf('--actor');
  if (index >= 0) {
    actor = rest[index + 1];
    rest.splice(index, 2);
    if (!['cli', 'panel'].includes(actor)) throw new Error('--actor must be cli or panel');
    if (rest.includes('--actor')) throw new Error('duplicate option: --actor');
  }
  return { actor, args: rest };
}

async function saveResult(config, previous, actor, note) {
  const changed = !isDeepStrictEqual(previous, config);
  await saveConfig(config, { actor, note });
  process.stdout.write(`${JSON.stringify({ ok: true, changed, note })}\n`);
  return 0;
}

function entryOptions(opts) {
  required(opts, ['--provider', '--model', '--effort']);
  return { provider: opts['--provider'], model: opts['--model'], effort: opts['--effort'] };
}

function chainFor(config, opts, allowPanel = false) {
  if (opts['--tier'] && opts['--panel']) throw new Error('choose one of --tier or --panel');
  const panel = allowPanel && opts['--panel'];
  const name = panel || opts['--tier'];
  if (!name) throw new Error(allowPanel ? '--tier or --panel is required' : '--tier is required');
  const chains = panel ? config.panels : config.tiers;
  if (!Object.hasOwn(chains, name)) throw new Error(`unknown ${panel ? 'panel' : 'tier'}: ${name}`);
  return chains[name];
}

function entryIndex(value, max, label) {
  if (!/^(0|[1-9]\d*)$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new Error(`${label} must be a zero-based index between 0 and ${max}`);
  }
  return Number(value);
}

async function undoTarget() {
  let journal;
  try { journal = await fs.readFile(paths().journal, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('nothing to undo'); throw error; }
  const applying = new Map(), history = [];
  for (const line of journal.split(/\r?\n/).filter((value) => value.trim())) {
    const entry = JSON.parse(line);
    if (!entry || typeof entry.id !== 'string') continue;
    if (entry.status === 'applying') applying.set(entry.id, entry);
    if (entry.status !== 'applied') continue;
    const change = applying.get(entry.id);
    if (!change) continue;
    const undone = typeof change.note === 'string' && /^undo (.+)$/.exec(change.note);
    if (undone) {
      const index = history.findIndex((candidate) => candidate.id === undone[1]);
      if (index >= 0) history.splice(index, 1);
    } else if (change.before && change.diff && Object.keys(change.diff).length) history.push(change);
  }
  if (!history.length) throw new Error('nothing to undo');
  return history.at(-1);
}

async function configCommand(args) {
  const parsed = actorArguments(args), actor = parsed.actor;
  const [action, ...rest] = parsed.args;
  const config = await loadConfig(), previous = structuredClone(config);
  if (action === 'get' && rest.length <= 1) {
    print(rest.length ? valueAt(config, jsonPath(rest[0])) : config);
    return 0;
  }
  if (action === 'validate' && !rest.length) {
    process.stdout.write('valid\n');
    return 0;
  }
  let note;
  if (action === 'set' && rest.length === 2) {
    const [key, raw] = rest;
    const parts = jsonPath(key);
    const parent = parts.length === 1 ? config : valueAt(config, parts.slice(0, -1));
    if (!parent || typeof parent !== 'object') throw new Error('json-path parent must be an object or array');
    const last = parts.at(-1);
    if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(last) || Number(last) > parent.length)) {
      throw new Error('json-path array index must address an entry or append one');
    }
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new Error('config set value must be valid JSON (quote string values)'); }
    Object.defineProperty(parent, last, { value, enumerable: true, configurable: true, writable: true });
    await saveConfig(config, { actor, note: `set ${key}` });
    print(config);
    return 0;
  } else if (action === 'preset' && rest.length === 1) {
    const [name] = rest;
    if (!Object.hasOwn(config.presets, name)) throw new Error(`unknown preset: ${name}`);
    for (const [tier, chain] of Object.entries(config.presets[name].tiers)) {
      config.tiers[tier] = structuredClone(chain);
    }
    note = `preset ${name}`;
  } else if (action === 'save-preset') {
    const opts = options(rest, { '--name': true, '--label': true });
    required(opts, ['--name', '--label']);
    const name = opts['--name'];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('--name must be a lowercase slug');
    config.presets[name] = { label: opts['--label'], tiers: structuredClone(config.tiers) };
    note = `save-preset ${name}`;
  } else if (action === 'threshold') {
    const opts = options(rest, { '--percent': true, '--hysteresis': true });
    required(opts, ['--percent']);
    for (const [flag, key] of [['--percent', 'switch_percent'], ['--hysteresis', 'hysteresis_percent']]) {
      if (opts[flag] !== undefined) {
        if (!/^\d+(?:\.\d+)?$/.test(opts[flag])) throw new Error(`${flag} must be a decimal number`);
        config.thresholds.codex[key] = Number(opts[flag]);
      }
    }
    note = 'threshold';
  } else if (action === 'undo' && !rest.length) {
    const target = await undoTarget();
    return saveResult(target.before, previous, actor, `undo ${target.id}`);
  } else if (['set-entry', 'add-entry', 'remove-entry', 'move-entry'].includes(action)) {
    const allowed = { '--tier': true };
    if (action === 'set-entry') Object.assign(allowed, { '--panel': true, '--seat': true });
    if (action !== 'add-entry') allowed['--index'] = true;
    if (action === 'set-entry' || action === 'add-entry') {
      Object.assign(allowed, { '--provider': true, '--model': true, '--effort': true });
    }
    if (action === 'add-entry') allowed['--at'] = true;
    if (action === 'move-entry') allowed['--to'] = true;
    const opts = options(rest, allowed), chain = chainFor(config, opts, action === 'set-entry');
    const panel = Boolean(opts['--panel']);
    const flag = panel ? '--seat' : '--index';
    if (opts[panel ? '--index' : '--seat'] !== undefined) throw new Error(`use ${flag} for this target`);
    if (action === 'add-entry') {
      const at = opts['--at'] === undefined ? chain.length : entryIndex(opts['--at'], chain.length, '--at');
      chain.splice(at, 0, entryOptions(opts));
    } else {
      const index = entryIndex(opts[flag], chain.length - 1, flag);
      if (action === 'set-entry') chain[index] = entryOptions(opts);
      else if (action === 'remove-entry') {
        if (chain.length === 1) throw new Error('cannot remove the last entry in a chain');
        chain.splice(index, 1);
      } else {
        const to = entryIndex(opts['--to'], chain.length - 1, '--to');
        chain.splice(to, 0, chain.splice(index, 1)[0]);
      }
    }
    note = `${action} ${panel ? 'panel' : 'tier'} ${opts['--panel'] || opts['--tier']}`;
  } else throw new Error('usage: exec.mjs config get | set | set-entry | add-entry | remove-entry | move-entry | ' +
    'threshold | preset | save-preset | undo | validate');
  return saveResult(config, previous, actor, note);
}

async function catalogCommand(args) {
  const parsed = actorArguments(args), actor = parsed.actor;
  const [action, ...rest] = parsed.args;
  const allowed = { '--provider': true };
  if (action === 'add' || action === 'remove') allowed['--model'] = true;
  if (action === 'add') allowed['--efforts'] = true;
  if (!['add', 'remove', 'refresh'].includes(action)) throw new Error('usage: exec.mjs catalog add | remove | refresh');
  const opts = options(rest, allowed);
  required(opts, ['--provider']);
  const provider = opts['--provider'];
  const config = await loadConfig(), previous = structuredClone(config);
  if (!Object.hasOwn(config.catalog, provider)) throw new Error(`unknown provider: ${provider}`);
  const catalog = config.catalog[provider];
  let note;
  if (action === 'refresh') {
    if (provider !== 'gemini') throw new Error('catalog refresh requires --provider gemini');
    let command = ['/srv/docker/compose/antigravity-parallel/run-agy', 'models'];
    if (process.env.CONVEYOR_AGY_MODELS_CMD !== undefined) {
      try { command = JSON.parse(process.env.CONVEYOR_AGY_MODELS_CMD); }
      catch { throw new Error('CONVEYOR_AGY_MODELS_CMD must be JSON argv'); }
    }
    if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('CONVEYOR_AGY_MODELS_CMD must be non-empty JSON argv');
    }
    const { stdout } = await execute(command[0], command.slice(1), {
      encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    });
    const added = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^(gemini-[^\s]+)\t[^\t]+$/.exec(line);
      if (!match) continue;
      const model = match[1].replace(/-(low|medium|high)$/, '');
      if (catalog.some((entry) => entry.model === model)) continue;
      catalog.push({ model, efforts: ['low', 'medium', 'high'] });
      added.push(model);
    }
    note = added.length ? `added ${added.join(', ')}` : 'no models added';
  } else {
    required(opts, action === 'add' ? ['--model', '--efforts'] : ['--model']);
    const model = opts['--model'];
    if (action === 'add') catalog.push({ model, efforts: opts['--efforts'].split(',') });
    else {
      const inUse = [...Object.values(config.tiers), ...Object.values(config.panels)]
        .some((chain) => chain.some((entry) => entry.provider === provider && entry.model === model));
      if (inUse) throw new Error(`model ${provider}/${model} is in use by a tier or panel`);
      const index = catalog.findIndex((entry) => entry.model === model);
      if (index < 0) throw new Error(`unknown model: ${provider}/${model}`);
      catalog.splice(index, 1);
    }
    note = `${action} ${provider}/${model}`;
  }
  return saveResult(config, previous, actor, note);
}

function statusValues(text) {
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !Object.hasOwn(values, line.slice(0, index))) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

function signature(file) {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return null; }
}

function trackStatus(file) {
  const previous = signature(file);
  let values = null;
  let reachedRunning = false;
  const inspect = () => {
    try {
      if (signature(file) === previous) return;
      values = statusValues(readFileSync(file, 'utf8'));
      if (values.state === 'running') reachedRunning = true;
    } catch { /* An atomic status replacement can briefly remove the file. */ }
  };
  // The final state overwrites running; retain every running observation during the foreground job.
  const timer = setInterval(inspect, 1000);
  let watcher;
  try {
    watcher = watch(path.dirname(file), (_event, name) => {
      if (name === null || name.toString() === path.basename(file)) inspect();
    });
    watcher.on('error', () => {});
  } catch { /* Polling remains available on filesystems without watch support. */ }
  return {
    finish() {
      clearInterval(timer);
      watcher?.close();
      inspect();
      return { values, reachedRunning };
    }
  };
}

async function launch(entry, args, dir) {
  const wrapper = wrapperPath(entry.provider);
  try { await fs.access(wrapper, constants.R_OK); }
  catch (error) { return { code: 127, launchError: error.message }; }
  return new Promise((resolve) => {
    const child = spawn('bash', [wrapper, ...args], { cwd: dir, stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    let launchError;
    child.once('error', (error) => { launchError = error.message; });
    child.once('close', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve({ code: code ?? (signal ? 128 + (osConstants.signals[signal] || 1) : 127), signal, launchError });
    });
  });
}

async function archiveAttempt(out, provider) {
  const dir = path.dirname(out), base = path.basename(out);
  const names = await fs.readdir(dir);
  const source = names.filter((name) => name === base || (name.startsWith(`${base}.`) &&
    name !== `${base}.dispatch.json` && !name.startsWith(`${base}.attempt-`)));
  let prefix = `${out}.attempt-${provider}`;
  for (let index = 2; names.some((name) => name.startsWith(`${path.basename(prefix)}.`)); index++) {
    prefix = `${out}.attempt-${provider}-${index}`;
  }
  for (const name of source) {
    const suffix = name === base ? '.out' : name.slice(base.length);
    await fs.rename(path.join(dir, name), `${prefix}${suffix}`);
  }
  return prefix;
}

async function switchProvider(tier, from, to, reason, out) {
  // Keep every switch on one terminal line even when an error contains control characters.
  reason = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  await recordSwitch({ tier, from, to, reason, out });
  process.stderr.write(`conveyor: ${tier}: ${from} → ${to} (${reason})\n`);
}

function failureReason(result, status) {
  if (result.launchError) return { reason: 'start', note: result.launchError };
  if (result.code === 3) {
    const reason = unavailableReasons.includes(status?.unavailable_reason) ? status.unavailable_reason
      : quotaError.test(status?.error || '') ? 'quota' : 'start';
    return { reason, note: status?.error || status?.unavailable_reason || 'wrapper exited 3' };
  }
  if (result.code !== 0 && quotaError.test(status?.error || '')) return { reason: 'quota', note: status.error };
  return null;
}

function targetFor(opts, config) {
  if (opts['--tier'] && opts['--panel']) throw new Error('choose one of --tier or --panel');
  const role = opts['--role'];
  if (role) {
    if (!Object.hasOwn(config.roles, role)) throw new Error(`unknown role: ${role}`);
    const target = config.roles[role], separator = target.indexOf(':');
    return { kind: target.slice(0, separator), name: target.slice(separator + 1) };
  }
  if (opts['--panel']) return { kind: 'panel', name: opts['--panel'] };
  if (opts['--tier']) return { kind: 'tier', name: opts['--tier'] };
  throw new Error('one of --tier, --panel or --role is required');
}

async function runCommand(args) {
  const opts = options(args, {
    '--tier': true, '--panel': true, '--seat': true, '--role': true,
    '-w': false, '-r': false, '-C': true, '-f': true, '-o': true
  });
  required(opts, ['-C', '-f', '-o']);
  if (Boolean(opts['-w']) === Boolean(opts['-r'])) throw new Error('exactly one of -w or -r is required');
  const config = await loadConfig();
  const role = opts['--role'];
  const target = targetFor(opts, config);
  const panel = target.kind === 'panel' ? target.name : null;
  const tier = target.name;
  if (panel) {
    required(opts, ['--seat']);
    if (!/^(0|[1-9]\d*)$/.test(opts['--seat'])) throw new Error('--seat must be a zero-based integer');
  } else if (opts['--seat'] !== undefined) throw new Error('--seat requires a panel');
  const dir = path.resolve(opts['-C']), brief = path.resolve(opts['-f']), out = path.resolve(opts['-o']);
  if (!(await fs.stat(dir)).isDirectory()) throw new Error('-C must be a directory');
  if (!(await fs.stat(brief)).isFile()) throw new Error('-f must be a brief file');
  if (out === brief) throw new Error('brief and output paths must differ');
  const mode = opts['-w'] ? 'write' : 'read';
  let state = await providerState(config);
  const resolve = async () => {
    if (!panel) return resolveChain(tier, { config, state });
    const resolved = await resolvePanel(panel, { config, state });
    const seat = resolved.seats[Number(opts['--seat'])];
    if (!seat) throw new Error(`unknown seat ${opts['--seat']} for panel ${panel}`);
    return { ...resolved, chain: [seat] };
  };
  let resolution = await resolve();
  const dispatch = {
    at: new Date().toISOString(), ...(panel ? { panel, seat: Number(opts['--seat']) } : { tier }),
    ...(role ? { role } : {}), brief, out, mode, dir,
    action: 'resolve', selected: null, chain: resolution.chain, attempts: []
  };
  const saveDispatch = () => writeJsonAtomic(`${out}.dispatch.json`, dispatch);
  let cursor = -1, from = null, failedReason = null;
  while (true) {
    const index = resolution.chain.findIndex((entry, position) => position > cursor && entry.available);
    dispatch.chain = resolution.chain;
    if (index < 0) {
      dispatch.action = 'unavailable';
      dispatch.selected = null;
      dispatch.provider = null;
      dispatch.model = null;
      dispatch.effort = null;
      dispatch.reason = [failedReason, ...resolution.chain.map((entry) => entry.reason)].filter(Boolean).join('; ');
      dispatch.code = 5;
      await saveDispatch();
      process.stderr.write(`conveyor: ${tier}: no provider available: ${dispatch.reason}\n`);
      return 5;
    }
    const entry = resolution.chain[index];
    const skipped = resolution.chain.slice(cursor + 1, index);
    const reason = [failedReason, ...skipped.map((candidate) => candidate.reason)]
      .filter(Boolean).join('; ') || entry.reason;
    Object.assign(dispatch, {
      selected: entry, provider: entry.provider, model: entry.model, effort: entry.effort, reason
    });
    dispatch.action = entry.provider === 'claude' ? 'claude-subagent' : 'run-wrapper';
    dispatch.code = entry.provider === 'claude' ? 4 : null;
    if (entry.provider === 'claude' && state.usage.claude.nearLimit) dispatch.warning = 'claude near limit';
    await saveDispatch();
    if (from || skipped.length) await switchProvider(tier, from || skipped[0].provider, entry.provider, reason, out);
    if (entry.provider === 'claude') {
      print(dispatch);
      return 4;
    }
    const attempt = {
      provider: entry.provider, model: entry.model, effort: entry.effort, at: new Date().toISOString()
    };
    dispatch.attempts.push(attempt);
    await saveDispatch();
    const tracker = trackStatus(`${out}.status`);
    let result, observed;
    try {
      result = await launch(entry, [mode === 'write' ? '-w' : '-r', '-m', entry.model, '-e', entry.effort,
        '-C', dir, '-f', brief, '-o', out], dir);
    } finally { observed = tracker.finish(); }
    const failure = failureReason(result, observed.values);
    Object.assign(attempt, {
      code: result.code, state: observed.values?.state ?? null, error: observed.values?.error ?? null,
      reached_running: observed.reachedRunning
    });
    dispatch.code = result.code;
    if (failure) await markUnavailable(entry.provider, failure.reason, failure.note, { config });
    const retryable = result.code === 3 || (result.code !== 0 && quotaError.test(observed.values?.error || ''));
    if (panel || !retryable || (mode === 'write' && observed.reachedRunning) || result.signal) {
      attempt.retry = false;
      await saveDispatch();
      return result.code;
    }
    attempt.retry = true;
    attempt.reason = `${failure.reason}: ${failure.note}`;
    attempt.archive = await archiveAttempt(out, entry.provider);
    await saveDispatch();
    cursor = index;
    from = entry.provider;
    failedReason = attempt.reason;
    state = await providerState(config);
    resolution = await resolve();
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === 'config') return configCommand(rest);
  if (command === 'catalog') return catalogCommand(rest);
  if (command === 'run') return runCommand(rest);
  if (command === 'roles') {
    if (rest[0] !== 'render') throw new Error('usage: exec.mjs roles render [--out <path>]');
    const opts = options(rest.slice(1), { '--out': true });
    process.stdout.write(`${await renderRoles(opts['--out'])}\n`);
    return 0;
  }
  if (command === 'resolve' || command === 'status') {
    const opts = options(rest, command === 'resolve' ? {
      '--tier': true, '--panel': true, '--role': true, '--json': false, '--first-available': false
    } : { '--json': false });
    const config = await loadConfig();
    const state = await providerState(config);
    if (command === 'resolve') {
      const target = targetFor(opts, config);
      if (opts['--first-available'] && target.kind !== 'panel') {
        throw new Error('--first-available requires a panel');
      }
      const result = target.kind === 'panel'
        ? await resolvePanel(target.name, { config, state, firstAvailable: Boolean(opts['--first-available']) })
        : await resolveChain(target.name, { config, state });
      const entries = result.seats || result.chain;
      if (opts['--json']) print(result);
      else for (const entry of entries) {
        const selected = result.selected === entry ? '*' : ' ';
        const seat = entry.seat === undefined ? '' : `seat ${entry.seat}: `;
        process.stdout.write(`${selected} ${seat}${entry.provider}/${entry.model} ` +
          `(${entry.effort}): ${entry.reason}\n`);
      }
      return entries.some((entry) => entry.available) ? 0 : 5;
    }
    const tiers = Object.create(null), panels = Object.create(null);
    for (const tier of Object.keys(config.tiers)) tiers[tier] = await resolveChain(tier, { config, state });
    for (const panel of Object.keys(config.panels)) panels[panel] = await resolvePanel(panel, { config, state });
    const result = { tiers, panels, providers: state.providers, usage: state.usage };
    if (opts['--json']) print(result);
    else {
      for (const [tier, resolved] of Object.entries(tiers)) {
        process.stdout.write(`${tier}:\n`);
        for (const entry of resolved.chain) {
          const selected = entry === resolved.selected ? '*' : ' ';
          process.stdout.write(`  ${selected} ${entry.provider}/${entry.model} (${entry.effort}): ${entry.reason}\n`);
        }
      }
      for (const [panel, resolved] of Object.entries(panels)) {
        process.stdout.write(`panel ${panel}:\n`);
        for (const entry of resolved.seats) {
          process.stdout.write(`  seat ${entry.seat}: ${entry.provider}/${entry.model} ` +
            `(${entry.effort}): ${entry.reason}\n`);
        }
      }
      process.stdout.write(`providers: ${JSON.stringify(state.providers)}\nusage: ${JSON.stringify(state.usage)}\n`);
    }
    return 0;
  }
  throw new Error('usage: exec.mjs resolve (--tier <tier>|--panel <name>|--role <name>) [--json] ' +
    '[--first-available] | run (--tier <tier>|--panel <name> --seat <n>|--role <name>) ' +
    '(-w|-r) -C <dir> -f <brief> -o <out> | roles render [--out <path>] | status [--json] | config … | catalog …');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`conveyor: ${error.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}\n`);
    process.exitCode = 1;
  });
}
