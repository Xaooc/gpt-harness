#!/usr/bin/env node
import path from 'node:path';
import {
  MB, exists, keyPath, assertPlainPath, inside, loadConfig, localDate, parseLock, worktrees,
  dirtyPaths, dependents, git, treeInfo, removeLinks, safeDelete, isMain
} from './lib.mjs';

export function removeWorktree(target, { archive = false, dryRun = false, config = loadConfig() } = {}) {
  target = path.resolve(target);
  assertPlainPath(target);
  const top = git(target, ['rev-parse', '--show-toplevel']).trim();
  if (keyPath(top) !== keyPath(target)) throw Error('path must be a worktree root');
  const entries = worktrees(target);
  const entry = entries.find((item) => keyPath(item.path) === keyPath(target));
  // Old worktrees predate registration; the dirty and dependents guards below still protect them.
  if (!entry || entry.main) throw Error('must be a linked worktree, not a main checkout');
  if (inside(target, config.sources) || inside(config.sources, target)) throw Error('sources path protected');
  const dirty = dirtyPaths(target, config.ignoreDirty);
  if (dirty.length && !archive) {
    const list = dirty.map((item) => `${item.status} ${item.paths.join(' -> ')}`).join('\n');
    throw Error(`dirty worktree; commit or use --archive:\n${list}`);
  }
  if (dirty.length && !entry.branch) throw Error('cannot archive a detached worktree');
  const deps = dependents(target, entries);
  if (deps.length) {
    throw Error(`worktree has dependents:\n${deps.map((item) => `${item.link} -> ${item.target}`).join('\n')}`);
  }
  const bytes = treeInfo(target).bytes;
  const tag = `archive/${entry.branch?.replaceAll('/', '-')}-${localDate().replaceAll('-', '')}`;
  if (dirty.length) {
    git(target, ['check-ref-format', `refs/tags/${tag}`]);
    const tags = git(target, ['tag', '--list', tag]).trim();
    if (tags) throw Error(`archive tag already exists: ${tag}; refusing to overwrite it`);
  }
  if (dryRun) return { path: target, bytes, dryRun: true, archiveTag: dirty.length ? tag : null };
  if (dirty.length) {
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'archive: uncommitted work before worktree removal']);
    git(target, ['tag', tag]);
  }
  // Clear every nested link as well, before Git's platform-dependent directory removal.
  removeLinks(target);
  const repo = entries[0].path;
  try { git(repo, ['worktree', 'unlock', '--', target]); }
  catch (error) { if (!/not locked/i.test(error.message)) throw error; }
  try { git(repo, ['worktree', 'remove', '--force', '--', target]); }
  catch (error) {
    // Never recursively delete after an unexplained Git refusal; retain registration for inspection.
    if (exists(target)) {
      try { git(repo, ['worktree', 'lock', '--reason', entry.locked, '--', target]); } catch {}
    }
    throw error;
  }
  if (exists(target)) {
    const failures = [];
    const result = safeDelete(target, { onSkip: (item, error) => failures.push(`${item}: ${error.message}`) });
    if (!result.removed) throw Error(`partial removal:\n${failures.join('\n')}`);
  }
  git(repo, ['worktree', 'prune']);
  return { path: target, bytes, dryRun: false, archiveTag: dirty.length ? tag : null };
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args[0].startsWith('--') || args.slice(1).some((arg) => !['--archive', '--dry-run'].includes(arg))) {
    throw Error('usage: wt-done.mjs <path> [--archive] [--dry-run]');
  }
  const result = removeWorktree(args[0], { archive: args.includes('--archive'), dryRun: args.includes('--dry-run') });
  if (result.archiveTag) {
    process.stdout.write(`${result.dryRun ? 'Would archive' : 'Archived'} as ${result.archiveTag}\n`);
  }
  process.stdout.write(`${result.dryRun ? 'Would remove' : 'Removed'} ${result.path}; ` +
    `${result.dryRun ? 'would free' : 'freed'} ${(result.bytes / MB).toFixed(1)} MB; branch retained\n`);
}

if (isMain(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`wt-done: ${error.message}\n`); process.exitCode = 1; }
}
