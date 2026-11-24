import * as fs from 'node:fs/promises';
import { readFileSync, rmSync, writeFileSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import path from 'node:path';
import { processRows } from '../../lib/luna-runtime.mjs';
import { withLock } from './orchestration.mjs';
import { processAlive, readProcessStat } from './platform.mjs';

export const MLAI_EFFORT_MODELS = new Set(['pixis-opus']);

export function mlaiPaths(env = process.env) {
  const run = path.resolve(env.LUNA_RUN_DIR || path.join(homedir(), '.claude', 'luna-run'));
  const claude = env.CLAUDE_HOME_DIR || path.join(homedir(), '.claude');
  const home = path.resolve(env.MLAI_HOME || path.join(homedir(), '.mlai'));
  return {
    run, slots: path.join(run, 'mlai', 'slots'), active: path.join(run, 'mlai-active'),
    bin: path.resolve(env.MLAI_BIN || path.join(claude, 'tools', 'mlai', 'node_modules', '.bin', 'mlai')),
    home, auth: path.join(home, 'auth.json'), limit: Number(env.CONVEYOR_MLAI_SLOTS) || 2
  };
}

export async function mlaiLogin(now = Date.now(), env = process.env) {
  const { bin, auth } = mlaiPaths(env);
  try {
    await fs.access(bin, constants.X_OK);
    if (!(await fs.stat(bin)).isFile()) throw new Error('not a regular file');
  } catch { return { installed: false, signedIn: false, expiresAt: null, reason: 'not installed' }; }
  let expires;
  try { expires = JSON.parse(await fs.readFile(auth, 'utf8'))?.expires; }
  catch { /* Unreadable credentials cannot establish a sign-in. */ }
  const date = new Date(typeof expires === 'number' ? expires : NaN);
  if (!Number.isFinite(date.getTime())) {
    return { installed: true, signedIn: false, expiresAt: null, reason: 'not signed in' };
  }
  const signedIn = expires > now;
  return { installed: true, signedIn, expiresAt: date.toISOString(), reason: signedIn ? null : 'sign-in expired' };
}

function sameProcess({ pid, pid_start }) {
  if (!processAlive(pid)) return false;
  const start = readProcessStat(pid)?.started;
  return start === undefined || pid_start == null || start === String(pid_start);
}

function readRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; }
  catch (error) { return error.code === 'ENOENT' ? null : {}; }
}

function childMayBeLive(dir) {
  const child = readRecord(path.join(dir, 'child.json'));
  if (!child) return false;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !Number.isSafeInteger(child.pgid) || child.pgid <= 0) return true;
  return sameProcess(child) || processRows().some((row) => row.group === child.pgid && row.state !== 'Z');
}

async function inspectSlot(dir) {
  let stat;
  try { stat = await fs.stat(dir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const owner = readRecord(path.join(dir, 'owner.json'));
  // Allow time for a dispatcher to publish owner.json just after mkdir.
  const ownerGone = owner?.pid ? !sameProcess(owner) : Date.now() - stat.mtimeMs >= 10_000;
  return { stat, owner, stale: ownerGone && !childMayBeLive(dir) };
}

export async function slotState(env = process.env) {
  const { slots, limit } = mlaiPaths(env);
  const holders = [];
  for (let index = 0; index < limit; index++) {
    const state = await inspectSlot(path.join(slots, String(index)));
    if (state && !state.stale) {
      holders.push({ index, out: state.owner?.out ?? null, at: state.owner?.at ?? null });
    }
  }
  return { limit, used: holders.length, holders };
}

async function reclaimSlot(dir, { stat }) {
  const stale = `${dir}.stale.${randomUUID()}`;
  try { await fs.rename(dir, stale); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const moved = await fs.stat(stale);
  if (moved.ino !== stat.ino || moved.dev !== stat.dev) await fs.rename(stale, dir);
  else await fs.rm(stale, { recursive: true, force: true });
}

export async function acquireSlot({ out }, env = process.env) {
  const { slots, limit } = mlaiPaths(env);
  // Serialize reclamation and publication so a contender cannot rename a successor's slot.
  return withLock(path.join(slots, '.acquire'), async () => {
    for (let index = 0; index < limit; index++) {
      const dir = path.join(slots, String(index));
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await fs.mkdir(dir); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (attempt !== 0) break;
          const state = await inspectSlot(dir);
          if (state && !state.stale) break;
          if (state) await reclaimSlot(dir, state);
          continue;
        }
        const file = path.join(dir, 'owner.json');
        const owner = {
          pid: process.pid, pid_start: readProcessStat(process.pid)?.started ?? null,
          token: randomUUID(), out, at: new Date().toISOString()
        };
        try { writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 }); }
        catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
        const release = () => {
          if (readRecord(file)?.token !== owner.token || childMayBeLive(dir)) return;
          rmSync(dir, { recursive: true, force: true });
        };
        const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
          const handler = () => {
            release();
            // Let any write-lock handler clean up before exiting.
            setImmediate(() => process.exit(128 + osConstants.signals[signal]));
          };
          process.prependListener(signal, handler);
          return [signal, handler];
        });
        return { index, dir, release() {
          for (const [signal, handler] of handlers) process.off(signal, handler);
          release();
        } };
      }
    }
    return null;
  });
}
