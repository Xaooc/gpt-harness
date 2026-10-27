#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import {
  DAY, MB, homePaths, loadConfig, git, program, exists, keyPath, inside, assertPlainPath,
  localDate, parseLock, worktrees, dirtyPaths, idleDays, dependents, treeInfo, safeDelete,
  freeSpace, atomicJson, isMain
} from './lib.mjs';

export function queryProcesses() {
  const commands = program('ps', ['-eo', 'args'], { timeout: 15_000, rejectStderr: true });
  if (!commands.trim()) throw Error('process query returned no command lines');
  return commands;
}

function activeProcess(commands, root) {
  const normalized = process.platform === 'win32' ? commands.replaceAll('\\', '/').toLowerCase() : commands;
  return normalized.includes(keyPath(root));
}

function tracked(root, target) {
  const relative = path.relative(root, target).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw Error('candidate outside checkout');
  return git(root, ['ls-files', '-z', '--', `:(literal)${relative}`]).length > 0;
}

function candidates(root, config, commands, now, warn) {
  const found = [];
  assertPlainPath(root);
  function consider(target, days, rule, keep = false) {
    if (!exists(target)) return;
    try {
      assertPlainPath(target, true);
      const stat = fs.lstatSync(target);
      // A root-level cache link is not a cache owned by this checkout.
      if (rule !== 'B' && (stat.isSymbolicLink() || !stat.isDirectory())) return;
      if (inside(target, config.sources) || inside(config.sources, target)) {
        warn(target, rule, 'sources path protected');
        return;
      }
      const cutoff = now - days * DAY;
      if (treeInfo(target, cutoff).newest >= cutoff || keep) return;
      if (tracked(root, target)) {
        warn(target, rule, 'tracked by git; kept');
        return;
      }
      const info = treeInfo(target);
      if (info.gitMetadata) {
        warn(target, rule, 'nested git repository protected');
        return;
      }
      found.push({ root, path: target, rule, cutoff, bytes: info.bytes });
    } catch (error) { warn(target, rule, error.message); }
  }
  if (commands !== null && !activeProcess(commands, root)) {
    consider(path.join(root, '.next'), config.cacheIdleHours / 24, 'A');
  }
  const temp = path.join(root, '.tmp');
  if (exists(temp)) {
    try {
      assertPlainPath(temp);
      const keepFile = path.join(temp, '.keep');
      let keep = [];
      if (exists(keepFile)) {
        assertPlainPath(keepFile);
        keep = fs.readFileSync(keepFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
      for (const name of fs.readdirSync(temp)) {
        if (name === '.keep') continue;
        const child = path.join(temp, name);
        const stat = fs.lstatSync(child);
        const marked = stat.isDirectory() && !stat.isSymbolicLink() && exists(path.join(child, 'KEEP'));
        consider(child, config.tmpMaxAgeDays, 'B', keep.includes(name) || marked);
      }
    } catch (error) { warn(temp, 'B', error.message); }
  }
  for (const name of ['test-results', 'playwright-report']) consider(path.join(root, name), 2, 'C');
  return found;
}

function inspectWorktree(repo, entry, entries, config, now) {
  assertPlainPath(entry.path);
  const lock = parseLock(entry.locked);
  const idle = idleDays(entry.path, now);
  const dirty = dirtyPaths(entry.path, config.ignoreDirty);
  const refs = config.liveRefs?.[repo] || [];
  let merged = false;
  for (const ref of refs) {
    try { git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); }
    catch { continue; }
    // Exit 1 means not an ancestor; all other failures are uncertainty, not a clean bill of health.
    const result = programAncestor(repo, entry.head, ref);
    if (result) merged = true;
  }
  const deps = dependents(entry.path, entries);
  const expired = Boolean(lock && lock.until < localDate(new Date(now)));
  let verdict = 'ok';
  if (deps.length) verdict = 'in-use';
  else if (dirty.length) verdict = 'dirty';
  else if (merged || expired || (!lock && idle >= config.worktreeIdleDays)) verdict = 'removable';
  else if (expired) verdict = 'expired';
  else if (!lock) verdict = 'unregistered';
  return {
    ...entry, branch: entry.branch || 'detached', commitDate: git(repo, ['show', '-s', '--format=%cI', entry.head]).trim(),
    lock, expired, dirty: dirty.length, dirtyPaths: dirty, merged, idleDays: idle, dependents: deps, verdict
  };
}

function programAncestor(repo, head, ref) {
  try { git(repo, ['merge-base', '--is-ancestor', head, ref]); return true; }
  catch (error) {
    if (/exit 1$/.test(error.message)) return false;
    throw error;
  }
}

export function runAudit(config, {
  sizes = false, apply = false, processQuery = queryProcesses, now = Date.now(), state = homePaths().state
} = {}) {
  const report = {
    ts: new Date(now).toISOString(), minFreeGB: config.minFreeGB, maxWorktreesPerRepo: config.maxWorktreesPerRepo,
    repos: [], drives: [], warnings: [], candidates: [], reclaimableBytes: 0, deletedBytes: 0, deletedEntries: 0,
    complete: true
  };
  let log;
  function record(target, rule, reason) {
    report.warnings.push(`${target}: ${reason}`);
    if (log !== undefined) {
      fs.writeSync(log, `${JSON.stringify({ ts: new Date().toISOString(), path: target, bytes: 0, rule,
        skipped: true, reason })}\n`);
    }
  }
  try {
    if (apply) {
      fs.mkdirSync(state, { recursive: true });
      assertPlainPath(state);
      const logPath = path.join(state, 'apply.log');
      if (exists(logPath)) assertPlainPath(logPath);
      log = fs.openSync(logPath, 'a');
      const stamp = path.join(state, 'last-apply');
      if (exists(stamp)) assertPlainPath(stamp);
      fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
    }
    let commands = null;
    try {
      commands = processQuery();
      if (typeof commands !== 'string') throw Error('invalid process query result');
    } catch (error) {
      commands = null;
      report.complete = false;
      report.warnings.push(`Rule A skipped: process query failed (${error.message})`);
    }
    const driveKeys = new Set();
    const rootKeys = new Set();
    function inspectDrive(target) {
      const drive = path.parse(path.resolve(target)).root;
      if (driveKeys.has(keyPath(drive))) return;
      const space = freeSpace(target);
      driveKeys.add(keyPath(space.drive));
      report.drives.push(space);
      if (space.freeGB < config.minFreeGB) report.warnings.push(`Low space on ${space.drive}: ${space.freeGB.toFixed(1)} GB`);
    }
    for (const repo of config.repos) {
      const result = { path: repo, worktrees: [], count: null };
      report.repos.push(result);
      try {
        if (!exists(repo)) { result.missing = true; continue; }
        inspectDrive(repo);
        assertPlainPath(repo);
        const entries = worktrees(repo);
        result.count = entries.length;
        if (entries.length > config.maxWorktreesPerRepo) {
          report.warnings.push(`${repo}: ${entries.length} worktrees exceeds limit ${config.maxWorktreesPerRepo}`);
        }
        for (const entry of entries) {
          try { inspectDrive(entry.path); }
          catch (error) { report.complete = false; record(entry.path, 'drive', error.message); }
          if (!entry.main) {
            try {
              const item = inspectWorktree(repo, entry, entries, config, now);
              if (sizes) item.sizeMB = treeInfo(entry.path).bytes / MB;
              item.command = item.verdict === 'removable' ?
                `node ~/.claude/scripts/disk/wt-done.mjs "${entry.path}"` : null;
              result.worktrees.push(item);
            } catch (error) {
              result.worktrees.push({ ...entry, verdict: 'unknown', error: error.message });
              report.complete = false;
              report.warnings.push(`${entry.path}: ${error.message}`);
            }
          }
          if (rootKeys.has(keyPath(entry.path)) || entry.bare) continue;
          rootKeys.add(keyPath(entry.path));
          try { report.candidates.push(...candidates(entry.path, config, commands, now, record)); }
          catch (error) { report.complete = false; record(entry.path, 'scan', error.message); }
        }
      } catch (error) {
        report.complete = false;
        result.error = error.message;
        report.warnings.push(`${repo}: ${error.message}`);
      }
    }
    report.reclaimableBytes = report.candidates.reduce((sum, item) => sum + item.bytes, 0);
    if (apply) {
      for (const item of report.candidates) {
        try {
          // Recheck age, tracking and KEEP markers immediately before deleting.
          assertPlainPath(item.path, true);
          const info = treeInfo(item.path, item.cutoff);
          if (info.newest >= item.cutoff || info.gitMetadata || tracked(item.root, item.path)) {
            record(item.path, item.rule, 'changed or tracked since scan; kept');
            continue;
          }
          if (item.rule === 'B') {
            const keepFile = path.join(item.root, '.tmp', '.keep');
            if (exists(keepFile)) assertPlainPath(keepFile);
            const keep = exists(keepFile) ? fs.readFileSync(keepFile, 'utf8').split(/\r?\n/).map((s) => s.trim()) : [];
            const marked = fs.lstatSync(item.path).isDirectory() && exists(path.join(item.path, 'KEEP'));
            if (marked || keep.includes(path.basename(item.path))) continue;
          }
          const deleted = safeDelete(item.path, {
            onDelete: (target, bytes) => {
              fs.writeSync(log, `${JSON.stringify({ ts: new Date().toISOString(), path: target, bytes, rule: item.rule })}\n`);
            },
            onSkip: (target, error) => record(target, item.rule, error.message)
          });
          report.deletedBytes += deleted.bytes;
          report.deletedEntries += deleted.entries;
        } catch (error) { record(item.path, item.rule, error.message); }
      }
    }
  } finally { if (log !== undefined) fs.closeSync(log); }
  return report;
}

function cell(value) {
  return String(value ?? '-').replace(/[\r\n\t]/g, ' ');
}

export function humanReport(report, quiet = false) {
  const lines = [];
  if (!quiet) {
    for (const repo of report.repos) {
      const state = repo.missing ? 'missing repository' : repo.error ? 'audit unavailable' : `${repo.count} worktrees`;
      lines.push(`${repo.path}: ${state}`);
      if (repo.missing || repo.error) continue;
      lines.push('VERDICT | PATH | BRANCH | HEAD DATE | OWNER / PURPOSE / UNTIL | EXPIRED | DIRTY | MERGED | IDLE d | DEPS | MB');
      for (const item of repo.worktrees) {
        const lock = item.lock ? `${item.lock.owner} / ${item.lock.purpose} / ${item.lock.until}` : 'unregistered';
        lines.push([item.verdict, item.path, item.branch || 'detached', item.commitDate?.slice(0, 10), lock,
          item.expired, item.dirty, item.merged, item.idleDays?.toFixed(1), item.dependents?.length,
          item.sizeMB?.toFixed(1)].map(cell).join(' | '));
        if (item.command) lines.push(`  ${item.command}`);
      }
    }
    for (const drive of report.drives) lines.push(`${drive.drive} free: ${drive.freeGB.toFixed(1)} GB`);
    const estimate = report.complete ? 'dry-run estimate' : 'incomplete dry-run estimate';
    lines.push(`Reclaimable by --apply: ${(report.reclaimableBytes / MB).toFixed(1)} MB (${estimate})`);
  }
  for (const warning of report.warnings) lines.push(`WARNING: ${cell(warning)}`);
  if (report.deletedEntries) lines.push(`Deleted ${report.deletedEntries} entries, ${(report.deletedBytes / MB).toFixed(1)} MB`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(['--json', '--sizes', '--apply', '--quiet', '--write-cache']);
  let configFile;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config' && args[i + 1] && !args[i + 1].startsWith('--')) configFile = args[++i];
    else if (!flags.has(args[i])) throw Error(`unknown or incomplete argument: ${args[i]}`);
  }
  const report = runAudit(loadConfig(configFile), { sizes: args.includes('--sizes'), apply: args.includes('--apply') });
  if (args.includes('--write-cache')) atomicJson(path.join(homePaths().state, 'last.json'), report);
  if (args.includes('--quiet') && !report.warnings.length && !report.deletedEntries) return;
  const output = args.includes('--json') ? JSON.stringify(report, null, 2) : humanReport(report, args.includes('--quiet'));
  if (output) process.stdout.write(`${output}\n`);
}

if (isMain(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`disk-audit: ${error.message}\n`); process.exitCode = 1; }
}
