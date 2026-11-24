import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main as execMain } from '../exec.mjs';
import { loadConfig, validateConfig } from '../lib/orchestration.mjs';
import { readProcessStat } from '../lib/platform.mjs';
import { invoke } from './process-fixture.mjs';

const fixture = new URL('./fixtures/orchestration.json', import.meta.url);
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function withEnvironment(work) {
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
    await fs.writeFile(configFile, JSON.stringify(config));
    await fs.writeFile(brief, 'Inspect the fixture.\n');
    await fs.writeFile(path.join(auth, 'auth.json'), JSON.stringify({ expires: Date.now() + 86_400_000 }));
    await fs.writeFile(wrapper, String.raw`#!/bin/bash
set -eu
while getopts 'wrm:e:C:f:o:' opt; do
  case "$opt" in o) out=$OPTARG;; esac
done
printf '%s\n' "$MLAI_SLOT" > "$out"
printf 'provider=mlai\nstate=done\nreached_running=1\n' > "$out.status"
`, { mode: 0o755 });
    const runJob = () => invoke(execMain, ['run', '--tier', 'complex', '-r', '-C', dir, '-f', brief, '-o', out], {
      env, prefix: 'conveyor', captureChildren: true
    });
    await work({ home, slots: path.join(run, 'mlai', 'slots'), config, out, env, runJob });
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

test('mlai receives a free slot and releases it when the dispatch ends', async () => {
  await withEnvironment(async ({ slots, out, runJob }) => {
    const result = await runJob();
    assert.equal(result.status, 0, result.stderr);
    const slot = (await fs.readFile(out, 'utf8')).trim();
    assert.equal(path.dirname(slot), slots);
    assert.equal((await readJson(`${out}.dispatch.json`)).provider, 'mlai');
    await assert.rejects(fs.stat(slot), { code: 'ENOENT' });
  });
});

test('legacy configs gain the mlai catalog and only mlai can use gpt-6-astra', async () => {
  await withEnvironment(async ({ config, env }) => {
    assert.equal(Object.hasOwn(config.catalog, 'mlai'), false);
    const result = await invoke(async () => {
      const loaded = await loadConfig();
      assert.deepEqual(loaded.catalog.mlai, (await readJson(defaultFile)).catalog.mlai);
      assert.deepEqual(loaded.tiers, config.tiers);
      loaded.tiers.complex[0].model = 'gpt-6-astra';
      assert.equal(validateConfig(loaded), loaded);
      loaded.tiers.complex[0].provider = 'codex';
      loaded.catalog.codex.push({ model: 'gpt-6-astra', efforts: ['medium'] });
      assert.throws(() => validateConfig(loaded), /gpt-6-astra is forbidden by user rule/);
    }, [], { env, prefix: 'conveyor' });
    assert.equal(result.status, 0, result.stderr);
  });
});
