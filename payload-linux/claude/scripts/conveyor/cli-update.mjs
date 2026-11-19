#!/usr/bin/env node
// Read-only status and explicitly confirmed executor updates. No binary patching on Linux.
import * as fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { home as userHome, killTree, listProcesses, platform } from './lib/platform.mjs';
import { run as runSupervised, startMaintenanceWatchdog } from '../lib/supervised-run.mjs';

const updater = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
const registry = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const allowedHosts = new Set(['registry.npmjs.org', 'storage.googleapis.com', new URL(updater).hostname]);
const cacheLifetime = 6 * 60 * 60 * 1000;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const home = () => path.resolve(userHome());
const conveyor = () => path.join(home(), '.claude', 'conveyor');
const agyDir = () => path.resolve(process.env.CLI_UPDATE_AGY_DIR || '/srv/docker/compose/antigravity-parallel');
const runDir = () => path.resolve(process.env.LUNA_RUN_DIR || path.join(home(), '.claude', 'luna-run'));
const proxy = () => process.env.HTTPS_PROXY || 'http://127.0.0.1:10809';
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

class Failure extends Error {
  constructor(reason, code = 1, details = {}) {
    super(reason);
    this.code = code;
    this.details = details;
  }
}

async function optionalJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function hashFile(file, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function atomicWrite(file, text, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

// Each child has a hard deadline; kill its process group as well as npm's immediate process.
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env, detached: platform !== 'win32',
      stdio: ['ignore', options.stdoutFd ?? 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', failure = null;
    const stop = () => { try { killTree(child, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => {
      failure = new Error(`${path.basename(command)} timed out after ${options.timeout || 10_000} ms`);
      stop();
    }, options.timeout || 10_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4 * 1024 * 1024) { failure = new Error('command output too large'); stop(); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

async function runProbe(command, args, { timeout = 10_000, env, input, stopWhen } = {}) {
  let matched = false;
  const result = await runSupervised([command, ...args], {
    deadlineMs: timeout, env, input, stopWhen: stopWhen && ((stdout) => (matched = stopWhen(stdout)))
  });
  if (result.timedOut) throw new Error(`${path.basename(command)} timed out after ${timeout} ms`);
  if (result.truncated) throw new Error('command output too large');
  return matched ? { ...result, code: 0 } : result;
}

function succeeded(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
  return result.stdout;
}

function officialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443')) throw new Error(`refused non-allowlisted URL: ${url.origin}`);
  return url;
}

async function fetchOfficial(value, output, redirects = 0) {
  const url = officialUrl(value);
  if (redirects > 4) throw new Error('too many redirects');
  if (process.env.CLI_UPDATE_FAKE_FETCH !== undefined) {
    const map = JSON.parse(process.env.CLI_UPDATE_FAKE_FETCH);
    if (!Object.hasOwn(map, url.href)) throw new Error(`no fake response for ${url.href}`);
    const body = typeof map[url.href] === 'string' ? map[url.href] : JSON.stringify(map[url.href]);
    if (output) await fs.writeFile(output, body, { mode: 0o700 });
    return body;
  }
  const args = ['--disable', '--silent', '--show-error', '--proxy', proxy(), '--noproxy', '',
    '--proto', '=https', '--max-time', '20', '--write-out', '\n%{http_code}\n%{redirect_url}'];
  if (output) args.push('--output', output);
  args.push('--url', url.href);
  const response = succeeded(await runProbe('curl', args, { timeout: 20_000 }), 'download');
  const match = /\n(\d{3})\n([^\n]*)$/.exec(response);
  if (!match) throw new Error('invalid HTTP response');
  const status = Number(match[1]);
  if (status >= 300 && status < 400 && match[2]) {
    return fetchOfficial(new URL(match[2], url).href, output, redirects + 1);
  }
  if (status !== 200) throw new Error(`HTTP ${status} from ${url.hostname}`);
  return response.slice(0, match.index);
}

function manifestUrl() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  return arch && platform === 'linux' ? `${updater}/manifests/linux_${arch}.json` : null;
}

function agyDownload(value) {
  const url = officialUrl(value);
  const match = /^\/antigravity-public\/antigravity-cli\/([^/]+)\/linux-(x64|arm64)\/([^/]+)$/.exec(url.pathname);
  if (url.hostname !== 'storage.googleapis.com' || !match || match[2] !== process.arch) {
    throw new Error('expected an official Antigravity Linux download for this architecture');
  }
  const version = /^(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+$/.exec(match[1])?.[1];
  if (!version) throw new Error('download URL does not contain a release version and build');
  return { url: url.href, version, archive: url.pathname.endsWith('.tar.gz') };
}

async function latestVersions(refresh = false) {
  const file = path.join(conveyor(), 'cli-cache.json');
  if (!refresh) {
    try {
      const cached = await optionalJson(file);
      const age = Date.now() - Date.parse(cached?.checkedAt);
      if (age >= 0 && age < cacheLifetime && cached.codex && cached.agy) {
        if (cached.agy.latestUrl) agyDownload(cached.agy.latestUrl);
        return cached;
      }
    } catch { /* A corrupt or obsolete cache is replaced from official sources. */ }
  }
  const latest = { codex: { latest: null }, agy: { latest: null, latestUrl: null }, checkedAt: new Date().toISOString() };
  try {
    const data = JSON.parse(await fetchOfficial(registry));
    if (!versionPattern.test(data.version)) throw new Error('invalid npm version');
    latest.codex.latest = data.version;
  } catch (error) { latest.codex.reason = error.message; }
  try {
    const source = manifestUrl();
    if (!source) throw new Error('unknown source');
    const data = JSON.parse(await fetchOfficial(source));
    const download = agyDownload(data.url);
    if (!versionPattern.test(data.version) || download.version !== data.version || !/^[a-f0-9]{128}$/i.test(data.sha512)) {
      throw new Error('invalid Antigravity manifest');
    }
    latest.agy = { latest: data.version, latestUrl: download.url, sha512: data.sha512.toLowerCase() };
  } catch (error) { latest.agy.reason = error.message; }
  try {
    await fs.mkdir(conveyor(), { recursive: true, mode: 0o700 });
    await atomicWrite(file, `${JSON.stringify(latest, null, 2)}\n`);
  } catch (error) { process.stderr.write(`cli-update: cannot cache latest versions: ${error.message}\n`); }
  return latest;
}

async function codexCommand() {
  if (process.env.CLI_UPDATE_CODEX_CMD) return process.env.CLI_UPDATE_CODEX_CMD;
  const global = path.join(home(), '.npm-global', 'bin', 'codex');
  return await exists(global) ? global : 'codex';
}

async function codexVersion() {
  const text = succeeded(await runProbe(await codexCommand(), ['--version']), 'codex --version');
  const version = /^codex(?:-cli)?\s+(\S+)/m.exec(text)?.[1];
  if (!versionPattern.test(version)) throw new Error('cannot parse codex --version');
  return version;
}

async function expectedByHarness() {
  try {
    const text = await fs.readFile(path.join(home(), 'dev', 'gpt-harness', 'install.mjs'), 'utf8');
    return /@openai\/codex@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1] || null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function newer(latest, installed) {
  if (!latest || !installed || latest === installed) return false;
  const [left, lp] = latest.split('+')[0].split('-'), [right, rp] = installed.split('+')[0].split('-');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  if (!lp || !rp) return Boolean(rp) && !lp;
  const ap = lp.split('.'), bp = rp.split('.');
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    if (ap[index] === bp[index]) continue;
    if (ap[index] === undefined || bp[index] === undefined) return bp[index] === undefined;
    const an = /^\d+$/.test(ap[index]), bn = /^\d+$/.test(bp[index]);
    return an && bn ? Number(ap[index]) > Number(bp[index]) : an !== bn ? !an : ap[index] > bp[index];
  }
  return false;
}

function daemonJobs(stdout) {
  const [first, ...lines] = stdout.trim().split(/\r?\n/), health = JSON.parse(first);
  if (health.ok !== true && health.ok !== false) throw new Error('invalid daemon health');
  if (!health.ok) return { health, jobs: [] };
  if (!lines[0]?.startsWith('id\tstate\t')) throw new Error('daemon job table missing');
  const jobs = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('owner\trunning\tqueued')) break;
    const [id, state] = line.split('\t');
    if (['running', 'queued', 'starting'].includes(state)) jobs.push({ id, state });
  }
  return { health, jobs };
}

async function codexBusy() {
  let jobs = 0;
  const reasons = [];
  try {
    if (platform !== 'linux') throw new Error('Codex update process inspection unavailable');
    const script = path.join(home(), '.claude', 'scripts', 'luna-daemon.mjs');
    if (await exists(script)) {
      for (const profile of ['default', 'net']) {
        const response = await runProbe(process.execPath, [script, '--status', '--profile', profile]);
        const parsed = daemonJobs(response.stdout);
        jobs += parsed.jobs.length;
        if (parsed.jobs.length) reasons.push(`${profile} daemon has running or queued jobs`);
        if (parsed.health.ok && response.code !== 0) throw new Error('daemon status failed');
        if (!parsed.health.ok) {
          const base = process.env.LUNA_DAEMON_HOME || runDir();
          const info = await optionalJson(path.join(base, profile === 'net' ? 'daemon-net' : '', 'daemon.json'));
          if (info?.pid) {
            try { process.kill(info.pid, 0); throw new Error('live daemon status unavailable'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }
      }
    } else if (await exists(path.join(runDir(), 'daemon.json')) || await exists(path.join(runDir(), 'daemon-net/daemon.json'))) {
      throw new Error('daemon script missing while discovery exists');
    }
    const rows = new Map(listProcesses({ argv: true }).map((row) => [row.pid, row]));
    for (const row of rows.values()) {
      if (row.state === 'Z' || !/^codex(?:\.exe)?$/.test(path.basename(row.argv[0] || '')) || !row.argv.includes('exec')) continue;
      let parent = rows.get(row.ppid);
      for (let depth = 0; parent && depth < 64; depth++, parent = rows.get(parent.ppid)) {
        if (parent.argv.some((arg) => path.basename(arg) === 'luna.sh')) {
          jobs++;
          reasons.push(`codex exec from luna.sh (pid ${row.pid})`);
          break;
        }
      }
    }
  } catch (error) { reasons.push(`cannot establish idle state: ${error.message}`); }
  return { jobs, reason: reasons.length ? reasons.join('; ') : null };
}

async function agyBusy() {
  let jobs = 0;
  const reasons = [];
  try {
    const active = path.join(runDir(), 'gem-active');
    const files = await fs.readdir(active).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of files.filter((entry) => entry.endsWith('.json'))) {
      const entry = await optionalJson(path.join(active, name));
      // Pointers represent admitted work, including the interval before an ACP child has a PID.
      if (entry) { jobs++; reasons.push(`gem job ${entry.id || name}`); }
    }
    const status = await optionalJson(path.join(agyDir(), 'data', 'status.json'));
    if (status !== null) {
      if (!Number.isSafeInteger(status.active_items) || status.active_items < 0) throw new Error('invalid MCP active_items');
      jobs += status.active_items;
      if (status.active_items) reasons.push(`${status.active_items} active MCP items`);
    }
  } catch (error) { reasons.push(`cannot establish idle state: ${error.message}`); }
  return { jobs, reason: reasons.length ? reasons.join('; ') : null };
}

function idle(busy) {
  if (busy.jobs || busy.reason) throw new Failure(busy.reason || 'executor is busy', 3, { busy });
}

function agyEnvironment() {
  const uid = process.getuid?.() ?? 1000;
  const env = { ...process.env, HOME: path.join(agyDir(), 'data', 'home'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`, XDG_RUNTIME_DIR: `/run/user/${uid}`,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true', AGY_CLI_MODEL_API_MAX_RETRIES: '1',
    HTTP_PROXY: 'http://127.0.0.1:10809', HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: 'localhost,127.0.0.1,::1' };
  for (const key of ['SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY']) delete env[key];
  return env;
}

async function agyVersion(sha256) {
  const release = await optionalJson(path.join(agyDir(), 'config', 'cli-release.json'));
  if (release?.installed_sha256 === sha256 && versionPattern.test(release.version)) return release.version;
  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cli-update', version: '1.0' } } })}\n`;
  let version = null;
  const response = await runProbe(path.join(agyDir(), 'run-agy'), ['acp'], {
    env: agyEnvironment(), input,
    stopWhen(text) {
      for (const line of text.split('\n').slice(0, -1)) {
        try {
          const result = JSON.parse(line);
          if (result.id === 1) { version = result.result?.agentInfo?.version; return true; }
        } catch { /* ACP notifications may precede the initialize response. */ }
      }
      return false;
    }
  });
  succeeded(response, 'agy ACP initialize');
  if (!versionPattern.test(version)) throw new Error('cannot parse agy ACP version');
  return version;
}

async function previousCopies() {
  const bin = path.join(agyDir(), 'bin');
  const names = await fs.readdir(bin).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const entries = [];
  for (const name of names.filter((entry) => /^agy\.prev-[a-f0-9]{12}$/.test(entry))) {
    const file = path.join(bin, name), stat = await fs.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, modified: stat.mtimeMs });
  }
  return entries.sort((left, right) => right.modified - left.modified || left.file.localeCompare(right.file));
}

async function agyStatus(latest) {
  const status = { installed: null, sha256: null, pinnedSha256: null, checksumOk: false,
    latest: latest.latest, latestUrl: latest.latestUrl, updateAvailable: false,
    busy: await agyBusy(), rollbackAvailable: false };
  if (latest.reason) status.reason = latest.reason;
  try {
    const settings = await optionalJson(path.join(agyDir(), 'config', 'settings.json'));
    status.pinnedSha256 = settings?.agy_sha256 || null;
    status.sha256 = await hashFile(path.join(agyDir(), 'bin', 'agy'));
    status.checksumOk = status.sha256 === status.pinnedSha256;
    status.installed = await agyVersion(status.sha256);
    status.rollbackAvailable = (await previousCopies()).length > 0;
  } catch (error) { status.reason = [status.reason, error.message].filter(Boolean).join('; '); }
  status.updateAvailable = newer(status.latest, status.installed);
  return status;
}

async function status(refresh) {
  const latest = await latestVersions(refresh);
  const codex = { installed: null, latest: latest.codex.latest, expectedByHarness: await expectedByHarness(),
    updateAvailable: false, busy: await codexBusy() };
  if (latest.codex.reason) codex.reason = latest.codex.reason;
  try { codex.installed = await codexVersion(); }
  catch (error) { codex.reason = [codex.reason, error.message].filter(Boolean).join('; '); }
  codex.updateAvailable = newer(codex.latest, codex.installed);
  return { codex, agy: await agyStatus(latest.agy), checkedAt: latest.checkedAt };
}

async function withLock(action) {
  await fs.mkdir(conveyor(), { recursive: true, mode: 0o700 });
  const file = path.join(conveyor(), 'cli-update.lock');
  let lock;
  try { lock = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Failure('another CLI update holds the update lock', 3);
    throw error;
  }
  try { await lock.writeFile(`${process.pid}\n`); return await action(); }
  finally { await lock.close(); await fs.rm(file, { force: true }); }
}

async function updateCodex(opts) {
  const requested = opts['--version'] || 'latest';
  if (requested !== 'latest' && !versionPattern.test(requested)) throw new Error('invalid Codex version');
  const from = await codexVersion(), expected = await expectedByHarness();
  const note = (to) => expected && to !== expected ? `expectedByHarness=${expected}; update install.mjs and commit` : null;
  if (!opts['--confirm']) return { ok: true, dryRun: true, from, to: requested,
    command: [process.env.CLI_UPDATE_NPM_CMD || 'npm', 'i', '-g', `@openai/codex@${requested}`], note: note(requested) };
  idle(await codexBusy());
  return withLock(async () => {
    const to = requested === 'latest' ? (await latestVersions(true)).codex.latest : requested;
    if (!to) throw new Error('cannot resolve latest Codex version');
    idle(await codexBusy());
    const env = { ...process.env, npm_config_prefix: path.join(home(), '.npm-global'),
      npm_config_registry: 'https://registry.npmjs.org', npm_config_proxy: proxy(), npm_config_https_proxy: proxy(),
      npm_config_fetch_retries: '0', npm_config_fetch_timeout: '60000' };
    const install = async (version) => succeeded(await run(process.env.CLI_UPDATE_NPM_CMD || 'npm',
      ['i', '-g', `@openai/codex@${version}`], { timeout: 60_000, env }), 'npm install');
    try {
      await install(requested);
      const actual = await codexVersion();
      if (actual !== to) throw new Error(`Codex version mismatch: expected ${to}, got ${actual}`);
      return { ok: true, from, to, note: note(to) };
    } catch (error) {
      let restored = false, rollbackReason = null;
      try { await install(from); restored = await codexVersion() === from; }
      catch (rollbackError) { rollbackReason = rollbackError.message; }
      throw new Failure(error.message, 1, { from, to, restored, rollbackReason, note: note(to) });
    }
  });
}

async function smoke(file, wrapper = false) {
  const text = succeeded(await run(file, ['models'], { timeout: 60_000, env: agyEnvironment() }),
    wrapper ? 'run-agy models' : 'candidate models');
  if (!/\bgemini-[A-Za-z0-9][A-Za-z0-9._-]*\b/.test(text)) throw new Error('smoke did not list a gemini- model');
}

async function stagingDirectory() {
  const staging = path.join(agyDir(), '.staging');
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(staging);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('staging must be a real directory');
  await fs.chmod(staging, 0o700);
  return staging;
}

async function stageCandidate(download, candidate, checksum) {
  const archive = `${candidate}.download`;
  const file = download.archive ? archive : candidate;
  const handle = await fs.open(file, 'wx', 0o700);
  await handle.close();
  try {
    await fetchOfficial(download.url, file);
    if (checksum && await hashFile(file, 'sha512') !== checksum) throw new Error('archive sha512 mismatch');
    if (download.archive) {
      const listing = succeeded(await run('tar', ['-tzf', archive], { timeout: 60_000 }), 'list release archive');
      const members = listing.trim().split('\n').filter((name) =>
        !name.split('/').includes('..') && !name.startsWith('/') &&
        ['agy', 'cli', `cli_linux_${process.arch}`].includes(path.posix.basename(name)));
      if (members.length !== 1) throw new Error('release archive must contain exactly one CLI binary');
      const target = await fs.open(candidate, 'wx', 0o700);
      try {
        succeeded(await run('tar', ['-xOzf', archive, '--', members[0]], { timeout: 60_000, stdoutFd: target.fd }),
          'extract release binary');
      } finally { await target.close(); }
    }
    await fs.chmod(candidate, 0o700);
  } finally { if (download.archive) await fs.rm(archive, { force: true }); }
}

async function settingsSnapshot() {
  const file = path.join(agyDir(), 'config', 'settings.json');
  const text = await fs.readFile(file, 'utf8'), settings = JSON.parse(text);
  const bin = path.join(agyDir(), 'bin', 'agy'), stat = await fs.lstat(bin);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('installed agy must be a regular file');
  if (settings.agy_bin && path.resolve(settings.agy_bin) !== bin) throw new Error('settings agy_bin points elsewhere');
  const sha256 = await hashFile(bin);
  if (settings.agy_sha256 !== sha256) throw new Error('installed agy checksum does not match settings');
  const mode = (await fs.stat(file)).mode & 0o777;
  return { file, text, settings, bin, sha256, mode };
}

function settingsWithSha(snapshot, sha256) {
  let count = 0;
  const text = snapshot.text.replace(/("agy_sha256"\s*:\s*")[a-f0-9]{64}("\s*[,}])/gi, (_match, before, after) => {
    count++;
    return `${before}${sha256}${after}`;
  });
  if (count !== 1 || JSON.parse(text).agy_sha256 !== sha256) throw new Error('cannot preserve settings checksum formatting');
  return text;
}

async function keepPrevious(snapshot) {
  const previous = `${snapshot.bin}.prev-${snapshot.sha256.slice(0, 12)}`;
  try { await fs.copyFile(snapshot.bin, previous, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await hashFile(previous) !== snapshot.sha256) throw new Error('previous copy checksum mismatch');
  await fs.chmod(previous, 0o700);
  // Reusing a hash-named copy still makes it the newest rollback target.
  const now = new Date();
  await fs.utimes(previous, now, now);
  return previous;
}

async function installAgy(candidate, snapshot) {
  const sha256 = await hashFile(candidate), settings = settingsWithSha(snapshot, sha256);
  idle(await agyBusy());
  if (await hashFile(snapshot.bin) !== snapshot.sha256 || await fs.readFile(snapshot.file, 'utf8') !== snapshot.text) {
    throw new Error('installed agy or settings changed during staging');
  }
  const previous = await keepPrevious(snapshot);
  let replaced = false;
  try {
    await fs.rename(candidate, snapshot.bin);
    replaced = true;
    await atomicWrite(snapshot.file, settings, snapshot.mode);
    await smoke(path.join(agyDir(), 'run-agy'), true);
    if (await hashFile(snapshot.bin) !== sha256) throw new Error('installed binary changed during smoke');
    return { ok: true, from: snapshot.sha256, to: sha256, previous };
  } catch (error) {
    let restored = !replaced, rollbackReason = null;
    if (replaced) {
      const restore = `${snapshot.bin}.${randomUUID()}.restore`;
      try {
        await fs.copyFile(previous, restore, constants.COPYFILE_EXCL);
        await fs.rename(restore, snapshot.bin);
        await atomicWrite(snapshot.file, snapshot.text, snapshot.mode);
        await smoke(path.join(agyDir(), 'run-agy'), true);
        restored = await hashFile(snapshot.bin) === snapshot.sha256;
      } catch (restoreError) { rollbackReason = restoreError.message; }
      finally { await fs.rm(restore, { force: true }); }
    }
    throw new Failure(error.message, 1, { from: snapshot.sha256, to: sha256, restored, rollbackReason });
  }
}

async function updateAgy(opts, rollback = false) {
  if (platform !== 'linux') throw new Error('agy updates and rollbacks are supported only on Linux');
  const explicit = opts['--url'] ? agyDownload(opts['--url']) : null;
  if (!opts['--confirm']) return { ok: true, dryRun: true, action: rollback ? 'rollback agy to newest agy.prev-*'
    : 'download, smoke, back up, replace agy and update agy_sha256', url: explicit?.url || null };
  idle(await agyBusy());
  return withLock(async () => {
    const snapshot = await settingsSnapshot();
    let download = explicit, checksum = null, previous = null;
    if (rollback) {
      previous = (await previousCopies())[0]?.file;
      if (!previous) throw new Error('no agy.prev-* rollback copy available');
      const sha = await hashFile(previous);
      if (!previous.endsWith(sha.slice(0, 12))) throw new Error('rollback copy checksum does not match its name');
    } else if (!download) {
      const latest = (await latestVersions(true)).agy;
      if (!latest.latestUrl) throw new Error(latest.reason || 'unknown source');
      download = agyDownload(latest.latestUrl);
      checksum = latest.sha512;
    }
    const staging = await stagingDirectory();
    const candidate = path.join(staging, `agy-${rollback ? 'rollback' : download.version}`);
    let ownsCandidate = false;
    try {
      if (await exists(candidate)) throw new Error('staging candidate already exists; inspect it before retrying');
      ownsCandidate = true;
      if (rollback) await fs.copyFile(previous, candidate, constants.COPYFILE_EXCL);
      else await stageCandidate(download, candidate, checksum);
      await fs.chmod(candidate, 0o700);
      await smoke(candidate);
      return await installAgy(candidate, snapshot);
    } finally { if (ownsCandidate) await fs.rm(candidate, { force: true }); }
  });
}

function options(args, allowed) {
  const opts = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!Object.hasOwn(allowed, key) || Object.hasOwn(opts, key)) throw new Error(`unknown or duplicate option: ${key}`);
    if (allowed[key]) {
      if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error(`${key} requires a value`);
      opts[key] = args[++index];
    } else opts[key] = true;
  }
  return opts;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  try {
    if (command === 'status') {
      const opts = options(rest, { '--json': false, '--refresh': false });
      print(await status(opts['--refresh']));
    } else if (command === 'update' && ['codex', 'agy'].includes(rest[0])) {
      const [provider, ...flags] = rest;
      const opts = options(flags, { '--confirm': false, [provider === 'codex' ? '--version' : '--url']: true });
      print(await (provider === 'codex' ? updateCodex(opts) : updateAgy(opts)));
    } else if (command === 'rollback' && rest[0] === 'agy') {
      print(await updateAgy(options(rest.slice(1), { '--confirm': false }), true));
    } else throw new Error('usage: cli-update.mjs status [--json] [--refresh] | update codex|agy | rollback agy');
    return 0;
  } catch (error) {
    print({ ok: false, reason: error.message, ...error.details });
    return error instanceof Failure ? error.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startMaintenanceWatchdog();
  process.exitCode = await main();
}
