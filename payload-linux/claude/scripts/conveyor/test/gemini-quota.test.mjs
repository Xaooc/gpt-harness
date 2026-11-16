import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGeminiQuota, parseStatuslineQuota } from '../gemini-quota.mjs';

const cli = fileURLToPath(new URL('../gemini-quota.mjs', import.meta.url));
const timeout = 600_000;
const run = promisify(execFile);

// Quota-only sample captured from agy 1.5.9's official statusLine stdin on this host.
const sample = {
  quota: {
    '3p-5h': { remaining_fraction: 1, reset_time: '2026-11-16T20:33:52Z', reset_in_seconds: 17999 },
    '3p-weekly': { remaining_fraction: 1, reset_time: '2026-11-23T15:33:52Z', reset_in_seconds: 604799 },
    'gemini-5h': { remaining_fraction: 0.8944898, reset_time: '2026-11-16T17:07:42Z', reset_in_seconds: 5629 },
    'gemini-weekly': { remaining_fraction: 0.8209774, reset_time: '2026-11-22T16:20:29Z', reset_in_seconds: 521196 }
  },
  agent_state: 'initializing',
  context_window: { used_percentage: 99, remaining_percentage: 1 }
};

function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'gemini-quota-test-'));
  t.after(async () => {
    for (const name of ['parent.pid', 'descendant.pid']) {
      const pid = Number(await fs.readFile(path.join(root, name), 'utf8').catch(() => ''));
      if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const fake = path.join(root, "fake agy's cli.mjs");
  await fs.writeFile(fake, [
    "import * as fs from 'node:fs';",
    "import path from 'node:path';",
    "import { spawn } from 'node:child_process';",
    'const root = process.argv[2];',
    "const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));",
    "fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(process.argv.slice(3)) + '\\n');",
    "fs.writeFileSync(path.join(root, 'parent.pid'), String(process.pid));",
    "fs.writeFileSync(path.join(root, 'environment.json'), JSON.stringify({",
    "  home: process.env.HOME, ssh: Object.keys(process.env).some((key) => key.startsWith('SSH_')),",
    '  dbus: process.env.DBUS_SESSION_BUS_ADDRESS, runtime: process.env.XDG_RUNTIME_DIR,',
    '  http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY',
    '}));',
    "if (config.mode === 'exit') process.exit(7);",
    "if (config.mode === 'hang') {",
    "  process.on('SIGTERM', () => {});",
    "  spawn(process.execPath, ['-e', [",
    "    \"process.on('SIGTERM', () => {});\",",
    "    \"require('node:fs').writeFileSync(process.argv[1], String(process.pid));\",",
    "    'setInterval(() => {}, 1000);'",
    "  ].join(''), path.join(root, 'descendant.pid')], { detached: true, stdio: 'ignore' });",
    '} else {',
    "  const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);",
    '  for (const payload of [{ quota: {} }, config.payload, { quota: {} }]) {',
    "    const hook = spawn('/bin/sh', ['-c', settings.statusLine.command], { stdio: ['pipe', 'ignore', 'ignore'] });",
    '    hook.stdin.end(JSON.stringify(payload));',
    "    await new Promise((resolve) => hook.once('exit', resolve));",
    '  }',
    '}',
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  const home = path.join(root, 'conveyor');
  const configFile = path.join(root, 'config.json');
  const configure = (value) => fs.writeFile(configFile, JSON.stringify({ mode: 'quota', payload: sample, ...value }));
  await configure({});
  const env = { ...process.env, HOME: root, CONVEYOR_HOME: home, LUNA_RUN_DIR: path.join(root, 'run'),
    SSH_CLIENT: 'test', SSH_CONNECTION: 'test', SSH_TTY: 'test',
    GEMINI_QUOTA_AGY_CMD: JSON.stringify([process.execPath, fake, root]) };
  return { root, home, env, configure, cache: path.join(home, 'gemini-quota.json'),
    read: async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8')),
    calls: async () => (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('parses the live status-line quota format without using context-window percentages', { timeout }, () => {
  const now = Date.parse('2026-11-16T15:33:53Z');
  const result = parseStatuslineQuota(sample, now);
  assert.equal(result.available, true);
  assert.equal(result.source, 'agy-statusline');
  assert.equal(result.at, '2026-11-16T15:33:53.000Z');
  assert.deepEqual(result.buckets, [
    { name: '3p-5h', remainingFraction: 1, resetAt: '2026-11-16T20:33:52.000Z' },
    { name: '3p-weekly', remainingFraction: 1, resetAt: '2026-11-23T15:33:52.000Z' },
    { name: 'gemini-5h', remainingFraction: 0.8944898, resetAt: '2026-11-16T17:07:42.000Z' },
    { name: 'gemini-weekly', remainingFraction: 0.8209774, resetAt: '2026-11-22T16:20:29.000Z' }
  ]);
  assert.equal(parseStatuslineQuota({ used: 50, size: 100, context_window: { used_percentage: 50 } }).available, false);
});

test('accepts exhausted buckets, rejects invalid fractions and counts, and validates resets', { timeout }, () => {
  const now = Date.parse('2026-11-16T15:00:00Z');
  const result = parseStatuslineQuota({ quota: {
    exhausted: { remaining_fraction: 0, reset_time: 'invalid', reset_in_seconds: 60 },
    missingReset: { remaining_fraction: 0.5 },
    disabled: { remaining_fraction: 1, disabled: true },
    amountOnly: { remaining_amount: 30 },
    negative: { remaining_fraction: -0.1 },
    overflow: { remaining_fraction: 1.1 },
    string: { remaining_fraction: '0.5' },
    infinite: { remaining_fraction: Infinity },
    null: null
  } }, now);
  assert.deepEqual(result.buckets, [
    { name: 'exhausted', remainingFraction: 0, resetAt: '2026-11-16T15:01:00.000Z' },
    { name: 'missingReset', remainingFraction: 0.5 }
  ]);
  assert.equal(parseStatuslineQuota(null).available, false);
});

test('runs the hook through fake agy, caches for ten minutes, and refreshes on request or expiry', { timeout }, async (t) => {
  const f = await fixture(t);
  const first = await getGeminiQuota({ env: f.env, refresh: true });
  assert.equal(first.available, true, JSON.stringify(first));
  assert.equal(first.buckets[2].remainingFraction, 0.8944898);
  assert.deepEqual(JSON.parse(await fs.readFile(f.cache, 'utf8')), first);
  assert.deepEqual(await getGeminiQuota({ env: f.env }), first);
  assert.equal((await f.calls()).length, 1);
  assert.deepEqual(await f.read('environment.json'), {
    home: '/srv/docker/compose/antigravity-parallel/data/home', ssh: false,
    dbus: 'unix:path=/run/user/1000/bus', runtime: '/run/user/1000',
    http: 'http://127.0.0.1:10809', https: 'http://127.0.0.1:10809', noProxy: 'localhost,127.0.0.1,::1'
  });
  const args = (await f.calls())[0];
  assert.equal(args[0], '--settings');
  assert.equal(args.length, 2, 'quota collection must not submit a model prompt');
  const changed = structuredClone(sample);
  changed.quota['gemini-5h'].remaining_fraction = 0.5;
  await f.configure({ payload: changed });
  const refreshed = await getGeminiQuota({ env: f.env, refresh: true });
  assert.equal(refreshed.buckets[2].remainingFraction, 0.5);
  assert.equal((await f.calls()).length, 2);
  await fs.writeFile(f.cache, JSON.stringify({ ...refreshed, at: new Date(Date.now() - 600_001).toISOString() }));
  assert.equal((await getGeminiQuota({ env: f.env })).available, true);
  assert.equal((await f.calls()).length, 3);
  const pid = Number(await fs.readFile(path.join(f.root, 'parent.pid'), 'utf8'));
  assert.equal(alive(pid), false, 'successful reads must also stop agy');
});

test('ignores corrupt and future-dated caches and supports the JSON CLI', { timeout }, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.home);
  await fs.writeFile(f.cache, '{invalid');
  assert.equal((await getGeminiQuota({ env: f.env })).available, true);
  const cached = JSON.parse(await fs.readFile(f.cache, 'utf8'));
  await fs.writeFile(f.cache, JSON.stringify({ ...cached, at: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal((await getGeminiQuota({ env: f.env })).available, true);
  const { stdout, stderr } = await run(process.execPath, [cli, '--json', '--refresh'], { env: f.env, timeout });
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(stdout).available, true);
  assert.equal((await f.calls()).length, 3);
});

test('unavailable results expose exhaustion timestamps and keep the proxy fresh on cache hits', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.configure({ mode: 'exit' });
  await fs.mkdir(path.join(f.root, '.claude', 'learning'), { recursive: true });
  const now = Date.now();
  const older = new Date(now - 120_000).toISOString();
  const latest = new Date(now - 60_000).toISOString();
  const records = [];
  for (const [name, provider, reason, finished] of [
    ['old', 'gemini', 'quota', older], ['latest', 'gemini', 'quota', latest],
    ['codex', 'codex', 'quota', new Date(now).toISOString()], ['auth', 'gemini', 'auth', new Date(now).toISOString()]
  ]) {
    const out = path.join(f.root, name);
    records.push({ out });
    await fs.writeFile(`${out}.status`, `provider=${provider}\nunavailable_reason=${reason}\nfinished=${finished}\n`);
  }
  await fs.writeFile(path.join(f.root, '.claude', 'learning', 'jobs.jsonl'), records.map(JSON.stringify).join('\n'));
  await fs.mkdir(f.home);
  const cooldownUntil = new Date(now + 600_000).toISOString();
  await fs.writeFile(path.join(f.home, 'providers.json'), JSON.stringify({ gemini: { reason: 'quota', until: cooldownUntil } }));
  const result = await getGeminiQuota({ env: f.env });
  assert.equal(result.available, false);
  assert.deepEqual(result.buckets, []);
  assert.match(result.reason, /exited before supplying quota.*exit 7/);
  assert.deepEqual(result.proxy, { source: 'gem-job-statuses', lastExhaustedAt: latest, cooldownUntil });
  const newest = new Date(now - 1000).toISOString();
  await fs.writeFile(path.join(f.root, 'latest.status'), `provider=gemini\nunavailable_reason=quota\nfinished=${newest}\n`);
  assert.equal((await getGeminiQuota({ env: f.env })).proxy.lastExhaustedAt, newest);
  assert.equal((await f.calls()).length, 1, 'negative results are cached too');
});

test('times out and kills agy plus a detached descendant that ignores SIGTERM', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.configure({ mode: 'hang' });
  const started = performance.now();
  const result = await getGeminiQuota({ env: f.env, timeoutMs: 4000 });
  assert.ok(performance.now() - started < 4000, 'the timeout must include tree cleanup');
  assert.equal(result.available, false);
  assert.match(result.reason, /timed out.*4000 ms/);
  assert.deepEqual(result.proxy, { source: 'gem-job-statuses', lastExhaustedAt: null });
  for (const name of ['parent.pid', 'descendant.pid']) {
    const pid = Number(await fs.readFile(path.join(f.root, name), 'utf8'));
    assert.equal(alive(pid), false, `${name} survived quota reader cleanup`);
  }
});
