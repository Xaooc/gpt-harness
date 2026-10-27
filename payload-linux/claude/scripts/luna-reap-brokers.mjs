#!/usr/bin/env node
// Reap leaked Codex-plugin broker trees, never general Codex or Node processes.
// Unrecorded brokers and parentless plugin app-servers qualify after ten minutes; bloated live brokers after an hour.
// Unknown ages and failed snapshots protect processes; dry runs never touch the stamp/lock or kill anything.
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { readProcess, timedProcessRows } from './lib/luna-runtime.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const INTERVAL_MS = 600_000;
const LOCK_MS = 300_000;
const BLOATED_AGE_MS = 60 * 60_000;
const BROKER = /app-server-broker\.mjs"?\s+serve\b/i;
const APP_SERVER = /\/@openai\/codex\/bin\/codex\.js"?\s+app-server\b/i;

function replLimit() {
  const value = process.env.LUNA_REAP_MAX_REPL;
  const limit = value?.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : 40;
}

export function selectVictims({ nodes, livePids, brokerPids, now, selfPid, parentPid,
  repls = [], treeNodes = nodes, maxRepl = 40 }) {
  const brokers = [];
  const appServers = [];
  const bloated = [];
  const children = new Map();
  const replPids = new Set(repls.map((repl) => repl.ProcessId));
  for (const node of [...treeNodes, ...repls]) {
    if (!Number.isInteger(node.ProcessId) || node.ProcessId <= 0 || !Number.isInteger(node.ParentProcessId)) continue;
    if (!children.has(node.ParentProcessId)) children.set(node.ParentProcessId, new Set());
    children.get(node.ParentProcessId).add(node.ProcessId);
  }
  function descendantRepls(pid) {
    const visited = new Set([pid]);
    const pending = [pid];
    let count = 0;
    while (pending.length) {
      for (const child of children.get(pending.pop()) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        pending.push(child);
        if (replPids.has(child)) count += 1;
      }
    }
    return count;
  }
  for (const node of nodes) {
    const pid = node?.ProcessId;
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || pid === parentPid) continue;
    const created = typeof node.Created === 'string' ? Date.parse(node.Created) : NaN;
    if (!Number.isFinite(created) || now - created < INTERVAL_MS) continue;
    const command = typeof node.CommandLine === 'string' ? node.CommandLine : '';
    if (BROKER.test(command) && !brokerPids.has(pid)) brokers.push(node);
    else if (APP_SERVER.test(command) && Number.isInteger(node.ParentProcessId) &&
      (node.ParentProcessId <= 1 || !livePids.has(node.ParentProcessId))) appServers.push(node);
    else if (BROKER.test(command) && brokerPids.has(pid) && now - created >= BLOATED_AGE_MS &&
      descendantRepls(pid) > maxRepl) bloated.push(node);
  }
  return { brokers, appServers, bloated };
}

function array(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function parseSnapshot(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || !Object.hasOwn(value, 'node') || !Object.hasOwn(value, 'pids')) {
    throw Error('incomplete process snapshot');
  }
  const nodes = array(value.node);
  const pids = array(value.pids);
  const repls = array(value.repls);
  const treeNodes = value.tree == null ? nodes : array(value.tree);
  if (!pids.length || pids.some((pid) => !Number.isInteger(pid) || pid < 0) ||
    [...nodes, ...repls, ...treeNodes].some((node) => !node || typeof node !== 'object' || Array.isArray(node))) {
    throw Error('invalid process snapshot');
  }
  return { nodes, livePids: new Set(pids), repls, treeNodes };
}

function processSnapshot() {
  const rows = timedProcessRows();
  const nodes = rows.filter((row) => /(?:^|\/)node(?:\s|$)/.test(row.command)).map((row) => ({
    ProcessId: row.pid, ParentProcessId: row.ppid, CommandLine: row.command,
    Created: new Date(row.created).toISOString(), Started: row.started
  }));
  const livePids = new Set(fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number));
  const repls = rows.filter((row) => /(?:^|\/)node_repl(?:\s|$)/.test(row.command))
    .map((row) => ({ ProcessId: row.pid, ParentProcessId: row.ppid }));
  const treeNodes = rows.map((row) => ({ ProcessId: row.pid, ParentProcessId: row.ppid }));
  return { nodes, livePids, repls, treeNodes };
}

function directories(root) {
  try {
    // Include junctions and directory links too; readdir at the next fixed level rejects ordinary files.
    return fs.readdirSync(root).map((name) => path.join(root, name));
  } catch { return []; }
}

function brokerPids(home) {
  const states = directories(path.join(home, '.claude', 'plugins', 'data')).map((dir) => path.join(dir, 'state'));
  states.push(path.join(tmpdir(), 'codex-companion', 'state'));
  const pids = new Set();
  for (const root of states) {
    for (const dir of directories(root)) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'broker.json'), 'utf8'));
        if (Number.isInteger(state?.pid)) pids.add(state.pid);
      } catch {}
    }
  }
  return pids;
}

