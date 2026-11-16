import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireUsageLock, collectUsage, localDay, readUsageSummary, summarizeUsage, usagePaths
} from '../usage.mjs';

process.env.TZ = 'America/New_York';
const timeout = 600_000;
const cli = fileURLToPath(new URL('../usage.mjs', import.meta.url));
const overview = fileURLToPath(new URL('../../luna-overview.mjs', import.meta.url));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function jsonl(file, records) {
  write(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function fixture(t, now = Date.parse('2026-11-03T16:00:00Z')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-usage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, TZ: 'America/New_York', CLAUDE_HOME_DIR: path.join(root, '.claude'),
    CODEX_HOME: path.join(root, '.codex'), CONVEYOR_HOME: path.join(root, 'conveyor'),
    LUNA_RUN_DIR: path.join(root, '.claude', 'luna-run'), LUNA_DAEMON_HOME: path.join(root, 'daemon') };
  env.LUNA_OVERVIEW_HOME = env.LUNA_RUN_DIR;
  const paths = usagePaths(env);
  return { root, env, paths, now, collect: () => collectUsage({ env, now }),
    cache: () => JSON.parse(fs.readFileSync(paths.cache, 'utf8')) };
}

function assistant(id, at, model, input, output, cacheRead = 0, cacheWrite = 0) {
  return { type: 'assistant', timestamp: at, message: { id, model, usage: {
    input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite
  } } };
}

function status(out, values) {
  write(`${out}.status`, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

function run(file, args, env) {
  const result = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('Claude dedupes split messages, normalizes projects, and buckets by local day', { timeout }, (t) => {
  const f = fixture(t), previous = '2026-11-03T02:30:00Z', today = new Date(f.now).toISOString();
  const transcript = path.join(f.paths.projects, '-home-fake-harness--claude-worktrees-branch', 'session.jsonl');
  const final = assistant('split', previous, 'claude-opus', 100, 10, 20, 30);
  jsonl(transcript, [assistant('split', previous, 'claude-opus', 100, 2, 20, 30), final, final,
    assistant('today', today, 'claude-sonnet', 7, 3, 2, 1), { type: 'user', message: { content: 'private fixture text' } }]);
  jsonl(path.join(path.dirname(transcript), 'session', 'subagents', 'agent.jsonl'), [
    final, assistant('agent', today, 'claude-opus', 2, 3)
  ]);
  jsonl(path.join(f.paths.projects, 'C--Other', 'windows.jsonl'), [assistant('windows', today, 'claude-sonnet', 2, 2)]);
  jsonl(path.join(f.paths.projects, '-home-fake-scratch-workspaces-job', 'scratch.jsonl'), [
    assistant('scratch', today, 'claude-sonnet', 1, 1)
  ]);
  f.collect();
  const cache = f.cache(), before = cache.days['2026-11-02'].claude, current = cache.days['2026-11-03'].claude;
  assert.deepEqual(before.byModel['claude-opus'], {
    input: 100, output: 10, cacheRead: 20, cacheWrite: 30, total: 160, messages: 1
  });
  assert.equal(before.byProject.harness, 160);
  assert.equal(current.byProject.harness, 18);
  assert.equal(current.byProject.other, 4);
  assert.equal(current.byProject['без папки'], 2);
  assert.equal(current.byModel['claude-sonnet'].messages, 3);
  assert.equal(cache.topJobs.find((job) => job.name === 'session').total, 178);
  const state = fs.readFileSync(f.paths.state, 'utf8');
  assert.ok(!state.includes('private fixture text'));
  assert.equal(localDay(previous), '2026-11-02');
});

test('Incremental collection reads appended bytes, rescans truncations and replacements, and locks state', { timeout }, (t) => {
  const f = fixture(t), at = new Date(f.now).toISOString();
  const file = path.join(f.paths.projects, '-home-fake-project', 'session.jsonl');
  jsonl(file, [assistant('one', at, 'claude-opus', 10, 5)]);
  // Match the live machine's source count; idle work must also ignore a large message ledger.
  for (let index = 0; index < 2665; index++) write(path.join(path.dirname(file), `empty-${index}.jsonl`), '');
  assert.equal(f.collect().bytesRead, fs.statSync(file).size);
  const savedState = fs.readFileSync(f.paths.state, 'utf8');
  fs.appendFileSync(f.paths.state, ' '.repeat(28 * 1024 * 1024)); // Legal JSON whitespace after the ledger.
  const idle = f.collect();
  assert.equal(idle.bytesRead, 0);
  assert.equal(idle.changedFiles, 0);
  assert.ok(idle.elapsedMs < 2000, `idle collector took ${idle.elapsedMs} ms`);
  t.diagnostic(`unchanged collect: ${idle.elapsedMs} ms, ${idle.files} files, ${fs.statSync(f.paths.state).size} state bytes`);
  write(f.paths.state, savedState);
  const append = JSON.stringify(assistant('two', at, 'claude-opus', 8, 2)) + '\n';
  fs.appendFileSync(file, append);
  assert.equal(f.collect().bytesRead, Buffer.byteLength(append));
  assert.equal(f.cache().days[localDay(f.now)].claude.byModel['claude-opus'].total, 25);
  const partial = JSON.stringify(assistant('partial', at, 'claude-opus', 2, 1));
  fs.appendFileSync(file, partial.slice(0, -3));
  f.collect();
  fs.appendFileSync(file, partial.slice(-3) + '\n');
  f.collect();
  assert.equal(f.cache().days[localDay(f.now)].claude.byModel['claude-opus'].total, 28);
  jsonl(file, [assistant('new', at, 'claude-opus', 6, 2)]);
  assert.equal(f.collect().bytesRead, fs.statSync(file).size);
  assert.equal(f.cache().days[localDay(f.now)].claude.byModel['claude-opus'].total, 8);
  const replacement = `${file}.replacement`;
  jsonl(replacement, [assistant('old', at, 'claude-opus', 4, 1)]);
  fs.renameSync(replacement, file);
  assert.equal(f.collect().bytesRead, fs.statSync(file).size);
  assert.equal(f.cache().days[localDay(f.now)].claude.byModel['claude-opus'].total, 5);
  const release = acquireUsageLock(f.paths);
  assert.ok(release);
  try { assert.deepEqual(f.collect(), { locked: true, bytesRead: 0 }); }
  finally { release(); }
  assert.ok(!fs.existsSync(f.paths.lock));
  fs.rmSync(file);
  f.collect();
  assert.equal(f.cache().days[localDay(f.now)].claude.byModel['claude-opus'].total, 5);
});

test('Codex cumulative rollouts and surviving log footers aggregate alongside Gemini statuses', { timeout }, (t) => {
  const f = fixture(t), at = new Date(f.now).toISOString();
  const retained = path.join(f.root, 'jobs', 'retained'), deleted = path.join(f.root, 'jobs', 'deleted');
  const gem = path.join(f.root, 'jobs', 'gem'), active = path.join(f.root, 'jobs', 'active');
  const rollout = path.join(f.paths.sessions, '2026', '11', '03', 'rollout-retained.jsonl');
  const usage = { input_tokens: 160, output_tokens: 40, cached_input_tokens: 40, total_tokens: 200 };
  jsonl(rollout, [
    { type: 'session_meta', timestamp: at, payload: { id: 'session-retained', cwd: '/home/fake/repo' } },
    { type: 'turn_context', timestamp: at, payload: { model: 'gpt-6.1-sol', cwd: '/home/fake/repo' } },
    { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 20, total_tokens: 100 }
    } } },
    { type: 'token_usage_record', timestamp: at, payload: { thread_token_usage: usage, usage } },
    { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: usage } } },
    { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: null } }
  ]);
  status(retained, { state: 'done', model: 'gpt-6.1-sol', dir: '/home/fake/repo', finished: at });
  write(`${retained}.daemon`, 'thread=session-retained\n');
  write(`${retained}.log`, `[${at}] turn start thread=session-retained turn=turn-one model=gpt-6.1-sol effort=high\n` +
    'tokens used\n200\n');
  status(deleted, { state: 'done', model: 'gpt-6-luna', dir: '/home/fake/repo', finished: at });
  write(`${deleted}.log`, 'session id: deleted-session\ntokens used\n1,234\n');
  status(gem, { provider: 'gemini', state: 'done', model: 'alias', acp_model: 'gemini-3.8-flash-high',
    dir: '/home/fake/gem-project', finished: at, usage_input: 30, usage_output: 12, usage_total: 50 });
  status(active, { provider: 'gemini', state: 'running', acp_model: 'gemini-3.8-flash-medium',
    dir: '/home/fake/gem-project', started: at, usage_input: 5, usage_output: 3, usage_total: 8 });
  jsonl(f.paths.registry, [retained, deleted, gem, gem].map((out) => ({ out, finished: at, model: out === gem ? 'alias' : '' })));
  write(path.join(f.paths.run, 'gem-active', 'active.json'), JSON.stringify({ v: 1, out: active, started: at }));
  write(path.join(f.paths.run, 'gem-active', 'duplicate.json'), JSON.stringify({ v: 1, out: gem, started: at }));
  // Daemon discovery metadata alone must not fabricate usage for ephemeral sessions.
  status(path.join(f.paths.run, 'ephemeral'), { model: 'gpt-6-luna', state: 'done', finished: at });
  const orphan = path.join(f.paths.run, 'archived', 'orphan.log');
  write(orphan, 'tokens used\n77\n');
  fs.utimesSync(orphan, new Date(f.now), new Date(f.now));
  f.collect();
  const cache = f.cache(), day = cache.days[localDay(f.now)];
  assert.equal(day.codex.byModel['gpt-6.1-sol'].total, 200);
  assert.equal(day.codex.byModel['gpt-6.1-sol'].cacheRead, 40);
  assert.equal(day.codex.byModel['gpt-6-luna'].total, 1234);
  assert.equal(day.codex.byModel['gpt-6-luna'].input, 0);
  assert.equal(day.codex.byProject.repo, 1434);
  assert.equal(day.codex.byModel.unknown.total, 77);
  assert.equal(day.codex.jobs, 3);
  assert.equal(day.gemini.byModel['gemini-3.8-flash-high'].total, 50);
  assert.equal(day.gemini.byProject['gem-project'], 58);
  assert.equal(day.gemini.jobs, 2);
  assert.equal(cache.topJobs.filter((job) => job.provider === 'codex').length, 3);
  assert.equal(f.collect().bytesRead, 0);
  status(gem, { provider: 'gemini', acp_model: 'gemini-3.8-flash-high', dir: '/home/fake/gem-project',
    finished: at, usage_input: 40, usage_output: 20, usage_total: 60 });
  fs.appendFileSync(`${deleted}.log`, 'tokens used\n2,000\n');
  f.collect();
  assert.equal(f.cache().days[localDay(f.now)].gemini.byProject['gem-project'], 68);
  assert.equal(f.cache().days[localDay(f.now)].codex.byProject.repo, 2200);
  fs.rmSync(rollout);
  fs.rmSync(`${deleted}.log`);
  fs.rmSync(`${gem}.status`);
  f.collect();
  assert.equal(f.cache().days[localDay(f.now)].codex.byProject.repo, 2200);
  assert.equal(f.cache().days[localDay(f.now)].gemini.byProject['gem-project'], 68);
});

