#!/usr/bin/env node
// No client filesystem/terminal capabilities: agy runs its own tools inside bubblewrap.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, constants, accessSync, closeSync, createReadStream, existsSync, fstatSync, ftruncateSync,
  lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { processRows, readProcess } from '../lib/luna-runtime.mjs';

const ROOT = '/srv/docker/compose/antigravity-parallel';
const AGY_HOME = `${ROOT}/data/home`;
const BWRAP = '/usr/bin/bwrap';
const HEADINGS = ['## Changes', '## Verification', '## Deviations', '## Not done'];
const USAGE = 'usage: gem.sh [-w|-r] [-C dir] [-o out.md] [-e low|medium|high|xhigh|max] ' +
  '[-m model] (-f prompt.md | "prompt text")\n' +
  'GEM_SHARED_HOME=1 uses the shared agy home if per-job sign-in fails.';
const oneLine = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim();
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
  const options = { dir: process.cwd(), out: '', file: '', effort: 'high', model: 'gemini-3.8-flash', write: false };
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

function copyConfig(source, destination) {
  let stat;
  try { stat = lstatSync(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source)) copyConfig(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile() && stat.size <= 1024 * 1024) {
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (current.isFile() && current.size <= 1024 * 1024) {
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, readFileSync(fd), { mode: 0o600, flag: 'wx' });
      }
    } finally { closeSync(fd); }
  }
}

