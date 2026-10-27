#!/usr/bin/env node
// Luna artifacts only. Root overrides replace defaults, including every temp root:
// LUNA_CLEAN_TMP, LUNA_CLEAN_RUN, LUNA_CLEAN_SESSIONS, LUNA_CLEAN_BAK_ROOTS.
// Multi-root overrides accept a JSON string array or the platform path delimiter.
import * as fs from 'node:fs';
import { homedir, tmpdir, uptime } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PREFIX_BYTES = 300 * 1024;
const MARKERS = ['Standing rules (from the orchestrator)', 'invoked by the Claude orchestrator'];
// Sessions written by the Claude Code codex plugin (review gate, /codex:*): kept 3 days, then removed.
const PLUGIN_MARKER = '"originator":"Claude Code"';
const CATEGORIES = ['temp-prompts', 'temp-results', 'lock-leftovers', 'run-artifacts', 'sessions', 'backups'];

function roots(value) {
  if (value.startsWith('[')) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('root override must be an array of nonempty paths');
    }
    return parsed;
  }
  return value.split(path.delimiter).filter(Boolean);
}

function uniqueRoots(values) {
  const seen = new Set();
  return values.map((value) => path.resolve(value)).filter((value) => {
    const key = value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tempRoots() { return [tmpdir(), '/tmp']; }

function safePath(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function configuration() {
  const home = path.resolve(process.env.HOME || homedir());
  const claude = path.join(home, '.claude');
  const backupRoots = [claude, path.join(claude, 'scripts'), path.join(claude, 'hooks')];
  if (!process.env.LUNA_CLEAN_BAK_ROOTS) {
    const skills = path.join(claude, 'skills');
    if (safePath(skills)) {
      for (const name of fs.readdirSync(skills)) {
        const dir = path.join(skills, name);
        const stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) backupRoots.push(dir);
      }
    }
  }
  return {
    tmp: uniqueRoots(process.env.LUNA_CLEAN_TMP ? roots(process.env.LUNA_CLEAN_TMP) : tempRoots()),
    run: path.resolve(process.env.LUNA_CLEAN_RUN || path.join(claude, 'luna-run')),
    sessions: path.resolve(process.env.LUNA_CLEAN_SESSIONS ||
      path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions')),
    backups: uniqueRoots(process.env.LUNA_CLEAN_BAK_ROOTS ? roots(process.env.LUNA_CLEAN_BAK_ROOTS) : backupRoots)
  };
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function throttled(run, force) {
  const stamp = path.join(run, '.last-clean');
  return !force && safePath(stamp) && Date.now() - fs.lstatSync(stamp).mtimeMs < DAY;
}

function runCleaner(config, {
  dryRun = false, force = false, verbose = false, quiet = false, boot = Date.now() - uptime() * 1000
} = {}) {
  const now = Date.now();
  const stamp = path.join(config.run, '.last-clean');
  const logPath = path.join(config.run, 'clean.log');
  const stats = Object.fromEntries(CATEGORIES.map((name) => [name, { files: 0, dirs: 0, bytes: 0, failed: 0 }]));
  const lines = [];
  const removed = new Set();
  let errors = 0;
  const print = (line) => { if (!quiet) process.stdout.write(`${line}\n`); };
  const record = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    lines.push(line);
    if (dryRun || verbose) print(line);
  };
  const fail = (target, error, category) => {
    errors += 1;
    if (category) stats[category].failed += 1;
    record(`FAILED ${JSON.stringify(target)} ${String(error.message).replace(/[\r\n]/g, ' ')}`);
  };
  const guarded = (target, fn) => {
    try { return fn(); } catch (error) { fail(target, error); return undefined; }
  };
  const entries = (dir) => safePath(dir) && fs.lstatSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
  const older = (stat, age) => now - stat.mtimeMs > age;

  if (throttled(config.run, force)) {
    return { stats, throttled: true, errors: 0 };
  }

  function remove(target, stat, category) {
    try {
      if (!safePath(target)) return false;
      const current = fs.lstatSync(target);
      if (current.isSymbolicLink() || !sameFile(stat, current)) return false;
      const dir = current.isDirectory();
      if (dir && !fs.readdirSync(target).every((name) => removed.has(path.join(target, name)))) return false;
      if (!dryRun) {
        if (dir) fs.rmdirSync(target);
        else fs.unlinkSync(target);
      }
      removed.add(target);
      stats[category][dir ? 'dirs' : 'files'] += 1;
      if (!dir) stats[category].bytes += current.size;
      record(`${dryRun ? 'WOULD DELETE' : 'DELETED'} ${category} ${JSON.stringify(target)}`);
      return true;
    } catch (error) {
      fail(target, error, category);
      return false;
    }
  }

  // A linked/unknown entry or an unreadable subtree protects the entire candidate.
  function snapshot(target) {
    if (!safePath(target)) return null;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() && !stat.isFile()) return null;
    const nodes = [];
    let newestFile = stat.isFile() ? stat.mtimeMs : -Infinity;
    let newestDir = stat.isDirectory() ? stat.mtimeMs : -Infinity;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) {
        const child = snapshot(path.join(target, name));
        if (!child) return null;
        newestFile = Math.max(newestFile, child.newestFile);
        newestDir = Math.max(newestDir, child.newestDir);
        nodes.push(...child.nodes);
      }
    }
    nodes.push({ target, stat });
    const newest = Number.isFinite(newestFile) ? newestFile : newestDir;
    return { nodes, newest, newestFile, newestDir };
  }

  function removeAgedTree(target, age, category) {
    const tree = snapshot(target);
    if (!tree || now - tree.newest <= age) return;
    // Recheck the entire candidate before mutation; newly written files protect it.
    const latest = snapshot(target);
    if (!latest || latest.nodes.length !== tree.nodes.length || latest.newest !== tree.newest) return;
    if (latest.nodes.some((node, i) => node.target !== tree.nodes[i].target ||
      !sameFile(node.stat, tree.nodes[i].stat))) return;
    for (const node of latest.nodes) {
      // Child removal changes directory metadata, so inspect directories again.
      const stat = !dryRun && node.stat.isDirectory() ? fs.lstatSync(node.target) : node.stat;
      if (!remove(node.target, stat, category)) break;
    }
  }

  for (const dir of config.tmp) guarded(dir, () => {
    for (const name of entries(dir)) guarded(path.join(dir, name), () => {
      const prompt = /^luna-(prompt|full)\..+$/.test(name);
      const result = /^luna-out\..+$/.test(name);
      if (!prompt && !result) return;
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (stat.isFile() && !stat.isSymbolicLink() && older(stat, prompt ? 6 * HOUR : 3 * DAY)) {
        remove(target, stat, prompt ? 'temp-prompts' : 'temp-results');
      }
    });
  });

  const active = path.join(config.run, 'active');
  guarded(active, () => {
    for (const name of entries(active)) guarded(path.join(active, name), () => {
      const index = path.join(active, name);
      if (!safePath(index)) return;
      const indexStat = fs.lstatSync(index);
      if (!indexStat.isFile()) return;
      const out = fs.readFileSync(index, 'utf8').split(/\r?\n/)[0].trim();
      if (!path.isAbsolute(out)) return;
      const status = `${out}.status`;
      if (!safePath(status)) return;
      const stat = fs.lstatSync(status);
      if (!stat.isFile()) return;
      const text = fs.readFileSync(status, 'utf8');
      const state = text.match(/^state=([^\r\n]*)/m)?.[1] || '';
      const started = Date.parse(text.match(/^started=([^\r\n]*)/m)?.[1]);
      if (!(state === 'running' || state === 'queued' || state.startsWith('waiting-')) || !(started < boot)) return;
      if (!dryRun) {
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        const updated = text.replace(/^state=[^\r\n]*/m, 'state=failed') +
          `${text.endsWith('\n') ? '' : newline}error=lost at PC reboot${newline}`;
        const temp = `${status}.${process.pid}.${randomUUID()}.tmp`;
        const fd = fs.openSync(temp, 'wx', stat.mode);
        try {
          try { fs.writeFileSync(fd, updated); }
          finally { fs.closeSync(fd); }
          if (!safePath(status) || !sameFile(stat, fs.lstatSync(status)) ||
              !safePath(index) || !sameFile(indexStat, fs.lstatSync(index))) return;
          fs.renameSync(temp, status);
        } finally {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
      }
      record(`${dryRun ? 'WOULD FAIL' : 'FAILED'} ${JSON.stringify(status)} lost at PC reboot`);
      remove(index, indexStat, 'run-artifacts');
    });
  });

  guarded(config.run, () => {
    for (const name of entries(config.run)) {
      if (['admit.lock', '.last-clean', 'clean.log'].includes(name)) continue;
      const target = path.join(config.run, name);
      const lock = /^admit\.lock\.(stale|rel)\..+$/.test(name);
      guarded(target, () => removeAgedTree(target, lock ? 10 * 60 * 1000 : 7 * DAY,
        lock ? 'lock-leftovers' : 'run-artifacts'));
    }
  });

  function lunaSession(target, expected) {
    if (!safePath(target)) return false;
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (!sameFile(expected, fs.fstatSync(fd))) return false;
      const buffer = Buffer.alloc(Math.min(PREFIX_BYTES, expected.size));
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const prefix = buffer.subarray(0, length).toString('utf8');
      if (MARKERS.some((marker) => prefix.includes(marker))) return 'luna';
      return prefix.slice(0, 4000).includes(PLUGIN_MARKER) ? 'plugin' : false;
    } finally { fs.closeSync(fd); }
  }

  function sessions(dir, parts = []) {
    let changed = false;
    for (const name of entries(dir)) guarded(path.join(dir, name), () => {
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (sessions(target, [...parts, name])) changed = true;
      } else if (stat.isFile() && name.endsWith('.jsonl') && older(stat, DAY)) {
        const kind = lunaSession(target, stat);
        if ((kind === 'luna' || (kind === 'plugin' && older(stat, 3 * DAY))) && remove(target, stat, 'sessions')) {
          changed = true;
        }
      }
    });
    const datePath = parts.length > 0 && parts.length <= 3 &&
      parts.every((part, i) => (i === 0 ? /^\d{4}$/ : /^\d{2}$/).test(part));
    if (changed && datePath && entries(dir).every((name) => removed.has(path.join(dir, name)))) {
      remove(dir, fs.lstatSync(dir), 'sessions');
    }
    return changed;
  }
  guarded(config.sessions, () => sessions(config.sessions));

  for (const dir of config.backups) guarded(dir, () => {
    const groups = new Map();
    for (const name of entries(dir)) {
      const match = /^(.+)\.bak(?:-.*)?$/.exec(name);
      if (!match) continue;
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const key = match[1];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ target, stat });
    }
    for (const group of groups.values()) {
      const newest = Math.max(...group.map(({ stat }) => stat.mtimeMs));
      for (const { target, stat } of group) {
        if (stat.mtimeMs < newest && older(stat, 30 * DAY)) remove(target, stat, 'backups');
      }
    }
  });

  for (const [category, count] of Object.entries(stats)) {
    if (dryRun || verbose) print(`${category}: files=${count.files} dirs=${count.dirs} ` +
      `bytes=${count.bytes} failed=${count.failed}`);
  }
  const totals = Object.values(stats).reduce((sum, count) => ({
    files: sum.files + count.files, dirs: sum.dirs + count.dirs, bytes: sum.bytes + count.bytes
  }), { files: 0, dirs: 0, bytes: 0 });
  record(`summary ${dryRun ? 'dry-run' : 'clean'} files=${totals.files} dirs=${totals.dirs} ` +
    `bytes=${totals.bytes} errors=${errors}`);

  if (!dryRun) {
    try {
      // Do not create the run directory through a linked ancestor.
      if (!fs.existsSync(config.run) && safePath(path.dirname(config.run))) fs.mkdirSync(config.run);
      if (!safePath(config.run) || !fs.lstatSync(config.run).isDirectory()) throw Error('unsafe run root');
      let previous = [];
      let logExists = false;
      try {
        const stat = fs.lstatSync(logPath);
        if (stat.isSymbolicLink() || !stat.isFile() || !safePath(logPath)) throw Error('unsafe log path');
        logExists = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (logExists) {
        previous = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
      }
      // open with NOFOLLOW as well as lstat, where supported.
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC |
        (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(logPath, flags, 0o600);
      try { fs.writeFileSync(fd, `${[...previous, ...lines].slice(-1000).join('\n')}\n`); }
      finally { fs.closeSync(fd); }
      if (errors === 0) {
        // A dangling link must also protect the stamp (existsSync alone misses it).
        try {
          if (fs.lstatSync(stamp).isSymbolicLink() || !safePath(stamp)) throw Error('unsafe stamp path');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const stampFd = fs.openSync(stamp, flags, 0o600);
        try { fs.writeFileSync(stampFd, `${new Date(now).toISOString()}\n`); }
        finally { fs.closeSync(stampFd); }
      }
    } catch (error) {
      errors += 1;
      if (!quiet) process.stderr.write(`luna-clean: ${error.message}\n`);
    }
  }
  return { stats, throttled: false, errors };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'luna-clean-test-'));
  const saved = Object.fromEntries(['LUNA_CLEAN_TMP', 'LUNA_CLEAN_RUN', 'LUNA_CLEAN_SESSIONS',
    'LUNA_CLEAN_BAK_ROOTS'].map((key) => [key, process.env[key]]));
  let passed = 0;
  let failed = 0;
  const check = (label, condition) => {
    if (condition) passed += 1;
    else failed += 1;
    process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  };
  const dirs = Object.fromEntries(['tmp', 'run', 'sessions', 'backups', 'outside']
    .map((name) => [name, path.join(root, name)]));
  const age = (target, days) => {
    const time = new Date(Date.now() - days * DAY);
    fs.utimesSync(target, time, time);
  };
  const file = (base, name, days, content = 'fixture') => {
    const target = path.join(base, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    age(target, days);
    return target;
  };
  const exists = (target) => fs.existsSync(target);
  try {
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
    process.env.LUNA_CLEAN_TMP = JSON.stringify([dirs.tmp, dirs.tmp]);
    process.env.LUNA_CLEAN_RUN = dirs.run;
    process.env.LUNA_CLEAN_SESSIONS = dirs.sessions;
    process.env.LUNA_CLEAN_BAK_ROOTS = JSON.stringify([dirs.backups]);
    const config = configuration();
    const oldPrompt = file(dirs.tmp, 'luna-prompt.old', 1);
    const oldFull = file(dirs.tmp, 'luna-full.old', 1);
    const freshPrompt = file(dirs.tmp, 'luna-prompt.fresh', 0.1);
    const freshFull = file(dirs.tmp, 'luna-full.fresh', 0.1);
    const oldResult = file(dirs.tmp, 'luna-out.old', 4);
    const oldLog = file(dirs.tmp, 'luna-out.old.log', 4);
    const oldStatus = file(dirs.tmp, 'luna-out.old.status', 4);
    const youngResult = file(dirs.tmp, 'luna-out.young', 2);
    const unrelated = file(dirs.tmp, 'user-file', 100);
    const lock = file(dirs.run, 'admit.lock/owner', 20);
    const stale = file(dirs.run, 'admit.lock.stale.old/owner', 1);
    const rel = file(dirs.run, 'admit.lock.rel.old/owner', 1);
    const freshLock = file(dirs.run, 'admit.lock.stale.fresh/owner', 0);
    const oldJob = file(dirs.run, 'old-job/output', 8);
    const activeJob = file(dirs.run, 'active-job/nested/output', 0);
    const oldRunFile = file(dirs.run, 'old-file', 8);
    const recentDirOldFile = file(dirs.run, 'recent-dir-old-file/output', 8);
    for (const target of [lock, stale, rel, oldJob]) age(path.dirname(target), 20);
    age(path.dirname(activeJob), 20);
    age(path.dirname(path.dirname(activeJob)), 20);
    const oldSession = file(dirs.sessions, '2020/01/01/luna.jsonl', 2, MARKERS[0]);
    const otherMarker = file(dirs.sessions, '2020/01/02/luna.jsonl', 2, MARKERS[1]);
    const freshSession = file(dirs.sessions, '2020/02/01/fresh.jsonl', 0, MARKERS[0]);
    const userSession = file(dirs.sessions, '2020/03/01/user.jsonl', 100, 'user history');
    const lateMarker = file(dirs.sessions, '2020/04/01/late.jsonl', 100,
      `${'x'.repeat(PREFIX_BYTES)}${MARKERS[0]}`);
    const untouchedEmpty = path.join(dirs.sessions, '1999/01/01');
    fs.mkdirSync(untouchedEmpty, { recursive: true });
    const oldestBackup = file(dirs.backups, 'one.mjs.bak-old', 100);
    const newestBackup = file(dirs.backups, 'one.mjs.bak-new', 90);
    const onlyBackup = file(dirs.backups, 'two.mjs.bak', 90);
    const freshBackup = file(dirs.backups, 'three.mjs.bak-old', 20);
    file(dirs.backups, 'three.mjs.bak-new', 1);
    const tiedBackup = file(dirs.backups, 'tie.bak-a', 90);
    const tiedBackup2 = file(dirs.backups, 'tie.bak-b', 90);
    fs.utimesSync(tiedBackup2, fs.statSync(tiedBackup).atime, fs.statSync(tiedBackup).mtime);
    const nestedBackup = file(dirs.backups, 'nested/one.mjs.bak-old', 100);
    file(dirs.backups, 'nested/one.mjs.bak-new', 90);
    const outside = file(dirs.outside, 'luna-prompt.outside', 100);
    const link = path.join(dirs.run, 'linked-job');
    fs.symlinkSync(dirs.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const nestedLink = path.join(dirs.run, 'protected-job/link');
    fs.mkdirSync(path.dirname(nestedLink));
    fs.symlinkSync(dirs.outside, nestedLink, process.platform === 'win32' ? 'junction' : 'dir');
    const protectedFile = file(dirs.run, 'protected-job/output', 100);
    age(path.dirname(nestedLink), 100);
    const boot = Date.now() - 60_000;
    const rebootJobs = [
      ['running', boot - DAY, true],
      ['queued', boot - DAY, true],
      ['waiting-ram', boot - DAY, true],
      ['running', boot - 1, true],
      ['running', boot, false],
      ['running', boot + 1, false],
      ['done', boot - DAY, false],
      ['failed', boot - DAY, false],
      ['running', 'invalid', false],
      ['running', undefined, false]
    ].map(([state, started, dead], i) => {
      const out = path.join(dirs.outside, `reboot-${i}`);
      const stamp = typeof started === 'number' ? new Date(started).toISOString() : started;
      const text = `state=${state}\r\npid=${process.pid}\r\n` +
        `${stamp === undefined ? '' : `started=${stamp}\r\n`}model=test\r\nerror=previous`;
      const status = file(dirs.outside, `reboot-${i}.status`, 0, text);
      const index = file(dirs.run, `active/reboot-${i}`, 0, `${out}\r\n${process.pid}\r\n`);
      return { status, index, text, dead };
    });
    const dry = runCleaner(config, { dryRun: true, force: true, quiet: true, boot });
    check('dry-run plans old files without writing log or stamp',
      dry.stats['temp-prompts'].files === 2 && exists(oldPrompt) && !exists(path.join(dirs.run, 'clean.log')) &&
      !exists(path.join(dirs.run, '.last-clean')));
    check('dry-run preserves pre-boot statuses and active indexes', rebootJobs.every(({ status, index, text }) =>
      exists(index) && fs.readFileSync(status, 'utf8') === text));
    const result = runCleaner(config, { force: true, quiet: true, boot });
    check('run succeeds', result.errors === 0);
    for (const [i, { status, index, text, dead }] of rebootJobs.entries()) {
      const expected = dead ? text.replace(/^state=[^\r\n]*/, 'state=failed') +
        '\r\nerror=lost at PC reboot\r\n' : text;
      check(`reboot job ${i}: status and index`, exists(index) === !dead && fs.readFileSync(status, 'utf8') === expected);
    }
    check('atomic reboot status updates leave no temporary files',
      !fs.readdirSync(dirs.outside).some((name) => name.endsWith('.tmp')));
    check('old prompt and full files deleted', !exists(oldPrompt) && !exists(oldFull));
    check('fresh prompt and full files kept', exists(freshPrompt) && exists(freshFull));
    check('output and sidecars deleted after three days', !exists(oldResult) && !exists(oldLog) && !exists(oldStatus));
    check('output kept until three days', exists(youngResult));
    check('unrelated temp file kept', exists(unrelated));
    check('admit.lock kept', exists(lock));
    check('old stale and release directories deleted', !exists(path.dirname(stale)) && !exists(path.dirname(rel)));
    check('fresh stale directory kept', exists(freshLock));
    check('old job tree and run file deleted', !exists(path.dirname(oldJob)) && !exists(oldRunFile));
    check('directory age uses newest file, not directory metadata', !exists(recentDirOldFile));
    check('newest inner mtime protects job', exists(activeJob));
    check('both markers identify old Luna sessions', !exists(oldSession) && !exists(otherMarker));
    check('fresh Luna session kept', exists(freshSession));
    check('old user session kept', exists(userSession));
    check('marker beyond 300 KB is ignored', exists(lateMarker));
    check('only newly emptied date directories removed',
      !exists(path.join(dirs.sessions, '2020/01')) && exists(untouchedEmpty));
    check('oldest backup deleted and newest 90-day backup kept', !exists(oldestBackup) && exists(newestBackup));
    check('sole 90-day backup kept', exists(onlyBackup));
    check('backups younger than 30 days kept', exists(freshBackup));
    check('tied newest backups kept', exists(tiedBackup) && exists(tiedBackup2));
    check('backup scan is direct only', exists(nestedBackup));
    check('junction or symlink not followed', fs.lstatSync(link).isSymbolicLink() && exists(outside));
    check('nested link protects whole candidate', exists(protectedFile) && exists(outside));
    check('duplicate temp roots de-duplicated', config.tmp.length === 1);
    const throttled = file(dirs.tmp, 'luna-full.throttled', 1);
    check('successful run writes stamp', exists(path.join(dirs.run, '.last-clean')));
    check('default throttles within 24 hours', runCleaner(config, { quiet: true }).throttled && exists(throttled));
    const log = path.join(dirs.run, 'clean.log');
    const beforeLog = fs.readFileSync(log, 'utf8');
    const beforeStamp = fs.readFileSync(path.join(dirs.run, '.last-clean'), 'utf8');
    runCleaner(config, { force: true, dryRun: true, quiet: true });
    check('forced dry-run leaves log and stamp unchanged', fs.readFileSync(log, 'utf8') === beforeLog &&
      fs.readFileSync(path.join(dirs.run, '.last-clean'), 'utf8') === beforeStamp && exists(throttled));
    fs.writeFileSync(log, `${'old line\n'.repeat(1100)}`);
    runCleaner(config, { force: true, quiet: true });
    check('force bypasses throttle', !exists(throttled));
    check('log retains only last 1000 lines', fs.readFileSync(log, 'utf8').trimEnd().split('\n').length === 1000);
    const expired = file(dirs.tmp, 'luna-full.expired-stamp', 1);
    age(path.join(dirs.run, '.last-clean'), 2);
    check('expired stamp allows cleanup', !runCleaner(config, { quiet: true }).throttled && !exists(expired));
  } catch (error) {
    check(`self-test exception: ${error.stack}`, false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // All paths are owned by this test; unlink links before recursively removing the fixture.
    for (const relative of ['run/linked-job', 'run/protected-job/link']) {
      const target = path.join(root, relative);
      try { if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('luna-clean-test-')) {
      throw Error('unsafe self-test cleanup target');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`clean self-test: passed=${passed} failed=${failed}\n`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  const allowed = new Set(['--dry-run', '--force', '--verbose']);
  if (args.some((arg) => !allowed.has(arg))) throw Error('usage: luna-clean.mjs [--dry-run] [--force] [--verbose]');
  const home = path.resolve(process.env.HOME || homedir());
  const run = path.resolve(process.env.LUNA_CLEAN_RUN || path.join(home, '.claude/luna-run'));
  if (throttled(run, args.includes('--force'))) return 0;
  runCleaner(configuration(), {
    dryRun: args.includes('--dry-run'), force: args.includes('--force'), verbose: args.includes('--verbose')
  });
  if (!args.includes('--dry-run')) {
    try {
      const reaper = fileURLToPath(new URL('./luna-reap-brokers.mjs', import.meta.url));
      const child = spawn(process.execPath, [reaper], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch {}
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`luna-clean: ${error.message}\n`);
    process.exitCode = process.argv.includes('--self-test') ? 1 : 0;
  }
}
