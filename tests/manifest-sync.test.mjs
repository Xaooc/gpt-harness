/** Usage: node tests/manifest-sync.test.mjs. Isolated executable metadata regression check. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-test-'));
const payload = path.join(root, 'payload-linux');
const tool = path.join(root, 'tools/manifest-sync.mjs');
const manifestPath = path.join(payload, 'manifest.json');
const hash = text => createHash('sha256').update(text).digest('hex');
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 600_000 });

try {
  put(tool, fs.readFileSync(new URL('../tools/manifest-sync.mjs', import.meta.url)));
  put(path.join(payload, 'settings.json'), '{}');
  put(path.join(payload, 'section.md'), 'instructions');
  const scripts = ['script.mjs', 'helper.sh', 'mode-only.mjs'];
  const files = scripts.map(dest => {
    put(path.join(payload, 'claude', dest), 'plain text\n');
    return { src: `claude/${dest}`, dest, kind: 'file', sha256: hash('plain text\n') };
  });
  put(manifestPath, `${JSON.stringify({ version: 1, files, settings: 'settings.json', claudeMd: 'section.md',
    settingsSha256: hash('{}'), claudeMdSha256: hash('instructions') }, null, 2)}\n`);
  put(path.join(payload, files[0].src), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(payload, files[2].src), 0o755);
  const before = fs.readFileSync(manifestPath);
  let result = run('--check');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /executable.*claude\/script\.mjs/i);
  assert.match(result.stdout, /executable.*claude\/helper\.sh/i);
  assert.deepEqual(fs.readFileSync(manifestPath), before);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.executable), [true, true, undefined]);
  assert.equal(run('--check').status, 0);
  put(path.join(payload, files[0].src), 'plain text\n');
  result = run('--check');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /executable.*claude\/script\.mjs/i);
  assert.equal(run().status, 0);
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.executable), [undefined, true, undefined]);
  assert.equal(run('--check').status, 0);
  console.log('PASS: 1 manifest-sync executable regression check, 0 failures');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
