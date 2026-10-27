#!/usr/bin/env node
// Shared admission gate for memory-heavy commands across Claude sessions and script jobs.
// Dev servers wait for free RAM without taking a heavy-command lease.
// hook-pre/post manage tool leases (720s foreground, 2700s background); run owns a child lease.
// wait only checks RAM and never writes files.
// --status reports leases and --self-test uses disposable state. Errors/timeouts fail open, never grant permission.
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { processStarts, sameStart } from './lib/process-identity.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const MB = 1024 * 1024;
const DEFAULTS = { max: 2, minFreeMb: 2500, maxWaitS: 600, devMaxWaitS: 180 };
const SHELL_PREFIXES = new Set('if then else elif fi do done while until for case esac ! { } ( ) time'.split(' '));

function commandSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let quote = '';
  let started = false;
  const finishWord = () => {
    if (started) words.push(word);
    word = ''; started = false;
  };
  const finishSegment = () => {
    finishWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\' && command[i + 1] === '"') word += command[++i];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (char === '(' || char === ')') {
      finishWord(); words.push(char);
    } else if (char === ';' || char === '|' || char === '\n' || (char === '&' && command[i + 1] === '&')) {
      finishSegment();
      if (command[i + 1] === char && (char === '|' || char === '&')) i += 1;
    } else if (char === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>') {
      finishSegment();
    } else if (/\s/.test(char)) finishWord();
    else { word += char; started = true; }
  }
  // Incomplete quoting is unexpected input: do not hold up the caller.
  if (quote) return [];
  finishSegment();
  return segments;
}

function commandName(word) {
  return word.split(/[\\/]/).pop().replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

function packageCommand(args) {
  const [action = '', script = ''] = args.map((arg) => arg.toLowerCase());
  return /^(install|i|ci|add|test|t|build)$/.test(action) ||
    (action === 'run' && /^(test|build|typecheck|lint|check|e2e)/.test(script));
}

function stripAssignments(input) {
  const words = [...input];
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || SHELL_PREFIXES.has(words[0]))) words.shift();
  return words;
}

function stripCommandPrefixes(input) {
  const words = stripAssignments(input);
  while (words.length) {
    const name = commandName(words[0]);
    const args = words.slice(1);
    const first = (args[0] || '').toLowerCase();
    if (name === 'npx' || name === 'bunx' || name === 'yarn' ||
      (name === 'npm' && /^(exec|x)$/.test(first)) ||
      ((name === 'pnpm' || name === 'yarn') && /^(exec|dlx)$/.test(first))) {
      words.shift();
      if (/^(npm|pnpm|yarn)$/.test(name) && /^(exec|x|dlx)$/.test(commandName(words[0] || ''))) words.shift();
      while (/^(--|-y|--yes|--no-install)$/.test(words[0] || '')) words.shift();
      continue;
    }
    if ((name === 'pnpm' && first === 'exec') || (/^(uv|poetry)$/.test(name) && first === 'run') ||
      (/^(python|py)$/.test(name) && first === '-m')) {
      words.splice(0, 2); continue;
    }
    if (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/i.test(first)) {
      words.splice(0, 2); continue;
    }
    if (name === 'env') {
      words.shift();
      while (words.length && (words[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
        if (words[0] === '-u' || words[0] === '--unset') words.splice(0, 2);
        else words.shift();
      }
      continue;
    }
    if (name === 'nice') {
      words.shift();
      if (words[0] === '-n' || words[0] === '--adjustment') words.splice(0, 2);
      else if (/^(--adjustment=|-\d)/.test(words[0] || '')) words.shift();
      continue;
    }
    break;
  }
  return words;
}

function heavySegment(input, depth = 0) {
  const initial = stripAssignments(input);
  if (initial.length && /^(npm|pnpm|yarn|bun)$/.test(commandName(initial[0])) &&
    packageCommand(initial.slice(1))) return true;
  const words = stripCommandPrefixes(input);
  if (!words.length) return false;
  const name = commandName(words[0]);
  const args = words.slice(1);
  const first = (args[0] || '').toLowerCase();
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && packageCommand(args)) return true;
  if (/^(bash|sh|dash|zsh)$/.test(name) && depth < 3) {
    const index = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (index >= 0) return isHeavy(args[index + 1], depth + 1);
  }
  if (args.length === 1 && /^(--version|--help|-h)$/.test(first)) return false;
  if (name === 'tsc') return !args.some((arg) => /^(--version|-v|--help|-h)$/.test(arg));
  if (/^(vitest|jest|mocha|ava|pytest|webpack|mvn|gradle|gradlew|msbuild)$/.test(name)) return true;
  if (name === 'cargo') return /^(build|test|check|clippy|run)$/.test(first);
  if (name === 'playwright') return first === 'test';
  if (name === 'cypress') return first === 'run';
  if (/^(make|mingw32-make|nmake)$/.test(name)) {
    if (args.some((arg) => /^(?:-n|--just-print|--dry-run)$/.test(arg))) return false;
    const operands = [...args];
    while (operands.length && /^-/.test(operands[0])) {
      const option = operands.shift();
      if (/^(?:-f|--file|-C|--directory|-j|--jobs)$/.test(option)) operands.shift();
    }
    const target = operands[0];
    return !target || /^(test|tests|check|build|all|ci|e2e|lint|typecheck)$/i.test(target);
  }
  if (/^(vite|next|nuxt|astro)$/.test(name)) return first === 'build';
  if (name === 'rollup') return args.includes('-c');
  if (name === 'esbuild') return args.some((arg) => /^--bundle(?:=true)?$/.test(arg));
  if (/^(go|dotnet)$/.test(name)) return /^(build|test)$/.test(first);
  if (name === 'docker') return first === 'build' || (first === 'compose' && args[1]?.toLowerCase() === 'build');
  if (name === 'eslint') return args.some((arg) => arg === '.' || /[\\/]$|\*/.test(arg));
  return false;
}

function devSegment(input) {
  const initial = stripAssignments(input);
  if (initial.length && /^(npm|pnpm|yarn|bun)$/.test(commandName(initial[0]))) {
    const [action = '', script = ''] = initial.slice(1).map((arg) => arg.toLowerCase());
    return /^(dev|start|serve|preview)$/.test(action) ||
      (action === 'run' && /^(dev|start|serve|preview)$/.test(script));
  }
  const words = stripCommandPrefixes(input);
  if (!words.length) return false;
  const name = commandName(words[0]);
  const args = words.slice(1);
  const first = (args[0] || '').toLowerCase();
  if (name === 'vite') return first !== 'build';
  if (/^(next|nuxt|astro|remix)$/.test(name)) return /^(dev|start)$/.test(first);
  if (name === 'webpack') return first === 'serve';
  if (name === 'webpack-dev-server') return true;
  if (/^(tsx|ts-node|nodemon)$/.test(name)) {
    if (name === 'tsx' && first === 'watch') return true;
    const entry = args.find((arg) => !arg.startsWith('-')) || '';
    return /(?:server\.(?:ts|js|mjs)|main\.ts|index\.ts|app\.ts)$/i.test(entry);
  }
  if (/^(uvicorn|gunicorn)$/.test(name)) return true;
  if (name === 'flask') return first === 'run';
  if (/^(python|py|python3)$/.test(name)) {
    return (args[0] === 'manage.py' && args[1] === 'runserver') ||
      (args[0] === '-m' && args[1] === 'http.server');
  }
  return name === 'http.server';
}

export function isHeavy(command, depth = 0) {
  return typeof command === 'string' && commandSegments(command).some((words) => heavySegment(words, depth));
}

export function isDevServer(command) {
  return typeof command === 'string' && !isHeavy(command) && commandSegments(command).some(devSegment);
}

function runtime(overrides = {}) {
  const home = path.resolve(process.env.USERPROFILE || os.homedir());
  let starts;
  const ctx = {
    ...DEFAULTS, env: process.env, dir: path.join(home, '.claude', 'luna-run', 'heavy'),
    sentinel: path.join(home, '.claude', 'heavy-gate-off'), now: Date.now, freemem: os.freemem,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), batchProbe: processStarts,
    out: (value) => process.stdout.write(value), err: (value) => process.stderr.write(value),
    input: readInput, spawn, ...overrides
  };
  const start = (pid) => {
    if (!starts) {
      const pids = [process.pid];
      try {
        for (const name of fs.readdirSync(ctx.dir).filter((item) => /^lease-[A-Za-z0-9._-]+\.json$/.test(item))) {
          try {
            const lease = JSON.parse(fs.readFileSync(path.join(ctx.dir, name), 'utf8'));
            if (validLease(lease) && lease.kind === 'run' && lease.pid && alive(lease.pid)) pids.push(lease.pid);
          } catch {}
        }
      } catch {}
      starts = ctx.batchProbe(pids);
    }
    return starts.get(pid) || '';
  };
  if (!overrides.processStart) ctx.processStart = start;
  if (!overrides.alive) ctx.alive = (pid, expected) => alive(pid) && sameStart(start(pid), expected);
  return ctx;
}

