import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOME_CLAUDE, paths, ensureDirs, withLock, readJson, readJsonl, appendJsonl,
  writeFileAtomic, writeJsonAtomic, loadEvents, sha256, nowIso, sanitizeQuote, isForeignPath,
} from "./common.mjs";

export const TARGETS = Object.freeze(["CLAUDE.md", "skills/luna/SKILL.md", "skills/luna-critics/SKILL.md"]);
export const PROTECT_RE = Object.freeze([
  /user (decision|requirement|observation|correction|says|said)/i,
  /решение пользователя/i,
  /\(user, \d{4}-\d\d-\d\d/i,
  /\buser\b.*\b20\d\d-\d\d-\d\d\b/i,
  /\bNEVER\b/,
]);
export const SAFETY_LINE_RE = Object.freeze([
  /\bnever\b/i, /\bdon'?t\b.*\b(delete|remove|push|commit|use|hand|run)\b/i,
  /\bdo not\b/i, /\bmust not\b/i, /\bask\b/i, /\bconfirm/i, /\bpermission/i,
  /\bapprov/i, /\bconsent/i, /\bdestructive\b/i, /\birreversib/i, /\bdelete\b/i,
  /\bsafety\b/i, /\bsecurity\b/i, /\bsecret/i, /\bcredential/i, /\bpassword/i, /\btoken/i,
  /prompt[- ]injection/i, /\buntrusted\b/i, /\bcommits? itself\b/i, /\bnever commits\b/i,
  /\bgit (push|commit|reset)\b/i,
]);
export const REVERT_MIN_DAYS = 3;
export const COUNTING_TYPES = Object.freeze(["user_correction", "luna_job", "executor_assumption"]);
export const TARGET_EXTRA_PROTECT = Object.freeze({
  "CLAUDE.md": Object.freeze([/\bcritic/i, /\breview/i, /\bverif/i, /\bpanel\b/i, /\bgate\b/i, /\bchecks?\b/i]),
});

export function isCountingEvent(event) {
  if (!COUNTING_TYPES.includes(event?.type)) return false;
  return event.type === "user_correction"
    ? typeof event.source === "string" && event.source.includes(".jsonl#L")
    : event.data?.trusted === true;
}

const DEFAULTS = {
  min_new_events: 5, min_hours_between_runs: 24, retry_after_failure_hours: 6, report_days: 7,
  max_edits_per_run: 3, max_edit_growth_chars: 700, candidate_expiry_days: 60,
  targets: {
    "CLAUDE.md": { max_bytes: 11500 },
    "skills/luna/SKILL.md": { max_bytes: 24000 },
    "skills/luna-critics/SKILL.md": { max_bytes: 10500 },
  },
  proposer: { model: "gpt-6-luna", effort: "max" },
  critic: { model: "gpt-6.1-sol", effort: "high" },
};
const DENY_RE = [
  /https?:\/\//gi, /www\./gi, /\bcurl\b/gi, /\bwget\b/gi, /invoke-webrequest/gi,
  /\biwr\b/gi, /\birm\b/gi, /base64/gi, /\beval\b/gi,
  /ignore (all|any|previous|prior|the above)/gi, /disregard/gi, /dangerously/gi, /bypass/gi,
  /skip-permissions/gi, /--yolo/gi, /no-verify/gi, /rm -rf/gi, /permission/gi,
  /settings(\.local)?\.json/gi, /credential/gi, /\.credentials/gi, /api[_ -]?key/gi,
  /\btokens?\b/gi, /password/gi, /secret/gi, /exfiltrat/gi, /<system/gi, /extremely_important/gi,
  /codex-gate|review gate|review-gate/gi, /PAUSED/gi, /CAPTURE_OFF/gi, /luna-autoload-off/gi,
  /learning loop/gi, /self-improvement/gi, /scripts\/learning/gi, /\.claude\/learning/gi,
  /adopted\.(md|jsonl)/gi, /learning-revert/gi, /hooks?\//gi,
  /without (asking|confirm\w*|approval|permission|checking|review\w*)/gi,
  /no need to (ask|confirm|check|review|wait|run)/gi, /\bunless\b/gi, /\bexcept(ion|ions)?\b/gi,
  /instead of asking/gi, /don'?t (ask|confirm|wait for|check with)/gi,
  /skip(ping)?\s+(the\s+)?(critic|critics|review|confirmation|check|checks|tests?|gate)/gi,
  /\boptional(ly)?\b/gi, /\bauto-?approv/gi, /\bsilently\b/gi, /\bno longer\b/gi, /\bdisable/gi,
];
const rawTargets = new WeakMap();
const DAY_MS = 86400000;
const lf = (text) => text.replace(/\r/g, "");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const collapse = (text) => typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

export function displayText(text, max = 200) {
  let clean = sanitizeQuote(text, max);
  for (const re of [...DENY_RE, ...PROTECT_RE, /=== (BEGIN|END) DATA/gi, /<\/?learning-loop-report>/gi]) {
    clean = clean.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "…");
  }
  return clean;
}