test('Summary has seven ordered days, today/week totals, model/project rankings, and ten top jobs', { timeout }, (t) => {
  const f = fixture(t, Date.now()), at = new Date(f.now).toISOString();
  const ago = (count) => { const date = new Date(f.now); date.setDate(date.getDate() - count); return date.toISOString(); };
  jsonl(path.join(f.paths.projects, '-home-fake-repo', 'session.jsonl'), [
    assistant('today', at, 'claude-opus', 10, 2, 3, 4), assistant('six', ago(6), 'claude-opus', 20, 5),
    assistant('seven', ago(7), 'claude-opus', 100, 10), assistant('keep', ago(34), 'claude-opus', 30, 2),
    assistant('expire', ago(35), 'claude-opus', 1000, 200)
  ]);
  const records = [];
  for (let index = 1; index <= 12; index++) {
    const out = path.join(f.root, 'jobs', `job-${index}`);
    status(out, { state: 'done', model: 'gpt-6-luna', dir: '/home/fake/repo', finished: at });
    write(`${out}.log`, `tokens used\n${index * 100}\n`);
    records.push({ out, finished: at });
  }
  const gem = path.join(f.root, 'jobs', 'gem');
  status(gem, { provider: 'gemini', acp_model: 'gemini-3.8-flash', usage_input: 7, usage_output: 8,
    usage_total: 15, dir: '/home/fake/other', finished: at });
  jsonl(f.paths.registry, [...records, { out: gem, finished: at }]);
  f.collect();
  const cache = f.cache(), summary = readUsageSummary({ env: f.env, now: f.now });
  assert.deepEqual(Object.keys(summary), ['at', 'today', 'week', 'days', 'byModel7d', 'byProject7d', 'topJobs']);
  assert.equal(summary.days.length, 7);
  assert.deepEqual(summary.days.map((day) => day.date), Array.from({ length: 7 }, (_, index) => localDay(ago(6 - index))));
  assert.deepEqual(summary.today.claude, { total: 19, input: 10, output: 2, cached: 7 });
  assert.deepEqual(summary.week.claude, { total: 44, input: 30, output: 7, cached: 7 });
  assert.equal(summary.today.codex.total, 7800);
  assert.equal(summary.week.gemini.total, 15);
  assert.equal(summary.byModel7d[0].model, 'gpt-6-luna');
  assert.equal(summary.byProject7d[0].project, 'repo');
  assert.equal(summary.byProject7d[0].total, 7844);
  assert.equal(summary.topJobs.length, 10);
  assert.equal(summary.topJobs[0].total, 1200);
  assert.ok(summary.topJobs.every((job, index, rows) => !index || rows[index - 1].total >= job.total));
  assert.ok(cache.days[localDay(ago(34))]);
  assert.ok(!cache.days[localDay(ago(35))]);
  // CLI summaries must remain independent of the large collector state and source files.
  write(f.paths.state, '{invalid');
  fs.rmSync(f.paths.projects, { recursive: true });
  assert.deepEqual(run(cli, ['summary', '--json'], f.env), summary);
  assert.deepEqual(run(cli, ['summary'], f.env), summary);
});

