import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../../learning/common.mjs';
import { ledgerPaths, runCommand, transcriptRows } from './ledger.mjs';

const editorTools = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const sortedEntries = (map) => [...map.keys()].sort().map((key) => [key, map.get(key)]);

async function git(cwd, ...args) {
  const result = await runCommand(['git', '-C', cwd, ...args], [], cwd);
  return result.rc === 0 ? result.stdout : null;
}

export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function worktreeFor(file, dir = path.dirname(file)) {
  while (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const root = (await git(dir, 'rev-parse', '--show-toplevel'))?.trimEnd();
  return root && inside(root, file) ? root : null;
}

function pairedTools(rows, start) {
  const pending = new Map(), pairs = [];
  for (const { entry, offset } of rows) {
    if (offset < start) continue;
    const content = entry.message?.content ?? entry.content;
    if (!Array.isArray(content)) continue;
    const results = entry.type === 'user' ? content.filter((part) => part.type === 'tool_result') : [];
    for (const block of content) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.id &&
        (editorTools.has(block.name) || block.name === 'Bash')) {
        pending.set(block.id, { tool: block, cwd: entry.cwd });
      }
      if (entry.type !== 'user' || block.type !== 'tool_result') continue;
      const call = pending.get(block.tool_use_id);
      if (!call) continue;
      pending.delete(block.tool_use_id);
      const at = Date.parse(entry.timestamp);
      const structured = block.toolUseResult ?? (results.length === 1 ? entry.toolUseResult : null);
      if (Number.isFinite(at)) pairs.push({ ...call, cwd: call.cwd ?? entry.cwd, result: block, structured, at });
    }
  }
  return pairs;
}

function resultText(result) {
  if (typeof result.content === 'string') return result.content;
  return Array.isArray(result.content) ? result.content.filter((part) => part.type === 'text').map(({ text }) => text).join('\n') : '';
}

function editorPath(tool, result) {
  const input = tool.input || {};
  const { filePath, structuredPatch, originalFile, type, content } = result || {};
  const output = typeof content === 'string' ? content : tool.name === 'Write' ? input.content : undefined;
  if (typeof originalFile === 'string' && originalFile === output) return null;
  if (Array.isArray(structuredPatch) && type !== 'create') {
    const changed = structuredPatch.some(({ lines }) => lines?.some((line) => /^[+-]/.test(line)));
    if (!changed) return null;
  }
  const edits = tool.name === 'MultiEdit' ? input.edits : tool.name === 'Edit' ? [input] : null;
  if (edits?.length && edits.every(({ old_string, new_string }) => typeof old_string === 'string' && old_string === new_string)) {
    return null;
  }
  return filePath || input.file_path || input.notebook_path;
}

// Read literal commands without executing transcript text. Dynamic paths and shell syntax are left unattributed.
function commitDirectories(command, cwd) {
  if (typeof command !== 'string') return [];
  const word = /'[^']*'|"(?:\\.|[^"\\])*"|\\[^\n]|[^\s;&|<>()'"\\]+/y;
  const parts = [];
  let args = [], token = null;
  for (let index = 0; index < command.length;) {
    const char = command[index];
    if (char === '\\' && command[index + 1] === '\n') { index += 2; continue; }
    if (/\s|[;&|()<>]/.test(char)) {
      if (token !== null) { args.push(token); token = null; }
      if (/[^ \t\r]/.test(char)) { parts.push({ args, separator: char }); args = []; }
      index++;
      continue;
    }
    if (char === '#' && token === null) {
      const next = command.indexOf('\n', index);
      index = next === -1 ? command.length : next;
      continue;
    }
    word.lastIndex = index;
    const match = word.exec(command)?.[0];
    if (!match) return [];
    token ??= '';
    if (match[0] === "'") token += match.slice(1, -1);
    else if (match[0] === '"') token += match.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else token += match.replace(/^\\/, '');
    index = word.lastIndex;
  }
  if (token !== null) args.push(token);
  parts.push({ args });
  const literal = (arg) => typeof arg === 'string' && arg !== '' && !/[$~*?[\]]/.test(arg);
  const dirs = new Set();
  for (const { args: words, separator } of parts) {
    if (['(', ')', '<'].includes(separator)) return [];
    const [program, ...argv] = words;
    if (program === 'cd') {
      const operands = argv[0] === '--' ? argv.slice(1) : argv;
      const target = operands.length === 1 ? operands[0] : null;
      cwd = literal(target) && (cwd || path.isAbsolute(target)) ? path.resolve(cwd || '', target) : null;
    }
    if (!program || path.basename(program) !== 'git') continue;
    let dir = cwd, index = 0;
    while (argv[index]?.startsWith('-')) {
      const flag = argv[index++];
      if (flag === '-C') {
        const next = argv[index++];
        if (next !== '') dir = literal(next) && (dir || path.isAbsolute(next)) ? path.resolve(dir || '', next) : null;
      } else if (flag === '-c') index++;
      else if (!['--no-pager', '--no-optional-locks', '--paginate'].includes(flag)) {
        dir = null;
        break;
      }
    }
    if (dir && argv[index] === 'commit') dirs.add(dir);
  }
  return [...dirs];
}