function mergedConfig(overrides = {}) {
  const result = structuredClone(DEFAULTS);
  if (!object(overrides)) return result;
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(overrides, key)) continue;
    if (key === "targets") {
      for (const target of TARGETS) {
        if (object(overrides.targets) && object(overrides.targets[target])) {
          result.targets[target] = { ...DEFAULTS.targets[target], ...overrides.targets[target] };
        }
      }
    } else if (object(DEFAULTS[key])) {
      result[key] = { ...DEFAULTS[key], ...(object(overrides[key]) ? overrides[key] : {}) };
    } else {
      result[key] = overrides[key];
    }
  }
  const ranges = {
    min_new_events: [1, Infinity], min_hours_between_runs: [1, Infinity],
    retry_after_failure_hours: [1, Infinity], report_days: [1, Infinity],
    max_edits_per_run: [0, 10], max_edit_growth_chars: [0, 2000], candidate_expiry_days: [1, Infinity],
  };
  const validNumber = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!validNumber(result[key], min, max)) result[key] = DEFAULTS[key];
  }
  for (const target of TARGETS) {
    if (!validNumber(result.targets[target].max_bytes, 1000, Infinity)) {
      result.targets[target].max_bytes = DEFAULTS.targets[target].max_bytes;
    }
  }
  for (const role of ["proposer", "critic"]) {
    if (typeof result[role].model !== "string" || !/^[a-z0-9.\-]+$/.test(result[role].model)) {
      result[role].model = DEFAULTS[role].model;
    }
    if (!["low", "medium", "high", "xhigh", "max"].includes(result[role].effort)) {
      result[role].effort = DEFAULTS[role].effort;
    }
  }
  if (result.proposer.model === result.critic.model) result.critic.model = DEFAULTS.critic.model;
  if (result.proposer.model === result.critic.model) result.proposer.model = DEFAULTS.proposer.model;
  return result;
}

export function loadConfig() {
  if (!fs.existsSync(paths.config)) {
    ensureDirs();
    writeJsonAtomic(paths.config, DEFAULTS);
  }
  return mergedConfig(readJson(paths.config, {}));
}

function targetFile(target) {
  if (!TARGETS.includes(target)) throw new Error("target is not allowlisted");
  const file = path.resolve(HOME_CLAUDE, target);
  const canonical = (value) => {
    const normal = path.normalize(value);
    return process.platform === "win32" ? normal.toLowerCase() : normal;
  };
  const expected = path.resolve(fs.realpathSync(HOME_CLAUDE), target);
  if (canonical(fs.realpathSync(file)) !== canonical(expected)) throw new Error("target resolves through a link");
  return file;
}

export function readTargets(config = mergedConfig()) {
  const files = {};
  const originals = {};
  for (const target of TARGETS) {
    if (!Object.hasOwn(config.targets || {}, target)) continue;
    try {
      originals[target] = fs.readFileSync(targetFile(target), "utf8");
      files[target] = lf(originals[target]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  rawTargets.set(files, originals);
  return files;
}

export function protectedLineIndexes(text, target) {
  const lines = lf(text).split("\n");
  const protectedLines = new Set();
  const patterns = [...PROTECT_RE, ...SAFETY_LINE_RE, ...(TARGET_EXTRA_PROTECT[target] || [])];
  let block = false;
  let frontmatter = lines[0] === "---";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes("<!-- learning:protected:begin -->")) block = true;
    if (block || frontmatter || patterns.some((re) => re.test(line))) {
      protectedLines.add(i);
    }
    if (line.toLowerCase().includes("<!-- learning:protected:end -->")) block = false;
    if (i > 0 && frontmatter && line === "---") frontmatter = false;
  }
  return protectedLines;
}

export function annotate(text, target) {
  const indexes = protectedLineIndexes(text, target);
  return lf(text).split("\n").map((line, i) => (
    String(i + 1).padStart(4, "0") + "| " + (indexes.has(i) ? "[P] " : "") + line
  )).join("\n");
}

function protectedStrings(text, target) {
  const lines = lf(text).split("\n");
  return [...protectedLineIndexes(text, target)].map((i) => lines[i]).sort();
}

function sameProtected(before, after, target) {
  return JSON.stringify(protectedStrings(before, target)) === JSON.stringify(protectedStrings(after, target));
}

function protectedStringsOutsideRange(text, target, start, length) {
  const lines = lf(text).split("\n");
  const indexes = protectedLineIndexes(text, target);
  let offset = 0;
  return lines.filter((line, i) => {
    const lineEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0);
    const intersects = length === 0
      ? start >= offset && start <= offset + line.length
      : start < lineEnd && start + length > offset;
    offset = lineEnd;
    return indexes.has(i) && !intersects;
  }).sort();
}

export function eventsIndex() {
  return new Map(loadEvents().map((event) => [event.id, event]));
}

function occurrences(text, needle) {
  if (!needle) return [];
  const found = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i);
  return found;
}

function evidenceStats(events) {
  events = events.filter(isCountingEvent);
  const groups = new Map();
  const ordered = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
  for (const event of ordered) {
    const uuid = event.data?.uuid;
    const quote = collapse(event.quote);
    const key = typeof uuid === "string" && uuid.length ? `uuid:${uuid}`
      : quote.length >= 12 ? `q:${event.type}:${quote.toLowerCase()}` : `id:${event.id}`;
    if (!groups.has(key)) groups.set(key, event);
  }
  const sessions = new Set([...groups.values()].map((event) => event.session).filter((session) => (
    typeof session === "string" && session.trim() !== ""
  )));
  const explicit = events.some((event) => (
    event.type === "user_correction" && event.data?.explicit === true
    && typeof event.source === "string" && event.source.includes(".jsonl#L")
  ));
  return { sessions: sessions.size, explicit };
}

