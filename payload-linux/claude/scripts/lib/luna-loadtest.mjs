#!/usr/bin/env node
// Usage: node lib/luna-loadtest.mjs [--sessions 4] [--jobs-per-session 6]
//   [--wrapper luna.sh.next] [--prompt-kind light|commands] [--sample-ms 1000]
//   [--out-dir <dir>] [--stagger-ms 300] [--dry-run]
// Runs several fake Claude sessions against the Luna wrapper and records load.
import { spawn } from 'node:child_process';
import {
  appendFileSync, mkdirSync, readFileSync, writeFileSync
} from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableMemory, timedProcessRows } from './luna-runtime.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = 'bash';
const DEFAULT_OUT_ROOT = path.join(os.homedir(), '.claude/luna-run/loadtest');
const MB = 1024 * 1024;
const TERMINAL = new Set(['done', 'failed', 'incomplete', 'stalled']);

function usageError(message) {
  throw new Error(`${message}\nUse --help for usage.`);
}

function parseArgs(argv) {
  const config = {
    sessions: 4,
    jobsPerSession: 6,
    wrapper: 'luna.sh.next',
    promptKind: 'light',
    sampleMs: 1000,
    outDir: null,
    staggerMs: 300,
    dryRun: false
  };
  const values = new Map([
    ['--sessions', 'sessions'], ['--jobs-per-session', 'jobsPerSession'],
    ['--wrapper', 'wrapper'], ['--prompt-kind', 'promptKind'],
    ['--sample-ms', 'sampleMs'], ['--out-dir', 'outDir'], ['--stagger-ms', 'staggerMs']
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('node luna-loadtest.mjs [--sessions 4] [--jobs-per-session 6] ' +
        '[--wrapper luna.sh.next] [--prompt-kind light|commands] [--sample-ms 1000] ' +
        '[--out-dir <dir>] [--stagger-ms 300] [--dry-run]\n');
      process.exit(0);
    }
    if (arg === '--dry-run') {
      config.dryRun = true;
      continue;
    }
    const key = values.get(arg);
    if (!key) usageError(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usageError(`missing value for ${arg}`);
    i += 1;
    if (['sessions', 'jobsPerSession', 'sampleMs', 'staggerMs'].includes(key)) {
      if (!/^\d+$/.test(value)) usageError(`${arg} must be a non-negative integer`);
      config[key] = Number(value);
    } else {
      config[key] = value;
    }
  }
  if (config.sessions < 1 || config.jobsPerSession < 1) {
    usageError('--sessions and --jobs-per-session must be at least 1');
  }
  if (config.sampleMs < 10) usageError('--sample-ms must be at least 10');
  if (!['light', 'commands'].includes(config.promptKind)) {
    usageError('--prompt-kind must be light or commands');
  }
  if (!/^[\w.-]+$/.test(config.wrapper)) usageError('--wrapper must be a file name');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  config.outDir = path.resolve(config.outDir || path.join(DEFAULT_OUT_ROOT, stamp));
  return config;
}

function promptFor(config, sessionNumber, jobNumber) {
  if (config.promptKind === 'commands') {
    return `Run these shell commands one by one and then reply with exactly ` +
      `ok-${sessionNumber}-${jobNumber}: \`ls\`, \`rg -c function luna-pool.mjs\`, \`sleep 5\``;
  }
  return `Reply with exactly: ok-${sessionNumber}-${jobNumber}`;
}

function makeJobs(config) {
  return Array.from({ length: config.sessions }, (_, sessionIndex) => {
    const sessionNumber = sessionIndex + 1;
    const sessionId = `luna-loadtest-${process.pid}-${sessionNumber}`;
    return {
      number: sessionNumber,
      id: sessionId,
      jobs: Array.from({ length: config.jobsPerSession }, (_, jobIndex) => {
        const jobNumber = jobIndex + 1;
        const out = path.join(config.outDir, `session-${sessionNumber}-job-${jobNumber}.md`);
        return {
          sessionNumber, sessionId, jobNumber, out,
          prompt: promptFor(config, sessionNumber, jobNumber),
          submitMs: null, runningMs: null, completionMs: null,
          state: 'not-started', rc: '', engine: '', child: null,
          sessionRunning: false
        };
      })
    };
  });
}

function readStatus(job) {
  try {
    const text = readFileSync(`${job.out}.status`, 'utf8');
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const split = line.indexOf('=');
      if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
    }
    return values;
  } catch {
    return {};
  }
}

function cpuSnapshot() {
  return os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }));
}

