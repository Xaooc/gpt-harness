import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_PATH = fileURLToPath(new URL("../harness-guards.mjs", import.meta.url));
const PYTEST_MESSAGE = "Run pytest through the gate: python3 ~/.claude/scripts/pytest_gate.py " +
  "-n K -- <args> (CLAUDE.md: Tests: a budget).";
const WRAPPER_MESSAGE = "Shared wrapper: write <file>.next, test it, then swap atomically (mv -f) " +
  "when idle — see the luna skill, Launch hygiene.";
const WORKTREE_MESSAGE = "Prefer node ~/.claude/scripts/disk/wt-new.mjs … (owner/purpose/until, " +
  "shared node_modules) for worktrees that outlive one command.";
const BARE_PYTEST = [
  "pytest -q tests/x.py",
  "uv run pytest",
  "bash -c 'cd a && python -m pytest -x'",
  "ls; pytest",
];

function fixture(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guards-test-"));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  return tempHome;
}

function bash(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

function runHook(tempHome, payload, overrides = {}) {
  const env = { ...process.env, HOME: tempHome };
  delete env.HARNESS_GUARDS_OFF;
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    env: { ...env, ...overrides },
    input: typeof payload === "string" ? payload : JSON.stringify({ cwd: tempHome, ...payload }),
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertBlocked(result, message) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${message}\n`);
}

function assertAllowed(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function wrapperRequests(tempHome) {
  return {
    blocked: [
      { tool_name: "Write", tool_input: { file_path: path.join(tempHome, ".claude", "scripts", "luna.sh") } },
      bash("sed -i s/a/b/ ~/.claude/scripts/luna.sh"),
      bash("echo x >> ~/.claude/scripts/luna-pool.mjs"),
    ],
    allowed: [
      { tool_name: "Write", tool_input: { file_path: path.join(tempHome, ".claude", "scripts", "luna.sh.next") } },
      bash("mv -f ~/.claude/scripts/luna.sh.next ~/.claude/scripts/luna.sh"),
      bash("cat ~/.claude/scripts/luna.sh"),
    ],
  };
}

test("R1 blocks bare pytest commands, runners, nested shells, and command lists", (t) => {
  const tempHome = fixture(t);
  for (const command of BARE_PYTEST) assertBlocked(runHook(tempHome, bash(command)), PYTEST_MESSAGE);
});

test("R1 allows the gate, version queries, and pytest appearing only as an argument", (t) => {
  const tempHome = fixture(t);
  const commands = [
    "python3 ~/.claude/scripts/pytest_gate.py -n 2 -- -q tests/x.py",
    "pytest --version",
    "rg pytest src",
    'git commit -m "fix pytest"',
    "echo pytest",
  ];
  for (const command of commands) assertAllowed(runHook(tempHome, bash(command)));
});

test("R2 blocks direct wrapper writes and allows staging, atomic swaps, and reads", (t) => {
  const tempHome = fixture(t);
  const requests = wrapperRequests(tempHome);
  for (const payload of requests.blocked) assertBlocked(runHook(tempHome, payload), WRAPPER_MESSAGE);
  for (const payload of requests.allowed) assertAllowed(runHook(tempHome, payload));
});

test("R3 warns about bare git worktree add and allows wt-new.mjs silently", (t) => {
  const tempHome = fixture(t);
  const result = runHook(tempHome, bash("git worktree add ../x -b y"));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { systemMessage: WORKTREE_MESSAGE });
  assertAllowed(runHook(tempHome, bash("node ~/.claude/scripts/disk/wt-new.mjs ../x -b y")));
});

test("the hook environment can disable all guards, and malformed stdin fails open", (t) => {
  const tempHome = fixture(t);
  const requests = [
    ...BARE_PYTEST.map(bash),
    ...wrapperRequests(tempHome).blocked,
    bash("git worktree add ../x -b y"),
  ];
  for (const payload of requests) assertAllowed(runHook(tempHome, payload, { HARNESS_GUARDS_OFF: "1" }));
  assertAllowed(runHook(tempHome, "{"));
  const log = fs.readFileSync(path.join(tempHome, ".claude", "logs", "harness-guards.log"), "utf8");
  assert.equal(log.trim().split("\n").length, 1);
});
