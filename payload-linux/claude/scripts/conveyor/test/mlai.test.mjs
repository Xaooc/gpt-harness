import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main as execMain } from '../exec.mjs';
import { acquireSlot } from '../lib/mlai.mjs';
import { loadConfig, providerState, resolveChain, validateConfig } from '../lib/orchestration.mjs';
import { readProcessStat } from '../lib/platform.mjs';
import { invoke } from './process-fixture.mjs';

const fixture = new URL('./fixtures/orchestration.json', import.meta.url);
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function withProcessEnv(env, work) {
  const keys = ['HOME', 'CONVEYOR_HOME', 'LUNA_RUN_DIR', 'CLAUDE_HOME_DIR', 'MLAI_HOME', 'MLAI_BIN',
    'CONVEYOR_MLAI_SLOTS', 'CONVEYOR_MLAI_SH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) if (env[key] !== undefined) process.env[key] = env[key];
  try { return await work(); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function withEnvironment(work, { accounts } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor mlai test-'));
  const home = path.join(root, 'conveyor'), run = path.join(root, 'luna-run'), auth = path.join(root, 'mlai');
  const wrapper = path.join(root, 'mlai.sh'), dir = path.join(root, 'repo');
  const configFile = path.join(home, 'orchestration.json'), brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md');
  const env = {
    ...process.env, HOME: root, CONVEYOR_HOME: home, LUNA_RUN_DIR: run, CLAUDE_HOME_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'), CONVEYOR_MLAI_SH: wrapper, MLAI_BIN: wrapper, MLAI_HOME: auth,
    CONVEYOR_MLAI_SLOTS: '2', CONVEYOR_LUNA_SH: fileURLToPath(new URL('./fixtures/fake-wrapper.sh', import.meta.url))
  };
  try {
    for (const directory of [home, run, auth, dir]) await fs.mkdir(directory);
    const config = await readJson(fixture);
    config.tiers.complex = [{ provider: 'mlai', model: 'pixis-sol', effort: 'medium' }, config.tiers.complex[0]];
    const mlaiAccounts = accounts?.({ root, auth });
    if (mlaiAccounts) {
      for (const account of mlaiAccounts.slice(1)) {
        await fs.mkdir(account.home, { recursive: true });
        await fs.writeFile(path.join(account.home, 'auth.json'), JSON.stringify({ expires: Date.now() + 86_400_000 }));
      }
      config.mlai_accounts = mlaiAccounts;
    }
    await fs.writeFile(configFile, JSON.stringify(config));
    await fs.writeFile(brief, 'Inspect the fixture.\n');
    await fs.writeFile(path.join(auth, 'auth.json'), JSON.stringify({ expires: Date.now() + 86_400_000 }));
    await fs.writeFile(wrapper, String.raw`#!/bin/bash
set -eu
while getopts 'wrm:e:C:f:o:' opt; do
  case "$opt" in o) out=$OPTARG;; esac
done
flags="$(dirname "$out")"
printf 'home=%s\naccount=%s\nproxy=%s\n' "${'$'}{MLAI_HOME:-}" "${'$'}{MLAI_ACCOUNT:-}" \
  "${'$'}{HTTPS_PROXY:-}" > "$out.cli-env"
if [ -f "$flags/nowork" ]; then
  printf 'provider=mlai\nstate=incomplete\nreached_running=1\nchanged_files=0\nerror=mlai: stopped early (exit 3: error_during_execution)\n' > "$out.status"
  exit 1
fi
if [ -f "$flags/partial" ]; then
  printf 'half\n' > partial.txt
  printf 'provider=mlai\nstate=incomplete\nreached_running=1\nchanged_files=1\nerror=mlai: stopped early (exit 3: error_max_turns)\n' > "$out.status"
  exit 1
fi
if [ -f "$(dirname "$out")/netfail" ]; then
  printf 'provider=mlai\nstate=unavailable\nunavailable_reason=start\nerror=mlai: connection interrupted (after 2 attempts)\n' > "$out.status"
  exit 3
fi
printf '%s\n' "$MLAI_SLOT" > "$out"
printf 'provider=mlai\nstate=done\nreached_running=1\n' > "$out.status"
`, { mode: 0o755 });
    const runJob = (mode = '-r') => invoke(execMain, ['run', '--tier', 'complex', mode, '-C', dir, '-f', brief, '-o', out,
      ...(mode === '-w' ? ['--review-skip', 'test fixture'] : [])], { env, prefix: 'conveyor', captureChildren: true });
    await work({ home, root, run, dir, slots: path.join(run, 'mlai', 'slots'), config, out, env, runJob });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('two live mlai slots skip to Codex without marking mlai unavailable', async () => {
  await withEnvironment(async ({ home, slots, out, runJob }) => {
    const sleeper = spawn('sleep', ['30']);
    const exited = once(sleeper, 'exit');
    try {
      await once(sleeper, 'spawn');
      for (const index of [0, 1]) {
        const dir = path.join(slots, String(index));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({
          pid: sleeper.pid, pid_start: readProcessStat(sleeper.pid)?.started, token: String(index), out,
          at: new Date().toISOString()
        }));
      }
      const result = await runJob();
      assert.equal(result.status, 0, result.stderr);
      assert.match(await fs.readFile(out, 'utf8'), /^codex /);
      const dispatch = await readJson(`${out}.dispatch.json`);
      assert.equal(dispatch.provider, 'codex');
      assert.match(dispatch.reason, /mlai sessions busy \(2\/2\)/);
      assert.deepEqual(dispatch.attempts.map(({ provider }) => provider), ['codex']);
      assert.equal(Object.hasOwn(await readJson(path.join(home, 'providers.json')), 'mlai'), false);
    } finally {
      sleeper.kill();
      await exited;
    }
  });
});

test('mlai slot release; a network failure, or an unfinished write run with no changes, moves on unmarked; one with changes exits 1', async () => {
  await withEnvironment(async ({ home, dir, slots, out, runJob }) => {
    await fs.writeFile(path.join(path.dirname(out), 'netfail'), '');
    const failed = await runJob();
    assert.equal(failed.status, 0, failed.stderr);
    assert.deepEqual((await readJson(`${out}.dispatch.json`)).attempts.map(({ provider }) => provider), ['mlai', 'codex']);
    assert.equal(Object.hasOwn(await readJson(path.join(home, 'providers.json')).catch(() => ({})), 'mlai'), false);
    assert.deepEqual(await fs.readdir(slots), []);
    await fs.rm(path.join(path.dirname(out), 'netfail'));

    // A write run that stopped without changing anything moves on; one that left changes stays and fails loudly.
    for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']]) {
      const git = spawn('git', args, { cwd: dir });
      assert.equal((await once(git, 'exit'))[0], 0);
    }
    await fs.writeFile(path.join(path.dirname(out), 'nowork'), '');
    const idle = await runJob('-w');
    assert.equal(idle.status, 0, idle.stderr);
    assert.deepEqual((await readJson(`${out}.dispatch.json`)).attempts.map(({ provider }) => provider), ['mlai', 'codex']);
    assert.equal(Object.hasOwn(await readJson(path.join(home, 'providers.json')).catch(() => ({})), 'mlai'), false);
    await fs.rm(path.join(path.dirname(out), 'nowork'));
    await fs.writeFile(path.join(path.dirname(out), 'partial'), '');
    const partial = await runJob('-w');
    assert.equal(partial.status, 1, partial.stderr);
    assert.deepEqual((await readJson(`${out}.dispatch.json`)).attempts.map(({ provider }) => provider), ['mlai']);
    await fs.rm(path.join(path.dirname(out), 'partial'));
    await fs.rm(path.join(dir, 'partial.txt'));

    const result = await runJob();
    assert.equal(result.status, 0, result.stderr);
    const slot = (await fs.readFile(out, 'utf8')).trim();
    assert.equal(path.dirname(slot), slots);
    assert.equal((await readJson(`${out}.dispatch.json`)).provider, 'mlai');
    await assert.rejects(fs.stat(slot), { code: 'ENOENT' });
  });
});

test('account b is filled after main, and Codex is reached only when both accounts are full', async () => {
  const accounts = ({ root }) => [
    { id: 'main', label: 'основной' },
    { id: 'b', label: 'b', home: path.join(root, 'mlai-b'), proxy: 'http://127.0.0.1:10820' }
  ];
  await withEnvironment(async ({ home, root, run, slots, out, runJob }) => {
    const bHome = path.join(root, 'mlai-b'), bSlots = path.join(run, 'mlai', 'accounts', 'b', 'slots');
    const sleeper = spawn('sleep', ['30']);
    const exited = once(sleeper, 'exit');
    const hold = async (dir, index) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({
        pid: sleeper.pid, pid_start: readProcessStat(sleeper.pid)?.started, token: String(index), out,
        at: new Date().toISOString()
      }));
    };
    try {
      await once(sleeper, 'spawn');
      for (const index of [0, 1]) await hold(path.join(slots, String(index)), index);
      const first = await runJob();
      assert.equal(first.status, 0, first.stderr);
      const dispatch = await readJson(`${out}.dispatch.json`);
      assert.equal(dispatch.provider, 'mlai');
      assert.equal(dispatch.attempts[0].account, 'b');
      assert.equal(path.dirname((await fs.readFile(out, 'utf8')).trim()), bSlots);
      assert.deepEqual((await fs.readFile(`${out}.cli-env`, 'utf8')).trim().split('\n'),
        [`home=${bHome}`, 'account=b', 'proxy=http://127.0.0.1:10820']);

      for (const index of [0, 1]) await hold(path.join(bSlots, String(index)), index);
      const second = await runJob();
      assert.equal(second.status, 0, second.stderr);
      const fallback = await readJson(`${out}.dispatch.json`);
      assert.equal(fallback.provider, 'codex');
      assert.match(fallback.reason, /mlai sessions busy \(4\/4\)/);
      assert.deepEqual(fallback.attempts.map(({ provider }) => provider), ['codex']);
      assert.equal(Object.hasOwn(await readJson(path.join(home, 'providers.json')).catch(() => ({})), 'mlai'), false);
    } finally {
      sleeper.kill();
      await exited;
    }
  }, { accounts });
});

test('a snapshot that says sessions busy never outvotes the live reservation', async () => {
  const accounts = ({ root }) => [
    { id: 'main', label: 'основной' },
    { id: 'b', label: 'b', home: path.join(root, 'mlai-b'), proxy: 'http://127.0.0.1:10820' }
  ];
  await withEnvironment(async ({ root, run, slots, out, env, runJob }) => {
    const bHome = path.join(root, 'mlai-b'), bAuth = path.join(bHome, 'auth.json');
    const bSlots = path.join(run, 'mlai', 'accounts', 'b', 'slots');
    const signedIn = await fs.readFile(bAuth, 'utf8');
    await fs.rm(bAuth);
    const sleeper = spawn('sleep', ['30']);
    const exited = once(sleeper, 'exit');
    try {
      await once(sleeper, 'spawn');
      for (const index of [0, 1]) {
        const dir = path.join(slots, String(index));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({
          pid: sleeper.pid, pid_start: readProcessStat(sleeper.pid)?.started, token: String(index), out,
          at: new Date().toISOString()
        }));
      }
      const config = await withProcessEnv(env, async () => {
        const loaded = await loadConfig();
        const state = await providerState(loaded, { persist: false });
        // With main full and b signed out the snapshot says everything is busy.
        const model = loaded.catalog.mlai[0];
        const probe = {
          ...loaded, tiers: { mlai: [{ provider: 'mlai', model: model.model, effort: model.efforts[0] }] }
        };
        const entry = (await resolveChain('mlai', { config: probe, state, now: Date.now() })).chain[0];
        assert.match(entry.reason, /mlai sessions busy \(2\/2\)/);
        return loaded;
      });

      // b signs in after that snapshot; the live reservation claims its first slot anyway.
      await fs.writeFile(bAuth, signedIn);
      const claimed = await acquireSlot({ out }, env, {
        accounts: config.mlai_accounts, marks: {}, now: Date.now()
      });
      assert.equal(claimed.account, 'b');
      assert.equal(path.dirname(claimed.dir), bSlots);
      claimed.release();

      const result = await runJob();
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await readJson(`${out}.dispatch.json`)).provider, 'mlai');
      assert.equal((await readJson(`${out}.dispatch.json`)).attempts[0].account, 'b');
    } finally {
      sleeper.kill();
      await exited;
    }
  }, { accounts });
});