function recentStamp(stamp) {
  try { return Date.now() - fs.statSync(stamp).mtimeMs < INTERVAL_MS; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function takeLock(lock) {
  try { fs.mkdirSync(lock); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_MS) return false;
    // Locks contain no files. Never recursively remove an unexpected directory.
    fs.rmdirSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try { fs.mkdirSync(lock); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function killTree(node) {
  const root = readProcess(node.ProcessId);
  if (!root || root.command !== node.CommandLine || root.started !== node.Started ||
      !(BROKER.test(root.command) || APP_SERVER.test(root.command))) return false;
  const rows = timedProcessRows();
  const selected = [root];
  const seen = new Set([root.pid]);
  for (let i = 0; i < selected.length; i++) {
    for (const row of rows) {
      if (row.ppid !== selected[i].pid || seen.has(row.pid) ||
          Number(row.started) < Number(selected[i].started)) continue;
      seen.add(row.pid);
      selected.push(row);
    }
  }
  const same = (row) => {
    const current = readProcess(row.pid);
    return current && current.state !== 'Z' && current.started === row.started && current.command === row.command;
  };
  const signal = (row, name) => {
    if (!same(row)) return;
    try { process.kill(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  for (const row of [...selected].reverse()) signal(row, 'SIGTERM');
  const deadline = Date.now() + 5000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (selected.some(same) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 100);
  for (const row of [...selected].reverse()) signal(row, 'SIGKILL');
  return true;
}

function writeLog(run, report) {
  if (!report.killed.length && !report.errors.length) return;
  try {
    fs.mkdirSync(run, { recursive: true });
    const log = path.join(run, 'reap-brokers.log');
    fs.appendFileSync(log, `${new Date().toISOString()} ${JSON.stringify(report)}\n`);
    if (fs.statSync(log).size > 200 * 1024) {
      const tail = Buffer.alloc(100 * 1024);
      const fd = fs.openSync(log, 'r');
      try { fs.readSync(fd, tail, 0, tail.length, fs.fstatSync(fd).size - tail.length); }
      finally { fs.closeSync(fd); }
      fs.writeFileSync(log, tail);
    }
  } catch {}
}

function reap(home, report) {
  const snapshot = processSnapshot();
  const victims = selectVictims({
    ...snapshot, brokerPids: brokerPids(home), now: Date.now(), selfPid: process.pid, parentPid: process.ppid,
    maxRepl: replLimit()
  });
  for (const [kind, nodes] of Object.entries(victims)) {
    for (const node of nodes) {
      try {
        // State may have been published after the snapshot; protect newly recorded brokers too.
        if (kind === 'brokers' && brokerPids(home).has(node.ProcessId)) continue;
        if (kind === 'appServers' && !alive(node.ProcessId)) continue;
        if (!killTree(node)) continue;
        report[kind] += 1;
        report.killed.push({ pid: node.ProcessId, command: node.CommandLine.slice(0, 80) });
      } catch (error) { report.errors.push(`pid=${node.ProcessId}: ${error.message}`); }
    }
  }
}

function selfTest() {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const broker = 'node /opt/plugin/app-server-broker.mjs serve';
  const app = 'node /opt/plugin/node_modules/@openai/codex/bin/codex.js app-server';
  const node = (command = broker, age = 11, pid = 101, parent = 202) => ({
    ProcessId: pid, ParentProcessId: parent, CommandLine: command,
    Created: new Date(now - age * 60_000).toISOString()
  });
  const select = (nodes, recorded = [], live = [], options = {}) => selectVictims({
    nodes, brokerPids: new Set(recorded), livePids: new Set(live), now, selfPid: 1, parentPid: 2, ...options
  });
  const empty = (result) => result.brokers.length === 0 && result.appServers.length === 0 && result.bloated.length === 0;
  const treeNodes = [101, 301, 302, 303, 304].map((pid, index, pids) => ({
    ProcessId: pid, ParentProcessId: index ? pids[index - 1] : 202
  }));
  const repls = Array.from({ length: 41 }, (_, index) => ({ ProcessId: 1000 + index, ParentProcessId: 304 }));
  const tests = [
    ['old unrecorded broker', () => assert.equal(select([node()]).brokers.length, 1)],
    ['recorded broker', () => assert.ok(empty(select([node()], [101])))],
    ['young broker', () => assert.ok(empty(select([node(broker, 9)])))],
    ['parentless app-server', () => assert.equal(select([node(app)]).appServers.length, 1)],
    ['parent alive', () => assert.ok(empty(select([node(app)], [], [202])))],
    ['Linux orphan reparented to init', () => {
      assert.equal(select([node(app, 11, 101, 1)], [], [1]).appServers.length, 1);
    }],
    ['unrelated processes', () => {
      const commands = ['luna-daemon.mjs --serve', 'vite.js', 'npx-cli.js vitest',
        '/usr/bin/codex', '/opt/codex app-server'];
      assert.ok(empty(select(commands.map((command) => node(command)))));
    }],
    ['self and parent protected', () => {
      assert.ok(empty(select([node(broker, 11, 1), node(broker, 11, 2), node(app, 11, 1), node(app, 11, 2)])));
    }],
    ['quoted and marketplaces paths', () => {
      const commands = [
        'node "/opt/some path/app-server-broker.mjs" serve --endpoint unix:/tmp/broker.sock',
        `node ${tmpdir()}/.claude/plugins/cache/openai-codex/codex/1/scripts/app-server-broker.mjs serve`,
        'node "/opt/some path/@openai/codex/bin/codex.js" app-server'
      ];
      const result = select(commands.map((command, index) => node(command, 11, 101 + index)));
      assert.equal(result.brokers.length, 2);
      assert.equal(result.appServers.length, 1);
    }],
    ['single-object snapshot', () => {
      const parsed = parseSnapshot(JSON.stringify({ node: node(), pids: 202 }));
      assert.deepEqual(parsed.nodes, [node()]);
      assert.deepEqual([...parsed.livePids], [202]);
      assert.deepEqual(parseSnapshot('{"node":null,"pids":[202]}').nodes, []);
    }],
    ['unknown creation times', () => {
      const nodes = [undefined, null, '', 'invalid'].flatMap((Created) =>
        [broker, app].map((command) => ({ ...node(command), Created })));
      assert.ok(empty(select(nodes)));
    }],
    ['exact age boundary', () => assert.equal(select([node(broker, 10)]).brokers.length, 1)],
    ['bloated live broker', () => {
      const result = select([node(broker, 61)], [101], [101], { repls, treeNodes });
      assert.deepEqual(result.bloated.map((entry) => entry.ProcessId), [101]);
      assert.equal(result.brokers.length, 0);
      assert.equal(result.appServers.length, 0);
    }],
    ['live broker under or at threshold', () => {
      for (const count of [39, 40]) {
        assert.ok(empty(select([node(broker, 61)], [101], [101], { repls: repls.slice(0, count), treeNodes })));
      }
    }],
    ['young bloated broker', () => {
      assert.ok(empty(select([node(broker, 59)], [101], [101], { repls, treeNodes })));
    }],
    ['bloated unrecorded broker only class A', () => {
      const result = select([node(broker, 61)], [], [101], { repls, treeNodes });
      assert.equal(result.brokers.length, 1);
      assert.equal(result.bloated.length, 0);
    }],
    ['bloated age boundary and custom threshold', () => {
      assert.equal(select([node(broker, 60)], [101], [101], { repls, treeNodes }).bloated.length, 1);
      assert.ok(empty(select([node(broker, 61)], [101], [101], { repls, treeNodes, maxRepl: 41 })));
    }],
    ['unrelated and duplicate REPLs do not inflate count', () => {
      const unrelated = repls.map((repl) => ({ ...repl, ParentProcessId: 999 }));
      assert.ok(empty(select([node(broker, 61)], [101], [101], { repls: unrelated, treeNodes })));
      const duplicates = Array(41).fill(repls[0]);
      assert.ok(empty(select([node(broker, 61)], [101], [101], { repls: duplicates, treeNodes })));
    }],
    ['extended single-object snapshot', () => {
      const parsed = parseSnapshot(JSON.stringify({ node: node(), pids: 101, repls: repls[0], tree: treeNodes[0] }));
      assert.deepEqual(parsed.repls, [repls[0]]);
      assert.deepEqual(parsed.treeNodes, [treeNodes[0]]);
    }],
    ['incomplete snapshots fail closed', () => {
      for (const value of ['{}', '{"node":[],"pids":null}', '{"node":[],"pids":["202"]}']) {
        assert.throws(() => parseSnapshot(value));
      }
    }]
  ];
  let passed = 0;
  for (const [name, test] of tests) {
    try { test(); passed += 1; }
    catch (error) { process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
  }
  process.stdout.write(`PASS ${passed}/${tests.length}\n`);
  return passed === tests.length ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const home = path.resolve(process.env.HOME || homedir());
  const run = path.join(home, '.claude', 'luna-run');
  if (args.includes('--dry-run')) {
    try {
      const snapshot = processSnapshot();
      const victims = selectVictims({
        ...snapshot, brokerPids: brokerPids(home), now: Date.now(), selfPid: process.pid, parentPid: process.ppid,
        maxRepl: replLimit()
      });
      process.stdout.write(`${JSON.stringify(victims, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ brokers: [], appServers: [], bloated: [], error: error.message })}\n`);
    }
    return 0;
  }
  const stamp = path.join(run, 'reap-brokers.stamp');
  const lock = path.join(run, 'reap-brokers.lock');
  const report = { brokers: 0, appServers: 0, bloated: 0, killed: [], errors: [] };
  let locked = false;
  try {
    if (!args.includes('--force') && recentStamp(stamp)) return 0;
    fs.mkdirSync(run, { recursive: true });
    locked = takeLock(lock);
    if (!locked) return 0;
    // Another session may have completed between our first stamp check and lock acquisition.
    if (!args.includes('--force') && recentStamp(stamp)) return 0;
    fs.writeFileSync(stamp, '');
    reap(home, report);
  } catch (error) { report.errors.push(error.message); }
  finally {
    if (locked) {
      try { fs.rmdirSync(lock); }
      catch (error) { report.errors.push(`lock cleanup: ${error.message}`); }
    }
    writeLog(run, report);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