function numberSetting(value, fallback, minimum, integer = false) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(number) || number < minimum ||
    (integer && !Number.isInteger(number)) || number > Number.MAX_SAFE_INTEGER / 1000) {
    throw Error('invalid gate setting');
  }
  return number;
}

function configure(ctx) {
  ctx.max = numberSetting(ctx.env.HEAVY_GATE_MAX, DEFAULTS.max, 1, true);
  ctx.minFreeMb = numberSetting(ctx.env.HEAVY_GATE_MIN_FREE_MB, DEFAULTS.minFreeMb, 0);
  ctx.maxWaitS = numberSetting(ctx.env.HEAVY_GATE_MAX_WAIT_S, DEFAULTS.maxWaitS, 0);
  ctx.devMaxWaitS = numberSetting(ctx.env.HEAVY_GATE_DEV_MAX_WAIT_S, DEFAULTS.devMaxWaitS, 0);
}

function isOff(ctx) {
  return ctx.env.HEAVY_GATE_OFF === '1' || fs.existsSync(ctx.sentinel);
}

function freeMb(ctx) {
  const bytes = ctx.freemem();
  if (!Number.isFinite(bytes) || bytes < 0) throw Error('invalid free RAM reading');
  return Math.floor(bytes / MB);
}

function safeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

function leaseFile(ctx, id) {
  return path.join(ctx.dir, `lease-${safeId(id)}.json`);
}

function removeFile(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw error;
  }
  return true;
}

function validLease(lease) {
  return lease && lease.v === 1 && typeof lease.id === 'string' && typeof lease.session === 'string' &&
    typeof lease.cmd === 'string' && /^(hook|run)$/.test(lease.kind) &&
    Number.isFinite(lease.since) && Number.isFinite(lease.ttlS) && lease.ttlS >= 0 &&
    (lease.pid === null || (Number.isInteger(lease.pid) && lease.pid > 0));
}

