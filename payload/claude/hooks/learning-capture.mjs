#!/usr/bin/env node
// Stop / SessionEnd hook: capture learning evidence in a detached extractor.
// OFF SWITCH: create ~/.claude/learning/CAPTURE_OFF to stop capture.
// Fail-safe: any error exits 0 silently; never block a session or print a decision.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const timer = setTimeout(() => process.exit(0), 2000);

try {
  const local = new URL("../scripts/learning/common.mjs", import.meta.url);
  const commonUrl = fs.existsSync(fileURLToPath(local)) ? local
    : pathToFileURL(path.join(os.homedir(), ".claude", "scripts", "learning", "common.mjs"));
  const { isCaptureOff, spawnDetached, findNode, SCRIPTS_DIR } = await import(commonUrl.href);
  if (!isCaptureOff()) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    if (typeof event.transcript_path === "string" && event.transcript_path
      && typeof event.session_id === "string" && event.session_id) {
      spawnDetached(findNode(), [
        path.join(SCRIPTS_DIR, "extract.mjs"), "--transcript", event.transcript_path,
        "--session", event.session_id, "--then-run-if-due", "--quiet",
      ]);
    }
  }
} catch {
  // Fail-safe: capture must never affect the Stop or SessionEnd event.
}
clearTimeout(timer);
process.exit(0);