test('legacy configs gain the mlai catalog and only mlai can use gpt-6-astra', async () => {
  await withEnvironment(async ({ config, env }) => {
    assert.equal(Object.hasOwn(config.catalog, 'mlai'), false);
    const result = await invoke(async () => {
      const loaded = await loadConfig();
      assert.deepEqual(loaded.catalog.mlai, (await readJson(defaultFile)).catalog.mlai);
      assert.deepEqual(loaded.tiers, config.tiers);
      assert.throws(() => validateConfig({ ...loaded, mlai_accounts: [
        { id: 'main', label: 'основной' }, { id: 'b', label: 'b', proxy: 'ftp://127.0.0.1:1' }
      ] }), /proxy must match http:\/\/host:port/);
      assert.throws(() => validateConfig({ ...loaded, mlai_accounts: [{ id: 'b', label: 'b' }] }),
        /mlai_accounts must start with the main account/);
      loaded.tiers.complex[0].model = 'gpt-6-astra';
      assert.equal(validateConfig(loaded), loaded);
      loaded.tiers.complex[0].provider = 'codex';
      loaded.catalog.codex.push({ model: 'gpt-6-astra', efforts: ['medium'] });
      assert.throws(() => validateConfig(loaded), /gpt-6-astra is forbidden by user rule/);
    }, [], { env, prefix: 'conveyor' });
    assert.equal(result.status, 0, result.stderr);
  });
});
