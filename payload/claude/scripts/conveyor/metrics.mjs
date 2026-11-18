#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const day = 86400_000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
      try { const row = JSON.parse(line); return object(row) ? [row] : []; }
      catch { return []; }
    });
  } catch { return null; }
};
const files = (directory, suffix) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => path.join(directory, entry.name));
  } catch { return null; }
};
const ranked = (values, key) => [...values.values()].sort((a, b) => b.count - a.count || a[key].localeCompare(b[key]));

// home is the Claude configuration directory. Honour the same directory overrides as the producers.
// Only counts and repository/provider identifiers leave this collector; message text is never returned.
export function collectMetrics({ start, end, home = process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.claude') }) {
  start = timestamp(start);
  end = timestamp(end);
  const within = (value) => timestamp(value) >= start && timestamp(value) <= end;
  const learning = process.env.CLAUDE_LEARNING_DIR || path.join(home, 'learning');
  const conveyor = process.env.CONVEYOR_HOME || path.join(home, 'conveyor');
  const result = {
    corrections: null, previousCorrections: null, interrupts: null, projects: null, afterDone: null,
    tasks: null, correctionsPerTask: null, executor: null, stopGate: null, waivers: null,
    switches: null, checks: null, hygiene: null
  };
  const events = readJsonl(path.join(learning, 'events.jsonl'));
  const corrections = events?.filter((row) => row.type === 'user_correction' && within(row.ts));
  if (events !== null) {
    result.corrections = corrections.length;
    result.previousCorrections = events.filter((row) => row.type === 'user_correction'
      && timestamp(row.ts) >= start - (end - start) && timestamp(row.ts) < start).length;
    result.interrupts = events.filter((row) => row.type === 'user_interrupt' && within(row.ts)).length;
    const projects = new Map();
    for (const row of events) {
      if (!within(row.ts) || !['user_correction', 'user_interrupt'].includes(row.type)) continue;
      if (typeof row.project !== 'string' || !row.project) continue;
      const entry = projects.get(row.project) || { project: row.project, corrections: 0, interrupts: 0, count: 0 };
      entry[row.type === 'user_correction' ? 'corrections' : 'interrupts']++;
      entry.count++;
      projects.set(row.project, entry);
    }
    result.projects = ranked(projects, 'project').slice(0, 5).map(({ count, ...entry }) => entry);
  }

  const ledgers = files(path.join(conveyor, 'ledgers'), '.jsonl');
  if (ledgers !== null) {
    const tasks = new Set(), completions = new Map();
    result.waivers = 0;
    for (const file of ledgers) {
      const session = path.basename(file, '.jsonl');
      for (const row of readJsonl(file) || []) {
        if (within(row.at)) {
          tasks.add(session);
          if (row.type === 'waive') result.waivers++;
        }
        const at = timestamp(row.at);
        if (['done', 'checklist', 'crosscheck'].includes(row.type) && at <= end
          && (!completions.has(session) || at < completions.get(session))) completions.set(session, at);
      }
    }
    result.tasks = tasks.size;
    if (events !== null) {
      result.afterDone = corrections.filter((row) => timestamp(row.ts) > completions.get(row.session)).length;
      result.correctionsPerTask = tasks.size
        ? corrections.filter((row) => tasks.has(row.session)).length / tasks.size : null;
    }
  }

  const sessions = files(path.join(conveyor, 'sessions'), '.jsonl');
  if (sessions !== null) {
    const gate = { writeRuns: 0, round0: 0, afterFix: 0, fixRounds: { 1: 0, 2: 0 }, red: 0,
      handoffs: 0, noProvider: 0, writeLocked: 0, unknown: 0 };
    for (const file of sessions) {
      const runs = [], pending = new Map();
      for (const row of readJsonl(file) || []) {
        if (row.event === 'end') {
          const queue = pending.get(row.out);
          const run = queue?.shift();
          if (run) run.end = row;
          else runs.push({ row, end: row });
        } else {
          const run = { row, end: null };
          runs.push(run);
          if (typeof row.out === 'string') {
            if (!pending.has(row.out)) pending.set(row.out, []);
            pending.get(row.out).push(run);
          }
        }
      }
      for (const { row, end: completion } of runs) {
        if (!within(row.at)) continue;
        const dispatch = completion ?? (typeof row.out === 'string' ? readJson(`${row.out}.dispatch.json`) : null);
        // The current index contains write runs with gate modes block/warn/off; older fixtures may say write/read.
        if (dispatch?.mode === 'read' || row.mode === 'read') continue;
        if (dispatch?.mode !== 'write' && !['write', 'block', 'warn', 'off'].includes(row.mode)) continue;
        gate.writeRuns++;
        if (!object(dispatch)) { gate.unknown++; continue; }
        const outcome = { 4: 'handoffs', 5: 'noProvider', 6: 'red', 7: 'writeLocked' }[dispatch.code];
        if (outcome) gate[outcome]++;
        const rounds = dispatch.gate?.rounds;
        if (rounds === 1 || rounds === 2) gate.fixRounds[rounds]++;
        if ((dispatch.code === 0 || (!completion && dispatch.code === null)) && dispatch.gate?.status === 'pass') {
          if (rounds === 0) gate.round0++;
          else if (rounds === 1 || rounds === 2) gate.afterFix++;
        }
      }
    }
    result.executor = gate;
  }

  const states = files(path.join(conveyor, 'gate-state'), '.json');
  if (states !== null) {
    result.stopGate = { sessions: 0, reasons: {} };
    for (const file of states) {
      const state = readJson(file);
      // Stop state has no timestamp or history: mtime dates its bounded, most recent reasons.
      let at;
      try { at = state?.at ?? fs.statSync(file).mtimeMs; }
      catch { continue; }
      if (!within(at) || !Array.isArray(state?.reasons)) continue;
      const reasons = new Set(state.reasons.map((reason) => /^([1-8])\./.exec(String(reason))?.[1]).filter(Boolean));
      if (reasons.size) result.stopGate.sessions++;
      for (const reason of reasons) result.stopGate.reasons[reason] = (result.stopGate.reasons[reason] || 0) + 1;
    }
  }

  const switches = readJsonl(path.join(conveyor, 'switches.jsonl'));
  if (switches !== null) {
    const counts = new Map();
    for (const row of switches) {
      if (within(row.at) && typeof row.from === 'string' && typeof row.to === 'string') {
        const key = `${row.from}→${row.to}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    result.switches = Object.fromEntries(counts);
  }
  const checks = readJsonl(path.join(learning, 'checks.jsonl'));
  if (checks !== null) {
    const built = checks.filter((row) => row.status === 'built' && within(row.at));
    const repos = new Map();
    for (const row of built) {
      if (typeof row.repo !== 'string' || !row.repo) continue;
      const entry = repos.get(row.repo) || { repo: row.repo, count: 0 };
      entry.count++;
      repos.set(row.repo, entry);
    }
    result.checks = { built: built.length, repos: ranked(repos, 'repo') };
  }
  const reports = (files(path.join(conveyor, 'hygiene'), '.json') || []).map(readJson)
    .filter((report) => timestamp(report?.at) <= end
      && ['high', 'medium', 'low'].every((key) => Number.isInteger(report?.counts?.[key]) && report.counts[key] >= 0))
    .sort((a, b) => timestamp(b.at) - timestamp(a.at));
  if (reports.length) result.hygiene = Object.fromEntries(['high', 'medium', 'low'].map((key) => [key, reports[0].counts[key]]));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let days = 7, json = false;
    while (args.length) {
      const arg = args.shift();
      if (arg === '--json') json = true;
      else if (arg === '--days' && args.length) days = Number(args.shift());
      else throw new Error('Usage: metrics.mjs [--days 7] [--json]');
    }
    if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be positive');
    const end = Date.now(), metrics = collectMetrics({ start: end - days * day, end });
    process.stdout.write(json ? `${JSON.stringify(metrics, null, 2)}\n`
      : Object.entries(metrics).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n');
  } catch (error) {
    process.stderr.write(`metrics: ${error.message}\n`);
    process.exitCode = 1;
  }
}
