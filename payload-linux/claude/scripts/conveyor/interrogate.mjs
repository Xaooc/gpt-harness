#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePanel } from './lib/orchestration.mjs';

const scripts = path.join(homedir(), '.claude', 'scripts');
const here = path.dirname(fileURLToPath(import.meta.url));
const REPRO_LIMIT = 2 * 1024 * 1024;

function parse(args) {
  const opts = { '--panel': 'review', '--timeout-min': '60' };
  const seen = new Set();
  const allowed = ['--repo', '--base', '--intent', '--out', '--panel', '--timeout-min'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key) || seen.has(key) || !value || value.startsWith('--')) {
      throw new Error(`unknown, duplicate or incomplete argument: ${key}`);
    }
    seen.add(key);
    opts[key] = value;
  }
  for (const key of ['--repo', '--intent', '--out']) if (!opts[key]) throw new Error(`required: ${key}`);
  const minutes = Number(opts['--timeout-min']);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new Error('invalid --timeout-min');
  return { repo: path.resolve(opts['--repo']), base: opts['--base'], intent: path.resolve(opts['--intent']),
    out: path.resolve(opts['--out']), panel: opts['--panel'], timeout: minutes * 60_000 };
}

function commandOverride(name, fallback) {
  if (!process.env[name]) return fallback;
  const value = process.env[name];
  const argv = value.startsWith('[') ? JSON.parse(value) : [process.execPath, value];
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || !part)) {
    throw new Error(`${name} must be a script path or non-empty JSON argv`);
  }
  return argv;
}

// A positive allowlist keeps credentials, agent session state and shell startup hooks out of repros.
function runEnv() {
  const env = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function program(argv, { cwd, input, timeout = 30_000, env = process.env, onTimeout, maxOutput = 64_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stdout = '', error, timedOut = false, stopping = Promise.resolve();
    const capture = (chunk) => {
      if (output.length < maxOutput) output += chunk.toString().slice(0, maxOutput - output.length);
    };
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString().slice(0, maxOutput - stdout.length);
      capture(chunk);
    });
    child.stderr.on('data', capture);
    child.on('error', (value) => { error = value; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
    let force;
    const timer = setTimeout(() => {
      timedOut = true;
      stopping = Promise.resolve().then(onTimeout).catch((value) => { error = value; }).finally(() => {
        kill('SIGTERM');
        force = setTimeout(() => kill('SIGKILL'), 1000);
      });
    }, Math.max(1, timeout));
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await stopping;
      clearTimeout(force);
      resolve({ code: timedOut ? 124 : code ?? 128, output: output + (error ? `\n${error.message}` : ''),
        stdout, timedOut, signal });
    });
  });
}

async function checked(argv, options) {
  const result = await program(argv, { maxOutput: Infinity, ...options });
  if (result.code !== 0) throw new Error(`${argv[0]}: exit ${result.code}: ${result.output.trim()}`);
  return result.stdout;
}

const git = (repo, args, options) => checked(['git', '-C', repo, ...args], options);

async function baselineTree(worktree, index) {
  const options = { env: { ...process.env, GIT_INDEX_FILE: index } };
  try {
    await git(worktree, ['read-tree', 'HEAD'], options);
    await git(worktree, ['add', '-A', '.'], options);
    return (await git(worktree, ['write-tree'], options)).trim();
  } finally {
    await fs.rm(index, { force: true });
    await fs.rm(`${index}.lock`, { force: true });
  }
}

async function saveRepro(worktree, baseline, out, seat) {
  await git(worktree, ['add', '-A', '-N', '.']);
  // The baseline tree is HEAD plus the copied scope, so this excludes that scope even in files the seat also edits.
  // No commit is needed; intent-to-add includes the adversary's new files in the working-tree diff.
  const patch = await git(worktree, ['diff', baseline ?? 'HEAD', '--'], { maxOutput: REPRO_LIMIT + 1 });
  let bytes = Buffer.from(patch);
  const note = '\n# Repro patch truncated at 2 MB; remaining changes were omitted.\n';
  if (bytes.length > REPRO_LIMIT) {
    seat.reproNote = note.trim().slice(2);
    bytes = Buffer.concat([bytes.subarray(0, REPRO_LIMIT - Buffer.byteLength(note)), Buffer.from(note)]);
  }
  const file = path.join(out, `seat-${seat.seat}.repro.patch`);
  await fs.writeFile(file, bytes);
  seat.repro = file;
}

