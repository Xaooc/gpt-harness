#!/usr/bin/env node
// Start a daily read-only hygiene scan and show recent actionable reports at most twice.
// HYGIENE_RUN_CMD is a complete shell command override, used by disposable test runners.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositorySurface } from '../scripts/conveyor/lib/profile.mjs';
import { home, shell } from '../scripts/conveyor/lib/platform.mjs';

const day = 24 * 60 * 60 * 1000;
const runner = fileURLToPath(new URL('../scripts/conveyor/harness-hygiene.mjs', import.meta.url));
const execute = promisify(execFile);
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};

async function sessionCwd() {
  const fallback = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (process.stdin.isTTY) return fallback;
  // SessionStart supplies JSON on stdin; bound the read so an absent/unfinished payload cannot stall startup.
  return new Promise((resolve) => {
    let input = '';
    const finish = () => {
      clearTimeout(timer);
      process.stdin.off('data', data).off('end', finish).off('error', finish);
      process.stdin.pause();
      process.stdin.unref?.();
      try { resolve(JSON.parse(input).cwd || fallback); }
      catch { resolve(fallback); }
    };
    const data = (chunk) => { input += chunk; if (input.length > 65536) finish(); };
    const timer = setTimeout(finish, 100);
    process.stdin.on('data', data).once('end', finish).once('error', finish);
    process.stdin.resume();
    if (process.stdin.readableEnded) finish();
  });
}

function scratchWorkspace(cwd) {
  const scratch = path.join(home(), '.config', 'Claude', 'scratch-workspaces');
  let canonical = path.resolve(cwd);
  try { canonical = fs.realpathSync(cwd); } catch { /* A missing directory has no guidance. */ }
  return canonical === scratch || canonical.startsWith(`${scratch}${path.sep}`);
}

async function repositoryDirectives(cwd) {
  try {
    const { stdout } = await execute('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { timeout: 500, killSignal: 'SIGKILL', maxBuffer: 65536 });
    const repo = stdout.trim();
    if (!repo || scratchWorkspace(repo)) return '';
    const surface = await repositorySurface(repo), messages = [];
    if (!surface.code) return '';
    if (!fs.existsSync(path.join(repo, '.claude', 'conveyor.json'))) {
      messages.push('This repository has no conveyor profile. On your first task here that changes code, run '
        + `node ~/.claude/scripts/conveyor/check.mjs init --dir '${repo.replaceAll("'", "'\\''")}' --write, `
        + 'review the generated checks (adjust commands that do not fit this repo, measure fast/turn on the change), '
        + 'tell the user, and propose committing .claude/conveyor.json and .conveyor/hygiene-baseline.json.');
    }
    const skills = path.join(repo, '.claude', 'skills');
    const verified = fs.existsSync(skills) && fs.readdirSync(skills).some((name) => name.startsWith('verify-')
      && fs.existsSync(path.join(skills, name, 'SKILL.md')));
    if (surface.ui && !verified) {
      messages.push('UI repository without a verify skill: the first task that changes the UI also creates '
        + '.claude/skills/verify-<app>/ with the pstack create-verification-skill method '
        + '(isolated launch on a free port with its own data, Playwright drive, desktop+mobile screenshots kept after cleanup '
        + "— see kriminalist's verify-kriminalist for a worked example), and proves the change with it.");
    }
    return messages.join('\n');
  } catch { return ''; } // Optional guidance must never prevent hygiene output or session startup.
}

function outputContext(message) {
  if (message) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message }
  }));
}

async function main() {
  const cwd = await sessionCwd();
  if (scratchWorkspace(cwd)) return;
  const directives = await repositoryDirectives(cwd);
  const claude = process.env.CLAUDE_HOME_DIR || path.join(home(), '.claude');
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
  catch { outputContext(directives); return; }
  try {
    const saved = readJson(stateFile);
    const state = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const report = readJson(path.join(directory, 'latest.json'));
    let changed = false;
    const elapsed = now - Date.parse(state.lastRunAt);
    if (!Number.isFinite(elapsed) || elapsed > day) {
      const { spawn } = await import('node:child_process');
      const command = process.env.HYGIENE_RUN_CMD;
      const [executable, ...args] = command ? [...shell(), command] : [process.execPath, runner, 'run'];
      const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      if (child.pid) {
        state.lastRunAt = new Date(now).toISOString();
        changed = true;
      }
    }
    const age = now - Date.parse(report?.at);
    const counts = report?.counts;
    let message = directives;
    if (age >= 0 && age < 2 * day && counts
      && ['high', 'medium', 'low'].every((key) => Number.isInteger(counts[key]) && counts[key] >= 0)
      && counts.high + counts.medium > 0) {
      const shown = state.report?.at === report.at && Number.isInteger(state.report.shown) ? state.report.shown : 0;
      if (shown >= 0 && shown < 2) {
        const total = counts.high + counts.medium + counts.low;
        const reportPath = path.resolve(directory) === path.join(home(), '.claude', 'conveyor', 'hygiene')
          ? '~/.claude/conveyor/hygiene/latest.json' : path.join(directory, 'latest.json');
        const reportMessage = `Гигиена харнесса: ${total} расхождений (${counts.high} важных). Отчёт: ${reportPath}`
          + ' — предложи пользователю разобрать, ничего не меняй сам.';
        message = [message, reportMessage].filter(Boolean).join('\n');
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
    outputContext(message);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

try { await main(); }
catch { /* SessionStart is fail-silent and never waits for the scan. */ }
