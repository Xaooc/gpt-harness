#!/usr/bin/env node
// Global SessionStart hook: make GSD execution use Codex in EVERY GSD project.
//
// The only reliable way to force codex on GSD execution is to SHADOW the
// `gsd-executor` subagent with a project-level `.claude/agents/gsd-executor.md`
// that delegates code-writing to `codex exec`. Doing it per-project by hand is
// the "pердолинг" we want to avoid — so this hook drops that override into any
// GSD project (one with a `.planning/` dir) that doesn't already have it, on
// every session start.
//
// Safety:
// - Only touches projects that have `.planning/` (real GSD projects).
// - Writes ONLY if the file is missing OR already carries our marker — never
//   clobbers a foreign/hand-written gsd-executor override.
// - The override READS the canonical user-level gsd-executor protocol at runtime,
//   so it stays in sync with GSD updates and never duplicates the 786-line file.
// - Any error is swallowed (exit 0); worst case a project just won't get codex
//   execution and you can drop the file manually.
//
// To stop: remove this hook's entry from ~/.claude/settings.json SessionStart.
// To opt one project out of codex execution: replace its
// `.claude/agents/gsd-executor.md` with your own (no MARKER) or delete it + this hook.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MARKER = "codex-auto-override:v1";

const OVERRIDE = `---
name: gsd-executor
description: >-
  AUTO override (${MARKER}) — GSD plan executor that writes production code via Codex
  (gpt-6.1-terra @ max effort, ~/.claude/scripts/luna.sh) while following the standard gsd-executor protocol exactly.
  Dropped by the global codex-gsd-executor-override hook so every GSD command (quick, execute-phase, autonomous,
  progress, ship, manager) implements via Codex automatically.
tools: Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*
color: cyan
effort: high
---

<!-- ${MARKER} : managed by ~/.claude/hooks/codex-gsd-executor-override.mjs.
Safe to edit; the hook only rewrites this file if this marker is present. -->

<role>
You are the GSD plan executor. You follow the standard GSD executor protocol
exactly — but production code is written by **Codex gpt-6.1-terra at max effort**,
not by you. Exception: visual/UI/UX styling work (layout, CSS, look & feel) you
write yourself — GPT is weak at design.
</role>

<step_0_load_protocol>
FIRST, before anything else, Read this file IN FULL and adopt it as your COMPLETE
operating protocol:

\`${path.join(os.homedir(), ".claude", "agents", "gsd-executor.md").replace(/\\\\/g, "/")}\`
(the canonical user-level executor; also \`~/.claude/agents/gsd-executor.md\`)

That file is the stock executor this project override shadows — it is your source
of truth for execution patterns, task_commit_protocol, SUMMARY.md authoring,
checkpoint handling, deviation rules, STATE/ROADMAP updates, anti-stall, CLAUDE.md
enforcement, stub/threat scans. Follow it EXACTLY, with the single implementation
override below. Reading it at runtime keeps this in sync with GSD updates — do NOT
skip. If the Read fails, proceed using the GSD conventions you know and still apply
the override.
</step_0_load_protocol>

<implementation_override>
ONE rule replaces how the stock protocol writes production code:

**You MUST NOT hand-write or hand-edit production code with the Write/Edit tools.**
For every code change a task requires, delegate the writing to Codex via Bash,
from the repository root:

\`\`\`bash
bash ~/.claude/scripts/luna.sh -w -m gpt-6.1-terra -e max -C "<repo root>" -f <brief.md> -o <result.md>
\`\`\`

- The prompt must stand alone (Codex can't see this conversation or PLAN.md):
  exact change + acceptance criteria for THIS task, files to touch, house
  patterns/constraints from PLAN.md and CLAUDE.md, and the literal line:
  **"Edit files only. Do NOT run git add or git commit."**
- Write the brief to a temp file first (\`mktemp\`). Pass \`-m gpt-6.1-terra -e max\`
  explicitly; luna.sh closes stdin — never call bare \`codex exec\` (it
  can hang waiting on stdin).
- luna.sh edits the tree directly and returns when done (no approval prompt).
  One task at a time so commits stay atomic.
- After each run: \`git status\`+\`git diff\`, check vs acceptance criteria, run the
  project verification gates per CLAUDE.md (typecheck+lint+build+tiny tests — never
  the full suite). Re-run codex with a corrected prompt if wrong/incomplete.
- THEN commit the task atomically YOURSELF via task_commit_protocol. Codex must not
  have committed.
- TDD plans: Codex writes the failing test first (RED commit), then implementation
  (GREEN commit).

You STILL author SUMMARY.md / STATE.md and other GSD docs yourself with Write/Edit
(Codex is only for production code). A single trivial one-liner may be edited inline.

**Fallback — never stall:** if \`codex exec\` errors / hits a quota limit / times
out, implement that task inline yourself, note it in SUMMARY.md, and continue.
Resume delegating once Codex recovers.
</implementation_override>
`;

function main() {
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch { /* fall back to cwd */ }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Only GSD projects.
  if (!fs.existsSync(path.join(cwd, ".planning"))) return;

  const target = path.join(cwd, ".claude", "agents", "gsd-executor.md");
  if (fs.existsSync(target)) {
    const cur = fs.readFileSync(target, "utf8");
    if (!cur.includes(MARKER)) return; // foreign override — never clobber
    if (cur === OVERRIDE) return;       // already current
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, OVERRIDE, "utf8");
}

try { main(); } catch { /* swallow */ } finally { process.exitCode = 0; }
