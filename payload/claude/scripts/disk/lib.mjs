import * as fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Set DISK_AUDIT_REPOS (semicolon-separated absolute paths) and DISK_SOURCES_ROOT in the environment
// or ~/.claude/luna-harness.env. An unset repository list audits no repositories.
export const DAY = 24 * 60 * 60 * 1000;
export const MB = 1024 * 1024;
export const DEFAULTS = {
  repos: [], liveRefs: {},
  sources: path.join(process.env.USERPROFILE || homedir(), 'dev', '_sources'),
  maxWorktreesPerRepo: 4, minFreeGB: 20, tmpMaxAgeDays: 7, cacheIdleHours: 24, worktreeIdleDays: 7,
  ignoreDirty: ['.claude/agents/gsd-executor.md', 'next-env.d.ts']
};

export function homePaths() {
  const home = path.resolve(process.env.DISK_AUDIT_HOME || process.env.CLAUDE_HOME ||
    path.join(process.env.USERPROFILE || homedir(), '.claude'));
  return { home, config: path.join(home, 'disk-audit.json'), state: path.join(home, 'disk-audit') };
}

function harnessSettings() {
  const values = {};
  try {
    const text = fs.readFileSync(path.join(homePaths().home, 'luna-harness.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^(DISK_AUDIT_REPOS|DISK_SOURCES_ROOT)=(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return values;
}

export function loadConfig(file = homePaths().config) {
  if (!exists(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = { ...DEFAULTS, ...saved, liveRefs: saved.liveRefs ?? {} };
  const settings = harnessSettings();
  const repos = process.env.DISK_AUDIT_REPOS ?? settings.DISK_AUDIT_REPOS;
  const sources = process.env.DISK_SOURCES_ROOT ?? settings.DISK_SOURCES_ROOT;
  if (repos !== undefined) config.repos = repos.split(';').map((repo) => repo.trim()).filter(Boolean);
  if (sources !== undefined) config.sources = sources.trim();
  if (!Array.isArray(config.repos) || config.repos.some((repo) => typeof repo !== 'string' || !path.isAbsolute(repo))) {
    throw Error('config repos must be an array of absolute paths');
  }
  if (typeof config.sources !== 'string' || !path.isAbsolute(config.sources)) throw Error('invalid sources path');
  for (const key of ['maxWorktreesPerRepo', 'minFreeGB', 'tmpMaxAgeDays', 'cacheIdleHours', 'worktreeIdleDays']) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw Error(`invalid config ${key}`);
  }
  if (!Array.isArray(config.ignoreDirty) || config.ignoreDirty.some((item) => typeof item !== 'string')) {
    throw Error('invalid ignoreDirty');
  }
  if (!config.liveRefs || typeof config.liveRefs !== 'object' || Array.isArray(config.liveRefs) ||
      Object.values(config.liveRefs).some((refs) => !Array.isArray(refs) ||
        refs.some((ref) => typeof ref !== 'string'))) {
    throw Error('invalid liveRefs');
  }
  return config;
}

export function program(exe, args, { rejectStderr = false, ...options } = {}) {
  const result = spawnSync(exe, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 32 * MB,
    ...options
  });
  if (result.error || result.status !== 0 || (rejectStderr && result.stderr?.trim())) {
    throw Error(`${exe}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export function git(repo, args) {
  return program('git', ['--no-optional-locks', '-C', repo, ...args]);
}

export function exists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function keyPath(target) {
  let absolute = path.resolve(target);
  if (absolute.startsWith('\\\\?\\UNC\\')) absolute = `\\\\${absolute.slice(8)}`;
  else if (absolute.startsWith('\\\\?\\')) absolute = absolute.slice(4);
  const normalized = absolute.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function inside(target, parent) {
  const child = keyPath(target);
  const root = keyPath(parent);
  return child === root || child.startsWith(`${root}/`);
}

// Check every ancestor, including dangling links; never walk through a junction.
export function assertPlainPath(target, allowLeafLink = false) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() && !(allowLeafLink && i === parts.length - 1)) {
      throw Error(`linked path protected: ${current}`);
    }
  }
  return absolute;
}

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`;
}

export function validDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function parseLock(reason) {
  if (!reason) return null;
  const fields = Object.create(null);
  for (const part of reason.split(';').filter((item) => item.trim())) {
    const match = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match || !match[2] || Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2];
  }
  return fields.owner && fields.purpose && validDate(fields.until) ? fields : null;
}

export function worktrees(repo) {
  const entries = [];
  let entry;
  // Line-based: `worktree list -z` needs git 2.36, this machine has 2.33.
  for (const field of git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice(9), main: entries.length === 0, branch: null, locked: null };
      entries.push(entry);
    } else if (entry) {
      if (field.startsWith('HEAD ')) entry.head = field.slice(5);
      if (field.startsWith('branch ')) entry.branch = field.slice(7).replace(/^refs\/heads\//, '');
      if (field === 'locked' || field.startsWith('locked ')) entry.locked = unquoteGit(field.slice(7));
      if (field === 'bare') entry.bare = true;
    }
  }
  return entries;
}

// Without -z git C-quotes values with non-ASCII bytes: "purpose=\320\237...".
function unquoteGit(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes = [];
  const body = value.slice(1, -1);
  const simple = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i], 'utf8')); continue; }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; continue; }
    const code = simple[body[i + 1]];
    bytes.push(code ?? 92);
    if (code !== undefined) i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

