// Windows process creation times use the same FILETIME ticks as GetProcessTimes and CIM.
import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function nativePath(file) {
  if (process.platform !== 'win32') return file;
  return file.replace(/^\/(?:cygdrive\/)?([a-z])(?:\/|$)/i, '$1:/');
}

function sessionTime(payload, stat) {
  const stamp = typeof payload.timestamp === 'string' ? payload.timestamp : '';
  const parts = /T\d\d:\d\d:\d\d(?:\.(\d+))?(?:Z|[+-]\d\d:\d\d)$/i.exec(stamp);
  const time = parts ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(time)) return { time: stat.birthtimeMs, latest: stat.birthtimeMs };
  const digits = Math.min(parts[1]?.length || 0, 3);
  return { time, latest: time + 10 ** (3 - digits) - 1 };
}

// Codex rollout metadata identifies a session when the CLI did not print its ID.
export function findSession(home, cwd, startMs) {
  if (typeof home !== 'string' || !home || typeof cwd !== 'string' || !cwd || !Number.isFinite(startMs)) return '';
  const key = (file) => {
    let resolved = path.resolve(nativePath(file));
    try { resolved = realpathSync(resolved); } catch {}
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const expected = key(cwd);
  const directories = [path.join(nativePath(home), 'sessions')];
  let newest = null;
  while (directories.length) {
    const dir = directories.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { directories.push(file); continue; }
      const match = /^rollout-(?:.*-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      let fd;
      try {
        const stat = statSync(file);
        fd = openSync(file, 'r');
        const buffer = Buffer.alloc(65536);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0];
        const meta = JSON.parse(first);
        if (meta.type !== 'session_meta' || typeof meta.payload?.cwd !== 'string' ||
            String(meta.payload.id).toLowerCase() !== match[1].toLowerCase() || key(meta.payload.cwd) !== expected) {
          continue;
        }
        // NTFS can preserve the old birth time when a deleted filename is recreated. The session's own
        // timestamp identifies its creation; older metadata without one retains the birth-time fallback.
        const created = sessionTime(meta.payload, stat);
        // A coarse timestamp that overlaps the start is ambiguous unless the file's birth time confirms it.
        if (created.time < startMs && (created.latest < startMs || stat.birthtimeMs < startMs)) continue;
        if (newest && created.time < newest.created) continue;
        if (newest && created.time === newest.created && stat.mtimeMs <= newest.modified) continue;
        newest = { id: match[1], created: created.time, modified: stat.mtimeMs };
      } catch {} finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  return newest?.id.toLowerCase() || '';
}

function query(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';` +
    `if ($p -and $p.CreationDate) {$p.CreationDate.ToFileTimeUtc().ToString()}`;
}

const options = { encoding: 'utf8', windowsHide: true, timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] };
const args = (command) => ['-NoProfile', '-NonInteractive', '-Command', command];
const value = (text) => /^\d+$/.test(text.trim()) ? text.trim() : '';

export function processStart(pid) {
  const command = query(pid);
  if (!command) return '';
  try { return value(execFileSync('powershell.exe', args(command), options)); }
  catch { return ''; }
}

export function processStarts(pids) {
  const ids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const result = new Map();
  if (!ids.length) return result;
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const command = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {` +
    `if ($_.CreationDate) { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" } }`;
  try {
    const output = execFileSync('powershell.exe', args(command), options);
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+) (\d+)$/.exec(line.trim());
      if (match) result.set(Number(match[1]), match[2]);
    }
  } catch {}
  return result;
}

export function processStartAsync(pid) {
  const command = query(pid);
  if (!command) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('powershell.exe', args(command), options, (error, stdout) => resolve(error ? '' : value(stdout)));
  });
}

// Accept ISO timestamps too, for discovery records written with CIM's round-trip format.
export function sameStart(actual, expected) {
  if (!actual || !expected) return true; // A failed probe or an older record must not discard live work.
  if (String(actual) === String(expected)) return true;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(Z|[+-]\d\d:\d\d)?$/i.exec(String(expected));
  if (!match) return false;
  const times = [Date.parse(`${match[1]}${match[3] || ''}`)];
  if (!match[3]) times.push(Date.parse(`${match[1]}Z`));
  return times.some((millis) => Number.isFinite(millis) && actual === String(
    (BigInt(millis) + 11644473600000n) * 10000n + BigInt((match[2] || '').padEnd(7, '0'))));
}

