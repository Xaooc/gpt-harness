#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, appendJsonl, nowIso, withLock, canonicalRepo, projectKeyForCwd } from '../learning/common.mjs';
import { loadChecks, refreshChecks } from '../learning/core.mjs';

function parse(args) {
  const [command, ...rest] = args;
  if (!['list', 'show', 'done', 'reject'].includes(command)) throw new Error('expected list, show, done or reject');
  const id = command === 'list' ? null : rest.shift();
  if (command !== 'list' && (!id || id.startsWith('-'))) throw new Error('id is required');
  const allowed = { list: ['--json', '--layer', '--repo'], show: [],
    done: ['--repo', '--proof', '--commit'], reject: ['--reason'] }[command];
  const opts = {};
  while (rest.length) {
    const key = rest.shift();
    if (!allowed.includes(key) || Object.hasOwn(opts, key)) throw new Error(`unexpected argument: ${key}`);
    if (key === '--json') opts[key] = true;
    else {
      const value = rest.shift();
      if (!value?.trim() || value.startsWith('--')) throw new Error(`value required: ${key}`);
      opts[key] = value;
    }
  }
  if (opts['--layer'] && !['project', 'harness'].includes(opts['--layer'])) throw new Error('invalid layer');
  for (const key of command === 'done' ? allowed : command === 'reject' ? ['--reason'] : []) {
    if (!opts[key]) throw new Error(`required: ${key}`);
  }
  return { command, id, opts };
}

export function main(args = process.argv.slice(2)) {
  let parsed;
  try { parsed = parse(args); }
  catch (error) { process.stderr.write(`checks: ${error.message}\n`); return 2; }
  const { command, id, opts } = parsed;
  if (command === 'list') {
    const repo = opts['--repo'] && canonicalRepo(projectKeyForCwd(path.resolve(opts['--repo'])));
    const items = loadChecks({ openOnly: true }).filter((item) => (
      (!opts['--layer'] || item.layer === opts['--layer']) && (!repo || item.layer === 'harness' || item.repo === repo)
    )).sort((a, b) => String(b.last_at || b.at).localeCompare(String(a.last_at || a.at)))
      .map((item) => ({ id: item.id, title: item.title, layer: item.layer, signal: item.signal,
        where: item.where, effect: item.effect, evidence_count: item.evidence?.length || 0 }));
    process.stdout.write(opts['--json'] ? `${JSON.stringify(items, null, 2)}\n` : items.map((item) => (
      `${item.id} | ${item.title} | ${item.layer} | ${item.signal} | ${item.where} | ${item.effect}`
      + ` | evidence: ${item.evidence_count}\n`
    )).join(''));
    return 0;
  }
  if (command === 'show') {
    const item = loadChecks().find((entry) => entry.id === id);
    if (!item) throw new Error(`unknown id: ${id}`);
    process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    return 0;
  }
  const result = withLock('checks', { waitMs: 5000 }, () => {
    const item = loadChecks().find((entry) => entry.id === id);
    if (!item) throw new Error(`unknown id: ${id}`);
    const at = nowIso();
    const audit = command === 'done'
      ? { id, status: 'built', repo: path.resolve(opts['--repo']), proof: opts['--proof'], commit: opts['--commit'], at }
      : { id, status: 'rejected', reason: opts['--reason'], at };
    // The loop folds by key and understands done/dismissed; preserve its repository identity.
    const record = { ...item, event: 'status', status: command === 'done' ? 'done' : 'dismissed', at,
      ...(command === 'done' ? { proof: audit.proof, commit: audit.commit, built_repo: audit.repo }
        : { reason: audit.reason }) };
    fs.mkdirSync(path.dirname(paths.checks), { recursive: true });
    appendJsonl(paths.checks, [audit, record]);
  });
  if (!result.locked) throw new Error('checks lock busy');
  refreshChecks();
  process.stdout.write(`${id}: ${command === 'done' ? 'built' : 'rejected'}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`checks: ${error.message}\n`); process.exitCode = 1; }
}
