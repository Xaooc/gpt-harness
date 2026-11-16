import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../gem.sh');
const fake = path.join(here, 'fake-acp.mjs');
const statusKeys = [
  'state', 'pid', 'wrapper_pid', 'owner', 'started', 'finished', 'rc', 'model', 'acp_model', 'effort', 'sandbox', 'dir',
  'engine', 'provider', 'conversation_id', 'error', 'last_note', 'usage_input', 'usage_output', 'usage_total',
  'elapsed_s', 'agy_home'
];
const status = (out) => Object.fromEntries(readFileSync(`${out}.status`, 'utf8').trimEnd().split('\n')
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'gem-test-'));
  const dir = path.join(root, 'project with spaces');
  const out = path.join(root, 'results with spaces', 'answer.md');
  const traceFile = path.join(root, 'trace.jsonl');
  const pidFile = path.join(root, 'pids.json');
  const home = path.join(root, 'home');
  const children = new Set();
  mkdirSync(dir);
  mkdirSync(home);
  const trace = () => readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  async function run({
    args = [], prompt = 'Read Привет.txt and report 世界.', scenario = 'success-with-headings', env = {}, output = out
  } = {}) {
    writeFileSync(traceFile, '');
    const child = spawn('bash', [entry, '-C', dir, '-o', output, ...args, ...(prompt === null ? [] : [prompt])], {
      env: {
        ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'gem-test-owner', SSH_FAKE_TEST: 'must be removed',
        GEM_AGENT_CMD: JSON.stringify([process.execPath, fake, scenario, traceFile, pidFile]),
        GEM_NO_SANDBOX: '1', GEM_SKIP_CHECKSUM: '1', GEM_SHARED_HOME: '0',
        GEM_JOB_MB: '0', GEM_RAM_WAIT_S: '5', LUNA_RAM_RESERVE_MB: '0', LUNA_RAMP_S: '0',
        LUNA_ADMIT_LOCK: path.join(root, 'admit.lock'), LUNA_IDLE_MAX_S: '30', LUNA_TIMEOUT_S: '30',
        LUNA_NO_REGISTRY: '1',
        GEM_TEST_SECRET: 'parent secret must not reach agy', ...env
      },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, killSignal: 'SIGKILL'
    });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const rc = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => { children.delete(child); resolve(code); });
    });
    assert.equal(existsSync(`${output}.gem-lock`), false, 'output claim is cleaned up');
    assert.equal(existsSync(path.join(root, 'admit.lock')), false, 'admission lock is released');
    return {
      rc, stdout, stderr, status: existsSync(`${output}.status`) ? status(output) : {},
      output: existsSync(output) ? readFileSync(output, 'utf8') : '',
      log: existsSync(`${output}.log`) ? readFileSync(`${output}.log`, 'utf8') : ''
    };
  }
  try {
    await fn({ root, dir, out, run, trace, pidFile });
  } finally {
    for (const child of children) child.kill('SIGTERM');
    if (existsSync(pidFile)) {
      const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      for (const pid of [...pids.children, pids.agent]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('write-mode success writes the final message and all status fields', { timeout: 300_000 }, async () => {
  await fixture(async ({ root, dir, run, trace }) => {
    const promptFile = path.join(root, 'prompt with spaces.md');
    writeFileSync(promptFile, 'Read Привет.txt and report 世界.\n', 'utf8');
    const result = await run({ args: ['-w', '-f', promptFile], prompt: null });
    assert.equal(result.rc, 0, result.stderr);
    assert.equal(result.status.state, 'done');
    assert.equal(result.status.rc, '0');
    for (const key of statusKeys) assert.ok(Object.hasOwn(result.status, key), `missing status key: ${key}`);
    assert.equal(result.stdout, result.output);
    assert.ok(result.output.includes('Привет, 世界'));
    assert.ok(result.output.includes('λ'.repeat(90_000)), 'long output is preserved');
    assert.ok(result.output.endsWith('✅'.repeat(240) + '\n'));
    assert.equal(result.status.last_note, 'Read greeting.txt');
    assert.equal(result.status.owner, 'gem-test-owner');
    assert.equal(result.status.dir, dir);
    assert.equal(result.status.sandbox, 'workspace-write');
    assert.equal(result.status.model, 'gemini-3.8-flash');
    assert.equal(result.status.acp_model, 'gemini-3.8-flash-high');
    assert.equal(result.status.engine, 'acp');
    assert.equal(result.status.provider, 'gemini');
    assert.equal(result.status.usage_input, '64');
    assert.equal(result.status.usage_output, '128');
    assert.equal(result.status.usage_total, '192');
    assert.equal(result.status.thought_chunks, '1');
    assert.ok(result.status.conversation_id.startsWith('fake-session-'));
    assert.ok(Date.parse(result.status.finished) >= Date.parse(result.status.started));
    assert.ok(Number(result.status.elapsed_s) > 0);
    assert.equal(result.log.match(/agy: startup noise/g)?.length, 5);
    assert.match(result.log, /tool: Read greeting.txt/);
    assert.match(result.log, /state=running/);
    assert.match(result.log, /state=done/);
    assert.doesNotMatch(result.log, /private thought/);
    const calls = trace();
    assert.deepEqual(calls.filter((call) => call.method).map((call) => call.method),
      ['initialize', 'session/new', 'session/set_model', 'session/set_mode', 'session/prompt']);
    const prompt = calls.find((call) => call.method === 'session/prompt').params.prompt[0].text;
    assert.match(prompt, /EXECUTOR/);
    assert.match(prompt, /Do NOT spawn sub-agents/);
    assert.match(prompt, /Never loosen tests, tolerances/);
    assert.match(prompt, /Assumption: \.\.\./);
    assert.ok(prompt.endsWith('Read Привет.txt and report 世界.\n'));
    const environment = calls.find((call) => call.type === 'environment');
    assert.match(environment.env.HOME, /^\/tmp\/gem-job-[^/]+\/home$/);
    assert.equal(existsSync(path.dirname(environment.env.HOME)), false, 'per-job home and tmp are removed');
    assert.equal(result.status.agy_home, 'per-job');
    assert.deepEqual(environment.env, {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb',
      HOME: environment.env.HOME,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000',
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true', AGY_CLI_MODEL_API_MAX_RETRIES: '1',
      HTTP_PROXY: 'http://127.0.0.1:10809', HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: 'localhost,127.0.0.1,::1'
    });
    assert.deepEqual(environment.keys, Object.keys(environment.env).sort());
    assert.ok(!environment.keys.includes('GEM_TEST_SECRET'));
    assert.ok(!environment.keys.some((key) => key.startsWith('SSH_')));
  });
});

test('output, status, log and parent symlinks are refused without touching their targets',
  { timeout: 300_000 }, async () => {
    await fixture(async ({ root, out, run }) => {
      mkdirSync(path.dirname(out));
      const target = path.join(root, 'untouched');
      writeFileSync(target, 'sentinel\n');
      for (const suffix of ['', '.status', '.log']) {
        for (const destination of [target, path.join(root, 'missing')]) {
          const link = `${out}${suffix}`;
          symlinkSync(destination, link);
          try {
            const result = await run();
            assert.equal(result.rc, 2, result.stderr);
            assert.match(result.stderr, /output symlink refused/);
            assert.equal(readFileSync(target, 'utf8'), 'sentinel\n');
            assert.equal(existsSync(path.join(root, 'missing')), false);
          } finally { rmSync(link); }
        }
      }
      const parent = path.join(root, 'linked-results');
      symlinkSync(path.dirname(out), parent);
      const result = await run({ output: path.join(parent, 'answer.md') });
      assert.equal(result.rc, 2, result.stderr);
      assert.match(result.stderr, /output parent symlink refused/);
      assert.equal(existsSync(out), false);
      assert.equal(readFileSync(target, 'utf8'), 'sentinel\n');
    });
  });

test('provider phrases in an answer remain a successful answer', { timeout: 300_000 }, async () => {
  await fixture(async ({ run }) => {
    const result = await run({ args: ['-w'], scenario: 'answer-diagnostics' });
    assert.equal(result.rc, 0, result.stderr);
    assert.equal(result.status.state, 'done');
    assert.equal(result.status.unavailable_reason, '');
    assert.match(result.output, /quota exceeded; sign in required/);
  });
});

test('checksum mismatch exits 3 without executing the binary', { timeout: 300_000 }, async () => {
  await fixture(async ({ root, run }) => {
    const settings = path.join(root, 'settings.json');
    writeFileSync(settings, JSON.stringify({ agy_bin: fake, agy_sha256: '0'.repeat(64) }));
    const result = await run({ env: { GEM_SKIP_CHECKSUM: '0', GEM_TEST_SETTINGS_FILE: settings } });
    assert.equal(result.rc, 3, result.stderr);
    assert.equal(result.status.state, 'unavailable');
    assert.equal(result.status.unavailable_reason, 'checksum');
    assert.equal(result.status.error, 'agy checksum changed');
    assert.equal(readFileSync(path.join(root, 'trace.jsonl'), 'utf8'), '');
  });
});

test('last_note uses the final non-empty message line without tools and status values strip controls',
  { timeout: 300_000 }, async () => {
    await fixture(async ({ run }) => {
      const result = await run({ args: ['-w'], scenario: 'message-only', env: {
        CLAUDE_CODE_SESSION_ID: 'owner\r\nforged=value\t\u001b\u007f\u0085'
      } });
      assert.equal(result.rc, 0, result.stderr);
      assert.equal(result.status.last_note, '✅'.repeat(200));
      assert.match(result.status.owner, /^owner forged=value$/);
      assert.ok(!Object.hasOwn(result.status, 'forged'));
      for (const value of Object.values(result.status)) assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/u);
    });
  });

test('write-mode result missing headings is incomplete', { timeout: 300_000 }, async () => {
  await fixture(async ({ run }) => {
    const result = await run({ args: ['-w'], scenario: 'success-missing-headings' });
    assert.equal(result.rc, 0, result.stderr);
    assert.equal(result.status.state, 'incomplete');
    assert.equal(result.status.rc, '0');
    assert.match(result.output, /finished without headings/);
  });
});

test('permissions use allow_once; unsupported capabilities get -32601', { timeout: 300_000 }, async () => {
  await fixture(async ({ run, trace }) => {
    const result = await run({ args: ['-w'], scenario: 'permission-request' });
    assert.equal(result.rc, 0, result.stderr);
    assert.equal(result.status.state, 'done');
    const calls = trace();
    assert.deepEqual(calls.find((call) => call.id === 'permission-1').result,
      { outcome: { outcome: 'selected', optionId: 'once-first' } });
    assert.equal(calls.find((call) => call.id === 'unsupported-1').error.code, -32601);
    assert.match(result.log, /Run cat greeting.txt/);
  });
});

test('provider exhaustion exits 3 with unavailable quota status', { timeout: 300_000 }, async () => {
  await fixture(async ({ run }) => {
    const result = await run({ args: ['-w'], scenario: 'provider-exhausted' });
    assert.equal(result.rc, 3, result.stderr);
    assert.equal(result.status.state, 'unavailable');
    assert.equal(result.status.rc, '3');
    assert.equal(result.status.unavailable_reason, 'quota');
    assert.match(result.status.error, /exhausted your capacity|RESOURCE_EXHAUSTED/);
    assert.doesNotMatch(result.status.error, /[\r\n]/);
  });
});

test('idle hang exits 124, cancels the session and leaves no child processes', { timeout: 300_000 }, async () => {
  await fixture(async ({ run, pidFile, trace }) => {
    const result = await run({ args: ['-w'], scenario: 'hang', env: { LUNA_IDLE_MAX_S: '2' } });
    assert.equal(result.rc, 124, result.stderr);
    assert.equal(result.status.state, 'stalled');
    assert.equal(result.status.rc, '124');
    assert.match(result.status.error, /no ACP updates for 2s/);
    assert.ok(trace().some((call) => call.method === 'session/cancel'));
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.equal(pids.children.length, 1);
    assert.equal(Number(result.status.pid), pids.agent);
    for (const pid of [pids.agent, ...pids.children]) assert.equal(running(pid), false, `child ${pid} is still alive`);
  });
});

test('models map effort, preserve explicit ids and reject unavailable ids', { timeout: 300_000 }, async () => {
  await fixture(async ({ run, trace }) => {
    for (const [requested, effort, expected] of [
      ['gemini-3.8-flash', 'medium', 'gemini-3.8-flash-medium'],
      ['gemini-3.8-flash-high', 'low', 'gemini-3.8-flash-high'],
      ['claude-sonnet-4-6', 'max', 'claude-sonnet-4-6']
    ]) {
      const result = await run({ args: ['-m', requested, '-e', effort] });
      assert.equal(result.rc, 0, result.stderr);
      assert.equal(result.status.state, 'done');
      assert.equal(result.status.model, requested);
      assert.equal(result.status.acp_model, expected);
      assert.equal(result.status.effort, effort);
      assert.equal(result.status.sandbox, 'read-only');
      assert.equal(trace().find((call) => call.method === 'session/set_model').params.modelId, expected);
      const prompt = trace().find((call) => call.method === 'session/prompt').params.prompt[0].text;
      assert.match(prompt, /must not MODIFY anything/);
    }
    const result = await run({ args: ['-m', 'not-offered'] });
    assert.equal(result.rc, 2, result.stderr);
    assert.equal(result.status.state, 'failed');
    assert.equal(result.status.error, 'model not offered: not-offered');
    assert.equal(trace().some((call) => call.method === 'session/set_model'), false);
  });
});
