import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig, validateConfig, saveConfig, applyPreset, markUnavailable, resolveChain, paths
} from '../lib/orchestration.mjs';

const cli = fileURLToPath(new URL('../exec.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-wrapper.sh', import.meta.url));
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const timeout = 300_000;
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readLines = async (file) => (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

async function environment() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor exec test-'));
  const changes = {
    CONVEYOR_HOME: path.join(root, 'home'), LUNA_RUN_DIR: path.join(root, 'luna-run'),
    CONVEYOR_LUNA_SH: fixture, CONVEYOR_GEM_SH: fixture, CLAUDE_HOME_DIR: path.join(root, 'claude')
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const dir = path.join(root, 'repo'), brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md');
  return {
    root, dir, brief, out,
    async setup() {
      await fs.mkdir(dir);
      await fs.mkdir(changes.LUNA_RUN_DIR);
      await fs.writeFile(brief, 'Inspect the fixture.\n');
    },
    command(args, extraEnv = {}) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024
      });
      assert.ifError(result.error);
      return result;
    },
    run(tier, mode = '-r', extraEnv = {}, extraArgs = []) {
      return this.command(['run', '--tier', tier, mode, '-C', dir, '-f', brief, '-o', out, ...extraArgs], extraEnv);
    },
    async limits(percent, { at = new Date().toISOString(), net = false, secondary = 10 } = {}) {
      const dir = net ? path.join(changes.LUNA_RUN_DIR, 'daemon-net') : changes.LUNA_RUN_DIR;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'codex-limits.json'), JSON.stringify({
        v: 1, at, primary: { usedPercent: percent, windowMins: 300 },
        secondary: { usedPercent: secondary, windowMins: 10080 }
      }));
    },
    async cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test('validation rejects invalid schema; atomic saves journal a diff', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const config = await loadConfig();
    assert.deepEqual(config, await readJson(defaultFile));
    assert.equal(validateConfig(config), config);
    const invalid = (change, message) => {
      const copy = structuredClone(config);
      change(copy);
      assert.throws(() => validateConfig(copy), message);
    };
    invalid((copy) => { copy.tiers.complex[0].model = 'gpt-6-astra'; }, /gpt-6-astra is forbidden by user rule/);
    invalid((copy) => { copy.catalog.codex[0].model = 'gpt-6-astra'; }, /gpt-6-astra is forbidden by user rule/);
    invalid((copy) => { copy.tiers.complex[0].provider = 'other'; }, /unknown provider other/);
    invalid((copy) => { copy.tiers.complex[0].effort = 'ultra'; }, /effort ultra is not in catalog/);
    invalid((copy) => { copy.extra = true; }, /unknown top-level key: extra/);
    invalid((copy) => { copy.tiers.complex = []; }, /tiers.complex must be a non-empty array/);
    invalid((copy) => { copy.tiers.complex[0].model = 'missing'; }, /model codex\/missing is not in catalog/);
    invalid((copy) => { copy.thresholds.codex.switch_percent = 101; }, /switch_percent must be between 1 and 100/);
    invalid((copy) => { copy.thresholds.codex.hysteresis_percent = -1; },
      /hysteresis_percent must be between 0 and 50/);
    invalid((copy) => { copy.roles.critic = 'tier:missing'; }, /roles.critic: unknown tier missing/);
    invalid((copy) => { copy.roles.critic = 'panel:missing'; }, /roles.critic: unknown panel missing/);
    invalid((copy) => { copy.roles.critic = 'review'; }, /expected tier:<name> or panel:<name>/);
    invalid((copy) => { copy.panels.design[0].effort = 'ultra'; }, /effort ultra is not in catalog/);
    invalid((copy) => { copy.panels.judge = []; }, /panels.judge must be a non-empty array/);
    invalid((copy) => { copy.presets.bad = { label: 'Bad', tiers: { simple: [] } }; },
      /presets.bad.tiers.simple must be a non-empty array/);
    invalid((copy) => { copy.presets.bad = { label: '', tiers: {} }; }, /presets.bad.label must be a non-empty string/);
    await assert.rejects(fs.stat(paths().config), { code: 'ENOENT' });
    config.thresholds.codex.switch_percent = 81;
    await fs.mkdir(paths().journal, { recursive: true });
    await assert.rejects(saveConfig(config, { actor: 'panel', note: 'journal unavailable' }), { code: 'EISDIR' });
    await assert.rejects(fs.stat(paths().config), { code: 'ENOENT' });
    await fs.rmdir(paths().journal);
    await saveConfig(config, { actor: 'panel', note: 'threshold control' });
    assert.deepEqual(await readJson(paths().config), config);
    const [journal, applied] = await readLines(paths().journal);
    assert.equal(journal.status, 'applying');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.id, journal.id);
    assert.equal(journal.actor, 'panel');
    assert.equal(journal.note, 'threshold control');
    assert.deepEqual(journal.before, await readJson(defaultFile));
    assert.ok(Number.isFinite(Date.parse(journal.at)));
    assert.deepEqual(journal.diff, { 'thresholds.codex.switch_percent': [80, 81] });
    const before = await fs.readFile(paths().config, 'utf8');
    config.thresholds.codex.switch_percent = 0;
    await assert.rejects(saveConfig(config, { actor: 'cli', note: 'invalid' }), /switch_percent/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    assert.deepEqual((await fs.readdir(paths().home)).sort(), ['orchestration.json', 'orchestration.log.jsonl']);
  } finally { await env.cleanup(); }
});

