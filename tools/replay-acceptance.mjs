#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { jsonl, replayHistory, snapshot, transcriptHistory } from './lib/acceptance-history.mjs';

const usage = [
  'Usage: node tools/replay-acceptance.mjs --all --home <claude-home> [--as-of <UTC>]',
  '       node tools/replay-acceptance.mjs --ledger <jsonl> --transcript <jsonl> [--as-of <UTC>]'
].join('\n');

async function entries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function discover(home) {
  const projects = path.join(home, 'projects'), conveyor = path.join(home, 'conveyor');
  const ledgers = path.join(conveyor, 'ledgers');
  const projectDirs = (await entries(projects)).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
  const files = (await entries(ledgers)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(({ name }) => name).sort();
  const known = new Set(files), transcripts = new Map(), duplicates = new Set();
  for (const dir of projectDirs) {
    for (const entry of await entries(path.join(projects, dir))) {
      if (!known.has(entry.name) || !entry.isFile()) continue;
      if (transcripts.has(entry.name)) duplicates.add(entry.name);
      else transcripts.set(entry.name, path.join(projects, dir, entry.name));
    }
  }
  return files.map((name) => ({ session: path.basename(name, '.jsonl'), ledger: path.join(ledgers, name),
    transcript: transcripts.get(name), runs: path.join(conveyor, 'sessions', name), duplicate: duplicates.has(name) }));
}

async function records(input, cutoff) {
  const rows = [];
  for await (const { entry } of jsonl(input)) {
    if (Date.parse(entry.at) <= cutoff) rows.push(entry);
  }
  return rows;
}

const counts = ['stops', 'summaries', 'comparable', 'oldBlocks', 'warnings', 'oldAllowances', 'wip', 'cancelled',
  'unobserved', 'newBlocks', 'unknown', 'allowances', 'identical', 'adjacent', 'legacy', 'inferred', 'ambiguous', 'missingDelivery'];
const escapeCell = (text) => String(text).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');

function reportRow(row) {
  const cells = [row.session, row.comparable, row.oldBlocks, `${row.warnings} / ${row.oldAllowances}`,
    `${row.wip} / ${row.cancelled} / ${row.unobserved}`, row.newBlocks, row.unknown, row.allowances,
    `${row.identical} / ${row.adjacent}`, row.reopened.size, row.notes || ''];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function detail(rows, field, heading) {
  const lines = rows.flatMap((row) => [...row[field].values()].map((outcome) => {
    const { task, item, at, checkpoint, kinds, reason } = outcome;
    return `| ${[row.session, `${task}/${item}`, `${new Date(at).toISOString()} (${checkpoint})`, kinds, reason]
      .map(escapeCell).join(' | ')} |`;
  }));
  if (!lines.length) return [`### ${heading}`, '', 'None observed.', ''];
  return [`### ${heading}`, '', '| Session | Outcome | First checkpoint (UTC and Stop ID) | Old proof | v2 reason |',
    '| --- | --- | --- | --- | --- |', ...lines, ''];
}

function markdown(rows, cutoff) {
  const total = Object.fromEntries(counts.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
  const totalSize = (field) => ({ size: rows.reduce((sum, row) => sum + row[field].size, 0) });
  const reasons = new Map();
  for (const row of rows) {
    for (const [reason, count] of row.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + count);
  }
  return [
    '## Acceptance replay', '',
    cutoff === Infinity ? 'Cutoff is the available corpus at startup.' : `Cutoff is ${new Date(cutoff).toISOString()} (inclusive).`, '',
    '| Session | Comparable Stops | Old hard blocks | Old warnings / allowances | Old WIP / cancelled / unobserved | ' +
      'New hard blocks | Indeterminate | Unchanged-blocker allowances | Identical new blocks / comparable adjacent pairs | ' +
      'Old-proven → new-open | Notes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(reportRow), reportRow({ ...total, session: '**Total**', reopened: totalSize('reopened') }), '',
    `Recovered ${total.stops} Stop checkpoints across ${rows.length} sessions, including ${total.summaries} conveyor summaries.`,
    `At ${total.missingDelivery} checkpoints the projection reached check 6 with no recorded delivery.`,
    `Inferred rollovers: ${total.inferred}. Ambiguous delivery boundaries left in the existing request: ${total.ambiguous}.`, '',
    ...detail(rows, 'reopened', 'Confirmed old-proven → new-open outcomes'),
    ...detail(rows, 'possible', 'Possible evidence losses with missing historical facts'),
    '### Limitations', '',
    `- Production would bypass the ${total.legacy} checkpoints in legacy requests. Replay projects their starts into v2 requests.`,
    '- New decisions assume enforcement mode. Historical warnings and repeat allowances reflect what v1 actually emitted.',
    '- A checkpoint uses the first conveyor attachment time and transcript position, falling back to the summary.',
    '- Comparable Stops have an observed old outcome and a determinate projected outcome. Adjacent pairs are consecutive ' +
      'recorded Stops in one session with comparable outcomes and known identities for any emitted block.',
    '- Editor results and executor acceptance rows provide historical scope. Old executor runs or commit results without ' +
      'recorded deltas can leave scope incomplete. Live jobs use recorded WIP and launch/end observations.',
    '- A later v1 check can establish that v1 accepted outcome evidence. Old cross-check hashes supply no v2 delivery fingerprint. ' +
      'A new reviewer’s findings are unavailable.',
    '- Historical artifact availability, filesystem versions, turn checks, temp paths, worktree locks, and UI profiles ' +
      'can be indeterminate. Replay uses recorded facts and carries possible blocker state across those Stops.',
    '- Exact delivery fingerprints can be reconstructed for empty owned scope and immutable proof metadata. ' +
      'Screenshot coverage for nonempty scope remains behind an earlier unresolved check.',
    ...(reasons.size ? ['', 'Indeterminate checkpoints by first unresolved fact', '',
      ...[...reasons].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => `- ${count} · ${reason}`)] : []),
    ''
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({ options: {
    all: { type: 'boolean' }, home: { type: 'string' }, ledger: { type: 'string' }, transcript: { type: 'string' },
    'as-of': { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) { process.stdout.write(usage + '\n'); return; }
  const date = values['as-of'];
  const cutoff = date === undefined ? Infinity : Date.parse(date);
  if (date !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(date) || !Number.isFinite(cutoff))) {
    throw new Error('--as-of requires an ISO UTC timestamp ending in Z');
  }
  if (values.all ? values.ledger || values.transcript : !values.ledger || !values.transcript || values.home) {
    throw new Error(usage);
  }
  const session = values.ledger && path.basename(values.ledger, '.jsonl');
  const pairs = values.all ? await discover(values.home ?? path.join(os.homedir(), '.claude')) :
    [{ ...values, session: session === path.basename(values.transcript, '.jsonl') ? session : undefined }];
  // Capture every input prefix before processing the first session.
  const inputs = await Promise.all(pairs.map(async (pair) => {
    const [ledger, transcript, runs] = await Promise.all([snapshot(pair.ledger), snapshot(pair.transcript), snapshot(pair.runs)]);
    if (!ledger) throw new Error(`ledger missing: ${pair.ledger}`);
    return { ...pair, ledger, transcript, runs };
  }));
  const rows = [];
  for (const pair of inputs) {
    const ledger = await records(pair.ledger, cutoff);
    const history = await transcriptHistory(pair.transcript, pair.session, cutoff);
    if (values.all && cutoff !== Infinity && !ledger.length && !history.hadRows) continue;
    history.session ??= path.basename(pair.ledger.file, '.jsonl');
    const runs = (await records(pair.runs, cutoff)).filter((run) => !run.session || run.session === history.session);
    const row = replayHistory(ledger, history, runs);
    const notes = [!pair.transcript && 'transcript missing', pair.duplicate && 'multiple transcripts; first project path used',
      row.ambiguous && `${row.ambiguous} ambiguous rollover(s)`];
    row.notes = notes.filter(Boolean).join(', ');
    rows.push(row);
  }
  process.stdout.write(markdown(rows, cutoff));
}

main().catch((error) => {
  process.stderr.write(`replay-acceptance: ${error.message}\n`);
  process.exitCode = 1;
});