function adoptionList(adoptions) {
  return Array.isArray(adoptions) ? adoptions : adoptions?.list || [];
}

function validateShape(p, failures) {
  if (typeof p.id !== "string") failures.push("id must be a string");
  if (p.rationale !== undefined && typeof p.rationale !== "string") failures.push("rationale must be a string");
  if (!["edit", "log", "needs_user", "revert"].includes(p.kind)) failures.push("unknown kind");
  if (typeof p.lesson !== "string" || !p.lesson.trim() || p.lesson.length > 300) {
    failures.push("lesson must be non-empty and at most 300 chars");
  }
  if (typeof p.summary_ru !== "string" || p.summary_ru.length > 300
    || (p.kind !== "log" && !p.summary_ru.trim())) {
    failures.push("summary_ru must be non-empty and at most 300 chars (empty allowed for log)");
  }
  if (!Array.isArray(p.evidence) || p.evidence.length === 0 || p.evidence.length > 20) {
    failures.push("evidence must contain 1 to 20 items");
  }
}

function validateEvidence(p, ctx, failures) {
  const cited = [];
  for (const item of Array.isArray(p.evidence) ? p.evidence : []) {
    if (!object(item) || typeof item.event_id !== "string" || typeof item.quote !== "string") {
      failures.push(`evidence ${item?.event_id ?? "?"}: event_id and quote must be strings`);
      continue;
    }
    const event = ctx.events?.get(item.event_id);
    const quote = collapse(item.quote);
    if (!event) failures.push(`evidence ${item.event_id}: unknown event id`);
    if (quote.length < 12) failures.push(`evidence ${item.event_id}: quote shorter than 12 chars`);
    if (event && (!quote || ![event.quote, event.context].some((text) => collapse(text).includes(quote)))) {
      failures.push(`evidence ${item.event_id}: quote is not a substring of quote or context`);
    }
    if (event) cited.push(event);
  }
  return cited;
}

function validateEdit(p, ctx, failures) {
  const config = ctx.config || mergedConfig();
  const allowed = TARGETS.includes(p.target) && Object.hasOwn(config.targets || {}, p.target);
  if (!allowed) failures.push("target is not allowlisted");
  const supplied = ctx.files?.[p.target];
  if (allowed && typeof supplied !== "string") failures.push("target file is missing");
  const raw = rawTargets.get(ctx.files)?.[p.target] ?? (typeof supplied === "string" ? supplied : "");
  if (raw.includes("\r\n") && /(?<!\r)\n/.test(raw)) failures.push("mixed line endings");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const beforeText = typeof supplied === "string" ? lf(supplied) : "";
  const oldText = typeof p.old_text === "string" ? lf(p.old_text) : "";
  const anchor = typeof p.anchor === "string" ? lf(p.anchor) : "";
  const op = p.op === undefined ? (oldText ? "replace" : "insert") : p.op;
  if (!["replace", "insert"].includes(op)) failures.push("op must be replace or insert");
  if (typeof p.new_text !== "string") failures.push("new_text must be a string");
  const newText = typeof p.new_text === "string" ? lf(p.new_text) : "";
  if (newText.length > 4000) failures.push("new_text exceeds 4000 chars");
  if (op === "insert" && !newText) failures.push("insert new_text must not be empty");
  if (PROTECT_RE.some((re) => re.test(newText)) || /<!-- learning:protected/i.test(newText)) {
    failures.push("new_text contains protected content");
  }
  const removed = op === "replace" ? oldText : "";
  for (const re of DENY_RE) {
    if ([...newText.matchAll(re)].length > [...removed.matchAll(re)].length) {
      failures.push(`denylist: ${re.source}`);
    }
  }
  if (!allowed || typeof supplied !== "string") return null;
  const needle = op === "replace" ? oldText : anchor;
  const label = op === "replace" ? "old_text" : "anchor";
  const positions = occurrences(beforeText, needle);
  if (!needle) failures.push(`${label} must be non-empty`);
  if (positions.length !== 1) failures.push(`${label} must occur exactly once`);
  if (positions.length !== 1 || !["replace", "insert"].includes(op)) return null;
  let start = positions[0];
  let end = start + needle.length;
  let inserted = newText;
  if (op === "insert") {
    const newline = beforeText.indexOf("\n", end - 1);
    start = newline === -1 ? beforeText.length : newline;
    end = start;
    inserted = "\n" + newText.replace(/\n+$/, "");
  } else {
    const protectedLines = protectedLineIndexes(beforeText, p.target);
    let offset = 0;
    for (const [i, line] of beforeText.split("\n").entries()) {
      const lineEnd = offset + line.length + (offset + line.length < beforeText.length ? 1 : 0);
      if (start < lineEnd && end > offset && protectedLines.has(i)) {
        failures.push("replacement intersects a protected line");
        break;
      }
      offset = lineEnd;
    }
  }
  const afterText = beforeText.slice(0, start) + inserted + beforeText.slice(end);
  if (!sameProtected(beforeText, afterText, p.target)) failures.push("protected line multiset changed");
  const growth = op === "insert" ? inserted.length : newText.length - oldText.length;
  if (!Number.isFinite(config.max_edit_growth_chars) || growth > config.max_edit_growth_chars) {
    failures.push("edit growth exceeds max_edit_growth_chars");
  }
  const budget = config.targets[p.target]?.max_bytes;
  if (!Number.isFinite(budget) || budget < 0) failures.push("invalid target byte budget");
  if (Buffer.byteLength(afterText.replace(/\n/g, eol), "utf8") > budget && growth >= 0) {
    failures.push("over budget: only shrinking edits allowed");
  }
  return { target: p.target, op, start, end, inserted, beforeText, afterText, eol };
}

