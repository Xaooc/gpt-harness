#!/usr/bin/env node
// PreToolUse guards: budget pytest, stage shared-wrapper edits, and explain worktree hygiene.
// Only the hook process's HARNESS_GUARDS_OFF=1 disables these checks. Errors fail open and are logged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PYTEST_MESSAGE = "Run pytest through the gate: python3 ~/.claude/scripts/pytest_gate.py " +
  "-n K -- <args> (CLAUDE.md: Tests: a budget).";
const WRAPPER_MESSAGE = "Shared wrapper: write <file>.next, test it, then swap atomically (mv -f) " +
  "when idle — see the luna skill, Launch hygiene.";
const WORKTREE_MESSAGE = "Prefer node ~/.claude/scripts/disk/wt-new.mjs … (owner/purpose/until, " +
  "shared node_modules) for worktrees that outlive one command.";
const SHARED_WRAPPERS = ["luna.sh", "luna-daemon.mjs", "luna-pool.mjs", "luna-panel.sh"];
// Providers are chosen by the dispatcher from the Luna panel's chains and panels, never by naming a wrapper:
// a session calling gem.sh directly ran Gemini after the owner had taken it out of the flow (2026-11-17).
const DIRECT_PROVIDERS = new Set(["gem.sh", "gem-run.mjs"]);
const PROVIDER_MESSAGE = "Providers are chosen by the dispatcher from the Luna panel: run node ~/.claude/scripts/conveyor/" +
  "exec.mjs run --tier <tier> (or --panel <panel> --seat <n>) instead of gem.sh. For a one-off diagnostic only, " +
  "prefix the command with CONVEYOR_DIRECT_PROVIDER=1.";
const SHELL_PREFIXES = new Set("if then else elif fi do done while until ! { } ( ) time".split(" "));
const RUN_VALUE_OPTIONS = new Set([
  "--project", "--directory", "-C", "--python", "-p", "--with", "-w", "--with-editable",
  "--with-requirements", "--package", "--extra", "--group", "--no-group", "--only-group",
  "--index", "--default-index", "--index-url", "--extra-index-url", "--find-links", "-f",
  "--config-file", "--cache-dir", "--env-file", "--resolution", "--prerelease", "--link-mode",
]);

// Adapted from ~/.claude/scripts/heavy-gate.mjs: its tokenizer/prefix helpers are private.
// Keep command boundaries and quoted words; record unquoted redirection targets separately.
function commandSegments(command) {
  const segments = [];
  let words = [];
  let writes = [];
  let word = "";
  let quote = "";
  let started = false;
  let redirect = null;
  const finishWord = () => {
    if (started) {
      if (redirect === null) words.push(word);
      else if (redirect) writes.push(word);
      redirect = null;
    }
    word = "";
    started = false;
  };
  const finishSegment = () => {
    finishWord();
    if (words.length || writes.length) segments.push({ words, writes });
    words = [];
    writes = [];
    redirect = null;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (quote === '"' && char === "\\" && /["\\$`\n]/.test(command[i + 1] || "")) {
        const escaped = command[++i];
        if (escaped !== "\n") word += escaped;
      } else word += char;
    } else if (char === "\\") {
      if (command[i + 1] === "\n") i += 1;
      else if (i + 1 < command.length) {
        word += command[++i];
        started = true;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
    } else if (char === ">" || char === "<" || (char === "&" && command[i + 1] === ">")) {
      // A numeric word immediately before a redirect is a file descriptor, not an argument.
      if (/^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      finishWord();
      let operator = char;
      if (char === "&") operator += command[++i];
      if (command[i + 1] === operator.at(-1)) operator += command[++i];
      if (command[i + 1] === "&" || command[i + 1] === "|" ||
          (operator === "<" && command[i + 1] === ">")) operator += command[++i];
      redirect = operator.includes(">") && !operator.endsWith("&");
    } else if (char === ";" || char === "|" || char === "\n" || char === "&" || char === "(" || char === ")") {
      finishSegment();
      if (command[i + 1] === char && (char === "|" || char === "&")) i += 1;
    } else if (/\s/.test(char)) finishWord();
    else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Incomplete shell quoting");
  finishSegment();
  return segments;
}

function commandName(word = "") {
  return path.basename(word);
}

function stripCommandPrefixes(input) {
  const words = [...input];
  while (words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || SHELL_PREFIXES.has(words[0])) {
      words.shift();
      continue;
    }
    const name = commandName(words[0]);
    if (name === "env") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) words.shift();
      }
      continue;
    }
    if ((name === "uv" || name === "poetry") && words[1] === "run") {
      words.splice(0, 2);
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (option === "--") break;
        if (RUN_VALUE_OPTIONS.has(option)) words.shift();
      }
      continue;
    }
    if (/^(python(?:\d+(?:\.\d+)*)?|py)$/.test(name)) {
      let i = 1;
      while (words[i]?.startsWith("-")) {
        if (words[i] === "-m") return words[i + 1] === "pytest" ? words.slice(i + 1) : words;
        if (words[i] === "-c" || words[i] === "--") break;
        if (["-W", "-X", "--check-hash-based-pycs"].includes(words[i])) i += 1;
        i += 1;
      }
    }
    if (name === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(words[1] || "")) {
      words.splice(0, 2);
      continue;
    }
    if (name === "nice") {
      words.shift();
      if (words[0] === "-n" || words[0] === "--adjustment") words.splice(0, 2);
      else if (/^(--adjustment=|-\d)/.test(words[0] || "")) words.shift();
      continue;
    }
    if (name === "command" && !words.slice(1).some((word) => /^-[vV]$/.test(word))) {
      words.shift();
      while (["--", "-p"].includes(words[0])) words.shift();
      continue;
    }
    break;
  }
  return words;
}

