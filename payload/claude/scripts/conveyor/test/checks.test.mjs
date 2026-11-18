import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const cli = fileURLToPath(new URL('../checks.mjs', import.meta.url));

test('list/show/done/reject preserve the loop queue and refuse unknown ids', { timeout: 5000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'checks-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checks = path.join(root, 'checks.jsonl'), md = path.join(root, 'checks.md');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, CLAUDE_LEARNING_DIR: root }, encoding: 'utf8', timeout: 300_000
  });
  const old = new Date(Date.now() - 1000).toISOString(), now = new Date().toISOString();
  const item = (id, at, layer = 'project', repo = 'sample') => ({
    id, key: id, status: 'open', title: `Check ${id}`, layer, repo, signal: 'repeated mistake',
    where: 'src/check.mjs', effect: 'block', at, last_at: at, first_at: at,
    evidence: [{ event_id: `E-${id}`, quote: 'A real evidence quote.' }]
  });
  const initial = [item('one', old), item('two', now, 'harness', ''), item('other', old, 'project', 'other')];
  await fs.writeFile(checks, initial.map((entry) => JSON.stringify(entry) + '\n').join(''));
  const untouched = path.join(root, 'events.jsonl');
  await fs.writeFile(untouched, 'unchanged\n');
  let result = run(['list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map((entry) => entry.id), ['two', 'one', 'other']);
  assert.equal(JSON.parse(result.stdout)[0].evidence_count, 1);
  result = run(['list', '--json', '--layer', 'project', '--repo', '/home/test/sample']);
  assert.deepEqual(JSON.parse(result.stdout).map((entry) => entry.id), ['one']);
  assert.match(run(['list']).stdout, /one \| Check one \| project \| repeated mistake/);
  result = run(['show', 'one']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).evidence[0].quote, 'A real evidence quote.');
  const before = await fs.readFile(checks, 'utf8');
  result = run(['done', 'missing', '--repo', root, '--proof', 'node check.mjs', '--commit', 'abc123']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown id/);
  assert.equal(await fs.readFile(checks, 'utf8'), before);
  result = run(['done', 'one', '--repo', root, '--proof', 'node check.mjs', '--commit', 'abc123']);
  assert.equal(result.status, 0, result.stderr);
  const records = (await fs.readFile(checks, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.find((entry) => entry.status === 'built'), {
    id: 'one', status: 'built', repo: root, proof: 'node check.mjs', commit: 'abc123', at: records[3].at
  });
  assert.equal(records.at(-1).status, 'done');
  assert.match(await fs.readFile(md, 'utf8'), /one · done/);
  result = run(['reject', 'two', '--reason', 'Already enforced']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(run(['show', 'two']).stdout).reason, 'Already enforced');
  assert.match(await fs.readFile(md, 'utf8'), /two · dismissed/);
  assert.deepEqual(JSON.parse(run(['list', '--json']).stdout).map((entry) => entry.id), ['other']);
  assert.equal(await fs.readFile(untouched, 'utf8'), 'unchanged\n');
});
