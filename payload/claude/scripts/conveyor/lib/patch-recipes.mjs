import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const originalWord = Buffer.from('ineligible', 'ascii');
const patchedWord = Buffer.from('inexigible', 'ascii');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const patchRecipes = Object.freeze([
  Object.freeze({
    file: 'language_server.exe', version: '2.32.1', replacements: 14,
    originalSha256: '65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f',
    patchedSha256: '944ab3421336b581af6b261841ebf5b4befd92ca3b24d67ecf994cc1195a1039'
  }),
  Object.freeze({
    file: 'agy.exe', version: '1.5.9', replacements: 15,
    originalSha256: '8803c289cac04d6e53f2211592d9981c2d5760bc0d9b4a7f222ef6ecc7abb38a',
    patchedSha256: '36f580671d589c611f33723473f2ddc1ee10293cc1c52b4164fb3714d1e90cb0'
  })
]);

function occurrences(bytes, word) {
  const positions = [];
  for (let index = bytes.indexOf(word); index !== -1; index = bytes.indexOf(word, index + word.length)) {
    positions.push(index);
  }
  return positions;
}

// The input is never mutated; all byte-level checks are independent of file IO and platform.
export function planPatch(bytes, recipe) {
  const failed = (reason) => ({ status: 'verification-failed', reason });
  if (!(bytes instanceof Uint8Array)) return failed('bytes must be a Uint8Array');
  if (!recipe || !/^[a-f0-9]{64}$/.test(recipe.originalSha256) ||
      !/^[a-f0-9]{64}$/.test(recipe.patchedSha256) ||
      !Number.isSafeInteger(recipe.replacements) || recipe.replacements < 1) {
    return failed('invalid recipe');
  }
  const original = Buffer.from(bytes), hash = sha256(original);
  if (hash === recipe.patchedSha256) return { status: 'already-patched' };
  if (hash !== recipe.originalSha256) return { status: 'unknown-build', reason: 'needs investigation' };
  const positions = occurrences(original, originalWord);
  if (positions.length !== recipe.replacements) {
    return failed(`expected ${recipe.replacements} ineligible occurrences; found ${positions.length}`);
  }
  if (occurrences(original, patchedWord).length !== 0) return failed('original contains inexigible');
  const candidate = Buffer.from(original);
  for (const offset of positions) patchedWord.copy(candidate, offset);
  if (candidate.length !== original.length) return failed('candidate size changed');
  let differingBytes = 0;
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== candidate[index]) differingBytes++;
  }
  if (differingBytes !== recipe.replacements) return failed('unexpected differing byte count');
  if (sha256(candidate) !== recipe.patchedSha256) return failed('candidate sha256 mismatch');
  const reversed = Buffer.from(candidate);
  for (const offset of occurrences(reversed, patchedWord)) originalWord.copy(reversed, offset);
  if (sha256(reversed) !== recipe.originalSha256) return failed('reverse replacement sha256 mismatch');
  return { status: 'ok', candidate, replacements: positions.length, sha256: recipe.patchedSha256 };
}

// Call only on a dedicated Windows binary copy. Linux updates never import or invoke this adapter.
export async function applyPatchFile(file) {
  if (process.platform !== 'win32') throw new Error('patch files are supported only on Windows');
  const target = path.resolve(file);
  const recipe = patchRecipes.find((entry) => entry.file.toLowerCase() === path.basename(target).toLowerCase());
  if (!recipe) return { status: 'unknown-build', reason: 'needs investigation' };
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('patch target must be a regular file');
  const original = await fs.readFile(target), plan = planPatch(original, recipe);
  if (plan.status !== 'ok') return plan;
  const backup = `${target}.${recipe.version}.${recipe.originalSha256}.bak`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    await fs.copyFile(target, backup, constants.COPYFILE_EXCL);
    if (sha256(await fs.readFile(backup)) !== recipe.originalSha256) throw new Error('backup sha256 mismatch');
    await fs.writeFile(temporary, plan.candidate, { flag: 'wx', mode: stat.mode & 0o777 });
    if (sha256(await fs.readFile(target)) !== recipe.originalSha256) throw new Error('patch target changed');
    await fs.rename(temporary, target);
    replaced = true;
    if (sha256(await fs.readFile(target)) !== recipe.patchedSha256) throw new Error('installed sha256 mismatch');
    return { status: 'ok', backup, replacements: plan.replacements, sha256: plan.sha256 };
  } catch (error) {
    if (replaced) {
      try {
        await fs.copyFile(backup, temporary, constants.COPYFILE_EXCL);
        await fs.rename(temporary, target);
        if (sha256(await fs.readFile(target)) !== recipe.originalSha256) throw new Error('restored sha256 mismatch');
      } catch (restoreError) {
        throw new Error(`${error.message}; restore failed: ${restoreError.message}; backup: ${backup}`);
      }
    }
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
}