export function validateProposal(p, ctx = {}) {
  const failures = [];
  let plan = null;
  let kind = null;
  try {
    if (!object(p)) return { ok: false, failures: ["proposal must be an object"], kind, plan };
    kind = p.kind;
    validateShape(p, failures);
    let cited = validateEvidence(p, ctx, failures);
    if (p.kind === "revert") {
      const adoption = adoptionList(ctx.adoptions).find((item) => item.id === p.revert_id);
      if (!adoption || adoption.status !== "active") failures.push("revert_id must name an active adoption");
      cited = cited.filter((event) => Date.parse(event.ts) > Date.parse(adoption?.applied_at));
      const age = (ctx.now || new Date()).getTime() - Date.parse(adoption?.applied_at);
      if (!(age >= REVERT_MIN_DAYS * DAY_MS) && !evidenceStats(cited).explicit) {
        failures.push("revert: observation window < 3 days");
      }
    }
    if (["edit", "revert"].includes(p.kind)) {
      const stats = evidenceStats(cited);
      if (stats.sessions < 2 && !stats.explicit) failures.push("evidence threshold not met");
    }
    if (p.kind === "edit") plan = validateEdit(p, ctx, failures);
  } catch (error) {
    failures.push(`validation exception: ${error.message}`);
  }
  return { ok: failures.length === 0, failures, kind, plan };
}

export function loadAdoptions() {
  const list = [];
  const byId = new Map();
  for (const record of readJsonl(paths.adoptedJsonl)) {
    if (record.event === "adopt" && !byId.has(record.id)) {
      const adoption = { ...record, status: "active" };
      list.push(adoption);
      byId.set(record.id, adoption);
    } else if (record.event === "revert" && byId.has(record.id)) {
      Object.assign(byId.get(record.id), {
        status: "reverted", reverted_at: record.reverted_at, revert_reason: record.reason,
      });
    }
  }
  return { list, active: list.filter((item) => item.status === "active") };
}

function stamp(iso) {
  return iso.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function nextAdoptionId(appliedAt, runId, adoptions) {
  let n = adoptions.filter((item) => item.run_id === runId).length + 1;
  const ids = new Set(adoptions.map((item) => item.id));
  while (ids.has(`L-${stamp(appliedAt)}-${n}`)) n++;
  return `L-${stamp(appliedAt)}-${n}`;
}

function copyBackup(bytes, directory, target) {
  const dir = path.resolve(paths.backupsDir, directory);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, target.replaceAll("/", "__"));
  fs.writeFileSync(file, bytes, { flag: "wx" });
  return file;
}

function makeDiff(backup, expected, p, plan) {
  try {
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", "-U2", backup, "-"], {
      encoding: "utf8", windowsHide: true, input: expected,
    });
    if (!result.error && [0, 1].includes(result.status) && result.stdout) {
      return result.stdout.split(/\r?\n/).filter((line) => (
        !line.startsWith("diff --git ") && !line.startsWith("index ")
      )).map((line, i) => {
        if (i === 0 && line.startsWith("--- ")) return `--- a/${p.target}`;
        if (i === 1 && line.startsWith("+++ ")) return `+++ b/${p.target}`;
        return line;
      }).join("\n").trimEnd();
    }
  } catch {
    // The journal remains useful when git is absent or spawning is unavailable.
  }
  const lineStart = plan.beforeText.lastIndexOf("\n", plan.start - 1) + 1;
  const before = plan.op === "replace" ? lf(p.old_text) : plan.beforeText.slice(lineStart, plan.start);
  return `--- a/${p.target}\n+++ b/${p.target}\n${before}\n${plan.inserted}`;
}

function journalText(text) {
  return displayText(text, 400).replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "'");
}

function adoptionMarkdown(record) {
  const header = fs.existsSync(paths.adoptedMd) ? "" : "# Adopted lessons (learning loop journal)\n\n";
  const lines = [
    `## ${record.id} — ${journalText(record.lesson)}  (active)`,
    `- Applied: ${record.applied_at} · target: \`${record.target}\``
      + ` · confidence: ${journalText(record.confidence)} · run: ${record.run_id}`,
    `- Evidence: ${record.sessions} session(s)${record.explicit ? ", explicit user correction" : ""}`,
    ...record.evidence.map((item) => (
      `  - E:${item.event_id} · ${String(item.session || "").slice(0, 8)} · ${String(item.ts || "").slice(0, 10)}`
        + `: "${journalText(item.quote)}"`
    )),
    `- Rationale: ${journalText(record.rationale)}`,
    `- Critic: ${journalText(record.critic?.reason || "—")}`,
    `- Revert: \`bash ~/.claude/scripts/learning-revert.sh ${record.id}\``,
    "", "```diff", record.diff, "```", "", "",
  ];
  return header + lines.join("\n");
}