test('Codex threshold persists hysteresis, hands off to Sonnet, and ignores stale limits', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    await env.limits(99, { at: new Date(Date.now() - 60_000).toISOString() });
    await env.limits(83, { net: true });
    const sessions = path.join(paths().run, 'sessions');
    await fs.mkdir(sessions);
    await fs.writeFile(path.join(sessions, 'live.json'), JSON.stringify({
      v: 1, sessionId: 'live', updatedAt: Date.now(), limits: [{ kind: 'five_hour', percentUsed: 96 }]
    }));
    const first = env.command(['resolve', '--tier', 'complex', '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).selected.model, 'sonnet');
    assert.match(JSON.parse(first.stdout).chain[0].reason, /codex 83% ≥ 80% \(5h window\)/);
    const handoff = env.run('complex');
    assert.equal(handoff.status, 4, handoff.stderr);
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.action, 'claude-subagent');
    assert.equal(dispatch.model, 'sonnet');
    assert.equal(dispatch.effort, 'high');
    assert.equal(dispatch.mode, 'read');
    assert.equal(dispatch.brief, path.resolve(env.brief));
    assert.equal(dispatch.out, path.resolve(env.out));
    assert.equal(dispatch.dir, path.resolve(env.dir));
    assert.equal(dispatch.warning, 'claude near limit');
    assert.deepEqual(JSON.parse(handoff.stdout), dispatch);
    assert.deepEqual(dispatch.attempts, []);
    assert.equal((await readJson(paths().providers)).codex.switched, true);
    await env.limits(78, { net: true });
    assert.equal((await resolveChain('complex')).selected.provider, 'claude');
    await env.limits(75, { net: true });
    assert.equal((await resolveChain('complex')).selected.provider, 'claude');
    await env.limits(74, { net: true });
    assert.equal((await resolveChain('complex')).selected.provider, 'codex');
    assert.equal((await readJson(paths().providers)).codex.switched, false);
    await env.limits(10, { net: true, secondary: 85 });
    assert.equal((await resolveChain('complex')).selected.provider, 'claude');
    const stale = new Date(Date.now() - 1801_000).toISOString();
    await env.limits(99, { at: stale });
    await env.limits(99, { at: stale, net: true });
    assert.equal((await resolveChain('complex')).selected.provider, 'codex');
  } finally { await env.cleanup(); }
});

