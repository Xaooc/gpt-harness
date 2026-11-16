import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDigest, resolvePstack } from "../luna-skill-autoload.mjs";

const HOOK_PATH = fileURLToPath(
  new URL("../luna-skill-autoload.mjs", import.meta.url)
);

test("two cached versions 0.15.42-bro.1 and 0.15.42-bro.2: newest chosen and populates digest", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-test-cache-"));
  try {
    const cacheBase = path.join(
      tempHome,
      ".claude",
      "plugins",
      "cache",
      "luna-local",
      "pstack"
    );
    const v1Dir = path.join(cacheBase, "0.15.42-bro.1");
    const v2Dir = path.join(cacheBase, "0.15.42-bro.2");

    for (const [dir, ver] of [
      [v1Dir, "0.15.42-bro.1"],
      [v2Dir, "0.15.42-bro.2"],
    ]) {
      fs.mkdirSync(path.join(dir, "skills", "poteto-mode"), { recursive: true });
      fs.mkdirSync(path.join(dir, "docs", "harness"), { recursive: true });
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "skills", "poteto-mode", "SKILL.md"),
        "# Poteto Mode"
      );
      fs.writeFileSync(
        path.join(dir, "docs", "harness", "bro-harness.md"),
        "# Bro Harness"
      );
      fs.writeFileSync(
        path.join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "pstack", version: ver })
      );
    }

    const resolved = resolvePstack(tempHome);
    const expected = path.resolve(v2Dir);
    assert.equal(resolved, expected);

    const digest = buildDigest(resolved);
    assert.equal(digest.includes("{{PSTACK}}"), false);
    const occurrences = digest.split(resolved).length - 1;
    assert.equal(occurrences, 4);

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, digest);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("no cache, local-plugins copy present: resolves local-plugins path", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-test-local-"));
  try {
    const localDir = path.join(tempHome, ".claude", "local-plugins", "pstack");
    fs.mkdirSync(path.join(localDir, "skills", "poteto-mode"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(localDir, "docs", "harness"), { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "skills", "poteto-mode", "SKILL.md"),
      "# Poteto Mode"
    );
    fs.writeFileSync(
      path.join(localDir, "docs", "harness", "bro-harness.md"),
      "# Bro Harness"
    );

    const resolved = resolvePstack(tempHome);
    const expected = path.resolve(localDir);
    assert.equal(resolved, expected);

    const digest = buildDigest(resolved);
    assert.equal(digest.includes("{{PSTACK}}"), false);
    const occurrences = digest.split(resolved).length - 1;
    assert.equal(occurrences, 4);

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, digest);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("nothing: resolves null, digest contains pstack is not installed and Executors", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-test-none-"));
  try {
    const resolved = resolvePstack(tempHome);
    assert.equal(resolved, null);

    const digest = buildDigest(resolved);
    assert.equal(digest.includes("pstack is not installed"), true);
    assert.equal(digest.includes("Executors"), true);
    assert.equal(digest.includes("{{PSTACK}}"), false);

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, digest);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("off-switch file present: prints nothing and exits 0", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-test-off-"));
  try {
    const claudeDir = path.join(tempHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "luna-autoload-off"), "");

    const localDir = path.join(claudeDir, "local-plugins", "pstack");
    fs.mkdirSync(path.join(localDir, "skills", "poteto-mode"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(localDir, "docs", "harness"), { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "skills", "poteto-mode", "SKILL.md"),
      "# Poteto Mode"
    );
    fs.writeFileSync(
      path.join(localDir, "docs", "harness", "bro-harness.md"),
      "# Bro Harness"
    );

    const res = spawnSync(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
