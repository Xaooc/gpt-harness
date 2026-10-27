// Offline Linux acceptance checks. Run with HOME set to a disposable directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  availableMemory, codexEnvironment, formatRetryDelay, loadProxyEnv, modelRetryDelayMs, ownedProcess, processRows,
  readProcess, resolveCodex, stopGroup
} from './luna-runtime.mjs';
import { codexPluginRoot } from './codex-plugin.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const run = async (command, args, options = {}) => {
  const result = await execute(command, args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

await test('model retry jitter stays within zero to thirty percent for each retry', () => {
  for (const [base, retry] of [[0, 1], [1, 1], [60, 2], [Number.MAX_SAFE_INTEGER, 3]]) {
    const minimum = BigInt(base) * BigInt(retry) * 1000n;
    assert.equal(modelRetryDelayMs(base, retry, () => 0), minimum);
    assert.equal(modelRetryDelayMs(base, retry, () => 1 - Number.EPSILON), minimum + minimum * 3n / 10n);
    for (let i = 0; i < 100; i++) {
      const actual = modelRetryDelayMs(base, retry);
      assert.ok(actual >= minimum && actual <= minimum + minimum * 3n / 10n);
    }
  }
  assert.equal(formatRetryDelay(1234n), '1.234');
});

await test('MemAvailable returns positive MB in Node, bash and Python', async () => {
  assert.ok(Math.floor(availableMemory() / 1048576) > 0);
  assert.ok(Number(await run('bash', ['-c', "awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo"])) > 0);
  const code = 'import runpy,sys; m=runpy.run_path(sys.argv[1]); assert m["free_ram_gb"]()>0; ' +
    'assert m["MAX_WORKERS"]==4; assert m["MIN_FREE_DISK_GB"]==10; ' +
    'assert m["pid_alive"](__import__("os").getpid()); assert not m["pid_alive"](2147483647); ' +
    'assert m["_processes"]()';
  await run('python3', ['-c', code, path.join(scripts, 'pytest_gate.py')]);
});

await test('resolver respects executable overrides, active PATH installs and paths with spaces', async () => {
  const resolved = resolveCodex();
  assert.ok(existsSync(resolved));
  console.log(`codex_bin=${resolved}`);
  const root = mkdtempSync(path.join(tmpdir(), 'luna-resolve-'));
  try {
    const shimDir = path.join(root, 'shim with spaces');
    const packageRoot = path.join(root, '.npm-global/lib/node_modules/@openai/codex');
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    const native = path.join(packageRoot, 'vendor', `${arch}-unknown-linux-musl`, 'bin', 'codex');
    const shim = path.join(shimDir, 'codex');
    mkdirSync(path.dirname(native), { recursive: true });
    mkdirSync(shimDir);
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    for (const file of [native, shim]) { writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755); }
    assert.equal(resolveCodex({ PATH: shimDir }, root), native);
    const env = codexEnvironment(native, { CODEX_MANAGED_BY_BUN: '1' });
    assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT, packageRoot);
    assert.equal(env.CODEX_MANAGED_BY_NPM, '1');
    assert.equal(env.CODEX_MANAGED_BY_BUN, undefined);
    assert.equal(resolveCodex({ PATH: shimDir, LUNA_CODEX_BIN: shim }, root), shim);
    assert.throws(() => resolveCodex({ PATH: shimDir, LUNA_CODEX_BIN: path.join(root, 'missing') }, root),
      /LUNA_CODEX_BIN is not an executable file/);
    chmodSync(shim, 0o644);
    assert.throws(() => resolveCodex({ PATH: shimDir, LUNA_CODEX_BIN: shim }, root), /not an executable/);
    assert.throws(() => resolveCodex({ PATH: shimDir, LUNA_CODEX_BIN: root }, root), /not an executable/);
    chmodSync(shim, 0o755);
    const errorFile = path.join(root, 'resolve-error');
    const invalid = await execute('bash', ['-c', 'exec "$1" "$2" --resolve 2>"$3"', '_',
      process.execPath, path.join(scripts, 'lib/luna-runtime.mjs'), errorFile],
      { env: { ...process.env, LUNA_CODEX_BIN: path.join(root, 'missing') } });
    assert.equal(invalid.status, 2); assert.match(readFileSync(errorFile, 'utf8'), /LUNA_CODEX_BIN/);
    const activePackage = path.join(root, 'active install/lib/node_modules/@openai/codex');
    const activeNative = path.join(activePackage, 'vendor', `${arch}-unknown-linux-musl`, 'codex/codex');
    const activeShim = path.join(activePackage, 'bin/codex.js');
    const activeBin = path.join(root, 'active install/bin');
    mkdirSync(path.dirname(activeNative), { recursive: true });
    mkdirSync(path.dirname(activeShim)); mkdirSync(activeBin);
    writeFileSync(path.join(activePackage, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    for (const file of [activeNative, activeShim]) {
      writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755);
    }
    symlinkSync(activeShim, path.join(activeBin, 'codex'));
    assert.equal(resolveCodex({ PATH: `${activeBin}:${shimDir}` }, root), activeNative);
    chmodSync(native, 0o644);
    assert.equal(resolveCodex({ PATH: shimDir }, root), shim);
    const fallback = path.join(root, '.npm-global/bin/codex');
    mkdirSync(path.dirname(fallback), { recursive: true });
    writeFileSync(fallback, '#!/bin/sh\n'); chmodSync(fallback, 0o755);
    assert.equal(resolveCodex({ PATH: '' }, root), fallback);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('proxy safety net parses exports without evaluating shell code or logging values', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-proxy-'));
  try {
    mkdirSync(path.join(root, '.config'));
    writeFileSync(path.join(root, '.config/luna-proxy.env'), [
      'export PATH="$HOME/.npm-global/bin:$PATH"', 'export HTTPS_PROXY=http://127.0.0.1:3128',
      "export NO_PROXY='localhost,127.0.0.1'", 'export HTTP_PROXY=$(touch /tmp/never-evaluate-luna)',
      'export ALL_PROXY=bad ; false', 'export all_proxy=bad && false',
      'export no_proxy=local # harmless comment', 'export UNRELATED=ignored', ''
    ].join('\n'));
    const env = { PATH: '/usr/bin' };
    loadProxyEnv(env, root);
    assert.equal(env.PATH, `${root}/.npm-global/bin:/usr/bin`);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.UNRELATED, undefined);
    assert.equal(env.ALL_PROXY, undefined);
    assert.equal(env.all_proxy, undefined);
    assert.equal(env.no_proxy, 'local');
    const preset = { HTTPS_PROXY: 'preset', PATH: '/usr/bin' };
    loadProxyEnv(preset, root);
    assert.equal(preset.PATH, '/usr/bin');
    const defaultFile = path.join(root, '.config/luna-proxy.env');
    const legacyFile = path.join(root, '.config/bro-env.sh');
    const customFile = path.join(root, 'custom-proxy.env');
    writeFileSync(legacyFile, 'export HTTPS_PROXY=legacy\n');
    writeFileSync(customFile, 'export HTTPS_PROXY=custom\n');
    const configured = { LUNA_PROXY_ENV_FILE: customFile };
    loadProxyEnv(configured, root);
    assert.equal(configured.HTTPS_PROXY, 'custom');
    const tilde = { LUNA_PROXY_ENV_FILE: '~/custom-proxy.env' };
    loadProxyEnv(tilde, root);
    assert.equal(tilde.HTTPS_PROXY, 'custom');
    const missing = { LUNA_PROXY_ENV_FILE: path.join(root, 'missing') };
    loadProxyEnv(missing, root);
    assert.equal(missing.HTTPS_PROXY, undefined);
    const preferred = {};
    loadProxyEnv(preferred, root);
    assert.equal(preferred.HTTPS_PROXY, 'http://127.0.0.1:3128');
    rmSync(defaultFile);
    const legacy = {};
    loadProxyEnv(legacy, root);
    assert.equal(legacy.HTTPS_PROXY, 'legacy');

    const shell = '. "$1/lib/luna-runtime.sh"; luna_proxy_env; printf "%s" "${HTTPS_PROXY:-}"';
    const shellEnv = { ...process.env, HOME: root, HTTPS_PROXY: '', LUNA_PROXY_ENV_FILE: '' };
    assert.equal(await run('bash', ['-c', shell, '_', scripts], { env: shellEnv }), 'legacy');
    assert.equal(await run('bash', ['-c', shell, '_', scripts],
      { env: { ...shellEnv, LUNA_PROXY_ENV_FILE: '~/custom-proxy.env' } }), 'custom');
    writeFileSync(defaultFile, 'export HTTPS_PROXY=default\n');
    assert.equal(await run('bash', ['-c', shell, '_', scripts], { env: shellEnv }), 'default');
    assert.equal(await run('bash', ['-c', shell, '_', scripts],
      { env: { ...shellEnv, LUNA_PROXY_ENV_FILE: path.join(root, 'missing') } }), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('same setsid helper stops an entire dummy tree, including TERM-resistant descendants', async () => {
  for (const resistant of [false, true]) {
    const script = '. "$1/lib/luna-runtime.sh"; ' +
      'luna_start_group bash -c "$2" luna-linux-dummy >/dev/null 2>&1; printf "%s\\n" "$CPID"';
    const pid = Number(await run('bash', ['-c', script, '_', scripts,
      `${resistant ? 'trap "" TERM; ' : ''}sleep 300 & wait`]));
    try {
      await delay(150);
      assert.ok(ownedProcess(pid));
      assert.ok(processRows().filter((row) => row.group === pid && row.state !== 'Z').length >= 2);
      await run('bash', ['-c', '. "$1/lib/luna-runtime.sh"; luna_stop_group "$2" "$3"',
        '_', scripts, String(pid), readProcess(pid).started]);
      await delay(100);
      assert.deepEqual(processRows().filter((row) => row.group === pid && row.state !== 'Z'), []);
    } finally {
      if (processRows().some((row) => row.group === pid && row.state !== 'Z')) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
    }
  }
});

await test('stale, missing and foreign file PIDs are never signaled', async () => {
  assert.equal(ownedProcess(2147483647), null);
  assert.equal(await stopGroup(2147483647), false);
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  try {
    assert.equal(await stopGroup(child.pid), false);
    const identity = readProcess(child.pid);
    assert.equal(await stopGroup(child.pid, { ...identity, started: 'reused' }), false);
    assert.equal(await stopGroup(child.pid, { ...identity, command: 'reused' }), false);
    assert.ok(readProcess(child.pid));
  } finally {
    process.kill(-child.pid, 'SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

await test('fake status retains every status key, elapsed time and log fields', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-status-'));
  try {
    const out = path.join(root, 'job with spaces.md');
    const values = {
      state: 'done', pid: '2147483647', wrapper_pid: '2147483646', owner: 'fixture',
      started: '2026-10-24T12:00:00+0000', effort: 'high', sandbox: 'read-only', model: 'fixture',
      tier: 'default', dir: root, codex_bin: '/usr/bin/fixture', shell: 'bash', engine: 'exec',
      rc: '0', finished: '2026-10-24T12:01:00+0000'
    };
    const status = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    writeFileSync(`${out}.status`, status);
    writeFileSync(`${out}.log`, 'codex\nfixture note\n');
    const output = await run('bash', [path.join(scripts, 'luna-status.sh'), out]);
    for (const line of status.trim().split('\n')) assert.ok(output.includes(`${line}\n`), line);
    assert.match(output, /elapsed_min=1\n/);
    assert.match(output, /log_bytes=\d+ log_idle_s=\d+/);
    assert.match(output, /last_note=fixture note/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('plugin resolution uses freshly installed cache sources and the manifest-selected version', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-plugin-'));
  try {
    const cache = path.join(root, '.claude/plugins/cache/openai-codex/codex');
    const chosen = path.join(cache, '1.0.0');
    for (const version of ['1.0.0', '2.0.0']) {
      const dir = path.join(cache, version, 'scripts');
      mkdirSync(path.join(dir, 'lib'), { recursive: true });
      writeFileSync(path.join(dir, 'lib/state.mjs'), '');
      writeFileSync(path.join(dir, 'stop-review-gate-hook.mjs'), '');
    }
    writeFileSync(path.join(root, '.claude/plugins/installed_plugins.json'), JSON.stringify({
      plugins: { 'codex@openai-codex': [{ installPath: chosen }] }
    }));
    assert.equal(codexPluginRoot(root), chosen);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('exec wrapper preserves flags, stdin and terminal status using a local Codex stub', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-wrapper-'));
  try {
    const binary = path.join(root, 'codex fixture');
    const output = path.join(root, 'result with spaces.md');
    writeFileSync(binary, '#!/bin/bash\n' +
      'printf "%s\\n" "$@" > "$LUNA_FIXTURE_ARGS"\n' +
      'out=""; while [ "$#" -gt 0 ]; do\n' +
      'case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done\n' +
      'cat > "$LUNA_FIXTURE_PROMPT"\nprintf "fixture answer\\n" > "$out"\n');
    chmodSync(binary, 0o755);
    await run('bash', [path.join(scripts, 'luna.sh'), '-r', '-e', 'high', '-m', 'fixture-model', '-t', 'default',
      '-C', root, '-o', output, 'fixture prompt'], { env: { ...process.env,
      LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_CODEX_BIN: binary,
      LUNA_NO_PREAMBLE: '1', LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_MODEL_RETRIES: '0',
      LUNA_FIXTURE_ARGS: path.join(root, 'args'), LUNA_FIXTURE_PROMPT: path.join(root, 'prompt') } });
    assert.equal(readFileSync(path.join(root, 'prompt'), 'utf8'), 'fixture prompt\n');
    const args = readFileSync(path.join(root, 'args'), 'utf8').trim().split('\n');
    assert.equal(args[0], 'exec');
    assert.ok(args.includes('--ephemeral'));
    for (const value of ['fixture-model', 'read-only', root, output, '-']) assert.ok(args.includes(value));
    const status = readFileSync(`${output}.status`, 'utf8');
    assert.match(status, /^state=done$/m);
    assert.match(status, /^rc=0$/m);
    assert.match(status, /^shell=bash$/m);
    assert.ok(status.includes(`codex_bin=${binary}\n`));
    assert.match(status, /^engine=exec$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('exec resumes capacity failures in the same session and ignores ordinary output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'luna-model-retry-'));
  const uuid = '01a17d4c-b215-70f3-a2f0-a56ba9c1e238';
  try {
    const binary = path.join(root, 'fake codex');
    const calls = path.join(root, 'calls.jsonl');
    const prompt = path.join(root, 'resume-prompt');
    const sessions = path.join(root, 'codex-home/sessions/2026/10/27');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(binary, `#!${process.execPath}
const fs = require('fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.RETRY_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[1] !== 'resume') {
  process.stderr.write('session id: ${uuid}\\n');
  if (process.env.RETRY_CASE === 'output') process.stdout.write('The model said at capacity\\n');
  else process.stderr.write('ERROR: Selected model is at capacity. Please try a different model.\\n');
  process.exit(1);
}
fs.writeFileSync(process.env.RETRY_PROMPT, fs.readFileSync(0, 'utf8'));
fs.writeFileSync(args[args.indexOf('-o') + 1],
  '## Changes\\nDone\\n## Verification\\nDone\\n## Deviations\\nNone\\n## Not done\\nNone\\n');
`);
    chmodSync(binary, 0o755);
    const rollout = path.join(sessions, `rollout-x-${uuid}.jsonl`);
    const sibling = path.join(sessions, 'rollout-x-11111111-1111-1111-1111-111111111111.jsonl');
    writeFileSync(sibling, 'other session');
    const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'codex-home'),
      LUNA_DAEMON: '0', LUNA_NO_GATE: '1', LUNA_RAMP_S: '0', LUNA_CODEX_BIN: binary,
      LUNA_NO_REGISTRY: '1', LUNA_MODEL_RETRIES: '2', LUNA_MODEL_RETRY_DELAY_S: '1',
      RETRY_CALLS: calls, RETRY_PROMPT: prompt };
    const out = path.join(root, 'result.md');
    writeFileSync(rollout, 'this session');
    const args = [path.join(scripts, 'luna.sh'), '-w', '-C', root, '-o', out,
      '-m', 'fixture-model', '-e', 'high', 'fixture prompt'];
    const resumed = await execute('bash', args, { env });
    assert.equal(resumed.status, 0, resumed.stderr);
    const invocations = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].args[0], 'exec');
    assert.ok(!invocations[0].args.includes('--ephemeral'));
    assert.deepEqual(invocations[1].args.slice(0, 2), ['exec', 'resume']);
    for (const value of [uuid, 'fixture-model', 'model_reasoning_effort="high"',
      'service_tier="default"', 'sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=true']) {
      assert.ok(invocations[1].args.includes(value), value);
    }
    assert.ok(!invocations[1].args.includes('-s') && !invocations[1].args.includes('-C'));
    assert.equal(invocations[1].cwd, root);
    assert.match(readFileSync(prompt, 'utf8'), /^LUNA AUTO-RETRY 1\/2:/);
    const status = readFileSync(`${out}.status`, 'utf8');
    assert.match(status, /^state=done$/m);
    assert.match(status, /^model_retry=1$/m);
    const delayS = /^model_retry_delay_s=(\d+\.\d{3})$/m.exec(status)?.[1];
    assert.ok(Number(delayS) >= 1 && Number(delayS) <= 1.3);
    assert.ok(readFileSync(`${out}.log`, 'utf8').includes(`same session in ${delayS}s`));
    assert.ok(!existsSync(rollout));
    assert.ok(existsSync(sibling));

    rmSync(calls);
    writeFileSync(rollout, 'this session');
    const plainOutput = await execute('bash', args, { env: { ...env, RETRY_CASE: 'output' } });
    assert.equal(plainOutput.status, 1);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    assert.match(readFileSync(`${out}.status`, 'utf8'), /^state=failed$/m);
    assert.ok(!existsSync(rollout));
    assert.ok(existsSync(sibling));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
