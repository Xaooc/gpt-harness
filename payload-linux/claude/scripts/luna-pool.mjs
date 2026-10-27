#!/usr/bin/env node
// Admission is shared with luna.sh. LUNA_NO_GATE=1 skips both RAM and locking.
// LUNA_ADMIT_LOCK: directory (default $HOME/.claude/luna-run/admit.lock).
// LUNA_POOL_SERVER_MB: app-server RAM estimate (default 120 MB).
// LUNA_POOL_RAMP_MS: hold the admission lock after a start (default 2000 ms).
// LUNA_IDLE_MAX_S: no thread events before stalling (default 900 s; 0 disables).
// LUNA_TURN_TIMEOUT_S: turn timeout (default 2400 s). Stalls use state=stalled, rc=124.
// luna.sh instead uses LUNA_TIMEOUT_S for total attempt time (default 28800 s = 8 h hard cap; 0 disables).
// Threads are ephemeral by default; LUNA_KEEP_SESSION=1 keeps Codex session history.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import * as os from 'node:os';
import { homedir, totalmem } from 'node:os';
import path from 'node:path';
import {
  availableMemory, codexEnvironment, loadProxyEnv, ownedProcess, readProcess, resolveCodex, stopGroup, stopGroupSync
} from './lib/luna-runtime.mjs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const MB = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TIMER_MS = 2_147_000_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const REFUSAL_RE = new RegExp([
  String.raw`\b(i|we)\b[^.\n]{0,25}\b` +
  String.raw`(can(’|'|)t|cannot|am unable to|are unable to|am not able to|don(’|'|)t have|do not have|have no)\b` +
  String.raw`[^.\n]{0,50}\b(read|access|run|use|execute|open|shell|command|tool)`,
  String.raw`\b(workspace|sandbox|filesystem|file system|environment)\b[^.\n]{0,20}\bis read-only\b`,
  String.raw`\bno (shell|command|terminal)[^.\n]{0,15}(access|tool|available)`
].join('|'), 'i');

function isRefusal(message) {
  return REFUSAL_RE.test(message);
}
const REFUSAL_RETRY_PROMPT = [
  'IMPORTANT: a previous attempt wrongly refused to read files. You DO have a shell tool.',
  'Read-only only forbids modifying files. Read the files and run read-only commands',
  '(cat, grep, rg, git diff) now, before answering.'
].join(' ');

