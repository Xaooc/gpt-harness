import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  HOME_CLAUDE, LEARN_DIR, SCRIPTS_DIR, paths, ensureDirs, nowIso, tryLock, withLock,
  readJson, writeJsonAtomic, appendJsonl, loadEvents, sanitizeQuote, eventId, toWinPath,
  spawnDetached, findNode, sha256, canonicalJson, readJsonl,
} from "./common.mjs";
import { normaliseJobOut, registryHas, statusSha256 } from "./registry.mjs";

const LEFT = "(?<![\\p{L}\\p{N}])";
const RIGHT = "(?![\\p{L}\\p{N}])";
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const ACTIVE_STATES = /^(?:starting|queued|waiting-daemon|waiting-ram|waiting-lock|running)$/;
const TERMINAL_STATES = /^(?:done|incomplete|failed|stalled|killed|timeout|abandoned)$/;
const ABANDONED_MS = 3 * 60 * 60 * 1000;
const pattern = (name, body, start = false) => [name, new RegExp((start ? "^" : LEFT) + body + RIGHT, "iu")];
const corrections = [
  pattern("ru_start", "(?:нет|не так|неправильно|неверно|стоп|подожди|погоди)", true),
  ...[
    ["ru_not_that", "не то"], ["ru_i_already", "я же (?:сказал|говорил|просил)"],
    ["ru_i_asked", "я просил"], ["ru_why", "(?:зачем|почему) ты"],
    ["ru_you", "ты (?:опять|снова|не)"], ["ru_dont", "не (?:надо|нужно|делай)"],
    ["ru_stop", "(?:перестань|хватит)"], ["ru_revert", "(?:откати|верни как было)"],
    ["ru_broken", "(?:сломал|не работает)"], ["ru_still", "вс[её] ещ[её]"],
    ["ru_missed", "(?:не заметил|ты забыл|не туда|не тот)"],
  ].map(([name, body]) => pattern(name, body)),
  pattern("en_start", "(?:no|nope|wrong|stop|wait)", true),
  ...[
    ["en_not_that", "(?:that's not|that is not)"], ["en_i_asked", "i (?:said|told you|asked)"],
    ["en_why", "why did you"], ["en_you", "you (?:didn't|did not|forgot|broke|keep|missed)"],
    ["en_dont", "(?:don't|do not|stop doing)"], ["en_revert", "(?:revert|undo)"],
    ["en_still", "still (?:broken|not|failing)"], ["en_not_requested", "not what i"],
  ].map(([name, body]) => pattern(name, body)),
];
const rules = [
  ["ru_always", "всегда"], ["ru_never", "никогда"], ["ru_remember", "запомни"],
  ["ru_future", "(?:впредь|с этого момента)"], ["ru_default", "по умолчанию"],
  ["ru_every_time", "каждый раз"], ["ru_required", "обязательно"], ["en_always", "always"],
  ["en_never", "never"], ["en_future", "from now on"], ["en_remember", "remember"],
  ["en_default", "by default"], ["en_every_time", "every time"], ["en_required", "make sure to"],
].map(([name, body]) => pattern(name, body));
const frustrations = [
  ["ru_again", "(?:опять|снова)"], ["ru_how_many", "сколько (?:раз|можно)"],
  ["ru_swear", "(?:блин|бля|сука)"], ["en_swear", "(?:wtf|ffs)"], ["en_again", "again"],
].map(([name, body]) => pattern(name, body));
const within = (start, distance, end) => start + RIGHT + `[\\s\\S]{0,${distance}}` + LEFT + end;
const explicitPatterns = [
  ["ru_you_always", within("(?:ты|тебе|себе|за собой)", 40, "(?:всегда|никогда)" + RIGHT)],
  ["ru_always_do", within("(?:всегда|никогда|впредь|с этого момента|каждый раз)", 30,
    "(?:делай|прогоняй|запускай|проверяй|используй|спрашивай|пиши|чисти|убирай|удаляй|сохраняй|коммить|"
    + "тестируй|смотри|думай|отвечай|сообщай|не )")],
  ["ru_remember", "запомни" + RIGHT],
  ["ru_told_you", "(?:я же (?:сказал|говорил|просил)|сколько раз|ты (?:опять|снова)|(?:опять|снова) ты)"
    + RIGHT],
  ["en_you_always", within("(?:you|yourself)", 40, "(?:always|never)" + RIGHT)],
  ["en_always_do", within("(?:always|never|from now on|every time)", 30,
    "(?:run|use|ask|check|test|write|clean|commit|delete|keep|do not|don't|make sure)" + RIGHT)],
  ["en_told_you", "(?:i told you|how many times|you keep)" + RIGHT],
].map(([name, body]) => [name, new RegExp(LEFT + body, "iu")]);

