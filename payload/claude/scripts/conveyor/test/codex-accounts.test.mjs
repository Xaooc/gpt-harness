import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { selectAccount } from '../lib/codex-accounts.mjs';
import { providerState, resolveChain } from '../lib/orchestration.mjs';
import { matchingProcess } from '../../lib/luna-runtime.mjs';

const scripts = fileURLToPath(new URL('../../', import.meta.url));
const configFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const accounts = [{ id: 'main', label: 'основной' }, { id: 'b', label: 'Second account' }];
const threshold = { switch_percent: 80, hysteresis_percent: 5, windows: ['primary', 'secondary'] };
const run = promisify(execFile);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('Codex selection applies per-account hysteresis, cooldowns and ranking', () => {
  const now = Date.now();
  const limit = (usedPercent, loggedIn = true) => ({ known: true, primary: { usedPercent }, loggedIn });
  const scenarios = [
    { name: 'main below threshold', main: limit(79), b: limit(10), expected: 'main' },
    { name: 'main at threshold', main: limit(80), b: limit(10), expected: 'b', switched: true },
    { name: 'main still above recovery mark', main: limit(76), b: limit(10), previousActive: 'b',
      marks: { main: { switched: true } }, expected: 'b', switched: true },
    { name: 'both at threshold', main: limit(80), b: limit(80), previousActive: 'b', expected: null, switched: true },
    { name: 'main marked for quota', main: limit(10), b: limit(10),
      marks: { main: { until: now + 1000, reason: 'quota' } }, expected: 'b', reason: /quota/ },
    { name: 'depleted credits pool below the threshold', main: { ...limit(10), reached: 'workspace_member_credits_depleted' },
      b: limit(10), expected: 'b', switched: true, reason: /credits_depleted/ },
    { name: 'unknown limits rank below known limits', main: { known: false }, b: limit(10),
      expected: 'b', mainKnown: false },
    { name: 'second account is logged out', main: { known: false }, b: limit(10, false),
      expected: 'main', mainKnown: false, secondReason: /not logged in/ }
  ];
  for (const {
    name, main, b, previousActive = 'main', marks = {}, expected, switched = false, mainKnown = true, reason, secondReason
  } of scenarios) {
    const selected = selectAccount({ accounts, usage: { main, b }, marks, previousActive, threshold, now });
    assert.equal(selected.active, expected, name);
    assert.equal(selected.allExhausted, expected === null, name);
    assert.equal(selected.accounts[0].switched, switched, name);
    assert.equal(selected.accounts[0].known, mainKnown, name);
    if (reason) assert.match(selected.accounts[0].reason, reason, name);
    if (secondReason) assert.match(selected.accounts[1].reason, secondReason, name);
  }
});

test('provider state resolves Codex to b until both accounts hit the threshold', async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'codex-accounts-state-'));
  const base = path.join(home, 'luna-run'), secondRun = path.join(base, 'accounts', 'b');
  const secondHome = path.join(home, '.codex-accounts', 'b');
  const env = {
    HOME: home, USERPROFILE: home, LUNA_DAEMON_HOME: base, LUNA_RUN_DIR: base,
    CONVEYOR_HOME: path.join(home, 'conveyor'), CONVEYOR_LUNA_SH: path.join(scripts, 'luna.sh')
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const now = Date.now();
  const writeLimits = (dir, usedPercent) => fs.writeFile(path.join(dir, 'codex-limits.json'), JSON.stringify({
    at: now, primary: { usedPercent, windowMins: 300 }
  }));
  try {
    const config = { ...await readJson(configFile), codex_accounts: accounts, thresholds: { codex: threshold } };
    await fs.mkdir(secondRun, { recursive: true });
    await fs.mkdir(secondHome, { recursive: true });
    await fs.writeFile(path.join(secondHome, 'auth.json'), '');
    await writeLimits(base, 80);
    await writeLimits(secondRun, 10);
    let state = await providerState(config, { now });
    let { selected } = await resolveChain('complex', { config, state, now });
    assert.equal(state.threshold.active, 'b');
    assert.equal(selected.provider, 'codex');
    assert.equal(selected.active, 'b');
    assert.equal((await readJson(path.join(env.CONVEYOR_HOME, 'providers.json'))).codex.active, 'b');
    await writeLimits(secondRun, 80);
    state = await providerState(config, { now });
    const { chain } = await resolveChain('complex', { config, state, now });
    assert.equal(state.threshold.active, null);
    assert.equal(chain[0].provider, 'codex');
    assert.equal(chain[0].available, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('luna.sh starts the pinned account daemon and gives the app-server its Codex home', { timeout: 300_000 }, async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "codex account's wrapper-"));
  const base = path.join(home, 'daemon'), configDir = path.join(home, '.claude', 'conveyor');
  const secondHome = path.join(home, '.codex-accounts', 'b');
  const daemon = path.join(base, 'accounts', 'b', 'daemon.json');
  const audit = path.join(home, 'audit.jsonl'), out = path.join(home, 'answer.md');
  const stub = path.join(scripts, 'lib', 'luna-daemon-stub.mjs');
  const env = {
    ...process.env, HOME: home, CONVEYOR_HOME: configDir, LUNA_DAEMON_HOME: base, LUNA_CODEX_ACCOUNT: 'b',
    LUNA_DAEMON: '1', LUNA_CODEX_BIN: process.execPath, LUNA_DAEMON_APP_SERVER_CMD: JSON.stringify([process.execPath, stub, audit]),
    LUNA_NO_GATE: '1', LUNA_RAM_RESERVE_MB: '0', LUNA_DAEMON_TURN_MB: '0', LUNA_DAEMON_RAMP_MS: '10', LUNA_RAMP_S: '0',
    LUNA_NO_PREAMBLE: '1', LUNA_NO_REGISTRY: '1', LUNA_NO_REFUSAL_RETRY: '1', LUNA_MODEL_RETRIES: '0'
  };
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(secondHome, { recursive: true });
    await fs.writeFile(path.join(secondHome, 'auth.json'), '');
    await fs.writeFile(path.join(configDir, 'orchestration.json'), JSON.stringify({
      ...await readJson(configFile), codex_accounts: accounts
    }));
    await run('bash', [path.join(scripts, 'luna.sh'), '-C', home, '-o', out, 'fixture prompt'], { env, timeout: 300_000 });
    assert.ok((await readJson(daemon)).pid);
    const status = await fs.readFile(`${out}.status`, 'utf8');
    assert.match(status, /^account=b$/m);
    assert.match(status, /^engine=daemon$/m);
    assert.match(status, /^state=done$/m);
    const events = (await fs.readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.find(({ event }) => event === 'spawn').codexHome, secondHome);
  } finally {
    try {
      const info = await readJson(daemon).catch(() => null);
      if (info && matchingProcess(info.pid, info.pid_start)) {
        process.kill(info.pid, 'SIGTERM');
        for (let i = 0; i < 100 && matchingProcess(info.pid, info.pid_start); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (matchingProcess(info.pid, info.pid_start)) process.kill(info.pid, 'SIGKILL');
        if (matchingProcess(info.appServerPid, info.appServerStart)) process.kill(-info.appServerPid, 'SIGKILL');
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});
