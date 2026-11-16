import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJsonAtomic } from './orchestration.mjs';

const execute = promisify(execFile);
const jsFiles = '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}';
const tsFiles = '**/*.{ts,tsx,mts,cts}';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fallback = (value, defaultValue) => value === undefined ? defaultValue : value;

function keys(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${label} key: ${key}`);
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => text(entry, `${label}.${index}`));
}

function relativeFile(value, label) {
  text(value, label);
  if (path.isAbsolute(value) || value.split('/').includes('..') || path.normalize(value) === '.') {
    throw new Error(`${label} must be a file or directory path inside the repository`);
  }
  return value;
}

export function matchesGlob(file, glob) {
  return path.matchesGlob(file, glob);
}

function entries(value, label) {
  // Write {files} unquoted in run commands; the runner supplies quoted positional arguments.
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const names = new Set();
  return value.map((entry, index) => {
    const where = `${label}.${index}`;
    keys(entry, ['name', 'glob', 'when', 'run'], where);
    text(entry.name, `${where}.name`);
    text(entry.run, `${where}.run`);
    if (names.has(entry.name)) throw new Error(`${where}: duplicate name ${entry.name}`);
    names.add(entry.name);
    for (const key of ['glob', 'when']) {
      if (Object.hasOwn(entry, key)) text(entry[key], `${where}.${key}`);
    }
    if (entry.glob !== undefined && entry.when !== undefined) throw new Error(`${where}: choose glob or when`);
    return { ...entry };
  });
}

function counters(value) {
  if (!Array.isArray(value)) throw new Error('hygiene.counters must be an array');
  const names = new Set();
  return value.map((counter, index) => {
    const where = `hygiene.counters.${index}`;
    keys(counter, ['name', 'pattern', 'maxLines', 'glob', 'exclude'], where);
    text(counter.name, `${where}.name`);
    if (names.has(counter.name)) throw new Error(`${where}: duplicate name ${counter.name}`);
    names.add(counter.name);
    if (Object.hasOwn(counter, 'pattern') === Object.hasOwn(counter, 'maxLines')) {
      throw new Error(`${where}: exactly one of pattern or maxLines is required`);
    }
    if (Object.hasOwn(counter, 'pattern')) {
      text(counter.pattern, `${where}.pattern`);
      try { new RegExp(counter.pattern, 'g'); }
      catch (error) { throw new Error(`${where}.pattern: ${error.message}`); }
    } else if (!Number.isSafeInteger(counter.maxLines) || counter.maxLines < 1) {
      throw new Error(`${where}.maxLines must be a positive integer`);
    }
    for (const key of ['glob', 'exclude']) {
      if (Object.hasOwn(counter, key)) text(counter[key], `${where}.${key}`);
    }
    return { glob: '**/*', ...counter };
  });
}

function defaults(profile) {
  keys(profile, ['version', 'fast', 'turn', 'verify', 'evidence_dir', 'budgets', 'gate', 'hygiene'], 'profile');
  if (profile.version !== 1) throw new Error('profile.version must be 1');
  const budgets = { fast_s: 20, turn_s: 300 };
  if (profile.budgets !== undefined) {
    keys(profile.budgets, Object.keys(budgets), 'budgets');
    for (const [key, value] of Object.entries(profile.budgets)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value * 1000 > 2 ** 31 - 1) {
        throw new Error(`budgets.${key} must be positive and fit a process timer`);
      }
      budgets[key] = value;
    }
  }
  let verify = null;
  if (profile.verify !== undefined) {
    keys(profile.verify, ['skill', 'required_for'], 'verify');
    verify = {
      skill: text(profile.verify.skill, 'verify.skill'),
      required_for: strings(fallback(profile.verify.required_for, []), 'verify.required_for')
    };
  }
  const gate = fallback(profile.gate, {});
  keys(gate, ['mode'], 'gate');
  if (gate.mode !== undefined && !['block', 'warn', 'off'].includes(gate.mode)) {
    throw new Error('gate.mode must be block, warn or off');
  }
  const hygiene = fallback(profile.hygiene, {});
  keys(hygiene, ['counters', 'baseline'], 'hygiene');
  return {
    version: 1,
    fast: entries(fallback(profile.fast, []), 'fast'),
    turn: entries(fallback(profile.turn, []), 'turn'),
    verify,
    evidence_dir: relativeFile(fallback(profile.evidence_dir, '.conveyor/evidence'), 'evidence_dir'),
    budgets,
    gate: { mode: gate.mode ?? 'block' },
    hygiene: {
      counters: counters(fallback(hygiene.counters, [])),
      baseline: relativeFile(fallback(hygiene.baseline, '.conveyor/hygiene-baseline.json'), 'hygiene.baseline')
    }
  };
}

function defaultCounters() {
  return [
    { name: 'eslint-disable', pattern: 'eslint-disable', glob: jsFiles },
    { name: '@ts-ignore', pattern: '@ts-ignore', glob: jsFiles },
    { name: 'setTimeout', pattern: String.raw`\bsetTimeout\(`, glob: jsFiles },
    { name: 'broad-except', pattern: 'except Exception', glob: '**/*.py' },
    { name: 'type-ignore', pattern: '# type: ignore', glob: '**/*.py' },
    { name: 'time.sleep', pattern: String.raw`\btime\.sleep\(`, glob: '**/*.py' },
    { name: 'TODO/FIXME', pattern: String.raw`\b(?:TODO|FIXME)\b`, glob: '**/*' },
    { name: 'large-files', maxLines: 1500, glob: '**/*' }
  ];
}

async function optionalText(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function autodetect(repo) {
  const profile = { version: 1, fast: [], turn: [], hygiene: { counters: defaultCounters() } };
  const rawPackage = await optionalText(path.join(repo, 'package.json'));
  if (rawPackage !== null) {
    const pkg = JSON.parse(rawPackage);
    if (!object(pkg)) throw new Error('package.json must be an object');
    const files = await fs.readdir(repo);
    if (files.some((file) => /^eslint\.config\..+|^\.eslintrc(?:\..*)?$/.test(file))) {
      profile.fast.push({ name: 'eslint', glob: jsFiles, run: 'npx eslint --max-warnings=0 {files}' });
    } else if (typeof pkg.scripts?.lint === 'string') {
      profile.turn.push({ name: 'lint', when: jsFiles, run: 'npm run lint' });
    }
    const script = ['typecheck', 'type-check'].find((name) => typeof pkg.scripts?.[name] === 'string');
    if (script || files.includes('tsconfig.json')) {
      profile.turn.push({ name: 'types', when: tsFiles, run: script ? `npm run ${script}` : 'npx tsc --noEmit' });
    }
    if ([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((deps) => Object.hasOwn(deps ?? {}, 'vitest'))) {
      profile.turn.push({ name: 'tests', when: jsFiles, run: 'npx vitest related --run {files}' });
    }
  }
  const pyproject = await optionalText(path.join(repo, 'pyproject.toml'));
  if (pyproject !== null) {
    const hasTool = (name) => new RegExp(`^\\s*\\[tool\\.${name}(?:\\.|\\])`, 'm').test(pyproject) ||
      new RegExp(`["']${name}(?:\\[[^"']*\\])?(?=[<>=!~;\\s"'])`).test(pyproject);
    if (hasTool('ruff')) {
      const uv = await optionalText(path.join(repo, 'uv.lock'));
      profile.fast.push({ name: 'ruff', glob: '**/*.py', run: `${uv === null ? '' : 'uv run '}ruff check {files}` });
    }
    if (/^\s*\[tool\.mypy(?:\.|\])/m.test(pyproject)) {
      profile.turn.push({ name: 'mypy', when: '**/*.py', run: 'uv run mypy {files}' });
    }
    if (hasTool('pytest')) {
      profile.turn.push({
        name: 'pytest', when: '**/*.py',
        run: 'python3 ~/.claude/scripts/pytest_gate.py -n 2 -- -q {tests_for_files}'
      });
    }
  }
  return defaults(profile);
}

export async function loadProfile(repo) {
  const file = path.join(path.resolve(repo), '.claude', 'conveyor.json');
  const raw = await optionalText(file);
  try {
    if (raw === null) return { ...await autodetect(repo), profileTrust: 'autodetected' };
    const profile = defaults(JSON.parse(raw));
    const trusted = JSON.parse(await optionalText(trustFile()) || '{}');
    const identity = await repositoryIdentity(repo), sha256 = digest(raw);
    if ((Array.isArray(trusted[identity]) && trusted[identity].includes(sha256)) || trusted[path.resolve(repo)] === sha256) {
      return { ...profile, profileTrust: 'trusted' };
    }
    return { ...await autodetect(repo), hygiene: profile.hygiene, profileTrust: 'untrusted' };
  }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}

function trustFile() {
  const home = process.env.CONVEYOR_HOME || path.join(homedir(), '.claude', 'conveyor');
  return path.join(home, 'trusted-profiles.json');
}

const digest = (raw) => createHash('sha256').update(raw).digest('hex');

async function repositoryIdentity(repo) {
  let stdout;
  try {
    ({ stdout } = await execute('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }));
  } catch { return path.resolve(repo); }
  return fs.realpath(path.resolve(repo, stdout.replace(/\r?\n$/, '')));
}

export async function trustProfile(repo) {
  const raw = await fs.readFile(path.join(repo, '.claude', 'conveyor.json'), 'utf8');
  defaults(JSON.parse(raw));
  const file = trustFile(), trusted = JSON.parse(await optionalText(file) || '{}');
  const identity = await repositoryIdentity(repo), sha256 = digest(raw), repoPath = path.resolve(repo);
  const previous = Array.isArray(trusted[identity]) ? trusted[identity] : [];
  const legacy = typeof trusted[repoPath] === 'string' ? [trusted[repoPath]] : [];
  const digests = [...new Set([...previous, ...legacy])].filter((entry) => entry !== sha256);
  if (legacy.length) delete trusted[repoPath];
  await writeJsonAtomic(file, { ...trusted, [identity]: [...digests, sha256].slice(-5) });
  return { ok: true, repo, identity, profileTrust: 'trusted', sha256 };
}