function applyLocked(p, opts) {
  const config = opts.config || loadConfig();
  const events = opts.events || eventsIndex();
  if (!object(p) || p.kind !== "edit") return { ok: false, error: "applyEdit requires kind edit" };
  const file = targetFile(p.target);
  const bytes = fs.readFileSync(file);
  const raw = bytes.toString("utf8");
  const adoptions = loadAdoptions();
  const checked = validateProposal(p, { events, files: { [p.target]: raw }, config, adoptions });
  if (!checked.ok) return { ok: false, error: checked.failures.join("; ") };
  const runId = opts.runId ?? null;
  if (!Number.isFinite(config.max_edits_per_run)
    || adoptions.list.filter((item) => item.run_id === runId).length >= config.max_edits_per_run) {
    return { ok: false, error: "max_edits_per_run reached" };
  }
  const appliedAt = nowIso();
  const id = nextAdoptionId(appliedAt, runId, adoptions.list);
  const plan = checked.plan;
  const backup = copyBackup(bytes, id, p.target);
  const expected = Buffer.from(plan.afterText.replace(/\n/g, plan.eol), "utf8");
  const evidence = p.evidence.map((item) => {
    const event = events.get(item.event_id);
    return { ...item, session: event.session, ts: event.ts, type: event.type };
  });
  const stats = evidenceStats(p.evidence.map((item) => events.get(item.event_id)));
  const diff = makeDiff(backup, expected, p, plan);
  const record = {
    event: "adopt", id, applied_at: appliedAt, run_id: runId, target: p.target, op: plan.op,
    old_text: plan.op === "replace" ? lf(p.old_text) : "",
    anchor: typeof p.anchor === "string" ? lf(p.anchor) : "",
    new_text: lf(p.new_text), inserted: plan.inserted, lesson: p.lesson, summary_ru: p.summary_ru,
    rationale: p.rationale || "", confidence: p.confidence || "", evidence,
    ...stats, critic: opts.critic ?? null, backup, sha256_before: sha256(bytes), sha256_after: sha256(expected),
    ctx_before: plan.afterText.slice(Math.max(0, plan.start - 80), plan.start),
    ctx_after: plan.afterText.slice(plan.start + plan.inserted.length, plan.start + plan.inserted.length + 80),
    diff,
  };
  const markdown = adoptionMarkdown(record);
  if (sha256(fs.readFileSync(targetFile(p.target))) !== sha256(bytes)) {
    return { ok: false, error: "target changed during apply" };
  }
  let actual;
  try {
    writeFileAtomic(file, expected);
    actual = fs.readFileSync(file);
  } catch (error) {
    writeFileAtomic(file, bytes);
    throw error;
  }
  if (sha256(actual) !== sha256(expected) || !sameProtected(raw, actual.toString("utf8"), p.target)) {
    writeFileAtomic(file, bytes);
    return { ok: false, error: "post-write verification failed" };
  }
  let journaled = false;
  try {
    appendJsonl(paths.adoptedJsonl, record);
    journaled = true;
    fs.appendFileSync(paths.adoptedMd, markdown, "utf8");
  } catch (error) {
    writeFileAtomic(file, bytes);
    if (journaled) {
      appendJsonl(paths.adoptedJsonl, {
        event: "revert", id, reverted_at: nowIso(), reason: "rollback: journal write failed",
        auto: true, method: "restore-backup",
      });
    }
    return { ok: false, error: `journal write failed: ${error.message}` };
  }
  return { ok: true, id, diff };
}