export function dirtyPaths(repo, ignored = []) {
  const fields = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const result = [];
  for (let i = 0; i < fields.length; i += 1) {
    if (!fields[i]) continue;
    const status = fields[i].slice(0, 2);
    const names = [fields[i].slice(3)];
    if (/[RC]/.test(status)) names.push(fields[++i]);
    if (!names.every((name) => ignored.includes(name))) result.push({ status, paths: names });
  }
  return result;
}

export function idleDays(repo, now = Date.now()) {
  const gitdir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const times = ['index', 'HEAD', 'logs/HEAD'].map((name) => {
    try { return fs.lstatSync(path.join(gitdir, name)).mtimeMs; }
    catch (error) { if (error.code === 'ENOENT') return -Infinity; throw error; }
  });
  const newest = Math.max(...times);
  if (!Number.isFinite(newest)) throw Error(`no activity metadata: ${repo}`);
  return Math.max(0, (now - newest) / DAY);
}

export function dependents(target, entries) {
  const found = [];
  for (const entry of entries) {
    if (keyPath(entry.path) === keyPath(target)) continue;
    if (!exists(entry.path)) throw Error(`cannot check dependents in missing worktree: ${entry.path}`);
    assertPlainPath(entry.path);
    for (const name of ['node_modules', 'data']) {
      const link = path.join(entry.path, name);
      if (!exists(link) || !fs.lstatSync(link).isSymbolicLink()) continue;
      let resolved;
      try { resolved = fs.realpathSync(link); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        resolved = path.resolve(path.dirname(link), fs.readlinkSync(link));
      }
      if (inside(resolved, fs.realpathSync(target))) found.push({ path: entry.path, link, target: resolved });
    }
  }
  return found;
}

export function treeInfo(target, newerThan = Infinity) {
  assertPlainPath(target, true);
  const stat = fs.lstatSync(target);
  let newest = stat.mtimeMs;
  let bytes = stat.isFile() ? stat.size : 0;
  let gitMetadata = path.basename(target) === '.git';
  if (!stat.isSymbolicLink() && stat.isDirectory() && newest <= newerThan) {
    for (const name of fs.readdirSync(target)) {
      const child = treeInfo(path.join(target, name), newerThan);
      newest = Math.max(newest, child.newest);
      bytes += child.bytes;
      gitMetadata ||= child.gitMetadata;
      if (newest > newerThan) break;
    }
  }
  return { newest, bytes, stat, gitMetadata };
}

function retryPath(target, operation, stat) {
  const attempts = [target];
  if (process.platform === 'win32') attempts.push(path.toNamespacedPath(target));
  let failure;
  for (const attempt of attempts) {
    try { operation(attempt); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      failure = error;
    }
    if (!stat.isSymbolicLink() && ['EACCES', 'EPERM'].includes(failure.code)) {
      try {
        assertPlainPath(target);
        fs.chmodSync(attempt, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
        operation(attempt);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        failure = error;
      }
    }
  }
  throw failure;
}

// Only unlink leaf links. Revalidate ancestors and identity before each mutation.
export function safeDelete(target, { onDelete = () => {}, onSkip = () => {} } = {}) {
  let bytes = 0;
  let entries = 0;
  function remove(item) {
    let stat;
    try {
      assertPlainPath(item, true);
      stat = fs.lstatSync(item);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const name of fs.readdirSync(item)) remove(path.join(item, name));
      }
      assertPlainPath(item, true);
      const current = fs.lstatSync(item);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink() !== stat.isSymbolicLink()) {
        throw Error('entry changed during deletion');
      }
      const directory = stat.isDirectory() && !stat.isSymbolicLink();
      if (!retryPath(item, directory ? fs.rmdirSync : fs.unlinkSync, stat)) return;
    } catch (error) {
      if (error.code !== 'ENOENT') onSkip(item, error);
      return;
    }
    const size = stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
    bytes += size;
    entries += 1;
    onDelete(item, size);
  }
  if (path.parse(path.resolve(target)).root === path.resolve(target)) throw Error('refusing drive root deletion');
  remove(path.resolve(target));
  return { bytes, entries, removed: !exists(target) };
}

export function removeLinks(root) {
  assertPlainPath(root);
  for (const name of fs.readdirSync(root)) {
    const target = path.join(root, name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const result = safeDelete(target, { onSkip: (item, error) => { throw Error(`${item}: ${error.message}`); } });
      if (!result.removed) throw Error(`cannot unlink ${target}`);
    } else if (stat.isDirectory() && name !== '.git') removeLinks(target);
  }
}

export function freeSpace(target) {
  let probe = path.resolve(target);
  while (!exists(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw Error(`drive unavailable: ${target}`);
    probe = parent;
  }
  const stat = fs.statfsSync(probe);
  return { drive: path.parse(probe).root, freeGB: stat.bavail * stat.bsize / (1024 ** 3) };
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertPlainPath(path.dirname(file));
  if (exists(file)) assertPlainPath(file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (exists(temp)) fs.unlinkSync(temp); }
}

export function isMain(url) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
}
