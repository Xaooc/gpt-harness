import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readProcess } from '../../lib/luna-runtime.mjs';
import { CLAUSE_RULES, extractClauses } from '../lib/ledger.mjs';
import { foldLedger } from '../lib/request-state.mjs';
import { uiFile } from '../lib/profile.mjs';
import { collectTaskScope } from '../lib/task-scope.mjs';
import { main as ledgerMain } from '../ledger.mjs';
import { invoke, invokeHook, shellList, shellLog, shellQuote } from './process-fixture.mjs';

const cli = fileURLToPath(new URL('../ledger.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../../../hooks/conveyor-prompt-capture.mjs', import.meta.url));
const stop = fileURLToPath(new URL('../../../hooks/conveyor-stop-gate.mjs', import.meta.url));
const timeout = 600_000;

async function fixture(t, text = 'Please add a safe ledger. Ensure cleanup.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-ledger-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), transcript = path.join(root, 'transcript.jsonl');
  const home = path.join(root, 'conveyor'), bin = path.join(root, 'bin');
  const luna = path.join(root, 'luna-run');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(transcript, '');
  const env = {
    ...process.env, HOME: root, CLAUDE_HOME_DIR: path.join(root, 'claude'), CONVEYOR_HOME: home,
    LUNA_RUN_DIR: luna, LUNA_DAEMON_HOME: luna,
    CLAUDE_CODE_SESSION_ID: 'ledger-test', CLAUDE_CODE_TRANSCRIPT_PATH: transcript, CONVEYOR_GATE_MODE: 'block',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DIFF_FILE: path.join(root, 'diff.txt'),
    FAKE_PROMPT_COPY: path.join(root, 'prompt-copy.txt'), FAKE_ARGS: path.join(root, 'args.json'),
    FAKE_REVIEW_CALLS: path.join(root, 'review-calls'), FAKE_RESPONSE: '{"missing":[],"misread":[]}', FAKE_RC: '0'
  };
  delete env.CONVEYOR_OVERVIEW_CMD;
  const fake = path.join(root, 'crosscheck.sh');
  fs.writeFileSync(fake, `#!/bin/bash
${shellLog}
printf 'review\n' >> "$FAKE_REVIEW_CALLS"
json_args "$@" > "$FAKE_ARGS"
if [ -n "$FAKE_RELEASE" ]; then
  touch "$FAKE_RELEASE.started"
  while [ ! -f "$FAKE_RELEASE" ]; do sleep 0.02; done
fi
while [ "$#" -gt 0 ]; do
  case "$1" in -f) cp -- "$2" "$FAKE_PROMPT_COPY";; -o) out=$2;; esac
  shift
done
if [ "$FAKE_RC" != 0 ]; then printf 'Gemini unavailable' >&2; exit "$FAKE_RC"; fi
printf '%s' "$FAKE_RESPONSE" > "$out"
`, { mode: 0o755 });
  env.CONVEYOR_CROSSCHECK_CMD = JSON.stringify([fake]);
  const check = path.join(root, 'check.sh');
  fs.writeFileSync(check, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
  env.CONVEYOR_CHECK_CMD = JSON.stringify([check]);
  fs.writeFileSync(env.FAKE_DIFF_FILE, '');
  // Retain the streaming Node producer only for the large-output cancellation scenario.
  const largeGit = path.join(root, 'large-git.cjs');
  fs.writeFileSync(largeGit, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    'fs.writeFileSync(process.env.FAKE_LARGE_PID, String(process.pid));',
    "const chunk = '+large diff line '.padEnd(200, 'x') + '\\n';",
    'let sent = 0;',
    'function pump() {',
    '  while (sent < 500000) {',
    "    sent += 1000; if (!process.stdout.write(chunk.repeat(1000))) { process.stdout.once('drain', pump); return; }",
    '  }',
    "  fs.writeFileSync(process.env.FAKE_LARGE_PID + '.finished', 'all output buffered');",
    '}',
    'pump();'
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
if [ "$1" = --no-optional-locks ]; then shift; fi
repo=$2
shift 2
[ "$repo" = ${shellQuote(repo)} ] || exit 128
case "$1" in
  rev-parse)
    case "$2" in --show-toplevel) printf '%s' "$repo";; HEAD) printf 'task-base';; esac ;;
  ls-tree)
    if [ -n "$FAKE_TREE_READY" ]; then touch "$FAKE_TREE_READY.started"; fi
    if [[ " $* " == *worker.mjs* ]]; then
      printf '100644 blob 1234567890123456789012345678901234567890\\tworker.mjs\\0'
    fi ;;
  ls-files)
    if [ "$2" != --stage ]; then
      eval "set -- $FAKE_UNTRACKED_ARGS"
      if [ "$#" -gt 0 ]; then printf '%s\\0' "$@"; fi
    fi ;;
  diff)
    if [[ " $* " == *' --stat '* ]]; then printf ' worker.mjs | %s bytes\\n' "$(wc -c < "$FAKE_DIFF_FILE")"
    elif [[ " $* " == *' --name-only '* ]]; then :
    elif [ -n "$FAKE_LARGE_PID" ]; then exec "$FAKE_NODE" "$FAKE_LARGE_GIT" -C "$repo" "$@"
    else cat "$FAKE_DIFF_FILE"; fi ;;