test('Luna overview reads only cache and refreshes stale usage in one detached collector', { timeout }, async (t) => {
  const f = fixture(t, Date.now()), marker = path.join(f.root, 'collector.jsonl'), done = path.join(f.root, 'done');
  const stop = path.join(f.root, 'stop'), fake = path.join(f.root, 'fake-collector.mjs');
  const date = localDay(f.now), at = new Date(f.now).toISOString();
  const cache = { v: 1, at, days: { [date]: { claude: { byModel: { test: {
    input: 5, output: 2, cacheRead: 3, cacheWrite: 1, total: 11, messages: 1
  } }, byProject: { repo: 11 } } } }, topJobs: [] };
  write(f.paths.cache, JSON.stringify(cache));
  write(f.paths.state, '{invalid state must never be read on the poll path');
  write(path.join(f.paths.run, 'reap-brokers.stamp'), '');
  write(fake, [
    "import fs from 'node:fs';", `import { acquireUsageLock } from ${JSON.stringify(new URL('../usage.mjs', import.meta.url).href)};`,
    'const release = acquireUsageLock();', 'if (release) {',
    "  const stat = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');",
    `  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, session: Number(stat[3]),`,
    "    args: process.argv.slice(2) }) + '\\n');",
    '  const timer = setInterval(() => {', `    if (!fs.existsSync(${JSON.stringify(stop)})) return;`,
    `    release(); fs.writeFileSync(${JSON.stringify(done)}, 'done'); clearInterval(timer);`, '  }, 20);',
    '  setTimeout(() => { release(); process.exit(1); }, 60_000).unref();', '}'
  ].join('\n'));
  f.env.LUNA_USAGE_COLLECTOR = fake;
  const fresh = run(overview, [], f.env);
  assert.deepEqual(fresh.usage, { ...summarizeUsage(cache, f.now), stale: false });
  assert.ok(!fs.existsSync(marker));
  cache.at = new Date(f.now - 61_000).toISOString();
  write(f.paths.cache, JSON.stringify(cache));
  let pid;
  const waitFor = async (file) => {
    const deadline = Date.now() + timeout;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(file), `missing ${path.basename(file)}`);
  };
  try {
    const stale = run(overview, [], f.env);
    assert.equal(stale.usage.stale, true);
    assert.equal(stale.usage.today.claude.total, 11);
    assert.ok(!fs.existsSync(done));
    await waitFor(marker);
    const child = JSON.parse(fs.readFileSync(marker, 'utf8').trim());
    pid = child.pid;
    assert.deepEqual(child.args, ['collect']);
    assert.equal(child.session, child.pid);
    assert.equal(run(overview, [], f.env).usage.stale, true);
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
    write(stop, '');
    await waitFor(done);
    pid = undefined;
    assert.ok(!fs.existsSync(f.paths.lock));
    // A missing cache also returns an empty stale summary immediately.
    fs.rmSync(f.paths.cache);
    f.env.LUNA_USAGE_COLLECTOR = path.join(f.root, 'missing-collector.mjs');
    assert.equal(run(overview, [], f.env).usage.today.claude.total, 0);
  } finally {
    write(stop, '');
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});
