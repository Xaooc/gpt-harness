#!/usr/bin/env node
// Start a daily read-only hygiene scan and show recent actionable reports at most twice.
// HYGIENE_RUN_CMD is a complete shell command override, used by disposable test runners.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const day = 24 * 60 * 60 * 1000;
const runner = fileURLToPath(new URL('../scripts/conveyor/harness-hygiene.mjs', import.meta.url));
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};

async function main() {
  const claude = process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.claude');
  const conveyor = process.env.CONVEYOR_HOME || path.join(claude, 'conveyor');
  const directory = path.join(conveyor, 'hygiene'), now = Date.now();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'state.json'), lock = `${stateFile}.lock`;
  // Never wait for another session; recover an abandoned lock after a minute.
  try {
    if (now - fs.statSync(lock).mtimeMs > 60_000) fs.unlinkSync(lock);
  } catch { /* No existing lock. */ }
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch { return; }
  try {
    const saved = readJson(stateFile);
    const state = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const report = readJson(path.join(directory, 'latest.json'));
    let changed = false;
    const elapsed = now - Date.parse(state.lastRunAt);
    if (!Number.isFinite(elapsed) || elapsed > day) {
      const { spawn } = await import('node:child_process');
      const command = process.env.HYGIENE_RUN_CMD;
      const child = command ? spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' })
        : spawn(process.execPath, [runner, 'run'], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      if (child.pid) {
        state.lastRunAt = new Date(now).toISOString();
        changed = true;
      }
    }
    const age = now - Date.parse(report?.at);
    const counts = report?.counts;
    let message = '';
    if (age >= 0 && age < 2 * day && counts
      && ['high', 'medium', 'low'].every((key) => Number.isInteger(counts[key]) && counts[key] >= 0)
      && counts.high + counts.medium > 0) {
      const shown = state.report?.at === report.at && Number.isInteger(state.report.shown) ? state.report.shown : 0;
      if (shown >= 0 && shown < 2) {
        const total = counts.high + counts.medium + counts.low;
        const reportPath = path.resolve(directory) === path.join(homedir(), '.claude', 'conveyor', 'hygiene')
          ? '~/.claude/conveyor/hygiene/latest.json' : path.join(directory, 'latest.json');
        message = `Гигиена харнесса: ${total} расхождений (${counts.high} важных). Отчёт: ${reportPath}`
          + ' — предложи пользователю разобрать, ничего не меняй сам.';
        state.report = { at: report.at, shown: shown + 1 };
        changed = true;
      }
    }
    if (changed) {
      const temporary = `${stateFile}.${process.pid}.${now}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, stateFile);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    if (message) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message }
      }));
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

try { await main(); }
catch { /* SessionStart is fail-silent and never waits for the scan or stdin. */ }
