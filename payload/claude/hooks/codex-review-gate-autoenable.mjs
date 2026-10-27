#!/usr/bin/env node
// Global SessionStart hook: turn ON the Codex plugin "review gate" for whatever
// workspace the current Claude Code session opened in.
//
// Why this exists: the codex@openai-codex plugin stores the review-gate flag in
// PER-WORKSPACE state, keyed under CLAUDE_PLUGIN_DATA. There is no single global
// switch. This hook makes the gate effectively global ("for all projects") by
// flipping that per-workspace flag at session start, writing to the SAME data
// dir the plugin's own Stop hook reads from.
//
// PAUSE SWITCH: if the sentinel file ~/.claude/codex-gate-paused exists, this
// hook DISABLES the gate instead (and stops re-enabling it). Use this when Codex
// usage limits are exhausted, so the Stop-time review gate does not hard-block
// every turn with quota errors. Remove the file to resume auto-enabling once
// limits recover.
//
// Fail-safe: ANY error (plugin updated/removed, path changed, bad input) is
// swallowed and the hook exits 0. Worst case the gate simply isn't auto-enabled
// and you can still run `/codex:setup --enable-review-gate` per project.
//
// To stop auto-enabling everywhere permanently: remove the SessionStart entry
// that calls this file from ~/.claude/settings.json. To turn the gate OFF in one
// project for the current session: `/codex:setup --disable-review-gate`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PAUSE_SENTINEL = path.join(os.homedir(), ".claude", "codex-gate-paused");

async function main() {
  // 1. Read the hook payload (SessionStart provides { cwd, ... } on stdin).
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    /* no stdin / not JSON — fall back to env/cwd below */
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // 2. Point the plugin's state layer at the real plugin data dir.
  //    Convention (observed): ~/.claude/plugins/data/<pluginName>-<marketplace>.
  const pluginDataDir = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "data",
    "codex-openai-codex",
  );
  fs.mkdirSync(pluginDataDir, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  // 3. Import the plugin's own state helpers so slug/hash math stays identical
  //    to what the Stop hook uses when it reads the flag back.
  const { codexPluginRoot } = await import("../scripts/lib/codex-plugin.mjs");
  const installedRoot = codexPluginRoot();
  if (!installedRoot) return;
  const pluginRoot = path.join(installedRoot, "scripts", "lib");
  const statePath = path.join(pluginRoot, "state.mjs");
  const workspacePath = path.join(pluginRoot, "workspace.mjs");
  if (!fs.existsSync(statePath) || !fs.existsSync(workspacePath)) return;

  const { setConfig, getConfig } = await import(pathToFileURL(statePath).href);
  const { resolveWorkspaceRoot } = await import(pathToFileURL(workspacePath).href);

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const current = (() => {
    try {
      return getConfig(workspaceRoot)?.stopReviewGate === true;
    } catch {
      return false;
    }
  })();

  // 4a. PAUSED (Codex limits exhausted): make sure the gate is OFF, then stop.
  if (fs.existsSync(PAUSE_SENTINEL)) {
    if (current) setConfig(workspaceRoot, "stopReviewGate", false);
    return;
  }

  // 4b. Normal: enable the gate (idempotent — skip write if already on).
  if (current) return;
  setConfig(workspaceRoot, "stopReviewGate", true);
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