esac
`, { mode: 0o755 });
  env.FAKE_NODE = process.execPath;
  env.FAKE_LARGE_GIT = largeGit;
  let sequence = 0;
  const append = (entry) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: 'ledger-test', ...entry }) + '\n');
  const user = (value, fields = {}) => append({ type: 'user', uuid: `u${++sequence}`, origin: { kind: 'human' },
    message: { content: value }, ...fields });
  user(text);
  async function run(program, args = [], extra = {}, input) {
    const callEnv = { ...env, ...extra };
    callEnv.FAKE_UNTRACKED_ARGS = shellList(JSON.parse(callEnv.FAKE_UNTRACKED || '[]'));
    const options = { cwd: repo, env: callEnv, input };
    const result = program === cli ? await invoke(ledgerMain, args, options) : await invokeHook(program, options);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  async function command(args, extra = {}, rc = 0) {
    const result = await run(cli, args, extra);
    assert.equal(result.status, rc, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  }
  async function prompt(value, fields = {}) {
    const result = await run(capture, [], {}, JSON.stringify({ session_id: 'ledger-test', transcript_path: transcript,
      cwd: repo, prompt: value, source: 'user', ...fields }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  }
  assert.equal(await prompt(text), '');
  const toolResult = (name, input, result = {}) => {
    const { cwd = repo, timestamp = new Date().toISOString(), toolUseResult, ...block } = result;
    const id = `tool-${++sequence}`;
    append({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name, id, input }] } });
    append({ type: 'user', timestamp, toolUseResult, message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'Success', ...block }]
    } });
  };
  return { root, repo, home, transcript, env, append, user, command, prompt, run, toolResult,
    state: async () => JSON.parse(await command(['show', '--json'])),
    records: () => fs.readFileSync(path.join(home, 'ledgers/ledger-test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('clause extraction pins the Russian/English rule table, questions, and excluded blocks', { timeout }, () => {
  assert.deepEqual(CLAUSE_RULES, {
    firstWords: 2,
    russianEndings: ['й', 'йте', 'и', 'ите'],
    russianVerbs: ['сделай', 'добавь', 'проверь', 'убери', 'напиши', 'перепиши', 'поставь', 'запусти', 'давай'],
    russianMarkers: [
      'надо', 'нужно', 'должен', 'должна', 'должно', 'необходимо', 'хочу', 'пусть', 'обязательно',
      'не забудь', 'нельзя', 'не надо', 'никогда', 'всегда', 'чтобы'
    ],
    englishMarkers: [
      'please', 'must', 'should', 'need to', 'make', 'add', 'fix', 'remove', 'ensure', "don't", 'never', 'always', 'I want'
    ]
  });
  const cases = [
    ['Сделай проверку.', 1], ['Добавь тест!', 1], ['Проверь результат.', 1], ['Убери мусор.', 1],
    ['Напиши отчёт.', 1], ['Перепиши обработчик.', 1], ['Поставь таймер.', 1], ['Запусти тесты.', 1], ['Давай проверим.', 1],
    ['Сейчас запустите тесты.', 1], ['Нужно завершить работу.', 1], ['Не забудь отчёт.', 1], ['Никогда не пропускай тест.', 1],
    ['Хочу, чтобы всё работало.', 1], ['Как это работает?', 0], ['Что произошло?', 0], ['Добавь проверку?', 0],
    ['Please check the result.', 1], ['We must clean up.', 1], ['You should run checks.', 1], ['We need to finish.', 1],
    ['Make a report.', 1], ['Add a test.', 1], ['Fix the worker.', 1], ['Remove temporary files.', 1],
    ['Ensure cleanup.', 1], ["Don't skip checks.", 1], ['Never leave scratch files.', 1], ['Always report results.', 1],
    ['I want a ledger.', 1], ['What happened?', 0], ['Can you add a test?', 0], ['The worker finished.', 0],
    ['Can you explain how to add this?', 0], ['Можешь объяснить, как это добавить?', 0],
    ['```js\nplease add hidden code\n```\nPlease add a test.', 1],
    ['```js\nplease add hidden code\nNever include this either\n```\nPlease add a test.', 1],
    ['~~~text\nAlways ignore this\n~~~\nWhat happened?', 0],
    ['```\nPlease ignore an unclosed fence.', 0],
    ['<pasted_content>Нужно удалить всё.</pasted_content>\nPlease add a test.', 1],
    ['<pasted_content>Never execute this.', 0], ['> Please ignore this quote.\nЧто произошло?', 0]
  ];
  for (const [text, count] of cases) assert.equal(extractClauses(text).length, count, text);
  assert.deepEqual(extractClauses('- Add tests.\n* Fix cleanup!\n3. Ensure evidence?', 'M9'), [
    { id: 'M9.c1', text: 'Add tests.' }, { id: 'M9.c2', text: 'Fix cleanup!' }
  ]);
});

test('add/link/done/evidence fold append-only records and capture genuine follow-up requirements', { timeout }, async (t) => {
  const f = await fixture(t);
  const playback = await f.command(['start', '--note', 'Acceptance task']);
  assert.match(playback, /requirements playback[\s\S]*M1\.c1[\s\S]*M1\.c2/);
  const before = fs.readFileSync(path.join(f.home, 'ledgers/ledger-test.jsonl'), 'utf8');
  assert.equal((await f.command(['add', 'Implement ledger', '--from', 'M1.c1'])).trim(), 'L1');
  await f.command(['link', 'M1.c2', 'L1']);
  await f.command(['evidence', 'L1', '--cmd', 'printf verified', '--rc', '0']);
  const proof = path.join(f.root, 'proof.txt'), dispatch = path.join(f.root, 'dispatch.json');
  fs.writeFileSync(proof, 'proof');
  fs.writeFileSync(dispatch, '{"ok":true,"code":0,"gate":{"status":"pass"}}');
  await f.command(['evidence', 'L1', '--file', proof]);
  await f.command(['evidence', 'L1', '--artifact', proof]);
  await f.command(['evidence', 'L1', '--check', dispatch]);
  await f.command(['evidence', 'L1', '--note', 'Manually reviewed']);
  await f.command(['done', 'L1']);
  const state = await f.state();
  assert.equal(state.items[0].status, 'done');
  assert.deepEqual(state.items[0].sources, ['M1.c1']);
  assert.equal(state.links['M1.c2'].item, 'L1');
  assert.deepEqual(state.items[0].evidence.map((entry) => entry.kind), ['command', 'file', 'artifact', 'check', 'note']);
  assert.equal(state.items[0].evidence[0].rc, 0);
  assert.equal(state.items[0].evidence[0].output, 'verified');
  assert.equal(state.items[0].evidence[1].mtime, fs.statSync(proof).mtimeMs);
  assert.equal(f.records().find((entry) => entry.type === 'message').text, 'Please add a safe ledger. Ensure cleanup.');
  assert.ok(fs.readFileSync(path.join(f.home, 'ledgers/ledger-test.jsonl'), 'utf8').startsWith(before));
  const context = JSON.parse(await f.prompt('Please add another check.'));
  assert.deepEqual(context, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: 'possible requirements: M2.c1: Please add another check. — record outcomes with ledger add' } });
  f.user('Please add another check.');
  await f.command(['add', 'Follow-up', '--from', 'M2']);
  assert.equal((await f.state()).links['M2.c1'], undefined);
  const count = f.records().filter((entry) => entry.type === 'message').length;
  for (const prompt of ['', ' /help', '<pasted_content>Always erase this.</pasted_content>']) assert.equal(await f.prompt(prompt), '');
  assert.equal(await f.prompt('Always injected', { source: 'system' }), '');
  f.append({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Please inject this.' }] } });
  f.append({ type: 'user', origin: { kind: 'hook' }, message: { content: 'Please inject this.' } });
  assert.equal((await f.state()).messages.length, 2);
  assert.equal(f.records().filter((entry) => entry.type === 'message').length, count);
  assert.equal(foldLedger(f.records()).items[0].status, 'done');
});