test('Gemini exit 3 falls back, archives artifacts, and journals a cooldown and switch', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const run = env.run('simple', '-w', {
      FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'starting'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /codex gpt-6-luna high write/);
    const mark = (await readJson(paths().providers)).gemini;
    assert.equal(mark.reason, 'quota');
    assert.equal(Date.parse(mark.until) - Date.parse(mark.at), 1800_000);
    const resolved = env.command(['resolve', '--tier', 'simple', '--json']);
    const chain = JSON.parse(resolved.stdout);
    assert.equal(chain.chain[0].available, false);
    assert.match(chain.chain[0].reason, /gemini unavailable until .*: quota/);
    assert.equal(chain.selected.provider, 'codex');
    const switches = await readLines(paths().switches);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].tier, 'simple');
    assert.equal(switches[0].from, 'gemini');
    assert.equal(switches[0].to, 'codex');
    assert.equal(switches[0].out, env.out);
    assert.match(switches[0].reason, /quota/);
    assert.equal(run.stderr.trim().split('\n').length, 1);
    assert.match(run.stderr, /conveyor: simple: gemini → codex \(quota: quota\)/);
    assert.equal((await readJson(`${env.out}.dispatch.json`)).provider, 'codex');
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.attempts.length, 2);
    assert.equal(dispatch.attempts[0].retry, true);
    assert.equal(dispatch.attempts[1].code, 0);
    assert.match(await fs.readFile(`${env.out}.attempt-gemini.status`, 'utf8'), /unavailable_reason=quota/);
    assert.match(await fs.readFile(`${env.out}.attempt-gemini.out`, 'utf8'), /gemini/);
    assert.match(await fs.readFile(`${env.out}.attempt-gemini.log`, 'utf8'), /gemini-3.8-flash/);
    assert.deepEqual((await fs.readFile(`${env.out}.log`, 'utf8')).trim().split('\n'), [
      '-w', '-m', 'gpt-6-luna', '-e', 'high', '-C', env.dir, '-f', env.brief, '-o', env.out
    ]);
    const marks = await readJson(paths().providers);
    marks.gemini.until = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(paths().providers, JSON.stringify(marks));
    assert.equal((await resolveChain('simple')).selected.provider, 'gemini');
  } finally { await env.cleanup(); }
});

test('a write wrapper that runs, edits a file and hits quota is never retried', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const run = env.run('complex', '-w', {
      FAKE_CODEX_RC: '17', FAKE_CODEX_ERROR: 'Usage limit reached; quota exhausted', FAKE_CODEX_MODIFY: '1'
    });
    assert.equal(run.status, 17, run.stderr);
    assert.equal(await fs.readFile(path.join(env.dir, 'changed-by-codex.txt'), 'utf8'), 'changed\n');
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.action, 'run-wrapper');
    assert.equal(dispatch.attempts.length, 1);
    assert.equal(dispatch.attempts[0].reached_running, true);
    assert.equal(dispatch.attempts[0].retry, false);
    assert.equal(dispatch.code, 17);
    assert.equal((await readJson(paths().providers)).codex.reason, 'quota');
    await assert.rejects(fs.stat(paths().switches), { code: 'ENOENT' });
    assert.doesNotMatch(run.stdout, /claude-subagent/);
  } finally { await env.cleanup(); }
});

test('running write jobs never fall back even without edits; running read-only jobs do fall back',
  { timeout }, async () => {
    for (const mode of ['-w', '-r']) {
      const env = await environment();
      try {
        await env.setup();
        const run = env.run('simple', mode, {
          FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'running',
          FAKE_WRAPPER_DELAY_S: '1.1'
        });
        assert.equal(run.status, mode === '-w' ? 3 : 0, run.stderr);
        assert.deepEqual(await fs.readdir(env.dir), [], 'the wrapper did not change the project');
        const dispatch = await readJson(`${env.out}.dispatch.json`);
        assert.equal(dispatch.attempts[0].reached_running, true);
        assert.equal(dispatch.attempts[0].retry, mode === '-r');
        assert.equal(dispatch.attempts.length, mode === '-w' ? 1 : 2);
        if (mode === '-w') await assert.rejects(fs.stat(paths().switches), { code: 'ENOENT' });
        else assert.equal(dispatch.provider, 'codex');
      } finally { await env.cleanup(); }
    }
  });

test('stale config and provider locks are reclaimed for dead and reused process identities', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    await fs.mkdir(paths().home);
    const config = await loadConfig();
    await fs.writeFile(`${paths().config}.lock`, JSON.stringify({ pid: 2147483647, pid_start: '1' }));
    await saveConfig(config, { actor: 'cli', note: 'reclaim dead owner' });
    await assert.rejects(fs.stat(`${paths().config}.lock`), { code: 'ENOENT' });
    await fs.writeFile(`${paths().providers}.lock`, JSON.stringify({ pid: process.pid, pid_start: '0' }));
    await markUnavailable('gemini', 'quota', 'reclaim reused pid');
    assert.equal((await readJson(paths().providers)).gemini.reason, 'quota');
    await assert.rejects(fs.stat(`${paths().providers}.lock`), { code: 'ENOENT' });
    assert.ok((await fs.readdir(paths().home)).every((name) => !name.endsWith('.stale')));
  } finally { await env.cleanup(); }
});