export function classifyUserText(text) {
  if (typeof text !== "string" || text.length > 1500 || text.length < 2) return null;
  const clean = sanitizeQuote(text, 1501);
  if (clean.length < 2 || clean.length > 1500) return null;
  const sample = clean.slice(0, 600);
  const hits = (patterns) => patterns.filter(([, regex]) => regex.test(sample)).map(([name]) => name);
  const correction = hits(corrections);
  const rule = hits(rules);
  const frustration = hits(frustrations);
  // Preserve line boundaries through the shared whitespace-collapsing sanitizer.
  const explicitText = sanitizeQuote(text.replace(/\r\n?|\n/g, "\0"), 1501).replace(/\0/g, "\n")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`]*(?:`|$)/g, " ")
    .replace(/^\s*>[^\n]*/gm, " ")
    .replace(/«[^»]*»|“[^”]*”|"[^"]{8,}"/g, " ")
    .replace(/(?<![^\s([{:;,])(?:'[^']{8,}'|‘[^’]{8,}’)/g, " ")
    .replace(/\[pasted\]/gi, " ");
  const sentences = explicitText.match(/[^.!?\n]+[.!?\n]?/g) || [];
  const explicit = clean.length <= 600 ? explicitPatterns.filter(([, regex]) => sentences.some((sentence) => {
    return !sentence.trimEnd().endsWith("?") && regex.test(sentence);
  })).map(([name]) => name) : [];
  if (sample.includes("!!")) frustration.push("exclamation");
  const letters = sample.match(/\p{L}/gu) || [];
  if (letters.length >= 12 && letters.filter((letter) => /\p{Lu}/u.test(letter)).length / letters.length >= 0.6) {
    frustration.push("uppercase");
  }
  const matched = [...new Set([...correction, ...rule, ...frustration, ...explicit])];
  if (!matched.length) return null;
  return {
    kind: rule.length ? "rule" : correction.length ? "correction" : "frustration",
    explicit: explicit.length > 0,
    matched,
  };
}

function key(file) {
  return toWinPath(path.resolve(toWinPath(file)));
}

// Resolve missing output leaves through their nearest existing ancestor (status-only jobs are valid).
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

function under(root, file) {
  const compare = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(compare(root), compare(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

// Test overrides: { tmp: <temporary base>, lunaRun: <luna-run directory>, registry: <jobs.jsonl> }.
export function isTrustedJobPath(p, roots = {}) {
  try {
    if (typeof p !== "string" || !path.isAbsolute(toWinPath(p))) return false;
    const file = canonicalPath(p);
    if (under(canonicalPath(LEARN_DIR), file) || file === canonicalPath(LEARN_DIR)) return false;
    if (under(canonicalPath(roots.lunaRun ?? path.join(HOME_CLAUDE, "luna-run")), file)) return true;
    const base = canonicalPath(path.join(roots.tmp ?? os.tmpdir(), "claude"));
    if (!under(base, file)) return false;
    const parts = path.relative(base, file).split(path.sep);
    return parts.length >= 4 && (process.platform === "win32" ? parts[2].toLowerCase() : parts[2])
      === "scratchpad";
  } catch { return false; }
}

export function isTrustedJob(out, roots = {}) {
  try {
    if (isTrustedJobPath(out, roots)) return true;
    if (typeof out !== "string" || !path.isAbsolute(toWinPath(out))) return false;
    const file = canonicalPath(out);
    const learn = canonicalPath(LEARN_DIR);
    if (under(learn, file) || path.relative(learn, file) === "") return false;
    const sha = statusSha256(`${file}.status`);
    if (sha === null) return false;
    return registryHas(file, sha, roots.registry ?? paths.jobs);
  } catch { return false; }
}

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

export function entryText(entry) {
  return textOf(entry?.message?.content ?? entry?.content);
}

export function isGenuineHumanEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const content = entry.message?.content ?? entry.content;
  const text = entryText(entry);
  if (entry.type !== "user" || entry.isSidechain || entry.isMeta) return false;
  if (typeof content !== "string" && !Array.isArray(content)) return false;
  if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return false;
  if (entry.origin?.kind === "human" || entry.turnOrigin === "human") return true;
  if ("origin" in entry || "turnOrigin" in entry) return false;
  return !/^(?:<|This session is being continued|Caveat:)/u.test(text.trim());
}

function resolvedArgument(raw, command, position, cwd) {
  let value = raw;
  const assignments = new Map();
  const assignment = /(?:^|\n)\s*(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;]+))/g;
  for (const match of command.slice(0, position).matchAll(assignment)) {
    assignments.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  value = value.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (whole, braced, bare) => {
    return assignments.get(braced ?? bare) ?? whole;
  });
  value = toWinPath(value);
  // $(...) is allowed as a literal filename (never evaluated). Unresolved variables are not.
  if (/\$(?!\()|`/.test(value) || !value) return null;
  return key(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function discover(command, cwd, state, meta) {
  if (typeof command !== "string" || !/(?:luna\.sh|luna-panel\.sh|luna-pool\.mjs)/.test(command)) return;
  const add = (raw, position, directory = false) => {
    const resolved = resolvedArgument(raw, command, position, cwd);
    if (!resolved) return;
    const out = directory ? `${resolved}/*` : resolved;
    if (!state.outs[out]) state.outs[out] = { ...meta, done: false };
  };
  for (const match of command.matchAll(/(?:^|\s)-o\s+(?:"([^"\n]*)"|'([^'\n]*)'|([^\s]+))/g)) {
    add(match[1] ?? match[2] ?? match[3], match.index);
  }
  const panel = /luna-panel\.sh["']?\s+(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;]+))/g;
  for (const match of command.matchAll(panel)) add(match[1] ?? match[2] ?? match[3], match.index, true);
}

// common.withLock is synchronous: keep its tryLock ownership across stream awaits locally.
async function withExtractLock(fn) {
  const release = tryLock("extract", 10 * 60 * 1000);
  if (!release) return { locked: false };
  try { return { locked: true, value: await fn() }; } finally { release(); }
}

async function* transcriptLines(file, offset = 0) {
  let fragments = [];
  let length = 0;
  let byte = offset;
  for await (const chunk of fs.createReadStream(file, { start: offset })) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const stop = end === -1 ? chunk.length : end;
      const fragment = chunk.subarray(start, stop);
      length += fragment.length;
      if (length > MAX_LINE_BYTES) fragments = [];
      else if (fragment.length) fragments.push(fragment);
      if (end === -1) break;
      const buffer = length > MAX_LINE_BYTES ? null : Buffer.concat(fragments, length);
      yield { buffer, byte, length };
      byte += length + 1;
      fragments = [];
      length = 0;
      start = end + 1;
    }
  }
  // A partial final line stays unread in the saved state until its newline arrives.
}

function transcriptSource(source) {
  const match = typeof source === "string" && /^(.*)#L([1-9]\d*)$/.exec(source);
  if (!match) throw new Error("invalid transcript source");
  const file = toWinPath(match[1]);
  if (!path.isAbsolute(file) || file.split("/").includes("..")) throw new Error("invalid transcript path");
  const projects = path.join(HOME_CLAUDE, "projects");
  const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const inside = (root, target) => {
    const relative = path.relative(comparable(root), comparable(target));
    if (path.isAbsolute(relative)) return false;
    const parts = relative.split(path.sep);
    return parts.length === 2 && !!parts[0] && parts[0] !== ".." && parts[1].endsWith(".jsonl");
  };
  if (!inside(path.resolve(projects), path.resolve(file))) throw new Error("source outside projects layout");
  const real = fs.realpathSync(file);
  if (!inside(fs.realpathSync(projects), real) || !fs.statSync(real).isFile()) {
    throw new Error("source outside real projects layout");
  }
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line)) throw new Error("invalid source line");
  return { file: real, line };
}

async function provenanceEntry(event) {
  const { file, line } = transcriptSource(event.source);
  const byte = event.data?.byte;
  if (byte !== undefined && (!Number.isSafeInteger(byte) || byte < 0)) throw new Error("invalid source byte");
  let count = 0;
  for await (const row of transcriptLines(file, byte === undefined ? 0 : Math.max(0, byte - 1))) {
    if (byte > 0 && count === 0) {
      if (row.length !== 0) throw new Error("source byte is not a line start");
      count++;
      continue;
    }
    count++;
    if (byte === undefined && count !== line) continue;
    if (!row.buffer) throw new Error("source line exceeds size cap");
    return { entry: JSON.parse(row.buffer.toString("utf8")), file, nextByte: row.byte + row.length + 1 };
  }
  throw new Error("source line not found");
}

function containsQuote(text, quote) {
  if (typeof quote !== "string") return false;
  const prefix = quote.endsWith("…") ? quote.slice(0, -1) : quote;
  const collapse = (value) => value.replace(/\s+/g, " ").trim();
  return !!collapse(prefix) && collapse(text).includes(collapse(prefix));
}

export function eventDigest(event) {
  const { captured, ...rest } = event;
  return sha256(canonicalJson(rest));
}

function hasRegisteredProvenance(event, out, jobRoots) {
  const sha = event.data?.status_sha256;
  if (!(event.data?.trusted === true && typeof sha === "string" && /^[0-9a-f]{64}$/i.test(sha)
    && isTrustedJob(out, jobRoots) && registryHas(out, sha, jobRoots?.registry ?? paths.jobs))) return false;
  const normalisedOut = normaliseJobOut(out);
  if (normalisedOut === null) return false;
  const digest = eventDigest(event);
  for (const file of [jobRoots?.attest ?? paths.attest, jobRoots?.attestOld ?? paths.attestOld]) {
    if (readJsonl(file).some((record) => record.id === event.id && record.type === event.type
      && normaliseJobOut(record.out) === normalisedOut && record.status_sha256 === sha
      && record.event_sha256 === digest)) return true;
  }
  return false;
}

export async function verifyEventProvenance(event, jobRoots) {
  try {
    if (["user_correction", "user_interrupt", "critic_synthesis"].includes(event?.type)) {
      const { entry, file, nextByte } = await provenanceEntry(event);
      const text = entryText(entry);
      if (event.type === "user_correction") {
        if (!isGenuineHumanEntry(entry)) throw new Error("source is not a genuine human entry");
        if (event.data?.uuid != null && entry.uuid !== event.data.uuid) throw new Error("uuid mismatch");
        if (!containsQuote(sanitizeQuote(text, text.length + 1), event.quote)) throw new Error("quote mismatch");
        const classification = classifyUserText(text);
        if (!classification || classification.explicit !== event.data?.explicit) {
          throw new Error("explicit classification mismatch");
        }
      } else if (event.type === "user_interrupt") {
        if (entry.type !== "user" || !text.includes("[Request interrupted by user")) {
          throw new Error("interrupt marker missing");
        }
        let quote = "";
        let found = false;
        for await (const row of transcriptLines(file, nextByte)) {
          if (!row.buffer) throw new Error("following line exceeds size cap");
          let next;
          try { next = JSON.parse(row.buffer.toString("utf8")); } catch { continue; }
          if (event.quote === "" && next?.type === "assistant") break;
          if (entryText(next).includes("[Request interrupted by user")) continue;
          if (!isGenuineHumanEntry(next)) continue;
          found = true;
          quote = sanitizeQuote(entryText(next), 400);
          break;
        }
        if (event.quote !== quote || (event.quote === "" && found)) throw new Error("interrupt quote mismatch");
      } else {
        const synthesis = synthesisOf(entry);
        if (!synthesis || event.quote !== synthesis.quote
          || event.data?.accepted !== synthesis.accepted || event.data?.rejected !== synthesis.rejected) {
          throw new Error("synthesis mismatch");
        }
      }
    } else if (event?.type === "luna_job") {
      const file = toWinPath(event.source);
      if (!file.endsWith(".status")) throw new Error("invalid status source");
      const out = file.slice(0, -7);
      let info, values;
      try {
        info = fs.statSync(file);
        if (!info.isFile()) throw new Error("invalid status source");
        values = parseStatus(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!hasRegisteredProvenance(event, out, jobRoots)) throw new Error("status file gone and not in registry");
        return { ok: true, reason: "verified" };
      }
      if (!isTrustedJob(out, jobRoots)) throw new Error("untrusted job path");
      const { data, quote } = statusData(out, values, info, jobRoots);
      if (!Object.hasOwn(event.data ?? {}, "status_sha256")) delete data.status_sha256;
      if (!TERMINAL_STATES.test(data.state || "") || event.data?.trusted !== true
        || !isDeepStrictEqual(data, event.data) || event.quote !== quote) {
        throw new Error("status mismatch");
      }
    } else if (["executor_assumption", "critic_output"].includes(event?.type)) {
      const file = toWinPath(event.data?.out_path);
      let text;
      try {
        if (!fs.statSync(file).isFile()) throw new Error("invalid output source");
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!hasRegisteredProvenance(event, file, jobRoots)) throw new Error("output file gone and not in registry");
        return { ok: true, reason: "verified" };
      }
      if (!isTrustedJob(file, jobRoots)) throw new Error("untrusted job path");
      if (event.data?.trusted !== true) throw new Error("trusted flag mismatch");
      // The hash is capture metadata; live outputs retain their existing content/state checks.
      const outputData = { ...event.data };
      delete outputData.status_sha256;
      if (event.type === "executor_assumption") {
        const source = /^(.*)#L([1-9]\d*)$/.exec(event.source || "");
        const line = source && text.split(/\r?\n/)[Number(source[2]) - 1];
        const quote = typeof line === "string" ? assumptionOf(line) : null;
        if (!source || toWinPath(source[1]) !== file || quote === null || quote !== event.quote) {
          throw new Error("assumption line mismatch");
        }
        const state = jobState(parseStatus(`${file}.status`), fs.statSync(`${file}.status`));
        if (!TERMINAL_STATES.test(state || "") || !isDeepStrictEqual(outputData, {
          out_path: file, job_state: state, trusted: true,
        })) throw new Error("assumption data mismatch");
      } else {
        const expected = criticOf(file, text, jobRoots);
        if (toWinPath(event.source) !== file || !hasCriticBrief(file)
          || !isDeepStrictEqual(outputData, expected.data) || event.quote !== expected.quote) {
          throw new Error("critic output mismatch");
        }
      }
    } else return { ok: false, reason: "unknown type" };
    return { ok: true, reason: "verified" };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function readTranscript(file, saved, state, emit, summary) {
  const info = fs.statSync(file);
  const session = path.basename(file, ".jsonl");
  const project = path.basename(path.dirname(file));
  if (saved.offset > info.size) {
    saved = { offset: 0, lines: 0, lastAssistant: "", pendingInterrupt: null };
  }
  Object.assign(saved, { session, project, size: info.size });
  saved.lines ??= 0;
  saved.offset ??= 0;
  saved.lastAssistant ??= "";
  saved.pendingInterrupt ??= null;
  const meta = { session, project };
  const interrupt = (quote = "") => {
    const pending = saved.pendingInterrupt;
    emit("user_interrupt", meta, `${file}#L${pending.line}`, quote, saved.lastAssistant,
      { uuid: pending.uuid ?? null, ...(pending.byte === undefined ? {} : { byte: pending.byte }) }, pending.ts);
    saved.pendingInterrupt = null;
  };
  const consume = (buffer, byte) => {
    saved.offset += buffer.length + 1;
    saved.lines++;
    let entry;
    try { entry = JSON.parse(buffer.toString("utf8")); } catch { return; }
    if (!entry || typeof entry !== "object") return;
    const content = entry.message?.content ?? entry.content;
    const text = entryText(entry);
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : nowIso();
    const uuid = typeof entry.uuid === "string" && entry.uuid.length ? entry.uuid : null;
    const source = `${file}#L${saved.lines}`;
    if (entry.type === "user" && text.includes("[Request interrupted by user")) {
      if (saved.pendingInterrupt) interrupt();
      saved.pendingInterrupt = { ts, line: saved.lines, uuid, byte };
      return;
    }
    if (isGenuineHumanEntry(entry)) {
      if (saved.pendingInterrupt) interrupt(text);
      const classification = classifyUserText(text);
      if (classification) {
        emit("user_correction", meta, source, text, saved.lastAssistant, { ...classification, uuid, byte }, ts);
      }
    }
    if (entry.type !== "assistant" || entry.isSidechain) return;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.name === "Bash") {
        discover(block.input?.command, entry.cwd || HOME_CLAUDE, state, meta);
      }
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const clean = sanitizeQuote(block.text, 300);
      if (clean) saved.lastAssistant = clean;
    }
    const synthesis = synthesisOf(entry);
    if (synthesis) {
      const { quote, accepted, rejected } = synthesis;
      emit("critic_synthesis", meta, source, quote, "", { uuid, byte, accepted, rejected }, ts);
    }
  };
  // Work in bytes so CRLF, split UTF-8 characters and a trailing partial JSON line retain exact offsets.
  if (saved.offset < info.size) {
    for await (const row of transcriptLines(file, saved.offset)) {
      if (row.buffer) consume(row.buffer, row.byte);
      else {
        saved.offset += row.length + 1;
        saved.lines++;
        summary.skipped_long_lines++;
      }
    }
  }
  if (saved.pendingInterrupt) interrupt();
  return saved;
}

function* walkStatuses(dir, depth = 0) {
  const normalized = key(dir);
  const learn = key(LEARN_DIR);
  if (normalized === learn || normalized.startsWith(`${learn}/`)) return;
  for (const entry of entries(dir)) {
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 6) yield* walkStatuses(file, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".status")) yield key(file);
  }
}

function scanRoots(jobRoots = {}) {
  const roots = [jobRoots.lunaRun ?? path.join(HOME_CLAUDE, "luna-run")];
  const base = path.join(jobRoots.tmp ?? os.tmpdir(), "claude");
  for (const project of entries(base).filter((entry) => entry.isDirectory())) {
    const dir = path.join(base, project.name);
    for (const session of entries(dir).filter((entry) => entry.isDirectory())) {
      roots.push(path.join(dir, session.name, "scratchpad"));
    }
  }
  return roots;
}

function statusMeta(file) {
  const parts = toWinPath(file).split("/");
  const scratch = parts.lastIndexOf("scratchpad");
  if (scratch >= 2) return { session: parts[scratch - 1], project: parts[scratch - 2] };
  return { session: "", project: parts.includes("luna-run") ? "luna-run" : "" };
}

function parseStatus(file) {
  const bytes = fs.readFileSync(file);
  const values = {};
  for (const line of bytes.toString("utf8").replace(/^\uFEFF/u, "").split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  values.status_sha256 = sha256(bytes);
  return values;
}

function jobState(values, info) {
  return ACTIVE_STATES.test(values.state || "") && Date.now() - info.mtimeMs > ABANDONED_MS
    ? "abandoned" : values.state;
}

function hasCriticBrief(out) {
  if (!out.endsWith(".out.md")) return false;
  const stem = path.basename(out, ".out.md");
  return ["", ".low", ".medium", ".high", ".xhigh", ".max"]
    .some((effort) => stat(path.join(path.dirname(out), `${stem}${effort}.brief.md`))?.isFile());
}

function synthesisOf(entry) {
  if (entry?.type !== "assistant" || entry.isSidechain) return null;
  const content = entry.message?.content ?? entry.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string"
      || !/(?:critic|критик|panel|панел)/iu.test(block.text)
      || !/(?:accepted|rejected|принят|отклон)/iu.test(block.text)) continue;
    return {
      accepted: (block.text.match(/accepted|принят\p{L}*/giu) || []).length,
      rejected: (block.text.match(/rejected|отклон\p{L}*/giu) || []).length,
      quote: sanitizeQuote(block.text.split(/\r?\n/)
        .filter((line) => /accepted|rejected|принят|отклон/iu.test(line)).slice(0, 5).join(" / "), 400),
    };
  }
  return null;
}

function assumptionOf(line) {
  const match = /^\s*(?:[-*]\s*)?(?:\*\*)?Assumption:(?:\*\*)?\s*(.+)$/i.exec(line);
  return match ? sanitizeQuote(match[1], 400) : null;
}

function criticOf(out, text, jobRoots) {
  const lines = text.split(/\r?\n/);
  const findings = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const match of text.matchAll(/\[(?:severity:\s*)?(critical|high|medium|low)\]/gi)) {
    findings[match[1].toLowerCase()]++;
  }
  const findingsText = [];
  for (const line of lines) {
    const match = /^\s*[-*]\s*\*\*\[(?:severity:\s*)?(critical|high|medium|low)\]\*\*\s*(.+)$/i.exec(line)
      || /^\s*[-*]\s*\*\*\[(?:severity:\s*)?(critical|high|medium|low)\]\s*(.+?)\*\*/i.exec(line);
    if (match) findingsText.push({ severity: match[1].toLowerCase(), title: sanitizeQuote(match[2], 200) });
    if (findingsText.length === 10) break;
  }
  const persona = path.basename(out, ".out.md").replace(/\.(?:low|medium|high|xhigh|max)$/i, "");
  return {
    quote: sanitizeQuote(lines.find((line) => /^Top concern:/i.test(line)) || "", 400),
    data: { persona, findings, findings_text: findingsText, out_path: out, trusted: isTrustedJob(out, jobRoots) },
  };
}

