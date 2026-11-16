import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMetrics } from '../metrics.mjs';

const start = '2026-11-09T00:00:00Z', end = '2026-11-16T00:00:00Z';
const at = '2026-11-10T12:00:00Z';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'conveyor-metrics-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (relative, records) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.isArray(records)
      ? records.map((row) => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(records));
    return file;
  };
  return { home, write, collect: () => collectMetrics({ start, end, home }) };
}

test('corrections, interrupts, first completion and task rates use windowed ledger fixtures', { timeout: 5000 }, (t) => {
  const f = fixture(t);
  const correction = (session, ts, project = 'alpha') => ({ type: 'user_correction', session, ts, project,
    quote: 'PRIVATE fixture message', context: 'PRIVATE fixture context' });
  f.write('learning/events.jsonl', [
    correction('a', '2026-11-02T00:00:00Z'), correction('a', '2026-11-08T23:59:59Z'),
    correction('a', start), correction('a', '2026-11-10T12:00:01Z'), correction('a', '2026-11-10T14:00:00Z'),
    correction('b', at, 'beta'), correction('no-ledger', at, 'gamma'), correction('old', at, 'delta'),
    correction('a', '2026-11-16T00:00:01Z'),
    { type: 'user_interrupt', session: 'a', project: 'alpha', ts: at },
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'user_interrupt', project: `project-${i}`, ts: at })),
    { type: 'luna_job', session: 'a', ts: at }, { type: 'user_interrupt', ts: 'invalid' }
  ]);
  f.write('conveyor/ledgers/a.jsonl', [
    { type: 'start', at: start }, { type: 'done', at },
    { type: 'crosscheck', at: '2026-11-10T13:00:00Z' }, { type: 'waive', at, quote: 'PRIVATE waiver' }
  ]);
  f.write('conveyor/ledgers/b.jsonl', [{ type: 'checklist', at }]);
  f.write('conveyor/ledgers/old.jsonl', [{ type: 'done', at: '2026-11-08T00:00:00Z' }]);
  const state = f.write('conveyor/gate-state/a.json', { reasons: ['1. PRIVATE reason', '1. PRIVATE reason', '8. cleanup'] });
  fs.utimesSync(state, new Date(at), new Date(at));
  f.write('conveyor/gate-state/old.json', { at: '2026-11-08T00:00:00Z', reasons: ['2. old'] });
  f.write('conveyor/switches.jsonl', [{ at, from: 'gemini', to: 'codex' }, { at, from: 'gemini', to: 'codex' },
    { at: '2026-11-08T00:00:00Z', from: 'codex', to: 'claude' }]);
  f.write('learning/checks.jsonl', [{ status: 'built', at, repo: '/code/alpha' },
    { status: 'done', at, repo: '/code/alpha' }, { status: 'built', at: '2026-11-08T00:00:00Z', repo: '/code/beta' }]);
  f.write('conveyor/hygiene/older.json', { at: '2026-11-08T00:00:00Z', counts: { high: 9, medium: 9, low: 9 } });
  f.write('conveyor/hygiene/latest.json', { at, counts: { high: 1, medium: 2, low: 3 } });
  f.write('conveyor/hygiene/future.json', { at: '2026-11-17T00:00:00Z', counts: { high: 8, medium: 8, low: 8 } });
  const result = f.collect();
  assert.equal(result.corrections, 6);
  assert.equal(result.previousCorrections, 2);
  assert.equal(result.interrupts, 7);
  assert.equal(result.afterDone, 3);
  assert.equal(result.tasks, 2);
  assert.equal(result.correctionsPerTask, 2);
  assert.equal(result.projects.length, 5);
  assert.deepEqual(result.projects[0], { project: 'alpha', corrections: 3, interrupts: 1 });
  assert.equal(result.waivers, 1);
  assert.deepEqual(result.stopGate, { sessions: 1, reasons: { 1: 1, 8: 1 } });
  assert.deepEqual(result.switches, { 'gemini→codex': 2 });
  assert.deepEqual(result.checks, { built: 1, repos: [{ repo: '/code/alpha', count: 1 }] });
  assert.deepEqual(result.hygiene, { high: 1, medium: 2, low: 3 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('run indexes collect write gate outcomes including handoff and exits 5, 6 and 7', { timeout: 5000 }, (t) => {
  const f = fixture(t);
  const outcomes = [
    { code: 0, gate: { status: 'pass', rounds: 0 } },
    { code: 0, gate: { status: 'pass', rounds: 1 } },
    { code: 0, gate: { status: 'pass', rounds: 2 } },
    { code: 6, gate: { status: 'fail', rounds: 2 } }, { code: 4 }, { code: 5 }, { code: 7 },
    { mode: 'read', code: 0, gate: { status: 'pass', rounds: 0 } },
    { code: 0, gate: { status: 'warn', rounds: 0 } }
  ];
  const runs = outcomes.map((outcome, i) => {
    const out = path.join(f.home, 'runs', `${i}.md`);
    f.write(`runs/${i}.md.dispatch.json`, { mode: 'write', ...outcome });
    return { at, session: 'a', repo: '/code/alpha', out, tier: 'complex', mode: i % 2 ? 'write' : 'block' };
  });
  f.write('conveyor/sessions/a.jsonl', [...runs, { at, mode: 'warn', out: path.join(f.home, 'removed') },
    { ...runs[0], at: '2026-11-08T00:00:00Z' }]);
  assert.deepEqual(f.collect().executor, {
    writeRuns: 9, round0: 1, afterFix: 2, fixRounds: { 1: 1, 2: 2 }, red: 1,
    handoffs: 1, noProvider: 1, writeLocked: 1, unknown: 1
  });
});

test('end records retain outcomes after dispatch cleanup without counting starts twice', (t) => {
  const f = fixture(t);
  const outcomes = [
    { code: 0, gate: { status: 'pass', rounds: 0 } },
    { code: 0, gate: { status: 'pass', rounds: 1 } },
    { code: 6, gate: { status: 'fail', rounds: 2 } },
    { code: 7, gate: null }, { code: 4, gate: null }, { code: 5, gate: null },
    { code: 2, gate: { status: 'pass', rounds: 0 } },
    { code: null, gate: { status: 'pass', rounds: 0 } },
    { mode: 'read', code: 0, gate: null }
  ];
  const rows = outcomes.flatMap((outcome, i) => {
    const out = path.join(f.home, `deleted-${i}.md`);
    const completion = { event: 'end', at, out, mode: 'write', ...outcome };
    return outcome.code === 7 || outcome.mode === 'read'
      ? [completion] : [{ at, out, mode: 'block' }, completion];
  });
  f.write('conveyor/sessions/a.jsonl', rows);
  assert.deepEqual(f.collect().executor, {
    writeRuns: 8, round0: 1, afterFix: 1, fixRounds: { 1: 1, 2: 1 }, red: 1,
    handoffs: 1, noProvider: 1, writeLocked: 1, unknown: 0
  });
});

test('ordered end records take precedence over dispatch files when output paths are reused', (t) => {
  const f = fixture(t);
  const out = path.join(f.home, 'reused.md');
  const row = { at, out, mode: 'block' };
  f.write('reused.md.dispatch.json', { mode: 'read', code: 6 });
  f.write('conveyor/sessions/a.jsonl', [
    row, { ...row, event: 'end', code: 0, gate: { status: 'pass', rounds: 0 } },
    row, { ...row, event: 'end', code: 0, gate: { status: 'pass', rounds: 2 } },
    { ...row, at: '2026-11-08T00:00:00Z' }, { ...row, event: 'end', code: 6 }
  ]);
  const gate = f.collect().executor;
  assert.equal(gate.writeRuns, 2);
  assert.equal(gate.round0, 1);
  assert.equal(gate.afterFix, 1);
  assert.equal(gate.fixRounds[2], 1);
  assert.equal(gate.red, 0);
  assert.equal(gate.unknown, 0);
});

test('legacy dispatch runs with a null code and a passing gate count as green', (t) => {
  const f = fixture(t);
  const out = path.join(f.home, 'legacy.md');
  f.write('legacy.md.dispatch.json', { mode: 'write', code: null, gate: { status: 'pass', rounds: 0 } });
  f.write('conveyor/sessions/a.jsonl', [{ at, out, mode: 'block' }]);
  assert.deepEqual(f.collect().executor, {
    writeRuns: 1, round0: 1, afterFix: 0, fixRounds: { 1: 0, 2: 0 }, red: 0,
    handoffs: 0, noProvider: 0, writeLocked: 0, unknown: 0
  });
});

test('missing sources return null metrics without throwing', { timeout: 5000 }, (t) => {
  const f = fixture(t);
  const result = f.collect();
  assert.ok(Object.values(result).every((value) => value === null));
  assert.equal(collectMetrics({ start, end, home: path.join(f.home, 'missing') }).corrections, null);
});