test('panel runs keep the chosen seat and unavailable seats return 5 with their reason', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const args = ['run', '--panel', 'design', '--seat', '1', '-r', '-C', env.dir, '-f', env.brief, '-o', env.out];
    const run = env.command(args);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /gemini gemini-3.8-flash high read/);
    let dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.panel, 'design');
    assert.equal(dispatch.seat, 1);
    assert.equal(dispatch.attempts.length, 1);
    const failed = env.command(args, {
      FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'starting'
    });
    assert.equal(failed.status, 3, failed.stderr);
    dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.attempts.length, 1);
    assert.equal(dispatch.attempts[0].retry, false);
    const unavailable = env.command(args);
    assert.equal(unavailable.status, 5, unavailable.stderr);
    assert.match(unavailable.stderr, /gemini unavailable until .*: quota/);
    assert.deepEqual((await readJson(`${env.out}.dispatch.json`)).attempts, []);
    await env.limits(83);
    args[4] = '0';
    const threshold = env.command(args);
    assert.equal(threshold.status, 5, threshold.stderr);
    assert.match(threshold.stderr, /codex 83% ≥ 80%/);
    await assert.rejects(fs.stat(paths().switches), { code: 'ENOENT' });
    const role = env.command(['run', '--role', 'arena runners', '--seat', '1', '-w',
      '-C', env.dir, '-f', env.brief, '-o', env.out]);
    assert.equal(role.status, 5, role.stderr);
    assert.equal((await readJson(`${env.out}.dispatch.json`)).panel, 'design');
  } finally { await env.cleanup(); }
});

test('judge resolution lists seats and first-available selects the earliest available seat', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const args = ['resolve', '--panel', 'judge', '--json'];
    const listed = env.command(args);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).selected, null);
    assert.deepEqual(JSON.parse(listed.stdout).seats.map((entry) => entry.seat), [0, 1]);
    args.push('--first-available');
    const first = env.command(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).selected.provider, 'gemini');
    assert.equal(JSON.parse(first.stdout).selected.seat, 0);
    await markUnavailable('gemini', 'quota', 'fixture');
    const second = env.command(['resolve', '--role', 'arena cross-judge pool', '--first-available', '--json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).panel, 'judge');
    assert.equal(JSON.parse(second.stdout).selected.provider, 'codex');
    assert.equal(JSON.parse(second.stdout).selected.seat, 1);
    await env.limits(83);
    const none = env.command(args);
    assert.equal(none.status, 5, none.stderr);
    assert.equal(JSON.parse(none.stdout).selected, null);
    assert.ok(JSON.parse(none.stdout).seats.every((entry) => !entry.available));
  } finally { await env.cleanup(); }
});

test('all providers skipped returns exit 5 with reasons and a status snapshot', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    for (const provider of ['codex', 'gemini', 'claude']) await markUnavailable(provider, 'quota', 'fixture quota');
    const run = env.run('simple');
    assert.equal(run.status, 5, run.stderr);
    for (const provider of ['codex', 'gemini', 'claude']) {
      assert.match(run.stderr, new RegExp(`${provider} unavailable until`));
    }
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.action, 'unavailable');
    assert.equal(dispatch.selected, null);
    assert.deepEqual(dispatch.attempts, []);
    const resolve = env.command(['resolve', '--tier', 'simple', '--json']);
    assert.equal(resolve.status, 5, resolve.stderr);
    assert.ok(JSON.parse(resolve.stdout).chain.every((entry) => !entry.available));
    const status = env.command(['status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const result = JSON.parse(status.stdout);
    assert.deepEqual(Object.keys(result.tiers).sort(), ['complex', 'review', 'scout', 'simple']);
    assert.equal(result.providers.claude.reason, 'quota');
    assert.equal(result.usage.codex.known, false);
    assert.equal(result.usage.claude.known, false);
  } finally { await env.cleanup(); }
});

