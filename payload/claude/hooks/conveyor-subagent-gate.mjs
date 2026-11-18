#!/usr/bin/env node
// SubagentStop gate. Internal failures are logged and must never prevent a subagent from stopping.
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  gateRepository, gateChangedFiles, gateMode, gateSessionFile, runGateChecks, gateDetails, gateInstruction,
  failedCheck, protectedFiles, modifiedTests, budgetOnlyFailure
} from '../scripts/conveyor/exec.mjs';
import { trimSnapshot, trimViolations } from '../scripts/conveyor/lib/hygiene.mjs';

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function ownerFor(session, repo) {
  let text;
  try { text = await fs.readFile(gateSessionFile(session), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    const owner = JSON.parse(line);
    if (owner.repo === repo) return owner;
  }
  return null;
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const { repo, base: head } = await gateRepository(input.cwd || process.cwd());
  if (!head) return;
  const session = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  const owner = await ownerFor(session, repo);
  const mode = owner?.mode ?? await gateMode(repo);
  if (mode === 'off') return;
  const base = owner?.base || head;
  const files = await gateChangedFiles(repo, base);
  // Keep the previous red gate's snapshot across the subagent's continuation (the fix round).
  const identity = [session, repo, base, owner?.at, input.agent_id, input.agent_transcript_path || input.transcript_path];
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const stateFile = path.join(path.dirname(gateSessionFile(session)), `${key}.gate.json`);
  let previous;
  try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const snapshot = await protectedFiles(repo);
  // After a budget-only failure the subagent may trim the tests it added (deletions only); otherwise no test edits.
  const trim = previous?.trim;
  const tests = modifiedTests(new Map(previous?.protected || []), snapshot, Boolean(trim))
    .filter((file) => !trim || !Object.hasOwn(trim.tests, file));
  if (tests.length) {
    print({ systemMessage: `## Gate: fail (fix round modified tests: ${tests.join(', ')})` });
    return;
  }
  if (trim) {
    const problems = await trimViolations(repo, base, trim, files);
    if (problems.length) {
      print({ systemMessage: `## Gate: fail (the trim round may only delete tests the job added: ${problems.join('; ')})` });
      return;
    }
  }
  if (!files.length) return;
  const last = await runGateChecks(repo, base, files);
  if (last.configError) {
    await logError(new Error(last.configError));
    print({ systemMessage: `Conveyor gate: config error: ${last.configError}` });
    return;
  }
  if (last.ok) {
    await fs.rm(stateFile, { force: true });
    return;
  }
  const summary = gateDetails(last, true).replace(/\s+/g, ' ').slice(0, 6000);
  if (mode === 'warn') {
    print({ systemMessage: `Conveyor gate: warn: ${summary}` });
    return;
  }
  // Timing varies on every run. Only failure identities and diagnostics determine a repeated failure.
  const failures = last.results.filter(failedCheck)
    .map(({ name, cmd, status, rc, outputTail }) => ({ name, cmd, status, rc, outputTail }));
  const fingerprint = createHash('sha256').update(JSON.stringify({ failures, hygiene: last.hygiene, tests: last.tests?.added }))
    .digest('hex');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const nextTrim = budgetOnlyFailure(last) ? await trimSnapshot(repo, files) : undefined;
  await fs.writeFile(stateFile, JSON.stringify({ fingerprint, protected: [...snapshot], trim: nextTrim }), { mode: 0o600 });
  if (input.stop_hook_active === true && previous?.fingerprint === fingerprint) {
    print({ systemMessage: `Conveyor gate failed again; allowing stop to avoid a loop. ${summary}` });
  } else print({ decision: 'block', reason: budgetOnlyFailure(last) ? summary : `${summary} ${gateInstruction}` });
}

async function logError(error) {
  try {
    const directory = path.join(homedir(), '.claude', 'logs');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const message = String(error?.message || error).replace(/[\r\n]+/g, ' ');
    await fs.appendFile(path.join(directory, 'conveyor-gate.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { /* Logging failures must also fail open. */ }
}

main().catch(async (error) => {
  process.exitCode = 0;
  await logError(error);
});
