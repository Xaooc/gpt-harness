#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync, appendFileSync, closeSync, constants, createReadStream, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { processRows, readProcess } from '../lib/luna-runtime.mjs';

const HEADINGS = ['## Changes', '## Verification', '## Deviations', '## Not done'];
// Never readable by the agent (see secretArgs): sign-ins, keys and tokens of the harness, its providers and the shell.
const SECRET_HOME_PATHS = ['.claude', '.claude.json', '.codex', '.config', '.mlai', '.mlai-accounts', '.gemini',
  '.local/share/keyrings', '.password-store', '.bash_history', '.zsh_history', '.python_history', '.node_repl_history'];
const SECRET_READABLE = ['.claude/scripts'];
const SECRET_NAME = /secret|credential|password|admin_access|^\.env(\..+)?$/i;
const PROMPT_LIMIT = 28_000;
const START_EVENTS = new Set(['inference_progress', 'tool', 'command', 'answer']);
const USAGE = 'usage: mlai.sh [-w|-r] [-C dir] [-o out.md] [-e low|medium|high|xhigh|max] ' +
  '[-m model] (-f prompt.md | "prompt text")';
// The CLI's result.error can be an object ({code, message}); String() would log it as "[object Object]".
const errorText = (value) => value && typeof value === 'object'
  ? [value.code, value.message].filter(Boolean).join(': ') || JSON.stringify(value) : value;
// The CLI can report an error as the literal text "[object Object]" next to a code (http_error): keep the code then.
const cliError = (result) => {
  const text = oneLine(result?.error);
  const code = oneLine(result?.code);
  if (!text || text === '[object Object]') return code ? `mlai: ${code}` : '';
  return code && !text.includes(code) ? `${code}: ${text}` : text;
};
const oneLine = (text) => String(errorText(text) ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim();
const clip = (text, length) => Array.from(oneLine(text)).slice(0, length).join('');
const fields = (text) => Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes('='))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const readFields = (file) => { try { return fields(readFileSync(file, 'utf8')); } catch { return {}; } };
const alive = (pid, started) => {
  const row = readProcess(pid);
  return row && row.state !== 'Z' && (!started || row.started === String(started));
};

class Failure extends Error {
  constructor(message, rc = 1, state = 'failed', reason = '') {
    super(oneLine(message));
    Object.assign(this, { rc, state, reason });
  }
}

function parseArgs(argv) {
  const options = { dir: process.cwd(), out: '', file: '', effort: 'medium', model: 'pixis', write: false };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { index += 1; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = arg[offset];
      if (flag === 'w' || flag === 'r') { options.write = flag === 'w'; continue; }
      const key = { C: 'dir', o: 'out', f: 'file', e: 'effort', m: 'model' }[flag];
      if (!key) throw new Failure(`unknown option: ${arg}\n${USAGE}`, 2);
      const value = arg.slice(offset + 1) || argv[++index];
      if (!value) throw new Failure(`missing value for -${flag}\n${USAGE}`, 2);
      options[key] = value;
      break;
    }
  }
  options.prompt = argv.slice(index).join(' ');
  return options;
}

function integerEnv(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Failure(`${name} must be a non-negative integer`, 2);
  }
  return Number(value);
}

