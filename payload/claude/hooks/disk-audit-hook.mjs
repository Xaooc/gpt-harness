#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let homePaths, loadConfig, exists, assertPlainPath;

function ageText(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function printCached(state) {
  const cache = path.join(state, 'last.json');
  if (!exists(cache)) return;
  const report = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const items = [];
  for (const drive of report.drives || []) {
    if (drive.freeGB < report.minFreeGB) items.push(`- ${drive.drive}: ${drive.freeGB.toFixed(1)} GB free`);
  }
  for (const repo of report.repos || []) {
    if (repo.missing || !exists(repo.path)) continue;
    const parts = [];
    const removable = repo.worktrees.filter((item) => item.verdict === 'removable');
    const expired = repo.worktrees.filter((item) => item.expired && item.verdict !== 'removable');
    const unregistered = repo.worktrees.filter((item) => !item.lock &&
      !['removable', 'unknown'].includes(item.verdict));
    if (removable.length) {
      const names = removable.slice(0, 3).map((item) => path.basename(item.path)).join(', ');
      parts.push(`${removable.length} removable worktrees (${names}${removable.length > 3 ? ', ...' : ''})`);
    }
    if (expired.length) parts.push(`${expired.length} expired`);
    if (unregistered.length) parts.push(`${unregistered.length} unregistered`);
    if (repo.count > report.maxWorktreesPerRepo) {
      parts.push(`${repo.count} worktrees (limit ${report.maxWorktreesPerRepo})`);
    }
    if (parts.length) items.push(`- ${path.basename(repo.path)}: ${parts.join(', ')}`);
  }
  if (!items.length) return;
  const lines = items.length > 6 ? [...items.slice(0, 5), `- ${items.length - 5} more items; see details`] : items;
  const age = ageText(Date.now() - Date.parse(report.ts));
  process.stdout.write([`Disk audit (${age} ago):`, ...lines,
    'Details: node ~/.claude/scripts/disk/audit.mjs'].map((line) => line.replace(/[\r\n]/g, ' ')).join('\n') + '\n');
}

try {
  ({ homePaths, loadConfig, exists, assertPlainPath } = await import('../scripts/disk/lib.mjs'));
  const { state } = homePaths();
  for (const repo of loadConfig().repos) {
    if (!exists(repo)) process.stdout.write(`disk-audit: ${repo.replace(/[\r\n]/g, ' ')}: missing repository\n`);
  }
  try { printCached(state); } catch {}
  const args = [fileURLToPath(new URL('../scripts/disk/audit.mjs', import.meta.url)), '--write-cache', '--quiet'];
  const stamp = path.join(state, 'last-apply');
  let last = -Infinity;
  if (exists(stamp)) {
    const text = fs.readFileSync(stamp, 'utf8').trim();
    last = Date.parse(text);
    if (!Number.isFinite(last)) last = fs.lstatSync(stamp).mtimeMs;
  }
  if (Date.now() - last > 86_400_000) {
    fs.mkdirSync(state, { recursive: true });
    assertPlainPath(state);
    if (exists(stamp)) assertPlainPath(stamp);
    fs.writeFileSync(stamp, `${new Date().toISOString()}\n`);
    args.push('--apply');
  }
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
} catch {
  // Session startup must succeed even if the report or launcher is unavailable.
}
process.exit(0);
