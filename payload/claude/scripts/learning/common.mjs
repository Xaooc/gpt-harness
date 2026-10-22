import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HOME_CLAUDE = process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), ".claude");
export const LEARN_DIR = process.env.CLAUDE_LEARNING_DIR || path.join(HOME_CLAUDE, "learning");
export const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));

export const paths = Object.freeze({
  events: path.resolve(LEARN_DIR, "events.jsonl"),
  eventsOld: path.resolve(LEARN_DIR, "events.1.jsonl"),
  jobs: path.resolve(LEARN_DIR, "jobs.jsonl"),
  extractState: path.resolve(LEARN_DIR, "extract-state.json"),
  loopState: path.resolve(LEARN_DIR, "loop-state.json"),
  config: path.resolve(LEARN_DIR, "config.json"),
  adoptedJsonl: path.resolve(LEARN_DIR, "adopted.jsonl"),
  adoptedMd: path.resolve(LEARN_DIR, "adopted.md"),
  candidates: path.resolve(LEARN_DIR, "candidates.jsonl"),
  needsUser: path.resolve(LEARN_DIR, "needs-user.md"),
  logMd: path.resolve(LEARN_DIR, "log.md"),
  reportsDir: path.resolve(LEARN_DIR, "reports"),
  runsDir: path.resolve(LEARN_DIR, "runs"),
  backupsDir: path.resolve(LEARN_DIR, "backups"),
  locksDir: path.resolve(LEARN_DIR, "locks"),
  paused: path.resolve(LEARN_DIR, "PAUSED"),
  captureOff: path.resolve(LEARN_DIR, "CAPTURE_OFF"),
});

export function ensureDirs() {
  for (const dir of [LEARN_DIR, paths.reportsDir, paths.runsDir, paths.backupsDir, paths.locksDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStale(dir, staleMs) {
  const owner = readJson(path.join(dir, "owner.json"), null);
  const started = Date.parse(owner?.started);
  if (Number.isFinite(started)) return Date.now() - started > staleMs;
  return Date.now() - fs.statSync(dir).mtimeMs > staleMs;
}

function releaseLock(dir, nonce) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      // A stale owner's release must not remove its successor's lock.
      if (readJson(path.join(dir, "owner.json"), null)?.nonce === nonce) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Hooks may release a lock that was already removed.
    }
  };
}

export function tryLock(name, staleMs) {
  const dir = path.join(paths.locksDir, name);
  try {
    ensureDirs();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(dir);
      } catch (error) {
        if (error.code !== "EEXIST" || attempt > 0 || !isStale(dir, staleMs)) return null;
        const staleDir = `${dir}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
        let renamed = false;
        try {
          fs.renameSync(dir, staleDir);
          renamed = true;
        } catch (takeoverError) {
          if (!["ENOENT", "EPERM", "EEXIST"].includes(takeoverError.code)) throw takeoverError;
        }
        if (renamed) {
          if (!isStale(staleDir, staleMs)) {
            try {
              fs.renameSync(staleDir, dir);
            } catch {
              // A contender may already own dir; preserve the fresh quarantined owner too.
            }
            return null;
          }
          fs.rmSync(staleDir, { recursive: true, force: true });
        }
        continue;
      }
      const nonce = randomBytes(16).toString("hex");
      const ownerText = JSON.stringify({ pid: process.pid, host: os.hostname(), started: nowIso(), nonce });
      try {
        fs.writeFileSync(path.join(dir, "owner.json"), ownerText);
      } catch (error) {
        const owner = readJson(path.join(dir, "owner.json"), null);
        if (!owner || owner.nonce === nonce) fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return releaseLock(dir, nonce);
    }
  } catch {
    return null;
  }
  return null;
}

export function withLock(name, opts, fn) {
  const { staleMs = 600000, waitMs = 0, pollMs = 200 } = opts || {};
  const deadline = performance.now() + waitMs;
  let release = tryLock(name, staleMs);
  while (!release && performance.now() < deadline) {
    sleep(Math.min(Math.max(1, pollMs), deadline - performance.now()));
    if (performance.now() >= deadline) break;
    release = tryLock(name, staleMs);
  }
  if (!release) return { locked: false };
  try {
    return { locked: true, value: fn() };
  } finally {
    release();
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (error) {
        if (attempt >= 5 || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        sleep(50);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Rename consumes the temporary file; failed writes also need cleanup.
    }
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + "\n");
}

export function appendJsonl(file, objOrArray) {
  const objects = Array.isArray(objOrArray) ? objOrArray : [objOrArray];
  if (objects.length === 0) return;
  fs.appendFileSync(file, objects.map((obj) => JSON.stringify(obj) + "\n").join(""), "utf8");
}

export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const objects = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const obj = JSON.parse(line);
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) objects.push(obj);
    } catch {
      // Concurrent appends or interrupted writes can leave an incomplete line.
    }
  }
  return objects;
}

export function loadEvents(opts = {}) {
  const seen = new Set();
  return [...readJsonl(paths.eventsOld), ...readJsonl(paths.events)].filter((event) => {
    if (opts.sinceIso !== undefined && !(event.ts >= opts.sinceIso)) return false;
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export function sanitizeQuote(text, max = 400) {
  if (typeof text !== "string") return "";
  try {
    let clean = text
      .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\s*>/gi, "[pasted]")
      .replace(/<system-reminder\s*>[\s\S]*?<\/system-reminder\s*>/gi, "")
      .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/g, " ")
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
      .replace(/xox[abpr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
      .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim();
    const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 400;
    if (limit === 0) return "";
    if (clean.length > limit) clean = clean.slice(0, limit - 1) + "…";
    return clean;
  } catch {
    return "";
  }
}

export function eventId(...parts) {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function toWinPath(p) {
  if (typeof p !== "string" || !p) return "";
  let result = p.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\\/g, "/");
  if (result === "~" || result.startsWith("~/")) {
    result = os.homedir().replace(/\\/g, "/") + result.slice(1);
  } else if (result.startsWith("$HOME/") || result.startsWith("${HOME}/")) {
    result = os.homedir().replace(/\\/g, "/") + result.replace(/^\$(?:HOME|\{HOME\})/, "");
  }
  return result.replace(/^\/([a-z])(?=\/|$)/i, (_, drive) => `${drive.toUpperCase()}:`);
}

export function findBash() {
  for (const file of ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"]) {
    if (fs.existsSync(file)) return file;
  }
  return "bash";
}

export function findNode() {
  return process.execPath;
}

export function spawnDetached(cmd, args, opts) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, ...opts });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

export function isPaused() {
  return fs.existsSync(paths.paused);
}

export function isCaptureOff() {
  return fs.existsSync(paths.captureOff);
}
