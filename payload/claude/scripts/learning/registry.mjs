import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { paths, toWinPath } from "./common.mjs";

export const TERMINAL_JOB_STATES = /^(?:done|incomplete|failed|stalled|killed|timeout)$/;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024 * 1024;
const registryCache = new Map();

function statusBytes(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_STATUS_BYTES) return null;
    const bytes = fs.readFileSync(file);
    return bytes.length <= MAX_STATUS_BYTES ? bytes : null;
  } catch { return null; }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function statusSha256(file) {
  try {
    const bytes = statusBytes(file);
    return bytes === null ? null : hashBytes(bytes);
  } catch { return null; }
}

export function recordJob(out, opts = {}) {
  try {
    if (typeof out !== "string" || !out || !path.isAbsolute(toWinPath(out))) return false;
    const file = path.resolve(toWinPath(out));
    const bytes = statusBytes(`${file}.status`);
    if (bytes === null) return false;
    const sha = hashBytes(bytes);
    const values = Object.create(null);
    for (const line of bytes.toString("utf8").replace(/^\uFEFF/u, "").split(/\r?\n/)) {
      const equals = line.indexOf("=");
      if (equals > 0) values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
    }
    if (!TERMINAL_JOB_STATES.test(values.state || "")) return false;
    const registry = opts.registry ?? paths.jobs;
    if (!fs.existsSync(path.dirname(registry))) return false;
    const record = {
      v: 1,
      out: toWinPath(file).replace(/^([a-z]):/i, (_, drive) => `${drive.toUpperCase()}:`),
      status_sha256: sha,
      started: values.started ?? "",
      finished: values.finished ?? "",
      state: values.state,
      model: values.model ?? "",
      pid: values.pid ?? "",
    };
    fs.appendFileSync(registry, JSON.stringify(record) + "\n");
    return true;
  } catch { return false; }
}

// Status-only jobs resolve missing output leaves through their nearest existing ancestor.
function canonicalPath(file) {
  const resolved = path.resolve(toWinPath(file));
  try { return fs.realpathSync(resolved); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (fs.existsSync(path.dirname(resolved)) && fs.lstatSync(resolved, { throwIfNoEntry: false })) throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(canonicalPath(parent), path.basename(resolved));
  }
}

export function normaliseJobOut(p) {
  try {
    if (typeof p !== "string" || !path.isAbsolute(toWinPath(p))) return null;
    const canonical = canonicalPath(p).replace(/\\/g, "/");
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch { return null; }
}

export function loadJobRegistry(file = paths.jobs) {
  const records = new Map();
  try {
    file = path.resolve(toWinPath(file));
    const info = fs.statSync(file);
    const cached = registryCache.get(file);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ino === info.ino) {
      return cached.records;
    }
    const start = Math.max(0, info.size - MAX_REGISTRY_BYTES);
    const bytes = Buffer.alloc(Math.min(info.size, MAX_REGISTRY_BYTES));
    const descriptor = fs.openSync(file, "r");
    let length = 0;
    try {
      while (length < bytes.length) {
        const read = fs.readSync(descriptor, bytes, length, bytes.length - length, start + length);
        if (!read) break;
        length += read;
      }
    } finally { fs.closeSync(descriptor); }
    const text = bytes.subarray(0, length).toString("utf8");
    const firstLine = start ? text.indexOf("\n") : -1;
    const tail = start ? (firstLine < 0 ? "" : text.slice(firstLine + 1)) : text;
    for (const line of tail.split(/\r?\n/)) {
      if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_STATUS_BYTES) continue;
      try {
        const record = JSON.parse(line.replace(/^\uFEFF/u, ""));
        if (!record || typeof record !== "object" || Array.isArray(record) || record.v !== 1
          || typeof record.out !== "string" || !path.isAbsolute(toWinPath(record.out))
          || typeof record.status_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.status_sha256)
          || typeof record.state !== "string" || !TERMINAL_JOB_STATES.test(record.state)) continue;
        const out = normaliseJobOut(record.out);
        if (out === null) continue;
        if (!records.has(out)) records.set(out, new Set());
        records.get(out).add(record.status_sha256);
      } catch { /* Ignore malformed records. */ }
    }
    registryCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, records });
  } catch { registryCache.delete(file); }
  return records;
}

export function registryHas(out, sha, file = paths.jobs) {
  try {
    const key = normaliseJobOut(out);
    return key !== null && loadJobRegistry(file).get(key)?.has(sha) === true;
  } catch { return false; }
}

try {
  if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    if (process.argv[2] === "record") recordJob(process.argv[3]);
  }
} catch { /* Wrapper calls must stay silent and successful. */ }