function selfTestRefusal() {
  const cases = [
    ['I can’t read files in this read-only workspace.', true],
    ['I can’t run `cat greet.py` here because the workspace is read-only and doesn’t provide shell access.', true],
    ['Unable to read `greet.py`; filesystem access is read-only.', true],
    ['I can’t read the workspace because filesystem access is read-only and no command tool is available', true],
    ['I don’t have access to the shell.', true],
    ["I can't read files", true],
    ['No access control is implemented on /admin.', false],
    ['- **[high]** Users cannot read the config when the cache is cold', false],
    ['Unable to access the file due to its permissions is shown to users as a raw stack trace', false],
    ['`greet.py` prints `Hello, {name}!`', false],
    ['No findings', false]
  ];
  let failed = 0;
  for (const [message, expected] of cases) {
    const pass = isRefusal(message) === expected;
    if (!pass) failed += 1;
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(message)}\n`);
  }
  process.stdout.write(`refusal self-test: passed=${cases.length - failed} failed=${failed}\n`);
  return failed === 0 ? 0 : 1;
}

// MCP servers stay disabled unless LUNA_POOL_ALLOW_MCP=1 is set; plugins and
// apps are always disabled. LUNA_FULL and LUNA_MCP are ignored.

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  let max;
  let effort;
  let dryRun = false;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--max' || arg === '--effort') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new CliError(`missing value for ${arg}`);
      i += 1;
      if (arg === '--max') max = parseInteger(value, '--max', 1);
      else effort = value;
    } else if (arg.startsWith('--')) {
      throw new CliError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    throw new CliError([
      'usage: node luna-pool.mjs <briefs-dir> <repo-root> [--max N] [--effort E] [--dry-run]',
      '  LUNA_ADMIT_LOCK: shared directory (default $HOME/.claude/luna-run/admit.lock)',
      '  LUNA_POOL_SERVER_MB=120, LUNA_POOL_RAMP_MS=2000, LUNA_WAIT_MAX_S=1800, LUNA_NO_GATE=1 skips admission',
      '  LUNA_IDLE_MAX_S=900 (0 disables), LUNA_TURN_TIMEOUT_S=2400; stalls: state=stalled rc=124',
      '  luna.sh uses LUNA_TIMEOUT_S=28800 (8 h hard cap, 0 disables); stalls are caught by idle time'
    ].join('\n'));
  }
  return { briefsDir: positional[0], repoRoot: positional[1], max, effort, dryRun };
}

function parseInteger(value, name, minimum) {
  if (!/^\d+$/.test(String(value))) throw new CliError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new CliError(`${name} must be at least ${minimum}`);
  }
  return number;
}

function envInteger(name, fallback, minimum = 0) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  try {
    return parseInteger(value, name, minimum);
  } catch (error) {
    throw new CliError(error.message);
  }
}

function cleanValue(value) {
  return String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(file, content, privateFile = false) {
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, content, privateFile ? { encoding: 'utf8', mode: 0o600, flag: 'wx' } : 'utf8');
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function readLockOwner(directory) {
  try {
    return Object.fromEntries(readFileSync(path.join(directory, 'owner'), 'utf8').trim().split(/\r?\n/)
      .map((line) => line.split('=')));
  } catch { return null; }
}

function removeLockDirectory(directory) {
  for (const name of ['owner', 'owner.tmp']) {
    try { unlinkSync(path.join(directory, name)); } catch {}
  }
  try { rmdirSync(directory); } catch {}
}

function admissionLock(home, report = (message) => process.stderr.write(`luna-pool: ${message}\n`)) {
  const directory = process.env.LUNA_ADMIT_LOCK || path.join(home, '.claude', 'luna-run', 'admit.lock');
  let token = null;

  function reclaim() {
    const owner = readLockOwner(directory);
    const judgedToken = owner?.token ?? '';
    const now = Date.now();
    let reason;
    let orphanMtime;
    if (owner) {
      const age = /^\d+$/.test(owner.since ?? '') ? now / 1000 - Number(owner.since) : 0;
      if (age > 600) {
        reason = 'owner age exceeds 600s';
      } else if (age > 5 && /^[1-9]\d*$/.test(owner.pid ?? '') && Number.isSafeInteger(Number(owner.pid))) {
        const row = readProcess(owner.pid);
        if (!row || row.state === 'Z' || row.started !== owner.pid_start) {
          reason = `owner pid ${owner.pid} is dead`;
        }
      }
    } else {
      try {
        orphanMtime = statSync(directory).mtimeMs;
        if (now - orphanMtime > 10_000) reason = 'missing owner older than 10s';
      } catch {}
    }
    if (!reason) return false;

    const parent = path.dirname(directory);
    const prefixes = ['stale', 'rel'].map((kind) => `${path.basename(directory)}.${kind}.`);
    for (const name of readdirSync(parent)) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const leftover = path.join(parent, name);
      try {
        if (statSync(leftover).isDirectory() && now - statSync(leftover).mtimeMs > 600_000) {
          removeLockDirectory(leftover);
        }
      } catch {}
    }
    const stale = `${directory}.stale.${randomBytes(8).toString('hex')}`;
    try { renameSync(directory, stale); } catch { return false; }
    let changed = (readLockOwner(stale)?.token ?? '') !== judgedToken;
    if (orphanMtime !== undefined) {
      try { changed ||= statSync(stale).mtimeMs !== orphanMtime; } catch { changed = true; }
    }
    if (changed) {
      try {
        // Never replace a directory that a new caller has already acquired.
        if (existsSync(directory)) throw new Error('lock already exists');
        renameSync(stale, directory);
      } catch {
        report(`warning: fresh owner moved during reclaim; retained ${stale}`);
      }
      return false;
    }
    report(`reclaimed admission lock: ${reason}`);
    removeLockDirectory(stale);
    return true;
  }

  return {
    get held() { return token !== null; },
    details() {
      const owner = readLockOwner(directory);
      let since = owner && /^\d+$/.test(owner.since ?? '') ? Number(owner.since) : Date.now() / 1000;
      if (!owner) {
        try { since = statSync(directory).mtimeMs / 1000; } catch {}
      }
      return { lock_kind: owner?.kind || 'unknown', lock_age_s: Math.max(0, Math.floor(Date.now() / 1000 - since)) };
    },
    acquire() {
      if (token !== null) return false;
      if (!process.env.LUNA_ADMIT_LOCK) {
        const run = path.join(home, '.claude', 'luna-run');
        mkdirSync(run, { recursive: true, mode: 0o700 });
        chmodSync(run, 0o700);
      }
      mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        chmodSync(directory, 0o700);
        reclaim();
        return false;
      }
      token = randomBytes(8).toString('hex');
      try {
        atomicWrite(path.join(directory, 'owner'),
          `pid=${process.pid}\npid_start=${readProcess(process.pid)?.started || ''}\n` +
          `kind=luna-pool\nsince=${Math.floor(Date.now() / 1000)}\ntoken=${token}\n`, true);
      } catch (error) {
        token = null;
        // No published owner: subsequent callers use the 10s orphan rule.
        throw error;
      }
      return true;
    },
    release() {
      if (token === null) return;
      const released = `${directory}.rel.${token}`;
      const myToken = token;
      token = null;
      try { renameSync(directory, released); } catch { return; }
      if (readLockOwner(released)?.token === myToken) {
        removeLockDirectory(released);
      } else {
        try {
          if (existsSync(directory)) throw new Error('lock already exists');
          renameSync(released, directory);
        } catch {
          report(`warning: foreign owner moved during release; retained ${released}`);
        }
      }
    }
  };
}

async function selfTestLock() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'luna-admit-test-'));
  const previous = process.env.LUNA_ADMIT_LOCK;
  const directory = path.join(root, 'missing-parent', 'admit.lock');
  process.env.LUNA_ADMIT_LOCK = directory;
  const reports = [];
  const lock = admissionLock(root, (message) => reports.push(message));
  const second = admissionLock(root, (message) => reports.push(message));
  let passed = 0;
  let failed = 0;
  function check(name, condition) {
    if (condition) passed += 1;
    else failed += 1;
    process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${name}\n`);
  }
  function seed(pid, since) {
    mkdirSync(directory, { recursive: true });
    atomicWrite(path.join(directory, 'owner'), `pid=${pid}\npid_start=${readProcess(pid)?.started || ''}\n` +
      `kind=luna-pool\nsince=${since}\ntoken=0123456789abcdef\n`, true);
  }
  function reclaimed() {
    lock.acquire(); // Reclaim happens only after a failed mkdir; acquisition is retried separately.
    const acquired = lock.acquire();
    lock.release();
    return acquired;
  }
  try {
    check('acquire creates missing parent', lock.acquire());
    check('pool admission token file and directory are private',
      (statSync(path.join(directory, 'owner')).mode & 0o777) === 0o600 &&
      (statSync(directory).mode & 0o777) === 0o700);
    check('second acquire fails while held', !second.acquire());
    const original = readFileSync(path.join(directory, 'owner'), 'utf8');
    atomicWrite(path.join(directory, 'owner'), original.replace(/token=.*/, 'token=fedcba9876543210'), true);
    lock.release();
    check('wrong token release is a no-op', readLockOwner(directory)?.token === 'fedcba9876543210');
    removeLockDirectory(directory);
    check('acquire again', lock.acquire());
    lock.release();
    check('release removes lock', !existsSync(directory));
    const child = spawn(process.execPath, ['-e', '0'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    seed(child.pid, Math.floor(Date.now() / 1000) - 2);
    check('dead owner aged 2s not reclaimed', !lock.acquire() && existsSync(directory));
    removeLockDirectory(directory);
    seed(child.pid, Math.floor(Date.now() / 1000) - 6);
    check('dead owner aged 6s reclaimed', reclaimed());
    seed(process.pid, Math.floor(Date.now() / 1000) - 200);
    check('live owner aged 200s not reclaimed', !lock.acquire() && existsSync(directory));
    removeLockDirectory(directory);
    seed(process.pid, Math.floor(Date.now() / 1000) - 700);
    check('live owner aged 700s reclaimed', reclaimed());
    seed(child.pid, Math.floor(Date.now() / 1000) - 700);
    check('dead owner aged 700s reclaimed', reclaimed());
    check('acquire predecessor', lock.acquire());
    const predecessor = readFileSync(path.join(directory, 'owner'), 'utf8');
    atomicWrite(path.join(directory, 'owner'),
      predecessor.replace(/since=\d+/, `since=${Math.floor(Date.now() / 1000) - 700}`), true);
    second.acquire();
    check('successor acquires reclaimed lock', second.acquire());
    const successor = readFileSync(path.join(directory, 'owner'), 'utf8');
    lock.release();
    check('reclaimed holder release preserves successor',
      readFileSync(path.join(directory, 'owner'), 'utf8') === successor && second.held);
    second.release();
    for (const kind of ['stale', 'rel']) {
      for (const age of ['old', 'young']) {
        const leftover = `${directory}.${kind}.${age}`;
        mkdirSync(leftover);
        writeFileSync(path.join(leftover, 'owner'), 'token=leftover\n', { mode: 0o600 });
        const modified = new Date(Date.now() - (age === 'old' ? 700_000 : 0));
        utimesSync(leftover, modified, modified);
      }
    }
    seed(child.pid, Math.floor(Date.now() / 1000) - 6);
    check('reclaim with leftovers', reclaimed());
    for (const kind of ['stale', 'rel']) {
      check(`old ${kind} directory cleaned`, !existsSync(`${directory}.${kind}.old`));
      check(`young ${kind} directory retained`, existsSync(`${directory}.${kind}.young`));
    }
    mkdirSync(directory);
    const old = new Date(Date.now() - 11_000);
    utimesSync(directory, old, old);
    check('missing owner older than 10s reclaimed', reclaimed());
    seed(process.pid, Math.floor(Date.now() / 1000));
    check('live fresh owner not reclaimed', !lock.acquire() && existsSync(directory));
  } catch (error) {
    check(`unexpected error: ${error.message}`, false);
  } finally {
    lock.release();
    second.release();
    removeLockDirectory(directory);
    for (const name of readdirSync(path.dirname(directory))) {
      removeLockDirectory(path.join(path.dirname(directory), name));
    }
    rmdirSync(path.dirname(directory));
    rmdirSync(root);
    if (previous === undefined) delete process.env.LUNA_ADMIT_LOCK;
    else process.env.LUNA_ADMIT_LOCK = previous;
  }
  process.stdout.write(`lock self-test: passed=${passed} failed=${failed}\n`);
  return failed === 0 ? 0 : 1;
}

function loadConfigMcpNames(configPath) {
  if (!existsSync(configPath)) return [];
  const text = readFileSync(configPath, 'utf8');
  return [...text.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((match) => match[1]);
}

function buildLeanArgs(configPath) {
  const args = [];
  if (process.env.LUNA_POOL_ALLOW_MCP !== '1') {
    for (const name of loadConfigMcpNames(configPath)) {
      args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
  }
  args.push('--disable', 'plugins', '--disable', 'apps');
  return args;
}

function listJobs(briefsDir, fallbackEffort) {
  let names;
  try {
    names = readdirSync(briefsDir).filter((name) => name.endsWith('.brief.md')).sort();
  } catch (error) {
    throw new CliError(`cannot read briefs directory ${briefsDir}: ${error.message}`);
  }
  if (names.length === 0) throw new CliError(`no *.brief.md files in ${briefsDir}`);

  const outputs = new Set();
  return names.map((name) => {
    const briefPath = path.resolve(briefsDir, name);
    let isFile = false;
    try { isFile = statSync(briefPath).isFile(); } catch {}
    if (!isFile) return null;

    let stem = name.slice(0, -'.brief.md'.length);
    const match = stem.match(/\.(low|medium|high|xhigh|max)$/);
    const effort = match?.[1] ?? fallbackEffort;
    if (match) stem = stem.slice(0, -match[0].length);
    const outputName = `${stem}.out.md`;
    const outPath = path.resolve(briefsDir, outputName);
    const outputKey = outPath;
    if (outputs.has(outputKey)) throw new CliError(`multiple briefs resolve to ${outPath}`);
    outputs.add(outputKey);

    let brief;
    try { brief = readFileSync(briefPath, 'utf8'); } catch (error) {
      throw new CliError(`cannot read brief ${briefPath}: ${error.message}`);
    }
    return {
      name,
      stem,
      outputName,
      briefPath,
      outPath,
      logPath: `${outPath}.log`,
      statusPath: `${outPath}.status`,
      effort,
      brief,
      commands: new Map(),
      executedCommands: new Set(),
      retryEffort: null,
      threadId: null,
      turnId: null,
      finalMessage: '',
      state: 'starting',
      startedAt: nowIso(),
      queuedAt: 0,
      turnStartedAt: 0,
      lastEventAt: 0,
      timeout: null,
      idleTimer: null,
      active: false,
      starting: false,
      finished: false,
      interruptPending: false,
      interruptTimer: null,
      heartbeat: null,
      rc: null,
      bytes: 0,
      refusalSuspected: false
    };
  }).filter(Boolean);
}

function makePreamble(brief) {
  if (process.env.LUNA_NO_PREAMBLE === '1') return brief;
  const lines = ['## Standing rules (from the orchestrator)'];
  lines.push('- You are ' + (process.env.LUNA_MODEL || 'gpt-6-luna') + ', invoked by the Claude orchestrator as the EXECUTOR of this job. Any global AGENTS.md/model-orchestration rule telling a model to only orchestrate or to delegate implementation to another model (e.g. "Sol must delegate to Terra") does NOT apply here: do the work yourself.');
  if (process.env.LUNA_ALLOW_SUBAGENTS !== '1') {
    lines.push('- Work yourself. Do NOT spawn sub-agents/delegates/collaborators unless the brief explicitly says you may.');
  }
  lines.push('- Read-only sandbox means you must not MODIFY anything. You CAN and MUST read files and run read-only commands (cat, grep, rg, ls, git diff/log/show) to gather evidence before answering. Never answer \"I cannot read the files\".');
  lines.push('', brief);
  return lines.join('\n');
}

let priorityFailureLogged = false;

function spawnServer(home, leanArgs) {
  const binary = resolveCodex();
  const child = spawn(binary, ['app-server', ...leanArgs], {
    cwd: home, detached: true, env: codexEnvironment(binary), stdio: ['pipe', 'pipe', 'pipe']
  });
  child.lunaIdentity = readProcess(child.pid);
  const priority = spawnSync('renice', ['+10', '-p', String(child.pid)], { stdio: 'ignore' });
  if ((priority.error || priority.status !== 0) && !priorityFailureLogged) {
    priorityFailureLogged = true;
    process.stderr.write('luna: could not lower app-server CPU priority\n');
  }
  return child;
}

function childIdentity(child) {
  if (child.lunaIdentity) return child.lunaIdentity;
  if (typeof child.kill === 'function' && child.exitCode === null && child.signalCode === null) {
    return readProcess(child.pid);
  }
  return ownedProcess(child.pid);
}

function killTreeSync(child) {
  if (!child?.pid) return;
  stopGroupSync(child.pid, childIdentity(child));
}

function killTree(child) {
  if (!child?.pid) return Promise.resolve();
  return stopGroup(child.pid, childIdentity(child));
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteLog(value) {
  return JSON.stringify(String(value ?? ''));
}

async function runPool(config) {
  const {
    jobs, briefsDir, repoRoot, home, model, tier, leanArgs,
    reserveMb, turnMb, serverMb, rampMs, max, waitMaxMs, turnTimeoutMs, idleMaxMs
  } = config;
  loadProxyEnv();
  const noGate = process.env.LUNA_NO_GATE === '1';
  let server;
  let initialized = false;
  let shuttingDown = false;
  let serverFailure = null;
  let serverExitText = '';
  let spawnError = null;
  let startupTimeout;
  let pipeBreakTimer;
  let latestStderr = '';
  let nextRequestId = 1;
  let wakeLoop = null;
  let abortMain;
  let killPromise = null;
  let stdoutClosed = false;
  let processClosed = false;
  const pending = new Map();
  const byThread = new Map();
  const abortPromise = new Promise((resolve) => { abortMain = resolve; });
  const closedPromise = new Promise((resolve) => {
    runPool.resolveClosed = resolve;
  });
  let admissionJob = null;
  let admissionTimer = null;
  const startupReclaims = [];
  const lock = admissionLock(home, (message) => {
    process.stderr.write(`luna-pool: ${message}\n`);
    if (admissionJob) log(admissionJob, message);
    else {
      startupReclaims.push(message);
      for (const job of jobs) log(job, message);
    }
  });

  function releaseAdmission(job) {
    if (job && admissionJob !== job) return;
    clearTimeout(admissionTimer);
    admissionTimer = null;
    lock.release();
    admissionJob = null;
    signalLoop();
  }

  function rampAdmission() {
    if (noGate || rampMs === 0) releaseAdmission();
    else admissionTimer = setTimeout(() => releaseAdmission(), rampMs);
  }

  const onExit = () => {
    lock.release();
    killTreeSync(server);
  };
  process.on('exit', onExit);

  function signalLoop() {
    if (wakeLoop) {
      const wake = wakeLoop;
      wakeLoop = null;
      wake();
    }
  }

  function log(job, message) {
    const line = `[${nowIso()}] ${cleanValue(message)}\n`;
    try { appendFileSync(job.logPath, line, 'utf8'); } catch (error) {
      process.stderr.write(`luna-pool: cannot write ${job.logPath}: ${error.message}\n`);
    }
  }

  function logAgentProgress(job, text) {
    const excerpt = cleanValue(text).slice(0, 400);
    const entry = `codex\n${excerpt}\nexec\n`;
    try { appendFileSync(job.logPath, entry, 'utf8'); } catch (error) {
      process.stderr.write(`luna-pool: cannot write ${job.logPath}: ${error.message}\n`);
    }
  }

  function writeStatus(job, state, extras = {}) {
    const lines = [
      `state=${state}`,
      `pid=${server?.pid ?? ''}`,
      `pid_start=${server?.lunaIdentity?.started || ''}`,
      `wrapper_pid=${process.pid}`,
      `wrapper_start=${readProcess(process.pid)?.started || ''}`,
      `started=${job.startedAt}`,
      `effort=${job.effort}`,
      'sandbox=read-only',
      `model=${cleanValue(model)}`,
      `tier=${cleanValue(tier)}`,
      `dir=${cleanValue(repoRoot)}`,
      'engine=pool',
      `owner=${cleanValue(process.env.LUNA_OWNER || process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`)}`
    ];
    if (job.retryEffort) lines.push('retry=1', `retry_effort=${job.retryEffort}`);
    for (const [key, value] of Object.entries(extras)) {
      if (value !== undefined && value !== null) lines.push(`${key}=${cleanValue(value)}`);
    }
    try { atomicWrite(job.statusPath, `${lines.join('\n')}\n`); } catch (error) {
      process.stderr.write(`luna-pool: cannot write ${job.statusPath}: ${error.message}\n`);
      return;
    }
    // Active-job index for the Luna pane / luna-overview: out path, then the pool process pid.
    try {
      const activeDir = path.join(homedir(), '.claude', 'luna-run', 'active');
      const outHash = createHash('sha1').update(job.outPath).digest('hex').slice(0, 12);
      const activeFile = path.join(activeDir, `pool-${process.pid}-${outHash}`);
      if (/^(?:done|incomplete|failed|stalled)$/.test(state)) {
        try { unlinkSync(activeFile); } catch {}
      } else {
        mkdirSync(activeDir, { recursive: true });
        writeFileSync(activeFile, `${job.outPath.replace(/\\/g, '/')}\n${process.pid}\n` +
          `${readProcess(process.pid)?.started || ''}\n`, 'utf8');
      }
    } catch {
      // the index is cosmetic: never fail a critic over it
    }
    // Learning-loop job registry (single implementation: learning/registry.mjs), after the terminal status write.
    if (/^(?:done|incomplete|failed|stalled)$/.test(state) && process.env.LUNA_NO_REGISTRY !== '1') {
      const registry = path.join(homedir(), '.claude', 'scripts', 'learning', 'registry.mjs');
      import(pathToFileURL(registry).href).then((m) => m.recordJob(job.outPath)).catch(() => {});
    }
  }

  function printFinished(job) {
    process.stdout.write(`done rc=${job.rc} effort=${job.effort} ${job.outputName} (${job.bytes} bytes)\n`);
  }

  function finishFailure(job, error, rc = 1, detail = {}) {
    if (job.finished) return;
    releaseAdmission(job);
    job.finished = true;
    job.active = false;
    job.starting = false;
    job.state = 'failed';
    job.rc = rc;
    if (job.timeout) clearTimeout(job.timeout);
    job.timeout = null;
    if (job.idleTimer) clearInterval(job.idleTimer);
    job.idleTimer = null;
    if (job.heartbeat) clearInterval(job.heartbeat);
    job.heartbeat = null;
    const message = cleanValue(error || 'unknown error');
    log(job, `error=${message}`);
    writeStatus(job, 'failed', { ...detail, rc, finished: nowIso(), error: message });
    log(job, `completion state=failed rc=${rc}`);
    printFinished(job);
    signalLoop();
  }

  function writeOutput(job) {
    const temp = `${job.outPath}.tmp`;
    try {
      writeFileSync(temp, job.finalMessage, 'utf8');
      renameSync(temp, job.outPath);
      job.bytes = Buffer.byteLength(job.finalMessage, 'utf8');
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }

  function finishTurn(job, turn) {
    if (job.finished) return;
    releaseAdmission(job);
    if (turn?.id) job.turnId = turn.id;
    if (!job.finalMessage && Array.isArray(turn?.items)) {
      const finalItem = [...turn.items].reverse().find((item) => item?.type === 'agentMessage');
      if (typeof finalItem?.text === 'string') job.finalMessage = finalItem.text;
    }

    const turnStatus = turn?.status ?? 'unknown';
    const turnError = cleanValue(turn?.error?.message ?? '');
    let failure = '';
    if (turnStatus !== 'completed') failure = turnError || `turn status ${turnStatus}`;
    else if (!job.finalMessage.trim()) failure = 'empty final message';

    let outputWritten = false;
    if (!failure) {
      try { writeOutput(job); outputWritten = true; } catch (error) { failure = `cannot write output: ${error.message}`; }
    } else if (job.finalMessage) {
      try { writeOutput(job); outputWritten = true; } catch (error) {
        failure = `${failure}; cannot write output: ${error.message}`;
      }
    }

    if (outputWritten && process.env.LUNA_NO_REFUSAL_RETRY !== '1'
        && job.executedCommands.size === 0 && isRefusal(job.finalMessage)) {
      if (job.retryEffort) {
        job.refusalSuspected = true;
        log(job, 'second refusal suspected; keeping retry answer');
      } else {
        log(job, 'first refusal answer follows');
        log(job, job.finalMessage);
        log(job, 'end first refusal answer');
        try { unlinkSync(job.outPath); } catch (error) {
          if (error.code !== 'ENOENT') {
            finishFailure(job, `cannot clear previous refusal output: ${error.message}`, 1);
            return;
          }
        }
        job.retryEffort = ['low', 'medium'].includes(job.effort) ? 'high' : job.effort;
        log(job, `refusal detected; retrying at effort=${job.retryEffort}`);
        if (job.timeout) clearTimeout(job.timeout);
        job.timeout = null;
        if (job.idleTimer) clearInterval(job.idleTimer);
        job.idleTimer = null;
        if (job.heartbeat) clearInterval(job.heartbeat);
        job.heartbeat = null;
        byThread.delete(job.threadId);
        job.threadId = null;
        job.turnId = null;
        job.finalMessage = '';
        job.commands.clear();
        job.executedCommands.clear();
        job.active = false;
        job.starting = false;
        job.state = 'starting';
        job.queuedAt = Date.now();
        writeStatus(job, 'starting');
        signalLoop();
        return;
      }
    }

    if (failure) {
      finishFailure(job, failure, 1, { turn_status: turnStatus });
      log(job, `completion turn_status=${turnStatus} error=${failure}`);
      return;
    }

    job.finished = true;
    job.active = false;
    job.starting = false;
    job.state = 'done';
    job.rc = 0;
    if (job.timeout) clearTimeout(job.timeout);
    job.timeout = null;
    if (job.idleTimer) clearInterval(job.idleTimer);
    job.idleTimer = null;
    if (job.heartbeat) clearInterval(job.heartbeat);
    job.heartbeat = null;
    writeStatus(job, 'done', {
      rc: 0,
      finished: nowIso(),
      turn_status: turnStatus,
      bytes: job.bytes,
      ...(job.refusalSuspected ? { refusal_suspected: 1 } : {})
    });
    if (job.refusalSuspected) log(job, 'refusal_suspected=1');
    log(job, `completion state=done rc=0 turn_status=${turnStatus} bytes=${job.bytes}`);
    printFinished(job);
    signalLoop();
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function failServer(error, exitInfo = '') {
    if (shuttingDown || serverFailure) return;
    releaseAdmission();
    serverFailure = cleanValue(error);
    serverExitText = exitInfo;
    rejectPending(new Error(serverFailure));
    if (initialized) {
      for (const job of jobs) {
        if (job.interruptPending) {
          job.active = false;
          job.interruptPending = false;
          if (job.interruptTimer) clearTimeout(job.interruptTimer);
          job.interruptTimer = null;
        }
        if (!job.finished) {
          const suffix = exitInfo ? ` (${exitInfo})` : '';
          finishFailure(job, `${serverFailure}${suffix}`, 1);
        }
      }
      void stopServer();
    } else {
      abortMain(new Error(serverFailure));
    }
    signalLoop();
  }

  function rpc(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!server || serverFailure || shuttingDown) {
      return Promise.reject(new Error(serverFailure || 'app-server is not available'));
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.ceil(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try { server.stdin.write(frame); } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params = {}) {
    if (!server || serverFailure || shuttingDown) return;
    server.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  function sendServerReply(request, result, error) {
    if (!server || serverFailure || shuttingDown) return;
    const frame = error
      ? { id: request.id, error: { code: -32601, message: error } }
      : { id: request.id, result };
    server.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function serverRequestResult(method, params) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: 'decline' };
      case 'item/fileChange/requestApproval':
        return { decision: 'decline' };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      case 'item/tool/requestUserInput': {
        const answers = {};
        for (const question of params?.questions ?? []) {
          if (typeof question?.id === 'string') answers[question.id] = { answers: [] };
        }
        return { answers };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      case 'item/tool/call':
        return {
          contentItems: [{ type: 'inputText', text: 'Dynamic tools are disabled in the read-only pool.' }],
          success: false
        };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return { decision: { denied: { rejection: 'unattended read-only pool' } } };
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
        return null;
      default:
        return null;
    }
  }

  function handleServerRequest(message) {
    const method = message.method;
    const params = message.params ?? {};
    const job = byThread.get(params.threadId ?? params.conversationId);
    const result = serverRequestResult(method, params);
    const unsupported = result === null
      ? `unattended read-only pool cannot handle ${method}`
      : null;
    if (job) log(job, `server request ${method} replied ${unsupported ? 'with error' : 'declined'}`);
    else process.stderr.write(`luna-pool: server request ${method} ${unsupported ? 'rejected' : 'declined'}\n`);
    sendServerReply(message, result, unsupported);
  }

  function handleMessage(message) {
    const params = message?.params ?? {};
    const job = byThread.get(params.threadId ?? params.conversationId);
    if (job?.active && !job.finished) job.lastEventAt = Date.now();
    if (message && message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const messageText = message.error.message ?? JSON.stringify(message.error);
        entry.reject(new Error(`${entry.method}: ${messageText}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message && message.id !== undefined && typeof message.method === 'string') {
      handleServerRequest(message);
      return;
    }

    if (!job) return;

    if (job.interruptPending && message.method === 'turn/completed') {
      if (params.turn?.id === job.turnId) {
        job.active = false;
        job.interruptPending = false;
        if (job.interruptTimer) clearTimeout(job.interruptTimer);
        job.interruptTimer = null;
        if (job.heartbeat) clearInterval(job.heartbeat);
        job.heartbeat = null;
        log(job, 'turn/completed received after timeout; concurrency slot released');
        signalLoop();
      }
      return;
    }
    if (job.finished) return;

    if (message.method === 'turn/started') {
      if (params.turn?.id) job.turnId = params.turn.id;
      log(job, `turn started id=${job.turnId ?? ''}`);
      return;
    }
    if (message.method === 'item/started' && params.item?.type === 'commandExecution') {
      const item = params.item;
      job.executedCommands.add(item.id);
      job.commands.set(item.id, { command: item.command, cwd: item.cwd });
      log(job, `command start cwd=${quoteLog(item.cwd)} command=${quoteLog(item.command)}`);
      return;
    }
    if (message.method === 'item/started' && ['reasoning', 'agentMessage'].includes(params.item?.type)) {
      log(job, `item/started type=${params.item.type}`);
      return;
    }
    if (message.method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        job.finalMessage = item.text;
        log(job, 'item/completed type=agentMessage');
        logAgentProgress(job, item.text);
      } else if (item?.type === 'reasoning') {
        log(job, 'item/completed type=reasoning');
      }
      if (item?.type === 'commandExecution') {
        job.executedCommands.add(item.id);
        const started = job.commands.get(item.id) ?? {};
        const command = item.command ?? started.command ?? '';
        const cwd = item.cwd ?? started.cwd ?? '';
        log(job, `command exit=${item.exitCode ?? 'unknown'} cwd=${quoteLog(cwd)} command=${quoteLog(command)}`);
        job.commands.delete(item.id);
      }
      return;
    }
    if (message.method === 'turn/completed') {
      if (params.turn?.id) job.turnId = params.turn.id;
      finishTurn(job, params.turn);
    }
  }

  function startRequestAnswer(job, response) {
    if (response?.thread?.id) return response.thread.id;
    if (typeof response?.threadId === 'string') return response.threadId;
    throw new Error('thread/start returned no thread id');
  }

  async function startJob(job) {
    job.starting = true;
    job.state = 'starting';
    try {
      const threadParams = {
        model,
        cwd: repoRoot,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: process.env.LUNA_KEEP_SESSION !== '1'
      };
      if (tier !== 'default') threadParams.serviceTier = tier;
      const threadResponse = await rpc('thread/start', threadParams);
      if (job.finished) return;
      job.threadId = startRequestAnswer(job, threadResponse);
      byThread.set(job.threadId, job);
      const brief = job.retryEffort ? `${REFUSAL_RETRY_PROMPT}\n\n${job.brief}` : job.brief;
      const inputText = makePreamble(brief);
      const effort = job.retryEffort ?? job.effort;
      job.active = true;
      job.turnStartedAt = Date.now();
      job.lastEventAt = job.turnStartedAt;
      const turnStarted = rpc('turn/start', {
        threadId: job.threadId,
        effort,
        input: [{ type: 'text', text: inputText, text_elements: [] }]
      });
      rampAdmission();
      const turnResponse = await turnStarted;
      if (job.finished || !job.active) return;
      if (turnResponse?.turn?.id) job.turnId = turnResponse.turn.id;
      job.starting = false;
      job.state = 'running';
      writeStatus(job, 'running');
      log(job, `turn start thread=${job.threadId} turn=${job.turnId ?? ''} model=${model} effort=${effort} tier=${tier}`);
      job.heartbeat = setInterval(() => {
        if (job.active) log(job, 'heartbeat turn active');
      }, 30_000);
      job.timeout = setTimeout(() => {
        stallTurn(job, `exceeded turn timeout ${turnTimeoutMs / 1000}s`);
      }, turnTimeoutMs);
      if (idleMaxMs > 0) {
        job.idleTimer = setInterval(() => {
          if (Date.now() - job.lastEventAt >= idleMaxMs) {
            stallTurn(job, `no events for ${idleMaxMs / 1000}s`);
          }
        }, 5_000);
      }
      signalLoop();
    } catch (error) {
      if (!job.finished) finishFailure(job, error.message, 1);
    }
  }

  function stallTurn(job, error) {
    if (job.finished) return;
    releaseAdmission(job);
    clearTimeout(job.timeout);
    job.timeout = null;
    clearInterval(job.idleTimer);
    job.idleTimer = null;
    clearInterval(job.heartbeat);
    job.heartbeat = null;
    log(job, `error=${error}; sending turn/interrupt`);
    if (job.threadId && job.turnId) {
      rpc('turn/interrupt', { threadId: job.threadId, turnId: job.turnId }, 10_000)
        .then(() => log(job, 'turn/interrupt acknowledged'))
        .catch((interruptError) => log(job, `turn/interrupt error=${interruptError.message}`));
    } else {
      log(job, 'turn/interrupt unavailable: missing turn id');
    }
    job.finished = true;
    job.state = 'stalled';
    job.rc = 124;
    job.starting = false;
    job.interruptPending = true;
    writeStatus(job, 'stalled', { rc: 124, finished: nowIso(), error });
    log(job, `completion state=stalled rc=124 error=${error}; slot retained pending turn/completed`);
    printFinished(job);
    job.interruptTimer = setTimeout(() => {
      if (job.interruptPending) log(job, 'interrupt unconfirmed');
    }, 120_000);
    signalLoop();
  }

  function setJobState(job, state, extras = {}) {
    if (job.finished || (job.state === state && !state.startsWith('waiting-'))) return;
    job.state = state;
    writeStatus(job, state, extras);
  }

  function waitForLock(job) {
    const detail = { waited_s: Math.floor((Date.now() - job.queuedAt) / 1000), ...lock.details() };
    setJobState(job, 'waiting-lock', detail);
    if (job.lastLockNote === undefined || Date.now() - job.lastLockNote >= 60_000) {
      const message = `waiting for admission lock kind=${detail.lock_kind} ` +
        `age=${detail.lock_age_s}s waited=${detail.waited_s}s`;
      process.stderr.write(`luna-pool: ${job.name}: ${message}\n`);
      if (initialized) log(job, message);
      job.lastLockNote = Date.now();
    }
  }

  function stopServer() {
    releaseAdmission();
    if (killPromise) return killPromise;
    shuttingDown = true;
    rejectPending(new Error('app-server is shutting down'));
    killPromise = (async () => {
      if (!server?.pid) return;
      await killTree(server);
      await Promise.race([closedPromise, sleep(1_000)]);
    })();
    return killPromise;
  }

  function onAbort(error, isSignal = false) {
    releaseAdmission();
    if (serverFailure) return;
    serverFailure = cleanValue(error?.message ?? error);
    rejectPending(new Error(serverFailure));
    if (initialized) {
      for (const job of jobs) {
        if (job.interruptPending) {
          job.active = false;
          job.interruptPending = false;
          if (job.interruptTimer) clearTimeout(job.interruptTimer);
          job.interruptTimer = null;
        }
        if (!job.finished) finishFailure(job, serverFailure, 1);
      }
    }
    abortMain(error instanceof Error ? error : new Error(serverFailure));
    signalLoop();
    if (isSignal) void stopServer();
  }

  const onSigint = () => onAbort(new Error('interrupted by SIGINT'), true);
  const onSigterm = () => onAbort(new Error('interrupted by SIGTERM'), true);
  const onUncaught = (error) => {
    process.stderr.write(`luna-pool: uncaught error: ${error.stack ?? error.message}\n`);
    onAbort(error);
    void stopServer();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  try {
    try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const admissionStarted = Date.now();
    for (const job of jobs) job.queuedAt = admissionStarted;
    let lastRamNote = 0;
    let admissionCause = 'admission lock';
    while (true) {
      if (serverFailure) throw new Error(serverFailure);
      if (noGate || lock.acquire()) {
        const freeMb = Math.floor(availableMemory() / MB);
        if (noGate || freeMb - serverMb >= reserveMb) break;
        releaseAdmission();
        admissionCause = 'RAM';
        for (const job of jobs) {
          setJobState(job, 'waiting-ram', {
            waited_s: Math.floor((Date.now() - admissionStarted) / 1000),
            free_mb: freeMb, need_mb: serverMb, reserve_mb: reserveMb
          });
        }
        if (lastRamNote === 0 || Date.now() - lastRamNote >= 60_000) {
          process.stderr.write(`luna-pool: waiting for app-server RAM free=${freeMb}MB ` +
            `need=${serverMb}MB reserve=${reserveMb}MB\n`);
          lastRamNote = Date.now();
        }
      } else {
        admissionCause = 'admission lock';
        for (const job of jobs) waitForLock(job);
      }
      if (Date.now() - admissionStarted >= waitMaxMs) {
        const error = `gave up waiting for ${admissionCause} for app-server`;
        for (const job of jobs) finishFailure(job, error, 75);
        throw new CliError(error, 75);
      }
      await Promise.race([sleep(300 + Math.floor(Math.random() * 201)), abortPromise]);
    }
    server = spawnServer(home, leanArgs);
    rampAdmission();
    server.on('error', (error) => {
      spawnError = error;
      failServer(`cannot start codex app-server: ${error.message}`);
    });
    server.on('exit', (code, signal) => {
      processClosed = true;
      const codeText = code === null ? 'null' : String(code);
      const info = `code ${codeText}${signal ? ` signal ${signal}` : ''}`;
      if (!shuttingDown) failServer(`app-server exited`, info);
    });
    server.on('close', () => {
      processClosed = true;
      runPool.resolveClosed?.();
    });
    server.stdin.on('error', (error) => {
      if (!shuttingDown) failServer(`app-server pipe broke: ${error.message}`);
    });
    server.stdout.on('error', (error) => {
      if (!shuttingDown) failServer(`app-server pipe broke: ${error.message}`);
    });
    server.stdout.on('end', () => {
      stdoutClosed = true;
      pipeBreakTimer = setTimeout(() => {
        if (!shuttingDown && !processClosed) failServer('app-server stdout pipe closed');
      }, 1_000);
    });
    server.stderr.on('data', (chunk) => {
      latestStderr = `${latestStderr}${chunk.toString('utf8')}`.slice(-8_000);
    });

    const lines = readline.createInterface({ input: server.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch {
        failServer(`invalid app-server JSON frame: ${line.slice(0, 200)}`);
        return;
      }
      try { handleMessage(message); } catch (error) {
        failServer(`app-server protocol handling failed: ${error.message}`);
      }
    });

    startupTimeout = setTimeout(() => {
      if (!initialized) failServer(`app-server initialize timed out after ${STARTUP_TIMEOUT_MS / 1000}s`);
    }, STARTUP_TIMEOUT_MS);
    const initialize = rpc('initialize', {
      clientInfo: { name: 'luna-pool', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }, STARTUP_TIMEOUT_MS);
    await Promise.race([initialize, abortPromise]);
    if (serverFailure) throw new Error(serverFailure);
    clearTimeout(startupTimeout);
    startupTimeout = null;
    notify('initialized', {});
    initialized = true;

    const now = Date.now();
    for (const job of jobs) {
      job.queuedAt = now;
      job.startedAt = nowIso();
      try { unlinkSync(job.outPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { writeFileSync(job.logPath, '', 'utf8'); } catch (error) {
        finishFailure(job, `cannot create log: ${error.message}`, 1);
        continue;
      }
      job.state = 'starting';
      writeStatus(job, 'starting');
      log(job, `queued brief=${job.name} effort=${job.effort} output=${job.outPath}`);
      for (const message of startupReclaims) log(job, message);
    }

    let nextRetryAt = Date.now();
    while (jobs.some((job) => !job.finished || job.active)) {
      if (serverFailure) break;
      const time = Date.now();
      for (const job of jobs) {
        if (job.finished) continue;
        if (!job.active && !job.starting && time - job.queuedAt >= waitMaxMs) {
          const waitingLock = job.state === 'waiting-lock';
          finishFailure(job, `gave up waiting for ${waitingLock ? 'admission lock' : 'RAM'}`, 75, {
            waited_s: Math.floor((time - job.queuedAt) / 1000),
            ...(waitingLock ? lock.details() : {}),
            free_mb: Math.floor(availableMemory() / MB),
            need_mb: turnMb,
            reserve_mb: reserveMb
          });
        }
      }

      const candidate = jobs.find((job) => !job.finished && !job.active && !job.starting);
      if (candidate && Date.now() >= nextRetryAt) {
        const active = jobs.reduce((count, job) => count + (job.active ? 1 : 0), 0);
        if (active >= max) {
          for (const job of jobs) {
            if (!job.active && !job.starting) setJobState(job, 'starting');
          }
          nextRetryAt = Date.now() + 2_000;
        } else if (lock.held) {
          for (const job of jobs) {
            if (!job.active && !job.starting) waitForLock(job);
          }
          nextRetryAt = Date.now() + 300 + Math.floor(Math.random() * 201);
        } else {
          admissionJob = candidate;
          if (!noGate && !lock.acquire()) {
            admissionJob = null;
            for (const job of jobs) {
              if (!job.active && !job.starting) waitForLock(job);
            }
            nextRetryAt = Date.now() + 300 + Math.floor(Math.random() * 201);
          } else {
            const freeMb = Math.floor(availableMemory() / MB);
            if (!noGate && freeMb - turnMb < reserveMb) {
              releaseAdmission();
              for (const job of jobs) {
                if (!job.active && !job.starting) {
                  setJobState(job, 'waiting-ram', {
                    free_mb: freeMb,
                    need_mb: turnMb,
                    reserve_mb: reserveMb,
                    waited_s: Math.floor((Date.now() - job.queuedAt) / 1000)
                  });
                }
              }
              log(candidate, `waiting for RAM free=${freeMb}MB need=${turnMb}MB reserve=${reserveMb}MB`);
              nextRetryAt = Date.now() + 2_000;
            } else {
              nextRetryAt = Date.now();
              await startJob(candidate);
              continue;
            }
          }
        }
      }

      // A missing turn/completed after interrupt must not keep an otherwise finished pool alive.
      if (jobs.every((job) => job.finished) || serverFailure) break;
      const waitForRetry = Math.max(50, Math.min(500, nextRetryAt - Date.now()));
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wakeLoop === finish) wakeLoop = null;
          resolve();
        };
        const timer = setTimeout(finish, waitForRetry);
        wakeLoop = finish;
      });
    }

    if (serverFailure && !processClosed && !shuttingDown) await stopServer();
    else await stopServer();
    const done = jobs.filter((job) => job.state === 'done').length;
    const failed = jobs.length - done;
    process.stdout.write(`summary total=${jobs.length} done=${done} failed=${failed}\n`);
    return failed === 0 ? 0 : 1;
  } catch (error) {
    releaseAdmission();
    if (error instanceof CliError && error.code === 75) {
      process.stderr.write(`luna-pool: ${error.message}\n`);
      return 75;
    }
    if (!initialized) {
      const details = latestStderr.trim();
      const message = spawnError
        ? `cannot start codex app-server: ${spawnError.message}`
        : (error?.message ?? String(error));
      process.stderr.write(`luna-pool: startup failed: ${cleanValue(message)}${details ? `\n${details}` : ''}\n`);
      process.stdout.write(`summary total=${jobs.length} done=0 failed=0 startup_failure=1\n`);
      return error.exitCode === 2 ? 2 : 3;
    }
    for (const job of jobs) {
      if (!job.finished) finishFailure(job, error?.message ?? String(error), 1);
    }
    await stopServer();
    const done = jobs.filter((job) => job.state === 'done').length;
    process.stdout.write(`summary total=${jobs.length} done=${done} failed=${jobs.length - done}\n`);
    process.stderr.write(`luna-pool: ${cleanValue(error?.message ?? error)}\n`);
    return 1;
  } finally {
    releaseAdmission();
    for (const job of jobs) {
      clearTimeout(job.timeout);
      clearInterval(job.idleTimer);
      clearInterval(job.heartbeat);
      clearTimeout(job.interruptTimer);
    }
    clearTimeout(startupTimeout);
    clearTimeout(pipeBreakTimer);
    if (server && !shuttingDown) await stopServer();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUncaught);
    process.removeListener('exit', onExit);
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test-refusal') return selfTestRefusal();
  if (process.argv.length === 3 && process.argv[2] === '--self-test-lock') return selfTestLock();
  const raw = parseArgs(process.argv.slice(2));
  const briefsDir = path.resolve(raw.briefsDir);
  const repoRoot = path.resolve(raw.repoRoot);
  const home = path.resolve(process.env.HOME || homedir());
  const configHome = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));
  const configPath = path.resolve(configHome, 'config.toml');

  if (!existsSync(briefsDir) || !statSync(briefsDir).isDirectory()) {
    throw new CliError(`briefs directory does not exist: ${briefsDir}`);
  }
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    throw new CliError(`repo root does not exist: ${repoRoot}`);
  }

  const requestedEffort = raw.effort ?? process.env.LUNA_PANEL_EFFORT ?? 'high';
  if (!EFFORTS.has(requestedEffort)) throw new CliError(`unknown effort '${requestedEffort}'`);
  const max = raw.max ?? envInteger('LUNA_POOL_MAX', 16, 1);
  const reserveMb = envInteger(
    'LUNA_RAM_RESERVE_MB',
    Math.max(1024, Math.floor((totalmem() / MB) * 0.06)),
    0
  );
  const turnMb = envInteger('LUNA_POOL_TURN_MB', 120, 0);
  const serverMb = envInteger('LUNA_POOL_SERVER_MB', 120, 0);
  const rampMs = envInteger('LUNA_POOL_RAMP_MS', 2000, 0);
  const waitMaxMs = envInteger('LUNA_WAIT_MAX_S', 1800, 0) * 1000;
  const turnTimeoutMs = envInteger('LUNA_TURN_TIMEOUT_S', 2400, 1) * 1000;
  const idleMaxMs = envInteger('LUNA_IDLE_MAX_S', 900, 0) * 1000;
  if ([waitMaxMs, turnTimeoutMs, rampMs, idleMaxMs].some((value) => value > MAX_TIMER_MS)) {
    throw new CliError('timeout settings exceed the supported timer range');
  }
  const tier = process.env.LUNA_TIER || 'default';
  const model = process.env.LUNA_MODEL || 'gpt-6-luna';
  const leanArgs = buildLeanArgs(configPath);
  const jobs = listJobs(briefsDir, requestedEffort);
  if (jobs.length === 0) throw new CliError(`no regular *.brief.md files in ${briefsDir}`);

  if (raw.dryRun) {
    process.stdout.write(`plan briefs_dir=${briefsDir}\n`);
    process.stdout.write(`plan repo_root=${repoRoot}\n`);
    process.stdout.write(`plan reserve_mb=${reserveMb} turn_mb=${turnMb} max=${max}\n`);
    process.stdout.write(`plan lean_args=${JSON.stringify(leanArgs)}\n`);
    const mcpPolicy = process.env.LUNA_POOL_ALLOW_MCP === '1'
      ? 'explicitly allowed; plugins and apps disabled'
      : 'disabled; plugins and apps disabled (LUNA_FULL and LUNA_MCP ignored)';
    process.stdout.write(`plan mcp_policy=${mcpPolicy}\n`);
    for (const job of jobs) {
      process.stdout.write(`job effort=${job.effort} brief=${job.briefPath} output=${job.outPath}\n`);
    }
    return 0;
  }

  return runPool({
    jobs,
    briefsDir,
    repoRoot,
    home,
    model,
    tier,
    leanArgs,
    reserveMb,
    turnMb,
    serverMb,
    rampMs,
    max,
    waitMaxMs,
    turnTimeoutMs,
    idleMaxMs
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  const code = error instanceof CliError ? error.code : 1;
  process.stderr.write(`luna-pool: ${error.message}\n`);
  process.exitCode = code;
}
