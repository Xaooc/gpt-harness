import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main as execMain } from '../exec.mjs';
import { gitState, invoke, shellQuote, shellLog } from './process-fixture.mjs';
import {
  loadConfig, validateConfig, saveConfig, applyPreset, markUnavailable, resolveChain, paths
} from '../lib/orchestration.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-wrapper.sh', import.meta.url));
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const timeout = 600_000;
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readLines = async (file) => (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

async function environment() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'conveyor exec test-'));
  const changes = {
    CONVEYOR_HOME: path.join(root, 'home'), LUNA_RUN_DIR: path.join(root, 'luna-run'),
    CONVEYOR_LUNA_SH: fixture, CONVEYOR_GEM_SH: fixture, CLAUDE_HOME_DIR: path.join(root, 'claude'),
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    CLAUDE_CODE_SESSION_ID: 'gate-session', CONVEYOR_GATE_ROUNDS: '2'
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
      await fs.mkdir(path.join(root, 'bin'));
      await fs.writeFile(path.join(root, 'bin', 'git'), `#!/bin/bash
state_file=${shellQuote(path.join(root, 'git.json'))}
[ -f "$state_file" ] || exit 128
source "$state_file.sh"
shift 2
case "$1" in
  rev-parse)
    if [ "$2" = --show-toplevel ]; then printf '%s' ${shellQuote(dir)}; else printf '%s' "$head"; fi
    exit 0 ;;
  diff) names=$working ;;
  log) names=$committed ;;
  ls-files) if [[ " $* " == *' --cached '* ]]; then names=$files; else names=$untracked; fi ;;
  *) printf 'unexpected fake git arguments: %s\\n' "$*" >&2; exit 1 ;;
esac
eval "set -- $names"
if [ "$#" -gt 0 ]; then printf '%s\\0' "$@"; fi
`, { mode: 0o755 });
    },
    async command(args, extraEnv = {}) {
      return invoke(execMain, args, {
        env: { ...process.env, ...extraEnv }, prefix: 'conveyor', captureChildren: true
      });
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

async function gateFixture(env, scenario = 'green', mode = 'block') {
  const stateFile = path.join(env.root, 'git.json'), calls = path.join(env.root, 'launches.jsonl');
  const checks = path.join(env.root, 'checks.jsonl'), wrapper = path.join(env.root, 'gate-wrapper.sh');
  const checker = path.join(env.root, 'check.sh');
  await fs.mkdir(path.join(env.dir, '.claude'));
  await fs.writeFile(path.join(env.dir, '.claude', 'conveyor.json'), JSON.stringify({ gate: { mode } }));
  for (const file of ['source.js', 'dirty.txt', 'old.txt', 'source.test.js']) {
    await fs.writeFile(path.join(env.dir, file), 'before\n');
  }
  const initial = {
    head: 'fixture-base', working: ['dirty.txt'], untracked: ['old.txt'],
    files: ['source.js', 'dirty.txt', 'old.txt', 'source.test.js', '.claude/conveyor.json']
  };
  await fs.writeFile(stateFile, JSON.stringify(initial));
  await fs.writeFile(`${stateFile}.sh`, gitState(initial));
  await fs.writeFile(wrapper, `#!/bin/bash
${shellLog}
calls=${shellQuote(calls)}
state_file=${shellQuote(stateFile)}
json_args "$@" >> "$calls"
printf '\\n' >> "$calls"
round=$(wc -l < "$calls")
while [ "$#" -gt 1 ]; do
  case "$1" in -C) dir=$2;; -o) out=$2;; esac
  shift
done
printf 'change %s\\n' "$round" > "$dir/source.js"
printf 'new\\n' > "$dir/new.txt"
printf 'committed\\n' > "$dir/committed.js"
working=('dirty.txt' 'source.js')
untracked=('old.txt' 'new.txt')
committed=('committed.js')
files=('source.js' 'dirty.txt' 'old.txt' 'source.test.js' '.claude/conveyor.json' 'new.txt' 'committed.js')
if [ "$round" -gt 1 ]; then
  case "$FAKE_GATE_SCENARIO" in
    weaken) printf 'export default [];\\n' > "$dir/eslint.config.js"; files+=('eslint.config.js') ;;
    edit-tests) printf 'weakened test\\n' > "$dir/source.test.js" ;;
    delete-tests) rm -- "$dir/source.test.js" ;;
    add-tests) printf 'new test\\n' > "$dir/new.test.js"; files+=('new.test.js'); untracked+=('new.test.js') ;;
  esac
fi
printf 'head=fixture-head\\n' > "$state_file.sh"
printf '{"head":"fixture-head"' > "$state_file"
for key in working untracked committed files; do
  declare -n names=$key
  printf -v encoded '%q ' "${'${'}names[@]}"
  printf '%s=%q\\n' "$key" "$encoded" >> "$state_file.sh"
  { printf ',"%s":' "$key"; json_args "${'${'}names[@]}"; } >> "$state_file"
done
printf '}' >> "$state_file"
printf 'Requested change done.\\n' > "$out"
printf 'state=done\\n' > "$out.status"
`);
  await fs.writeFile(checker, `#!/bin/bash
${shellLog}
json_args "$@" >> ${shellQuote(checks)}
printf '\\n' >> ${shellQuote(checks)}
round=$(wc -l < ${shellQuote(calls)})
while [ "$#" -gt 1 ]; do
  case "$1" in --level) level=$2;; --dir) repo=$2;; --base) base=$2;; --files) files=$2;; esac
  shift
done
ok=false
if [ "$FAKE_GATE_SCENARIO" = green ]; then ok=true
elif [ "$round" -gt 1 ]; then
  case "$FAKE_GATE_SCENARIO" in repair|timeout|add-tests) ok=true;; esac
fi
status=fail; rc=1; tail='fixture failure tail'; grew='[{"file":"source.js","counter":"suppression","before":0,"after":1}]'
if [ "$ok" = true ]; then status=pass; rc=0; tail=; grew='[]'
elif [ "$FAKE_GATE_SCENARIO" = timeout ]; then status=timeout; rc=null; tail='fixture timeout tail'; fi
printf '{"ok":%s,"level":' "$ok"; json_string "$level"
printf ',"repo":'; json_string "$repo"
printf ',"base":'; json_string "$base"
printf ',"changed":'; IFS=, read -ra names <<< "$files"; json_args "${'${'}names[@]}"
printf ',"results":[{"name":'; json_string "$level-check"
printf ',"cmd":'; json_args fake "$level"
printf ',"status":'; json_string "$status"
printf ',"rc":%s,"durationMs":12,"outputTail":' "$rc"; json_string "$tail"
printf '}],"hygiene":{"ok":%s,"grew":%s}}' "$ok" "$grew"
if [ "$ok" = true ]; then exit 0; else exit 1; fi
`, { mode: 0o755 });
  return {
    calls, checks,
    env: {
      CONVEYOR_LUNA_SH: wrapper, CONVEYOR_GEM_SH: wrapper, FAKE_GATE_SCENARIO: scenario,
      CONVEYOR_CHECK_CMD: JSON.stringify([checker])
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
    const first = await env.command(['resolve', '--tier', 'complex', '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).selected.model, 'sonnet');
    assert.match(JSON.parse(first.stdout).chain[0].reason, /codex 83% ≥ 80% \(5h window\)/);
    const handoff = await env.run('complex');
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
    const run = await env.run('simple', '-w', {
      FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'starting'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /codex gpt-6-luna high write/);
    const mark = (await readJson(paths().providers)).gemini;
    assert.equal(mark.reason, 'quota');
    assert.equal(Date.parse(mark.until) - Date.parse(mark.at), 1800_000);
    const resolved = await env.command(['resolve', '--tier', 'simple', '--json']);
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
    const run = await env.run('complex', '-w', {
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
        const run = await env.run('simple', mode, {
          FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'running',
          // The real status watcher observes the running state; no full polling interval is needed.
          FAKE_WRAPPER_DELAY_S: '0.1'
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

test('a live repository write lock exits 7 with its owner while reads proceed', { timeout }, async () => {
  const env = await environment();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    await env.setup();
    await fs.writeFile(path.join(env.root, 'git.json'), JSON.stringify({ head: 'fixture-base' }));
    await fs.writeFile(path.join(env.root, 'git.json.sh'), gitState({ head: 'fixture-base' }));
    const subdir = path.join(env.dir, 'nested');
    await fs.mkdir(subdir);
    const stat = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const owner = {
      pid: child.pid, start, key: env.dir, out: path.join(env.root, 'owner.md'), brief: env.brief,
      session: 'other-session', at: new Date().toISOString()
    };
    const lock = path.join(paths().home, 'write-locks', createHash('sha256').update(env.dir).digest('hex').slice(0, 16));
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    const args = ['run', '--tier', 'complex', '-w', '-C', subdir, '-f', env.brief, '-o', env.out];
    const blocked = await env.command([...args, '--no-gate', '--waive', 'W-7']);
    assert.equal(blocked.status, 7, blocked.stderr);
    assert.equal(blocked.stdout, '');
    assert.equal(blocked.stderr, `exec: another write job runs in ${env.dir} ` +
      `(out: ${owner.out}, since ${owner.at}). Run this slice in its own worktree ` +
      '(node ~/.claude/scripts/disk/wt-new.mjs …) or wait for it.\n');
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.action, 'write-locked');
    assert.equal(dispatch.code, 7);
    assert.deepEqual(dispatch.owner, owner);
    assert.deepEqual(dispatch.attempts, []);
    const index = path.join(paths().home, 'sessions', 'gate-session.jsonl');
    const blockedRecords = await readLines(index);
    assert.equal(blockedRecords.length, 1);
    const [completion] = blockedRecords;
    assert.deepEqual(completion, {
      event: 'end', at: completion.at, session: 'gate-session', out: env.out, tier: 'complex', mode: 'write',
      provider: null, model: null, code: 7, gate: null
    });
    assert.ok(Number.isFinite(Date.parse(completion.at)));
    args[3] = '-r';
    const read = await env.command(args, { FAKE_WRAPPER_DELAY_S: '0' });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /codex gpt-6.1-sol max read/);
    assert.deepEqual(await readJson(path.join(lock, 'owner.json')), owner);
    const records = await readLines(index);
    assert.equal(records.length, 2);
    assert.equal(records[1].event, 'end');
    assert.equal(records[1].mode, 'read');
    assert.equal(records[1].code, 0);
    assert.equal(records[1].gate, null);
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await env.cleanup();
  }
});

test('stale write locks are taken over and released after successful and failed executors', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const key = await fs.realpath(env.dir);
    const lock = path.join(paths().home, 'write-locks', createHash('sha256').update(key).digest('hex').slice(0, 16));
    for (const code of [0, 2, 17]) {
      await fs.mkdir(lock, { recursive: true });
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
        pid: 2147483647, start: '1', key, out: env.out, brief: env.brief, session: null, at: new Date().toISOString()
      }));
      const run = await env.run('complex', '-w', { FAKE_CODEX_RC: String(code), FAKE_WRAPPER_DELAY_S: '0' });
      assert.equal(run.status, code, run.stderr);
      assert.equal((await readJson(`${env.out}.dispatch.json`)).action, 'run-wrapper');
      await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.dirname(lock)), []);
    }
    const records = await readLines(path.join(paths().home, 'sessions', 'gate-session.jsonl'));
    assert.deepEqual(records.filter((record) => record.event === 'end').map((record) => record.code), [0, 2, 17]);
  } finally { await env.cleanup(); }
});

test('run index failures log diagnostics without changing executor exits', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    await fs.mkdir(paths().home, { recursive: true });
    await fs.writeFile(path.join(paths().home, 'sessions'), 'not a directory');
    for (const code of [0, 17]) {
      const run = await env.run('complex', '-r', { FAKE_CODEX_RC: String(code), FAKE_WRAPPER_DELAY_S: '0' });
      assert.equal(run.status, code, run.stderr);
      assert.match(run.stderr, /conveyor: could not append run index:/);
    }
  } finally { await env.cleanup(); }
});

