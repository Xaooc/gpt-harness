#!/usr/bin/env node
// Local tier dispatcher. Claude entries are returned to the orchestrator as exit-code-4 handoffs.
import * as fs from 'node:fs/promises';
import { readFileSync, writeFileSync, rmSync, statSync, watch, constants } from 'node:fs';
import path from 'node:path';
import { constants as osConstants, homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  loadConfig, saveConfig, updateConfig, providerState, resolveChain, resolvePanel, markUnavailable,
  recordSwitch, renderRoles, validateConfig, wrapperPath, writeJsonAtomic, paths
} from './lib/orchestration.mjs';
import { testFile, trimSnapshot, trimViolations } from './lib/hygiene.mjs';
import { hasApproachReviewTiers, ledgerHome, taskApproachReviewRequirement, validReviewSkip } from './lib/ledger.mjs';
import { accountPaths } from './lib/codex-accounts.mjs';
import { bash, platform, processAlive, readProcessStat, scanBinary } from './lib/platform.mjs';
import { run as runSupervised, startMaintenanceWatchdog } from '../lib/supervised-run.mjs';

// Matches luna.sh's retryable_model_error deny pattern, including usage, auth and invalid-model failures.
const quotaError = new RegExp([
  String.raw`usage limit|quota|insufficient|billing|unauthorized|forbidden|\b40[0134]\b|"status":\s*4\d\d`,
  'model_not_found|not supported|invalid|context window|context_length|too long'
].join('|'), 'i');
const unavailableReasons = ['quota', 'region', 'auth', 'start'];
// "Your workspace is out of credits" is what a business seat with a depleted credit pool returns (seen 2026-11-24).
const codexQuotaError = /\busage limit\b|\bquota\b|\binsufficient_quota\b|\brate[ _]limit[ _]reached\b|\bout of credits\b|\bcredits[ _]depleted\b/i;
const codexAuthError = /\b(?:unauthorized|forbidden|401|403|not logged in|login|token expired)\b/i;
const execute = promisify(execFile);
const gitOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
export const gateInstruction = 'Fix the root cause in the code. Do not weaken, skip or delete checks, ' +
  'tests, lint rules or hygiene counters. Do not revert the requested change.';
const testBudgetInstruction = 'Keep only tests that protect against lost work, lost data, broken production, money or security, ' +
  'and delete the other tests you added. Only delete lines: do not rewrite or add test code, do not delete tests that existed ' +
  'before this job, and do not touch any file other than the tests you added.';

async function git(repo, args) {
  const { stdout } = await execute('git', ['-C', repo, ...args], gitOptions);
  return stdout;
}

function writeOwnerAlive(owner) {
  if (!processAlive(owner?.pid)) return false;
  const start = readProcessStat(owner.pid)?.started;
  return start === undefined || owner.start === null || start === String(owner.start);
}

