#!/usr/bin/env node
// Global SessionStart hook: make every session, in every project, start with the
// `luna` orchestration rules in mind (Codex Luna / Sol delegation).
//
// The full skill (~20 KB) is too big for hook output (Claude Code persists large
// hook output to a file and shows only a 2 KB preview), so this injects a short
// digest of the rules that must never be missed, plus an instruction to load the
// full skill through the Skill tool before the first delegation. The digest is
// static on purpose: details live in SKILL.md, which the self-learning loop may edit.
//
// OFF SWITCH: create ~/.claude/luna-autoload-off. Fail-safe: errors → exit 0, no output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const claudeDir = path.join(os.homedir(), ".claude");
const OFF_SENTINEL = path.join(claudeDir, "luna-autoload-off");

const DIGEST = `<EXTREMELY_IMPORTANT>
Codex orchestration is active in this session (global SessionStart hook). Before you delegate anything
for the first time in this session, load the full \`luna\` skill with the Skill tool (and \`luna-critics\`
before a review). Rules that always apply:
- Claude orchestrates; Codex executes through \`bash ~/.claude/scripts/luna.sh\`. Any implementation that is
  more than simple goes to Sol: \`-m gpt-6.1-sol -e high\` (when in doubt, Sol). Luna handles simple/mechanical
  work, research scouts, critics and images.
- The executors are literal: they do exactly what the brief says and miss what it doesn't. Briefs must be
  exhaustive (ripples, edge cases, decisions, invariants, non-goals, intent, exact checks). Then review what
  the brief did NOT say, and include the "Ревизор пробелов" critic after Sol/Luna implementations.
- After every launch: check \`luna-status.sh\`, then ALWAYS arm a stall watcher with the Monitor tool:
  \`bash ~/.claude/scripts/luna-watch.sh -i 300 <out.md> ...\` (600 for Sol). Act immediately on STALL/GONE.
- Stop a job with \`bash ~/.claude/scripts/luna-stop.sh <out.md>\`: stopping the Bash task does NOT stop it. Never edit
  luna.sh / luna-pool.mjs / luna-daemon.mjs in place, because other sessions are running them (write .next, swap when idle).
- Design/UI/UX/CSS/visuals are done by Opus itself, never delegated. Generate raster images proactively
  (Opus writes the prompt and judges, Luna generates), with no permission needed.
- Clean up as you go (CLAUDE.md section 5): job artifacts, temp files, extra backups (max one per file),
  monitors and processes. The last line of the report says what was cleaned and what was kept.
</EXTREMELY_IMPORTANT>`;

try {
  if (!fs.existsSync(OFF_SENTINEL)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: DIGEST },
    }));
  }
} catch {
  /* fail-safe: never block session start */
}
process.exit(0);
