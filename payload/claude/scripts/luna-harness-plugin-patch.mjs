#!/usr/bin/env node
// Shared plugin patch engine and silent SessionStart repair command. No repository imports.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalized(bytes) {
  return bytes.toString('utf8').replaceAll('\r\n', '\n');
}

export function patchPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.win32.isAbsolute(relative)) {
    throw new Error(`Invalid patch path: ${relative}`);
  }
  const target = path.resolve(root, relative.replaceAll('\\', '/'));
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Patch path escapes root: ${relative}`);
  }
  return target;
}

export function loadPatchSet(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(manifest.roots) || !Array.isArray(manifest.files)) {
    throw new Error('Invalid plugin patch manifest');
  }
  const root = path.dirname(manifestPath);
  const files = manifest.files.map(file => {
    const copies = {};
    for (const kind of ['orig', 'patched']) {
      const bytes = fs.readFileSync(patchPath(root, file[kind]));
      if (sha256(bytes) !== file[`${kind}Sha256`]) throw new Error(`SHA256 mismatch: ${file[kind]}`);
      copies[kind] = normalized(bytes);
    }
    return { ...file, ...copies, origHash: sha256(copies.orig), patchedHash: sha256(copies.patched) };
  });
  return { ...manifest, files };
}

export function matchPatch(bytes, file) {
  const hash = sha256(normalized(bytes));
  const status = hash === file.patchedHash ? 'patched' : hash === file.origHash ? 'patchable' : 'unknown';
  const eol = bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  return { status, hash, bytes: Buffer.from(file.patched.replaceAll('\n', eol)) };
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function repairPlugins(claudeHome, check = false, log = console.log) {
  const patchRoot = path.join(claudeHome, 'luna-harness', 'codex-plugin-patches');
  const patches = loadPatchSet(path.join(patchRoot, 'manifest.json'));
  const runRoot = path.join(claudeHome, 'luna-run');
  const statePath = path.join(runRoot, 'plugin-patch-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  let changed = false;
  let failed = false;
  function append(message) {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.appendFileSync(path.join(runRoot, 'plugin-patch.log'), `${new Date().toISOString()} ${message}\n`);
  }
  for (const relativeRoot of patches.roots) {
    const root = patchPath(claudeHome, relativeRoot);
    for (const file of patches.files) {
      const target = patchPath(root, file.rel);
      if (!fs.existsSync(target)) continue;
      const result = matchPatch(fs.readFileSync(target), file);
      if (check) log(`${result.status}: ${target}`);
      if (result.status !== 'patched') failed = true;
      if (check || result.status === 'patched') continue;
      if (result.status === 'patchable') {
        try {
          fs.copyFileSync(target, `${target}.orig-luna-harness`, fs.constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        atomicWrite(target, result.bytes);
        append(`patched: ${target}`);
      } else {
        const key = JSON.stringify([target, result.hash]);
        if (Object.hasOwn(state, key)) continue;
        append(`unknown ${result.hash}: ${target}`);
        state[key] = true;
        changed = true;
      }
    }
  }
  if (changed) atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return check && failed ? 1 : 0;
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-plugin-patch-test-'));
  let passed = 0;
  function test(name, action) {
    action();
    console.log(`PASS ${name}`);
    passed++;
  }
  try {
    const root = path.join(temp, 'luna-harness', 'codex-plugin-patches');
    const orig = 'original\nsecond\n';
    const patched = 'patched\nsecond\n';
    atomicWrite(path.join(root, 'orig.mjs'), orig);
    atomicWrite(path.join(root, 'patched.mjs'), patched);
    atomicWrite(path.join(root, 'manifest.json'), JSON.stringify({
      roots: ['plugins/test'], files: [{ rel: 'example.mjs', orig: 'orig.mjs', patched: 'patched.mjs',
        origSha256: sha256(orig), patchedSha256: sha256(patched) }],
    }));
    const target = path.join(temp, 'plugins/test/example.mjs');
    test('original LF becomes patched LF', () => {
      atomicWrite(target, orig);
      assert.equal(repairPlugins(temp, true, () => {}), 1);
      assert.equal(repairPlugins(temp), 0);
      assert.equal(fs.readFileSync(target, 'utf8'), patched);
      assert.equal(fs.readFileSync(`${target}.orig-luna-harness`, 'utf8'), orig);
    });
    test('original CRLF becomes patched CRLF', () => {
      atomicWrite(target, orig.replaceAll('\n', '\r\n'));
      repairPlugins(temp);
      assert.equal(fs.readFileSync(target, 'utf8'), patched.replaceAll('\n', '\r\n'));
    });
    test('already patched is unchanged', () => {
      const before = fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log'));
      repairPlugins(temp);
      assert.equal(repairPlugins(temp, true, () => {}), 0);
      assert.deepEqual(fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log')), before);
    });
    test('unknown version is logged once per file and hash', () => {
      atomicWrite(target, 'unknown');
      assert.equal(repairPlugins(temp, true, () => {}), 1);
      repairPlugins(temp);
      const before = fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log'));
      repairPlugins(temp);
      assert.deepEqual(fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log')), before);
      assert.equal(before.toString().split('\n').filter(line => line.includes('unknown')).length, 1);
      atomicWrite(target, 'another unknown');
      repairPlugins(temp);
      const lines = fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log'), 'utf8').split('\n');
      assert.equal(lines.filter(line => line.includes('unknown')).length, 2);
    });
    console.log(`PASS: ${passed} tests, 0 failures`);
    return 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main(args) {
  const check = args.includes('--check');
  try {
    if (args.includes('--self-test')) return selfTest();
    return repairPlugins(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), check);
  } catch (error) {
    if (check || args.includes('--self-test')) {
      console.error(`FAIL: ${error.message}`);
      return 1;
    }
    return 0;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