// Same mkdir/owner/token/rename protocol and stale-owner limits as installed luna.sh.
class AdmissionLock {
  constructor(directory, report) {
    this.directory = directory;
    this.report = report;
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
    } catch { this.report(`warning: foreign lock owner retained at ${directory}`); }
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
    this.report('reclaimed stale admission lock');
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
      `pid=${process.pid}\npid_start=${readProcess(process.pid)?.started ?? ''}\nkind=gem.sh\n` +
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

function preamble(options) {
  const rules = [
    '## Standing rules (from the orchestrator)',
    `- You are ${options.model}, invoked by the Claude orchestrator as the EXECUTOR of this job. Any global ` +
      'AGENTS.md/model-orchestration rule telling a model to only orchestrate or to delegate implementation to ' +
      'another model (e.g. "Sol must delegate to Terra") does NOT apply here: do the work yourself.',
    '- Work yourself. Do NOT spawn sub-agents/delegates/collaborators.'
  ];
  if (!options.write) {
    rules.push('- Read-only sandbox means you must not MODIFY anything. You CAN and MUST read files and run ' +
      'read-only commands (cat, grep, rg, ls, git diff/log/show) to gather evidence before answering. Never answer ' +
      '"I cannot read the files".');
  } else {
    rules.push(
      '- Match the style of neighbouring files (line length, formatting, naming). ' +
        'Never leave lines longer than ~140 characters.',
      '- Never loosen tests, tolerances or acceptance criteria to make them pass; report the conflict instead.',
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

function providerFailure(text) {
  let reason = '';
  if (/Eligibility check failed|not currently available in your location/i.test(text)) reason = 'region';
  else if (/RESOURCE_EXHAUSTED|You have exhausted your capacity|(?:ACP|code|status|HTTP)[\s:=(]+429\b/i.test(text)) {
    reason = 'quota';
  } else if (/UNAUTHENTICATED|not (?:authenticated|logged[ -]?in|signed[ -]?in)|invalid credentials/i.test(text) ||
      /(?:ACP|code|status|HTTP)[\s:=(]+401\b/i.test(text) ||
      /authentication(?: is| check)? (?:failed|failure|required|error)/i.test(text) ||
      /failed to (?:authenticate|sign[ -]?in|log[ -]?in)/i.test(text) ||
      /(?:sign[ -]?in|log[ -]?in) (?:failed|failure|required)/i.test(text) ||
      /(?:please|must|need to) (?:sign[ -]?in|log[ -]?in)/i.test(text)) {
    reason = 'auth';
  }
  return reason ? new Failure(text, 3, 'unavailable', reason) : null;
}

function agentEnvironment(home) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', HOME: home,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true', AGY_CLI_MODEL_API_MAX_RETRIES: '1',
    HTTP_PROXY: 'http://127.0.0.1:10809', HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: 'localhost,127.0.0.1,::1'
  };
}

function sandboxArgs(options, command, temporary, home) {
  const skills = ['/home/bro/.claude/skills', '/home/bro/.claude/plugins/cache/luna-local']
    .filter((directory) => existsSync(directory)).flatMap((directory) => ['--ro-bind', directory, directory]);
  return [
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--bind', temporary, temporary, '--tmpfs', '/home/bro',
    ...skills,
    options.write ? '--bind' : '--ro-bind', options.dir, options.dir,
    ...(home === AGY_HOME ? [] : ['--tmpfs', AGY_HOME]),
    '--bind', home, home, '--bind', '/run/user/1000/bus', '/run/user/1000/bus',
    '--ro-bind', path.dirname(command[0]), path.dirname(command[0]),
    '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', options.dir, '--', ...command
  ];
}

class AcpClient {
  constructor(job, command) {
    this.job = job;
    this.serial = 0;
    this.pending = new Map();
    this.members = new Map();
    this.lastUpdate = performance.now();
    this.closing = false;
    this.nonJson = 0;
    this.child = spawn(command[0], command.slice(1), {
      cwd: job.options.dir, env: agentEnvironment(job.agyHome), detached: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdin.on('error', (error) => this.transportError(error));
    this.child.on('error', (error) => this.transportError(error));
    this.child.on('exit', () => { this.exited = true; });
    this.child.on('close', (rc, signal) => this.transportError(new Error(`agy exited (${signal ?? rc})`), rc));
    this.stdout = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.stderr = readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    this.stdout.on('line', (line) => {
      try { this.onLine(line); } catch (error) { job.abort(error); }
    });
    this.stderr.on('line', (line) => {
      try {
        job.log(`agy stderr: ${line}`);
        const error = providerFailure(line);
        if (error) job.abort(error);
      } catch (error) { job.abort(error); }
    });
    this.abortListener = () => this.rejectPending(job.signal.reason);
    job.signal.addEventListener('abort', this.abortListener, { once: true });
    if (this.child.pid) {
      job.values.pid = this.child.pid;
      this.trackTree();
    }
  }

  transportError(error, rc) {
    if (this.closing) return;
    const failure = providerFailure(error.message) ?? (this.job.sessionReady
      ? new Failure(error.message, Number.isInteger(rc) && rc > 0 && rc < 256 ? rc : 1)
      : new Failure(error.message, 3, 'unavailable', 'start'));
    this.job.abort(failure);
  }

  rejectPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  send(message) {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  async call(method, params, timeout = 0) {
    this.job.signal.throwIfAborted();
    const id = ++this.serial;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { method, resolve, reject });
        if (timeout) timer = setTimeout(() => {
          const error = new Failure(`ACP ${method} timed out`, this.job.sessionReady ? 1 : 3,
            this.job.sessionReady ? 'failed' : 'unavailable', this.job.sessionReady ? '' : 'start');
          reject(error);
        }, timeout);
        this.send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      if (this.nonJson++ < 5) this.job.log(`agy: ${line}`);
      const diagnostic = /^⚠ (?:API error \(attempt \d+\):|You have exhausted your capacity on this model\.)/u;
      const error = diagnostic.test(line) ? providerFailure(line) : null;
      if (error) this.job.abort(error);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.method && Object.hasOwn(message, 'id')) {
      if (message.method === 'session/request_permission') {
        const title = message.params?.toolCall?.title ?? 'permission request';
        this.job.note(title, 'tool');
        const option = message.params?.options?.find((item) => item.kind === 'allow_once');
        this.send({ id: message.id, result: { outcome: option
          ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
      } else {
        this.send({ id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
      }
    } else if (Object.hasOwn(message, 'id')) {
      const request = this.pending.get(message.id);
      if (!request) return;
      if (message.error) {
        const text = `ACP ${message.error.code}: ${message.error.message ?? 'error'} ` +
          JSON.stringify(message.error.data ?? {});
        const error = providerFailure(text) ?? new Failure(text);
        request.reject(error);
      } else {
        if (request.method === 'session/new' && message.result?.sessionId) this.job.sessionReady = true;
        request.resolve(message.result ?? {});
      }
    } else if (message.method === 'session/update') {
      if (this.job.values.conversation_id && message.params?.sessionId !== this.job.values.conversation_id) return;
      this.lastUpdate = performance.now();
      this.job.update(message.params?.update ?? {});
    }
  }

  trackTree() {
    const rows = processRows();
    const wrapperGroup = readProcess(process.pid)?.group;
    const groups = new Set([...this.members.values()]
      .filter((row) => alive(row.pid, row.started)).map((row) => row.group));
    if (!this.exited) groups.add(this.child.pid);
    groups.delete(wrapperGroup);
    const owned = new Set();
    for (const row of rows) {
      if (groups.has(row.group) || (!this.exited && row.pid === this.child.pid) ||
          this.members.get(row.pid)?.started === row.started) {
        owned.add(row.pid);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
      }
    }
    for (const row of rows) {
      if (!owned.has(row.pid)) continue;
      this.members.set(row.pid, row);
    }
    // bwrap may supervise a separate agy PID; publish the agent rather than its supervisor or a terminal child.
    const command = this.job.agentCommand.join(' ');
    const agent = rows.find((row) => owned.has(row.pid) &&
      (row.command === command || row.command.startsWith(`${command} `))) ??
      rows.find((row) => row.pid === this.child.pid);
    if (agent) {
      this.job.values.pid = agent.pid;
      this.job.values.pid_start = agent.started;
    }
  }

  signalTree(signal) {
    for (const row of [...this.members.values()].reverse()) {
      if (!alive(row.pid, row.started)) continue;
      try { process.kill(row.pid, signal); } catch {}
      if (row.group === row.pid && row.pid !== process.pid) {
        try { process.kill(-row.pid, signal); } catch {}
      }
    }
    if (!this.exited && this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch {}
      this.child.kill(signal);
    }
  }

  async close(cancel) {
    this.closing = true;
    this.job.signal.removeEventListener('abort', this.abortListener);
    if (cancel && this.job.values.conversation_id) {
      this.send({ method: 'session/cancel', params: { sessionId: this.job.values.conversation_id } });
      await delay(50);
    }
    this.rejectPending(new Failure('ACP transport closed'));
    try {
      this.trackTree();
      this.child.stdin.end();
      this.signalTree('SIGTERM');
      const deadline = performance.now() + 1000;
      while ([...this.members.values()].some((row) => alive(row.pid, row.started)) && performance.now() < deadline) {
        this.trackTree();
        await delay(50);
      }
    } finally {
      this.signalTree('SIGKILL');
      if (!this.exited && this.child.pid) {
        await Promise.race([new Promise((resolve) => this.child.once('exit', resolve)), delay(1000)]);
      }
      this.stdout.close();
      this.stderr.close();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }
}

class Job {
  constructor(options) {
    this.options = options;
    this.home = process.env.HOME || homedir();
    this.started = performance.now();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.toolTitles = new Map();
    this.values = {
      state: 'starting', pid: '', wrapper_pid: process.pid, wrapper_start: readProcess(process.pid)?.started ?? '',
      pid_start: '', owner: process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.ppid}`,
      started: new Date().toISOString(),
      finished: '', rc: '', model: options.model, acp_model: '', effort: options.effort,
      sandbox: options.write ? 'workspace-write' : 'read-only', dir: path.resolve(options.dir),
      engine: 'acp', provider: 'gemini', conversation_id: '', error: '', last_note: '', unavailable_reason: '',
      usage_input: 0, usage_output: 0, usage_total: 0, elapsed_s: 0, thought_chunks: 0,
      agy_home: process.env.GEM_SHARED_HOME === '1' ? 'shared' : 'per-job'
    };
  }

  abort(error) {
    if (!this.signal.aborted) this.controller.abort(error instanceof Failure ? error : new Failure(error.message));
  }

  log(message) {
    if (!this.ownsOutput) return;
    const lines = String(message).replace(/\r/g, '').split('\n').filter(Boolean);
    appendFileSync(this.logFd, lines.map((line) => `${new Date().toISOString()} ${line}\n`).join(''));
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

  note(text, kind = 'agent') {
    const combined = kind === 'agent' ? (this.messageLine ?? '') + text : String(text);
    const parts = combined.split(/[\r\n]+/u);
    const lines = parts.filter((line) => line.trim());
    if (!lines.length) return;
    const note = Array.from(oneLine(kind === 'tool' ? text : lines.at(-1))).slice(0, 200).join('');
    if (kind === 'tool') this.lastToolNote = note;
    else this.messageLine = Array.from(parts.at(-1)).slice(-200).join('');
    this.values.last_note = this.lastToolNote || note;
    this.log(`${kind}: ${text}`);
  }

  usage(usage = {}) {
    const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens;
    const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens;
    const total = usage.totalTokens ?? usage.total_tokens;
    if (Number.isFinite(input)) this.values.usage_input = input;
    if (Number.isFinite(output)) this.values.usage_output = output;
    this.values.usage_total = Number.isFinite(total) ? total : this.values.usage_input + this.values.usage_output;
  }

  update(update) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text ?? '' : '';
        appendFileSync(this.outputFd, text, 'utf8');
        this.note(text);
        break;
      }
      case 'agent_thought_chunk': this.values.thought_chunks += 1; break;
      case 'tool_call':
      case 'tool_call_update': {
        if (update.title) this.toolTitles.set(update.toolCallId, update.title);
        const title = this.toolTitles.get(update.toolCallId) ?? update.toolCallId ?? 'tool';
        this.note(title, 'tool');
        if (update.status) this.log(`tool status: ${update.status}`);
        break;
      }
      case 'usage_update': this.usage(update.usage ?? update); break;
    }
  }

  prepareOutput() {
    const options = this.options;
    options.out = path.resolve(options.out || path.join(tmpdir(), `gem-out.${randomBytes(8).toString('hex')}.md`));
    const parent = path.dirname(options.out);
    let existing = parent;
    while (!existsSync(existing)) existing = path.dirname(existing);
    if (realpathSync(existing) !== existing) throw new Failure(`output parent symlink refused: ${parent}`, 2);
    mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== parent) throw new Failure(`output parent symlink refused: ${parent}`, 2);
    for (const file of [options.out, `${options.out}.status`, `${options.out}.log`]) refuseSymlink(file);
    const previous = readFields(`${options.out}.status`);
    if (previous.state === 'running' && alive(previous.pid, previous.pid_start)) {
      throw new Failure('output already in use', 1);
    }
    this.outputLock = new AdmissionLock(`${options.out}.gem-lock`, () => {});
    if (!this.outputLock.acquire() && !this.outputLock.acquire()) throw new Failure('output already in use', 1);
    this.ownsOutput = true;
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND | constants.O_NOFOLLOW;
    this.outputFd = openSync(options.out, flags, 0o600);
    this.logFd = openSync(`${options.out}.log`, flags, 0o600);
    const active = path.join(process.env.LUNA_RUN_DIR || path.join(this.home, '.claude/luna-run'), 'gem-active');
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
      try { prompt = readFileSync(path.resolve(options.file), 'utf8'); }
      catch { throw new Failure(`prompt file not readable: ${options.file}`, 2); }
    }
    if (!prompt.trim()) throw new Failure('prompt is missing or empty', 2);
    try {
      options.dir = realpathSync(options.dir);
      if (!statSync(options.dir).isDirectory()) throw new Error('not a directory');
    } catch { throw new Failure(`working directory does not exist: ${options.dir}`, 2); }
    const home = realpathSync(this.home);
    const privateDirs = ['.claude', '.ssh', '.codex', '.config'].map((name) => {
      const directory = path.join(home, name);
      try { return realpathSync(directory); } catch { return directory; }
    });
    if (options.dir === '/' || options.dir === home || options.dir === '/home/bro' ||
        home.startsWith(`${options.dir}/`) ||
        privateDirs.some((dir) => options.dir === dir || options.dir.startsWith(`${dir}/`))) {
      throw new Failure(`unsafe project directory: ${options.dir}`, 2);
    }
    this.values.dir = options.dir;
    return preamble(options) + prompt;
  }

  async command() {
    const injected = process.env.GEM_AGENT_CMD;
    if ((process.env.GEM_NO_SANDBOX === '1' || process.env.GEM_SKIP_CHECKSUM === '1') && !injected) {
      throw new Failure('test sandbox/checksum overrides require GEM_AGENT_CMD', 2);
    }
    let command;
    let settings;
    if (injected) {
      try { command = JSON.parse(injected); } catch { throw new Failure('GEM_AGENT_CMD must be JSON argv', 2); }
      if (!Array.isArray(command) || !command.length || command.some((value) => typeof value !== 'string' || !value)) {
        throw new Failure('GEM_AGENT_CMD must be non-empty JSON argv', 2);
      }
    }
    if (!command || process.env.GEM_SKIP_CHECKSUM !== '1') {
      const settingsFile = injected && process.env.GEM_TEST_SETTINGS_FILE || `${ROOT}/config/settings.json`;
      try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); }
      catch { throw new Failure('cannot read agy settings', 2); }
      if (!path.isAbsolute(settings.agy_bin ?? '') || !/^[a-f0-9]{64}$/i.test(settings.agy_sha256 ?? '')) {
        throw new Failure('invalid agy settings', 2);
      }
      if (process.env.GEM_SKIP_CHECKSUM !== '1') {
        const hash = createHash('sha256');
        try {
          for await (const chunk of createReadStream(settings.agy_bin)) {
            this.signal.throwIfAborted();
            hash.update(chunk);
          }
        } catch (error) {
          this.signal.throwIfAborted();
          throw new Failure(`cannot read agy binary: ${error.message}`, 3, 'unavailable', 'start');
        }
        if (hash.digest('hex') !== settings.agy_sha256.toLowerCase()) {
          throw new Failure('agy checksum changed', 3, 'unavailable', 'checksum');
        }
      }
    }
    this.binary = settings?.agy_bin ?? command[0];
    command ??= [this.binary, '--sandbox', 'acp'];
    this.agentCommand = command;
    this.temporary = mkdtempSync('/tmp/gem-job-');
    this.agyHome = this.values.agy_home === 'shared' ? AGY_HOME : path.join(this.temporary, 'home');
    if (this.values.agy_home === 'per-job') {
      mkdirSync(this.agyHome, { mode: 0o700 });
      const gemini = path.join(AGY_HOME, '.gemini');
      if (existsSync(gemini) && lstatSync(gemini).isDirectory()) {
        copyConfig(path.join(gemini, 'config'), path.join(this.agyHome, '.gemini', 'config'));
      }
    }
    if (process.env.GEM_NO_SANDBOX !== '1') {
      try { accessSync(BWRAP, constants.X_OK); }
      catch { throw new Failure('bubblewrap is required: /usr/bin/bwrap', 2); }
      const args = sandboxArgs(this.options, command, this.temporary, this.agyHome);
      command = [BWRAP, ...args];
    }
    return command;
  }

  async admit() {
    const memory = fields(readFileSync('/proc/meminfo', 'utf8').replace(/:\s*/g, '=').replace(/ kB/g, ''));
    const total = Math.floor(Number(memory.MemTotal) / 1024);
    const reserve = integerEnv('LUNA_RAM_RESERVE_MB', Math.max(1024, Math.floor(total * 6 / 100)));
    const estimate = integerEnv('GEM_JOB_MB', this.options.write ? 500 : 350);
    const limit = integerEnv('GEM_RAM_WAIT_S', 1800);
    this.ramp = integerEnv('LUNA_RAMP_S', 4);
    this.lock = new AdmissionLock(process.env.LUNA_ADMIT_LOCK || path.join(this.home, '.claude/luna-run/admit.lock'),
      (message) => this.log(message));
    const started = performance.now();
    while (true) {
      this.signal.throwIfAborted();
      let cause = 'admission lock';
      if (this.lock.acquire()) {
        const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
        if (!match) throw new Failure('MemAvailable missing from /proc/meminfo', 2);
        if (Math.floor(Number(match[1]) / 1024) - estimate >= reserve) return;
        this.lock.release();
        cause = 'RAM';
      }
      this.values.last_note = `waiting for ${cause}`;
      this.status('waiting-ram');
      if ((performance.now() - started) / 1000 >= limit) throw new Failure(`gave up waiting for ${cause}`, 75);
      await delay(1000, undefined, { signal: this.signal });
    }
  }

  selectModel(session) {
    const offered = new Set((session.models?.availableModels ?? []).map((model) => model.modelId));
    const requested = this.options.model;
    const levels = ['low', 'medium', 'high'];
    const family = levels.some((level) => offered.has(`${requested}-${level}`)) ||
      (requested.startsWith('gemini-') && !offered.has(requested));
    const level = ['low', 'medium'].includes(this.options.effort) ? this.options.effort : 'high';
    const model = !/-(low|medium|high)$/.test(requested) && family ? `${requested}-${level}` : requested;
    this.values.acp_model = model;
    if (!offered.has(model)) throw new Failure(`model not offered: ${model}`, 2);
    return model;
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

  async run() {
    let result = { state: 'failed', rc: 1, error: '' };
    const interrupt = () => this.abort(new Failure('stopped', 130));
    process.on('SIGTERM', interrupt);
    process.on('SIGINT', interrupt);
    let heartbeat;
    let watchdog;
    let rampTimer;
    try {
      this.prepareOutput();
      heartbeat = setInterval(() => {
        try { this.status(); } catch (error) { this.abort(error); }
      }, 15_000);
      const prompt = this.validate();
      const idle = integerEnv('LUNA_IDLE_MAX_S', 900);
      const total = integerEnv('LUNA_TIMEOUT_S', 28800);
      const command = await this.command();
      await this.admit();
      this.signal.throwIfAborted();
      this.client = new AcpClient(this, command);
      this.status('running');
      const launched = performance.now();
      let lastScan = launched;
      rampTimer = setTimeout(() => this.lock.release(), Math.min(this.ramp * 1000, 2_147_000_000));
      watchdog = setInterval(() => {
        try {
          const now = performance.now();
          if (now - lastScan >= 1000) { this.client.trackTree(); lastScan = now; }
          if (idle && now - this.client.lastUpdate >= idle * 1000) {
            this.abort(new Failure(`no ACP updates for ${idle}s`, 124, 'stalled'));
          } else if (total && now - launched >= total * 1000) {
            this.abort(new Failure(`exceeded total timeout ${total}s`, 124, 'stalled'));
          }
        } catch (error) { this.abort(error); }
      }, 100);
      await this.client.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);
      const session = await this.client.call('session/new', { cwd: this.options.dir, mcpServers: [] }, 120_000);
      if (!session.sessionId) throw new Failure('session/new returned no sessionId', 3, 'unavailable', 'start');
      this.values.conversation_id = session.sessionId;
      this.client.trackTree();
      this.status();
      const model = this.selectModel(session);
      await this.client.call('session/set_model', { sessionId: session.sessionId, modelId: model }, 30_000);
      await this.client.call('session/set_mode', { sessionId: session.sessionId, modeId: 'auto' }, 30_000);
      this.status();
      const answer = await this.client.call('session/prompt', {
        sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }]
      });
      this.signal.throwIfAborted();
      this.usage(answer.usage);
      const output = readFileSync(this.options.out, {
        encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW
      });
      if (!output.trim()) throw new Failure('no final message');
      if (answer.stopReason !== 'end_turn') throw new Failure(`agent stopped: ${answer.stopReason ?? 'unknown'}`);
      const missing = this.options.write ? HEADINGS.filter((heading) => !output.includes(heading)) : [];
      result = { state: missing.length ? 'incomplete' : 'done', rc: 0, error: '' };
      if (missing.length) this.log(`result is missing contract headings: ${missing.join('|')}`);
    } catch (error) {
      const failure = this.signal.aborted ? this.signal.reason : error;
      result = { state: failure.state ?? 'failed', rc: failure.rc ?? 2, error: oneLine(failure.message),
        unavailable_reason: failure.reason ?? '' };
    } finally {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      clearTimeout(rampTimer);
      try { await this.client?.close(result.rc !== 0); } catch (error) {
        try { this.client?.signalTree('SIGKILL'); } catch {}
        result = { state: 'failed', rc: 1, error: `cleanup failed: ${oneLine(error.message)}` };
      }
      if (this.signal.aborted) {
        const failure = this.signal.reason;
        result = { state: failure.state, rc: failure.rc, error: failure.message, unavailable_reason: failure.reason };
      }
      try {
        try { this.lock?.release(); }
        catch (error) { result = { state: 'failed', rc: 1, error: `cleanup failed: ${oneLine(error.message)}` }; }
        try { if (this.temporary) rmSync(this.temporary, { recursive: true, force: true }); }
        catch (error) { result = { state: 'failed', rc: 1, error: `cleanup failed: ${oneLine(error.message)}` }; }
        if (this.ownsOutput) result = this.finalize(result);
      } finally {
        if (this.activeFile) { try { unlinkSync(this.activeFile); } catch {} }
        try { this.outputLock?.release(); }
        catch (error) { result = { state: 'failed', rc: 1, error: `cleanup failed: ${oneLine(error.message)}` }; }
        for (const fd of [this.outputFd, this.logFd]) {
          if (fd !== undefined) { try { closeSync(fd); } catch {} }
        }
        process.off('SIGTERM', interrupt);
        process.off('SIGINT', interrupt);
      }
    }
    if (result.error) process.stderr.write(`gem.sh: ${oneLine(result.error)}\n`);
    if (this.ownsOutput) {
      for await (const chunk of createReadStream(this.options.out)) {
        if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
    }
    return result.rc;
  }
}

try {
  process.exitCode = await new Job(parseArgs(process.argv.slice(2))).run();
} catch (error) {
  process.stderr.write(`gem.sh: ${error.message}\n`);
  process.exitCode = error.rc ?? 2;
}