export function applyEdit(p, opts = {}) {
  try {
    const result = withLock("apply", { staleMs: 600000, waitMs: 30000 }, () => applyLocked(p, opts));
    return result.locked ? result.value : { ok: false, error: "apply lock busy" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function reversePatch(text, adoption) {
  const region = adoption.op === "insert" ? adoption.inserted : adoption.new_text;
  if (region) {
    const before = adoption.ctx_before.slice(-30);
    const after = adoption.ctx_after.slice(0, 30);
    const positions = occurrences(text, region).filter((i) => (
      (!before ? i === 0 : text.slice(Math.max(0, i - before.length), i) === before)
      && (!after ? i + region.length === text.length : text.slice(i + region.length).startsWith(after))
    ));
    if (positions.length !== 1) return null;
    const start = positions[0];
    const restored = adoption.op === "insert" ? "" : adoption.old_text;
    return {
      text: text.slice(0, start) + restored + text.slice(start + region.length),
      start, removedLength: region.length, insertedLength: restored.length,
    };
  }
  const before = adoption.ctx_before.slice(-40);
  const after = adoption.ctx_after.slice(0, 40);
  const positions = [];
  for (let i = 0; i <= text.length; i++) {
    if ((!before ? i === 0 : text.slice(Math.max(0, i - before.length), i) === before)
      && (!after ? i === text.length : text.slice(i).startsWith(after))) positions.push(i);
  }
  if (positions.length !== 1) return null;
  const start = positions[0];
  return {
    text: text.slice(0, start) + adoption.old_text + text.slice(start),
    start, removedLength: 0, insertedLength: adoption.old_text.length,
  };
}

function revertFailure(id, reason, backup) {
  const message = `Revert of ${id} needs manual help: ${reason}. Backup: ${backup}`;
  appendJsonl(paths.adoptedJsonl, { event: "revert_failed", id, at: nowIso(), reason });
  appendNeedsUserText(message);
  return { ok: false, status: "failed", message };
}

function appendRevertMarkdown(record) {
  let text = fs.existsSync(paths.adoptedMd) ? fs.readFileSync(paths.adoptedMd, "utf8") : "";
  if (!/^## Revert log\r?$/m.test(text)) text += "\n## Revert log\n\n";
  const line = `- **Reverted** ${record.reverted_at} (${record.auto ? "auto" : "manual"}): `
    + journalText(record.reason)
    + `  — id ${record.id}\n`;
  const heading = /^## Revert log\r?\n/m.exec(text);
  const start = heading.index + heading[0].length;
  const next = text.indexOf("\n## ", start);
  const end = next === -1 ? text.length : next + 1;
  writeFileAtomic(paths.adoptedMd, text.slice(0, end) + line + text.slice(end));
}

function revertLocked(id, opts) {
  const adoption = loadAdoptions().list.find((item) => item.id === id);
  if (!adoption) return { ok: false, status: "unknown", message: `Unknown adoption: ${id}` };
  if (adoption.status === "reverted") return { ok: true, status: "already", message: `${id} already reverted` };
  if (isForeignPath(adoption.target)) {
    return revertFailure(id, "historical Windows target is unavailable on Linux; restore it manually",
      adoption.backup || "unavailable");
  }
  let file;
  let bytes;
  try {
    file = targetFile(adoption.target);
    bytes = fs.readFileSync(file);
  } catch (error) {
    return revertFailure(id, `target is unavailable: ${error.message}`, adoption.backup || "unavailable");
  }
  const raw = bytes.toString("utf8");
  const text = lf(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const revertedAt = nowIso();
  const base = `${id}-revert-${stamp(revertedAt).replace("-", "")}`;
  let directory = base;
  for (let n = 2; fs.existsSync(path.join(paths.backupsDir, directory)); n++) directory = `${base}-${n}`;
  const backup = copyBackup(bytes, directory, adoption.target);
  if (raw.includes("\r\n") && /(?<!\r)\n/.test(raw)) {
    return revertFailure(id, "mixed line endings", backup);
  }
  const patched = reversePatch(text, adoption);
  let expected;
  let method = "reverse-patch";
  if (patched !== null) {
    expected = Buffer.from(patched.text.replace(/\n/g, eol), "utf8");
  } else if (sha256(bytes) === adoption.sha256_after) {
    if (isForeignPath(adoption.backup)) {
      return revertFailure(id, "historical Windows backup is unavailable on Linux; restore it manually", backup);
    }
    try {
      expected = fs.readFileSync(adoption.backup);
    } catch (error) {
      return revertFailure(id, `saved backup is unavailable: ${error.message}`, backup);
    }
    if (sha256(expected) !== adoption.sha256_before) return revertFailure(id, "backup hash mismatch", backup);
    method = "restore-backup";
  } else {
    return revertFailure(id, "reverse patch is missing or ambiguous; file changed since adoption", backup);
  }
  const preservesProtected = (after) => patched === null || JSON.stringify(
    protectedStringsOutsideRange(text, adoption.target, patched.start, patched.removedLength),
  ) === JSON.stringify(
    protectedStringsOutsideRange(after, adoption.target, patched.start, patched.insertedLength),
  );
  if (!preservesProtected(expected.toString("utf8"))) {
    return revertFailure(id, "protected line multiset would change", backup);
  }
  let actual;
  try {
    writeFileAtomic(file, expected);
    actual = fs.readFileSync(file);
  } catch (error) {
    writeFileAtomic(file, bytes);
    return revertFailure(id, error.message, backup);
  }
  if (sha256(actual) !== sha256(expected) || !preservesProtected(actual.toString("utf8"))) {
    writeFileAtomic(file, bytes);
    return revertFailure(id, "post-write verification failed", backup);
  }
  const record = {
    event: "revert", id, reverted_at: revertedAt, reason: opts.reason || "manual revert",
    auto: opts.auto === true, run_id: opts.runId ?? null, method, backup,
  };
  try {
    appendJsonl(paths.adoptedJsonl, record);
  } catch (error) {
    writeFileAtomic(file, bytes);
    throw error;
  }
  appendRevertMarkdown(record);
  return { ok: true, status: "reverted", message: `${id} reverted (${method})` };
}

export function revertAdoption(id, opts = {}) {
  try {
    const result = withLock("apply", { staleMs: 600000, waitMs: 30000 }, () => revertLocked(id, opts));
    return result.locked ? result.value : { ok: false, status: "failed", message: "apply lock busy" };
  } catch (error) {
    return { ok: false, status: "failed", message: error.message };
  }
}

function candidateKey(lesson) {
  return sha256(lesson.toLowerCase().replace(/[^\p{L}]/gu, "")).slice(0, 12);
}

export function recordCandidate(p, { runId, reason, status = "open" } = {}) {
  return candidatesLocked(() => {
    const record = {
      at: nowIso(), run_id: runId ?? null, status, reason: reason || "", kind: p.kind, target: p.target,
      lesson: p.lesson, summary_ru: p.summary_ru, evidence: p.evidence, candidate_key: candidateKey(p.lesson),
    };
    appendJsonl(paths.candidates, record);
    return record;
  });
}

function candidatesLocked(fn) {
  const result = withLock("candidates", { waitMs: 5000 }, fn);
  if (!result.locked) throw new Error("candidates lock busy");
  return result.value;
}

export function loadCandidates({ openOnly = false } = {}) {
  const config = mergedConfig(readJson(paths.config, {}));
  const folded = new Map();
  for (const record of readJsonl(paths.candidates)) {
    const previous = folded.get(record.candidate_key);
    const evidence = new Map();
    const incoming = Array.isArray(record.evidence) ? record.evidence : [];
    for (const item of [...(previous?.evidence || []), ...incoming]) {
      if (!object(item) || typeof item.event_id !== "string") continue;
      if (!evidence.has(item.event_id)) evidence.set(item.event_id, item);
    }
    folded.set(record.candidate_key, {
      ...previous, ...record, evidence: [...evidence.values()],
      times_seen: (previous?.times_seen || 0) + (record.times_seen ?? 1),
      first_at: previous?.first_at || record.first_at || record.at,
      last_at: record.last_at || record.at,
    });
  }
  return [...folded.values()].map((record) => (
    Date.now() - Date.parse(record.last_at) > config.candidate_expiry_days * DAY_MS
      ? { ...record, status: "expired" } : record
  )).filter((record) => !openOnly || record.status === "open");
}

export function closeCandidates(keys, { runId, reason } = {}) {
  candidatesLocked(() => {
    const wanted = new Set(keys);
    for (const record of loadCandidates()) {
      if (!wanted.has(record.candidate_key)) continue;
      const at = nowIso();
      appendJsonl(paths.candidates, {
        ...record, times_seen: 0, at, last_at: at, run_id: runId ?? null, status: "closed", reason: reason || "",
      });
    }
  });
}

export function compactCandidates({ maxBytes = 2_000_000 } = {}) {
  return candidatesLocked(() => {
    if (!fs.existsSync(paths.candidates) || fs.statSync(paths.candidates).size <= maxBytes) return false;
    const config = mergedConfig(readJson(paths.config, {}));
    const records = loadCandidates().filter((record) => (
      record.status === "open" || Date.now() - Date.parse(record.last_at) <= config.candidate_expiry_days * DAY_MS
    ));
    writeFileAtomic(paths.candidates, records.map((record) => JSON.stringify(record) + "\n").join(""));
    return true;
  });
}

export function openNeedsUser() {
  if (!fs.existsSync(paths.needsUser)) return [];
  return fs.readFileSync(paths.needsUser, "utf8").split(/\r?\n/).filter((line) => line.startsWith("- [ ]"))
    .map((line) => ({ id: /^- \[ \] (NU-\d{8}-\d+)/.exec(line)?.[1] || "", text: line.slice(6) }));
}

function addNeedsUser(summary, target, rationale, evidence) {
  ensureDirs();
  const clean = (text) => displayText(String(text || ""), 300);
  summary = clean(summary);
  if (openNeedsUser().some((item) => item.text.includes(summary))) return;
  if (!fs.existsSync(paths.needsUser)) {
    writeFileAtomic(paths.needsUser, "# Needs your decision (learning loop)\n\n"
      + 'Mark an item done by changing "- [ ]" to "- [x]".\n\n');
  }
  const text = fs.readFileSync(paths.needsUser, "utf8");
  const prefix = `NU-${nowIso().slice(0, 10).replaceAll("-", "")}-`;
  let n = 1;
  while (text.includes(`${prefix}${n} (`)) n++;
  const refs = evidence.map((item) => `E:${clean(item.event_id)}`).join(", ") || "—";
  const line = `- [ ] ${prefix}${n} (${clean(target) || "—"}): ${summary}`
    + ` — ${clean(rationale).slice(0, 300)} (evidence: ${refs})\n`;
  fs.appendFileSync(paths.needsUser, line, "utf8");
}

export function recordNeedsUser(p, { runId } = {}) {
  addNeedsUser(p.summary_ru || p.lesson, p.target, p.rationale, p.evidence || []);
}

export function appendNeedsUserText(text) {
  addNeedsUser(text, "—", "", []);
}

function readLogDates() {
  if (!fs.existsSync(paths.logMd)) return [];
  return [...fs.readFileSync(paths.logMd, "utf8").matchAll(/^- (\d{4}-\d\d-\d\d[^\s]*)/gm)]
    .map((match) => match[1]).filter((date) => Number.isFinite(Date.parse(date)));
}

function reportSection(title, entries) {
  if (entries.length === 0) return [];
  return [title, ...entries.slice(0, 5).map((entry) => `• ${entry}`),
    ...(entries.length > 5 ? [`и ещё ${entries.length - 5}`] : [])];
}

export function russianPlural(count, forms) {
  const n = Math.abs(count) % 100;
  return forms[n >= 11 && n <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
}

function buildReport(config, start, now) {
  const within = (date) => Date.parse(date) >= start && Date.parse(date) <= now.getTime();
  const records = readJsonl(paths.adoptedJsonl);
  const adopts = records.filter((item) => item.event === "adopt" && within(item.applied_at));
  const reverts = records.filter((item) => item.event === "revert" && within(item.reverted_at));
  const candidates = readJsonl(paths.candidates).filter((item) => within(item.at));
  const open = openNeedsUser();
  const date = (value) => new Date(value).toISOString().slice(5, 10).split("-").reverse().join(".");
  const lines = [
    `Самообучение: отчёт за ${date(start)}–${date(now)}`,
    `Прогонов: ${readLogDates().filter(within).length} · применено: ${adopts.length} · откачено: ${reverts.length}`
      + ` · отложено (мало доказательств): ${candidates.length} · ждут вашего решения: ${open.length}`,
  ];
  if (adopts.length === 0 && reverts.length === 0) lines.push("Правок за период не было.");
  lines.push(...reportSection("Нужно ваше решение:", open.map((item) => displayText(item.text, 160))));
  lines.push(...reportSection("Что изменилось:", adopts.map((item) => (
    `${item.id} (${item.target}): ${displayText(item.summary_ru || item.lesson)}`
      + ` — ${item.sessions} ${russianPlural(item.sessions, ["сессия", "сессии", "сессий"])}.`
      + ` Откат: bash ~/.claude/scripts/learning-revert.sh ${item.id}`
  ))));
  lines.push(...reportSection("Откаты:", reverts.map((item) => `${item.id}: ${displayText(item.reason)}`)));
  lines.push("Размеры файлов:");
  for (const target of TARGETS) {
    let size = "нет файла";
    try {
      size = `${fs.statSync(targetFile(target)).size} байт`;
    } catch {
      // Missing targets are visible in the report, never silently created.
    }
    lines.push(`• ${target}: ${size} / ${config.targets[target]?.max_bytes ?? "—"}`);
  }
  lines.push("Журнал: ~/.claude/learning/adopted.md · пауза: создать файл ~/.claude/learning/PAUSED");
  return lines.join("\n") + "\n";
}

export function generateReport({ force = false, now = new Date() } = {}) {
  const result = withLock("state", { waitMs: 5000 }, () => {
    const state = readJson(paths.loopState, {});
    const config = mergedConfig(readJson(paths.config, {}));
    const lastReport = Date.parse(state.lastReportAt);
    const created = Date.parse(state.report?.created);
    const records = readJsonl(paths.adoptedJsonl);
    const changed = Number.isFinite(created) && (records.some((item) => (
      (item.event === "adopt" && Date.parse(item.applied_at) > created)
      || (item.event === "revert" && Date.parse(item.reverted_at) > created)
    )) || (openNeedsUser().length > 0 && fs.statSync(paths.needsUser).mtimeMs > created));
    if (!force && !changed && (!state.lastRunAt || (Number.isFinite(lastReport)
      && now.getTime() - lastReport < config.report_days * DAY_MS))) return null;
    const firstAdopt = records.find((item) => item.event === "adopt")?.applied_at;
    const firstLog = readLogDates()[0];
    const firstDate = [firstAdopt, firstLog].map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const start = Number.isFinite(lastReport) ? lastReport : firstDate ?? now.getTime() - 7 * DAY_MS;
    const text = buildReport(config, start, now);
    const base = now.toISOString().slice(0, 10);
    let reportPath = path.join(paths.reportsDir, `${base}.md`);
    for (let n = 2; fs.existsSync(reportPath); n++) reportPath = path.join(paths.reportsDir, `${base}-${n}.md`);
    writeFileAtomic(reportPath, text);
    writeJsonAtomic(paths.loopState, {
      ...state, lastReportAt: now.toISOString(), report: { path: reportPath, created: now.toISOString(), shown: 0 },
    });
    let short = text;
    if (short.length > 1200) {
      const end = short.lastIndexOf("\n", 1200);
      short = end === -1 ? "" : short.slice(0, end);
    }
    return { path: reportPath, text, short };
  });
  return result.locked ? result.value : null;
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "list") {
    const { list } = loadAdoptions();
    console.log(list.length ? list.map((item) => (
      `${item.id}  ${item.status}  ${item.target}  ${item.lesson}`
    )).join("\n") : "No adoptions yet.");
  } else if (command === "revert") {
    const result = revertAdoption(rest[0], { reason: rest.slice(1).join(" ") || "manual revert" });
    console.log(result.message);
    process.exitCode = result.ok ? 0 : result.status === "unknown" ? 2 : 1;
  } else if (command === "report") {
    console.log(generateReport({ force: rest.includes("--force") })?.text || "No report due.");
  } else if (command === "validate") {
    const input = readJson(rest[0], null);
    const proposals = Array.isArray(input) ? input : input?.proposals;
    if (!Array.isArray(proposals)) throw new Error("expected a proposal array or {proposals: [...]} JSON");
    const config = mergedConfig(readJson(paths.config, {}));
    const ctx = { events: eventsIndex(), files: readTargets(config), config, adoptions: loadAdoptions() };
    for (const proposal of proposals) {
      const result = validateProposal(proposal, ctx);
      console.log(`${proposal?.id ?? "?"} ${result.ok ? "ok" : `FAIL: ${result.failures.join("; ")}`}`);
    }
  } else {
    throw new Error("Usage: core.mjs revert <id> [reason…] | list | report [--force] | validate <proposals.json>");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
