// Offline regressions for hooks, PID consumers and curl authentication; no network or Codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcess } from './luna-runtime.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxy = ['http:', '', '127.0.0.1:3128'].join('/');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collect = (child) => new Promise((resolve, reject) => {
  child.stdin?.end();
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
const run = (program, args, env = process.env) => collect(spawn(program, args, { env }));
const fixture = async (fn) => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-fix2-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const status = (out, values) => writeFileSync(`${out}.status`,
  Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
const daemonMarker = (out, values = {}) => writeFileSync(`${out}.daemon`,
  Object.entries({ state: 'running', id: 'fixture', daemon_pid: process.pid,
    daemon_start: readProcess(process.pid).started, ...values })
    .map(([key, value]) => `${key}=${value}\n`).join(''));

await test('watch uses the daemon wrapper identity and waits through running orphan markers', async () => {
  await fixture(async (root) => {
    const out = path.join(root, 'job with spaces.md');
    status(out, { state: 'running', engine: 'daemon', pid: process.pid,
      pid_start: readProcess(process.pid).started, daemon_job: 'fixture',
      wrapper_pid: 2147483647, wrapper_start: '1' });
    daemonMarker(out);
    const watcher = spawn('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', out]);
    const result = collect(watcher);
    try {
      await delay(500);
      assert.equal(watcher.exitCode, null);
      writeFileSync(`${out}.daemon`, 'state=completed\n');
      const watched = await result;
      assert.equal(watched.code, 0); assert.match(watched.stdout, /^GONE /m);
    } finally { if (watcher.exitCode === null) watcher.kill(); }
  });
});

await test('watch treats pre-boot starts as conclusive even with a live wrapper and running marker', async () => {
  await fixture(async (root) => {
    const boot = Math.floor(Date.now() / 1000) - 1800;
    writeFileSync(path.join(root, 'node'), `#!${process.execPath}
const cp = require('child_process'), args = process.argv.slice(2);
if (args[0] === '-e' && args[1].includes('require("os").uptime()')) {
  process.stdout.write(process.env.FIXTURE_BOOT_EPOCH);
} else {
  const result = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
    chmodSync(path.join(root, 'node'), 0o755);
    const ended = path.join(root, 'terminal during grace.md'), gone = path.join(root, 'pre boot job.md');
    for (const out of [ended, gone]) {
      status(out, { state: 'running', engine: 'daemon', pid: process.pid,
        pid_start: readProcess(process.pid).started, daemon_job: 'fixture', wrapper_pid: process.pid,
        wrapper_start: readProcess(process.pid).started, started: new Date((boot - 60) * 1000).toISOString() });
      daemonMarker(out);
    }
    const watcher = spawn('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', ended, gone],
      { env: { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`,
        FIXTURE_BOOT_EPOCH: String(boot) }, timeout: 12_000 });
    const result = collect(watcher);
    try {
      await delay(1000);
      assert.equal(watcher.exitCode, null, 'watch preserves the final-status grace period');
      status(ended, { state: 'done', rc: 0 });
      const watched = await result;
      assert.equal(watched.code, 0, watched.stderr);
      assert.ok(watched.stdout.includes(`END ${ended} state=done rc=0`));
      assert.ok(watched.stdout.includes(`GONE ${gone} state=running but started before last boot`));
      assert.equal(watched.stdout.trim().split('\n').length, 2);
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
      await result;
    }
  });
});

await test('watch rejects missing, dead, reused and mismatched daemon marker identities', async () => {
  await fixture(async (root) => {
    const cases = [
      { daemon_start: '' }, { daemon_pid: 2147483647 }, { daemon_start: 'reused' }, { id: 'other-job' }
    ];
    const outputs = cases.map((values, i) => {
      const out = path.join(root, `stale marker ${i}.md`);
      status(out, { state: 'running', engine: 'daemon', pid: process.pid,
        pid_start: readProcess(process.pid).started, daemon_job: 'fixture',
        wrapper_pid: 2147483647, wrapper_start: '1' });
      daemonMarker(out, values);
      return out;
    });
    // Even matching marker/status identities cannot make a dead or reused process current.
    for (const [pid, started] of [[2147483647, '1'], [process.pid, 'reused']]) {
      const out = path.join(root, `not live ${pid}.md`);
      status(out, { state: 'running', engine: 'daemon', pid, pid_start: started, daemon_job: 'fixture',
        wrapper_pid: 2147483647, wrapper_start: '1' });
      daemonMarker(out, { daemon_pid: pid, daemon_start: started });
      outputs.push(out);
    }
    const watched = await collect(spawn('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', ...outputs],
      { env: { ...process.env, HOME: root }, timeout: 25_000 }));
    assert.equal(watched.code, 0, watched.stderr);
    assert.equal(watched.stdout.trim().split('\n').length, outputs.length);
    for (const out of outputs) assert.ok(watched.stdout.includes(`GONE ${out} `));
  });
});