function statusData(out, values, info, jobRoots) {
  const currentState = jobState(values, info);
  const started = Date.parse(values.started);
  const finished = Date.parse(values.finished);
  const ts = Number.isFinite(finished) ? new Date(finished).toISOString() : info.mtime.toISOString();
  const numeric = (value) => /^-?\d+(?:\.\d+)?$/.test(value || "") ? Number(value) : value ?? "";
  const data = {
    state: currentState, finished: values.finished || "", rc: numeric(values.rc),
    model: values.model || "", effort: values.effort || "",
    sandbox: values.sandbox || "", retry: numeric(values.retry), refusal_suspected: values.refusal_suspected || "",
    missing: values.missing || "", error: sanitizeQuote(values.error || "", 400),
    elapsed_s: Number.isFinite(started) && Number.isFinite(finished) ? (finished - started) / 1000 : null,
    out_path: out, trusted: isTrustedJob(out, jobRoots),
    notable: currentState !== "done" || values.retry === "1" || values.refusal_suspected === "1" || !!values.missing,
    status_sha256: values.status_sha256,
  };
  return { data, quote: sanitizeQuote(values.error || "", 400), ts };
}

function captureStatus(out, meta, state, emit, jobRoots) {
  const file = `${out}.status`;
  const info = stat(file);
  if (!info?.isFile()) return false;
  const values = parseStatus(file);
  const { data, quote, ts } = statusData(out, values, info, jobRoots);
  const currentState = data.state;
  if (!TERMINAL_STATES.test(currentState || "")) return true;
  const idParts = ["luna_job", out, values.started || ""];
  if (currentState === "abandoned") idParts.push("abandoned");
  emit("luna_job", meta, file, quote, "", data, ts, eventId(...idParts));
  const outInfo = stat(out);
  if (outInfo?.isFile() && outInfo.size <= 300 * 1024) {
    const text = fs.readFileSync(out, "utf8");
    const lines = text.split(/\r?\n/);
    let assumptions = 0;
    for (const [index, line] of lines.entries()) {
      const assumption = assumptionOf(line);
      if (assumption === null || assumptions >= 20) continue;
      emit("executor_assumption", meta, `${out}#L${index + 1}`, assumption, "", {
        out_path: out, job_state: currentState, trusted: data.trusted, status_sha256: data.status_sha256,
      }, ts, eventId("executor_assumption", out, String(index + 1)));
      assumptions++;
    }
    if (hasCriticBrief(out)) {
      const critic = criticOf(out, text, jobRoots);
      critic.data.status_sha256 = data.status_sha256;
      emit("critic_output", meta, out, critic.quote, "", critic.data, ts, eventId("critic_output", out));
    }
  }
  state.outs[out].done = true;
  return true;
}