test('panel runs keep the chosen seat and unavailable seats return 5 with their reason', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const args = ['run', '--panel', 'design', '--seat', '1', '-r', '-C', env.dir, '-f', env.brief, '-o', env.out];
    const run = await env.command(args);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /gemini gemini-3.8-flash high read/);
    let dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.panel, 'design');
    assert.equal(dispatch.seat, 1);
    assert.equal(dispatch.attempts.length, 1);
    const failed = await env.command(args, {
      FAKE_GEMINI_RC: '3', FAKE_GEMINI_REASON: 'quota', FAKE_GEMINI_STATE: 'starting'
    });
    assert.equal(failed.status, 3, failed.stderr);
    dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.attempts.length, 1);
    assert.equal(dispatch.attempts[0].retry, false);
    const unavailable = await env.command(args);
    assert.equal(unavailable.status, 5, unavailable.stderr);
    assert.match(unavailable.stderr, /gemini unavailable until .*: quota/);
    assert.deepEqual((await readJson(`${env.out}.dispatch.json`)).attempts, []);
    await env.limits(83);
    args[4] = '0';
    const threshold = await env.command(args);
    assert.equal(threshold.status, 5, threshold.stderr);
    assert.match(threshold.stderr, /codex 83% ≥ 80%/);
    await assert.rejects(fs.stat(paths().switches), { code: 'ENOENT' });
    const role = await env.command(['run', '--role', 'arena runners', '--seat', '1', '-w',
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
    const listed = await env.command(args);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).selected, null);
    assert.deepEqual(JSON.parse(listed.stdout).seats.map((entry) => entry.seat), [0, 1]);
    args.push('--first-available');
    const first = await env.command(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).selected.provider, 'gemini');
    assert.equal(JSON.parse(first.stdout).selected.seat, 0);
    await markUnavailable('gemini', 'quota', 'fixture');
    const second = await env.command(['resolve', '--role', 'arena cross-judge pool', '--first-available', '--json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).panel, 'judge');
    assert.equal(JSON.parse(second.stdout).selected.provider, 'codex');
    assert.equal(JSON.parse(second.stdout).selected.seat, 1);
    await env.limits(83);
    const none = await env.command(args);
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
    const run = await env.run('simple');
    assert.equal(run.status, 5, run.stderr);
    for (const provider of ['codex', 'gemini', 'claude']) {
      assert.match(run.stderr, new RegExp(`${provider} unavailable until`));
    }
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.action, 'unavailable');
    assert.equal(dispatch.selected, null);
    assert.deepEqual(dispatch.attempts, []);
    const resolve = await env.command(['resolve', '--tier', 'simple', '--json']);
    assert.equal(resolve.status, 5, resolve.stderr);
    assert.ok(JSON.parse(resolve.stdout).chain.every((entry) => !entry.available));
    const status = await env.command(['status', '--json']);
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
    const run = await env.run('simple', '-r', {}, ['--role', 'auditor']);
    assert.equal(run.status, 0, run.stderr);
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.tier, 'review');
    assert.equal(dispatch.role, 'auditor');
    assert.equal(dispatch.provider, 'codex');
    assert.equal(dispatch.model, 'gpt-6-luna');
    const get = await env.command(['config', 'get', 'roles.auditor']);
    assert.equal(get.status, 0, get.stderr);
    assert.equal(JSON.parse(get.stdout), 'tier:review');
    const render = await env.command(['roles', 'render']);
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
    const customRender = await env.command(['roles', 'render', '--out', custom]);
    assert.equal(customRender.status, 0, customRender.stderr);
    assert.equal(await fs.readFile(custom, 'utf8'), content);
    assert.deepEqual(await fs.readdir(path.dirname(generated)), ['pstack-models.md']);
    const set = await env.command(['config', 'set', 'thresholds.codex.switch_percent', '82']);
    assert.equal(set.status, 0, set.stderr);
    const before = await fs.readFile(paths().config, 'utf8');
    const invalid = await env.command(['config', 'set', 'thresholds.codex.switch_percent', '0']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /switch_percent must be between 1 and 100/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    const validate = await env.command(['config', 'validate']);
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(validate.stdout, 'valid\n');
    const preset = await env.command(['config', 'preset', 'economy']);
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

async function action(env, args, extraEnv = {}) {
  const result = await env.command(args, extraEnv);
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

test('config set-entry regenerates the roles file with the new model', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const roles = path.join(process.env.CLAUDE_HOME_DIR, 'rules', 'pstack-models.md');
    await fs.mkdir(path.dirname(roles), { recursive: true });
    await fs.writeFile(roles, 'stale roles\n');
    await action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '0', '--provider', 'codex',
      '--model', 'gpt-6-luna', '--effort', 'high', '--actor', 'panel']);
    const rendered = await fs.readFile(roles, 'utf8');
    assert.match(rendered, /^# Generated from orchestration.json\./);
    assert.match(rendered, /^arena runners: panel design = codex\/gpt-6-luna\/high,/m);
    assert.doesNotMatch(rendered, /stale roles/);
  } finally { await env.cleanup(); }
});