async function commitPaths(tool, cwd, output) {
  const headers = [...output.matchAll(/^\[[^\r\n]+? ([a-f0-9]{4,64})\](?: |$)/gmi)];
  if (!headers.length) return [];
  const dirs = commitDirectories(tool.input?.command, cwd);
  const roots = new Set();
  for (const dir of dirs) {
    const root = (await git(dir, 'rev-parse', '--show-toplevel'))?.trimEnd();
    if (root) roots.add(root);
  }
  const commits = [];
  for (const [, sha] of headers) {
    const matches = [];
    for (const root of roots) {
      const oid = (await git(root, 'rev-parse', '--verify', `${sha}^{commit}`))?.trim();
      if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) matches.push({ root, oid });
    }
    if (matches.length !== 1) continue;
    const { root, oid } = matches[0];
    const files = await git(root, 'show', '--format=', '--diff-merges=first-parent', '--root',
      '--name-only', '--no-renames', '-z', oid, '--');
    for (const file of files?.split('\0') || []) if (file) commits.push([root, path.resolve(root, file)]);
  }
  return commits;
}

// Keys inside each group are absolute paths. Their values are the latest attributed write times in milliseconds.
export async function collectTaskScope(context, task, rows = transcriptRows(context)) {
  const repos = new Map(), nonGit = new Map(), roots = new Map();
  const record = (root, file, at) => {
    if (root && !inside(root, file)) return;
    if (root && !repos.has(root)) repos.set(root, new Map());
    const paths = root ? repos.get(root) : nonGit;
    paths.set(file, Math.max(paths.get(file) ?? -Infinity, at));
  };
  const start = rows.find(({ entry }) => task?.uuid && entry.uuid === task.uuid)?.offset ?? task?.offset ?? 0;
  for (const { tool, cwd, result, structured, at } of pairedTools(rows, start)) {
    const output = resultText(result);
    if (tool.name === 'Bash') {
      const stdout = typeof structured?.stdout === 'string' ? structured.stdout : output;
      for (const [root, file] of await commitPaths(tool, cwd, stdout)) record(root, file, at);
      continue;
    }
    if (result.is_error || /^(?:<tool_use_error>|(?:Error|Denied|Rejected):|The user (?:rejected|denied)\b)/i.test(output.trim())) {
      continue;
    }
    const target = editorPath(tool, structured);
    if (typeof target !== 'string' || !target || (!cwd && !path.isAbsolute(target))) continue;
    const file = path.resolve(cwd || '', target), dir = path.dirname(file);
    if (!roots.has(dir)) roots.set(dir, await worktreeFor(file));
    record(roots.get(dir), file, at);
  }
  for (const { event, mode, session, at, acceptance } of readJsonl(ledgerPaths(context.session).runs)) {
    if (event !== 'end' || mode !== 'write' || session !== context.session || acceptance?.session !== context.session ||
      acceptance.task !== (task?.id ?? null) || !Array.isArray(acceptance.changed)) continue;
    if (!task?.id && (!task?.at || !(Date.parse(acceptance.startedAt) >= Date.parse(task.at)))) continue;
    for (const change of acceptance.changed) {
      const time = Date.parse(change?.at ?? at);
      if (typeof change?.path !== 'string' || !path.isAbsolute(change.path) || !Number.isFinite(time) ||
        change.before === change.after) continue;
      const root = acceptance.repo;
      if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
      record(root, change.path, time);
    }
  }
  return {
    repos: new Map(sortedEntries(repos).map(([repo, files]) => [repo, new Map(sortedEntries(files))])),
    nonGit: new Map(sortedEntries(nonGit))
  };
}
