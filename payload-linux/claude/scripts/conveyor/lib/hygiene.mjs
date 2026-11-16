import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchesGlob } from './profile.mjs';
import { writeJsonAtomic } from './orchestration.mjs';

const execute = promisify(execFile);

export async function git(repo, args) {
  const { stdout } = await execute('git', args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  return stdout;
}

export async function existingFiles(repo, files) {
  const result = [], root = await fs.realpath(repo);
  for (const name of [...new Set(files)].sort()) {
    if (!name || name.includes('\0') || path.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`file must be relative to the repository: ${name}`);
    }
    const file = path.normalize(name);
    if (file === '.') throw new Error('a file path is required');
    try {
      if (!(await fs.lstat(path.join(repo, file))).isFile()) continue;
      // Do not follow a parent symlink into an unrelated directory.
      const resolved = await fs.realpath(path.join(repo, file));
      const relative = path.relative(root, resolved);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`file resolves outside the repository: ${name}`);
      }
      result.push(file);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return [...new Set(result)].sort();
}

export async function repositoryFiles(repo) {
  const files = await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return existingFiles(repo, files.split('\0').filter(Boolean));
}

export async function readText(repo, file) {
  const value = await fs.readFile(path.join(repo, file));
  return value.includes(0) ? null : value.toString('utf8');
}

function applies(counter, file) {
  return matchesGlob(file, counter.glob) && (!counter.exclude || !matchesGlob(file, counter.exclude));
}

function count(counter, content) {
  if (content === null || content === '') return 0;
  if (counter.maxLines !== undefined) return content.split('\n').length - Number(content.endsWith('\n'));
  let total = 0;
  for (const match of content.matchAll(new RegExp(counter.pattern, 'g'))) total++;
  return total;
}

export async function ratchet(repo, files, counters, base) {
  const grew = [];
  if (!files.length || !counters.length) return { ok: true, grew };
  const tracked = new Set((await git(repo, ['ls-tree', '-r', '--name-only', '-z', base])).split('\0'));
  for (const file of files) {
    const matching = counters.filter((counter) => applies(counter, file));
    if (!matching.length) continue;
    const afterText = await readText(repo, file);
    let beforeText = '';
    if (tracked.has(file)) {
      beforeText = await git(repo, ['show', `${base}:${file}`]);
      if (beforeText.includes('\0')) beforeText = null;
    }
    for (const counter of matching) {
      const before = count(counter, beforeText), after = count(counter, afterText);
      if (after > before && (counter.maxLines === undefined || after > counter.maxLines)) {
        grew.push({ file, counter: counter.name, before, after });
      }
    }
  }
  return { ok: !grew.length, grew };
}

async function baselineFile(repo, file) {
  let current = repo;
  for (const part of path.normalize(file).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`baseline path contains a symlink: ${file}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

export async function hygieneReport(repo, profile, writeBaseline = false) {
  const { counters, baseline: baselineName } = profile.hygiene;
  const file = await baselineFile(repo, baselineName);
  const totals = Object.fromEntries(counters.map((counter) => [counter.name, 0]));
  for (const name of await repositoryFiles(repo)) {
    if (name === path.normalize(baselineName)) continue;
    const matching = counters.filter((counter) => applies(counter, name));
    if (!matching.length) continue;
    const content = await readText(repo, name);
    for (const counter of matching) {
      const value = count(counter, content);
      totals[counter.name] += counter.maxLines === undefined ? value : Number(value > counter.maxLines);
    }
  }
  let baseline = null;
  if (writeBaseline) {
    await writeJsonAtomic(file, { version: 1, totals });
    baseline = totals;
  } else {
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      if (stored?.version !== 1 || !stored.totals || Array.isArray(stored.totals) ||
          typeof stored.totals !== 'object' || Object.values(stored.totals).some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`invalid hygiene baseline: ${baselineName}`);
      }
      baseline = stored.totals;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const delta = baseline === null ? null : Object.fromEntries(Object.entries(totals).map(([name, total]) => [
    name, Object.hasOwn(baseline, name) ? total - baseline[name] : null
  ]));
  return { ok: true, repo, baselineFile: baselineName, totals, baseline, delta };
}