function expandPath(file, cwd, home) {
  return path.resolve(cwd, file.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home));
}

function realPath(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realPath(parent), path.basename(file));
  }
}

function sharedMatcher(home) {
  const shared = new Set(SHARED_WRAPPERS.map((name) => realPath(path.join(home, ".claude", "scripts", name))));
  const cache = new Map();
  return (file, cwd) => {
    if (typeof file !== "string" || !file) return false;
    const absolute = expandPath(file, cwd, home);
    if (!cache.has(absolute)) cache.set(absolute, shared.has(realPath(absolute)));
    return cache.get(absolute);
  };
}

function operands(args, valueOptions) {
  const files = [];
  let target;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-t" || arg === "--target-directory") target = args[++i];
    else if (arg.startsWith("--target-directory=")) target = arg.slice("--target-directory=".length);
    else if (arg.startsWith("-t") && arg.length > 2) target = arg.slice(2);
    else if (valueOptions.includes(arg)) i += 1;
    else if (!arg.startsWith("-")) files.push(arg);
  }
  return { files, target };
}

function writesShared(name, args, cwd, home, isShared) {
  const matches = (file) => isShared(file, cwd);
  if ((name === "sed" || name === "perl") && args.some((arg) => /^-[^-]*i|^--in-place(?:=|$)/.test(arg))) {
    return args.some(matches);
  }
  if (name === "tee") return args.some((arg) => !arg.startsWith("-") && matches(arg));
  if (name === "dd") return args.some((arg) => arg.startsWith("of=") && matches(arg.slice(3)));
  if (name === "truncate") {
    return operands(args, ["-s", "--size", "-r", "--reference"]).files.some(matches);
  }
  if (name !== "cp" && name !== "install") return false;
  const valueOptions = ["-S", "--suffix"];
  if (name === "install") valueOptions.push("-m", "--mode", "-o", "--owner", "-g", "--group");
  const { files, target } = operands(args, valueOptions);
  const destination = target ?? files.pop();
  if (!destination) return false;
  if (matches(destination)) return true;
  const directory = expandPath(destination, cwd, home);
  try {
    if (!fs.statSync(directory).isDirectory()) return false;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
  return files.some((file) => isShared(path.join(directory, path.basename(file)), cwd));
}

function addsWorktree(args) {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    if (["--help", "-h", "--version"].includes(args[i])) return false;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(args[i])) i += 1;
    i += 1;
  }
  return args[i] === "worktree" && args[i + 1] === "add";
}

function inspectCommand(command, cwd, home, isShared) {
  let warning = false;
  for (const segment of commandSegments(command)) {
    if (segment.writes.some((file) => isShared(file, cwd))) return { block: WRAPPER_MESSAGE };
    const [executable, ...args] = stripCommandPrefixes(segment.words);
    const name = commandName(executable);
    if (name === "pytest" || name === "py.test") {
      const end = args.indexOf("--");
      const options = end < 0 ? args : args.slice(0, end);
      if (!options.some((arg) => /^(--version|--help|-h)$/.test(arg))) return { block: PYTEST_MESSAGE };
    }
    if (writesShared(name, args, cwd, home, isShared)) return { block: WRAPPER_MESSAGE };
    const launched = /^(bash|sh|dash|zsh|node)$/.test(name) ? commandName(args.find((arg) => !arg.startsWith("-"))) : name;
    if (DIRECT_PROVIDERS.has(launched) && !segment.words.includes("CONVEYOR_DIRECT_PROVIDER=1")) {
      return { block: PROVIDER_MESSAGE };
    }
    if (/^(bash|sh|dash|zsh)$/.test(name)) {
      const index = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (index >= 0 && typeof args[index + 1] === "string") {
        const nested = inspectCommand(args[index + 1], cwd, home, isShared);
        if (nested.block) return nested;
        warning ||= nested.warning;
      }
    }
    if (name === "git" && addsWorktree(args)) warning = true;
    if (name === "cd") {
      const directory = args[0] === "--" ? args[1] : args[0];
      if (directory !== "-") cwd = expandPath(directory ?? home, cwd, home);
    }
  }
  return { warning };
}

function main() {
  if (process.env.HARNESS_GUARDS_OFF === "1") return;
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!["Bash", "Write", "Edit", "MultiEdit"].includes(payload?.tool_name)) return;
  const input = payload.tool_input || {};
  const home = os.homedir();
  const cwd = payload.cwd || process.cwd();
  const isShared = sharedMatcher(home);
  let result;
  if (payload.tool_name === "Bash") {
    if (typeof input.command !== "string") return;
    result = inspectCommand(input.command, cwd, home, isShared);
  } else {
    result = { block: isShared(input.file_path || input.filePath, cwd) ? WRAPPER_MESSAGE : null };
  }
  if (result.block) {
    process.stderr.write(`${result.block}\n`);
    process.exitCode = 2;
  } else if (result.warning) {
    process.stdout.write(`${JSON.stringify({ systemMessage: WORKTREE_MESSAGE })}\n`);
  }
}

try { main(); }
catch (error) {
  process.exitCode = 0;
  try {
    const directory = path.join(os.homedir(), ".claude", "logs");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const message = String(error?.message || error).replace(/[\r\n]+/g, " ");
    fs.appendFileSync(path.join(directory, "harness-guards.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { /* Logging failures must also fail open. */ }
}
