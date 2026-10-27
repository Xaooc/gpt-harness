#!/usr/bin/env node
// Global PreToolUse(Edit|Write) hook: forbid Claude from hand-writing PRODUCTION
// CODE in GSD projects, so code is ALWAYS written by Codex (`codex exec`) — even
// on direct/inline work with no GSD command. This is the only HARD way to make
// "use Codex" automatic for the main thread (which has no subagent to shadow).
//
// Scope / safety:
// - Blocks ONLY when the edited file is a known CODE extension AND lives inside a
//   project that has a `.planning/` dir (a real GSD project). Docs/config/.md/.json
//   and files outside any GSD project (e.g. ~/.claude) are allowed.
// - codex's OWN writes go through its own process (Bash), NOT Claude's Edit/Write,
//   so this hook never blocks Codex — only Claude's direct edits.
// - ESCAPE HATCH (avoids deadlock when Codex is down/over quota): if the file
//   ~/.claude/codex-codeblock-paused exists, all edits are allowed. Create it during
//   a Codex outage, remove it when Codex is back.
// - Any internal error → allow (fail-open); never wedge the session on a hook bug.
//
// Remove this hook's entry from ~/.claude/settings.json PreToolUse to disable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PAUSE = path.join(os.homedir(), ".claude", "codex-codeblock-paused");

// Extensions treated as production code (this stack + common langs).
const CODE_EXT = new Set([
  "ts","tsx","js","jsx","mjs","cjs","py","go","rs","java","rb","php",
  "c","cc","cpp","cxx","h","hpp","cs","swift","kt","kts","scala","m","mm",
  "vue","svelte","astro","css","scss","sass","less","sql","sh","bash","zsh",
  "ps1","lua","dart","ex","exs","erl","clj","cljs","r","jl","hs","ml","pl",
]);

// Path segments that are never "your code to write" — allow edits there.
const EXCLUDED_SEGMENTS = ["node_modules", ".git", ".planning", ".next", "dist", "build", "out", "vendor", ".venv", "__pycache__"];

function hasPlanningAncestor(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, ".planning"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function main() {
  // Escape hatch first — cheap and decisive.
  if (fs.existsSync(PAUSE)) return; // allow

  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }

  const tool = payload.tool_name || "";

  // --- Bash branch: block shell commands that WRITE code files (the bypass the
  //     gate review flagged: echo/cat>/tee/sed -i/dd of= to a code file). ---
  if (tool === "Bash") {
    const cmd = (payload.tool_input && payload.tool_input.command) || "";
    if (typeof cmd !== "string" || !cmd) return;
    // Never block the Codex invocation itself (its prompt may contain '>' / code paths).
    if (/\bcodex\s+exec\b/.test(cmd) || /\bcodex-companion(\.mjs)?\b/.test(cmd)) return;
    const cwd = payload.cwd || process.cwd();
    if (!hasPlanningAncestor(path.join(cwd, "_"))) return; // only inside GSD projects
    const exts = [...CODE_EXT].join("|");
    // redirection (> / >>), tee, dd of=  →  a path ending in a code extension
    const writeRe = new RegExp("(?:>>?|\\btee\\b\\s+(?:-a\\s+)?|\\bdd\\b[^|;&]*\\bof=)\\s*['\"]?[^\\s'\"|&;<>]*\\.(?:" + exts + ")(?![a-z0-9])", "i");
    // in-place stream edits of a code file
    const sedRe = new RegExp("\\b(?:sed|perl)\\b[^|;&]*-i[^|;&]*\\.(?:" + exts + ")(?![a-z0-9])", "i");
    if (writeRe.test(cmd) || sedRe.test(cmd)) {
      process.stderr.write(
        `⛔ Writing code files via Bash (redirect/tee/sed -i/dd) is disabled in this project — code MUST be written by Codex.\n` +
        `Use instead:  codex exec -s workspace-write --skip-git-repo-check "<self-contained task incl. 'Edit files only. Do NOT run git add or git commit.'>"\n` +
        `Reading/running code, and writing non-code (.md/.json/logs), is fine.\n` +
        `Codex outage bypass: create ~/.claude/codex-codeblock-paused (remove when Codex is back).\n`
      );
      process.exitCode = 2;
    }
    return;
  }

  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return;

  const fp = payload.tool_input && (payload.tool_input.file_path || payload.tool_input.filePath);
  if (!fp || typeof fp !== "string") return; // can't tell → allow

  const norm = fp.replace(/\\/g, "/");
  if (EXCLUDED_SEGMENTS.some((seg) => norm.split("/").includes(seg))) return; // allow

  const ext = (norm.split(".").pop() || "").toLowerCase();
  if (!CODE_EXT.has(ext)) return; // not code → allow (docs/config/etc.)

  if (!hasPlanningAncestor(fp)) return; // not inside a GSD project → allow

  // BLOCK: code file in a GSD project, no pause → force Codex.
  process.stderr.write(
    `⛔ Direct Edit/Write of code is disabled in this project — code MUST be written by Codex.\n` +
    `Implement this change via Bash instead (from the repo root):\n` +
    `  codex exec -s workspace-write --skip-git-repo-check "<self-contained task: the exact change to ${path.basename(norm)}, the acceptance criteria, and the line 'Edit files only. Do NOT run git add or git commit.'>"\n` +
    `Then review the diff, run the project's checks, and commit. Non-code files (.md/.json/config) may be edited directly.\n` +
    `If Codex is unavailable (quota/outage), bypass temporarily: create the file ~/.claude/codex-codeblock-paused (remove it when Codex is back).\n`
  );
  process.exitCode = 2; // exit 2 = block the tool call, feed stderr to Claude
}

try { main(); } catch { process.exitCode = 0; }
