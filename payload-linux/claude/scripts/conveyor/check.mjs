#!/usr/bin/env node
// Deterministic checks and per-file hygiene ratchets for executor and stop gates.
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { loadProfile, matchesGlob, trustProfile } from './lib/profile.mjs';
import { git, existingFiles, repositoryFiles, ratchet, hygieneReport } from './lib/hygiene.mjs';

function options(args, allowed) {
  const result = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown option: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option: ${key}`);
    if (allowed[key]) {
      if (args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error(`${key} requires a value`);
      result[key] = args[++index];
    } else result[key] = true;
  }
  return result;
}

function commandTemplate(command) {
  // Accept legacy quoted placeholders too. File names never become shell source.
  return command.replace(/(["'])\{(?:files|tests_for_files)\}\1|\{(?:files|tests_for_files)\}/g, '"$@"');
}

function heavy(command) {
  return /\b(?:tsc|vitest|jest|pytest(?:_gate\.py)?|cargo|webpack|rollup|esbuild|build)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test\b|type-?check\b|install\b|ci\b)/i.test(command);
}

function processResult(repo, executable, args, budgetMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '', timedOut = false, closed = false, escalation = null, rc = null;
    const append = (chunk) => { output = (output + chunk).split('\n').slice(-61).join('\n'); };
    const child = spawn(executable, args, {
      cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, npm_config_offline: 'true', npm_config_yes: 'false', npm_config_audit: 'false',
        UV_OFFLINE: '1', UV_NO_SYNC: '1', CARGO_NET_OFFLINE: 'true', PIP_NO_INDEX: '1',
        RUFF_NO_CACHE: 'true', PYTHONDONTWRITEBYTECODE: '1', MYPY_CACHE_DIR: '/dev/null'
      }
    });
    function signalGroup(signal) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    function finish() {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : rc === 0 ? 'pass' : 'fail', rc, durationMs: Date.now() - started,
        outputTail: stripVTControlCharacters(output).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').slice(-60).join('\n')
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      // Escalate even if the shell exits first: a descendant can ignore SIGTERM and close its pipes.
      escalation = setTimeout(() => {
        signalGroup('SIGKILL');
        escalation = null;
        if (closed) finish();
      }, 200);
    }, Math.max(1, budgetMs));
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    child.on('error', (error) => { append(`${error.message}\n`); rc = 127; });
    child.on('close', (code) => {
      closed = true;
      rc = code ?? rc;
      if (!escalation) finish();
    });
  });
}

async function relatedTests(repo, changed) {
  const names = new Set(changed.filter((file) => file.endsWith('.py')).map((file) => `test_${path.basename(file)}`));
  if (!names.size) return [];
  return (await repositoryFiles(repo)).filter((file) =>
    (file.startsWith('tests/') && names.has(path.basename(file))) ||
    (changed.includes(file) && file.endsWith('.py') && /(?:^|\/)test_[^/]+$/.test(file)));
}

async function run(repo, opts, profile) {
  const level = opts['--level'];
  if (!['fast', 'turn'].includes(level)) throw new Error('--level must be fast or turn');
  const base = opts['--base'] ?? 'HEAD';
  const revision = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
  let names;
  if (opts['--files'] !== undefined) names = opts['--files'].split(',').filter(Boolean);
  else {
    const diff = await git(repo, ['diff', '--name-only', '--no-renames', '-z', revision, '--']);
    const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
    names = (diff + untracked).split('\0').filter(Boolean);
  }
  const changed = await existingFiles(repo, names), results = [];
  const entries = profile[level];
  const deadline = Date.now() + profile.budgets[`${level}_s`] * 1000;
  for (const entry of entries) {
    const files = changed.filter((file) => matchesGlob(file, entry.glob ?? entry.when ?? '**/*'));
    const tests = entry.run.includes('{tests_for_files}') && files.length ? await relatedTests(repo, files) : [];
    const cmd = commandTemplate(entry.run);
    const args = (entry.run.includes('{tests_for_files}') ? tests : files)
      .map((file) => file.startsWith('-') ? `./${file}` : file);
    if (!files.length || (entry.run.includes('{tests_for_files}') && !tests.length)) {
      results.push({
        name: entry.name, cmd, status: 'skipped', rc: null, durationMs: 0,
        outputTail: 'skipped: no matching files'
      });
      continue;
    }
    if (deadline <= Date.now()) {
      results.push({ name: entry.name, cmd, status: 'timeout', rc: null, durationMs: 0, outputTail: 'level budget exhausted' });
      continue;
    }
    let admission;
    if (heavy(cmd)) {
      const gate = process.env.CONVEYOR_HEAVY_GATE || path.join(homedir(), '.claude/scripts/heavy-gate.mjs');
      admission = await processResult(repo, process.execPath, [gate, 'wait'], deadline - Date.now());
    }
    let result;
    if (admission && admission.status !== 'pass') result = admission;
    else if (deadline <= Date.now()) {
      result = { status: 'timeout', rc: null, durationMs: 0, outputTail: 'level budget exhausted' };
    } else result = await processResult(repo, '/bin/sh', ['-c', cmd, 'conveyor', ...args], deadline - Date.now());
    results.push({ name: entry.name, cmd, ...result });
  }
  const hygieneFiles = changed.filter((file) => file !== path.normalize(profile.hygiene.baseline));
  const hygiene = await ratchet(repo, hygieneFiles, profile.hygiene.counters, revision);
  const ok = hygiene.ok && results.every((result) => ['pass', 'skipped'].includes(result.status));
  const trust = profile.profileTrust;
  return { ok, level, repo, base, changed, results, hygiene, profileTrust: trust,
    ...(trust === 'untrusted' ? { profile: 'untrusted (run check.mjs trust after review)' } : {}) };
}

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.level) {
    if (result.profile) process.stdout.write(`profile: ${result.profile}\n`);
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.level}: ${result.changed.length} changed files (${result.repo})\n`);
    if (!result.results.some((entry) => entry.status !== 'skipped')) process.stdout.write('nothing to check\n');
    for (const entry of result.results) {
      process.stdout.write(`${entry.status} ${entry.name} (${entry.durationMs}ms)\n`);
      if (entry.outputTail && entry.status !== 'pass') process.stdout.write(`${entry.outputTail}\n`);
    }
    process.stdout.write(`hygiene: ${result.hygiene.ok ? 'pass' : 'fail'}\n`);
    for (const growth of result.hygiene.grew) {
      process.stdout.write(`  ${growth.file}: ${growth.counter} ${growth.before} -> ${growth.after}\n`);
    }
  } else {
    process.stdout.write(`hygiene: ${result.repo}\n`);
    for (const [name, total] of Object.entries(result.totals)) {
      process.stdout.write(`${name}: ${total} (baseline ${result.baseline?.[name] ?? 'none'}, delta ${result.delta?.[name] ?? 'n/a'})\n`);
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  if (!['run', 'hygiene', 'trust'].includes(action)) throw new Error('usage: check.mjs run | hygiene | trust --dir <repo> [--json]');
  const allowed = { '--dir': true, '--json': false };
  if (action === 'run') Object.assign(allowed, { '--level': true, '--files': true, '--base': true });
  else if (action === 'hygiene') allowed['--write-baseline'] = false;
  const opts = options(rest, allowed);
  if (!opts['--dir']) throw new Error('--dir is required');
  const repo = path.resolve(opts['--dir']);
  if (action === 'trust') {
    const result = await trustProfile(repo);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const profile = await loadProfile(repo);
  const result = action === 'run' ? await run(repo, opts, profile) : await hygieneReport(repo, profile, Boolean(opts['--write-baseline']));
  print(result, opts['--json']);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`conveyor check: ${error.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}\n`);
    process.exitCode = 2;
  });
}