function selfTest() {
  const tempRoot = path.resolve(os.tmpdir());
  const root = mkdtempSync(path.join(tempRoot, 'luna-session-test-'));
  const cwd = path.join(root, 'work');
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const otherId = 'fedcba98-7654-3210-fedc-ba9876543210';
  const base = Math.floor((Date.now() + 60_000) / 1000) * 1000;
  let passed = 0, failed = 0, serial = 0;
  const check = (name, ok) => {
    if (ok) { passed++; console.log(`PASS ${name}`); }
    else { failed++; console.error(`FAIL ${name}`); }
  };
  const fixture = () => {
    const home = path.join(root, `home-${++serial}`);
    const dir = path.join(home, 'sessions', '2026', '10', '27');
    mkdirSync(dir, { recursive: true });
    return { home, dir };
  };
  const write = (dir, sessionId, payload, nameId = sessionId) => {
    const file = path.join(dir, `rollout-2026-10-27T00-00-00-${nameId}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd, ...payload } })}\n` +
      '{"type":"event_msg"}\n');
    return file;
  };
  try {
    mkdirSync(cwd);
    check('rejects invalid lookup arguments', findSession('', cwd, base) === '' && findSession(root, cwd, NaN) === '');
    check('missing sessions directory is harmless', findSession(root, cwd, base) === '');

    const recent = fixture();
    const current = write(recent.dir, id, { timestamp: new Date(base + 500).toISOString() });
    check('recorded timestamp handles an older filesystem birth time',
      statSync(current).birthtimeMs < base && findSession(recent.home, cwd, base) === id);
    check('normalizes dot segments and a trailing slash',
      findSession(recent.home, path.join(cwd, '..', 'work') + path.sep, base) === id);
    check('rejects a different working directory', findSession(recent.home, root, base) === '');

    if (process.platform === 'win32') {
      const msys = (value) => value.replace(/\\/g, '/').replace(/^([a-z]):\//i, '/$1/');
      const cygwin = (value) => msys(value).replace(/^\/([a-z])\//i, '/cygdrive/$1/');
      check('matches Windows case and slash variants', findSession(recent.home, cwd.toUpperCase().replace(/\\/g, '/'),
        base) === id);
      check('converts MSYS home and cwd paths', findSession(msys(recent.home), msys(cwd), base) === id);
      check('converts cygdrive home and cwd paths', findSession(cygwin(recent.home), cygwin(cwd), base) === id);
      const metaMsys = fixture();
      write(metaMsys.dir, id, { cwd: msys(cwd), timestamp: new Date(base).toISOString() });
      check('matches an MSYS cwd recorded in metadata', findSession(metaMsys.home, cwd, base) === id);
    }

    const stale = fixture();
    const staleFile = write(stale.dir, id, { timestamp: new Date(base - 5000).toISOString() });
    utimesSync(staleFile, new Date(base + 5000), new Date(base + 5000));
    check('rejects an old session even if its file was modified later', findSession(stale.home, cwd, base) === '');

    const timezone = fixture();
    const offset = new Date(base + 3 * 3600_000).toISOString().replace('Z', '+03:00');
    write(timezone.dir, id, { timestamp: offset });
    check('compares timezone offsets as UTC instants', findSession(timezone.home, cwd, base) === id &&
      findSession(timezone.home, cwd, base + 1) === '');

    const seconds = fixture();
    const secondsFile = write(seconds.dir, id, {});
    const secondsBirth = statSync(secondsFile).birthtimeMs;
    const secondsBase = Math.floor(secondsBirth / 1000) * 1000;
    write(seconds.dir, id, { timestamp: new Date(secondsBase).toISOString().replace('.000Z', 'Z') });
    check('uses birth time to confirm an overlapping second-only timestamp',
      findSession(seconds.home, cwd, Math.floor(secondsBirth)) === id);
    const ambiguousSeconds = fixture();
    write(ambiguousSeconds.dir, id, { timestamp: new Date(base).toISOString().replace('.000Z', 'Z') });
    check('rejects an ambiguous second-only timestamp without birth-time confirmation',
      findSession(ambiguousSeconds.home, cwd, base + 999) === '');
    const tenths = fixture();
    const tenthsFile = write(tenths.dir, id, {});
    const tenthsBirth = statSync(tenthsFile).birthtimeMs;
    const tenthsBase = Math.floor(tenthsBirth / 100) * 100;
    write(tenths.dir, id, { timestamp: new Date(tenthsBase).toISOString().replace(/(\.\d)\d\dZ$/, '$1Z') });
    check('uses birth time to confirm an overlapping fractional timestamp',
      findSession(tenths.home, cwd, Math.floor(tenthsBirth)) === id);
    const ambiguousTenths = fixture();
    write(ambiguousTenths.dir, id, { timestamp: new Date(base + 100).toISOString().replace('.100Z', '.1Z') });
    check('rejects an ambiguous fractional timestamp without birth-time confirmation',
      findSession(ambiguousTenths.home, cwd, base + 199) === '');

    const latest = fixture();
    const older = write(latest.dir, id, { timestamp: new Date(base + 1000).toISOString() });
    write(latest.dir, otherId, { timestamp: new Date(base + 2000).toISOString() });
    utimesSync(older, new Date(base + 9000), new Date(base + 9000));
    check('selects the newest matching session instead of the newest modification',
      findSession(latest.home, cwd, base) === otherId);

    const invalid = fixture();
    write(invalid.dir, id, { timestamp: new Date(base).toISOString() }, otherId);
    check('rejects an id that does not match the filename', findSession(invalid.home, cwd, base) === '');
    const legacy = fixture();
    write(legacy.dir, id, {});
    check('metadata without a timestamp retains the filesystem birth-time fallback',
      findSession(legacy.home, cwd, Date.now() - 2000) === id && findSession(legacy.home, cwd, base) === '');
    write(legacy.dir, otherId, { timestamp: 'invalid' });
    check('invalid timestamps also use the birth-time fallback', findSession(legacy.home, cwd, base) === '');
  } finally {
    if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('luna-session-test-')) {
      throw new Error('invalid self-test cleanup path');
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`process identity self-test: passed=${passed} failed=${failed}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
    process.argv[2] === '--self-test') {
  process.exitCode = selfTest();
}
