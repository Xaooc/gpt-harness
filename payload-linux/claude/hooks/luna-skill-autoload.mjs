#!/usr/bin/env node
// Global SessionStart hook: pstack-first session initialization.
//
// Injects Lauren Tan's pstack as default process guidance when installed,
// resolved from ~/.claude/plugins/cache/luna-local/pstack/<version>/ or
// ~/.claude/local-plugins/pstack/. Falls back gracefully if pstack is missing.
//
// OFF SWITCH: create ~/.claude/luna-autoload-off. Fail-safe: errors → exit 0, no output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PSTACK_HEADER = [
  "This harness runs Lauren Tan's pstack as its default process" +
    " (user decision 2026-11-16). pstack root: {{PSTACK}}",
  "Before your first task in this session, read {{PSTACK}}/docs/harness/claude-code.md, then",
  "{{PSTACK}}/docs/harness/bro-harness.md (this harness's adapter; it wins), then work in poteto-mode:",
  "follow {{PSTACK}}/skills/poteto-mode/SKILL.md for every task (playbooks, named principles read from their leaf",
  "skills, proof against the real artifact). The adapter overrides pstack \"Autonomy\": anything external (messages,",
  "tickets, PRs, push, merge, deploy) needs the user's yes. superpowers and GSD skills are not the default process:",
  "use them only when the user names one or the project is a GSD project.",
].join("\n");

const PSTACK_MISSING_HEADER =
  "pstack is not installed: tell the user once and use the `luna` skill rules.";

const EXECUTORS_PART = `Executors (load the \`luna\` skill before the first delegation):
- Delegate by tier through \`node ~/.claude/scripts/conveyor/exec.mjs run --tier <complex|simple|review|scout>
  (-w|-r) -C <dir> -f <brief.md> -o <out.md>\`. complex: Codex Sol 6.1 -> Claude Sonnet; simple: Gemini ->
  Codex Luna -> Claude Haiku. Chains, models and efforts live in ~/.claude/conveyor/orchestration.json and are
  edited in the Luna panel. Exit 4: spawn a Claude subagent with the model in <out>.dispatch.json.
- Briefs are exhaustive (executors are literal; ripples, edge cases, decisions, invariants, non-goals, intent,
  exact checks); review what the brief did NOT say.
- After every launch: \`luna-status.sh <out>\`, then arm \`luna-watch.sh -i 600 <out>\` with the Monitor tool; stop jobs
  with \`luna-stop.sh\`. Never edit luna.sh / luna-pool.mjs / luna-daemon.mjs in place.
- Design/UI/UX/CSS/visuals are done by Opus itself, never delegated; generate raster images proactively.
- Clean up as you go (CLAUDE.md "Always clean up after yourself"); the last line of the report says what was cleaned and kept.`;

export const DIGEST_TEMPLATE = `<EXTREMELY_IMPORTANT>
${PSTACK_HEADER}
${EXECUTORS_PART}
</EXTREMELY_IMPORTANT>`;

function parseVersion(v) {
  const str = String(v ?? "").trim().replace(/^v/i, "");
  const match = str.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!match) {
    return { segments: [], suffix: str };
  }
  const segments = match[1].split(".").map((n) => parseInt(n, 10));
  const suffix = match[2];
  return { segments, suffix };
}

function compareVersions(v1, v2) {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  const len = Math.max(p1.segments.length, p2.segments.length);
  for (let i = 0; i < len; i++) {
    const s1 = p1.segments[i] ?? 0;
    const s2 = p2.segments[i] ?? 0;
    if (s1 !== s2) {
      return s1 - s2;
    }
  }
  if (p1.suffix < p2.suffix) {
    return -1;
  }
  if (p1.suffix > p2.suffix) {
    return 1;
  }
  return 0;
}

function compareCandidates(a, b) {
  const vDiff = compareVersions(a.version, b.version);
  if (vDiff !== 0) {
    return vDiff;
  }
  return a.mtime - b.mtime;
}

export function resolvePstack(home = os.homedir()) {
  const cacheBase = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "luna-local",
    "pstack"
  );
  try {
    if (fs.existsSync(cacheBase) && fs.statSync(cacheBase).isDirectory()) {
      const entries = fs.readdirSync(cacheBase, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        const dir = path.join(cacheBase, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
          try {
            isDir = fs.statSync(dir).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (!isDir) {
          continue;
        }

        const skillPath = path.join(dir, "skills", "poteto-mode", "SKILL.md");
        const adapterPath = path.join(dir, "docs", "harness", "bro-harness.md");
        if (!fs.existsSync(skillPath) || !fs.existsSync(adapterPath)) {
          continue;
        }

        let version = entry.name;
        const pluginJson = path.join(dir, ".claude-plugin", "plugin.json");
        try {
          if (fs.existsSync(pluginJson)) {
            const parsed = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
            if (typeof parsed.version === "string" && parsed.version.trim()) {
              version = parsed.version.trim();
            }
          }
        } catch {
          // ignore corrupted plugin.json and keep entry.name
        }

        let mtime = 0;
        try {
          mtime = fs.statSync(dir).mtimeMs;
        } catch {
          // ignore stat error
        }

        candidates.push({
          dir: path.resolve(dir),
          version,
          mtime,
        });
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => compareCandidates(b, a));
        return candidates[0].dir;
      }
    }
  } catch {
    // ignore cache inspection errors and proceed to local-plugins
  }

  try {
    const localDir = path.resolve(
      path.join(home, ".claude", "local-plugins", "pstack")
    );
    const skillPath = path.join(localDir, "skills", "poteto-mode", "SKILL.md");
    const adapterPath = path.join(localDir, "docs", "harness", "bro-harness.md");
    if (fs.existsSync(skillPath) && fs.existsSync(adapterPath)) {
      return localDir;
    }
  } catch {
    // ignore local-plugins inspection errors
  }

  return null;
}

export function buildDigest(pstackRoot) {
  if (pstackRoot) {
    return DIGEST_TEMPLATE.replaceAll("{{PSTACK}}", pstackRoot);
  }
  return `<EXTREMELY_IMPORTANT>\n${PSTACK_MISSING_HEADER}\n${EXECUTORS_PART}\n</EXTREMELY_IMPORTANT>`;
}

export function runHook(home = os.homedir()) {
  try {
    const offSentinel = path.join(home, ".claude", "luna-autoload-off");
    if (!fs.existsSync(offSentinel)) {
      const pstack = resolvePstack(home);
      const digest = buildDigest(pstack);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: digest,
          },
        })
      );
    }
  } catch {
    /* fail-safe: never block session start */
  }
}

function isMainScript() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const scriptPath = path.resolve(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    if (scriptPath === modulePath) {
      return true;
    }
    return fs.realpathSync(scriptPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isMainScript()) {
  runHook();
  process.exit(0);
}