test('set-entry validates catalog efforts, edits panel seats and journals the panel actor', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const target = ['--tier', 'complex', '--index', '0', '--provider', 'codex', '--model', 'gpt-6.1-sol'];
    const edited = await action(env, ['config', 'set-entry', ...target, '--effort', 'high', '--actor', 'panel']);
    assert.equal(edited.changed, true);
    assert.equal((await loadConfig()).tiers.complex[0].effort, 'high');
    const before = await fs.readFile(paths().config, 'utf8');
    const journalBefore = await fs.readFile(paths().journal, 'utf8');
    const invalid = await env.command(['config', 'set-entry', ...target, '--effort', 'ultra', '--actor', 'panel']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /effort ultra is not in catalog/);
    assert.equal(invalid.stderr.trim().split('\n').length, 1);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    assert.equal(await fs.readFile(paths().journal, 'utf8'), journalBefore);
    await action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
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
    await action(env, ['config', 'add-entry', '--tier', 'simple', '--provider', entry.provider,
      '--model', entry.model, '--effort', entry.effort, '--at', '1']);
    assert.deepEqual((await loadConfig()).tiers.simple, [initial[0], entry, ...initial.slice(1)]);
    await action(env, ['config', 'move-entry', '--tier', 'simple', '--index', '1', '--to', '3']);
    assert.deepEqual((await loadConfig()).tiers.simple, [...initial, entry]);
    await action(env, ['config', 'remove-entry', '--tier', 'simple', '--index', '3']);
    assert.deepEqual((await loadConfig()).tiers.simple, initial);
    assert.equal((await action(env, ['config', 'move-entry', '--tier', 'simple', '--index', '0', '--to', '0'])).changed, false);
    await action(env, ['config', 'remove-entry', '--tier', 'complex', '--index', '1']);
    const before = await fs.readFile(paths().config, 'utf8');
    const empty = await env.command(['config', 'remove-entry', '--tier', 'complex', '--index', '0']);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /cannot remove the last entry/);
    const pastEnd = await env.command(['config', 'move-entry', '--tier', 'simple', '--index', '0', '--to', '3']);
    assert.equal(pastEnd.status, 1);
    assert.match(pastEnd.stderr, /zero-based index/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    assert.ok((await readLines(paths().journal)).every((entry) => entry.actor === 'cli'));
  } finally { await env.cleanup(); }
});