async function scopeFor(repo, requestedBase) {
  const head = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
  let base = requestedBase;
  if (!base) {
    for (const branch of ['main', 'master']) {
      const exists = await program(['git', '-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (exists.code === 0) { base = (await git(repo, ['merge-base', 'HEAD', branch])).trim(); break; }
    }
    if (!base) throw new Error('no main/master branch; supply --base');
  }
  base = (await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const commits = (await git(repo, ['log', '--format=%h %s', `${base}..${head}`])).trim().split('\n').filter(Boolean);
  const stat = await git(repo, ['diff', '--stat', base, '--']);
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const patch = await git(repo, ['diff', '--binary', '--full-index', head, '--']);
  return { scope: { repo, base, head, commits, stat, untracked }, patch };
}

async function collect(seat, worktree, out, result) {
  let findings;
  try {
    const text = await fs.readFile(out, 'utf8');
    for (const match of text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
      try {
        const block = JSON.parse(match[1]);
        if (Array.isArray(block.findings)) findings = block.findings;
      } catch { /* Other JSON fences may describe a repro rather than the mandatory block. */ }
    }
    if (!findings) throw new Error('missing findings JSON block');
  } catch (error) {
    result.dropped.push({ seat, title: 'Seat output', reason: error.message });
    return;
  }
  for (const item of findings) {
    const title = typeof item?.title === 'string' ? item.title : 'Untitled';
    if (typeof item?.command !== 'string' || !item.command.trim() || typeof item.output !== 'string' || !item.output.trim()) {
      result.dropped.push({ seat, title, reason: 'no run' });
      continue;
    }
    let rerun;
    try {
      await checked([process.execPath, path.join(scripts, 'heavy-gate.mjs'), 'wait'], { cwd: worktree, timeout: 300_000 });
      rerun = await program(['/bin/sh', '-c', item.command], { cwd: worktree, timeout: 300_000, env: runEnv() });
    } catch (error) { rerun = { code: 127, output: error.message }; }
    result.findings.push({ seat, title, command: item.command, output: item.output,
      expected: typeof item.expected === 'string' ? item.expected : '',
      rerun_exit: rerun.code, rerun_output: rerun.output.slice(0, 4000) });
  }
}

function report(result) {
  const lines = ['# Intent', '', result.intent, '', '# Findings', '',
    'Rerun evidence only. The orchestrator must verify failures against intent per arena Phase F.', ''];
  if (!result.findings.length) lines.push('No findings with run evidence.', '');
  for (const finding of result.findings) {
    lines.push(`## ${finding.title} (seat ${finding.seat})`, '', `Command: ${JSON.stringify(finding.command)}`, '',
      `Reported output: ${JSON.stringify(finding.output)}`, '', `Expected: ${JSON.stringify(finding.expected)}`, '',
      `Rerun exit: ${finding.rerun_exit}`, '', `Rerun output: ${JSON.stringify(finding.rerun_output)}`, '');
  }
  lines.push('# Dropped', '');
  for (const seat of result.seats) {
    const dropped = result.dropped.filter((item) => item.seat === seat.seat);
    lines.push(`- Seat ${seat.seat} (${seat.provider}/${seat.model}): ${dropped.length} dropped; ${seat.status}. ${seat.reason}`);
    for (const item of dropped) lines.push(`  - ${item.title}: ${item.reason}`);
    if (seat.dispatch) lines.push(`  - Claude hand-off: ${seat.dispatch}; brief: ${seat.brief}`);
    if (seat.repro) lines.push(`  - Repro patch: ${seat.repro}${seat.reproNote ? ` (${seat.reproNote})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
  let opts;
  try { opts = parse(args); }
  catch (error) { process.stderr.write(`interrogate: ${error.message}\n`); return 2; }
  const intent = await fs.readFile(opts.intent, 'utf8');
  opts.repo = (await git(opts.repo, ['rev-parse', '--show-toplevel'])).trim();
  const { scope, patch } = await scopeFor(opts.repo, opts.base);
  const { seats } = await resolvePanel(opts.panel);
  const skill = await fs.readFile(new URL('../../local-plugins/pstack/skills/interrogate/SKILL.md', import.meta.url), 'utf8');
  const adversary = skill.split('\n').find((line) => line.startsWith('> Break this change.'))?.slice(2);
  if (!adversary) throw new Error('interrogate skill is missing its adversary brief');
  const runid = randomUUID(), owner = `interrogate-${runid}`;
  const until = new Date();
  until.setDate(until.getDate() + 2);
  const expiry = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`;
  const wtNew = commandOverride('CONVEYOR_WT_NEW', [process.execPath, path.join(scripts, 'disk/wt-new.mjs')]);
  const wtDone = commandOverride('CONVEYOR_WT_DONE', [process.execPath, path.join(scripts, 'disk/wt-done.mjs')]);
  const exec = commandOverride('CONVEYOR_EXEC_CMD', [process.execPath, path.join(here, 'exec.mjs')]);
  await fs.mkdir(opts.out, { recursive: true });
  // Seat worktrees live on disk next to the repository: /tmp is a small RAM-backed tmpfs here, and wt-new refuses
  // to create worktrees there once it holds less than 10 GB free.
  const rootBase = process.env.CONVEYOR_INTERROGATE_ROOT
    || path.join(path.dirname(opts.repo), `${path.basename(opts.repo)}-interrogate`);
  await fs.mkdir(rootBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(rootBase, 'run-'));
  const result = { intent, scope, seats: seats.map(({ seat, provider, model, available, reason }) => ({
    seat, provider, model, status: available ? 'pending' : 'unavailable', reason
  })), findings: [], dropped: [] };
  const created = [], deadline = Date.now() + opts.timeout;
  let cleanupFailed = false;
  try {
    await Promise.all(seats.filter((seat) => seat.available).map(async (entry) => {
      const seat = result.seats[entry.seat], worktree = path.join(root, `seat-${entry.seat}`);
      const branch = `interrogate/${runid}-${entry.seat}`;
      const output = path.join(opts.out, `seat-${entry.seat}.out.md`), brief = path.join(opts.out, `seat-${entry.seat}.brief.md`);
      const cleanup = { worktree, branch, seat };
      created.push(cleanup);
      try {
        // Reusing an output directory must never replay findings or dispatches from an earlier run.
        await fs.rm(output, { force: true });
        await fs.rm(`${output}.dispatch.json`, { force: true });
        await fs.rm(path.join(opts.out, `seat-${entry.seat}.repro.patch`), { force: true });
        await checked([...wtNew, '--repo', opts.repo, '--path', worktree, '--new-branch', branch, '--base', scope.head,
          '--owner', owner, '--purpose', `interrogate seat ${entry.seat}`, '--until', expiry, '--no-public']);
        if (patch) await git(worktree, ['apply', '--binary', '-'], { input: patch });
        for (const file of scope.untracked) {
          const target = path.join(worktree, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.cp(path.join(opts.repo, file), target, { recursive: true, dereference: false, verbatimSymlinks: true });
        }
        cleanup.baseline = await baselineTree(worktree, path.join(root, `seat-${entry.seat}.baseline.index`));
        await fs.writeFile(brief, `# Scope\n\n${JSON.stringify(scope, null, 2)}\n\n# Intent\n\n${intent}\n\n`
          + `# Adversary brief\n\n${adversary}\n\n# Mandatory output\n\n`
          + 'Include a fenced JSON block (an empty findings list is allowed):\n\n```json\n'
          + '{"findings":[{"title":"…","command":"…","output":"…","expected":"…"}]}\n```\n');
        // Panel runs already bypass the gate; --no-gate alone is rejected by exec's waiver validation.
        const launched = await program([...exec, 'run', '--panel', opts.panel, '--seat', String(entry.seat),
          '-w', '-C', worktree, '-f', brief, '-o', output], {
          timeout: deadline - Date.now(),
          onTimeout: () => checked(['bash', path.join(scripts, 'luna-stop.sh'), output])
        });
        seat.status = launched.timedOut ? 'timeout' : ({ 0: 'done', 4: 'claude-handoff', 5: 'unavailable',
          6: 'gate-failed', 7: 'write-locked' }[launched.code] || 'failed');
        seat.reason = launched.timedOut ? 'run deadline exceeded' : `exec exit ${launched.code}`;
        if (launched.code === 4) {
          seat.dispatch = `${output}.dispatch.json`;
          seat.brief = brief;
          seat.reason += '; spawn a Claude subagent with this brief in a new throwaway worktree; this worktree is removed';
          try { seat.handoff = JSON.parse(await fs.readFile(seat.dispatch, 'utf8')); }
          catch { seat.reason += '; dispatch file missing or invalid'; }
        }
        if (launched.output.trim()) await fs.writeFile(`${output}.runner.log`, launched.output);
      } catch (error) { seat.status = 'failed'; seat.reason = error.message; }
    }));
    // Serialize repros: each may be a heavy command, so gate immediately before every run.
    for (const { worktree, seat } of created) {
      if (seat.status !== 'claude-handoff' && seat.status !== 'unavailable') {
        await collect(seat.seat, worktree, path.join(opts.out, `seat-${seat.seat}.out.md`), result);
      }
    }
  } finally {
    for (const { worktree, branch, seat, baseline } of created) {
      try {
        // These are this run's disposable worktrees. Avoid wt-done --archive, which commits repros.
        const exists = await fs.stat(worktree).then(() => true, () => false);
        if (exists) {
          await saveRepro(worktree, baseline, opts.out, seat);
          await git(worktree, ['reset', '--hard', scope.head]);
          await git(worktree, ['clean', '-ffdx']);
          await checked([...wtDone, worktree]);
        }
        const branchExists = await program(['git', '-C', opts.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (branchExists.code === 0) await git(opts.repo, ['branch', '-D', '--', branch]);
      } catch (error) {
        cleanupFailed = true;
        seat.reason += `; cleanup failed (${worktree}): ${error.message}`;
      }
    }
    if (!cleanupFailed) {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rmdir(rootBase).catch(() => {});
    }
    result.findings.sort((a, b) => a.seat - b.seat);
    result.dropped.sort((a, b) => a.seat - b.seat);
    await fs.writeFile(path.join(opts.out, 'findings.json'), `${JSON.stringify(result, null, 2)}\n`);
    await fs.writeFile(path.join(opts.out, 'report.md'), report(result));
  }
  if (cleanupFailed) return 1;
  if (result.seats.every((seat) => seat.status === 'unavailable')) return 5;
  // A run in which no seat got to work (every seat unavailable or failed to start) proves nothing: report failure.
  return result.seats.some((seat) => !['unavailable', 'failed'].includes(seat.status)) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`interrogate: ${error.message}\n`);
    process.exitCode = 1;
  });
}
