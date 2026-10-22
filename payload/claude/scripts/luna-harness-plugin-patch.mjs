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

function patchRoot(claudeHome, relative) {
  try {
    if (typeof relative !== 'string') throw new Error();
    const parts = relative.replaceAll('\\', '/').split('/');
    const glob = parts.at(-1) === '*';
    if (parts.some((part, index) => part.includes('*') && !(glob && index === parts.length - 1))) {
      throw new Error();
    }
    return { root: patchPath(claudeHome, glob ? parts.slice(0, -1).join('/') : relative), glob };
  } catch {
    throw new Error(`Invalid patch root: ${relative}`);
  }
}

export function expandRoots(claudeHome, roots) {
  return [...new Set(roots.flatMap(relative => {
    const { root, glob } = patchRoot(claudeHome, relative);
    if (!glob) return [root];
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => entry.name).sort().map(name => {
          const target = patchPath(root, name);
          return patchPath(claudeHome, path.relative(claudeHome, target));
        });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }))];
}

export function loadPatchSet(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(manifest.roots) || !Array.isArray(manifest.files)) {
    throw new Error('Invalid plugin patch manifest');
  }
  const root = path.dirname(manifestPath);
  for (const relative of manifest.roots) patchRoot(root, relative);
  const files = manifest.files.map(file => {
    patchPath(root, file.rel);
    const entries = file.variants ?? [file];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`Invalid patch variants: ${file.rel}`);
    const variants = entries.map(variant => {
      const copies = {};
      for (const kind of ['orig', 'patched']) {
        const bytes = fs.readFileSync(patchPath(root, variant[kind]));
        if (sha256(bytes) !== variant[`${kind}Sha256`]) throw new Error(`SHA256 mismatch: ${variant[kind]}`);
        copies[kind] = normalized(bytes);
      }
      return { ...variant, ...copies, origHash: sha256(copies.orig), patchedHash: sha256(copies.patched) };
    });
    for (let i = 0; i < variants.length; i++) {
      for (let j = i + 1; j < variants.length; j++) {
        const a = variants[i];
        const b = variants[j];
        if ((a.origHash === b.origHash && a.patchedHash !== b.patchedHash)
          || a.patchedHash === b.origHash || b.patchedHash === a.origHash) {
          throw new Error(`Conflicting patch variants: ${file.rel}`);
        }
      }
    }
    return { ...file, variants };
  });
  return { ...manifest, files };
}

export function matchPatch(bytes, file) {
  const hash = sha256(normalized(bytes));
  const patched = file.variants.find(variant => hash === variant.patchedHash);
  const original = file.variants.find(variant => hash === variant.origHash);
  const status = patched ? 'patched' : original ? 'patchable' : 'unknown';
  const eol = bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const variant = patched ?? original ?? file.variants[0];
  return { status, hash, bytes: Buffer.from(variant.patched.replaceAll('\n', eol)) };
}

export function restorable(targetBytes, backupBytes, file) {
  if (!targetBytes || !backupBytes || !file) return false;
  const targetHash = sha256(normalized(targetBytes));
  const backupHash = sha256(normalized(backupBytes));
  return file.variants.some(variant => variant.patchedHash === targetHash && variant.origHash === backupHash);
}