test('panel entry actions add, move and remove seats; reject invalid targets and the last seat', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const config = await loadConfig(), initial = config.panels.design[0];
    config.panels.design = [initial];
    await saveConfig(config, { actor: 'cli', note: 'fixture panel' });
    const roles = path.join(process.env.CLAUDE_HOME_DIR, 'rules', 'pstack-models.md');
    const entry = { provider: 'claude', model: 'sonnet', effort: 'low' };
    const entryArgs = ['--provider', entry.provider, '--model', entry.model, '--effort', entry.effort];
    const verify = async (expected, actionName) => {
      assert.deepEqual((await readJson(paths().config)).panels.design, expected);
      const journal = (await readLines(paths().journal)).slice(-2);
      assert.deepEqual(journal.map((entry) => entry.status), ['applying', 'applied']);
      assert.deepEqual(journal.map((entry) => entry.note), Array(2).fill(`${actionName} panel design`));
      const rendered = await fs.readFile(roles, 'utf8');
      const seats = expected.map((seat) => `${seat.provider}/${seat.model}/${seat.effort}`).join(', ');
      assert.ok(rendered.split('\n').includes(`arena runners: panel design = ${seats}`));
    };
    await action(env, ['config', 'add-entry', '--panel', 'design', '--at', '1', ...entryArgs]);
    await verify([initial, entry], 'add-entry');
    await action(env, ['config', 'move-entry', '--panel', 'design', '--seat', '1', '--to', '0']);
    await verify([entry, initial], 'move-entry');
    await action(env, ['config', 'remove-entry', '--panel', 'design', '--seat', '0']);
    await verify([initial], 'remove-entry');
    const before = await fs.readFile(paths().config, 'utf8');
    const journalBefore = await fs.readFile(paths().journal, 'utf8');
    const invalid = [
      [['remove-entry', '--panel', 'design', '--seat', '0'], /cannot remove the last seat in a panel/],
      [['set-entry', '--panel', 'design', '--index', '0', ...entryArgs], /use --seat for this target/],
      [['add-entry', '--panel', 'design', '--index', '0', ...entryArgs], /unknown option: --index/],
      [['remove-entry', '--panel', 'design', '--index', '0'], /use --seat for this target/],
      [['move-entry', '--panel', 'design', '--index', '0', '--to', '0'], /use --seat for this target/],
      [['remove-entry', '--tier', 'simple', '--seat', '0'], /use --index for this target/],
      [['move-entry', '--tier', 'simple', '--seat', '0', '--to', '0'], /use --index for this target/],
      [['remove-entry', '--panel', 'missing', '--seat', '0'], /unknown panel: missing/],
      [['add-entry', '--panel', 'design', '--at', '2', ...entryArgs], /--at must be a zero-based index/],
      [['remove-entry', '--panel', 'design', '--seat', '1'], /--seat must be a zero-based index/],
      [['move-entry', '--panel', 'design', '--seat', '0', '--to', '1'], /--to must be a zero-based index/],
      [['add-entry', '--panel', 'design', '--provider', 'other', '--model', 'sonnet', '--effort', 'low'],
        /unknown provider other/],
      [['add-entry', '--panel', 'design', '--provider', 'claude', '--model', 'missing', '--effort', 'low'],
        /model claude\/missing is not in catalog/],
      [['add-entry', '--panel', 'design', '--provider', 'claude', '--model', 'sonnet', '--effort', 'ultra'],
        /effort ultra is not in catalog/]
    ];
    for (const [args, message] of invalid) {
      const result = await env.command(['config', ...args]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(await fs.readFile(paths().config, 'utf8'), before);
      assert.equal(await fs.readFile(paths().journal, 'utf8'), journalBefore);
    }
  } finally { await env.cleanup(); }
});

