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

test('code and UI directives recur each session, with independent profile and verify-skill detection',
  { timeout: 3000 }, async (t) => {
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
    assert.match(first, /This repository has no conveyor profile/);
    assert.match(first, /init --dir .* --write/);
    assert.match(first, /measure fast\/turn/);
    assert.doesNotMatch(first, /UI repository/);
    assert.equal(await run(), first);
    const stateFile = path.join(conveyor, 'profile-suggestions.json');
    assert.equal(fs.existsSync(stateFile), false);
    const profile = write('repo/.claude/conveyor.json', {});
    assert.equal(await run(), '');
    write('repo/package.json', { dependencies: { react: '1' } });
    assert.match(await run(), /UI repository without a verify skill/);
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'verify-fixture'), { recursive: true });
    assert.match(await run(), /UI repository without a verify skill/);
    write('repo/.claude/skills/verify-fixture/SKILL.md', {});
    assert.equal(await run(), '');
    fs.rmSync(profile);
    assert.equal(await run(), first, 'a verify skill does not suppress the missing-profile directive');
    fs.rmSync(path.join(repo, '.claude', 'skills'), { recursive: true });
    write('repo/package.json', {});
    write('repo/frontend/package.json', { devDependencies: { vite: '1' } });
    assert.match(await run(), /UI repository without a verify skill/);
    fs.rmSync(path.join(repo, 'frontend'), { recursive: true });
    write('repo/main.py', {});
    write('repo/templates/index.html', {});
    assert.match(await run(), /UI repository without a verify skill/);
    assert.equal(await run(root), '');
    assert.equal(fs.existsSync(stateFile), false);
  });

test('scratch workspaces, non-git directories, and git repositories without code have no directives',
  { timeout: 3000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'conveyor-scratch-session-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, '.config/Claude/scratch-workspaces/fixture');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"dependencies":{"next":"1"}}');
    const git = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8', timeout: 1000 });
    assert.equal(git.status, 0, git.stderr);
    const claude = path.join(root, 'claude');
    fs.mkdirSync(path.join(claude, 'conveyor/hygiene'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'conveyor/hygiene/state.json'), JSON.stringify({ lastRunAt: new Date().toISOString() }));
    for (const cwd of [repo, root]) {
      const result = await invokeHook(hook, { cwd: root, input: JSON.stringify({ cwd }),
        env: { ...process.env, HOME: root, CLAUDE_HOME_DIR: claude, CONVEYOR_HOME: path.join(claude, 'conveyor') } });
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    fs.rmSync(path.join(repo, 'package.json'));
    const result = await invokeHook(hook, { cwd: root, input: JSON.stringify({ cwd: repo }),
      env: { ...process.env, HOME: path.join(root, 'elsewhere'), CLAUDE_HOME_DIR: claude,
        CONVEYOR_HOME: path.join(claude, 'conveyor') } });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
