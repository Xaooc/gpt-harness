// Linux runtime shared by the wrapper, daemon, pool and offline checks.
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integer milliseconds keep very large retry delays exact and retain subsecond jitter for short delays.
export function modelRetryDelayMs(baseSeconds, retry, random = Math.random) {
  const base = BigInt(baseSeconds) * BigInt(retry) * 1000n;
  const fraction = BigInt(Math.floor(random() * 300_000_001));
  return base + base * fraction / 1_000_000_000n;
}

export function formatRetryDelay(ms) {
  const value = BigInt(ms);
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
}

export function availableMemory() {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!match) throw new Error('MemAvailable missing from /proc/meminfo');
  return Number(match[1]) * 1024;
}

export function loadProxyEnv(env = process.env, home = env.HOME || homedir()) {
  if (env.HTTPS_PROXY) return;
  const configured = env.LUNA_PROXY_ENV_FILE;
  let file = configured || path.join(home, '.config', 'luna-proxy.env');
  if (file === '~') file = home;
  else if (file.startsWith('~/')) file = path.join(home, file.slice(2));
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) {
    if (configured || error.code !== 'ENOENT') return;
    try { content = readFileSync(path.join(home, '.config', 'bro-env.sh'), 'utf8'); }
    catch { return; }
  }
  const allowed = new Set(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'ALL_PROXY', 'all_proxy']);
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    let value = match[2];
    const single = value.startsWith("'");
    const quoted = single ? /^'([^']*)'\s*(?:#.*)?$/.exec(value)
      : value.startsWith('"') ? /^"([^"\\]*)"\s*(?:#.*)?$/.exec(value) : null;
    if (single || value.startsWith('"')) {
      if (!quoted) continue;
      value = quoted[1];
    } else {
      const unquoted = /^([^\s;|&<>#]+)(?:\s+#.*)?$/.exec(value);
      if (!unquoted) continue;
      value = unquoted[1];
    }
    // Support ordinary shell variable expansion only; never execute shell expressions.
    if (!single) {
      if (/[`\\]/.test(value) || /\$\(/.test(value)) continue;
      value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_, braced, plain) => (braced || plain) === 'HOME' ? home : env[braced || plain] || '');
      if (value.includes('$')) continue;
    }
    env[match[1]] = value;
  }
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
  catch { return false; }
}

export function resolveCodex(env = process.env, home = env.HOME || homedir()) {
  if (Object.hasOwn(env, 'LUNA_CODEX_BIN')) {
    if (!executable(env.LUNA_CODEX_BIN)) {
      const error = new Error('LUNA_CODEX_BIN is not an executable file');
      error.exitCode = 2;
      throw error;
    }
    return path.resolve(env.LUNA_CODEX_BIN);
  }
  const entries = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const shim = entries.map((entry) => path.resolve(entry, 'codex')).find(executable);
  const roots = new Set();
  if (shim) {
    try {
      const root = managedPackageRoot(realpathSync(shim));
      if (root) roots.add(root);
    } catch {}
  }
  roots.add(path.join(home, '.npm-global/lib/node_modules/@openai/codex'));
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (arch) {
    for (const root of roots) {
      const vendors = [path.join(root, 'vendor'),
        path.join(root, 'node_modules/@openai', `codex-linux-${process.arch}`, 'vendor')];
      for (const vendor of vendors) {
        let triples;
        try { triples = readdirSync(vendor).sort(); } catch { continue; }
        for (const triple of triples.filter((name) => name.startsWith(`${arch}-unknown-linux-`))) {
          for (const dir of ['codex', 'bin']) {
            const binary = path.join(vendor, triple, dir, 'codex');
            if (executable(binary)) return binary;
          }
        }
      }
    }
  }
  if (shim) return shim;
  const fallback = path.join(home, '.npm-global/bin/codex');
  if (executable(fallback)) return fallback;
  throw new Error('codex executable not found');
}

export function managedPackageRoot(binary) {
  // Preserve the stock npm launcher's metadata when skipping its Node shim.
  let directory = path.dirname(binary);
  while (directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@openai/codex') return directory;
    } catch {}
    directory = path.dirname(directory);
  }
  return '';
}

export function codexEnvironment(binary, env = process.env) {
  const root = managedPackageRoot(binary);
  if (!root) return env;
  const result = { ...env, CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: '1' };
  delete result.CODEX_MANAGED_BY_BUN;
  delete result.CODEX_MANAGED_BY_PNPM;
  delete result.CODEX_MANAGED_BY_VITE_PLUS;
  return result;
}

export function readProcess(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]),
      started: fields[19], command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() };
  } catch { return null; }
}

export function matchingProcess(pid, started) {
  const row = readProcess(pid);
  return row && row.state !== 'Z' && started && row.started === String(started) ? row : null;
}

export function ownedProcess(pid, started) {
  const row = readProcess(pid);
  return row && row.state !== 'Z' && (started === undefined || row.started === String(started)) &&
    /codex|luna[-.]/i.test(row.command) ? row : null;
}

export function processRows() {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(readProcess).filter(Boolean);
}

export function timedProcessRows() {
  const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
  if (!(ticks > 0) || !(boot > 0)) throw new Error('cannot read process start times');
  return processRows().map((row) => ({ ...row, created: (boot + Number(row.started) / ticks) * 1000 }));
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function groupAlive(pid, members) {
  const rows = processRows().filter((row) => row.group === pid && row.state !== 'Z');
  if (!rows.some((row) => members.get(row.pid) === row.started)) return false;
  for (const row of rows) members.set(row.pid, row.started);
  return true;
}

// File-sourced PIDs require an owned command; direct children can supply their recorded identity.
export async function stopGroup(pid, identity = ownedProcess(pid)) {
  pid = Number(pid);
  const current = readProcess(pid);
  if (!identity || !current || current.started !== identity.started || current.command !== identity.command ||
      current.group !== pid) return false;
  const members = new Map(processRows().filter((row) => row.group === pid)
    .map((row) => [row.pid, row.started]));
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (groupAlive(pid, members) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (groupAlive(pid, members)) signalGroup(pid, 'SIGKILL');
  return true;
}

export function stopGroupSync(pid, identity = ownedProcess(pid)) {
  pid = Number(pid);
  const current = readProcess(pid);
  if (!identity || !current || current.started !== identity.started || current.command !== identity.command ||
      current.group !== pid) return false;
  const members = new Map(processRows().filter((row) => row.group === pid)
    .map((row) => [row.pid, row.started]));
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (groupAlive(pid, members) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 100);
  if (groupAlive(pid, members)) signalGroup(pid, 'SIGKILL');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, pid, started] = process.argv.slice(2);
  try {
    if (mode === '--resolve') process.stdout.write(`${resolveCodex()}\n`);
    else if (mode === '--package-root') process.stdout.write(`${managedPackageRoot(pid)}\n`);
    else if (mode === '--ram') process.stdout.write(`${Math.floor(availableMemory() / 1048576)}\n`);
    else if (mode === '--start') process.stdout.write(`${readProcess(pid)?.started || ''}\n`);
    else if (mode === '--retry-delay') {
      const ms = modelRetryDelayMs(pid, started);
      process.stdout.write(`${formatRetryDelay(ms)} ${ms}\n`);
    }
    else if (mode === '--owned') process.exitCode = started && ownedProcess(pid, started) ? 0 : 1;
    else if (mode === '--stop') process.exitCode = started && await stopGroup(pid, ownedProcess(pid, started)) ? 0 : 1;
    else throw new Error('usage: luna-runtime.mjs --resolve|--package-root BIN|--ram|--start PID|' +
      '--owned PID START|--stop PID START|--retry-delay BASE COUNT');
  } catch (error) {
    process.stderr.write(`luna-runtime: ${error.message}\n`);
    process.exitCode = 2;
  }
}