test('threshold edits preserve omitted hysteresis and reject out-of-range values', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    await action(env, ['config', 'threshold', '--percent', '85', '--hysteresis', '7', '--actor', 'panel']);
    assert.deepEqual((await loadConfig()).thresholds.codex, {
      switch_percent: 85, hysteresis_percent: 7, windows: ['primary', 'secondary']
    });
    await action(env, ['config', 'threshold', '--percent', '82']);
    assert.equal((await loadConfig()).thresholds.codex.hysteresis_percent, 7);
    const before = await fs.readFile(paths().config, 'utf8');
    for (const args of [['--percent', '0'], ['--percent', '101'], ['--percent', '80', '--hysteresis', '51']]) {
      const result = await env.command(['config', 'threshold', ...args]);
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
    await action(env, ['config', 'save-preset', '--name', 'my-chains', '--label', 'Мои цепочки', '--actor', 'panel']);
    await action(env, ['config', 'set-entry', '--tier', 'complex', '--index', '0', '--provider', 'claude',
      '--model', 'haiku', '--effort', 'medium']);
    assert.notDeepEqual((await loadConfig()).tiers, initial);
    await action(env, ['config', 'preset', 'my-chains', '--actor', 'panel']);
    const config = await loadConfig();
    assert.deepEqual(config.tiers, initial);
    assert.deepEqual(config.presets['my-chains'], { label: 'Мои цепочки', tiers: initial });
    const before = await fs.readFile(paths().config, 'utf8');
    for (const args of [['preset', 'absent'], ['save-preset', '--name', '../bad', '--label', 'Bad']]) {
      assert.equal((await env.command(['config', ...args])).status, 1);
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
    const empty = await env.command(['config', 'undo']);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /nothing to undo/);
    await action(env, ['config', 'threshold', '--percent', '82']);
    const first = await loadConfig();
    await action(env, ['config', 'threshold', '--percent', '88', '--hysteresis', '6']);
    const second = await loadConfig();
    await action(env, ['config', 'threshold', '--percent', '88', '--hysteresis', '6']);
    await action(env, ['config', 'undo', '--actor', 'panel']);
    assert.deepEqual(await loadConfig(), first);
    await action(env, ['config', 'undo', '--actor', 'panel']);
    assert.deepEqual(await loadConfig(), initial);
    const journal = await readLines(paths().journal);
    const applying = journal.filter((entry) => entry.status === 'applying');
    assert.deepEqual(applying.map((entry) => entry.before), [initial, first, second, second, first]);
    assert.equal(applying[3].note, `undo ${applying[1].id}`);
    assert.equal(applying[4].note, `undo ${applying[0].id}`);
    assert.equal(applying[3].actor, 'panel');
    assert.equal(applying[4].actor, 'panel');
    const before = await fs.readFile(paths().config, 'utf8');
    const exhausted = await env.command(['config', 'undo']);
    assert.equal(exhausted.status, 1);
    assert.match(exhausted.stderr, /nothing to undo/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    await action(env, ['config', 'threshold', '--percent', '90']);
    await action(env, ['config', 'undo']);
    assert.deepEqual(await loadConfig(), initial);
    assert.equal((await env.command(['config', 'undo'])).status, 1);
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
    const refreshed = await action(env, ['catalog', 'refresh', '--provider', 'gemini', '--actor', 'panel'], command);
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.note, 'added gemini-9-pro');
    const expected = { ...initial, gemini: [...initial.gemini, { model: 'gemini-9-pro', efforts: ['low', 'medium', 'high'] }] };
    assert.deepEqual((await loadConfig()).catalog, expected);
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
    assert.equal((await action(env, ['catalog', 'refresh', '--provider', 'gemini'], command)).changed, false);
    assert.deepEqual((await loadConfig()).catalog, expected);
    const before = await fs.readFile(paths().config, 'utf8');
    const failed = await env.command(['catalog', 'refresh', '--provider', 'gemini'], {
      CONVEYOR_AGY_MODELS_CMD: JSON.stringify([process.execPath, '-e', 'process.stderr.write("fake error\\n"); process.exit(1)'])
    });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.trim().split('\n').length, 1);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
  } finally { await env.cleanup(); }
});