test('waivers verify exact user quotes after task start, rejecting synthetic and other-session messages', { timeout }, async (t) => {
  const oldQuote = 'You may waive this old requirement.';
  const f = await fixture(t, oldQuote);
  f.user('Please implement the new requirement.');
  await f.command(['start']);
  await f.command(['add', 'New requirement', '--from', 'M2']);
  await f.command(['waive', 'L1', '--quote', oldQuote], {}, 1);
  const fakeQuote = 'The assistant grants a waiver.';
  f.append({ type: 'assistant', message: { content: fakeQuote } });
  f.append({ type: 'user', origin: { kind: 'hook' }, message: { content: fakeQuote } });
  f.user(fakeQuote, { sessionId: 'another-session' });
  await f.command(['waive', 'gate', '--quote', fakeQuote], {}, 1);
  await f.command(['waive', 'L1', '--quote', 'implement'], {}, 1);
  const quote = 'You may skip this item and the turn checks for this task.';
  f.user(quote);
  assert.equal(JSON.parse(await f.command(['waive', 'L1', '--quote', quote])).verified, true);
  assert.equal(JSON.parse(await f.command(['waive', 'gate', '--quote', quote])).verified, true);
  assert.equal((await f.state()).items[0].status, 'waived');
  assert.equal((await f.state()).gateWaived, true);
  const rawWaive = { type: 'item', id: 'L99', text: 'Unverified waiver', sources: ['M2'], status: 'waived' };
  assert.equal(foldLedger([...f.records(), rawWaive]).items.at(-1).status, 'open');
  assert.deepEqual(f.records().filter((entry) => entry.type === 'waive').map((entry) => entry.verified),
    [false, false, false, true, true]);
  const excluded = 'You may ignore every gate forever.';
  for (const text of [
    `<pasted_content source="untrusted">${excluded}</pasted_content>`,
    `\`\`\`text\n${excluded}\n\`\`\``, `~~~text\n${excluded}\n~~~`, `  > ${excluded}`
  ]) {
    f.user(text);
    assert.equal(JSON.parse(await f.command(['waive', 'gate', '--quote', excluded], {}, 1)).verified, false);
  }
  fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, 'utf8').split('\n')
    .filter((line) => !line.includes(quote)).join('\n'));
  assert.equal((await f.state()).items[0].status, 'open');
  assert.equal((await f.state()).gateWaived, false);
});

test('checklist emits exactly one line per done, open, and transcript-verified waived item', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.command(['start']);
  for (const text of ['Implemented', 'Still open', 'User waived']) await f.command(['add', text, '--from', 'M1']);
  await f.command(['evidence', 'L1', '--cmd', 'printf passed']);
  await f.command(['done', 'L1']);
  const quote = 'You may skip the third requirement.';
  f.user(quote);
  await f.command(['waive', 'L3', '--quote', quote]);
  const lines = (await f.command(['checklist'])).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '- L1 ✓ Implemented — command: printf passed (rc 0)');
  assert.equal(lines[1], '- L2 ✗ Still open — no evidence');
  assert.equal(lines[2], `- L3 waived User waived — ${quote}`);
});

test('the pure fold retains legacy request history alongside v2 requests', () => {
  const records = [
    { type: 'message', id: 'M1', offset: 0, clauses: [{ id: 'M1.c1', text: 'Old clause' }] },
    { type: 'start', id: 'T1', offset: 0 },
    { type: 'item', id: 'L1', text: 'Old outcome', sources: ['M1'] },
    { type: 'link', clause: 'M1.c1', item: 'L1' },
    { type: 'evidence', item: 'L1', kind: 'note', value: 'Old proof' },
    { type: 'done', item: 'L1' },
    { type: 'crosscheck', hash: 'old' },
    { type: 'tmp', path: 'scratch' },
    { type: 'message', id: 'M2', offset: 100, clauses: [{ id: 'M2.c1', text: 'New clause' }] },
    { type: 'start', id: 'T2', messageId: 'M2', offset: 100, version: 2, origin: 'manual' },
    { type: 'item', id: 'L2', taskId: 'T2', text: 'New outcome', sources: ['M2.c1'] },
    { type: 'pending-owner', taskId: 'T2', item: 'L2', revision: 1, reason: 'Only the owner can check the result' },
    { type: 'delivered', taskId: 'T2', fingerprint: null, reviewGap: true }
  ];
  assert.equal(foldLedger(records.slice(0, 8)).legacy, true);
  const state = foldLedger(records);
  assert.equal(state.legacy, false);
  assert.equal(state.ready, true);
  assert.equal(state.delivered, true);
  assert.equal(state.delivery.reviewGap, true);
  assert.deepEqual(state.messages.map(({ id }) => id), ['M2']);
  assert.deepEqual(state.items.map(({ id }) => id), ['L2']);
  assert.deepEqual(state.hints, []);
  assert.deepEqual(state.temps, ['scratch']);
  const [legacy] = state.archived;
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.links['M1.c1'].item, 'L1');
  assert.equal(legacy.crosscheck.hash, 'old');
  assert.equal(legacy.items[0].status, 'done');
  assert.equal(legacy.items[0].evidence[0].value, 'Old proof');
});

test('concurrent CLI adds allocate distinct outcome IDs', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.command(['start']);
  const launch = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => launch(process.execPath,
    [cli, 'add', 'Outcome ' + index, '--from', 'M1'], { cwd: f.repo, env: f.env, timeout })));
  const ids = Array.from({ length: 8 }, (_, index) => 'L' + (index + 1));
  assert.deepEqual(results.map(({ stdout }) => stdout.trim()).sort(), ids);
  assert.deepEqual((await f.state()).items.map(({ id }) => id), ids);
});

