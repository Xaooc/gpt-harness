#!/usr/bin/env node
// Runs on the host as pytest_gate.py's launcher for one test run inside an ML AI Code sandbox (see gate-bridge.mjs):
// the gate holds the machine-wide slots while this process lives. It grants the run, then waits until the sandbox
// reports it done, or until nothing of that run is left (its process group, or a process carrying its basetemp), so a
// killed run never keeps slots and a live one never loses them.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processRows } from '../lib/luna-runtime.mjs';

const [dir, id, pgid] = process.argv.slice(2);
if (!dir || !/^[\w.-]+$/.test(id ?? '') || !/^\d+$/.test(pgid ?? '')) {
  process.stderr.write('gate-hold: usage: gate-hold.mjs <bridge dir> <id> <pgid> [gate args...]\n');
  process.exit(2);
}
const marker = path.join(dir, `run-${id}`);
const alive = () => processRows().some((row) => row.state !== 'Z' &&
  (row.group === Number(pgid) || row.command.includes(marker)));
const temp = path.join(dir, `.grant-${id}`);
writeFileSync(temp, `${process.pid}\n`);
renameSync(temp, path.join(dir, `grant-${id}`));
while (!existsSync(path.join(dir, `done-${id}`)) && alive()) await delay(500);
process.exit(0);
