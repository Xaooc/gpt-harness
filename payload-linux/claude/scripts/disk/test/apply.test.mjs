import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, DEFAULTS, git, loadConfig, safeDelete } from '../lib.mjs';
import { runAudit, humanReport } from '../audit.mjs';

test('new audit configs have no repositories and existing configured repositories survive', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'disk-config-test-'));
  try {
    const file = path.join(root, 'disk-audit.json');
    const fresh = loadConfig(file);
    assert.deepEqual(fresh.repos, []);
    assert.deepEqual(fresh.liveRefs, {});
    const repo = path.join(root, 'repo');
    fs.writeFileSync(file, JSON.stringify({ repos: [repo], liveRefs: { [repo]: ['main'] } }));
    const existing = loadConfig(file);
    assert.deepEqual(existing.repos, [repo]);
    assert.deepEqual(existing.liveRefs, { [repo]: ['main'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rule B deletes only old untracked children and preserves KEEP, fresh and tracked data', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'disk apply test-'));
  const previousHome = process.env.DISK_AUDIT_HOME;
  process.env.DISK_AUDIT_HOME = path.join(root, 'home');
  const repo = path.join(root, 'Repo');
  const old = new Date(Date.now() - 10 * DAY);
  try {
    fs.mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Disk test']);
    git(repo, ['config', 'user.email', 'disk-test@localhost']);
    git(repo, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    const temp = path.join(repo, '.tmp');
    for (const name of ['old', 'marked', 'fresh', 'listed', 'linked']) fs.mkdirSync(path.join(temp, name), { recursive: true });
    fs.writeFileSync(path.join(temp, 'old', 'cache'), 'regenerable');
    fs.writeFileSync(path.join(temp, 'marked', 'KEEP'), 'keep');
    fs.writeFileSync(path.join(temp, 'fresh', 'output'), 'fresh');
    fs.writeFileSync(path.join(temp, 'listed', 'output'), 'keep by list');
    fs.writeFileSync(path.join(temp, '.keep'), 'listed\n');
    fs.writeFileSync(path.join(temp, 'x'), 'tracked source');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'source'), 'must survive');
    fs.symlinkSync(outside, path.join(temp, 'linked', 'data'), 'dir');
    fs.lutimesSync(path.join(temp, 'linked', 'data'), old, old);
    const cache = path.join(repo, '.next');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'output'), 'regenerable cache');
    fs.utimesSync(path.join(cache, 'output'), old, old);
    fs.utimesSync(cache, old, old);
    git(repo, ['add', '--', '.tmp/x']);
    git(repo, ['commit', '-m', 'tracked fixture']);
    for (const name of ['old/cache', 'old', 'marked/KEEP', 'marked', 'listed/output', 'listed', 'x', 'linked']) {
      fs.utimesSync(path.join(temp, name), old, old);
    }
    const missing = path.join(root, 'missing repo');
    const config = { ...DEFAULTS, repos: [repo, missing], liveRefs: {}, sources: path.join(root, 'sources') };
    const active = runAudit(config, { processQuery: () => `node ${path.join(repo, 'server.mjs')}` });
    assert.equal(active.candidates.some((item) => item.path === cache), false);
    const report = runAudit(config, { apply: true, processQuery: () => repo.toLowerCase() });
    assert.equal(fs.existsSync(cache), process.platform === 'win32');
    assert.equal(report.repos[1].missing, true);
    assert.equal(report.complete, true);
    assert.equal(fs.existsSync(missing), false);
    assert.ok(humanReport(report).split('\n').includes(`${missing}: missing repository`));
    assert.equal(fs.existsSync(path.join(temp, 'old')), false);
    assert.equal(fs.existsSync(path.join(temp, 'marked', 'KEEP')), true);
    assert.equal(fs.existsSync(path.join(temp, 'listed', 'output')), true);
    assert.equal(fs.existsSync(path.join(temp, 'fresh', 'output')), true);
    assert.equal(fs.readFileSync(path.join(temp, 'x'), 'utf8'), 'tracked source');
    assert.equal(fs.existsSync(temp), true);
    assert.equal(fs.existsSync(path.join(temp, 'linked')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'source'), 'utf8'), 'must survive');
    assert.ok(report.deletedBytes > 0);
    const log = fs.readFileSync(path.join(process.env.DISK_AUDIT_HOME, 'disk-audit', 'apply.log'), 'utf8');
    const events = log.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.rule === 'B' && event.bytes > 0 && !event.skipped));
    assert.ok(events.some((event) => event.path.endsWith(`${path.sep}x`) && event.skipped));
  } finally {
    if (previousHome === undefined) delete process.env.DISK_AUDIT_HOME;
    else process.env.DISK_AUDIT_HOME = previousHome;
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.equal(safeDelete(root).removed, true);
  }
});