test('roles render and override tiers; labelled presets validate and journal changes', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const config = await loadConfig();
    config.roles.auditor = 'tier:review';
    config.presets.economy = {
      label: 'Экономия', tiers: { complex: [{ provider: 'claude', model: 'haiku', effort: 'medium' }] }
    };
    await saveConfig(config, { actor: 'panel', note: 'roles and presets' });
    const run = env.run('simple', '-r', {}, ['--role', 'auditor']);
    assert.equal(run.status, 0, run.stderr);
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.tier, 'review');
    assert.equal(dispatch.role, 'auditor');
    assert.equal(dispatch.provider, 'codex');
    assert.equal(dispatch.model, 'gpt-6-luna');
    const get = env.command(['config', 'get', 'roles.auditor']);
    assert.equal(get.status, 0, get.stderr);
    assert.equal(JSON.parse(get.stdout), 'tier:review');
    const render = env.command(['roles', 'render']);
    assert.equal(render.status, 0, render.stderr);
    const generated = path.join(process.env.CLAUDE_HOME_DIR, 'rules', 'pstack-models.md');
    const content = await fs.readFile(generated, 'utf8');
    assert.match(content, /^# Generated from orchestration.json.\n# Edit through the Luna panel.\n/);
    assert.match(content, /\n# defaults: 2\n# budget: large\n/);
    for (const [role, target] of Object.entries(config.roles)) {
      const [kind, name] = target.split(':');
      const seats = kind === 'panel' ? ' = ' + config.panels[name]
        .map((entry) => `${entry.provider}/${entry.model}/${entry.effort}`).join(', ') : '';
      assert.ok(content.split('\n').includes(`${role}: ${kind} ${name}${seats}`));
    }
    const custom = path.join(env.root, 'custom-models.md');
    const customRender = env.command(['roles', 'render', '--out', custom]);
    assert.equal(customRender.status, 0, customRender.stderr);
    assert.equal(await fs.readFile(custom, 'utf8'), content);
    assert.deepEqual(await fs.readdir(path.dirname(generated)), ['pstack-models.md']);
    const set = env.command(['config', 'set', 'thresholds.codex.switch_percent', '82']);
    assert.equal(set.status, 0, set.stderr);
    const before = await fs.readFile(paths().config, 'utf8');
    const invalid = env.command(['config', 'set', 'thresholds.codex.switch_percent', '0']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /switch_percent must be between 1 and 100/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    const validate = env.command(['config', 'validate']);
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(validate.stdout, 'valid\n');
    const preset = env.command(['config', 'preset', 'economy']);
    assert.equal(preset.status, 0, preset.stderr);
    assert.deepEqual((await loadConfig()).tiers.complex, config.presets.economy.tiers.complex);
    assert.equal((await loadConfig()).presets.economy.label, 'Экономия');
    const journal = (await readLines(paths().journal)).filter((entry) => entry.status === 'applied');
    assert.equal(journal.length, 3);
    assert.equal(journal.at(-1).actor, 'cli');
    assert.equal(journal.at(-1).note, 'preset economy');
    assert.deepEqual(journal.at(-1).diff['tiers.complex.0.model'], ['gpt-6.1-sol', 'haiku']);
    assert.deepEqual((await applyPreset('economy')).tiers.complex, config.presets.economy.tiers.complex);
    assert.deepEqual((await readLines(paths().journal)).at(-1).diff, {});
  } finally { await env.cleanup(); }
});

function action(env, args, extraEnv = {}) {
  const result = env.command(args, extraEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ['ok', 'changed', 'note']);
  assert.equal(value.ok, true);
  assert.equal(typeof value.changed, 'boolean');
  assert.equal(typeof value.note, 'string');
  return value;
}

test('set-entry validates catalog efforts, edits panel seats and journals the panel actor', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const target = ['--tier', 'complex', '--index', '0', '--provider', 'codex', '--model', 'gpt-6.1-sol'];
    const edited = action(env, ['config', 'set-entry', ...target, '--effort', 'high', '--actor', 'panel']);
    assert.equal(edited.changed, true);
    assert.equal((await loadConfig()).tiers.complex[0].effort, 'high');
    const before = await fs.readFile(paths().config, 'utf8');
    const journalBefore = await fs.readFile(paths().journal, 'utf8');
    const invalid = env.command(['config', 'set-entry', ...target, '--effort', 'ultra', '--actor', 'panel']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /effort ultra is not in catalog/);
    assert.equal(invalid.stderr.trim().split('\n').length, 1);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    assert.equal(await fs.readFile(paths().journal, 'utf8'), journalBefore);
    action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
      '--model', 'gemini-3.8-flash', '--effort', 'low', '--actor', 'panel']);
    assert.deepEqual((await loadConfig()).panels.design[1], {
      provider: 'gemini', model: 'gemini-3.8-flash', effort: 'low'
    });
    const journal = (await readLines(paths().journal)).filter((entry) => entry.status === 'applied');
    assert.deepEqual(journal.map((entry) => entry.actor), ['panel', 'panel']);
  } finally { await env.cleanup(); }
});

