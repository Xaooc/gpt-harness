import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { listProcesses, processAlive, readProcessStat } from '../conveyor/lib/platform.mjs';

const live = new Map();
const windows = process.platform === 'win32';
const GRACE_MS = 2000;
let closing = false;

export function startMaintenanceWatchdog() {
  if (process.env.LUNA_SESSION_MAINTENANCE !== '1') return;
  setTimeout(async () => {
    closing = true;
    await Promise.allSettled([...live.values()].map((stop) => stop()));
    process.exit(1);
  }, 120_000).unref();
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal); return true; }
  catch (error) {
    if (signal === 0 && error.code === 'EPERM') return true;
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

function treeMembers(group, known = new Map()) {
  let rows;
  try { rows = listProcesses() ?? []; } catch { return known; }
  const roots = new Set(rows.filter((row) => row.group === group || known.get(row.pid)?.started === row.started)
    .map((row) => row.pid));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  for (const pid of roots) {
    for (const child of children.get(pid) ?? []) roots.add(child);
  }
  return new Map(rows.filter((row) => roots.has(row.pid)).map((row) => [row.pid, row]));
}

function sameProcess(row) {
  const current = readProcessStat(row.pid);
  return current?.started === row.started && current.state !== 'Z';
}

function signalOutsideGroup(members, group, signal) {
  for (const row of members.values()) {
    if (row.group === group || !sameProcess(row)) continue;
    signalProcess(row.pid, signal);
  }
}

async function terminate(child, pgid) {
  if (windows) {
    const error = await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, resolve);
    });
    if (error && child.exitCode === null) child.kill();
    return;
  }
  // Some helpers start probes in their own process groups. Keep their identities across reparenting.
  let members = treeMembers(pgid);
  signalProcess(-pgid, 'SIGTERM');
  signalOutsideGroup(members, pgid, 'SIGTERM');
  await sleep(GRACE_MS);
  members = treeMembers(pgid, members);
  signalProcess(-pgid, 'SIGKILL');
  signalOutsideGroup(members, pgid, 'SIGKILL');
  // Give the kernel a bounded chance to deliver SIGKILL before returning these PIDs to the caller.
  const until = performance.now() + 100;
  while ([...members.values()].some(sameProcess) && performance.now() < until) await sleep(10);
}

export async function run(argv, {
  deadlineMs = 120_000, cwd, env, maxOutput = 4 * 1024 * 1024, signal, input, stopWhen
} = {}) {
  if (closing || signal?.aborted) return { code: null, stdout: '', stderr: 'command cancelled', timedOut: false };
  const child = spawn(argv[0], argv.slice(1), {
    cwd, env, detached: !windows, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  const pgid = child.pid;
  let remaining = maxOutput, truncated = false;
  const capture = (stream) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      if (chunk.length > remaining) truncated = true;
      if (remaining <= 0) return;
      const part = chunk.subarray(0, remaining);
      chunks.push(part);
      remaining -= part.length;
    });
    return () => Buffer.concat(chunks).toString('utf8');
  };
  const stdout = capture(child.stdout), stderr = capture(child.stderr);
  let spawnError, timedOut = false, termination, closeGrace, groupPoll;
  child.once('error', (error) => { spawnError = error; });
  const destroyPipes = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  let exitCode = null;
  child.once('exit', (code) => {
    exitCode = code;
    if (!windows || termination) return;
    clearTimeout(timer);
    closeGrace = setTimeout(() => {
      destroyPipes();
      finish(code);
    }, GRACE_MS);
  });
  child.once('close', (code) => {
    clearTimeout(closeGrace);
    if (termination) return;
    const checkGroup = () => {
      if (windows || !pgid || !signalProcess(-pgid, 0)) finish(code);
      else groupPoll = setTimeout(checkGroup, 50);
    };
    checkGroup();
  });
  const stop = () => {
    if (!pgid) return result;
    clearTimeout(groupPoll);
    clearTimeout(closeGrace);
    termination ??= terminate(child, pgid).catch((error) => { spawnError ??= error; }).finally(() => {
      destroyPipes();
      finish(exitCode);
    });
    return termination;
  };
  if (pgid) live.set(pgid, stop);
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, deadlineMs);
  signal?.addEventListener('abort', stop, { once: true });
  if (stopWhen) child.stdout.on('data', () => { if (!termination && stopWhen(stdout())) void stop(); });
  if (child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  try {
    const code = await result;
    return { code, stdout: stdout(), stderr: stderr() || spawnError?.message || '', timedOut,
      ...(truncated ? { truncated: true } : {}) };
  } finally {
    clearTimeout(timer);
    clearTimeout(closeGrace);
    clearTimeout(groupPoll);
    signal?.removeEventListener('abort', stop);
    live.delete(pgid);
  }
}

// The marker is an exact Node argv entry scoped to this collector's run directory.
export async function sweepOrphans(scripts, marker) {
  if (process.platform !== 'linux') return;
  const orphans = [];
  for (const row of listProcesses() ?? []) {
    const { pid, ppid, group, started } = row;
    if (pid === process.pid || live.has(pid) || ppid > 1 && processAlive(ppid)) continue;
    let argv;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (argv[1] !== marker || !scripts.has(argv[2])) continue;
    const current = readProcessStat(pid);
    if (current?.started !== started || current.ppid !== ppid || current.state === 'Z') continue;
    const target = group === pid ? -pid : pid;
    if (signalProcess(target, 'SIGTERM')) orphans.push({ row, target });
  }
  if (!orphans.length) return;
  await sleep(GRACE_MS);
  for (const { row, target } of orphans) {
    const current = readProcessStat(row.pid);
    if (current && current.started !== row.started) continue;
    if (target < 0 || current && current.state !== 'Z') signalProcess(target, 'SIGKILL');
  }
}