export async function extract(opts = {}) {
  const started = performance.now();
  const backfillDays = opts.backfillDays ?? 30;
  if (!Number.isFinite(backfillDays) || backfillDays < 0) throw new Error("Invalid backfillDays");
  ensureDirs();
  const result = await withExtractLock(async () => {
    const runTime = nowIso();
    const state = readJson(paths.extractState, null) || { v: 1, lastFullScan: null, files: {}, outs: {} };
    state.files ??= {};
    state.outs ??= {};
    const loaded = withLock("events", { waitMs: 5000 }, () => new Set(loadEvents().map((event) => event.id)));
    if (!loaded.locked) throw new Error("Events lock busy");
    const ids = loaded.value;
    const events = [];
    const summary = { skipped_long_lines: 0 };
    const emit = (type, meta, source, quote, context, data, ts, id = data.uuid
      ? eventId(type, "uuid", data.uuid) : eventId(type, meta.session, source)) => {
      if (ids.has(id)) return;
      ids.add(id);
      events.push({
        v: 1, id, type, ts, captured: nowIso(), session: meta.session || "", project: meta.project || "",
        source, quote: sanitizeQuote(quote, 400), context: sanitizeQuote(context, 300), data,
      });
    };
    const full = !opts.transcript;
    const firstFull = !state.lastFullScan;
    const cutoff = firstFull ? Date.now() - backfillDays * 86400000 : Date.parse(state.lastFullScan) - 3600000;
    const transcripts = [];
    if (!full) transcripts.push(key(opts.transcript));
    else {
      const projects = path.join(HOME_CLAUDE, "projects");
      for (const project of entries(projects)) {
        if (!project.isDirectory() || project.name === "subagents") continue;
        for (const entry of entries(path.join(projects, project.name))) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const file = key(path.join(projects, project.name, entry.name));
          const info = stat(file);
          if (!info) continue;
          if (info.mtimeMs < cutoff && !state.files[file] && firstFull) {
            state.files[file] = {
              offset: info.size, size: info.size, lines: 0, session: path.basename(file, ".jsonl"),
              project: project.name, lastAssistant: "", pendingInterrupt: null,
            };
          } else if (info.mtimeMs >= cutoff) transcripts.push(file);
        }
      }
    }
    transcripts.sort();
    for (const file of transcripts) {
      state.files[file] = await readTranscript(file, state.files[file] || {
        offset: 0, size: 0, lines: 0, lastAssistant: "", pendingInterrupt: null,
      }, state, emit, summary);
    }
    const selected = new Map();
    for (const [out, meta] of Object.entries(state.outs)) {
      if (meta.done) continue;
      const active = full || transcripts.some((file) => state.files[file].session === meta.session
        && state.files[file].project === meta.project);
      if (!active) continue;
      if (out.endsWith("/*")) {
        const dir = out.slice(0, -2);
        for (const entry of entries(dir)) {
          if (!entry.isFile() || !entry.name.endsWith(".out.md")) continue;
          const file = key(path.join(dir, entry.name));
          state.outs[file] ??= { session: meta.session, project: meta.project, done: false };
          if (!state.outs[file].done) selected.set(file, state.outs[file]);
        }
      } else selected.set(out, meta);
    }
    if (full) {
      for (const root of opts.statusRoots ?? scanRoots(opts.jobRoots)) {
        for (const file of walkStatuses(root)) {
          const out = file.slice(0, -7);
          if (state.outs[out]?.done || (stat(file)?.mtimeMs ?? 0) < cutoff) continue;
          state.outs[out] ??= { ...statusMeta(file), done: false };
          selected.set(out, state.outs[out]);
        }
      }
    }
    let statusFiles = 0;
    for (const [out, meta] of [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (captureStatus(out, meta, state, emit, opts.jobRoots)) statusFiles++;
    }
    const appended = withLock("events", { waitMs: 5000 }, () => {
      const attestations = events.filter((event) => ["luna_job", "executor_assumption", "critic_output"].includes(event.type)
        && event.data?.trusted === true && typeof event.data.status_sha256 === "string"
        && /^[0-9a-f]{64}$/i.test(event.data.status_sha256)).map((event) => ({
        v: 1, id: event.id, type: event.type, out: normaliseJobOut(event.data.out_path),
        status_sha256: event.data.status_sha256, event_sha256: eventDigest(event),
      }));
      appendJsonl(paths.attest, attestations);
      appendJsonl(paths.events, events);
      if ((stat(paths.attest)?.size ?? 0) > 5 * 1024 * 1024) {
        fs.rmSync(paths.attestOld, { force: true });
        fs.renameSync(paths.attest, paths.attestOld);
      }
      if ((stat(paths.events)?.size ?? 0) > 20 * 1024 * 1024) {
        fs.rmSync(paths.eventsOld, { force: true });
        fs.renameSync(paths.events, paths.eventsOld);
      }
    });
    if (!appended.locked) throw new Error("Events lock busy");
    if (full) state.lastFullScan = runTime;
    writeJsonAtomic(paths.extractState, state);
    return {
      ok: true, new_events: events.length, transcripts: transcripts.length, status_files: statusFiles, ...summary,
    };
  });
  if (!result.locked) return { ok: true, skipped: "locked" };
  if (opts.thenRunIfDue && !fs.existsSync(paths.paused)) {
    const loop = path.join(SCRIPTS_DIR, "loop.mjs");
    if (fs.existsSync(loop)) spawnDetached(findNode(), [loop, "run", "--if-due"]);
  }
  return { ...result.value, ms: Math.round(performance.now() - started) };
}

function cliOptions(args) {
  const opts = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--then-run-if-due") opts.thenRunIfDue = true;
    else if (["--transcript", "--session", "--backfill-days"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--transcript") opts.transcript = value;
      else if (arg === "--session") opts.session = value;
      else opts.backfillDays = Number(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const quiet = process.argv.includes("--quiet");
  try {
    const result = await extract(cliOptions(process.argv.slice(2)));
    if (!quiet) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    if (!quiet) process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
    process.exitCode = 1;
  }
}
