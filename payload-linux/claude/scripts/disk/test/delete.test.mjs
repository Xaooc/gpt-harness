import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDelete } from '../lib.mjs';

test('recursive deletion unlinks a symlink without visiting its target', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'disk delete test-'));
  const outside = path.join(root, 'outside');
  const candidate = path.join(root, 'candidate');
  try {
    fs.mkdirSync(outside);
    fs.mkdirSync(candidate);
    const file = path.join(outside, 'source.txt');
    fs.writeFileSync(file, 'source data must survive');
    const link = path.join(candidate, 'symlink');
    fs.symlinkSync(outside, link, 'dir');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    fs.writeFileSync(path.join(candidate, 'cache.txt'), 'cache');
    const result = safeDelete(candidate);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(candidate), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'source data must survive');
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.equal(safeDelete(root).removed, true);
  }
});