test('catalog refresh discovers Codex models and Claude aliases with safe cache failures', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const config = await loadConfig();
    const initial = structuredClone(config.catalog);
    assert.ok(!initial.claude.some((entry) => entry.model === 'fable'));
    const cache = path.join(env.root, 'models_cache.json');
    const binary = path.join(env.root, 'claude-code');
    const secondBinary = path.join(env.root, 'claude-code-other');
    await fs.writeFile(binary, 'x="A short (3-5 word) description of the task",' +
      'aSa=["sonnet","opus","haiku","fable","newalias"],y=1');
    await fs.writeFile(secondBinary, 'x="A short (3-5 word) description of the task",aSa=["newalias",1,"BAD","next-alias"],y=1');
    const command = {
      CONVEYOR_CODEX_MODELS_CACHE: cache,
      CONVEYOR_CODEX_MODELS_CMD: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
      CONVEYOR_CLAUDE_BINS: JSON.stringify([binary, secondBinary])
    };
    await fs.writeFile(cache, JSON.stringify({ fetched_at: '2026-11-17T21:04:59Z', models: [
      { slug: 'gpt-6.2-sol', visibility: 'list', supported_reasoning_levels:
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'unknown'].map((effort) => ({ effort })) },
      { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      // Older releases Codex still lists stay out: only the newest version of a family joins the catalog.
      { slug: 'gpt-5.6-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-6.10-luna-old', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-6.2-ASTRA', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: initial.codex[0].model, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-no-efforts', visibility: 'list', supported_reasoning_levels: [{ effort: 'ultra' }] },
      { slug: '', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }
    ] }));
    const liveModel = { model: 'gpt-7-luna', efforts: ['high'] };
    const liveListing = { models: [
      { slug: liveModel.model, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }
    ] };
    const execPath = fileURLToPath(new URL('../exec.mjs', import.meta.url));
    const tierEntry = config.tiers.complex[0];
    assert.notEqual(tierEntry.effort, 'low');
    const updateTier = [execPath, 'config', 'set-entry', '--tier', 'complex', '--index', '0', '--actor', 'panel',
      '--provider', tierEntry.provider, '--model', tierEntry.model, '--effort', 'low'];
    const liveCommand = { ...command, CONVEYOR_CODEX_MODELS_CMD: JSON.stringify([process.execPath, '-e', `
      require('node:child_process').execFileSync(process.execPath, ${JSON.stringify(updateTier)});
      console.log(JSON.stringify(${JSON.stringify(liveListing)}));
    `]) };
    const live = await action(env, ['catalog', 'refresh', '--provider', 'codex'], liveCommand);
    const afterLive = await loadConfig();
    assert.equal(afterLive.tiers.complex[0].effort, 'low');
    assert.equal(live.changed, true);
    assert.equal(live.note, `added codex/${liveModel.model}`);
    assert.deepEqual(afterLive.catalog, { ...initial, codex: [...initial.codex, liveModel] });

    const refreshed = await action(env, ['catalog', 'refresh', '--provider', 'codex', '--actor', 'panel'], command);
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.note, 'added codex/gpt-6.2-sol');
    const expected = { ...initial, codex: [...initial.codex, liveModel,
      { model: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] };
    assert.deepEqual((await loadConfig()).catalog, expected);
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
    let before = await fs.readFile(paths().config);
    let journal = await fs.readFile(paths().journal);
    const repeated = await action(env, ['catalog', 'refresh', '--provider', 'codex'], command);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.note, 'no models added');
    assert.deepEqual(await fs.readFile(paths().config), before);
    assert.deepEqual(await fs.readFile(paths().journal), journal);

    const claude = await action(env, ['catalog', 'refresh', '--provider', 'claude'], command);
    assert.equal(claude.changed, true);
    assert.equal(claude.note, 'added claude/fable, claude/newalias, claude/next-alias');
    expected.claude = [...initial.claude,
      ...['fable', 'newalias', 'next-alias'].map((model) => ({ model, efforts: ['low', 'medium', 'high'] }))];
    assert.deepEqual((await loadConfig()).catalog, expected);
    const missing = path.join(env.root, 'missing-cache.json');
    const missingCommand = { ...command, CONVEYOR_CODEX_MODELS_CACHE: missing, CONVEYOR_CLAUDE_BINS: '[]' };
    const defaultsNote = '; claude aliases not found in Claude Code, used defaults';
    before = await fs.readFile(paths().config);
    journal = await fs.readFile(paths().journal);
    const failed = await env.command(['catalog', 'refresh', '--provider', 'codex'], missingCommand);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, `conveyor: codex model cache unreadable: ${missing}\n`);
    const invalidCommand = { ...command, CONVEYOR_CODEX_MODELS_CMD: '{' };
    const invalid = await env.command(['catalog', 'refresh', '--provider', 'codex'], invalidCommand);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr, 'conveyor: CONVEYOR_CODEX_MODELS_CMD must be non-empty JSON argv\n');
    const invalidAll = await action(env, ['catalog', 'refresh', '--provider', 'all'], invalidCommand);
    assert.equal(invalidAll.changed, false);
    assert.equal(invalidAll.note, 'no models added; CONVEYOR_CODEX_MODELS_CMD must be non-empty JSON argv');
    assert.deepEqual(await fs.readFile(paths().config), before);
    assert.deepEqual(await fs.readFile(paths().journal), journal);

    await action(env, ['catalog', 'remove', '--provider', 'claude', '--model', 'fable']);
    const applied = (await readLines(paths().journal)).filter((entry) => entry.status === 'applied').length;
    const all = await action(env, ['catalog', 'refresh', '--provider', 'all', '--actor', 'panel'], missingCommand);
    assert.equal(all.changed, true);
    assert.equal(all.note, `added claude/fable; codex model cache unreadable: ${missing}${defaultsNote}`);
    const [fable, ...newAliases] = expected.claude.slice(initial.claude.length);
    assert.deepEqual((await loadConfig()).catalog, { ...expected, claude: [...initial.claude, ...newAliases, fable] });
    const entries = (await readLines(paths().journal)).filter((entry) => entry.status === 'applied');
    assert.equal(entries.length, applied + 1);
    assert.equal(entries.at(-1).actor, 'panel');
    assert.equal(entries.at(-1).note, all.note);
    before = await fs.readFile(paths().config);
    journal = await fs.readFile(paths().journal);
    const unchanged = await action(env, ['catalog', 'refresh', '--provider', 'all'], missingCommand);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.note, `no models added; codex model cache unreadable: ${missing}${defaultsNote}`);
    assert.deepEqual(await fs.readFile(paths().config), before);
    assert.deepEqual(await fs.readFile(paths().journal), journal);
  } finally { await env.cleanup(); }
});

