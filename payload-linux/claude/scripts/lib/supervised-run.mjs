import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, listProcesses, processAlive, readProcessStat } from '../conveyor/lib/platform.mjs';

const live = new Set();
const windows = process.platform === 'win32';

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
    try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function terminate(child) {
  if (windows) {
    const error = await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, resolve);
    });
    if (error && child.exitCode === null) child.kill();
    return;
  }
  // Some helpers start probes in their own process groups. Keep their identities across reparenting.
  let members = treeMembers(child.pid);
  killTree(child, 'SIGTERM', { groupOnly: true });
  signalOutsideGroup(members, child.pid, 'SIGTERM');
  await sleep(2000);
  members = treeMembers(child.pid, members);
  killTree(child, 'SIGKILL', { groupOnly: true });
  signalOutsideGroup(members, child.pid, 'SIGKILL');
  const until = performance.now() + 1000;
  while ([...members.values()].some(sameProcess) && performance.now() < until) await sleep(20);
}

export async function run(argv, { deadlineMs = 120_000, cwd, env, maxOutput = 4 * 1024 * 1024 } = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (child.pid) live.add(child.pid);
  let remaining = maxOutput;
  const capture = (stream) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      if (remaining <= 0) return;
      const part = chunk.subarray(0, remaining);
      chunks.push(part);
      remaining -= part.length;
    });
    return () => Buffer.concat(chunks).toString('utf8');
  };
  const stdout = capture(child.stdout), stderr = capture(child.stderr);
  let spawnError, termination;
  child.once('error', (error) => { spawnError = error; });
  const timer = setTimeout(() => {
    if (child.pid) termination = terminate(child).catch((error) => { spawnError ??= error; });
  }, deadlineMs);
  try {
    const code = await new Promise((resolve) => child.once('close', resolve));
    await termination;
    return { code, stdout: stdout(), stderr: stderr() || spawnError?.message || '', timedOut: Boolean(termination) };
  } finally {
    clearTimeout(timer);
    live.delete(child.pid);
  }
}

// The marker is an exact Node argv entry scoped to this collector's run directory.
export function sweepOrphans(scripts, marker) {
  if (process.platform !== 'linux') return;
  for (const row of listProcesses() ?? []) {
    const { pid, ppid, group, started } = row;
    if (pid === process.pid || live.has(pid) || ppid > 1 && processAlive(ppid)) continue;
    let argv;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (argv[1] !== marker || !scripts.has(argv[2])) continue;
    const current = readProcessStat(pid);
    if (current?.started !== started || current.ppid !== ppid || current.state === 'Z') continue;
    if (group === pid) killTree(pid, 'SIGKILL', { groupOnly: true });
    else {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