function liveLeases(ctx) {
  let names;
  try { names = fs.readdirSync(ctx.dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const live = [];
  for (const name of names.filter((name) => /^lease-[A-Za-z0-9._-]+\.json$/.test(name))) {
    const file = path.join(ctx.dir, name);
    let lease;
    try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!validLease(lease) || lease.since + lease.ttlS * 1000 < ctx.now() ||
      (lease.kind === 'run' && lease.pid !== null && !ctx.alive(lease.pid, lease.pid_start))) removeFile(file);
    else live.push(lease);
  }
  return live;
}

function writeLease(ctx, lease) {
  const file = leaseFile(ctx, lease.id);
  const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...lease, since: ctx.now() }));
    fs.renameSync(temp, file);
  } finally { removeFile(temp); }
}

function takeLock(ctx) {
  const lock = path.join(ctx.dir, 'admit.lock');
  try { fs.mkdirSync(lock); return fs.statSync(lock); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    if (ctx.now() - fs.statSync(lock).mtimeMs <= 30_000) return null;
    // Only an empty lock directory is ours to remove, never arbitrary contents.
    fs.rmdirSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { fs.mkdirSync(lock); return fs.statSync(lock); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
}

function releaseLock(ctx, owned) {
  const lock = path.join(ctx.dir, 'admit.lock');
  try {
    const current = fs.statSync(lock);
    if (current.ino === owned.ino && current.birthtimeMs === owned.birthtimeMs) fs.rmdirSync(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function tryAdmission(ctx, lease, timedOut = false) {
  const lock = takeLock(ctx);
  if (!lock) return { admitted: false, lockBusy: true, reason: 'admission lock' };
  try {
    const live = liveLeases(ctx);
    const free = freeMb(ctx);
    const reason = live.length >= ctx.max ? 'slots full' : free < ctx.minFreeMb ? 'low RAM' : '';
    if (reason && !timedOut) return { admitted: false, reason };
    writeLease(ctx, lease);
    return { admitted: true, timeout: Boolean(reason && timedOut), reason };
  } finally { releaseLock(ctx, lock); }
}

function log(ctx, mode, id, waited, reason) {
  try {
    fs.mkdirSync(ctx.dir, { recursive: true });
    const file = path.join(ctx.dir, 'gate.log');
    const line = `${new Date(ctx.now()).toISOString()} ${mode} ${id} ${waited}s ${reason}`;
    fs.appendFileSync(file, `${line.replace(/[\r\n]/g, ' ')}\n`);
    if (fs.statSync(file).size > 200 * 1024) {
      const tail = Buffer.alloc(100 * 1024);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, tail, 0, tail.length, fs.fstatSync(fd).size - tail.length); }
      finally { fs.closeSync(fd); }
      fs.writeFileSync(file, tail);
    }
  } catch {}
}

function seconds(ctx, started) {
  return Math.max(0, Math.ceil((ctx.now() - started) / 1000));
}

async function acquire(ctx, lease, mode) {
  const started = ctx.now();
  const deadline = started + ctx.maxWaitS * 1000;
  let waited = false;
  let reason = '';
  try {
    fs.mkdirSync(ctx.dir, { recursive: true });
    for (;;) {
      if (isOff(ctx)) return { waited: seconds(ctx, started), off: true };
      const expired = ctx.now() >= deadline;
      const result = tryAdmission(ctx, lease, expired);
      if (result.admitted) {
        const elapsed = waited ? seconds(ctx, started) : 0;
        if (result.timeout || waited) log(ctx, mode, lease.id, elapsed, result.timeout ? 'timeout-admit' : reason);
        return { waited: elapsed, timeout: result.timeout };
      }
      reason = result.reason;
      if (expired) throw Error('admission lock timeout');
      waited = true;
      await ctx.sleep(Math.min(result.lockBusy ? 100 : 2000, Math.max(0, deadline - ctx.now())));
    }
  } catch (error) {
    const elapsed = seconds(ctx, started);
    log(ctx, mode, lease.id, elapsed, `error: ${error.message}`);
    return { waited: elapsed, error: true, timeout: ctx.now() >= deadline };
  }
}

function commandSummary(command) {
  const words = stripCommandPrefixes(commandSegments(command)[0] || []);
  const name = commandName(words[0] || '').replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  const action = /^(run|test|build|check|install|ci|lint|--noEmit)$/i.test(words[1] || '') ? words[1] : '';
  return `${name}${action ? ` ${action}` : ''}${words.length > 1 ? ' [redacted]' : ''}`;
}

function makeLease(ctx, id, session, command, kind, bg = false) {
  return {
    v: 1, id, session, kind, pid: kind === 'run' ? process.pid : null,
    pid_start: kind === 'run' ? ctx.processStart(process.pid) : '',
    cmd: commandSummary(command), since: ctx.now(),
    ttlS: kind === 'run' ? 7200 : bg ? 2700 : 720, bg
  };
}

function readInput() {
  return new Promise((resolve) => {
    let value = '';
    const finish = (result) => {
      clearTimeout(timer);
      process.stdin.off('data', data);
      process.stdin.off('end', end);
      process.stdin.off('error', error);
      process.stdin.pause();
      resolve(result);
    };
    const data = (chunk) => {
      value += chunk;
      if (value.length > MB) finish('');
    };
    const end = () => finish(value);
    const error = () => finish('');
    const timer = setTimeout(() => finish(''), 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data);
    process.stdin.once('end', end);
    process.stdin.once('error', error);
    process.stdin.resume();
  });
}

async function waitForDevRam(ctx, id) {
  const started = ctx.now();
  const deadline = started + ctx.devMaxWaitS * 1000;
  let waited = false;
  let timedOut = false;
  try {
    let free = freeMb(ctx);
    while (free < ctx.minFreeMb && ctx.now() < deadline) {
      if (isOff(ctx)) return;
      waited = true;
      await ctx.sleep(Math.min(2000, Math.max(0, deadline - ctx.now())));
      free = freeMb(ctx);
    }
    timedOut = free < ctx.minFreeMb;
  } catch (error) {
    if (!waited) return;
    timedOut = true;
    log(ctx, 'hook-pre', id, seconds(ctx, started), `dev RAM error: ${error.message}`);
  }
  const elapsed = waited ? seconds(ctx, started) : 0;
  if (!waited) return;
  log(ctx, 'hook-pre', id, elapsed, timedOut ? 'dev RAM timeout' : 'dev RAM available');
  ctx.out(`${JSON.stringify({
    systemMessage: `heavy-gate: dev server waited ${elapsed}s for free RAM${timedOut ? ', starting anyway' : ''}`
  })}\n`);
}

async function hook(ctx, mode) {
  let data;
  try { data = JSON.parse(await ctx.input()); }
  catch { return 0; }
  if (!data || typeof data !== 'object') return 0;
  const id = typeof data.tool_use_id === 'string' && data.tool_use_id ? data.tool_use_id : '';
  if (mode === 'hook-post') {
    if (!id) return 0;
    const file = leaseFile(ctx, id);
    let lease;
    try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return 0; throw error; }
    if (lease?.bg === false) removeFile(file);
    return 0;
  }
  if (!['Bash', 'PowerShell'].includes(data.tool_name)) return 0;
  const command = data.tool_input?.command;
  if (mode === 'hook-pre' && !isHeavy(command) && isDevServer(command)) {
    await waitForDevRam(ctx, id || 'dev-server');
    return 0;
  }
  if (!isHeavy(command)) return 0;
  const session = typeof data.session_id === 'string' ? data.session_id : '';
  const bg = data.tool_input.run_in_background === true;
  const lease = makeLease(ctx, id || `sess-${session}-${ctx.now()}`, session, data.tool_input.command, 'hook', bg);
  const result = await acquire(ctx, lease, mode);
  if (!result.off && (!result.error || result.timeout) && (result.timeout || result.waited > 0)) {
    const message = result.timeout ? `heavy-gate: waited ${result.waited}s, starting anyway` :
      `heavy-gate: waited ${result.waited}s for a free slot/RAM`;
    ctx.out(`${JSON.stringify({ systemMessage: message })}\n`);
  }
  return 0;
}

async function waitForRam(ctx, args) {
  let min = ctx.minFreeMb;
  let maxWait = ctx.maxWaitS;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i + 1] === undefined) throw Error('missing wait option value');
    if (args[i] === '--min-free') min = numberSetting(args[i + 1], min, 0);
    else if (args[i] === '--max-wait') maxWait = numberSetting(args[i + 1], maxWait, 0);
    else throw Error('unknown wait option');
  }
  const started = ctx.now();
  const deadline = started + maxWait * 1000;
  let waited = false;
  let free = freeMb(ctx);
  while (free < min && ctx.now() < deadline) {
    if (isOff(ctx)) return 0;
    waited = true;
    await ctx.sleep(Math.min(2000, deadline - ctx.now()));
    free = freeMb(ctx);
  }
  if (waited) ctx.err(`heavy-gate: waited ${seconds(ctx, started)}s for free RAM (${free} MB)\n`);
  return 0;
}

