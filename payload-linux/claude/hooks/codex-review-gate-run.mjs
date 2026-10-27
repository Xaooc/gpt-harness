#!/usr/bin/env node
// Global Stop hook: run the Codex plugin's stop-time review gate RELIABLY.
//
// Why this exists: Claude Code loads the codex@openai-codex plugin's
// commands/skills/agent, but in this setup it does NOT invoke the plugin's own
// hooks/hooks.json Stop hook (verified: no review job ever appears at end of
// turn). So we drive the gate ourselves from ~/.claude/settings.json — which CC
// definitely executes — forcing the same CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA
// the rest of this setup uses, then delegating to the plugin's real gate hook.
//
// It forwards the Stop event (stdin) to the plugin hook and passes the hook's
// stdout/stderr straight back to CC, so a `{"decision":"block",...}` verdict
// still blocks the turn. The gate's on/off flag lives in per-workspace state
// (stopReviewGate); the pause sentinel ~/.claude/codex-gate-paused flips it off
// via the SessionStart autoenable hook, so this runner becomes a silent no-op
// while paused. ANY failure here is swallowed (exit 0) so the turn never wedges.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { codexPluginRoot } from "../scripts/lib/codex-plugin.mjs";

import { loadProxyEnv } from "../scripts/lib/luna-runtime.mjs";

function main() {
  // Read the Stop event payload CC sends on stdin (cwd, last_assistant_message,
  // session_id, ...). Forward it verbatim to the plugin hook.
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin — pass empty, hook handles it */
  }

  const home = os.homedir();
  // 2026-10-21: the plugin's own Stop hook now runs too (brokers from plugins/cache appear on every turn). Running
  // both doubled every review and, racing on the same broker.json, orphaned one broker + Codex process per turn.
  // While this sentinel exists the plugin's own hook does the review alone; delete it to bring this runner back.
  if (fs.existsSync(path.join(home, ".claude", "codex-gate-runner-off"))) return;
  const pluginRoot = codexPluginRoot(home);
  if (!pluginRoot) return;
  const gateHook = path.join(pluginRoot, "scripts", "stop-review-gate-hook.mjs");
  const pluginData = path.join(home, ".claude", "plugins", "data", "codex-openai-codex");
  if (!fs.existsSync(gateHook)) return; // plugin source missing → no-op

  loadProxyEnv();
  const child = spawnSync(process.execPath, [gateHook], {
    input,
    // stdout/stderr inherited → the plugin hook's decision JSON reaches CC,
    // its notes reach the transcript. 16-min cap matches the plugin's own.
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 16 * 60 * 1000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
  });

  // Forward the plugin hook's exit code so a non-JSON block path still works.
  if (typeof child.status === "number") process.exitCode = child.status;
}

try {
  main();
} catch {
  process.exitCode = 0;
}