test('entry actions insert, move and remove; the last chain entry cannot be removed', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const initial = (await loadConfig()).tiers.simple;
    const entry = { provider: 'claude', model: 'sonnet', effort: 'low' };
    action(env, ['config', 'add-entry', '--tier', 'simple', '--provider', entry.provider,
      '--model', entry.model, '--effort', entry.effort, '--at', '1']);
    assert.deepEqual((await loadConfig()).tiers.simple, [initial[0], entry, ...initial.slice(1)]);
    action(env, ['config', 'move-entry', '--tier', 'simple', '--index', '1', '--to', '3']);
    assert.deepEqual((await loadConfig()).tiers.simple, [...initial, entry]);
    action(env, ['config', 'remove-entry', '--tier', 'simple', '--index', '3']);
    assert.deepEqual((await loadConfig()).tiers.simple, initial);
    assert.equal(action(env, ['config', 'move-entry', '--tier', 'simple', '--index', '0', '--to', '0']).changed, false);
    action(env, ['config', 'remove-entry', '--tier', 'complex', '--index', '1']);
    const before = await fs.readFile(paths().config, 'utf8');
    const empty = env.command(['config', 'remove-entry', '--tier', 'complex', '--index', '0']);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /cannot remove the last entry/);
    const pastEnd = env.command(['config', 'move-entry', '--tier', 'simple', '--index', '0', '--to', '3']);
    assert.equal(pastEnd.status, 1);
    assert.match(pastEnd.stderr, /zero-based index/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    assert.ok((await readLines(paths().journal)).every((entry) => entry.actor === 'cli'));
  } finally { await env.cleanup(); }
});

test('threshold edits preserve omitted hysteresis and reject out-of-range values', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    action(env, ['config', 'threshold', '--percent', '85', '--hysteresis', '7', '--actor', 'panel']);
    assert.deepEqual((await loadConfig()).thresholds.codex, {
      switch_percent: 85, hysteresis_percent: 7, windows: ['primary', 'secondary']
    });
    action(env, ['config', 'threshold', '--percent', '82']);
    assert.equal((await loadConfig()).thresholds.codex.hysteresis_percent, 7);
    const before = await fs.readFile(paths().config, 'utf8');
    for (const args of [['--percent', '0'], ['--percent', '101'], ['--percent', '80', '--hysteresis', '51']]) {
      const result = env.command(['config', 'threshold', ...args]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be between/);
      assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    }
  } finally { await env.cleanup(); }
});

test('save-preset snapshots every tier and preset restores it with its label', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const initial = (await loadConfig()).tiers;
    action(env, ['config', 'save-preset', '--name', 'my-chains', '--label', 'Мои цепочки', '--actor', 'panel']);
    action(env, ['config', 'set-entry', '--tier', 'complex', '--index', '0', '--provider', 'claude',
      '--model', 'haiku', '--effort', 'medium']);
    assert.notDeepEqual((await loadConfig()).tiers, initial);
    action(env, ['config', 'preset', 'my-chains', '--actor', 'panel']);
    const config = await loadConfig();
    assert.deepEqual(config.tiers, initial);
    assert.deepEqual(config.presets['my-chains'], { label: 'Мои цепочки', tiers: initial });
    const before = await fs.readFile(paths().config, 'utf8');
    for (const args of [['preset', 'absent'], ['save-preset', '--name', '../bad', '--label', 'Bad']]) {
      assert.equal(env.command(['config', ...args]).status, 1);
      assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    }
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
  } finally { await env.cleanup(); }
});

