import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
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

async function baseFiles(repo, base) {
  return new Set((await git(repo, ['ls-tree', '-r', '--name-only', '-z', base])).split('\0'));
}

async function baseText(repo, base, file) {
  const value = await git(repo, ['show', `${base}:${file}`]);
  return value.includes('\0') ? null : value;
}

export function testFile(file) {
  return /(^|\/)(tests?|__tests__)\//.test(file) || /(^|\/)(test[._-]|.*(?:_test|\.test|\.spec)\.)/.test(file);
}

function testPattern(file) {
  const name = path.basename(file), extension = path.extname(name);
  if (extension === '.py' && name !== 'conftest.py' &&
      (name.startsWith('test_') || name.endsWith('_test.py') || /(^|\/)tests?\//.test(file))) {
    return /^[ \t]*(async[ \t]+)?def[ \t]+test\w*[ \t]*\(/gm;
  }
  if (/^\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(extension) &&
      (/\.(test|spec)\./.test(name) || /(^|\/)__tests__\//.test(file))) {
    return /^[ \t]*(it|test)(\.(each|only|skip|concurrent|todo)[^(]*)?[ \t]*\(/gm;
  }
  if (name.endsWith('_test.go')) return /^func[ \t]+Test\w*[ \t]*\(/gm;
  if (extension === '.rs') return /#\[(tokio::)?test\]/gm;
  return null;
}

/** The declaration line of every test case in a test file (trimmed), in order; [] for other files. */
export function testLines(file, text) {
  const pattern = testFile(file) && testPattern(file);
  if (!pattern || !text) return [];
  const lines = text.split('\n');
  return [...text.matchAll(pattern)].map((match) => lines[text.slice(0, match.index).split('\n').length - 1].trim());
}

/** Test declaration lines of a file at a git revision ([] when the file is absent there). */
export async function baseTestLines(repo, base, file) {
  try { return testLines(file, await baseText(repo, base, file)); }
  catch { return []; }
}

export async function testChanges(repo, names, existing, base, budget) {
  const files = [];
  let added = 0;
  const current = new Set(existing);
  let tracked;
  for (const file of [...new Set(names.map((name) => path.normalize(name)))].sort()) {
    const pattern = testFile(file) && testPattern(file);
    if (!pattern) continue;
    tracked ??= await baseFiles(repo, base);
    const before = tracked.has(file) ? (await baseText(repo, base, file))?.match(pattern)?.length ?? 0 : 0;
    const after = current.has(file) ? (await readText(repo, file))?.match(pattern)?.length ?? 0 : 0;
    if (before !== after) files.push({ file, before, after });
    added += after - before;
  }
  return { budget, added, ok: added <= budget, files };
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
  const tracked = await baseFiles(repo, base);
  for (const file of files) {
    const matching = counters.filter((counter) => applies(counter, file));
    if (!matching.length) continue;
    const afterText = await readText(repo, file);
    const beforeText = tracked.has(file) ? await baseText(repo, base, file) : '';
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

async function totalsFor(repo, counters, baselineName, base = null) {
  const totals = Object.fromEntries(counters.map((counter) => [counter.name, 0]));
  const files = base === null ? await repositoryFiles(repo)
    : (await git(repo, ['ls-tree', '-r', '--name-only', '-z', base])).split('\0').filter(Boolean);
  for (const name of files) {
    if (name === path.normalize(baselineName)) continue;
    const matching = counters.filter((counter) => applies(counter, name));
    if (!matching.length) continue;
    const content = base === null ? await readText(repo, name) : await git(repo, ['show', `${base}:${name}`]);
    for (const counter of matching) {
      const value = count(counter, content?.includes('\0') ? null : content);
      totals[counter.name] += counter.maxLines === undefined ? value : Number(value > counter.maxLines);
    }
  }
  return totals;
}

export async function writeProfileBaseline(repo, name, baseline) {
  await writeJsonAtomic(await baselineFile(repo, name), { version: 1, totals: baseline });
}

async function readBaseline(file) {
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    if (stored?.version !== 1 || !stored.totals || Array.isArray(stored.totals) ||
        typeof stored.totals !== 'object' || Object.values(stored.totals).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`invalid hygiene baseline: ${file}`);
    }
    return stored.totals;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function defaultBaseline(repo, profile, base = 'HEAD') {
  const { counters, baseline: file } = profile.hygiene;
  let baseline = await readBaseline(file);
  if (baseline === null) {
    let revision;
    try { revision = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim(); }
    catch (error) {
      // A newly initialized repository has no committed debt yet.
      if (base !== 'HEAD' || (await git(repo, ['log', '--all', '-1', '--format=%H'])).trim()) throw error;
    }
    baseline = revision ? await totalsFor(repo, counters, file, revision)
      : Object.fromEntries(counters.map((counter) => [counter.name, 0]));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, totals: baseline }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      // Publish complete JSON without replacing a baseline initialized by another worktree.
      try { await fs.link(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await fs.rm(temporary, { force: true }); }
    baseline = await readBaseline(file);
  }
  return { source: 'default', baselineFile: file, baseline };
}

export async function hygieneReport(repo, profile, writeBaseline = false) {
  const { counters, baseline: baselineName } = profile.hygiene;
  const isDefault = profile.hygieneSource === 'default';
  const file = isDefault ? baselineName : await baselineFile(repo, baselineName);
  const baseline = isDefault ? (await defaultBaseline(repo, profile)).baseline : writeBaseline ? null : await readBaseline(file);
  const totals = await totalsFor(repo, counters, baselineName);
  if (writeBaseline && !isDefault) await writeJsonAtomic(file, { version: 1, totals });
  const stored = writeBaseline && !isDefault ? totals : baseline;
  const delta = stored === null ? null : Object.fromEntries(Object.entries(totals).map(([name, total]) => [
    name, Object.hasOwn(stored, name) ? total - stored[name] : null
  ]));
  return { ok: true, repo, source: isDefault ? 'default' : 'profile', baselineFile: baselineName, totals, baseline: stored, delta };
}
