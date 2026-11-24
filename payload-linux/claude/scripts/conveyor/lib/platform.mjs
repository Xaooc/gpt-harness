import { spawnSync } from 'node:child_process';
import fs, { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const override = process.env.CONVEYOR_PLATFORM;
export const platform = ['win32', 'linux'].includes(override) ? override : process.platform;

export function home(env = process.env) {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
}

function isFile(file) {
  try { return Boolean(file && statSync(file).isFile()); } catch { return false; }
}

export function bash() {
  if (platform !== 'win32') return 'bash';
  if (isFile(process.env.GIT_BASH)) return process.env.GIT_BASH;
  const found = spawnSync('where.exe', ['bash'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  for (const file of (found.stdout || '').trim().split(/\r?\n/)) {
    // Windows also ships a WSL launcher and an app alias named bash.exe.
    if (!/[\\/](?:system32|syswow64|windowsapps)[\\/]/i.test(file) &&
        /^bash\.exe$/i.test(path.win32.basename(file)) && isFile(file)) return file;
  }
  for (const root of [process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) {
    const git = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (isFile(git)) return git;
  }
  const bundled = path.join(process.env.CLAUDE_HOME_DIR || path.join(home(), '.claude'), 'bin', 'luna-sh', 'sh.exe');
  if (isFile(bundled)) return bundled;
  throw new Error('Conveyor shell unavailable: install Git for Windows, set GIT_BASH, or install the bundled luna-sh.');
}

export function shell() {
  return [platform === 'win32' ? bash() : '/bin/sh', '-c'];
}

export function killTree(child, signal, { groupOnly = false, timeoutMs = 5000 } = {}) {
  const pid = typeof child === 'number' ? child : child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: timeoutMs
    });
    // A failed taskkill is reported to stderr, never thrown: callers are cleaning up after a timeout and must still
    // write their result.
    if (result.error || (result.status !== 0 && processAlive(pid))) {
      process.stderr.write(`taskkill failed for pid ${pid}: ${result.error?.message ?? `exit ${result.status}`}\n`);
    }
    return;
  }
  try { process.kill(-pid, signal); }
  catch (error) {
    if (groupOnly) {
      if (error.code !== 'ESRCH') throw error;
    } else {
      try { process.kill(pid, signal); }
      catch (fallbackError) { if (fallbackError.code !== 'ESRCH') throw fallbackError; }
    }
  }
}

function linuxProcessStat(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), started: fields[19] };
}

export function readProcessStat(pid) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try { return linuxProcessStat(pid); } catch { return null; }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code !== 'EPERM') return false; }
  return readProcessStat(pid)?.state !== 'Z';
}

function readLockProcess(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null;
  try {
    const row = linuxProcessStat(pid);
    readFileSync(`/proc/${pid}/cmdline`);
    return row;
  } catch { return null; }
}

export function lockOwnerAlive(pid, start) {
  // Keep an occupied lock even when the platform cannot check a PID's start time.
  if (platform !== 'linux') return processAlive(pid);
  const row = readLockProcess(pid);
  return Boolean(row && row.state !== 'Z' && start && row.started === String(start));
}

export function lockOwnerStart() {
  return platform === 'linux' ? readLockProcess(process.pid)?.started : undefined;
}

function linuxArgv(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

export function listProcesses({ argv = false } = {}) {
  if (platform !== 'linux') return null;
  const rows = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const row = linuxProcessStat(name);
      if (argv) row.argv = linuxArgv(name);
      rows.push(row);
    } catch (error) {
      if (argv && !['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return rows;
}

export function readProcessCommand(pid) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { argv: linuxArgv(pid), exe: fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') };
}

export function linuxBootId() {
  return platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null;
}

export function linuxUptimeMs() {
  return platform === 'linux' ? Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000 : null;
}

// Match short binary signatures without buffering the file. A match must fit in the overlap.
export async function scanBinary(file, regex, { signal, maxBytes = Infinity } = {}) {
  const pattern = new RegExp(regex.source, regex.global ? regex.flags : regex.flags + 'g');
  const matches = [];
  let tail = '', bytes = 0;
  function scan(text, limit) {
    let end = limit;
    for (const match of text.matchAll(pattern)) {
      if (match.index >= limit) break;
      bytes += Buffer.byteLength(match[0]) + 1;
      if (bytes > maxBytes) throw new Error('Binary scan output too large');
      matches.push(match[0]);
      end = Math.max(end, match.index + match[0].length);
    }
    return text.slice(end);
  }
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024, signal })) {
    const text = tail + chunk;
    tail = scan(text, Math.max(0, text.length - 1024));
  }
  scan(tail, tail.length + 1);
  return matches;
}