test('undo twice restores successive full configs and never toggles previous undos', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const initial = await loadConfig();
    const empty = env.command(['config', 'undo']);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /nothing to undo/);
    action(env, ['config', 'threshold', '--percent', '82']);
    const first = await loadConfig();
    action(env, ['config', 'threshold', '--percent', '88', '--hysteresis', '6']);
    const second = await loadConfig();
    action(env, ['config', 'threshold', '--percent', '88', '--hysteresis', '6']);
    action(env, ['config', 'undo', '--actor', 'panel']);
    assert.deepEqual(await loadConfig(), first);
    action(env, ['config', 'undo', '--actor', 'panel']);
    assert.deepEqual(await loadConfig(), initial);
    const journal = await readLines(paths().journal);
    const applying = journal.filter((entry) => entry.status === 'applying');
    assert.deepEqual(applying.map((entry) => entry.before), [initial, first, second, second, first]);
    assert.equal(applying[3].note, `undo ${applying[1].id}`);
    assert.equal(applying[4].note, `undo ${applying[0].id}`);
    assert.equal(applying[3].actor, 'panel');
    assert.equal(applying[4].actor, 'panel');
    const before = await fs.readFile(paths().config, 'utf8');
    const exhausted = env.command(['config', 'undo']);
    assert.equal(exhausted.status, 1);
    assert.match(exhausted.stderr, /nothing to undo/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    action(env, ['config', 'threshold', '--percent', '90']);
    action(env, ['config', 'undo']);
    assert.deepEqual(await loadConfig(), initial);
    assert.equal(env.command(['config', 'undo']).status, 1);
  } finally { await env.cleanup(); }
});

test('catalog refresh adds Gemini families from a fake command and keeps existing models', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const initial = structuredClone((await loadConfig()).catalog);
    const listing = ['gemini-9-pro-low\tPro low', 'gemini-9-pro-medium\tPro medium', 'gemini-9-pro-high\tPro high',
      'gemini-3.8-flash-high\tFlash high', 'claude-sonnet-4-6\tSonnet', 'invalid line'].join('\n') + '\n';
    const command = { CONVEYOR_AGY_MODELS_CMD: JSON.stringify([
      process.execPath, '-e', `process.stdout.write(${JSON.stringify(listing)})`
    ]) };
    const refreshed = action(env, ['catalog', 'refresh', '--provider', 'gemini', '--actor', 'panel'], command);
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.note, 'added gemini-9-pro');
    const expected = { ...initial, gemini: [...initial.gemini, { model: 'gemini-9-pro', efforts: ['low', 'medium', 'high'] }] };
    assert.deepEqual((await loadConfig()).catalog, expected);
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
    assert.equal(action(env, ['catalog', 'refresh', '--provider', 'gemini'], command).changed, false);
    assert.deepEqual((await loadConfig()).catalog, expected);
    const before = await fs.readFile(paths().config, 'utf8');
    const failed = env.command(['catalog', 'refresh', '--provider', 'gemini'], {
      CONVEYOR_AGY_MODELS_CMD: JSON.stringify([process.execPath, '-e', 'process.stderr.write("fake error\\n"); process.exit(1)'])
    });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.trim().split('\n').length, 1);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
  } finally { await env.cleanup(); }
});

test('catalog add/remove validate efforts and refuse models referenced by tiers or panels', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    action(env, ['catalog', 'add', '--provider', 'gemini', '--model', 'gemini-9-panel', '--efforts', 'low,medium,high']);
    let before = await fs.readFile(paths().config, 'utf8');
    const invalid = env.command(['catalog', 'add', '--provider', 'gemini', '--model', 'gemini-bad', '--efforts', 'low,,high']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /catalog effort must be a non-empty string/);
    const tier = env.command(['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-3.8-flash']);
    assert.equal(tier.status, 1);
    assert.match(tier.stderr, /is in use by a tier or panel/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
      '--model', 'gemini-9-panel', '--effort', 'high']);
    before = await fs.readFile(paths().config, 'utf8');
    const panel = env.command(['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-9-panel']);
    assert.equal(panel.status, 1);
    assert.match(panel.stderr, /is in use by a tier or panel/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
      '--model', 'gemini-3.8-flash', '--effort', 'high']);
    action(env, ['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-9-panel', '--actor', 'panel']);
    assert.ok(!(await loadConfig()).catalog.gemini.some((entry) => entry.model === 'gemini-9-panel'));
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
  } finally { await env.cleanup(); }
});