export function planRoot(root, files) {
  const missing = [];
  const entries = files.flatMap(file => {
    const target = patchPath(root, file.rel);
    let bytes;
    try {
      bytes = fs.readFileSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(file.rel);
        return [];
      }
      throw error;
    }
    const { bytes: patchedBytes, ...result } = matchPatch(bytes, file);
    return [{ file, target, bytes, patchedBytes, ...result }];
  });
  const unknown = entries.some(entry => entry.status === 'unknown');
  const incomplete = entries.length > 0 && missing.length > 0;
  return { entries, missing, unknown, incomplete, canPatch: missing.length === 0 && !unknown };
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
  for (const root of expandRoots(claudeHome, patches.roots)) {
    const plan = planRoot(root, patches.files);
    if (plan.incomplete) {
      failed = true;
      const key = JSON.stringify([root, plan.missing]);
      if (!check && !Object.hasOwn(state, key)) {
        append(`incomplete ${root}: missing ${plan.missing.join(', ')}`);
        state[key] = true;
        changed = true;
      }
    }
    for (const result of plan.entries) {
      const { target } = result;
      if (check) log(`${result.status}: ${target}`);
      if (result.status !== 'patched') failed = true;
      if (check || result.status === 'patched') continue;
      if (result.status === 'patchable') {
        if (!plan.canPatch) continue;
        const backup = `${target}.orig-luna-harness`;
        const exists = fs.existsSync(backup);
        if (!exists || !fs.readFileSync(backup).equals(result.bytes)) {
          atomicWrite(backup, result.bytes);
          if (exists) append(`refreshed backup: ${target}`);
        }
        atomicWrite(target, result.patchedBytes);
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
    function variant(name, original, replacement) {
      const origPath = `${name}-orig.mjs`;
      const patchedPath = `${name}-patched.mjs`;
      atomicWrite(path.join(root, origPath), original);
      atomicWrite(path.join(root, patchedPath), replacement);
      return { orig: origPath, patched: patchedPath,
        origSha256: sha256(original), patchedSha256: sha256(replacement) };
    }
    const a = variant('a', orig, patched);
    const origB = 'upstream original\nsecond\n';
    const patchedB = 'upstream patched\nsecond\n';
    const b = variant('b', origB, patchedB);
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = { roots: ['plugins/test'], files: [{ rel: 'example.mjs', variants: [a, b] }] };
    test('partial root logs missing targets once and leaves every known target untouched', () => {
      const files = ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs']
        .map(rel => ({ rel, orig: 'orig.mjs', patched: 'patched.mjs',
          origSha256: sha256(orig), patchedSha256: sha256(patched) }));
      const rootPath = path.join(temp, 'plugins/incomplete');
      atomicWrite(manifestPath, JSON.stringify({ roots: ['plugins/incomplete'], files }));
      const targets = files.slice(0, 3).map(file => path.join(rootPath, file.rel));
      targets.forEach(file => atomicWrite(file, orig));
      const before = targets.map(file => fs.readFileSync(file));
      assert.equal(planRoot(rootPath, loadPatchSet(manifestPath).files).canPatch, false);
      repairPlugins(temp);
      const logPath = path.join(temp, 'luna-run/plugin-patch.log');
      const incomplete = fs.readFileSync(logPath, 'utf8').split('\n')
        .filter(line => line.includes(`incomplete ${rootPath}: missing four.mjs`));
      assert.equal(incomplete.length, 1);
      targets.forEach((file, index) => {
        assert.deepEqual(fs.readFileSync(file), before[index]);
        assert.equal(fs.existsSync(`${file}.orig-luna-harness`), false);
      });
      const previousLog = fs.readFileSync(logPath);
      repairPlugins(temp);
      assert.deepEqual(fs.readFileSync(logPath), previousLog);
    });
    test('root with none of the manifest targets is skipped without writes or logs', () => {
      const files = ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs'].map(rel => ({ rel, ...a }));
      const emptyRoot = path.join(temp, 'plugins/empty');
      fs.mkdirSync(emptyRoot, { recursive: true });
      atomicWrite(manifestPath, JSON.stringify({ roots: ['plugins/empty'], files }));
      const logPath = path.join(temp, 'luna-run/plugin-patch.log');
      const before = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
      assert.equal(planRoot(emptyRoot, loadPatchSet(manifestPath).files).canPatch, false);
      repairPlugins(temp);
      assert.deepEqual(fs.existsSync(logPath) ? fs.readFileSync(logPath) : null, before);
      assert.deepEqual(fs.readdirSync(emptyRoot), []);
    });
    test('unknown target blocks the entire root and is logged once', () => {
      const files = ['one.mjs', 'two.mjs', 'unknown.mjs'].map(rel => ({ rel, variants: [a, b] }));
      atomicWrite(manifestPath, JSON.stringify({ roots: ['plugins/blocked'], files }));
      const targets = files.map(file => path.join(temp, 'plugins/blocked', file.rel));
      const originals = [orig, origB, 'unknown root content'];
      targets.forEach((file, index) => atomicWrite(file, originals[index]));
      assert.equal(planRoot(path.dirname(targets[0]), loadPatchSet(manifestPath).files).unknown, true);
      assert.equal(repairPlugins(temp, true, () => {}), 1);
      const logPath = path.join(temp, 'luna-run/plugin-patch.log');
      for (let run = 0; run < 2; run++) {
        assert.equal(repairPlugins(temp), 0);
        targets.forEach((file, index) => {
          assert.deepEqual(fs.readFileSync(file), Buffer.from(originals[index]));
          assert.equal(fs.existsSync(`${file}.orig-luna-harness`), false);
        });
      }
      const lines = fs.readFileSync(logPath, 'utf8').split('\n');
      assert.equal(lines.filter(line => line.includes(targets[2])).length, 1);
    });
    test('restorable requires the patched target and original backup from the same variant', () => {
      atomicWrite(manifestPath, JSON.stringify(manifest));
      const file = loadPatchSet(manifestPath).files[0];
      const bytes = text => Buffer.from(text);
      assert.equal(restorable(bytes(patchedB), bytes(origB), file), true);
      assert.equal(restorable(bytes(patchedB.replaceAll('\n', '\r\n')), bytes(origB), file), true);
      for (const [target, backup] of [[patchedB, orig], ['unknown', orig], [patchedB, 'garbage']]) {
        assert.equal(restorable(bytes(target), bytes(backup), file), false);
      }
    });
    test('stale backup is refreshed before patching and the second repair changes nothing', () => {
      atomicWrite(manifestPath, JSON.stringify(manifest));
      const backup = `${target}.orig-luna-harness`;
      const original = origB.replaceAll('\n', '\r\n');
      atomicWrite(target, original);
      atomicWrite(backup, origB);
      assert.equal(repairPlugins(temp), 0);
      assert.equal(fs.readFileSync(backup, 'utf8'), original);
      assert.equal(fs.readFileSync(target, 'utf8'), patchedB.replaceAll('\n', '\r\n'));
      const logPath = path.join(temp, 'luna-run/plugin-patch.log');
      const log = fs.readFileSync(logPath);
      assert.ok(log.toString().includes(`refreshed backup: ${target}`));
      const times = [target, backup].map(file => fs.statSync(file).mtimeMs);
      assert.equal(repairPlugins(temp), 0);
      assert.deepEqual(fs.readFileSync(logPath), log);
      assert.deepEqual([target, backup].map(file => fs.statSync(file).mtimeMs), times);
    });
    test('two variants select their own patched content with LF and CRLF', () => {
      atomicWrite(manifestPath, JSON.stringify(manifest));
      for (const eol of ['\n', '\r\n']) {
        for (const [original, replacement] of [[orig, patched], [origB, patchedB]]) {
          atomicWrite(target, original.replaceAll('\n', eol));
          assert.equal(repairPlugins(temp, true, () => {}), 1);
          assert.equal(repairPlugins(temp), 0);
          assert.equal(fs.readFileSync(target, 'utf8'), replacement.replaceAll('\n', eol));
        }
      }
      assert.equal(fs.readFileSync(`${target}.orig-luna-harness`, 'utf8'), origB.replaceAll('\n', '\r\n'));
    });
    test('variant B already patched causes no write or log line', () => {
      const before = fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log'));
      const stat = fs.statSync(target);
      assert.equal(repairPlugins(temp), 0);
      assert.equal(repairPlugins(temp, true, () => {}), 0);
      assert.deepEqual(fs.readFileSync(path.join(temp, 'luna-run/plugin-patch.log')), before);
      assert.equal(fs.statSync(target).mtimeMs, stat.mtimeMs);
      assert.equal(fs.readFileSync(target, 'utf8'), patchedB.replaceAll('\n', '\r\n'));
    });
    test('glob expands sorted direct directories and patches both versions in one run', () => {
      const roots = ['plugins/test/*'];
      atomicWrite(manifestPath, JSON.stringify({ ...manifest, roots }));
      const targetA = path.join(temp, 'plugins/test/1.0.3/example.mjs');
      const targetB = path.join(temp, 'plugins/test/1.0.6/example.mjs');
      atomicWrite(targetB, origB.replaceAll('\n', '\r\n'));
      atomicWrite(targetA, orig);
      assert.deepEqual(expandRoots(temp, roots), [path.dirname(targetA), path.dirname(targetB)]);
      assert.deepEqual(expandRoots(temp, ['plugins/missing/*']), []);
      assert.equal(repairPlugins(temp), 0);
      assert.equal(fs.readFileSync(targetA, 'utf8'), patched);
      assert.equal(fs.readFileSync(targetB, 'utf8'), patchedB.replaceAll('\n', '\r\n'));
      assert.equal(repairPlugins(temp, true, () => {}), 0);
      assert.equal(fs.readFileSync(`${targetA}.orig-luna-harness`, 'utf8'), orig);
      assert.equal(fs.readFileSync(`${targetB}.orig-luna-harness`, 'utf8'), origB.replaceAll('\n', '\r\n'));
    });
    test('old single-variant manifest still loads and patches', () => {
      atomicWrite(manifestPath, JSON.stringify({ roots: ['plugins/test'], files: [{ rel: 'example.mjs', ...a }] }));
      assert.equal(loadPatchSet(manifestPath).files[0].variants.length, 1);
      atomicWrite(target, orig);
      repairPlugins(temp);
      assert.equal(fs.readFileSync(target, 'utf8'), patched);
    });
    test('invalid roots are rejected by loader and expansion', () => {
      for (const invalid of ['plugins/*/test', 'plugins/test*', '../escape/*', '..\\escape', 'C:/escape']) {
        assert.throws(() => expandRoots(temp, [invalid]), /Invalid patch root/);
        atomicWrite(manifestPath, JSON.stringify({ ...manifest, roots: [invalid] }));
        assert.throws(() => loadPatchSet(manifestPath), /Invalid patch root/);
      }
    });
    test('ambiguous normalized originals and patched-to-original chains are rejected', () => {
      const duplicate = variant('duplicate', orig.replaceAll('\n', '\r\n'), patchedB);
      const chain = variant('chain', patched.replaceAll('\n', '\r\n'), patchedB);
      for (const variants of [[a, duplicate], [a, chain], [chain, a]]) {
        atomicWrite(manifestPath, JSON.stringify({ ...manifest, files: [{ rel: 'example.mjs', variants }] }));
        assert.throws(() => loadPatchSet(manifestPath), /Conflicting patch variants/);
      }
    });
    test('every variant payload hash is verified', () => {
      atomicWrite(manifestPath, JSON.stringify(manifest));
      atomicWrite(path.join(root, b.patched), 'corrupt');
      assert.throws(() => loadPatchSet(manifestPath), /SHA256 mismatch/);
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