test('catalog add/remove validate efforts and refuse models referenced by tiers or panels', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    await action(env, ['catalog', 'add', '--provider', 'gemini', '--model', 'gemini-9-panel', '--efforts', 'low,medium,high']);
    let before = await fs.readFile(paths().config, 'utf8');
    const invalid = await env.command(['catalog', 'add', '--provider', 'gemini', '--model', 'gemini-bad', '--efforts', 'low,,high']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /catalog effort must be a non-empty string/);
    const tier = await env.command(['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-3.8-flash']);
    assert.equal(tier.status, 1);
    assert.match(tier.stderr, /is in use by a tier or panel/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    await action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
      '--model', 'gemini-9-panel', '--effort', 'high']);
    before = await fs.readFile(paths().config, 'utf8');
    const panel = await env.command(['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-9-panel']);
    assert.equal(panel.status, 1);
    assert.match(panel.stderr, /is in use by a tier or panel/);
    assert.equal(await fs.readFile(paths().config, 'utf8'), before);
    await action(env, ['config', 'set-entry', '--panel', 'design', '--seat', '1', '--provider', 'gemini',
      '--model', 'gemini-3.8-flash', '--effort', 'high']);
    await action(env, ['catalog', 'remove', '--provider', 'gemini', '--model', 'gemini-9-panel', '--actor', 'panel']);
    assert.ok(!(await loadConfig()).catalog.gemini.some((entry) => entry.model === 'gemini-9-panel'));
    assert.equal((await readLines(paths().journal)).at(-1).actor, 'panel');
  } finally { await env.cleanup(); }
});

test('a green write gate appends checks and records the owner, excluding pre-existing dirt', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const gate = await gateFixture(env);
    const run = await env.run('complex', '-w', gate.env);
    assert.equal(run.status, 0, run.stderr);
    const output = await fs.readFile(env.out, 'utf8');
    assert.match(output, /Requested change done\.[\s\S]*## Gate[\s\S]*pass/);
    assert.match(output, /fast-check: pass \(12 ms\)/);
    assert.match(output, /turn-check: pass \(12 ms\)/);
    const checks = await readLines(gate.checks);
    assert.deepEqual(checks.map((args) => args[args.indexOf('--level') + 1]), ['fast', 'turn']);
    for (const args of checks) {
      assert.equal(args[args.indexOf('--base') + 1], 'fixture-base');
      assert.equal(args[args.indexOf('--files') + 1], 'committed.js,new.txt,source.js');
    }
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.gate.status, 'pass');
    assert.equal(dispatch.gate.rounds, 0);
    const records = await readLines(path.join(paths().home, 'sessions', 'gate-session.jsonl'));
    assert.equal(records.length, 2);
    const [owner, completion] = records;
    assert.deepEqual(owner, {
      at: owner.at, session: 'gate-session', repo: env.dir, base: 'fixture-base', out: env.out, tier: 'complex', mode: 'block'
    });
    assert.ok(Number.isFinite(Date.parse(owner.at)));
    assert.deepEqual(completion, {
      event: 'end', at: completion.at, session: 'gate-session', out: env.out, tier: 'complex', mode: 'write',
      provider: 'codex', model: 'gpt-6.1-sol', code: 0, gate: { status: 'pass', rounds: 0 }
    });
    assert.ok(Number.isFinite(Date.parse(completion.at)));
  } finally { await env.cleanup(); }
});

