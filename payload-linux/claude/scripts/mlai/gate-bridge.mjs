// One machine-wide pytest pool for ML AI Code jobs (2026-11-25). pytest_gate.py keeps its slots in
// /tmp/pytest-gate-<uid>; the CLI's sandbox has a private /tmp and mounts extra folders read-only, so a gate inside it
// counted only its own runs. The sandbox can write ~/.cache, and this wrapper runs on the host for the whole job: the
// agent's `pytest` (bin/pytest) writes a request into a bridge folder there, the host gate takes the same number of
// slots with gate-hold.mjs as its "pytest", and the run starts once granted. A gate that refuses (disk, error) answers
// with a deny file instead.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcess } from '../lib/luna-runtime.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const HOLDER = path.join(HERE, 'gate-hold.mjs');

export class GateBridge {
  constructor({ dir, gate, log }) {
    Object.assign(this, { dir, gate, log, seen: new Set(), children: new Map() });
  }

  start() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const self = readProcess(process.pid);
    writeFileSync(path.join(this.dir, 'owner'), `${process.pid} ${self?.started ?? ''}\n`);
    sweep(path.dirname(this.dir), this.dir);
    this.timer = setInterval(() => this.poll(), 1000);
    return this;
  }

  poll() {
    let names = [];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const id = /^req-([\w.-]+)$/.exec(name)?.[1];
      if (!id || this.seen.has(id)) continue;
      this.seen.add(id);
      this.admit(id);
    }
  }

  admit(id) {
    let lines;
    try { lines = readFileSync(path.join(this.dir, `req-${id}`), 'utf8').split('\n'); } catch { return; }
    if (lines.at(-1) === '') lines.pop();
    const [, pgid, workers, ...args] = lines;
    if (!/^\d+$/.test(pgid ?? '') || !/^\d+$/.test(workers ?? '')) return this.deny(id, 'malformed request');
    this.log(`gate bridge: ${id} asks for ${workers} worker(s)`);
    const child = spawn('python3', [this.gate, '-n', workers, '--', ...args], {
      env: { ...process.env, PYTEST_GATE_LAUNCHER: JSON.stringify([process.execPath, HOLDER, this.dir, id, pgid]) },
      stdio: 'ignore', detached: true
    });
    this.children.set(id, child);
    child.on('error', (error) => this.deny(id, `could not start the gate: ${error.message}`));
    child.on('exit', (code) => {
      this.children.delete(id);
      if (!existsSync(path.join(this.dir, `grant-${id}`))) this.deny(id, `the gate refused (exit ${code})`);
      else this.log(`gate bridge: ${id} released`);
    });
  }

  deny(id, reason) {
    this.log(`gate bridge: ${id} denied: ${reason}`);
    try { writeFileSync(path.join(this.dir, `deny-${id}`), `${reason}\n`); } catch {}
  }

  async stop() {
    clearInterval(this.timer);
    for (const child of this.children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    for (let wait = 0; this.children.size && wait < 50; wait += 1) await delay(100);
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
}

/** Bridge folders of wrappers that died without their cleanup (a SIGKILL, 2026-11-25): their owner process is gone, or
 *  a folder without an owner is older than a day. Holders of such runs end on their own when the run's processes do. */
export function sweep(parent, keep) {
  let names = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    const dir = path.join(parent, name);
    if (dir === keep) continue;
    let stale;
    try {
      const [pid, started] = readFileSync(path.join(dir, 'owner'), 'utf8').trim().split(' ');
      const row = readProcess(pid);
      stale = !row || row.state === 'Z' || (started && row.started !== started);
    } catch {
      try { stale = Date.now() - statSync(dir).mtimeMs > 86_400_000; } catch { stale = false; }
    }
    if (stale) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