async function runCommand(ctx, args, gated = true) {
  if (args[0] !== '--' || args.length < 2) return 0;
  const command = args[1];
  const commandArgs = args.slice(2);
  const lease = makeLease(ctx, `run-${process.pid}-${randomUUID()}`, '', [command, ...commandArgs].join(' '), 'run');
  const heavy = gated && heavySegment([command, ...commandArgs]);
  const release = () => {
    if (!heavy) return;
    try { removeFile(leaseFile(ctx, lease.id)); }
    catch (error) { log(ctx, 'run', lease.id, 0, `error: ${error.message}`); }
  };
  if (heavy && (await acquire(ctx, lease, 'run')).off) return 0;
  process.on('exit', release);
  try {
    return await new Promise((resolve) => {
      let child;
      const forward = (signal) => {
        try { child.kill(signal); }
        catch (error) { log(ctx, 'run', lease.id, 0, `error: ${error.message}`); }
      };
      const interrupt = () => forward('SIGINT');
      const terminate = () => forward('SIGTERM');
      const finish = (code) => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        resolve(code);
      };
      try {
        child = ctx.spawn(command, commandArgs, { stdio: 'inherit', shell: false, windowsHide: true });
      } catch (error) {
        log(ctx, 'run', lease.id, 0, `error: ${error.message}`);
        ctx.err(`${error.message}\n`); finish(1); return;
      }
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      child.once('error', (error) => {
        log(ctx, 'run', lease.id, 0, `error: ${error.message}`);
        ctx.err(`${error.message}\n`); finish(1);
      });
      child.once('exit', (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] || 1)));
    });
  } finally {
    release();
    process.off('exit', release);
  }
}

function status(ctx) {
  let free = 0;
  let live = [];
  try { free = freeMb(ctx); live = liveLeases(ctx); }
  catch (error) { log(ctx, '--status', '-', 0, `error: ${error.message}`); }
  ctx.out(`${JSON.stringify({
    max: ctx.max, minFreeMb: ctx.minFreeMb, freeMb: free, live, off: isOff(ctx)
  })}\n`);
}