async function writeLockState(lock) {
  let stat;
  try { stat = await fs.stat(lock); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let owner = null;
  try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
  catch {}
  const valid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
  return { stat, owner, stale: valid ? !writeOwnerAlive(owner) : Date.now() - stat.mtimeMs > 60_000 };
}

async function reclaimWriteLock(lock, state, owner) {
  // Live reclaimers advertise themselves before inspecting each other. Only one may remove the old directory.
  const marker = path.join(lock, `.reclaim-${randomUUID()}`), stale = `${lock}.${randomUUID()}.stale`;
  try {
    try { await fs.writeFile(marker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const current = await writeLockState(lock);
    if (!current || current.stat.ino !== state.stat.ino || current.stat.dev !== state.stat.dev) return;
    if (current.owner?.pid ? writeOwnerAlive(current.owner) : !state.stale) return;
    for (const name of await fs.readdir(lock)) {
      if (!name.startsWith('.reclaim-') || name === path.basename(marker)) continue;
      let other;
      try { other = JSON.parse(await fs.readFile(path.join(lock, name), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        try { if (Date.now() - (await fs.stat(path.join(lock, name))).mtimeMs > 60_000) continue; }
        catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
        return;
      }
      if (writeOwnerAlive(other)) return;
    }
    const checked = await writeLockState(lock);
    if (!checked || checked.stat.ino !== state.stat.ino || checked.stat.dev !== state.stat.dev) return;
    if (writeOwnerAlive(checked.owner)) return;
    await fs.rename(lock, stale);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await fs.rm(marker, { force: true });
    await fs.rm(stale, { recursive: true, force: true });
  }
}

async function acquireWriteLock(dir, out, brief) {
  let key;
  try { key = (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (error) { if (error.code !== 128) throw error; key = await fs.realpath(dir); }
  const lock = path.join(paths().home, 'write-locks', createHash('sha256').update(key).digest('hex').slice(0, 16));
  const owner = {
    pid: process.pid, start: readProcessStat(process.pid)?.started ?? null, key, out, brief,
    session: process.env.CLAUDE_CODE_SESSION_ID || null, at: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.mkdir(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const state = await writeLockState(lock);
      if (attempt === 0 && (!state || state.stale)) {
        if (state) await reclaimWriteLock(lock, state, owner);
        continue;
      }
      return { key, owner: state?.owner ?? null };
    }
    const file = path.join(lock, 'owner.json');
    try { writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
    const release = () => {
      let current;
      try { current = JSON.parse(readFileSync(file, 'utf8')); }
      catch { return; }
      if (current.pid === owner.pid && current.start === owner.start && current.at === owner.at) {
        rmSync(lock, { recursive: true, force: true });
      }
    };
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
      const handler = () => { release(); process.exit(128 + osConstants.signals[signal]); };
      process.on(signal, handler);
      return [signal, handler];
    });
    return { release() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      release();
    } };
  }
}

export async function gateRepository(dir) {
  try {
    const repo = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return { repo, base: (await git(repo, ['rev-parse', 'HEAD'])).trim() };
  } catch (error) {
    if (error.code !== 128) throw error;
    return { repo: dir, base: null };
  }
}

async function workingFiles(repo) {
  const tracked = await git(repo, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))];
}

export async function gateChangedFiles(repo, base, preExisting = []) {
  const previous = new Set(preExisting);
  const working = (await workingFiles(repo)).filter((file) => !previous.has(file));
  const committed = await git(repo, ['log', '--format=', '--name-only', '--no-renames', '-m', '-z', `${base}..HEAD`, '--']);
  return [...new Set([...working, ...committed.split('\0').filter(Boolean)])].sort();
}

export async function gateMode(repo) {
  let profile;
  try { profile = JSON.parse(await fs.readFile(path.join(repo, '.claude', 'conveyor.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 'block'; throw error; }
  const mode = profile.gate?.mode ?? 'block';
  if (!['block', 'warn', 'off'].includes(mode)) throw new Error('gate.mode must be block, warn or off');
  return mode;
}

export function gateSessionFile(session) {
  return path.join(ledgerHome(), 'sessions', `${encodeURIComponent(session)}.jsonl`);
}

export function failedCheck(result) {
  return (typeof result.rc === 'number' && result.rc !== 0) || /^(fail|failed|error|timeout)$/.test(result.status);
}

export function budgetOnlyFailure(last) {
  return !last.ok && last.tests?.ok === false && last.hygiene.ok &&
    last.results.every((result) => ['pass', 'skipped'].includes(result.status) && !failedCheck(result));
}

export function gateDetails(last, failuresOnly = false) {
  const lines = [];
  for (const result of last.results || []) {
    if (failuresOnly && !failedCheck(result)) continue;
    lines.push(`- ${result.name}: ${result.status} (${result.durationMs ?? 0} ms)`);
    if (failedCheck(result)) lines.push(`  cmd: ${JSON.stringify(result.cmd)}\n\n${result.outputTail || ''}`);
  }
  for (const item of last.hygiene?.grew || []) {
    lines.push(`- hygiene: ${item.file} ${item.counter}: ${item.before} → ${item.after}`);
  }
  if (last.tests && (!failuresOnly || !last.tests.ok)) {
    const { added, budget, ok, files } = last.tests;
    lines.push(`- test budget: added ${added} new test cases, budget ${budget} — ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) {
      for (const { file, before, after } of files) lines.push(`  ${file}: ${before} → ${after}`);
      const prefix = budgetOnlyFailure(last) ? '' : 'When the test budget is the only failure, follow this rule. ';
      lines.push(`\n${prefix}${testBudgetInstruction}`);
    }
  }
  return lines.join('\n') || (last.ok ? 'No checks selected.' : 'Checks failed; no failure details were returned.');
}

export async function runGateChecks(repo, base, files, { testBudget = 'profile' } = {}) {
  const last = { ok: true, repo, base, changed: files, results: [], hygiene: { ok: true, grew: [] } };
  if (!files.length) return last;
  let command;
  try {
    command = process.env.CONVEYOR_CHECK_CMD === undefined
      ? [process.execPath, fileURLToPath(new URL('./check.mjs', import.meta.url))]
      : JSON.parse(process.env.CONVEYOR_CHECK_CMD);
    if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('CONVEYOR_CHECK_CMD must be non-empty JSON argv');
    }
  } catch (error) {
    last.ok = false;
    last.configError = error.message;
    return last;
  }
  for (const level of ['fast', 'turn']) {
    const args = [...command.slice(1), 'run', '--dir', repo, '--level', level, '--base', base,
      '--files', files.join(','), '--json'];
    if (level === 'turn') args.push('--test-budget', String(testBudget));
    let stdout, stderr = '', code = 0;
    try {
      ({ stdout, stderr } = await execute(command[0], args, {
        encoding: 'utf8', cwd: repo, timeout: 300_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024
      }));
    } catch (error) {
      if (![1, 2].includes(error.code)) throw error;
      ({ stdout, stderr, code } = error);
    }
    if (code === 2) {
      last.configError = (stdout || stderr || 'check exited 2').trim();
      last.ok = false;
      return last;
    }
    const report = JSON.parse(stdout);
    if (typeof report.ok !== 'boolean' || !Array.isArray(report.results) || typeof report.hygiene?.ok !== 'boolean') {
      throw new Error('check returned invalid JSON report');
    }
    if (level === 'turn' && report.tests) last.tests = report.tests;
    last.ok &&= code === 0 && report.ok && report.hygiene.ok && (last.tests?.ok ?? true) && !report.results.some(failedCheck);
    last.results.push(...report.results);
    last.hygiene.ok &&= report.hygiene.ok;
    for (const item of report.hygiene.grew || []) {
      if (!last.hygiene.grew.some((previous) => isDeepStrictEqual(previous, item))) last.hygiene.grew.push(item);
    }
  }
  return last;
}

function checkConfiguration(file) {
  const name = path.posix.basename(file);
  return /^(\.eslintrc.*|eslint\.config\..*|tsconfig.*\.json|vitest\.config\..*|jest\.config\..*|pytest\.ini)$/.test(name) ||
    /(^|\/)(\.claude\/conveyor\.json|\.conveyor\/hygiene-baseline\.json)$/.test(file);
}

function pythonCheckSections(text) {
  let selected = false;
  return text.split(/\r?\n/).filter((line) => {
    if (/^\s*\[/.test(line)) selected = /^\s*\[\[?tool\.(ruff|mypy)(\.|\])/.test(line);
    return selected;
  }).join('\n');
}

export async function protectedFiles(repo) {
  const files = (await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0');
  const snapshot = new Map();
  for (const file of new Set(files.filter(Boolean))) {
    const config = checkConfiguration(file), python = path.posix.basename(file) === 'pyproject.toml';
    if (!config && !python && !testFile(file)) continue;
    try {
      const content = await fs.readFile(path.join(repo, file));
      const protectedContent = python && !testFile(file) ? pythonCheckSections(content.toString()) : content;
      if (!python || protectedContent || testFile(file)) {
        snapshot.set(file, createHash('sha256').update(protectedContent).digest('hex'));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return snapshot;
}

export function modifiedTests(before, after, includeAdded = false) {
  const files = includeAdded ? new Set([...before.keys(), ...after.keys()]) : before.keys();
  return [...files].filter((file) => testFile(file) && before.get(file) !== after.get(file)).sort();
}

async function prepareGate(dir, brief, out, tier, panel, skip, reviewSkip) {
  const gate = { ...await gateRepository(dir), mode: 'off', preExisting: [] };
  try { gate.mode = panel || skip ? 'off' : await gateMode(gate.repo); }
  catch (error) { gate.mode = 'block'; gate.configError = error.message; }
  if (gate.base && gate.mode !== 'off') gate.preExisting = await workingFiles(gate.repo);
  gate.brief = await fs.readFile(brief, 'utf8');
  const budget = Number(gate.brief.match(/^Test budget:\s*(\d{1,3})\s*$/mi)?.[1]);
  if (budget <= 100) gate.testBudget = budget;
  await appendRunRecord({
    at: new Date().toISOString(), session: process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
    repo: gate.repo, base: gate.base, out, tier, ...(panel ? { panel } : {}), mode: gate.mode,
    ...(reviewSkip === undefined ? {} : { reviewSkip })
  });
  return gate;
}

async function appendRunRecord(record) {
  try {
    const file = gateSessionFile(record.session);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`conveyor: could not append run index: ${error.message}\n`);
  }
}

async function finishGate(gate, dispatch, entry, dir, out, account) {
  if (!gate || gate.mode === 'off') return 0;
  const append = (text) => fs.appendFile(out, `${text}\n`);
  const report = async (text) => {
    const failed = dispatch.gate.status === 'fail';
    if (failed) {
      const repo = `'${gate.repo.replaceAll("'", "'\\''")}'`;
      text += '\n\n## Approach review\n'
        + 'The checks stayed red after the fix rounds. Before another attempt, ask for an approach review:\n'
        + `node ~/.claude/scripts/conveyor/exec.mjs run --tier architect -r -C ${repo} -f <brief.md> -o <out.md>\n`
        + '(brief: the goal and why, what was tried, the failing output, one question: what is the better approach?)';
    }
    await append(text);
    return failed ? 6 : 0;
  };
  if (!gate.base) {
    dispatch.gate = { status: 'skipped', reason: 'not a git repository with HEAD' };
    await append(`\n## Gate\n\nskipped: ${dispatch.gate.reason}`);
    return 0;
  }
  let rounds = 0, last;
  const configError = async (message) => {
    dispatch.gate = { status: 'config error', rounds, last, message };
    await append(`\n## Gate: config error\n\n${message}`);
    return 0;
  };
  try {
    if (gate.configError) return await configError(gate.configError);
    const raw = process.env.CONVEYOR_GATE_ROUNDS ?? '2';
    if (!/^[0-2]$/.test(raw)) return await configError('CONVEYOR_GATE_ROUNDS must be 0, 1 or 2');
    const limit = Number(raw);
    const checkOptions = { testBudget: gate.testBudget };
    let files = await gateChangedFiles(gate.repo, gate.base, gate.preExisting);
    if (!files.length) return 0;
    await append('\n## Gate\n');
    last = await runGateChecks(gate.repo, gate.base, files, checkOptions);
    while (true) {
      if (last.configError) return await configError(last.configError);
      await append(`Round ${rounds}: ${last.ok ? 'pass' : 'fail'}\n\n${gateDetails(last)}`);
      if (last.ok || gate.mode === 'warn' || rounds === limit) break;
      const budgetOnly = budgetOnlyFailure(last);
      const trim = budgetOnly ? await trimSnapshot(gate.repo, files) : null;
      const before = await protectedFiles(gate.repo);
      rounds++;
      const brief = `${out}.gate-${rounds}.brief.md`, fixOut = `${out}.gate-${rounds}.out.md`;
      await fs.writeFile(brief, gate.brief + '\n\n## The work above is done but failed the project\'s checks\n\n' +
        `${gateDetails(last, true)}\n${budgetOnly ? '' : `\n${gateInstruction}\n`}`);
      const result = await launch(entry, ['-w', '-m', entry.model, '-e', entry.effort,
        '-C', dir, '-f', brief, '-o', fixOut], dir, account);
      const after = await protectedFiles(gate.repo);
      const tests = modifiedTests(before, after, budgetOnly);
      const forbiddenTests = budgetOnly ? tests.filter((file) => !files.includes(file)) : tests;
      if (forbiddenTests.length) {
        dispatch.gate = { status: 'fail', rounds, last, touched: forbiddenTests };
        return await report(`Round ${rounds}: fail\n\n## Gate: fail (fix round modified tests: ${forbiddenTests.join(', ')})`);
      }
      const touched = [...new Set([...before.keys(), ...after.keys()])].filter((file) =>
        before.get(file) !== after.get(file) && (checkConfiguration(file) ||
          path.posix.basename(file) === 'pyproject.toml' ||
          (before.has(file) && !after.has(file) && !(budgetOnly && testFile(file))))).sort();
      if (touched.length) {
        dispatch.gate = { status: 'fail', rounds, last, touched };
        return await report(`Round ${rounds}: fail\n\n## Gate: fail (fix round touched check configuration: ${touched.join(', ')})`);
      }
      if (result.code !== 0) {
        dispatch.gate = { status: 'fail', rounds, last, fixCode: result.code };
        return await report(`Round ${rounds}: wrapper exited ${result.code}\n\n## Gate: fail\n\n${gateDetails(last)}`);
      }
      files = await gateChangedFiles(gate.repo, gate.base, gate.preExisting);
      const previousTests = last.tests;
      last = await runGateChecks(gate.repo, gate.base, files, checkOptions);
      if (last.configError) return await configError(last.configError);
      if (budgetOnly) {
        const problems = await trimViolations(gate.repo, gate.base, trim, files);
        if (problems.length) {
          dispatch.gate = { status: 'fail', rounds, last, touched: problems };
          return await report(`Round ${rounds}: fail\n\n## Gate: fail (the trim round may only delete tests the job added: ` +
            `${problems.join('; ')})`);
        }
        if (!files.length) last.tests = { budget: previousTests.budget, added: 0, ok: true, files: [] };
        if (!last.tests || last.tests.added >= previousTests.added) {
          dispatch.gate = { status: 'fail', rounds, last, touched: tests };
          return await report(`Round ${rounds}: fail\n\n## Gate: fail (fix round did not reduce the number of new tests)`);
        }
      }
    }
    const status = last.ok ? 'pass' : gate.mode === 'warn' ? 'warn' : 'fail';
    dispatch.gate = { status, rounds, last };
    return await report(`\n## Gate: ${status}\n\n${gateDetails(last)}`);
  } catch (error) {
    const status = gate.mode === 'warn' ? 'warn' : 'fail';
    dispatch.gate = { status, rounds, last, message: error.message };
    return await report(`\n## Gate: ${status}\n\n${error.message}`);
  }
}

function options(args, allowed) {
  const result = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown option: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option: ${key}`);
    if (key === '--review-skip') {
      const value = args[index + 1];
      result[key] = value === undefined || Object.hasOwn(allowed, value) ? '' : args[++index];
    } else if (allowed[key]) {
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
    if (config.thresholds.codex.hysteresis_percent >= config.thresholds.codex.switch_percent) {
      validateConfig(config);
      throw new Error('hysteresis_percent must be less than switch_percent');
    }
    note = 'threshold';
  } else if (action === 'undo' && !rest.length) {
    const target = await undoTarget();
    return saveResult(target.before, previous, actor, `undo ${target.id}`);
  } else if (['set-entry', 'add-entry', 'remove-entry', 'move-entry'].includes(action)) {
    const allowed = { '--tier': true, '--panel': true };
    if (action !== 'add-entry') Object.assign(allowed, { '--index': true, '--seat': true });
    if (action === 'set-entry' || action === 'add-entry') {
      Object.assign(allowed, { '--provider': true, '--model': true, '--effort': true });
    }
    if (action === 'add-entry') allowed['--at'] = true;
    if (action === 'move-entry') allowed['--to'] = true;
    const opts = options(rest, allowed), chain = chainFor(config, opts, true);
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
        if (chain.length === 1) {
          throw new Error(panel ? 'cannot remove the last seat in a panel' : 'cannot remove the last entry in a chain');
        }
        chain.splice(index, 1);
      } else {
        const to = entryIndex(opts['--to'], chain.length - 1, '--to');
        chain.splice(to, 0, chain.splice(index, 1)[0]);
      }
    }
    note = `${action} ${panel ? 'panel' : 'tier'} ${opts['--panel'] || opts['--tier']}`;
  } else throw new Error('usage: exec.mjs config get | set | ' +
    'set-entry (--tier <name> --index <n>|--panel <name> --seat <n>) --provider <name> --model <name> --effort <name> | ' +
    'add-entry (--tier <name>|--panel <name>) [--at <n>] --provider <name> --model <name> --effort <name> | ' +
    'remove-entry (--tier <name> --index <n>|--panel <name> --seat <n>) | ' +
    'move-entry (--tier <name> --index <n>|--panel <name> --seat <n>) --to <n> | ' +
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
  if (action === 'refresh') {
    if (!['codex', 'claude', 'gemini', 'all'].includes(provider)) {
      throw new Error(`unknown provider: ${provider}`);
    }
    const providers = provider === 'all' ? ['codex', 'claude'] : [provider];
    const candidates = [];
    const problems = [];
    if (providers.includes('codex')) {
      const cache = process.env.CONVEYOR_CODEX_MODELS_CACHE ??
        path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json');
      let models = [];
      try {
        let command = ['codex', 'debug', 'models'];
        if (process.env.CONVEYOR_CODEX_MODELS_CMD !== undefined) {
          try { command = JSON.parse(process.env.CONVEYOR_CODEX_MODELS_CMD); }
          catch { command = null; }
          if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== 'string' || !item)) {
            throw new Error('CONVEYOR_CODEX_MODELS_CMD must be non-empty JSON argv');
          }
        }
        const parseModels = (json) => {
          const data = JSON.parse(json);
          if (!Array.isArray(data?.models)) throw new Error('models must be an array');
          return data.models;
        };
        try {
          // 15 s: a stalled Codex still leaves the cache fallback and the Claude scan inside the panel's deadline.
          const result = await runSupervised(command, { deadlineMs: 15_000, maxOutput: 8 * 1024 * 1024 });
          if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('codex debug models failed');
          models = parseModels(result.stdout);
        } catch {
          try { models = parseModels(await fs.readFile(cache, 'utf8')); }
          catch { throw new Error(`codex model cache unreadable: ${cache}`); }
        }
      } catch (error) {
        if (provider !== 'all') throw error;
        problems.push(error.message);
      }
      // Codex keeps listing older releases (gpt-5.6-*, gpt-6-sol); only the newest version of each family joins the
      // picker, so a refresh brings in gpt-6.2-sol without re-adding every model it replaced.
      const listed = models.filter((entry) => entry?.visibility === 'list' && typeof entry.slug === 'string' &&
        entry.slug && !/^gpt-6-astra$/i.test(entry.slug));
      const release = (slug) => /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/i.exec(slug);
      const newer = (a, b) => {
        const x = a.split('.').map(Number), y = b.split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
        return false;
      };
      const newest = new Map();
      for (const entry of listed) {
        const match = release(entry.slug);
        if (match && (!newest.has(match[2].toLowerCase()) || newer(match[1], newest.get(match[2].toLowerCase())))) {
          newest.set(match[2].toLowerCase(), match[1]);
        }
      }
      for (const entry of listed) {
        const match = release(entry.slug);
        if (match && newest.get(match[2].toLowerCase()) !== match[1]) continue;
        const efforts = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
          .map((level) => level?.effort).filter((effort) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort));
        if (efforts.length) candidates.push({ name: 'codex', model: entry.slug, efforts });
      }
    }
    if (providers.includes('claude')) {
      const binaries = new Set();
      const addBinary = async (file) => {
        try {
          const real = await fs.realpath(file);
          if (!(await fs.stat(real)).isFile()) return false;
          binaries.add(real);
          return true;
        } catch { return false; }
      };
      if (process.env.CONVEYOR_CLAUDE_BINS !== undefined) {
        let files;
        try { files = JSON.parse(process.env.CONVEYOR_CLAUDE_BINS); }
        catch { files = []; }
        if (Array.isArray(files)) {
          for (const file of files) if (typeof file === 'string' && file) await addBinary(file);
        }
      } else {
        const root = path.join(homedir(), '.config', 'Claude', 'claude-code');
        const name = platform === 'win32' ? 'claude.exe' : 'claude';
        for (const version of await fs.readdir(root).catch(() => [])) {
          const dir = path.join(root, version);
          for (const hash of await fs.readdir(dir).catch(() => [])) await addBinary(path.join(dir, hash, name));
        }
        for (const dir of process.env.PATH?.split(path.delimiter) ?? []) {
          if (await addBinary(path.join(dir, name))) break;
        }
      }
      const aliases = new Set();
      const pattern = /description of the task",[A-Za-z0-9_$]+=\[[^\]\n]{1,300}\]/;
      for (const file of binaries) {
        let matches;
        try {
          matches = await scanBinary(file, pattern, { signal: AbortSignal.timeout(15_000), maxBytes: 1024 * 1024 });
        } catch { continue; }
        for (const match of matches) {
          try {
            for (const alias of JSON.parse(match.slice(match.indexOf('[')))) {
              if (typeof alias === 'string' && /^[a-z][a-z0-9-]*$/.test(alias)) aliases.add(alias);
            }
          } catch { /* Another bundled copy can still have a valid enum. */ }
        }
      }
      if (!aliases.size) {
        for (const model of ['opus', 'sonnet', 'haiku', 'fable']) aliases.add(model);
        problems.push('claude aliases not found in Claude Code, used defaults');
      }
      for (const model of aliases) candidates.push({ name: 'claude', model, efforts: ['low', 'medium', 'high'] });
    }
    if (provider === 'gemini') {
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
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(gemini-[^\s]+)\t[^\t]+$/.exec(line);
        if (!match) continue;
        const model = match[1].replace(/-(low|medium|high)$/, '');
        candidates.push({ name: 'gemini', model, efforts: ['low', 'medium', 'high'] });
      }
    }

    // Discovery is done; the config is read, extended and written under one lock, so a setting another process
    // saved meanwhile is kept, never replaced by an older copy.
    let note;
    const saved = await updateConfig((config) => {
      const added = [];
      for (const { name, model, efforts } of candidates) {
        const catalog = config.catalog[name];
        if (!Array.isArray(catalog)) throw new Error(`unknown provider: ${name}`);
        if (catalog.some((entry) => entry.model === model)) continue;
        catalog.push({ model, efforts });
        added.push(name === 'gemini' ? model : `${name}/${model}`);
      }
      note = [added.length ? `added ${added.join(', ')}` : 'no models added', ...problems].join('; ');
      return added.length ? note : null;
    }, { actor });
    process.stdout.write(`${JSON.stringify({ ok: true, changed: saved !== null, note })}\n`);
    return 0;
  }

  const config = await loadConfig(), previous = structuredClone(config);
  if (!Object.hasOwn(config.catalog, provider)) throw new Error(`unknown provider: ${provider}`);
  const catalog = config.catalog[provider];
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
  return saveResult(config, previous, actor, `${action} ${provider}/${model}`);
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
      if (values.state === 'running' || values.reached_running === '1') reachedRunning = true;
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

async function launch(entry, args, dir, account) {
  const wrapper = wrapperPath(entry.provider);
  try { await fs.access(wrapper, constants.R_OK); }
  catch (error) { return { code: 127, launchError: error.message }; }
  return new Promise((resolve) => {
    const env = account ? { ...process.env, LUNA_CODEX_ACCOUNT: account } : process.env;
    const child = spawn(bash(), [wrapper, ...args], { cwd: dir, stdio: 'inherit', env });
    const forward = (signal) => child.kill(signal);
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    const onHup = () => forward('SIGHUP');
    // Forward to the wrapper before the write-lock signal handler exits the dispatcher.
    process.prependListener('SIGINT', onInt);
    process.prependListener('SIGTERM', onTerm);
    process.prependListener('SIGHUP', onHup);
    let launchError;
    child.once('error', (error) => { launchError = error.message; });
    child.once('close', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
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

function failureReason(result, status, account) {
  if (result.launchError) return { reason: 'start', note: result.launchError };
  if (account && result.code !== 0) {
    const explicit = status?.unavailable_reason;
    const error = status?.error || explicit || '';
    if (!['region', 'start'].includes(explicit)) {
      const auth = codexAuthError.exec(error);
      const quota = codexQuotaError.exec(error);
      if (auth) return { account, reason: 'auth', note: auth[0] };
      if (quota) return { account, reason: 'quota', note: quota[0] };
      if (!status?.error && explicit === 'auth') return { account, reason: 'auth', note: explicit };
    }
  }
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

function refuseUnreviewedWrite(session) {
  const requirement = taskApproachReviewRequirement(session);
  if (!requirement) return false;
  const message = requirement === 'retry'
    ? "this task's work failed the gate: run an approach review on tier architect with the failure history "
      + 'before another attempt (or --review-skip "<reason>")'
    : requirement === 'independent'
    ? 'the plan was written by tier planner (Astra): review it on tier approach (a different model) before implementing '
      + '(or --review-skip "<reason>")'
    : 'approach review required before the first complex write of this task: run exec.mjs run --tier approach '
      + '(medium change) or --tier architect (complex architecture) -r -C <dir> -f <plan-brief.md> -o <out.md>, '
      + 'then record what you accepted; or pass --review-skip "<reason>" for a change with no design choice';
  process.stderr.write(`${message}\n`);
  return true;
}

async function runCommand(args) {
  const opts = options(args, {
    '--tier': true, '--panel': true, '--seat': true, '--role': true,
    '--no-gate': false, '--waive': true, '--review-skip': true,
    '-w': false, '-r': false, '-C': true, '-f': true, '-o': true
  });
  const reviewSkip = opts['--review-skip'];
  if (reviewSkip !== undefined && !validReviewSkip(reviewSkip)) {
    process.stderr.write('conveyor: --review-skip requires a non-empty reason of at most 300 characters\n');
    return 2;
  }
  required(opts, ['-C', '-f', '-o']);
  if (Boolean(opts['-w']) === Boolean(opts['-r'])) throw new Error('exactly one of -w or -r is required');
  if ((opts['--no-gate'] && !opts['--waive']) || (opts['--waive'] && !/^W-\d+$/.test(opts['--waive']))) {
    throw new Error('--no-gate requires --waive <id> with format W-<digits>');
  }
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
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  // Any route to the complex tier counts, including a pstack role that maps to it.
  const enforceReview = reviewSkip === undefined && mode === 'write' && !panel
    && tier === 'complex' && hasApproachReviewTiers(config);
  if (enforceReview && refuseUnreviewedWrite(session)) return 8;
  const resolve = async (state) => {
    if (!panel) return resolveChain(tier, { config, state });
    const resolved = await resolvePanel(panel, { config, state });
    const seat = resolved.seats[Number(opts['--seat'])];
    if (!seat) throw new Error(`unknown seat ${opts['--seat']} for panel ${panel}`);
    return { ...resolved, chain: [seat] };
  };
  const triedAccounts = new Set(), excludedAccounts = new Set(), probedAccounts = new Set();
  const dispatch = {
    at: new Date().toISOString(), ...(panel ? { panel, seat: Number(opts['--seat']) } : { tier }),
    ...(role ? { role } : {}), brief, out, mode, dir,
    action: 'resolve', selected: null, chain: [], attempts: []
  };
  if (opts['--waive']) dispatch.waive = opts['--waive'];
  if (opts['--no-gate']) dispatch.noGate = true;
  const saveDispatch = () => writeJsonAtomic(`${out}.dispatch.json`, dispatch);
  let lock, code = 1, reviewRefused = false;
  try {
    lock = mode === 'write' ? await acquireWriteLock(dir, out, brief) : null;
    if (lock && !lock.release) {
      Object.assign(dispatch, { action: 'write-locked', owner: lock.owner, code: 7 });
      await saveDispatch();
      process.stderr.write(`exec: another write job runs in ${lock.key} ` +
        `(out: ${lock.owner?.out ?? 'unknown'}, since ${lock.owner?.at ?? 'unknown'}). ` +
        'Run this slice in its own worktree (node ~/.claude/scripts/disk/wt-new.mjs …) or wait for it.\n');
      return code = 7;
    }
    // A previous writer may have recorded a failure while this dispatch acquired the repository lock.
    reviewRefused = enforceReview && refuseUnreviewedWrite(session);
    if (reviewRefused) return 8;
    const gate = mode === 'write' ? await prepareGate(dir, brief, out, tier, panel, opts['--no-gate'], reviewSkip) : null;
    const refresh = () => providerState(config, { excludeCodexAccounts: excludedAccounts });
    let state = await refresh(), resolution = await resolve(state);
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
        return code = 5;
      }
      const entry = resolution.chain[index];
      // With several accounts, one whose limits nobody has read yet (just registered, probes failing) is read once
      // before a job starts on it: a depleted seat refuses the first turn only after the job is `running`, too late
      // to move a write job to the other account.
      if (entry.provider === 'codex' && entry.active && platform === 'linux' && state.threshold.accounts.length > 1 &&
          !probedAccounts.has(entry.active) &&
          state.threshold.accounts.find(({ id }) => id === entry.active)?.known === false) {
        probedAccounts.add(entry.active);
        const { probeLimits } = await import('../lib/codex-limits-probe.mjs');
        const { codexHome, runRoot } = accountPaths(entry.active);
        await probeLimits({ codexHome, out: path.join(runRoot, 'codex-limits.probe.json') }).catch(() => null);
        state = await refresh();
        resolution = await resolve(state);
        continue;
      }
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
        // Exit 4 releases the lock; the caller's hand-off subagent writes outside this lock.
        print(dispatch);
        return code = 4;
      }
      const attempt = {
        provider: entry.provider, model: entry.model, effort: entry.effort, at: new Date().toISOString()
      };
      let account = entry.active;
      if (account) {
        attempt.account = account;
        triedAccounts.add(account);
      }
      dispatch.attempts.push(attempt);
      await saveDispatch();
      const tracker = trackStatus(`${out}.status`);
      let result, observed;
      try {
        result = await launch(entry, [mode === 'write' ? '-w' : '-r', '-m', entry.model, '-e', entry.effort,
          '-C', dir, '-f', brief, '-o', out], dir, account);
      } finally { observed = tracker.finish(); }
      // The wrapper can fall back to main if its account picker fails.
      if (account && observed.values?.account === 'main') {
        account = attempt.account = 'main';
        triedAccounts.add(account);
      }
      const failure = failureReason(result, observed.values, account);
      Object.assign(attempt, {
        code: result.code, state: observed.values?.state ?? null, error: observed.values?.error ?? null,
        reached_running: observed.reachedRunning
      });
      dispatch.code = result.code;
      if (failure) await markUnavailable(entry.provider, failure.reason, failure.note, { config, account: failure.account });
      const retryable = result.code === 3 || Boolean(failure && !result.launchError);
      const canRetry = retryable && !(mode === 'write' && observed.reachedRunning) && !result.signal;
      let retryAccount = false;
      if (canRetry && (failure?.account || !panel)) {
        if (account && observed.reachedRunning) {
          for (const id of Object.keys(state.usage.codexAccounts)) excludedAccounts.add(id);
        } else if (failure?.account) {
          for (const id of triedAccounts) excludedAccounts.add(id);
        }
        state = await refresh();
        resolution = await resolve(state);
        retryAccount = Boolean(failure?.account && !observed.reachedRunning && resolution.chain[index].available);
      }
      if (!canRetry || (panel && !retryAccount)) {
        attempt.retry = false;
        if (result.code === 0 && ['done', 'incomplete'].includes(observed.values?.state)) {
          dispatch.code = await finishGate(gate, dispatch, entry, dir, out, account);
        }
        await saveDispatch();
        return code = dispatch.code;
      }
      attempt.retry = true;
      attempt.reason = `${failure.reason}: ${failure.note}`;
      attempt.archive = await archiveAttempt(out, entry.provider);
      await saveDispatch();
      cursor = retryAccount ? index - 1 : index;
      from = retryAccount ? null : entry.provider;
      failedReason = attempt.reason;
    }
  } finally {
    try {
      if (!reviewRefused) await appendRunRecord({
        event: 'end', at: new Date().toISOString(), session: session || 'unknown', out, tier, ...(panel ? { panel } : {}), mode,
        provider: dispatch.provider ?? null, model: dispatch.model ?? null, code,
        gate: dispatch.gate ? { status: dispatch.gate.status, rounds: dispatch.gate.rounds ?? null } : null
      });
    } finally { lock?.release?.(); }
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
    '(-w|-r) -C <dir> -f <brief> -o <out> [--no-gate --waive W-<digits>] [--review-skip <reason>] | ' +
    'roles render [--out <path>] | status [--json] | config … | catalog …; ' +
    'exit codes: 4 Claude hand-off, 5 no provider available, 6 gate failed, 7 repository write-locked, 8 approach review required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startMaintenanceWatchdog();
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`conveyor: ${error.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}\n`);
    process.exitCode = 1;
  });
}