test('amend and pending resolution track outcome revisions, earlier requests, and unlinked hints', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.command(['start']);
  await f.command(['add', 'Verify desktop', '--from', 'M1']);
  await f.command(['add', 'Verify mobile', '--from', 'M1.c2']);
  await f.command(['evidence', 'L1', '--note', 'Initial observation']);
  await f.command(['done', 'L1']);
  f.user('Please verify the tablet layout as well.');
  await f.command(['amend', 'L1', '--from', 'M2', 'Verify desktop and tablet']);
  let state = await f.state();
  assert.equal(state.items[0].revision, 2);
  assert.equal(state.items[0].status, 'open');
  assert.deepEqual(state.items[0].evidence, []);
  assert.equal(state.items[0].previousEvidence[0].value, 'Initial observation');
  assert.deepEqual(state.hints.map(({ id }) => id), ['M1.c1', 'M2.c1']);
  await f.command(['evidence', 'L1', '--owner-message', 'M2'], {}, 1);
  f.user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], { origin: { kind: 'hook' } });
  await f.command(['evidence', 'L1', '--owner-message', 'M3'], {}, 1);
  f.user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]);
  await f.command(['evidence', 'L1', '--owner-message', 'M3']);
  assert.equal((await f.state()).items[0].evidence[0].revision, 2);
  await f.command(['pending', 'L1', '--reason', 'Only the owner can verify the tablet']);
  await f.command(['pending', 'L2', '--reason', 'Only the owner can verify mobile']);
  state = await f.state();
  assert.equal(state.ready, true);
  assert.equal(state.delivered, false);
  assert.equal(state.pending[0].revision, 2);
  assert.match(await f.command(['show']), /L1 \(revision 2, pending-owner\).*Only the owner can verify the tablet/);
  f.user('The desktop and tablet layouts pass. Please fix the mobile layout.');
  await f.command(['start']);
  await f.command(['pending', 'L1', '--resolve', 'M4', '--result', 'accepted']);
  assert.equal((await f.command(['pending', 'L2', '--resolve', 'M4', '--result', 'needs-work'])).trim(), 'L3');
  state = await f.state();
  assert.deepEqual(state.archived[0].items.map(({ status }) => status), ['done', 'superseded']);
  assert.equal(state.archived[0].items[0].resolution.source, 'M4');
  assert.deepEqual(state.items.map(({ id, sources, previousItem }) => ({ id, sources, previousItem })),
    [{ id: 'L3', sources: ['M4'], previousItem: 'L2' }]);
  assert.deepEqual(state.hints.map(({ id }) => id), ['M4.c1']);
  assert.equal((await f.command(['add', 'A separate follow-up', '--from', 'M4'])).trim(), 'L4');
});

test('prompt capture starts the next request after delivery and manual start reuses it', { timeout }, async (t) => {
  const f = await fixture(t);
  await f.command(['start']);
  const file = path.join(f.home, 'ledgers/ledger-test.jsonl');
  fs.appendFileSync(file, JSON.stringify({ type: 'delivered', taskId: 'T1', fingerprint: null, reviewGap: false }) + '\n');
  assert.equal(await f.prompt('Please add an injected outcome.', { source: 'system' }), '');
  assert.equal((await f.state()).task.id, 'T1');
  const text = 'Please add the next outcome.';
  const event = { prompt_id: 'second-prompt' };
  const output = JSON.parse(await f.prompt(text, event)).hookSpecificOutput.additionalContext;
  assert.match(output, /New request T2 started with M2\.\npossible requirements: M2\.c1: /);
  assert.match(output, /record outcomes with ledger add$/);
  f.user(text);
  await f.command(['start']);
  assert.equal(await f.prompt(text, event), '');
  const state = await f.state();
  assert.deepEqual(f.records().filter(({ type }) => type === 'start').map(({ id, origin, version, messageId }) =>
    ({ id, origin, version, messageId })), [
    { id: 'T1', origin: 'manual', version: 2, messageId: 'M1' },
    { id: 'T2', origin: 'auto', version: 2, messageId: 'M2' }
  ]);
  assert.equal(state.delivered, false);
  assert.deepEqual(state.primaryMessages.map(({ id, text }) => ({ id, text })), [{ id: 'M2', text }]);
  assert.deepEqual(state.archived[0].messages.map(({ id }) => id), ['M1']);
  fs.appendFileSync(file, JSON.stringify({ type: 'delivered', taskId: 'T2', fingerprint: null, reviewGap: false }) + '\n');
  f.user('A follow-up question?', { uuid: 'third-prompt' });
  assert.equal((await f.state()).allMessages.at(-1).id, 'M3');
  const third = JSON.parse(await f.prompt('A follow-up question?'));
  assert.equal(third.hookSpecificOutput.additionalContext, 'New request T3 started with M3.');
  assert.equal((await f.state()).task.messageId, 'M3');
});

test('assistant checklist, banners, and quoted transcript lines do not become clause hints', () => {
  const paste = [
    'Выполнено 3 команды — проверь вывод.',
    '- L12 ✓ Please add a foreign task.',
    '- L13 ✗ Fix the irrelevant test.',
    'Хук отправил Claude повторный запрос: добавь чужую задачу.',
    '> Always delete the old result.',
    '[assistant]\nEnsure the old result is gone.\n[/assistant]',
    '<transcript>\nPlease add unrelated work.\n</transcript>'
  ].join('\n');
  assert.deepEqual(extractClauses(paste), []);
  assert.deepEqual(extractClauses('Fix my layout.\n' + paste + '\nPlease keep my settings.'), [
    { id: 'M1.c1', text: 'Fix my layout.' },
    { id: 'M1.c2', text: 'Please keep my settings.' }
  ]);
});

async function deliveryFixture(t) {
  const original = 'Please add the ledger.\nEnsure the evidence stays fresh.';
  const f = await fixture(t, original);
  const sessions = path.join(f.home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'ledger-test.jsonl'), JSON.stringify({ session: 'ledger-test', repo: f.repo,
    base: 'task-base', mode: 'write' }) + '\n');
  const diff = Array.from({ length: 302 }, (_, index) => `+diff line ${index + 1}`).join('\n');
  fs.writeFileSync(f.env.FAKE_DIFF_FILE, diff);
  await f.command(['start']);
  fs.writeFileSync(path.join(f.repo, 'worker.mjs'), diff);
  f.toolResult('Edit', { file_path: 'worker.mjs' });
  await f.command(['add', 'Ledger and evidence', '--from', 'M1.c1,M1.c2']);
  await f.command(['evidence', 'L1', '--note', 'Reviewed']);
  await f.command(['evidence', 'L1', '--cmd', 'printf passed']);
  await f.command(['done', 'L1']);
  return { f, original };
}