test('a red gate repairs on the same provider and preserves the brief and failure details', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const original = 'Implement this exact change.\n\nKeep the original brief verbatim.\n';
    await fs.writeFile(env.brief, original);
    const gate = await gateFixture(env, 'repair');
    const run = await env.run('complex', '-w', gate.env);
    assert.equal(run.status, 0, run.stderr);
    const fixBrief = await fs.readFile(`${env.out}.gate-1.brief.md`, 'utf8');
    assert.ok(fixBrief.startsWith(original));
    assert.match(fixBrief, /The work above is done but failed the project's checks/);
    assert.match(fixBrief, /fixture failure tail/);
    assert.match(fixBrief, /hygiene: source.js suppression: 0 → 1/);
    assert.match(fixBrief, /Do not weaken, skip or delete checks, tests, lint rules or hygiene counters/);
    assert.match(fixBrief, /Do not revert the requested change/);
    const launches = await readLines(gate.calls);
    assert.equal(launches.length, 2);
    for (const args of launches) {
      assert.deepEqual(args.slice(0, 5), ['-w', '-m', 'gpt-6.1-sol', '-e', 'max']);
    }
    assert.equal(launches[1][launches[1].indexOf('-f') + 1], `${env.out}.gate-1.brief.md`);
    assert.equal(launches[1][launches[1].indexOf('-o') + 1], `${env.out}.gate-1.out.md`);
    const output = await fs.readFile(env.out, 'utf8');
    assert.match(output, /Round 0: fail[\s\S]*Round 1: pass[\s\S]*## Gate: pass/);
    assert.equal((await readLines(gate.checks)).length, 4);
    assert.equal((await readJson(`${env.out}.dispatch.json`)).gate.rounds, 1);
  } finally { await env.cleanup(); }
});

test('a gate still red after the configured repair budget exits 6 and records its last results', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const gate = await gateFixture(env, 'red');
    const run = await env.run('complex', '-w', { ...gate.env, CONVEYOR_GATE_ROUNDS: '1' });
    assert.equal(run.status, 6, run.stderr);
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.code, 6);
    assert.equal(dispatch.gate.status, 'fail');
    assert.equal(dispatch.gate.rounds, 1);
    assert.equal(dispatch.gate.last.ok, false);
    assert.deepEqual(dispatch.gate.last.results.map((result) => result.name), ['fast-check', 'turn-check']);
    assert.equal((await readLines(gate.calls)).length, 2);
    assert.equal((await readLines(gate.checks)).length, 4);
    assert.match(await fs.readFile(env.out, 'utf8'), /Round 0: fail[\s\S]*Round 1: fail[\s\S]*## Gate: fail/);
  } finally { await env.cleanup(); }
});

test('a repair touching check configuration stops before another check or repair', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const gate = await gateFixture(env, 'weaken');
    const run = await env.run('complex', '-w', gate.env);
    assert.equal(run.status, 6, run.stderr);
    assert.match(await fs.readFile(env.out, 'utf8'),
      /## Gate: fail \(fix round touched check configuration: eslint.config.js\)/);
    assert.equal((await readLines(gate.calls)).length, 2);
    assert.equal((await readLines(gate.checks)).length, 2);
    const dispatch = await readJson(`${env.out}.dispatch.json`);
    assert.equal(dispatch.gate.status, 'fail');
    assert.equal(dispatch.gate.rounds, 1);
    assert.deepEqual(dispatch.gate.touched, ['eslint.config.js']);
  } finally { await env.cleanup(); }
});

test('fix rounds reject edits or deletions of existing tests and allow new tests', { timeout }, async () => {
  for (const scenario of ['edit-tests', 'delete-tests', 'add-tests']) {
    const env = await environment();
    try {
      await env.setup();
      const gate = await gateFixture(env, scenario);
      const run = await env.run('complex', '-w', gate.env);
      const added = scenario === 'add-tests';
      assert.equal(run.status, added ? 0 : 6, run.stderr);
      const output = await fs.readFile(env.out, 'utf8');
      if (added) assert.match(output, /## Gate: pass/);
      else assert.match(output, /## Gate: fail \(fix round modified tests: source.test.js\)/);
      assert.equal((await readLines(gate.calls)).length, 2);
      assert.equal((await readLines(gate.checks)).length, added ? 4 : 2);
    } finally { await env.cleanup(); }
  }
});

test('timeout results retain check names and diagnostics in gate output and repair briefs', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const gate = await gateFixture(env, 'timeout');
    const run = await env.run('complex', '-w', gate.env);
    assert.equal(run.status, 0, run.stderr);
    for (const file of [env.out, `${env.out}.gate-1.brief.md`]) {
      const text = await fs.readFile(file, 'utf8');
      assert.match(text, /fast-check: timeout[\s\S]*fixture timeout tail/);
      assert.match(text, /turn-check: timeout[\s\S]*fixture timeout tail/);
    }
    assert.equal((await readJson(`${env.out}.dispatch.json`)).gate.rounds, 1);
  } finally { await env.cleanup(); }
});

test('warn mode reports failures without repair and non-git jobs skip the gate', { timeout }, async () => {
  const env = await environment();
  try {
    await env.setup();
    const gate = await gateFixture(env, 'red', 'warn');
    const warn = await env.run('complex', '-w', gate.env);
    assert.equal(warn.status, 0, warn.stderr);
    assert.equal((await readLines(gate.calls)).length, 1);
    assert.match(await fs.readFile(env.out, 'utf8'), /## Gate: warn[\s\S]*fixture failure tail/);
    assert.equal((await readJson(`${env.out}.dispatch.json`)).gate.status, 'warn');
    await fs.rm(path.join(env.root, 'git.json'));
    const nonGit = await env.run('complex', '-w', { CONVEYOR_CHECK_CMD: 'invalid JSON; must never be used' });
    assert.equal(nonGit.status, 0, nonGit.stderr);
    assert.equal((await readLines(gate.checks)).length, 2);
    assert.equal((await readJson(`${env.out}.dispatch.json`)).gate.status, 'skipped');
    assert.match(await fs.readFile(env.out, 'utf8'), /skipped: not a git repository/);
  } finally { await env.cleanup(); }
});