function refuseSymlink(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Failure(`output symlink refused: ${file}`, 2);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function atomicWrite(file, text) {
  refuseSymlink(file);
  const temporary = `${file}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let fd;
  let created = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, text, 'utf8');
    closeSync(fd);
    fd = undefined;
    refuseSymlink(file);
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) { try { unlinkSync(temporary); } catch {} }
  }
}

// Same mkdir/owner/token/rename protocol and stale-owner limits as the Gemini output lock.
class OutputLock {
  constructor(directory) {
    this.directory = directory;
    this.token = '';
  }

  remove(directory) {
    for (const name of ['owner', 'owner.tmp']) {
      try { unlinkSync(path.join(directory, name)); } catch {}
    }
    try { rmdirSync(directory); } catch {}
  }

  restore(directory) {
    try {
      if (existsSync(this.directory)) throw new Error('successor already owns lock');
      renameSync(directory, this.directory);
    } catch {}
  }

  reclaim() {
    const ownerFile = path.join(this.directory, 'owner');
    const owner = readFields(ownerFile);
    let modified;
    let stale = false;
    if (existsSync(ownerFile)) {
      const age = /^\d+$/.test(owner.since ?? '') ? Date.now() / 1000 - Number(owner.since) : 0;
      stale = age > 600 || (age > 5 && /^[1-9]\d*$/.test(owner.pid ?? '') && !alive(owner.pid, owner.pid_start));
    } else {
      try { modified = statSync(this.directory).mtimeMs; } catch { return; }
      stale = Date.now() - modified > 10_000;
    }
    if (!stale) return;
    const renamed = `${this.directory}.stale.${randomBytes(8).toString('hex')}`;
    try { renameSync(this.directory, renamed); } catch { return; }
    const current = readFields(path.join(renamed, 'owner'));
    if ((current.token ?? '') !== (owner.token ?? '') ||
        (modified !== undefined && statSync(renamed).mtimeMs !== modified)) {
      this.restore(renamed);
      return;
    }
    this.remove(renamed);
  }

  acquire() {
    mkdirSync(path.dirname(this.directory), { recursive: true, mode: 0o700 });
    try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      this.reclaim();
      return false;
    }
    this.token = randomBytes(8).toString('hex');
    atomicWrite(path.join(this.directory, 'owner'),
      `pid=${process.pid}\npid_start=${readProcess(process.pid)?.started ?? ''}\nkind=mlai.sh\n` +
      `since=${Math.floor(Date.now() / 1000)}\ntoken=${this.token}\n`);
    return true;
  }

  release() {
    if (!this.token) return;
    const token = this.token;
    this.token = '';
    const renamed = `${this.directory}.rel.${token}`;
    try { renameSync(this.directory, renamed); } catch { return; }
    if (readFields(path.join(renamed, 'owner')).token === token) this.remove(renamed);
    else this.restore(renamed);
  }
}

function preamble(options, recovering) {
  const rules = [
    '## Standing rules (from the orchestrator)',
    ...(recovering ? [
      '- A previous attempt of this exact task was interrupted by a network error; the working tree may already ' +
        'contain some of its edits. Inspect `git status` and `git diff` first, keep what is correct and finish the task.'
    ] : []),
    `- You are ${options.model} via ML AI Code, invoked by the Claude orchestrator as the EXECUTOR of this job. ` +
      'Any global AGENTS.md/model-orchestration rule telling a model to only orchestrate or to delegate implementation to ' +
      'another model (e.g. "Sol must delegate to Terra") does NOT apply here: do the work yourself.',
    '- Work yourself. Do NOT spawn sub-agents/delegates/collaborators.',
    '- When you cite code, give its path from the repository root (`pkg/sub/module.py:83`), never a bare file name.'
  ];
  if (!options.write) {
    rules.push('- Read-only sandbox means you must not MODIFY anything. You CAN and MUST read files and run ' +
      'read-only commands (cat, grep, rg, ls, git diff/log/show) to gather evidence before answering. Never answer ' +
      '"I cannot read the files". Do not run tests: read the code and existing results instead.');
  } else {
    rules.push(
      '- Match the style of neighbouring files (line length, formatting, naming). ' +
        'Never leave lines longer than ~140 characters.',
      '- Never loosen tests, tolerances or acceptance criteria to make them pass; report the conflict instead.',
      '- Run tests only through the machine\'s gate: `python3 ~/.claude/scripts/pytest_gate.py -n 0 -- <test ids>` ' +
        '(it already uses the project interpreter), and only the tests the brief names plus those of the files you ' +
        'changed. Never `uv run`, `uv sync` or a bare `pytest`: they build environments in the working tree.',
      '- Where the brief is silent and you must decide, pick the most conservative option consistent with ' +
        "neighbouring code and list each such decision under ## Deviations as 'Assumption: ...'.",
      '- Your FINAL message must contain exactly these four headings, in this order:',
      '  ## Changes       — files touched with file:line pointers and one line each on what changed',
      '  ## Verification  — each acceptance command you ran and its result ' +
        '(pass/fail counts, verbatim tail on failure)',
      "  ## Deviations    — anything you did differently from the brief and why (write 'None' if none)",
      "  ## Not done      — anything left undone or uncertain (write 'None' if none)"
    );
  }
  return rules.join('\n') + '\n\n';
}

function agentEnvironment(home) {
  // NODE_USE_ENV_PROXY=1: the CLI's bundled Node ignores HTTPS_PROXY without it, so its own requests went straight to
  // code.ml.ai, bypassing the VPN, and failed now and then as "Cannot reach the ML AI Code server" while its Python
  // engine used the proxy (2026-11-24: 2 more proxied connections per run with it; none during the failures).
  // MLAI_ENGINE_UPDATES=0 keeps the engine on the version the pinned CLI bundles.
  // MLAI_KEYCHAIN=file: the CLI otherwise keeps the sign-in in one system keychain entry shared by every home on Linux.
  // MLAI_TOKEN is dropped: an inherited token would sign every account in as the dispatcher's own.
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', MLAI_KEYCHAIN: 'file', MLAI_NO_UPDATE_CHECK: '1',
    MLAI_AUTO_UPDATE: '0', MLAI_ENGINE_UPDATES: '0', MLAI_NO_BROWSER: '1', MLAI_NO_TUI: '1' };
  delete env.MLAI_TOKEN;
  if (env.HTTPS_PROXY !== undefined || env.https_proxy !== undefined) {
    const proxy = env.HTTPS_PROXY ?? env.https_proxy;
    env.HTTP_PROXY = env.https_proxy = env.http_proxy = proxy;
    return env;
  }
  // Same lookup as the other wrappers (INSTALL.md): an explicit file, the harness default, then the legacy file.
  const files = env.LUNA_PROXY_ENV_FILE ? [env.LUNA_PROXY_ENV_FILE]
    : [path.join(home, '.config/luna-proxy.env'), path.join(home, '.config/bro-env.sh')];
  let config;
  for (const file of files) {
    try { config = readFileSync(file, 'utf8'); break; } catch {}
  }
  if (config === undefined) return env;
  const proxy = /(?:^|[\s;])HTTPS_PROXY=["']?([^"'\s;$]+)/m.exec(config)?.[1];
  if (proxy) env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = proxy;
  return env;
}

async function stopGroup(pgid) {
  const groupAlive = () => processRows().some((row) => row.group === pgid && row.state !== 'Z');
  const send = (signal) => {
    try { process.kill(-pgid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (!groupAlive()) return;
  send('SIGTERM');
  const deadline = performance.now() + 3000;
  while (groupAlive()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      send('SIGKILL');
      return;
    }
    await delay(Math.min(100, remaining));
  }
}

class Attempt {
  constructor(job) {
    this.job = job;
    this.lastLine = performance.now();
    this.credits = 0;
    this.waitingForStream = true;
    this.answer = '';
    this.stderr = '';
  }

  onLine(line) {
    this.lastLine = performance.now();
    let event;
    try { event = JSON.parse(line); } catch {
      if (this.job.nonJson++ < 5) this.job.log(`mlai: ${line}`);
      return;
    }
    if (typeof event?.type !== 'string' || !event.type) return;

    const { type, content } = event;
    const { job } = this;
    if (Number.isFinite(event.credits)) this.credits = event.credits;
    if (Array.isArray(event.changedFiles)) job.values.changed_files = event.changedFiles.length;

    let detail = content;
    switch (type) {
      case 'session':
        if (typeof event.id === 'string') job.values.mlai_session = event.id;
        detail = event.id;
        break;
      case 'tool': detail = [event.name, event.target].filter(Boolean).join(' '); break;
      case 'command': detail = event.command; break;
      case 'safety': detail = [event.decision, event.command ?? content].filter(Boolean).join(' '); break;
      case 'output':
        job.log(`output rc=${Number.isInteger(event.returncode) ? event.returncode : ''}`);
        return;
      case 'answer':
        if (typeof content === 'string') this.answer = content;
        break;
      case 'completion':
        detail = `changed_files=${job.values.changed_files}`;
        break;
      case 'finished': detail = event.state; break;
      case 'result':
        this.result = event;
        detail = [event.subtype, cliError(event) || event.state].filter(Boolean).join(' ');
        break;
    }

    const note = clip(detail, 200);
    if (type === 'stage' || type === 'tool' || type === 'command') job.values.last_note = note;
    if (type !== 'inference_progress' || note) job.log(note ? `${type}: ${note}` : type);
    if (job.values.state === 'starting' && (START_EVENTS.has(type) ||
        (type === 'stage' && /^Starting the agent/.test(content)))) {
      job.values.reached_running = 1;
      job.status('running');
    } else if (type === 'session') {
      job.status();
    }
  }

  async run([binary, ...args], prompt, env) {
    const { job } = this;
    const { signal } = job;
    signal.throwIfAborted();
    const child = spawn(binary, args, { cwd: job.options.dir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let onAbort;
    const stopped = new Promise((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let spawnError;
    child.once('error', (error) => { spawnError = error; });
    child.stdin.on('error', (error) => {
      // A CLI that exits before consuming the brief can still return a structured result.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') job.abort(error);
    });
    const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    stdout.on('line', (line) => {
      try { this.onLine(line); } catch (error) { job.abort(error); }
    });
    stderr.on('line', (line) => {
      this.stderr = (this.stderr + line + '\n').slice(-4096);
      try { job.log(`mlai stderr: ${line}`); } catch (error) { job.abort(error); }
    });
    for (const reader of [stdout, stderr]) reader.on('error', (error) => job.abort(error));
    try {
      const pid = child.pid;
      const started = readProcess(pid)?.started;
      if (pid && process.env.MLAI_SLOT) {
        atomicWrite(path.join(process.env.MLAI_SLOT, 'child.json'),
          JSON.stringify({ pid, pid_start: started ?? '', pgid: pid }) + '\n');
      }
      job.values.pid = pid ?? '';
      job.values.pid_start = started ?? '';
      job.status('starting');
      child.stdin.end(prompt, 'utf8');
      const code = await Promise.race([closed, stopped]);
      signal.throwIfAborted();
      return { code: this.result?.exitCode ?? code ?? 1, result: this.result, stderr: this.stderr,
        text: typeof this.result?.text === 'string' ? this.result.text : this.answer, spawnError };
    } finally {
      this.waitingForStream = false;
      signal.removeEventListener('abort', onAbort);
      try { if (child.pid) await stopGroup(child.pid); }
      finally {
        stdout.close();
        stderr.close();
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
        await Promise.race([closed, delay(1000, undefined, { ref: false })]);
        child.unref();
      }
    }
  }
}

class Job {
  constructor(options) {
    this.options = options;
    this.home = homedir();
    this.claudeHome = process.env.CLAUDE_HOME_DIR || path.join(this.home, '.claude');
    this.mlaiHome = process.env.MLAI_HOME || path.join(this.home, '.mlai');
    this.sessionId = randomUUID();
    this.maxSteps = 160;
    this.started = performance.now();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.nonJson = 0;
    this.values = {
      state: 'starting', pid: '', wrapper_pid: process.pid, wrapper_start: readProcess(process.pid)?.started ?? '',
      pid_start: '', owner: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.ppid}`,
      started: new Date().toISOString(),
      finished: '', rc: '', model: options.model, effort: options.effort,
      sandbox: options.write ? 'workspace-write' : 'read-only', dir: path.resolve(options.dir),
      engine: 'mlai', provider: 'mlai', account: process.env.MLAI_ACCOUNT || 'main', error: '', last_note: '',
      unavailable_reason: '', cli_exit: '', cli_subtype: '', elapsed_s: 0,
      mlai_session: '', credits: 0, changed_files: 0, attempts: 0, continues: 0, reached_running: 0
    };
  }

  abort(error) {
    if (!this.signal.aborted) this.controller.abort(error instanceof Failure ? error : new Failure(error.message));
  }

  log(message) {
    if (!this.ownsOutput) return;
    appendFileSync(this.logFd, `${new Date().toISOString()} ${oneLine(message)}\n`);
  }

  status(state = this.values.state) {
    if (state !== this.values.state || !this.statusWritten) this.log(`state=${state}`);
    this.values.state = state;
    this.values.elapsed_s = ((performance.now() - this.started) / 1000).toFixed(3);
    atomicWrite(`${this.options.out}.status`, Object.entries(this.values)
      .map(([key, value]) => `${key}=${oneLine(value)}\n`).join(''));
    if (this.activeFile) {
      atomicWrite(this.activeFile, JSON.stringify({
        v: 1, id: path.basename(this.activeFile, '.json'), out: this.options.out,
        owner: oneLine(this.values.owner), started: this.values.started,
        pid: this.values.pid || null, wrapper_pid: process.pid
      }) + '\n');
    }
    this.statusWritten = true;
  }

  prepareOutput() {
    const options = this.options;
    options.out = path.resolve(options.out || path.join(tmpdir(), `mlai-out.${randomBytes(8).toString('hex')}.md`));
    const parent = path.dirname(options.out);
    let existing = parent;
    while (!existsSync(existing)) existing = path.dirname(existing);
    if (realpathSync(existing) !== existing) throw new Failure(`output parent symlink refused: ${parent}`, 2);
    mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== parent) throw new Failure(`output parent symlink refused: ${parent}`, 2);
    for (const file of [options.out, `${options.out}.status`, `${options.out}.log`]) refuseSymlink(file);
    const previous = readFields(`${options.out}.status`);
    if ((previous.state === 'starting' || previous.state === 'running') &&
        (alive(previous.wrapper_pid, previous.wrapper_start) || alive(previous.pid, previous.pid_start))) {
      throw new Failure('output already in use', 1);
    }
    this.outputLock = new OutputLock(`${options.out}.mlai-lock`);
    if (!this.outputLock.acquire() && !this.outputLock.acquire()) throw new Failure('output already in use', 1);
    this.ownsOutput = true;
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND | constants.O_NOFOLLOW;
    this.outputFd = openSync(options.out, flags, 0o600);
    this.logFd = openSync(`${options.out}.log`, flags, 0o600);
    const active = path.join(process.env.LUNA_RUN_DIR || path.join(this.home, '.claude/luna-run'), 'mlai-active');
    mkdirSync(active, { recursive: true, mode: 0o700 });
    const id = createHash('sha1').update(options.out).digest('hex').slice(0, 16);
    this.activeFile = path.join(active, `${id}.json`);
    this.status();
  }

  validate() {
    const options = this.options;
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) {
      throw new Failure(`unknown effort: ${options.effort}`, 2);
    }
    if (options.file && options.prompt) throw new Failure('use either -f or prompt text', 2);
    let prompt = options.prompt;
    if (options.file) {
      options.file = path.resolve(options.file);
      try { prompt = readFileSync(options.file, 'utf8'); }
      catch { throw new Failure(`prompt file not readable: ${options.file}`, 2); }
    }
    if (!prompt.trim()) throw new Failure('prompt is missing or empty', 2);
    try {
      options.dir = realpathSync(options.dir);
      if (!statSync(options.dir).isDirectory()) throw new Error('not a directory');
    } catch { throw new Failure(`working directory does not exist: ${options.dir}`, 2); }
    const homes = new Set([realpathSync(this.home)]);
    try { homes.add(realpathSync(userInfo().homedir)); } catch {}
    const privateDirs = [...homes].flatMap((home) => ['.claude', '.ssh', '.codex', '.config', '.mlai']
      .map((name) => path.join(home, name))).map((directory) => {
      try { return realpathSync(directory); } catch { return directory; }
    });
    // Claude sessions without a project folder work in their own folder under ~/.config/Claude: those folders (and the
    // sessions' notes) are not secrets, unlike the rest of ~/.config.
    // Harness code the briefs point at (skills, scripts, plugin code) is readable, never a job folder; ~/.claude itself
    // holds credentials.
    const sessionRoots = [...homes].flatMap((home) => ['scratch-workspaces', 'side-session-notes']
      .map((name) => path.join(home, '.config', 'Claude', name)));
    const codeRoots = [...homes].flatMap((home) => ['skills', 'scripts', 'plugins/cache']
      .map((name) => path.join(home, '.claude', name)));
    const inside = (target, root) => target === root || target.startsWith(`${root}/`);
    const within = (target, roots) => roots.some((root) => inside(target, root));
    const open = (target) => !privateDirs.some((dir) => inside(target, dir)) || within(target, sessionRoots);
    this.readable = (target) => open(target) || within(target, codeRoots);
    if (options.dir === '/' || [...homes].some((home) => options.dir === home || home.startsWith(`${options.dir}/`)) ||
        !open(options.dir)) {
      // Exit 3 so the dispatcher runs this job on the next chain entry (Codex) instead of failing it: sessions without
      // a project folder work under ~/.config, which mlai's own sandbox must not get.
      throw new Failure(`mlai: refuses this project directory: ${options.dir}`, 3, 'unavailable', 'start');
    }
    this.values.dir = options.dir;
    return prompt;
  }

  record() {
    if (process.env.LUNA_NO_REGISTRY === '1') return;
    const registry = path.join(this.home, '.claude/scripts/learning/registry.mjs');
    if (existsSync(registry)) {
      spawnSync(process.execPath, [registry, 'record', this.options.out], { stdio: 'ignore', timeout: 2000 });
    }
  }

  finalize(result) {
    const { state, ...details } = result;
    Object.assign(this.values, details, { finished: new Date().toISOString() });
    try { this.status(state); }
    catch (error) {
      result = { state: 'failed', rc: 1, error: `finalize: ${oneLine(error.message)}` };
      try {
        const size = fstatSync(this.logFd).size;
        const tail = Buffer.alloc(Math.min(size, 64 * 1024));
        const length = readSync(this.logFd, tail, 0, tail.length, Math.max(0, size - tail.length));
        ftruncateSync(this.logFd, 0);
        writeSync(this.logFd, tail.subarray(0, length));
      } catch {}
      try {
        atomicWrite(`${this.options.out}.status`, `state=failed\nrc=1\nerror=${oneLine(result.error)}\n`);
      } catch {}
    }
    try { this.record(); } catch {}
    return result;
  }

  precheck() {
    const binary = path.resolve(process.env.MLAI_BIN || path.join(this.claudeHome, 'tools/mlai/node_modules/.bin/mlai'));
    try {
      accessSync(binary, constants.X_OK);
      if (!statSync(binary).isFile()) throw new Error();
    } catch { throw new Failure('mlai: CLI missing or not executable', 3, 'unavailable', 'start'); }

    let expires;
    try { expires = JSON.parse(readFileSync(path.join(this.mlaiHome, 'auth.json'), 'utf8'))?.expires; }
    catch { throw new Failure('mlai: not signed in', 3, 'unavailable', 'auth'); }
    if (!Number.isFinite(expires)) throw new Failure('mlai: not signed in', 3, 'unavailable', 'auth');
    if (expires <= Date.now()) throw new Failure('mlai: sign-in expired', 3, 'unavailable', 'auth');
    return binary;
  }

  invocation(brief) {
    const { write, model, effort, file } = this.options;
    const rules = preamble(this.options, write && this.values.reached_running === 1);
    const args = ['-p', '--mode', write ? 'auto' : 'plan', '-m', model];
    if (model === 'pixis-opus') args.push('--effort', effort === 'xhigh' ? 'max' : effort);
    // An own session id (not --no-session-persistence) so a run stopped by the step limit can be continued; the
    // session is removed when the wrapper ends.
    args.push('--max-steps', String(this.maxSteps), '--session-id', this.sessionId, '--output-format', 'stream-json');
    this.readDirs ??= this.readAccess(brief);
    args.push('--yes', ...this.readArgs(), ...this.secretArgs());
    let prompt = rules + brief;
    if (Array.from(prompt).length > PROMPT_LIMIT && file) {
      // A copy in a folder of its own: the brief's real folder may be private (~/.claude, ~/.config) and must not open.
      this.briefDir ??= mkdtempSync(path.join(tmpdir(), 'mlai-brief-'));
      const copy = path.join(this.briefDir, path.basename(file));
      writeFileSync(copy, brief, { mode: 0o600 });
      prompt = rules + `The full task brief is in the file ${copy}. Read it completely first and follow it exactly.`;
      args.push('--add-dir', this.briefDir);
      this.addDir = this.briefDir;
    }
    if (Array.from(prompt).length > PROMPT_LIMIT) throw new Failure(`mlai: prompt exceeds ${PROMPT_LIMIT} characters`, 2);
    return { args, prompt };
  }

  /** Folders outside the job directory the agent may read without an approval nobody can give in a headless run (it
   *  stops the run as `limited`, seen on J7b and J8): the project trees the job lives in and the existing absolute paths
   *  the brief names, never the private home folders. */
  readAccess(brief) {
    const dir = this.options.dir;
    const home = realpathSync(this.home);
    const found = new Set();
    // The top-level home folder of a path (/home/u/dev for /home/u/dev/repo-wt/j8): sibling repos and worktrees.
    const tree = (target) => target.startsWith(`${home}/`)
      ? path.join(home, target.slice(home.length + 1).split('/')[0]) : null;
    found.add(tree(dir));
    try {
      const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      if (common) { found.add(common); found.add(tree(common)); }
    } catch {}
    const roots = process.env.MLAI_READ_ROOTS ?? '~/dev:~/rpg:~/work';
    for (const root of roots.split(':').filter(Boolean)) found.add(root.replace(/^~(?=\/|$)/, home));
    found.delete(null);
    for (const candidate of [...found]) {
      found.delete(candidate);
      try { if (statSync(candidate).isDirectory()) found.add(realpathSync(candidate)); } catch {}
    }
    for (const match of brief.matchAll(/(?:^|[\s`'"(<\[=:])(\/[^\s`'")<>\],;]+)/g)) {
      let candidate = match[1].replace(/[.:]+$/, '');
      try {
        const stat = statSync(candidate);
        candidate = realpathSync(stat.isDirectory() ? candidate : path.dirname(candidate));
      } catch { continue; }
      found.add(candidate);
    }
    const dirs = [...found].filter((target) => target !== '/' && target !== dir && !target.startsWith(`${dir}/`) &&
      target !== home && this.readable(target)).sort();
    // Keep the outermost of nested folders.
    const kept = dirs.filter((target) => !dirs.some((other) => other !== target && target.startsWith(`${other}/`)));
    if (kept.length) this.log(`read access: ${kept.join(' ')}`);
    return kept;
  }

  /** Read access as CLI flags. Every root gets a Read rule: it lifts the approval for the file tools (read_file,
   *  list_files, Glob, search_text) and mounts nothing; the sandbox already reads /. An absolute path in a rule starts
   *  with // (verified 2026-11-25; one leading / never matches). Shell commands are let through only for --add-dir
   *  folders, but the CLI mounts each --add-dir read-only over everything inside it, the job folder included
   *  (2026-11-24: with ~/dev added every write in a ~/dev worktree failed with "Read-only file system"). So a root that
   *  holds the job folder is added as its other subfolders, level by level down to the job folder, shallow ones first;
   *  the engine honours the first 20 (J10 2026-11-25 stopped on `ls ~/dev/rpg-track-wt`, the folder itself). */
  readArgs() {
    const dir = this.options.dir;
    const roots = (this.readDirs ?? []).filter((target) => !/[()]/.test(target));
    const split = (target) => {
      if (!dir.startsWith(`${target}/`)) return [target];
      const next = path.join(target, dir.slice(target.length + 1).split('/')[0]);
      let entries = [];
      try { entries = readdirSync(target, { withFileTypes: true }); } catch {}
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(target, entry.name)).sort()
        .flatMap((child) => child === dir ? [] : child === next ? split(child) : this.readable(child) ? [child] : []);
    };
    const depth = (target) => target.split('/').length;
    const shell = roots.flatMap(split).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, 20);
    return [
      ...roots.flatMap((target) => ['--allowedTools', `Read(/${target})`, '--allowedTools', `Read(/${target}/**)`]),
      ...shell.flatMap((target) => ['--add-dir', target])
    ];
  }

  /** Places the agent must never read, as deny rules. Every run answers its own approvals (--yes, owner's decision
   *  2026-11-25: 92 approval stops in one day, 7 jobs lost), and the CLI's sandbox reads all of / except a few key
   *  folders, so secrets stay closed by deny rules: the engine applies a Read deny to the file tools and to the paths it
   *  finds in shell commands (verified 2026-11-25 on a canary under ~/.config: `cat` and read_file both refused). A
   *  denied folder that holds the job folder is denied as its other entries, level by level down to the job folder. */
  secretArgs() {
    const dir = this.options.dir;
    const home = realpathSync(this.home);
    const targets = new Set(SECRET_HOME_PATHS.map((name) => path.join(home, name)));
    for (const extra of (process.env.MLAI_DENY_PATHS ?? '').split(':').filter(Boolean)) {
      targets.add(extra.replace(/^~(?=\/|$)/, home));
    }
    // Secret-looking files at the top of the project trees and of the job's main repository (~/rpg/ADMIN_ACCESS.txt).
    const tops = [...(this.readDirs ?? [])];
    try {
      const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      if (common) tops.push(path.dirname(common));
    } catch {}
    for (const top of tops) {
      let entries = [];
      try { entries = readdirSync(top, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory() && SECRET_NAME.test(entry.name)) targets.add(path.join(top, entry.name));
      }
    }
    // The job folder and the harness scripts (pytest_gate.py; code, no secrets) stay readable inside denied folders.
    const keep = [dir, ...SECRET_READABLE.map((name) => path.join(home, name))];
    const around = (target) => {
      if (keep.includes(target)) return [];
      if (!keep.some((kept) => kept.startsWith(`${target}/`))) return [target];
      let entries = [];
      try { entries = readdirSync(target); } catch {}
      return entries.map((name) => path.join(target, name)).sort().flatMap(around);
    };
    const denied = [...targets].filter((target) => existsSync(target) && !/[()]/.test(target)).flatMap(around).slice(0, 200);
    if (denied.length) this.log(`denied: ${denied.length} secret paths`);
    return denied.flatMap((target) => ['--disallowedTools', `Read(/${target})`, '--disallowedTools', `Read(/${target}/**)`]);
  }

  /** The engine's own checks (rpg-track report 2026-11-25). Its baseline test runs went through `uv run pytest`, hit
   *  their time limit and failed the final gate even in read-only jobs, and built environments in the working tree: off
   *  everywhere. A read-only job also skips the final gate (citation checks that miss files cited by bare name, claimed
   *  vs run tests), the checker agent and acceptance tests: the reader verifies a report. A write job keeps the final
   *  gate, whose finds are real work (V6-171), and runs tests through pytest_gate with the project's interpreter. */
  engineChecks() {
    const env = { MINI_VERIFY_BASELINE: '0' };
    if (!this.options.write) Object.assign(env, { MINI_MLAI_FINAL_GATES: '0', MINI_CHECKER: '0', MINI_ACCEPTANCE: '0' });
    const python = this.projectPython();
    if (python && !process.env.PYTEST_GATE_LAUNCHER) env.PYTEST_GATE_LAUNCHER = JSON.stringify([python, '-m', 'pytest']);
    return env;
  }

  /** The interpreter of the job's project: its own .venv, else that of the main checkout of a worktree. */
  projectPython() {
    const roots = [this.options.dir];
    try {
      const common = execFileSync('git', ['-C', this.options.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      if (common) roots.push(path.dirname(common));
    } catch {}
    return roots.map((root) => path.join(root, '.venv', 'bin', 'python')).find((file) => existsSync(file)) ?? null;
  }

  gitOutside() {
    const dir = this.options.dir;
    try {
      const gitDir = realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim());
      return gitDir !== dir && !gitDir.startsWith(`${dir}/`);
    } catch { return false; }
  }

  /** The same session, resumed after it used all its steps for one turn (CLI exit 3, subtype error_max_turns). */
  continuation() {
    const { write, model, effort } = this.options;
    const args = ['-p', '--resume', this.sessionId, '--mode', write ? 'auto' : 'plan', '-m', model];
    if (model === 'pixis-opus') args.push('--effort', effort === 'xhigh' ? 'max' : effort);
    args.push('--max-steps', String(this.maxSteps), '--output-format', 'stream-json');
    if (this.addDir) args.push('--add-dir', this.addDir);
    args.push('--yes', ...this.readArgs(), ...this.secretArgs());
    const prompt = 'continue: you stopped at the step limit. Pick up exactly where you left off and finish the whole task.' +
      (write ? ' End with the four headings ## Changes, ## Verification, ## Deviations, ## Not done covering the whole ' +
        'task, not only this part.' : '');
    return { args, prompt };
  }

  providerFailure(error, reason = 'start') {
    const started = this.values.reached_running === 1;
    return {
      state: started ? 'failed' : 'unavailable', rc: started ? 1 : 3, error,
      unavailable_reason: started && reason === 'start' ? '' : reason
    };
  }

  mapResult({ code, result, text, spawnError }) {
    // The dispatcher continues an unfinished write run only after exit 3; 6 and 7 are the agent's answers.
    this.values.cli_exit = spawnError ? '' : String(code ?? '');
    this.values.cli_subtype = oneLine(result?.subtype);
    if (spawnError) return this.providerFailure(`mlai: could not start CLI (${spawnError.code ?? 'spawn error'})`);
    const error = clip(cliError(result), 300) || `mlai exited ${code}`;
    // An account has 100 task starts a day (reset 00:00 UTC, seen 2026-11-24); it comes as exit 1 before the start.
    if (code !== 0 && /daily_run_limit|daily limit of \d+ task starts/i.test(error)) return this.providerFailure(error, 'quota');
    switch (code) {
      case 0: {
        if (this.options.write) text = contractHeadings(text);
        writeFileSync(this.outputFd, text);
        const missing = this.options.write
          ? HEADINGS.filter((heading) => !hasHeading(text, heading)) : [];
        if (missing.length) this.log(`result is missing contract headings: ${missing.join('|')}`);
        return { state: missing.length ? 'incomplete' : 'done', rc: 0, error: '' };
      }
      case 3: {
        const heading = hasHeading(text, '## Not done') ? '' : '## Not done\n\n';
        const separator = text ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
        const detail = oneLine(result?.subtype) || oneLine(result?.error);
        const note = `mlai: stopped early (exit 3: needs attention): ${detail}`;
        writeFileSync(this.outputFd, text + separator + heading + note + '\n');
        // Non-zero: the work is unfinished, so the dispatcher must not count it as done (it moves a run without changes
        // to the next chain entry and returns this code otherwise).
        return { state: 'incomplete', rc: 1, error: `mlai: stopped early (exit 3: ${detail || 'needs attention'})` };
      }
      case 7:
        // The CLI's own final checks failed (citations it could not find, claimed vs run tests): nothing for the owner
        // to decide. A read-only report stands, marked as unconfirmed; unfinished write work goes to the next executor.
        if (result?.subtype === 'error_checks_failed') {
          const issues = clip(cliError(result), 600);
          if (!this.options.write) {
            writeFileSync(this.outputFd, `${text}${text.endsWith('\n') ? '' : '\n'}\n> ML AI Code's own final checks did ` +
              `not confirm this report${issues ? `: ${issues}` : ''}. Verify its claims against the code.\n`);
            return { state: 'done', rc: 0, error: '' };
          }
          writeFileSync(this.outputFd, text);
          return { state: 'incomplete', rc: 1, error: `mlai: its final checks did not pass${issues ? ` (${issues})` : ''}` };
        }
      // falls through
      case 6:
        writeFileSync(this.outputFd, text);
        return { state: 'incomplete', rc: 1, error: code === 6
          ? 'mlai: the agent reported the task impossible' : "mlai: needs the owner's decision (changes kept)" };
      case 2: return { state: 'failed', rc: 2, error };
      case 4: return this.providerFailure(error, 'auth');
      case 5: return this.providerFailure(error, 'quota');
      case 130: return { state: 'stopped', rc: 130, error: 'stopped' };
      default: return this.providerFailure(error);
    }
  }

  async execute(brief, retries, retryDelay, continues) {
    let invocation = this.invocation(brief);
    const binary = this.precheck();
    const env = agentEnvironment(this.home);
    Object.assign(env, this.engineChecks());
    // The engine's step checkpoints write refs and objects into the repository's git directory. A worktree keeps it in
    // the main repo, outside the folder the CLI's sandbox lets the agent write, so every checkpoint failed
    // (checkpoint_error: Read-only file system; the engine goes on). Off there; on where .git sits in the job folder.
    if (this.gitOutside()) {
      env.MINI_STEP_CHECKPOINTS = '0';
      this.log('step checkpoints off: the git directory is outside the job folder');
    }
    for (let retry = 0; ; retry += 1) {
      this.signal.throwIfAborted();
      const { args, prompt } = invocation;
      const attempt = new Attempt(this);
      this.attempt = attempt;
      this.values.attempts += 1;
      let outcome;
      try { outcome = await attempt.run([binary, ...args], prompt, env); }
      finally {
        this.values.credits = Math.round((this.values.credits + attempt.credits) * 1e6) / 1e6;
        this.attempt = undefined;
      }
      this.signal.throwIfAborted();

      const { code, result, text, stderr } = outcome;
      // Transient network failures: a dropped stream, or the server not reached through the proxy (seen 2026-11-24,
      // a 45 s timeout while the proxy answered normally a moment later).
      const transient = /connection[ _-]?interrupted|Cannot reach the ML AI Code server/i;
      const interrupted = code === 1 && (result?.usage?.errorCode === 'connection_interrupted' ||
        transient.test(oneLine(result?.error)) || transient.test(text) || (!result && transient.test(stderr)));
      // The step limit ends one turn, not the task: resume the same session, a few times at most.
      if (code === 3 && result?.subtype === 'error_max_turns' && this.values.continues < continues) {
        this.values.continues += 1;
        this.log(`mlai: step limit reached, continuing the session (${this.values.continues}/${continues})`);
        this.values.last_note = `step limit: continuing (${this.values.continues}/${continues})`;
        this.status();
        invocation = this.continuation();
        retry -= 1;
        continue;
      }
      if (!interrupted) return this.mapResult(outcome);
      // Before the agent starts, one retry is enough: the job then moves on down the chain instead of waiting
      // three CLI connect timeouts (about 45 s each) while the server is unreachable.
      if (retry >= (this.values.reached_running === 1 ? retries : Math.min(retries, 1))) {
        return this.providerFailure(`mlai: connection interrupted (after ${this.values.attempts} attempts)`);
      }
      this.log(`mlai: connection interrupted, retrying (attempt ${this.values.attempts + 1})`);
      this.status();
      await delay(retryDelay * (retry + 1), undefined, { signal: this.signal });
      invocation = this.invocation(brief);
    }
  }

  async run() {
    let result;
    const interrupt = () => this.abort(new Failure('stopped', 130, 'stopped'));
    // SIGHUP too: the dispatcher forwards it, and an unhandled one would orphan the CLI's own process group.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, interrupt);
    let heartbeat;
    let watchdog;
    try {
      this.prepareOutput();
      heartbeat = setInterval(() => {
        try { this.status(); } catch (error) { this.abort(error); }
      }, 15_000);
      const brief = this.validate();
      const idle = integerEnv('LUNA_IDLE_MAX_S', 900);
      const total = integerEnv('LUNA_TIMEOUT_S', 28800);
      const retries = integerEnv('MLAI_RETRIES', 2);
      const continues = integerEnv('MLAI_CONTINUES', 3);
      this.maxSteps = Math.min(160, Math.max(1, integerEnv('MLAI_MAX_STEPS', 160)));
      const retryDelay = integerEnv('MLAI_RETRY_DELAY_MS', 5000);
      const launched = performance.now();
      watchdog = setInterval(() => {
        const now = performance.now();
        if (idle && this.attempt?.waitingForStream && now - this.attempt.lastLine >= idle * 1000) {
          this.abort(new Failure(`no mlai stream lines for ${idle}s`, 124, 'stalled'));
        } else if (total && now - launched >= total * 1000) {
          this.abort(new Failure(`exceeded total timeout ${total}s`, 124, 'stalled'));
        }
      }, 100);
      result = await this.execute(brief, retries, retryDelay, continues);
    } catch (error) {
      const failure = this.signal.aborted ? this.signal.reason : error;
      result = { state: failure.state ?? 'failed', rc: failure.rc ?? 1, error: oneLine(failure.message),
        unavailable_reason: failure.reason ?? '' };
    } finally {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      try { if (this.ownsOutput) result = this.finalize(result); }
      finally {
        if (this.activeFile) { try { unlinkSync(this.activeFile); } catch {} }
        if (this.briefDir) { try { rmSync(this.briefDir, { recursive: true, force: true }); } catch {} }
        // The session was kept only so a step-limited run could continue it.
        try { rmSync(path.join(this.mlaiHome, 'sessions', this.sessionId), { recursive: true, force: true }); } catch {}
        try { this.outputLock?.release(); } catch {}
        for (const fd of [this.outputFd, this.logFd]) {
          if (fd !== undefined) { try { closeSync(fd); } catch {} }
        }
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, interrupt);
      }
    }
    if (result.error) process.stderr.write(`mlai.sh: ${oneLine(result.error)}\n`);
    if (this.ownsOutput) {
      for await (const chunk of createReadStream(this.options.out, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
        if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
    }
    return result.rc;
  }
}

// The CLI renders Markdown headings in its final text as plain "Changes:" lines; restore the contract headings.
function contractHeadings(text) {
  return text.replace(/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(Changes|Verification|Deviations|Not done)(?:\*\*)?:?(?:\*\*)?[ \t]*$/gm,
    '## $1');
}

function hasHeading(text, heading) {
  return text.split(/\r?\n/).some((line) => line.trimEnd() === heading);
}

try {
  process.exitCode = await new Job(parseArgs(process.argv.slice(2))).run();
} catch (error) {
  process.stderr.write(`mlai.sh: ${error.message}\n`);
  process.exitCode = error.rc ?? 2;
}