test('Stop reads live owned jobs without a collector snapshot or a job lookup process', { timeout }, async (t) => {
  const { f } = await deliveryFixture(t);
  fs.writeFileSync(path.join(f.repo, 'worker.mjs'), 'export const worker = true;\n');
  f.toolResult('Write', { file_path: 'worker.mjs' });
  f.env.FAKE_UNTRACKED = '["worker.mjs"]';
  await f.command(['evidence', 'L1', '--cmd', 'printf passed']);
  await f.command(['crosscheck']);
  f.append({ type: 'assistant', message: { content: await f.command(['checklist']) } });

  const run = f.env.LUNA_RUN_DIR;
  const active = path.join(run, 'active');
  fs.mkdirSync(active, { recursive: true });
  const started = new Date().toISOString();
  const pidStart = readProcess(process.pid).started;
  function job(name, owner, state) {
    const out = path.join(run, name);
    fs.writeFileSync(`${out}.status`, `state=${state}\nowner=${owner}\nstarted=${started}\n`);
    fs.writeFileSync(path.join(active, name), `${out}\n${process.pid}\n${pidStart}\n`);
    return out;
  }
  const owned = job('owned', f.env.CLAUDE_CODE_SESSION_ID, 'running');
  job('other-session', 'another-session', 'running');
  assert.equal(fs.existsSync(path.join(run, 'collector', 'snapshot.json')), false);

  const spawned = [];
  const originalSpawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    spawned.push(options.file);
    return originalSpawn.call(this, options);
  });
  const input = JSON.stringify({ session_id: f.env.CLAUDE_CODE_SESSION_ID, transcript_path: f.transcript, cwd: f.repo });
  const progress = await f.run(stop, [], {}, input);
  assert.deepEqual(JSON.parse(progress.stdout), { systemMessage: 'conveyor: work in progress, 1 jobs running' });

  job('owned', f.env.CLAUDE_CODE_SESSION_ID, 'done');
  assert.equal((await f.run(stop, [], {}, input)).stdout, '');
  assert.equal(f.records().filter(({ type }) => type === 'turn-check').length, 1);
  assert.deepEqual(spawned.filter((file) => file !== 'git'), []);

  const identity = new URL('../../lib/process-identity.mjs', import.meta.url);
  await t.test('a live Windows wrapper in the home index allows a pause', {
    skip: !fs.existsSync(identity) && 'Windows process identity module is absent from this installation'
  }, () => {
    const homeIndex = path.join(f.env.HOME, '.claude', 'luna-run', 'active');
    fs.mkdirSync(homeIndex, { recursive: true });
    fs.rmSync(path.join(active, 'owned'));
    fs.writeFileSync(path.join(homeIndex, 'owned'), `${owned}\n${process.pid}\n${started}\n`);
    fs.writeFileSync(`${owned}.status`, `state=running\nowner=${f.env.CLAUDE_CODE_SESSION_ID}\nstarted=${started}\n`);
    const powershell = path.join(f.root, 'bin', 'powershell.exe');
    const fileTime = BigInt(Date.parse(started)) * 10_000n + 116_444_736_000_000_000n;
    fs.writeFileSync(powershell, `#!/bin/sh\nprintf '%s\\n' '${process.pid} ${fileTime}'\n`, { mode: 0o755 });
    const stdout = execFileSync(process.execPath, [stop], {
      cwd: f.repo,
      env: { ...f.env, CONVEYOR_PLATFORM: 'win32', USERPROFILE: f.env.HOME,
        FAKE_UNTRACKED_ARGS: shellList(JSON.parse(f.env.FAKE_UNTRACKED)) },
      input, encoding: 'utf8', timeout
    });
    assert.deepEqual(JSON.parse(stdout), { systemMessage: 'conveyor: work in progress, 1 jobs running' });
    fs.rmSync(path.join(homeIndex, 'owned'));
  });

  await t.test('a pointer with no recorded start does not count a PID newer than the pointer', async () => {
    const pointer = path.join(active, 'owned');
    job('owned', f.env.CLAUDE_CODE_SESSION_ID, 'running');
    fs.writeFileSync(pointer, `${owned}\n${process.pid}\n`);
    const old = new Date(Date.now() - process.uptime() * 1000 - 10_000);
    fs.utimesSync(pointer, old, old);
    const result = await f.run(stop, [], {}, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  await t.test('a known running job survives an unreadable index', async () => {
    const pointer = path.join(active, 'owned');
    fs.writeFileSync(pointer, `${owned}\n`);
    const status = `${owned}.status`;
    fs.appendFileSync(status, `wrapper_pid=${process.pid}\nwrapper_start=${pidStart}\n`);
    const old = new Date(Date.now() - 660_000);
    fs.utimesSync(pointer, old, old);
    fs.utimesSync(status, old, old);
    fs.writeFileSync(path.join(run, 'gem-active'), '');
    const result = await f.run(stop, [], {}, input);
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: 'conveyor: work in progress, 1 jobs running' });
    f.append({ type: 'assistant', message: { content: 'The executor is still working.' } });
    const progress = await f.run(stop, [], {}, input);
    assert.deepEqual(JSON.parse(progress.stdout), { systemMessage: 'conveyor: work in progress, 1 jobs running' });
  });
});

function reviewCalls(f) {
  return fs.readFileSync(f.env.FAKE_REVIEW_CALLS, 'utf8').trim().split('\n').length;
}