async function main(args, ctx = runtime()) {
  const mode = args[0];
  try {
    if (isOff(ctx) && mode !== 'hook-post') return 0;
    if (mode === '--self-test') return await selfTest(ctx.out);
    try { configure(ctx); }
    catch (error) {
      if (mode !== 'wait' && mode !== 'hook-post') log(ctx, mode || 'unknown', '-', 0, `error: ${error.message}`);
      if (mode === 'run') return await runCommand(ctx, args.slice(1), false);
      if (mode === '--status') status(ctx);
      return 0;
    }
    if (mode === 'hook-pre' || mode === 'hook-post') return await hook(ctx, mode);
    if (mode === 'wait') return await waitForRam(ctx, args.slice(1));
    if (mode === 'run') return await runCommand(ctx, args.slice(1));
    if (mode === '--status') status(ctx);
  } catch (error) {
    if (mode === '--self-test') {
      ctx.out(`FAIL self-test: ${error.message}\n`);
      return 1;
    }
    // A read-only wait must remain read-only even on invalid settings and internal errors.
    if (mode !== 'wait' && mode !== 'hook-post') log(ctx, mode || 'unknown', '-', 0, `error: ${error.message}`);
  }
  return 0;
}

async function selfTest(out) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gate-test-'));
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  let index = 0;
  const fixture = (env = {}) => {
    let now = Date.now();
    let output = '';
    let errors = '';
    const ctx = runtime({
      env, dir: path.join(root, `heavy-${index++}`), sentinel: path.join(root, 'off'),
      now: () => now, freemem: () => 8000 * MB, alive: () => true, processStart: () => '123',
      sleep: async (ms) => { now += ms; }, input: async () => '',
      out: (value) => { output += value; }, err: (value) => { errors += value; }
    });
    return { ctx, output: () => output, errors: () => errors };
  };
  const seed = (ctx, id, changes = {}) => {
    fs.mkdirSync(ctx.dir, { recursive: true });
    const lease = { ...makeLease(ctx, id, 's', 'vitest', 'hook'), ...changes };
    fs.writeFileSync(leaseFile(ctx, id), JSON.stringify(lease));
    return lease;
  };
  const input = (ctx, command, id = 'test', bg = false, tool = 'Bash') => {
    ctx.input = async () => JSON.stringify({
      session_id: 's', tool_name: tool, tool_use_id: id, tool_input: { command, run_in_background: bg }
    });
  };
  const heavyCommands = [
    "bash -c 'if true; then npm test; fi'", "bash -c 'for f in a; do pytest -q; done'",
    "sh -c '{ tsc; }'", "bash -c '(npm test)'", 'time ! { tsc; }',
    "bash -c 'npm test'", 'sh -lc "pytest -q"', "bash -ec 'npm test'",
    "env FOO=bar bash -c 'npm test'", 'env FOO=bar npm test',
    "dash -ec 'npm test'", "zsh -lc 'pytest -q'", "bash -c \"sh -c 'npm test'\"",
    'npx tsc --noEmit', 'cd frontend && npm run build', 'FOO=1 vitest run a.test.ts',
    'python -m pytest -q', 'uv run pytest tests/x.py', 'cargo build --release', 'npm ci', 'pnpm install',
    'node_modules/.bin/vitest run', 'C:\\x\\node_modules\\.bin\\tsc.cmd -p .',
    'git status && npx vitest run', 'eslint .', 'docker compose build',
    'pnpm exec tsc -p .', 'yarn vitest run', 'poetry run pytest', 'py -m pytest',
    'timeout 30 nice -n 5 npx vitest', 'FOO="two words" BAR=2 tsc', 'NPX.EXE TSC.CMD --noEmit',
    'echo ok || pytest', 'ls; npm run typecheck:all', 'ls | jest', 'ls\nmocha',
    'ava', 'playwright test', 'cypress run', 'bun add x', 'npm i', 'npm t', 'npm run test:unit',
    'pnpm run lint:all', 'yarn run check', 'bun build', 'cargo test', 'cargo check', 'cargo clippy', 'cargo run',
    'vite build', 'webpack', 'next build', 'nuxt build', 'astro build', 'rollup -c', 'esbuild x.ts --bundle',
    'go test ./...', 'go build', 'mvn test', 'gradle build', './gradlew test', 'dotnet build', 'dotnet test',
    'docker build .', 'DOCKER.EXE COMPOSE BUILD', 'msbuild', 'eslint src/', 'eslint "src/**/*.ts"',
    '"C:\\Program Files\\tools\\tsc.exe" --noEmit',
    'echo ready & pytest -q', '& npm test', '& "C:\\Program Files\\nodejs\\npm.cmd" test', '& pytest',
    '& "C:\\Program Files\\tools\\pytest.ps1" -q',
    'npm run lint & npx tsc --noEmit', 'npm exec -- vitest run', 'npm exec -- tsc --noEmit',
    'pnpm exec vitest', 'pnpm dlx tsc -p .', 'yarn dlx vitest', 'bunx vitest', 'npm x vitest',
    'npm run e2e', 'npm run e2e:ci', 'npm run test:unit',
    'make', 'make test', 'make tests', 'make check', 'make build', 'make all', 'make ci', 'make e2e',
    'make lint', 'make typecheck', 'mingw32-make test', 'nmake build'
  ];
  const lightCommands = [
    "bash -c 'if true; then echo hi; fi'", "sh -c '{ echo tsc; }'", "bash -c '(echo npm test)'",
    "bash -c 'echo hi'", "env FOO=bar sh -lc 'echo hi'",
    'tsc --version', 'git commit -m "run tests"', 'rg vitest src', 'node scripts/x.mjs', 'npm ls',
    'echo npm install', 'cat package.json', 'eslint src/a.ts', '', 'tsc -v', 'tsc --help',
    'vitest --help', 'pytest -h', 'webpack --version', 'npm view x', 'ls', 'npx tsc --version',
    'echo "text; npm install"', "git commit -m 'test || vitest'", 'vite dev', 'rollup x.js',
    'esbuild x.ts', 'docker compose ps', 'go version', 'npm run format', 'FOO=1 echo vitest',
    'echo "unfinished', 'npx', 'nice', 'pnpm exec', 'python -m', 'tsc --help --all', null, {}, 42,
    'ls 2>&1', 'git status 2>&1 | head', 'echo a &> out.txt', 'node x.js >&2', 'echo "a & pytest"',
    'npm exec -- prettier --check a.ts', 'make -n test', 'make -n build', 'make help', 'make clean'
  ];
  const devCommands = [
    'npm run dev', 'cd frontend && npm run dev -- --port 5181', 'npx vite --port 5181',
    'npx tsx server.ts', 'tsx watch src/server.ts', 'yarn start', 'uvicorn app.main:app --reload',
    'python manage.py runserver'
  ];
  const nonDevCommands = [
    'npm run build', 'vite build', 'npx tsx scripts/seed.ts', 'node server.js', 'npm test',
    'echo npm run dev'
  ];
  for (const command of heavyCommands) test(`heavy: ${command}`, () => assert.equal(isHeavy(command), true));
  test('nested shell inspection stops at depth three', () => {
    assert.equal(isHeavy("bash -c 'npm test'", 2), true);
    assert.equal(isHeavy("bash -c 'npm test'", 3), false);
  });
  for (const command of lightCommands) test(`light: ${command}`, () => assert.equal(isHeavy(command), false));
  for (const command of devCommands) test(`dev server: ${command}`, () => assert.equal(isDevServer(command), true));
  for (const command of nonDevCommands) {
    test(`not dev server: ${command}`, () => assert.equal(isDevServer(command), false));
  }
  test('heavy commands take precedence over dev server classification', () => {
    assert.equal(isHeavy('npm run build'), true);
    assert.equal(isDevServer('npm run build'), false);
    assert.equal(isHeavy('webpack serve'), true);
    assert.equal(isDevServer('webpack serve'), false);
  });
  test('two live leases deny admission', () => {
    const { ctx } = fixture();
    seed(ctx, 'one'); seed(ctx, 'two');
    assert.equal(tryAdmission(ctx, makeLease(ctx, 'third', '', 'tsc', 'hook')).admitted, false);
    assert.equal(liveLeases(ctx).length, 2);
  });
  test('expired lease is pruned and replaced', () => {
    const { ctx } = fixture();
    seed(ctx, 'one'); seed(ctx, 'expired', { since: ctx.now() - 800_000 });
    assert.equal(tryAdmission(ctx, makeLease(ctx, 'third', '', 'tsc', 'hook')).admitted, true);
    assert.equal(fs.existsSync(leaseFile(ctx, 'expired')), false);
    assert.equal(liveLeases(ctx).length, 2);
  });
  test('low RAM denies admission', () => {
    const { ctx } = fixture();
    seed(ctx, 'one'); ctx.freemem = () => 100 * MB;
    assert.equal(tryAdmission(ctx, makeLease(ctx, 'two', '', 'tsc', 'hook')).admitted, false);
  });
  test('dead run pid pruned, live run pid retained', () => {
    const { ctx } = fixture();
    ctx.alive = (pid) => pid !== 987;
    seed(ctx, 'dead', { kind: 'run', pid: 987 });
    seed(ctx, 'alive', { kind: 'run', pid: 986 });
    assert.deepEqual(liveLeases(ctx).map((lease) => lease.id), ['alive']);
    assert.equal(fs.existsSync(leaseFile(ctx, 'dead')), false);
  });
  test('live lease creation times use one cached batch probe per invocation', () => {
    let probes = 0;
    const dir = path.join(root, `batch-${index++}`);
    const ctx = runtime({ dir, batchProbe: (pids) => {
      probes++;
      assert.ok(pids.includes(process.pid));
      return new Map([[process.pid, '123']]);
    } });
    fs.mkdirSync(dir, { recursive: true });
    seed(ctx, 'one', { kind: 'run', pid: process.pid, pid_start: '123' });
    seed(ctx, 'two', { kind: 'run', pid: process.pid, pid_start: '123' });
    assert.equal(liveLeases(ctx).length, 2);
    assert.equal(liveLeases(ctx).length, 2);
    assert.equal(makeLease(ctx, 'self', '', 'tsc', 'run').pid_start, '123');
    assert.equal(probes, 1);
  });
  test('corrupt leases pruned; exact TTL boundary remains live', () => {
    const { ctx } = fixture();
    seed(ctx, 'boundary', { since: ctx.now() - 720_000 });
    fs.writeFileSync(leaseFile(ctx, 'bad'), '{');
    fs.writeFileSync(leaseFile(ctx, 'invalid'), 'null');
    assert.equal(liveLeases(ctx).length, 1);
    assert.equal(fs.existsSync(leaseFile(ctx, 'bad')), false);
    assert.equal(fs.existsSync(leaseFile(ctx, 'invalid')), false);
  });
  test('light hook: silent and no state directory', async () => {
    const f = fixture(); input(f.ctx, 'ls');
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('heavy foreground pre/post', async () => {
    const f = fixture(); input(f.ctx, 'tsc --noEmit', '../a\\b');
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    const lease = JSON.parse(fs.readFileSync(leaseFile(f.ctx, '../a\\b'), 'utf8'));
    assert.equal(lease.ttlS, 720); assert.equal(lease.bg, false); assert.equal(lease.pid, null);
    assert.equal(f.output(), '');
    assert.equal(fs.existsSync(path.join(f.ctx.dir, 'admit.lock')), false);
    assert.equal(fs.existsSync(path.join(f.ctx.dir, 'gate.log')), false);
    assert.equal(await main(['hook-post'], f.ctx), 0);
    assert.equal(liveLeases(f.ctx).length, 0);
  });
  test('background lease survives post', async () => {
    const f = fixture(); input(f.ctx, 'pytest', 'background', true, 'PowerShell');
    await main(['hook-pre'], f.ctx);
    await main(['hook-post'], f.ctx);
    const [lease] = liveLeases(f.ctx);
    assert.equal(lease.bg, true); assert.equal(lease.ttlS, 2700);
    assert.equal(f.output(), '');
  });
  test('disabled hooks do nothing', async () => {
    const f = fixture({ HEAVY_GATE_OFF: '1' }); input(f.ctx, 'npm run dev');
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('disabled background hook has no lease and disabled post releases foreground lease', async () => {
    const f = fixture({ HEAVY_GATE_OFF: '1' });
    input(f.ctx, 'pytest', 'disabled-bg', true);
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(fs.existsSync(leaseFile(f.ctx, 'disabled-bg')), false);
    seed(f.ctx, 'foreground', { bg: false });
    input(f.ctx, '', 'foreground');
    assert.equal(await main(['hook-post'], f.ctx), 0);
    assert.equal(fs.existsSync(leaseFile(f.ctx, 'foreground')), false);
    assert.equal(f.output(), '');
  });
  test('sentinel disables every mode without reading stdin', async () => {
    const f = fixture();
    fs.writeFileSync(f.ctx.sentinel, '');
    f.ctx.input = async () => { throw Error('must not read stdin'); };
    try {
      for (const mode of ['hook-pre', 'hook-post', 'wait', 'run', '--status', '--self-test']) {
        assert.equal(await main([mode], f.ctx), 0);
      }
      assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
    } finally { removeFile(f.ctx.sentinel); }
  });
  test('invalid stdin and unrelated tools are silent', async () => {
    const f = fixture();
    for (const value of ['{', 'null', '[]', '{}']) {
      f.ctx.input = async () => value;
      assert.equal(await main(['hook-pre'], f.ctx), 0);
    }
    input(f.ctx, 'tsc', 'other', false, 'Read');
    await main(['hook-pre'], f.ctx);
    assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('dev server waits for RAM without a lease and reports once', async () => {
    const f = fixture(); input(f.ctx, 'npm run dev');
    let reads = 0;
    f.ctx.freemem = () => (++reads === 1 ? 100 : 8000) * MB;
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.deepEqual(JSON.parse(f.output()), {
      systemMessage: 'heavy-gate: dev server waited 2s for free RAM'
    });
    assert.equal(fs.existsSync(f.ctx.dir) &&
      fs.readdirSync(f.ctx.dir).some((name) => name.startsWith('lease-')), false);
    assert.equal(fs.readFileSync(path.join(f.ctx.dir, 'gate.log'), 'utf8').trim().split('\n').length, 1);
  });
  test('dev server with enough RAM is silent and creates no state', async () => {
    const f = fixture(); input(f.ctx, 'npm run dev');
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('dev server wait timeout fails open without a lease', async () => {
    const f = fixture({ HEAVY_GATE_DEV_MAX_WAIT_S: '3' }); input(f.ctx, 'npm run dev');
    f.ctx.freemem = () => 100 * MB;
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.deepEqual(JSON.parse(f.output()), {
      systemMessage: 'heavy-gate: dev server waited 3s for free RAM, starting anyway'
    });
    assert.equal(fs.readdirSync(f.ctx.dir).some((name) => name.startsWith('lease-')), false);
  });
  test('wait above threshold creates no files', async () => {
    const f = fixture();
    assert.equal(await main(['wait'], f.ctx), 0);
    assert.equal(f.output(), ''); assert.equal(f.errors(), '');
    assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('wait polls RAM using overrides and stays read-only', async () => {
    const f = fixture();
    let reads = 0;
    f.ctx.freemem = () => (++reads < 3 ? 200 : 500) * MB;
    await main(['wait', '--min-free', '400', '--max-wait', '8'], f.ctx);
    assert.equal(f.errors(), 'heavy-gate: waited 4s for free RAM (500 MB)\n');
    assert.equal(f.output(), ''); assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('wait timeout and failures stay read-only and exit zero', async () => {
    const f = fixture(); f.ctx.freemem = () => MB;
    assert.equal(await main(['wait', '--max-wait', '1'], f.ctx), 0);
    assert.equal(f.errors(), 'heavy-gate: waited 1s for free RAM (1 MB)\n');
    assert.equal(await main(['wait', '--min-free', 'invalid'], f.ctx), 0);
    f.ctx.freemem = () => { throw Error('RAM failure'); };
    assert.equal(await main(['wait'], f.ctx), 0);
    f.ctx.env.HEAVY_GATE_MAX = 'bad';
    assert.equal(await main(['wait'], f.ctx), 0);
    assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('waiting hook admits after RAM returns and logs once', async () => {
    const f = fixture(); input(f.ctx, 'vitest');
    let reads = 0;
    f.ctx.freemem = () => (++reads === 1 ? 100 : 8000) * MB;
    await main(['hook-pre'], f.ctx);
    assert.deepEqual(JSON.parse(f.output()), { systemMessage: 'heavy-gate: waited 2s for a free slot/RAM' });
    assert.equal(liveLeases(f.ctx).length, 1);
    assert.equal(fs.readFileSync(path.join(f.ctx.dir, 'gate.log'), 'utf8').trim().split('\n').length, 1);
  });
  test('hook timeout admits anyway, preserves count and reports', async () => {
    const f = fixture({ HEAVY_GATE_MAX_WAIT_S: '3' }); input(f.ctx, 'vitest', 'third');
    seed(f.ctx, 'one'); seed(f.ctx, 'two');
    await main(['hook-pre'], f.ctx);
    assert.equal(liveLeases(f.ctx).length, 3);
    assert.deepEqual(JSON.parse(f.output()), { systemMessage: 'heavy-gate: waited 3s, starting anyway' });
    assert.match(fs.readFileSync(path.join(f.ctx.dir, 'gate.log'), 'utf8'), /timeout-admit/);
  });
  test('fresh lock denies and stale lock is retaken', () => {
    const f = fixture(); seed(f.ctx, 'one');
    const lock = path.join(f.ctx.dir, 'admit.lock');
    fs.mkdirSync(lock);
    const lease = makeLease(f.ctx, 'two', '', 'tsc', 'hook');
    assert.equal(tryAdmission(f.ctx, lease).lockBusy, true);
    const old = new Date(f.ctx.now() - 31_000);
    fs.utimesSync(lock, old, old);
    assert.equal(tryAdmission(f.ctx, lease).admitted, true);
    assert.equal(fs.existsSync(lock), false);
  });
  test('lock timeout fails open without stealing a fresh lock', async () => {
    const f = fixture({ HEAVY_GATE_MAX_WAIT_S: '0.2' }); input(f.ctx, 'tsc');
    fs.mkdirSync(path.join(f.ctx.dir, 'admit.lock'), { recursive: true });
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(fs.existsSync(path.join(f.ctx.dir, 'admit.lock')), true);
    assert.match(f.output(), /starting anyway/);
  });
  test('filesystem failure fails open', async () => {
    const f = fixture(); input(f.ctx, 'tsc');
    fs.writeFileSync(f.ctx.dir, 'not a directory');
    assert.equal(await main(['hook-pre'], f.ctx), 0);
    assert.equal(f.output(), '');
  });
  test('status reports config and live leases', async () => {
    const f = fixture({ HEAVY_GATE_MAX: '3', HEAVY_GATE_MIN_FREE_MB: '1234' }); seed(f.ctx, 'one');
    await main(['--status'], f.ctx);
    const value = JSON.parse(f.output());
    assert.equal(value.max, 3); assert.equal(value.minFreeMb, 1234);
    assert.equal(value.freeMb, 8000); assert.equal(value.off, false); assert.equal(value.live.length, 1);
  });
  test('run owns a lease, forwards signals, returns child code and cleans up', async () => {
    const f = fixture();
    const signals = [];
    const interrupts = process.listenerCount('SIGINT');
    const terminations = process.listenerCount('SIGTERM');
    f.ctx.spawn = (command, args, options) => {
      assert.equal(command, 'vitest'); assert.deepEqual(args, ['run', 'one file.test.ts']);
      assert.deepEqual(options, { stdio: 'inherit', shell: false, windowsHide: true });
      const [lease] = liveLeases(f.ctx);
      assert.equal(lease.kind, 'run'); assert.equal(lease.pid, process.pid); assert.equal(lease.ttlS, 7200);
      const child = new EventEmitter();
      child.kill = (signal) => { signals.push(signal); };
      queueMicrotask(() => {
        process.emit('SIGINT'); process.emit('SIGTERM'); child.emit('exit', 7, null);
      });
      return child;
    };
    assert.equal(await main(['run', '--', 'vitest', 'run', 'one file.test.ts'], f.ctx), 7);
    assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);
    assert.equal(liveLeases(f.ctx).length, 0);
    assert.equal(process.listenerCount('SIGINT'), interrupts);
    assert.equal(process.listenerCount('SIGTERM'), terminations);
  });
  test('light run bypasses admission even with low RAM', async () => {
    const f = fixture(); f.ctx.freemem = () => { throw Error('must not check RAM'); };
    f.ctx.spawn = () => {
      assert.equal(fs.existsSync(f.ctx.dir), false);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    assert.equal(await main(['run', '--', 'node', 'script.js'], f.ctx), 0);
    assert.equal(fs.existsSync(f.ctx.dir), false);
  });
  test('run spawn error is reported and releases lease', async () => {
    const f = fixture();
    f.ctx.spawn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', Error('spawn vitest ENOENT')));
      return child;
    };
    assert.equal(await main(['run', '--', 'vitest'], f.ctx), 1);
    assert.equal(f.errors(), 'spawn vitest ENOENT\n');
    assert.equal(liveLeases(f.ctx).length, 0);
  });
  test('run fails open on bad configuration and spawns exactly once', async () => {
    const f = fixture({ HEAVY_GATE_MAX: 'bad' });
    let spawned = 0;
    f.ctx.spawn = () => {
      spawned += 1;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    assert.equal(await main(['run', '--', 'tsc'], f.ctx), 0);
    assert.equal(spawned, 1); assert.equal(liveLeases(f.ctx).length, 0);
  });
  test('log truncation keeps last 100 KB', () => {
    const f = fixture(); fs.mkdirSync(f.ctx.dir);
    const file = path.join(f.ctx.dir, 'gate.log');
    fs.writeFileSync(file, 'x'.repeat(201 * 1024));
    log(f.ctx, 'hook-pre', 'id', 2, 'low RAM');
    assert.equal(fs.statSync(file).size, 100 * 1024);
    assert.match(fs.readFileSync(file, 'utf8'), /low RAM\n$/);
  });
  let passed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); passed += 1; }
      catch (error) { out(`FAIL ${name}: ${error.message}\n`); }
    }
  } finally {
    // Resolve and verify the exact, task-owned temp directory before recursive cleanup.
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('heavy-gate-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  out(`PASS ${passed}/${tests.length}\n`);
  return passed === tests.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { process.exitCode = process.argv[2] === '--self-test' ? 1 : 0; }
}
