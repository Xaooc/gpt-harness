import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeHook } from '../../scripts/conveyor/test/process-fixture.mjs';

const hook = fileURLToPath(new URL('../conveyor-hygiene-session-start.mjs', import.meta.url));

test('profile suggestion is weekly per repo and suppressed by an existing profile or verification skill',
  { timeout: 5000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'conveyor-session-start-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo'), claude = path.join(root, 'claude'), conveyor = path.join(claude, 'conveyor');
    const write = (relative, value) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    write('repo/package.json', { name: 'fixture' });
    const git = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8', timeout: 1000 });
    assert.ifError(git.error);
    assert.equal(git.status, 0, git.stderr);
    write('claude/conveyor/hygiene/state.json', { lastRunAt: new Date().toISOString() });
    const run = async (cwd = repo, extra = {}) => {
      const started = performance.now();
      const result = await invokeHook(hook, { cwd: root, input: JSON.stringify({ cwd }),
        env: { ...process.env, CLAUDE_HOME_DIR: claude, CONVEYOR_HOME: conveyor, HARNESS_REPO: path.join(root, 'harness'),
          ...extra } });
      assert.ok(performance.now() - started < 1000, 'SessionStart must finish within one second');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '';
    };
    const first = await run();
    assert.match(first, /propose a check\.mjs profile and create-verification-skill/);
    assert.equal(first.split('\n').length, 1);
    assert.equal(await run(), '');
    const stateFile = path.join(conveyor, 'profile-suggestions.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const key of Object.keys(state)) state[key] = new Date(Date.now() - 8 * 86400_000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(await run(), first);
    fs.rmSync(stateFile);
    const profile = write('repo/.claude/conveyor.json', {});
    assert.equal(await run(), '');
    assert.equal(fs.existsSync(stateFile), false);
    fs.rmSync(profile);
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'verify-fixture'), { recursive: true });
    assert.equal(await run(), '');
    fs.rmSync(path.join(repo, '.claude', 'skills'), { recursive: true });
    assert.equal(await run(repo, { HARNESS_REPO: repo }), '');
    assert.equal(await run(root), '');
    assert.equal(fs.existsSync(stateFile), false);
  });
