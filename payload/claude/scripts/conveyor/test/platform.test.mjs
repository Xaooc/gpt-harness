import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanBinary } from '../lib/platform.mjs';

const conveyor = fileURLToPath(new URL('../', import.meta.url));
const scripts = path.dirname(conveyor);
const hooks = path.resolve(scripts, '../hooks');
const adapter = new URL('../lib/platform.mjs', import.meta.url).href;

function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conveyor-platform-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function evaluate(source, env, cwd, input = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, ...env }, cwd, input, encoding: 'utf8', timeout: 15_000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CONVEYOR_PLATFORM selects the shell and process adapter', (t) => {
  const directory = temporary(t);
  const gitBash = path.join(directory, 'bash.exe');
  writeFileSync(gitBash, '');
  const probe = `
    import { bash, listProcesses, platform, processAlive, shell } from ${JSON.stringify(adapter)};
    console.log(JSON.stringify({ platform, bash: bash(), shell: shell(), alive: processAlive(process.pid),
      processes: platform === 'win32' ? listProcesses() : undefined }));
  `;
  const select = (platform) => JSON.parse(evaluate(probe, { CONVEYOR_PLATFORM: platform, GIT_BASH: gitBash }, directory));
  assert.deepEqual(select('linux'), { platform: 'linux', bash: 'bash', shell: ['/bin/sh', '-c'], alive: true });
  assert.deepEqual(select('win32'), { platform: 'win32', bash: gitBash, shell: [gitBash, '-c'], alive: true, processes: null });
});

test('scanBinary finds an Agent model enum across a chunk boundary', async (t) => {
  const file = path.join(temporary(t), 'claude.bin');
  const binary = Buffer.alloc(512 * 1024);
  const first = 'description of the task",Aa=["opus","sonnet","haiku"]';
  const second = 'description of the task",$m=["fable"]';
  binary.write(first, 64 * 1024 - 12);
  binary.write(second, binary.length - second.length);
  writeFileSync(file, binary);
  assert.deepEqual(await scanBinary(file, /description of the task",[A-Za-z0-9_$]+=\[[^\]\n]{1,300}\]/), [first, second]);
});

function modules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'test') return modules(file);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [file] : [];
  });
}

test('conveyor modules import on Windows and keep Linux primitives in the platform adapter', (t) => {
  const hookFiles = readdirSync(hooks).filter((name) => /^conveyor-.*\.mjs$/.test(name) ||
    ['harness-guards.mjs', 'plugin-quiet.mjs', 'luna-skill-autoload.mjs'].includes(name)).map((name) => path.join(hooks, name));
  const files = [...modules(conveyor), ...hookFiles, path.join(scripts, 'account-lease.mjs')];
  const forbidden = /\/(?:proc|bin\/sh)(?![\w.-])|\bgrep\b|process\s*\.\s*kill\s*\(\s*-/;
  const violations = [];
  for (const file of files) {
    if (pathToFileURL(file).href === adapter) continue;
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (forbidden.test(line) && !/\/\/ platform-ok: \S.*$/.test(line)) {
        violations.push(`${path.relative(scripts, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'Linux primitives belong in lib/platform.mjs');

  const directory = temporary(t);
  const scratch = path.join(directory, '.config', 'Claude', 'scratch-workspaces');
  mkdirSync(scratch, { recursive: true });
  const env = { CONVEYOR_PLATFORM: 'win32', HOME: directory, USERPROFILE: directory,
    CLAUDE_HOME_DIR: path.join(directory, '.claude'), CONVEYOR_HOME: path.join(directory, 'conveyor') };
  // Some hooks consume stdin at import time, and plugin-quiet exits the process.
  for (const file of files) {
    evaluate(`await import(${JSON.stringify(pathToFileURL(file).href)})`, env, scratch, JSON.stringify({ cwd: scratch }));
  }
});