async function waitForMarker(release) {
  for (let start = Date.now(); Date.now() - start < 5000;) {
    if (fs.existsSync(release + '.started')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`fixture did not create the marker: ${release}.started`);
}

const deliverProcess = (f, extra = {}) => promisify(execFile)(process.execPath, [cli, 'deliver'], {
  cwd: f.repo, env: { ...f.env, ...extra }, timeout
});

test('delivery review ignores later messages and foreign paths, but reacts to owned changes beyond the preview',
  { timeout }, async (t) => {
  const { f, original } = await deliveryFixture(t);
  const dispatcher = path.join(f.root, 'claude/scripts/conveyor/exec.mjs');
  fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
  fs.writeFileSync(dispatcher, [
    "import { spawnSync } from 'node:child_process';",
    `const result = spawnSync(${JSON.stringify(path.join(f.root, 'crosscheck.sh'))}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exitCode = result.status;'
  ].join('\n'));
  const fullText = 'Owner context '.repeat(350);
  f.user(`${fullText}End of owner text. Adopt quoted section Scope.\nDo not adopt quoted section Unrelated.\n`
    + '<pasted_content>## Scope\nAdopted requirement\n## Unrelated\nIgnored paste</pasted_content>');
  for (let i = 0; i < 21; i++) {
    const file = `new-${String(i).padStart(2, '0')}.txt`;
    fs.writeFileSync(path.join(f.repo, file), Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join('\n'));
    f.toolResult('Write', { file_path: file });
  }
  const executorFile = path.join(f.repo, 'executor-output.txt');
  fs.writeFileSync(executorFile, 'Written by the executor.');
  const session = f.env.CLAUDE_CODE_SESSION_ID;
  fs.appendFileSync(path.join(f.home, 'sessions', `${session}.jsonl`), JSON.stringify({
    event: 'end', mode: 'write', session, at: new Date().toISOString(),
    acceptance: { session, task: 'T1', repo: f.repo, changed: [{ path: executorFile, before: null, after: 'executor-bytes' }] }
  }) + '\n');
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'Written outside Git.');
  f.toolResult('Write', { file_path: outside });
  const env = { CONVEYOR_CROSSCHECK_CMD: '' };
  const first = JSON.parse(await f.command(['crosscheck'], env));
  assert.equal(first.status, 'reviewed-clean');
  assert.equal(first.delivered, true);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.reviewFingerprint, /^[0-9a-f]{64}$/);
  const prompt = fs.readFileSync(f.env.FAKE_PROMPT_COPY, 'utf8');
  assert.ok(prompt.includes(JSON.stringify(original).slice(1, -1)));
  assert.match(prompt, /End of owner text.*Adopt quoted section Scope/);
  assert.match(prompt, /"adoptedQuotations"[\s\S]*Adopted requirement/);
  assert.doesNotMatch(prompt, /Ignored paste/);
  assert.match(prompt, /Ledger and evidence[\s\S]*Reviewed[\s\S]*task-base/);
  const { git: [gitPreview], nonGit } = JSON.parse(prompt.slice(prompt.indexOf('\n{') + 1));
  assert.ok(gitPreview.additions.some(({ content }) => content === 'Written by the executor.'));
  assert.deepEqual(nonGit.map(({ file, content }) => [file, content]), [[outside, 'Written outside Git.']]);
  assert.match(gitPreview.diff, /\+diff line 300/);
  assert.doesNotMatch(gitPreview.diff, /\+diff line 301/);
  assert.equal(gitPreview.additions.length, 20);
  assert.equal(gitPreview.additions.some(({ file }) => file === 'new-20.txt'), false);
  assert.match(gitPreview.additions.find(({ file }) => file === 'new-00.txt').content, /line 200$/);
  const args = JSON.parse(fs.readFileSync(f.env.FAKE_ARGS, 'utf8'));
  assert.deepEqual(args.slice(0, 7), ['run', '--tier', 'scout', '-r', '-C', f.repo, '-f']);
  assert.equal(fs.existsSync(path.dirname(args[7])), false);
  f.user('Please preserve all requirements verbatim.');
  fs.writeFileSync(path.join(f.repo, 'foreign.txt'), 'other session content');
  f.append({ sessionId: 'foreign-session', type: 'assistant', cwd: f.repo,
    message: { content: [{ type: 'tool_use', id: 'foreign', name: 'Write', input: { file_path: 'foreign.txt' } }] } });
  await f.command(['evidence', 'L1', '--cmd', 'printf passed']);
  assert.equal(JSON.parse(await f.command(['deliver'])).fingerprint, first.fingerprint);
  assert.equal(reviewCalls(f), 1);
  fs.appendFileSync(path.join(f.repo, 'new-20.txt'), '\nChanged beyond the preview');
  f.toolResult('Edit', { file_path: 'new-20.txt' });
  const changed = JSON.parse(await f.command(['deliver']));
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(reviewCalls(f), 2);
  const pidFile = path.join(f.root, 'large-diff.pid');
  fs.chmodSync(path.join(f.repo, 'worker.mjs'), 0o755);
  const modeChange = JSON.parse(await f.command(['deliver'], { FAKE_LARGE_PID: pidFile }));
  assert.notEqual(modeChange.fingerprint, changed.fingerprint);
  assert.equal(modeChange.delivered, true);
  const large = fs.readFileSync(f.env.FAKE_PROMPT_COPY, 'utf8');
  assert.equal((large.match(/\+large diff line/g) || []).length, 300);
  assert.ok(Buffer.byteLength(large) < 256 * 1024);
  assert.equal(fs.existsSync(pidFile + '.finished'), false);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});

test('two simultaneous deliveries dispatch one independent review and record one delivery', { timeout }, async (t) => {
  const { f } = await deliveryFixture(t);
  const release = path.join(f.root, 'release'), ready = path.join(f.root, 'second-inputs');
  const calls = [deliverProcess(f, { FAKE_RELEASE: release })];
  try {
    await waitForMarker(release);
    calls.push(deliverProcess(f, { FAKE_RELEASE: release, FAKE_TREE_READY: ready }));
    await waitForMarker(ready);
    fs.writeFileSync(release, '');
    const results = await Promise.all(calls);
    assert.deepEqual(results.map(({ stdout }) => JSON.parse(stdout).status), ['reviewed-clean', 'reviewed-clean']);
    assert.equal(reviewCalls(f), 1);
    for (const kind of ['turn-check', 'screenshot-check', 'delivered']) {
      assert.equal(f.records().filter(({ type }) => type === kind).length, 1);
    }
  } finally { fs.closeSync(fs.openSync(release, 'a')); await Promise.allSettled(calls); }
});

test('finding links and dismissals reuse the review, while adding an outcome reviews again with prior answers',
  { timeout }, async (t) => {
  const { f } = await deliveryFixture(t);
  const FAKE_RESPONSE = JSON.stringify({ missing: [{ text: 'cleanup', source: 'M1.c1' }, 'docs'],
    misread: [{ text: 'scope', source: 'M1.c2' }] });
  const found = JSON.parse(await f.command(['deliver'], { FAKE_RESPONSE }, 1));
  assert.equal(found.status, 'reviewed-with-findings');
  assert.deepEqual(found.findings.map(({ id }) => id), ['X1', 'X2', 'X3']);
  await f.command(['link', 'X1', 'L1']);
  await f.command(['link', 'X3', 'none', '--reason', 'Already included in the explicit scope']);
  assert.deepEqual(JSON.parse(await f.command(['deliver'], {}, 1)).unanswered, ['X2']);
  assert.equal(reviewCalls(f), 1);
  await f.command(['add', 'Document the ledger', '--from', 'X2']);
  await f.command(['deliver'], {}, 1);
  assert.equal(reviewCalls(f), 1);
  await f.command(['evidence', 'L2', '--cmd', 'printf verified']);
  await f.command(['done', 'L2']);
  const second = JSON.parse(await f.command(['deliver'], { FAKE_RESPONSE }));
  assert.deepEqual(second.findings.map(({ id }) => id), ['X1', 'X2', 'X3']);
  assert.deepEqual(second.unanswered, []);
  assert.equal(reviewCalls(f), 2);
  assert.match(fs.readFileSync(f.env.FAKE_PROMPT_COPY, 'utf8'), /priorFindings[\s\S]*Already included in the explicit scope/);
  await f.command(['link', 'X1', 'L2'], {}, 1);
  assert.equal(JSON.parse(await f.command(['deliver'])).delivered, true);
  assert.equal(reviewCalls(f), 2);
});

test('unavailable reviews deliver with a review gap and allow automatic request rollover', { timeout }, async (t) => {
  const { f } = await deliveryFixture(t);
  const failed = JSON.parse(await f.command(['deliver'], { FAKE_RESPONSE: 'not json' }, 1));
  assert.equal(failed.status, 'error');
  assert.equal(failed.delivered, false);
  const quote = 'You may waive the unavailable delivery review for this request.';
  f.user(quote);
  const output = await f.command(['deliver'], { FAKE_RC: '3' });
  assert.match(output, /"status": "unavailable"/);
  assert.match(output, /Delivery review gap:/);
  await f.command(['waive', 'crosscheck', '--quote', quote]);
  assert.equal(f.records().findLast(({ type }) => type === 'delivered').reviewGap, true);
  assert.equal(reviewCalls(f), 2);
  assert.match(await f.prompt('Please follow up on delivery.'), /T2/);
  assert.equal((await f.state()).task.id, 'T2');
});

test('an in-flight review of stale work stays history and cannot close the updated delivery', { timeout }, async (t) => {
  const { f } = await deliveryFixture(t);
  const release = path.join(f.root, 'release');
  const first = deliverProcess(f, { FAKE_RELEASE: release, FAKE_RESPONSE: '{"missing":["outdated finding"],"misread":[]}' })
    .then(() => assert.fail('stale delivery should exit nonzero'), (error) => error);
  try {
    await waitForMarker(release);
    fs.appendFileSync(path.join(f.repo, 'worker.mjs'), '\nUpdated while the review runs');
    f.toolResult('Edit', { file_path: 'worker.mjs' });
    const second = JSON.parse(await f.command(['deliver']));
    fs.writeFileSync(release, '');
    const result = JSON.parse((await first).stdout);
    assert.equal(result.stale, true);
    assert.equal(result.delivered, false);
    assert.notEqual(result.fingerprint, second.fingerprint);
    const state = await f.state();
    assert.equal(state.reviews.length, 2);
    assert.deepEqual(state.deliveries.map(({ fingerprint }) => fingerprint), [second.fingerprint]);
    assert.equal(JSON.parse(await f.command(['deliver'])).delivered, true);
    assert.equal(reviewCalls(f), 2);
  } finally { fs.closeSync(fs.openSync(release, 'a')); await first; }
});

test('UI file detection covers UI extensions and detected directories while excluding tests and stories',
  { timeout: 3000 }, () => {
    for (const file of ['page.tsx', 'widget.jsx', 'src/view.vue', 'view.svelte', 'site.css', 'site.scss', 'index.html',
      'frontend/api.ts', 'templates/page.jinja']) assert.equal(uiFile(file, ['frontend', 'templates']), true, file);
    for (const file of ['worker.mjs', 'README.md', 'tests/page.tsx', 'src/__tests__/view.jsx', 'src/page.test.tsx',
      'src/page.spec.tsx', 'src/page.stories.tsx', 'stories/page.jsx', 'frontend/tests/api.ts', 'templates/test_page.html']) {
      assert.equal(uiFile(file, ['frontend', 'templates']), false, file);
    }
  });

async function taskScope(f, task, extra = {}) {
  let scope;
  const result = await invoke(async () => {
    scope = await collectTaskScope({ session: 'ledger-test', transcript: f.transcript, cwd: f.repo }, task);
    return 0;
  }, [], { env: { ...f.env, ...extra }, cwd: f.repo });
  assert.equal(result.status, 0, result.stderr);
  return scope;
}

test('task scope uses successful editor results and excludes denied, unmatched and identical edits', { timeout }, async (t) => {
  const f = await fixture(t);
  f.toolResult('Edit', { file_path: 'earlier.mjs' });
  f.user('Please fix the current request.');
  await f.command(['start']);
  const { task } = await f.state();
  const timestamp = '2026-08-01T00:00:00.000Z';
  f.toolResult('Edit', { file_path: 'input.mjs' }, { timestamp,
    toolUseResult: { filePath: 'actual.mjs', structuredPatch: [{ lines: ['-old', '+new'] }] } });
  f.toolResult('Edit', { file_path: 'denied.mjs' }, { is_error: true, content: 'The user rejected this tool use.' });
  f.toolResult('Write', { file_path: 'unchanged.mjs', content: 'same' },
    { toolUseResult: { originalFile: 'same', structuredPatch: [] } });
  f.append({ type: 'assistant', cwd: f.repo, message: {
    content: [{ type: 'tool_use', id: 'unmatched', name: 'Edit', input: { file_path: 'unmatched.mjs' } }]
  } });
  const executorPath = path.join(f.repo, 'executor.mjs');
  const row = { event: 'end', mode: 'write', session: 'ledger-test', at: timestamp, code: 17,
    acceptance: { session: 'ledger-test', repo: f.repo, task: task.id, runId: 'run',
      changed: [{ path: executorPath, before: null, after: 'hash' }] } };
  const earlier = { ...row, acceptance: { ...row.acceptance, task: 'T0',
    changed: [{ path: path.join(f.repo, 'earlier-run.mjs'), before: null, after: 'hash' }] } };
  fs.appendFileSync(path.join(f.home, 'sessions', 'ledger-test.jsonl'), JSON.stringify(row) + '\n' + JSON.stringify(earlier) + '\n');
  const scope = await taskScope(f, task);
  assert.deepEqual([...scope.repos], [[f.repo, new Map([
    [path.join(f.repo, 'actual.mjs'), Date.parse(timestamp)], [executorPath, Date.parse(timestamp)]
  ])]]);
  assert.equal(scope.nonGit.size, 0);
});

async function freshnessFixture(t, external = false) {
  const f = await fixture(t, 'Please fix the worker.');
  const proof = path.join(external ? f.root : f.repo, 'proof.log');
  const older = new Date(Date.now() - 10_000);
  fs.writeFileSync(proof, 'verification\n');
  fs.utimesSync(proof, older, older);
  f.env.CONVEYOR_CHECK_CMD = JSON.stringify(['/bin/sh', '-c', "printf '%s' '{\"ok\":true}'"]);
  await f.command(['start']);
  await f.command(['add', 'Fix the worker', '--from', 'M1.c1']);
  f.toolResult('Edit', { file_path: 'owned.mjs' }, { timestamp: new Date(older.getTime() - 1000).toISOString() });
  await f.command(['evidence', 'L1', '--artifact', proof]);
  await f.command(['done', 'L1']);
  const check = async () => JSON.parse(await f.command(['status', '--json'], {}, 1)).check;
  return { f, check, proof };
}

test('only a later owned edit in the artifact worktree makes proof stale', { timeout }, async (t) => {
  const { f, check, proof } = await freshnessFixture(t);
  fs.writeFileSync(path.join(f.repo, 'foreign.mjs'), 'foreign bytes\n');
  assert.ok(fs.statSync(path.join(f.repo, 'foreign.mjs')).mtimeMs > fs.statSync(proof).mtimeMs);
  f.env.FAKE_UNTRACKED = '["foreign.mjs"]';
  assert.equal(await check(), 6);
  f.toolResult('Edit', { file_path: 'owned.mjs' });
  assert.equal(await check(), 4);
  await f.command(['evidence', 'L1', '--cmd', 'test "$LEDGER_PROOF" = yes'], { LEDGER_PROOF: 'yes' });
  await f.command(['evidence', 'L1', '--cmd', 'exit 1'], {}, 1);
  assert.equal(await check(), 6);
  await f.command(['evidence', 'L1', '--cmd', 'test "$LEDGER_PROOF" = yes'], { LEDGER_PROOF: 'no' }, 1);
  assert.equal(await check(), 4);
});

test('only commits confirmed by paired Bash results enter this request scope', { timeout }, async (t) => {
  const realPath = process.env.PATH;
  const f = await fixture(t);
  await f.command(['start']);
  const { task } = await f.state();
  const git = (...args) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Ledger Test');
  git('config', 'user.email', 'ledger@example.test');
  fs.writeFileSync(path.join(f.repo, 'own.mjs'), 'own\n');
  git('add', 'own.mjs');
  const output = git('commit', '-m', 'owned');
  f.toolResult('Bash', { command: `git -C ${shellQuote(f.repo)} commit -m owned` }, { cwd: f.root, content: output });
  fs.writeFileSync(path.join(f.repo, 'foreign.mjs'), 'foreign\n');
  git('add', 'foreign.mjs');
  const foreign = git('commit', '-m', 'foreign');
  f.toolResult('Bash', { command: 'git log -1' }, { content: foreign });
  const scope = await taskScope(f, task, { PATH: realPath });
  assert.deepEqual([...scope.repos.get(f.repo).keys()], [path.join(f.repo, 'own.mjs')]);
});

test('an external artifact compares only with owned writes, including non-Git edits', { timeout }, async (t) => {
  const { f, check } = await freshnessFixture(t, true);
  fs.writeFileSync(path.join(f.repo, 'foreign.mjs'), 'foreign bytes\n');
  fs.writeFileSync(path.join(f.root, 'foreign.mjs'), 'foreign bytes\n');
  f.env.FAKE_UNTRACKED = '["foreign.mjs"]';
  assert.equal(await check(), 6);
  f.toolResult('Edit', { file_path: 'owned-outside.mjs' }, { cwd: f.root });
  assert.equal(await check(), 4);
  await f.command(['amend', 'L1', 'Fix the worker', '--from', 'M1', '--paths', 'owned.mjs']);
  const state = await f.state();
  assert.equal(state.items[0].revision, 2);
  assert.deepEqual(state.items[0].paths, [path.join(f.repo, 'owned.mjs')]);
  await f.command(['evidence', 'L1', '--artifact', path.join(f.root, 'proof.log')]);
  await f.command(['done', 'L1']);
  assert.equal(await check(), 6);
});

function replayFixture(t, records, stops, transcript = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-replay-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'ledger.jsonl'), log = path.join(root, 'transcript.jsonl');
  const before = '2026-11-20T12:00:00.000Z', at = '2026-11-20T12:01:00.000Z';
  const hook = 'node "/example/hooks/conveyor-stop-gate.mjs"';
  const write = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  write(ledger, records.map((record) => ({ at: before, ...record })));
  const rows = transcript.slice();
  for (const [index, reason] of stops.entries()) {
    const toolUseID = `stop-${index + 1}`;
    const summary = { type: 'system', subtype: 'stop_hook_summary', toolUseID, hookInfos: [{ command: hook }] };
    const attachment = { type: 'attachment', attachment: { type: 'hook_blocking_error', hookEvent: 'Stop', toolUseID,
      blockingError: { command: hook, blockingError: reason } } };
    rows.push(summary, attachment, ...(index === 0 ? [structuredClone(attachment)] : []));
  }
  write(log, rows.map((row) => ({ sessionId: 'replay-fixture', timestamp: at, ...row })));
  const replay = fileURLToPath(new URL('../../../../../tools/replay-acceptance.mjs', import.meta.url));
  return execFileSync(process.execPath, [replay, '--ledger', ledger, '--transcript', log], { encoding: 'utf8', timeout });
}

test('acceptance replay counts a Stop summary and duplicate conveyor attachments once', { timeout }, (t) => {
  const report = replayFixture(t, [], ['1. start the ledger']);
  assert.match(report, /Recovered 1 Stop checkpoints across 1 sessions, including 1 conveyor summaries/);
  assert.match(report, /\| replay-fixture \| 1 \| 1 \| 0 \/ 0 \|/);
});

test('acceptance replay reports an old-proven artifact reopened by an attributed write', { timeout }, (t) => {
  const artifact = '/example/proof.html';
  const report = replayFixture(t, [
    { type: 'start', id: 'T1', offset: 0 },
    { type: 'item', id: 'L1', paths: [artifact], text: 'Produce proof' },
    { type: 'evidence', item: 'L1', kind: 'artifact', value: artifact, mtime: Date.parse('2026-11-20T12:00:00.000Z') },
    { type: 'done', item: 'L1' }
  ], ['6. run ledger crosscheck'], [
    { type: 'assistant', cwd: '/example', message: { content: [
      { type: 'tool_use', id: 'write-proof', name: 'Write', input: { file_path: artifact, content: 'updated' } }
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-proof', content: 'Success' }] } }
  ]);
  assert.match(report, /\| T1\/L1 \| 2026-11-20T12:01:00\.000Z \(stop-1\) \| artifact \| artifact registration predates/);
});

test('acceptance replay allows the second and third unchanged blocks', { timeout }, (t) => {
  const report = replayFixture(t, [
    { type: 'start', id: 'T1', offset: 0 },
    { type: 'item', id: 'L1', text: 'Finish the outcome' }
  ], Array(3).fill('3. finish or obtain a user waiver for open items: L1'));
  assert.match(report, /\| replay-fixture \| 3 \| 3 \| 0 \/ 0 \| 0 \/ 0 \/ 0 \| 1 \| 0 \| 2 \| 0 \/ 2 \| 0 \|/);
});