await test('watch matches the recorded daemon profile before trusting an orphan marker', async () => {
  await fixture(async (root) => {
    const out = path.join(root, 'net-job.md');
    const identity = readProcess(process.pid).started;
    status(out, { state: 'running', engine: 'daemon', daemon_profile: 'net', pid: process.pid,
      pid_start: identity, daemon_job: 'fixture', wrapper_pid: 2147483647, wrapper_start: '1' });
    daemonMarker(out, { daemon_profile: 'net' });
    const watcher = spawn('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', out],
      { env: { ...process.env, HOME: root }, timeout: 10_000 });
    const result = collect(watcher);
    try {
      await delay(500);
      assert.equal(watcher.exitCode, null);
      daemonMarker(out, { daemon_profile: 'default' });
      const watched = await result;
      assert.equal(watched.code, 0, watched.stderr);
      assert.match(watched.stdout, /^GONE /m);
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
      await result;
    }
  });
});

await test('stop rejects a reused wrapper and child PID even with an owned command line', async () => {
  await fixture(async (root) => {
    const script = path.join(root, 'luna-fixture.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => child.once('spawn', resolve));
    try {
      const out = path.join(root, 'job.md');
      status(out, { state: 'running', engine: 'exec', pid: child.pid, pid_start: 'reused',
        wrapper_pid: child.pid, wrapper_start: 'reused' });
      const result = await run('bash', [path.join(scripts, 'luna-stop.sh'), out]);
      assert.equal(result.code, 1);
      assert.ok(readProcess(child.pid));
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

await test('exec watch rejects a reused PID and reattached daemon wrappers still reach END', async () => {
  await fixture(async (root) => {
    const out = path.join(root, 'job.md');
    status(out, { state: 'running', engine: 'exec', pid: process.pid, pid_start: 'reused' });
    const gone = await run('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', out]);
    assert.match(gone.stdout, /^GONE /m);
    status(out, { state: 'running', engine: 'daemon', wrapper_pid: process.pid,
      wrapper_start: readProcess(process.pid).started });
    writeFileSync(`${out}.daemon`, 'state=completed\n');
    const watcher = spawn('bash', [path.join(scripts, 'luna-watch.sh'), '-p', '0.05', out]);
    const result = collect(watcher);
    try {
      await delay(500);
      assert.equal(watcher.exitCode, null);
      status(out, { state: 'done', rc: 0 });
      const ended = await result;
      assert.match(ended.stdout, /^END /m); assert.doesNotMatch(ended.stdout, /^GONE /m);
    } finally { if (watcher.exitCode === null) watcher.kill(); }
  });
});

await test('idle swap ignores a reused active-index PID', async () => {
  await fixture(async (root) => {
    const active = path.join(root, '.claude/luna-run/active');
    mkdirSync(active, { recursive: true });
    const out = path.join(root, 'job with spaces.md');
    status(out, { state: 'running', started: new Date().toISOString() });
    writeFileSync(path.join(active, 'fixture'), `${out}\n${process.pid}\nreused\n`);
    const next = path.join(root, 'next.sh'), live = path.join(root, 'live.sh');
    writeFileSync(next, '#!/bin/bash\nexit 0\n');
    const result = await run('bash', [path.join(scripts, 'luna-swap-when-idle.sh'), next, live],
      { ...process.env, HOME: root });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(live, 'utf8'), '#!/bin/bash\nexit 0\n');
  });
});

await test('curl keeps token out of argv while preserving request body on fd 3', async () => {
  await fixture(async (root) => {
    const curl = path.join(root, 'curl');
    writeFileSync(curl, '#!/usr/bin/node\n' +
      'const fs=require("fs"); fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({\n' +
      'args:process.argv.slice(2), config:fs.readFileSync(0,"utf8"), body:fs.readFileSync(3,"utf8")}));\n');
    chmodSync(curl, 0o755);
    const token = 'ab'.repeat(16);
    const result = await run('bash', ['-c', '. "$1/lib/luna-runtime.sh"; ' +
      'printf \'{"prompt":"with spaces"}\' | luna_daemon_curl "$FIXTURE_TOKEN" ' +
      '--data-binary @/dev/fd/3 "$FIXTURE_URL"', '_', scripts],
    { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE_TOKEN: token, FIXTURE_URL: proxy + '/jobs',
      FIXTURE_CAPTURE: path.join(root, 'capture') });
    assert.equal(result.code, 0, result.stderr);
    const capture = JSON.parse(readFileSync(path.join(root, 'capture'), 'utf8'));
    assert.ok(!JSON.stringify(capture.args).includes(token));
    assert.deepEqual(capture.args.slice(0, 2), ['--config', '-']);
    assert.equal(capture.config, `header = "X-Luna-Token: ${token}"\n`);
    assert.equal(capture.body, '{"prompt":"with spaces"}');
  });
});

await test('TERM during discovery still cancels the submitted job with its original token', async () => {
  await fixture(async (root) => {
    const out = path.join(root, 'job with spaces.md');
    const capture = path.join(root, 'cancel'), blocked = path.join(root, 'discovery-blocked');
    const token = 'cd'.repeat(16), id = 'ef'.repeat(16), port = 12345;
    const discovery = { version: 1, pid: process.pid, pid_start: readProcess(process.pid).started,
      port, token, codexBin: '/usr/bin/true', shell: 'bash' };
    writeFileSync(path.join(root, 'daemon.json'), JSON.stringify(discovery), { mode: 0o600 });
    // Pause the real discovery reader after submission, while daemon_health has cleared its globals.
    writeFileSync(path.join(root, 'node'), `#!${process.execPath}
const fs = require('fs'), cp = require('child_process');
const args = process.argv.slice(2);
if (args[0] === '-e' && args[1].includes('d.pid_start') && fs.existsSync(process.env.FIXTURE_OUT + '.daemon')) {
  fs.writeFileSync(process.env.FIXTURE_BLOCKED, 'ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
const result = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    writeFileSync(path.join(root, 'curl'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2), config = fs.readFileSync(0, 'utf8'), url = args.at(-1);
const out = process.env.FIXTURE_OUT;
if (url.endsWith('/health')) {
  process.stdout.write(JSON.stringify({ ok: true, pid: Number(process.env.FIXTURE_PID), protocol: 2, profile: 'default' }));
} else if (url.endsWith('/jobs')) {
  const body = JSON.parse(fs.readFileSync(3, 'utf8'));
  fs.writeFileSync(out + '.daemon', 'id=${id}\\nstate=running\\nstarted=' + new Date().toISOString() + '\\n');
  fs.appendFileSync(body.log, 'turn started\\n');
  process.stdout.write(JSON.stringify({ id: '${id}' }) + '\\n200');
} else if (url.endsWith('/cancel')) {
  fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({ args, config }));
} else process.exit(1);
`);
    chmodSync(path.join(root, 'node'), 0o755);
    chmodSync(path.join(root, 'curl'), 0o755);
    const child = spawn('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', root, '-o', out, 'WAIT term'],
      { env: { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`,
        LUNA_CODEX_BIN: '/usr/bin/true', LUNA_DAEMON: '1', LUNA_DAEMON_HOME: root,
        LUNA_DAEMON_APP_SERVER_CMD: '', LUNA_NO_GATE: '1', LUNA_NO_REGISTRY: '1', LUNA_NO_PREAMBLE: '1',
        FIXTURE_OUT: out, FIXTURE_PID: String(process.pid), FIXTURE_BLOCKED: blocked, FIXTURE_CAPTURE: capture } });
    const result = collect(child);
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(blocked) && child.exitCode === null && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(blocked), 'wrapper reached discovery while its job was running');
      child.kill('SIGTERM');
      const cancelled = await result;
      assert.equal(cancelled.code, 130, cancelled.stderr);
      assert.ok(existsSync(capture), 'TERM sent the cancellation request');
      const request = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(request.args.at(-1), `http://127.0.0.1:${port}/jobs/${id}/cancel`);
      assert.equal(request.config, `header = "X-Luna-Token: ${token}"\n`);
      assert.ok(!JSON.stringify(request.args).includes(token));
      assert.match(readFileSync(out + '.status', 'utf8'), /^error=interrupted$/m);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await result;
    }
  });
});

await test('a live daemon without a protocol falls back to exec without submitting or replacing it', async () => {
  await fixture(async (root) => {
    const binary = path.join(root, 'fake-codex');
    const out = path.join(root, 'legacy.md');
    const discovery = { version: 1, pid: process.pid, pid_start: readProcess(process.pid).started,
      port: 12345, token: 'ab'.repeat(16), codexBin: binary, shell: 'bash' };
    writeFileSync(path.join(root, 'daemon.json'), JSON.stringify(discovery));
    writeFileSync(binary, `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift 2; else shift; fi
done
cat >/dev/null
printf 'exec fallback\\n' > "$out"
`);
    writeFileSync(path.join(root, 'curl'), `#!/usr/bin/env bash
cat >/dev/null
for arg in "$@"; do url="$arg"; done
if [[ "$url" = */health ]]; then
  printf '{"ok":true,"pid":%s}' "$FIXTURE_PID"
else
  printf 'submitted' > "$FIXTURE_SUBMITTED"
  exit 1
fi
`);
    chmodSync(binary, 0o755);
    chmodSync(path.join(root, 'curl'), 0o755);
    const result = await run('bash', [path.join(scripts, 'luna.sh'), '-r', '-C', root, '-o', out, 'fixture'],
      { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`, LUNA_DAEMON_HOME: root,
        LUNA_CODEX_BIN: binary, LUNA_DAEMON: '1', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0',
        LUNA_NO_REGISTRY: '1', LUNA_NO_PREAMBLE: '1', LUNA_NO_REFUSAL_RETRY: '1',
        FIXTURE_PID: String(process.pid), FIXTURE_SUBMITTED: path.join(root, 'submitted') });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /incompatible protocol/);
    assert.match(readFileSync(`${out}.status`, 'utf8'), /^engine=exec$/m);
    assert.equal(readFileSync(out, 'utf8'), 'exec fallback\n');
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'daemon.json'), 'utf8')), discovery);
    assert.ok(!existsSync(path.join(root, 'submitted')));
  });
});

await test('review runner loads proxy and PATH through the safe parser before the plugin hook', async () => {
  await fixture(async (root) => {
    mkdirSync(path.join(root, '.config'));
    writeFileSync(path.join(root, '.config/luna-proxy.env'),
      `export HTTPS_PROXY=${proxy}\nexport PATH="$HOME/bin:$PATH"\n`);
    const plugin = path.join(root, '.claude/plugins/cache/openai-codex/codex/1.0.0/scripts');
    mkdirSync(path.join(plugin, 'lib'), { recursive: true });
    writeFileSync(path.join(plugin, 'lib/state.mjs'), '');
    writeFileSync(path.join(plugin, 'stop-review-gate-hook.mjs'),
      'import fs from "node:fs"; fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({\n' +
      'proxy:process.env.HTTPS_PROXY,path:process.env.PATH}));\n');
    const capture = path.join(root, 'capture');
    const result = await run(process.execPath, [path.join(scripts, '../hooks/codex-review-gate-run.mjs')],
      { ...process.env, HOME: root, HTTPS_PROXY: '', LUNA_PROXY_ENV_FILE: '', PATH: '/usr/bin',
        FIXTURE_CAPTURE: capture });
    assert.equal(result.code, 0, result.stderr);
    const env = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(env.proxy, proxy);
    assert.equal(env.path, [path.join(root, 'bin'), '/usr/bin'].join(path.delimiter));
  });
});