function cpuPercent(previous, current) {
  if (!previous?.length || previous.length !== current.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < current.length; i += 1) {
    idle += current[i].idle - previous[i].idle;
    total += current[i].total - previous[i].total;
  }
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
}

function eventLoopLag() {
  return new Promise((resolve) => {
    const start = performance.now();
    setTimeout(() => resolve(performance.now() - start), 0);
  });
}

function runCmdProbe() {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    let child;
    try {
      child = spawn(BASH, ['-c', 'exit'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('error', () => finish(null));
      child.once('close', () => finish(performance.now() - start));
    } catch {
      finish(null);
    }
    function finish(ms) {
      if (settled) return;
      settled = true;
      resolve(ms);
    }
  });
}

async function processSnapshot(startedAt) {
  try {
    const rows = timedProcessRows().filter((row) => row.created >= startedAt.getTime() &&
      /(?:^|\/)(?:codex|node_repl|bash|sh|node)(?:\s|$)/.test(row.command));
    const processes = rows.map((row) => {
      let workingSetBytes = 0;
      try {
        const match = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${row.pid}/status`, 'utf8'));
        workingSetBytes = Number(match?.[1] || 0) * 1024;
      } catch {}
      return { name: row.command.split(' ')[0], workingSetBytes };
    });
    return { count: processes.length,
      workingSetMb: processes.reduce((sum, row) => sum + row.workingSetBytes, 0) / MB, processes };
  } catch { return { count: null, workingSetMb: null, processes: [], error: 'process query failed' }; }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function fmt(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

function terminalStatus(job, now) {
  const status = readStatus(job);
  if (status.state === 'running') {
    job.sessionRunning = true;
    if (job.runningMs === null) job.runningMs = now;
  }
  if (TERMINAL.has(status.state) && job.completionMs === null) {
    job.state = status.state;
    job.rc = status.rc || '';
    job.engine = status.engine || '';
    job.completionMs = now;
    return true;
  }
  return false;
}

function updateSessions(sessions, now) {
  for (const session of sessions) {
    const running = session.jobs.filter((job) => job.state !== 'not-started' && job.state !== 'done' &&
      job.state !== 'failed' && job.state !== 'incomplete' && job.state !== 'stalled' && job.sessionRunning).length;
    session.maxConcurrent = Math.max(session.maxConcurrent || 0, running);
    const completed = session.jobs.filter((job) => job.completionMs !== null);
    if (completed.length && session.firstResultMs === null) {
      session.firstResultMs = Math.min(...completed.map((job) => job.completionMs));
    }
    if (session.jobs.every((job) => job.completionMs !== null ||
      (interrupted && job.state === 'not-started'))) {
      if (session.lastResultMs === null && completed.length) {
        session.lastResultMs = Math.max(...completed.map((job) => job.completionMs));
      }
    }
    session.elapsedMs = now;
  }
}

function jobArgs(config, job) {
  const cwd = config.promptKind === 'commands' ? SCRIPT_ROOT : SCRIPT_ROOT;
  return ['-r', '-e', 'low', '-C', cwd, '-o', job.out, job.prompt];
}

function launchJob(config, job, startTime, allJobs) {
  if (interrupted) return;
  job.submitMs = performance.now() - startTime;
  job.state = 'queued';
  const args = [path.join(SCRIPT_ROOT, config.wrapper), ...jobArgs(config, job)];
  job.child = spawn(BASH, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: job.sessionId }
  });
  job.child.once('error', (error) => {
    job.state = 'failed';
    job.rc = 'spawn-error';
    job.engine = '';
    job.error = error.message;
    job.completionMs = performance.now() - startTime;
  });
  job.child.once('close', (code) => {
    if (job.completionMs !== null) return;
    const status = readStatus(job);
    if (TERMINAL.has(status.state)) {
      job.state = status.state;
      job.rc = status.rc || String(code ?? '');
      job.engine = status.engine || '';
    } else {
      job.state = code === 0 ? 'incomplete' : (code === 124 ? 'stalled' : 'failed');
      job.rc = String(code ?? '');
      job.engine = status.engine || '';
    }
    job.completionMs = performance.now() - startTime;
  });
  allJobs.push(job);
}

let interrupted = false;
let interruptAt = null;

function reportText(config, sessions, samples, startedAt, partial) {
  const completed = sessions.flatMap((session) => session.jobs).filter((job) => job.completionMs !== null);
  const allJobs = sessions.flatMap((session) => session.jobs);
  const ram = samples.map((sample) => sample.freeRamMb);
  const cpus = samples.map((sample) => sample.cpuPercent).filter((value) => value !== null);
  const eventLags = samples.map((sample) => sample.eventLoopLagMs).filter((value) => value !== null);
  const cmdLags = samples.map((sample) => sample.cmdProbeMs).filter((value) => value !== null);
  const processCounts = samples.map((sample) => sample.processCount).filter((value) => value !== null);
  const processMemory = samples.map((sample) => sample.processWorkingSetMb).filter((value) => value !== null);
  const failed = allJobs.filter((job) => job.state !== 'done');
  const reasons = [];
  if (failed.length) reasons.push(`${failed.length} job(s) did not reach done`);
  if (ram.length && Math.min(...ram) < 800) reasons.push('free RAM fell below 800 MB');
  if (cmdLags.length && Math.max(...cmdLags) >= 3000) reasons.push('bash probe reached 3000 ms or more');
  if (samples.some((sample) => sample.cmdProbeFailed)) reasons.push('bash probe failed to start or exit');
  if (!cmdLags.length) reasons.push('bash probe has no result');
  const verdict = reasons.length ? `FAIL: ${reasons.join('; ')}` : 'PASS';
  const lines = [
    '# Luna load test report', '',
    `Generated: ${new Date().toISOString()}${partial ? ' (partial; interrupted)' : ''}`,
    `Started: ${startedAt.toISOString()}`,
    `Configuration: ${config.sessions} sessions × ${config.jobsPerSession} jobs; ` +
      `wrapper=${config.wrapper}; prompt=${config.promptKind}; sample=${config.sampleMs} ms; ` +
      `stagger=${config.staggerMs} ms; out-dir=${config.outDir}`,
    `Jobs: ${completed.length}/${allJobs.length} launched jobs completed; ` +
      `${allJobs.length} planned.`, '',
    '| Session | First result | Last result | Max running |',
    '|---|---:|---:|---:|',
    ...sessions.map((session) => `| ${session.id} | ${fmt(session.firstResultMs / 1000)} s | ` +
      `${fmt(session.lastResultMs / 1000)} s | ${session.maxConcurrent || 0} |`), '',
    '| Session/job | Submitted | Running | Completed | State | rc | Engine |',
    '|---|---:|---:|---:|---|---:|---|',
    ...allJobs.map((job) => `| ${job.sessionNumber}/${job.jobNumber} | ${fmt(job.submitMs / 1000)} s | ` +
      `${fmt(job.runningMs === null ? null : job.runningMs / 1000)} s | ` +
      `${fmt(job.completionMs === null ? null : job.completionMs / 1000)} s | ${job.state} | ` +
      `${job.rc || ''} | ${job.engine || ''} |`), '',
    '## Resource summary', '',
    `- Free RAM: min ${fmt(ram.length ? Math.min(...ram) : null)} MB; ` +
      `average ${fmt(ram.length ? ram.reduce((sum, value) => sum + value, 0) / ram.length : null)} MB.`,
    `- System CPU: max ${fmt(cpus.length ? Math.max(...cpus) : null)}%.`,
    `- Event loop lag: max ${fmt(eventLags.length ? Math.max(...eventLags) : null)} ms; ` +
      `p95 ${fmt(percentile(eventLags, 0.95))} ms.`,
    `- bash probe: max ${fmt(cmdLags.length ? Math.max(...cmdLags) : null)} ms; ` +
      `p95 ${fmt(percentile(cmdLags, 0.95))} ms.`,
    `- Tracked processes: max ${fmt(processCounts.length ? Math.max(...processCounts) : null, 0)}; ` +
      `working set max ${fmt(processMemory.length ? Math.max(...processMemory) : null)} MB.`,
    `- Committed memory: unavailable.`, '', `## Verdict: ${verdict}`, '',
    `Raw samples: [samples.jsonl](samples.jsonl)`
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const sessions = makeJobs(config);
  const plan = sessions.flatMap((session) => session.jobs.map((job) => ({
    session: session.id,
    job: job.jobNumber,
    delayMs: (job.jobNumber - 1) * config.staggerMs,
    cwd: config.promptKind === 'commands' ? SCRIPT_ROOT : SCRIPT_ROOT,
    command: [BASH, path.join(SCRIPT_ROOT, config.wrapper), ...jobArgs(config, job)]
  })));
  if (config.dryRun) {
    process.stdout.write(JSON.stringify({ config, plan }, null, 2) + '\n');
    return;
  }

  mkdirSync(config.outDir, { recursive: true });
  const samplesPath = path.join(config.outDir, 'samples.jsonl');
  writeFileSync(samplesPath, '');
  const startedAt = new Date();
  const startTime = performance.now();
  const allJobs = [];
  const samples = [];
  for (const session of sessions) {
    session.firstResultMs = null;
    session.lastResultMs = null;
    session.maxConcurrent = 0;
  }
  process.on('SIGINT', () => {
    if (!interrupted) {
      interrupted = true;
      interruptAt = performance.now();
      process.stderr.write('\nInterrupt received; stopping launches and waiting up to 20 seconds.\n');
    }
  });

  const launchers = sessions.map(async (session) => {
    for (const job of session.jobs) {
      if (interrupted) break;
      launchJob(config, job, startTime, allJobs);
      if (config.staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.staggerMs));
      }
    }
  });
  let previousCpu = cpuSnapshot();
  let nextProcessQuery = 0;
  let lastCmdProbe = -5000;
  let latestProcess = { count: null, workingSetMb: null };
  let pendingProcessQuery = null;
  let pendingCmdProbe = null;
  while (true) {
    const tickStart = performance.now();
    const now = performance.now() - startTime;
    for (const job of allJobs) terminalStatus(job, now);
    updateSessions(sessions, now);
    const lagPromise = eventLoopLag();
    const cmdPromise = now - lastCmdProbe >= 5000 ? runCmdProbe() : null;
    if (cmdPromise) {
      lastCmdProbe = now;
      pendingCmdProbe = cmdPromise;
    }
    if (now >= nextProcessQuery && !pendingProcessQuery) {
      pendingProcessQuery = processSnapshot(startedAt).then((result) => {
        latestProcess = result;
        pendingProcessQuery = null;
      });
      nextProcessQuery = now + 5000;
    }
    const lag = await lagPromise;
    let cmdMs = null;
    let cmdFailed = false;
    if (pendingCmdProbe) {
      const settled = await Promise.race([
        pendingCmdProbe.then((value) => ({ done: true, value })),
        new Promise((resolve) => setTimeout(() => resolve({ done: false }), 0))
      ]);
      if (settled.done) {
        cmdMs = settled.value;
        cmdFailed = cmdMs === null;
        pendingCmdProbe = null;
      }
    }
    const currentCpu = cpuSnapshot();
    const sample = {
      elapsedMs: Math.round(now),
      freeRamMb: availableMemory() / MB,
      cpuPercent: cpuPercent(previousCpu, currentCpu),
      eventLoopLagMs: lag,
      cmdProbeMs: cmdMs,
      cmdProbeFailed: cmdFailed,
      processCount: latestProcess.count,
      processWorkingSetMb: latestProcess.workingSetMb,
      processList: latestProcess.processes || []
    };
    previousCpu = currentCpu;
    samples.push(sample);
    appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
    const launchComplete = sessions.every((session) => session.jobs.every((job) =>
      job.submitMs !== null || interrupted));
    const done = launchComplete && allJobs.every((job) => job.completionMs !== null);
    if (interrupted && interruptAt !== null && performance.now() - interruptAt >= 20_000 && !done) {
      for (const job of allJobs) {
        if (job.completionMs === null && job.child) job.child.kill();
      }
    }
    if (done || (interrupted && interruptAt !== null && performance.now() - interruptAt >= 20_500)) break;
    const waitMs = Math.max(0, config.sampleMs - (performance.now() - tickStart));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  await Promise.allSettled(launchers);
  if (pendingCmdProbe) {
    const probe = await pendingCmdProbe;
    const lastSample = samples.at(-1);
    if (lastSample && lastSample.cmdProbeMs === null) {
      lastSample.cmdProbeMs = probe;
      lastSample.cmdProbeFailed = probe === null;
    }
    writeFileSync(samplesPath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  }
  const finalNow = performance.now() - startTime;
  for (const job of allJobs) {
    if (job.completionMs === null) {
      const status = readStatus(job);
      job.state = status.state || 'incomplete';
      job.rc = status.rc || '';
      job.engine = status.engine || '';
      job.completionMs = finalNow;
    }
  }
  updateSessions(sessions, finalNow);
  const report = reportText(config, sessions, samples, startedAt, interrupted);
  writeFileSync(path.join(config.outDir, 'report.md'), report, 'utf8');
  process.stdout.write(report);
  if (interrupted) process.exitCode = 130;
}

main().catch((error) => {
  process.stderr.write(`luna-loadtest: ${error.message}\n`);
  process.exitCode = 2;
});
