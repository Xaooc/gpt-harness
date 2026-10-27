import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

process.env.CLAUDE_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learn-extract-"));
process.env.CLAUDE_LEARNING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learn-extract-"));
const common = await import("../common.mjs");
const {
  TERMINAL_JOB_STATES, statusSha256, recordJob, loadJobRegistry, normaliseJobOut, registryHas,
} = await import("../registry.mjs");
const {
  extract, classifyUserText, verifyEventProvenance, isGenuineHumanEntry, entryText, isTrustedJobPath, isTrustedJob,
  eventDigest,
} = await import("../extract.mjs");
const { HOME_CLAUDE, LEARN_DIR, paths, readJson, readJsonl, toWinPath, canonicalJson } = common;
const statusRoot = path.join(HOME_CLAUDE, "luna-run");
const hook = fileURLToPath(new URL("../../../hooks/learning-capture.mjs", import.meta.url));
const timestamp = "2026-10-20T10:00:00.000Z";
const run = (opts = {}) => extract({ statusRoots: [statusRoot], ...opts });
const events = (type) => common.loadEvents().filter((event) => !type || event.type === type);
const human = (text, extra = {}) => ({
  type: "user", timestamp, origin: { kind: "human" }, message: { content: text }, ...extra,
});
const assistant = (content, extra = {}) => ({ type: "assistant", timestamp, message: { content }, ...extra });
const encode = (entry, newline = "\n") => JSON.stringify(entry) + newline;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function transcript(rows, name = "session", newline = "\n") {
  return write(path.join(HOME_CLAUDE, "projects", "project", `${name}.jsonl`),
    rows.map((entry) => encode(entry, newline)).join(""));
}

function job(out, state = "done", extra = "") {
  return write(`${out}.status`, `\uFEFFstate=${state}\r\njunk\r\nrc=0\r\nmodel=gpt-6.1-sol\r\n`
    + `effort=high\r\nsandbox=workspace-write\r\nstarted=${timestamp}\r\n`
    + "finished=2026-10-20T10:01:00.000Z\r\n" + extra);
}

function registryRecord(out, extra = {}) {
  return {
    v: 1, out: toWinPath(out),
    status_sha256: createHash("sha256").update(fs.readFileSync(`${out}.status`)).digest("hex"),
    started: timestamp, finished: "2026-10-20T10:01:00.000Z", state: "done", model: "gpt-6.1-sol", pid: "",
    ...extra,
  };
}

function bash(command) {
  return assistant([{ type: "tool_use", name: "Bash", input: { command } }]);
}

beforeEach(() => {
  // These paths are fresh task-owned fixtures, never the real learning directory.
  fs.rmSync(HOME_CLAUDE, { recursive: true, force: true });
  fs.rmSync(LEARN_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_CLAUDE, { recursive: true });
  common.ensureDirs();
});

after(() => {
  fs.rmSync(HOME_CLAUDE, { recursive: true, force: true });
  fs.rmSync(LEARN_DIR, { recursive: true, force: true });
  fs.rmSync(`${LEARN_DIR}.status`, { force: true });
});

test("human correction has explicit classification, previous assistant context and stable source", async () => {
  const file = transcript([
    assistant([{ type: "thinking", thinking: "private" }, { type: "text", text: "Меняю конфиг." }]),
    human("нет, я же сказал не трогать конфиг"),
  ]);
  const result = await run();
  assert.equal(result.new_events, 1);
  assert.equal(result.transcripts, 1);
  const [event] = events();
  assert.equal(event.type, "user_correction");
  assert.equal(event.context, "Меняю конфиг.");
  assert.equal(event.data.kind, "correction");
  assert.equal(event.data.explicit, true);
  assert.equal(event.data.uuid, null);
  assert.equal(event.source, `${toWinPath(file)}#L2`);
  assert.equal(event.session, "session");
  assert.equal(event.project, "project");
  assert.equal(event.ts, timestamp);
  assert.equal(event.v, 1);
  assert.match(event.id, /^[a-f0-9]{16}$/);
  assert.equal(event.id, common.eventId(event.type, event.session, event.source));
});

test("provenance rejects parent path components with either separator", async () => {
  const file = transcript([human("нет, я же сказал не трогать конфиг")]);
  await run();
  const [event] = events("user_correction");
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  for (const separator of ["/", "\\"]) {
    const source = `${path.dirname(file)}${separator}..${separator}project${separator}session.jsonl#L1`;
    assert.deepEqual(await verifyEventProvenance({ ...event, source }),
      { ok: false, reason: "invalid transcript path" });
  }
});

test("copied transcript UUIDs deduplicate all entry event types and keep the first source", async () => {
  const rows = [
    human("нет, я же сказал не трогать конфиг", { uuid: "correction-uuid" }),
    human("[Request interrupted by user]", { uuid: "interrupt-uuid" }),
    human("сделай кнопку синей", { uuid: "following-uuid" }),
    assistant([
      { type: "text", text: "Critic panel: accepted, rejected" },
      { type: "text", text: "Critic panel: accepted, rejected again" },
    ], { uuid: "synthesis-uuid" }),
  ];
  const first = transcript(rows, "first");
  assert.equal((await run({ transcript: first })).new_events, 3);
  transcript(rows, "copy-one");
  transcript(rows, "copy-two");
  assert.equal((await run()).new_events, 0);
  const expected = [
    ["user_correction", "correction-uuid", 1],
    ["user_interrupt", "interrupt-uuid", 2],
    ["critic_synthesis", "synthesis-uuid", 4],
  ];
  assert.equal(events().length, expected.length);
  for (const [type, uuid, line] of expected) {
    const [event] = events(type);
    assert.equal(event.data.uuid, uuid);
    assert.equal(event.id, common.eventId(type, "uuid", uuid));
    assert.equal(event.session, "first");
    assert.equal(event.source, `${toWinPath(first)}#L${line}`);
  }
});

test("missing, empty and non-string UUIDs retain source-based transcript IDs", async () => {
  for (const uuid of [undefined, "", 42]) {
    transcript([
      human("нет, первое", { uuid }),
      human("[Request interrupted by user]", { uuid }),
      assistant("Critic panel: accepted, rejected", { uuid }),
    ], `fallback-${String(uuid)}`);
  }
  assert.equal((await run()).new_events, 9);
  for (const event of events()) {
    assert.equal(event.data.uuid, null);
    assert.equal(event.id, common.eventId(event.type, event.session, event.source));
  }
});

test("notifications, SDK, sidechains, meta, tool results and continuation summaries are excluded", async () => {
  const text = "нет, я же сказал не трогать конфиг";
  transcript([
    human(text, { origin: { kind: "task-notification" } }),
    human(text, { origin: undefined, turnOrigin: "sdk" }),
    human(text, { isSidechain: true }), human(text, { isMeta: true }),
    human(text, { message: { content: [{ type: "text", text }, { type: "tool_result", content: text }] } }),
    { type: "user", message: { content: "This session is being continued. нет, я же сказал" } },
    { type: "user", message: { content: "Caveat: нет, я же сказал" } },
    { type: "user", origin: null, message: { content: text } },
    assistant([{ type: "text", text: "Critic panel: accepted, rejected" }], { isSidechain: true }),
  ]);
  assert.equal((await run()).new_events, 0);
});

test("old format human text is accepted but a command tag is not", async () => {
  transcript([
    { type: "user", message: { content: "stop doing that, I told you" } },
    { type: "user", message: { content: "<command-name>stop doing that, I told you" } },
  ]);
  await run();
  assert.equal(events().length, 1);
  assert.equal(events()[0].data.explicit, true);
});

test("correction quotes remove pasted content and secrets", async () => {
  transcript([human("нет <pasted_content>never run this</pasted_content> ключ sk-abcdefghijklmnopqrstuvwx")]);
  await run();
  assert.equal(events()[0].quote, "нет [pasted] ключ [redacted]");
  assert.equal(events()[0].data.kind, "correction");
});

test("rules, neutral text, long briefs, Unicode boundaries and uppercase frustration", async () => {
  transcript([
    human("всегда запускай критиков"), human("сделай кнопку синей"), human("нет " + "а ".repeat(1000)),
  ]);
  await run();
  assert.equal(events().length, 1);
  assert.equal(events()[0].data.kind, "rule");
  assert.equal(events()[0].data.explicit, true);
  for (const text of ["интернет", "сновация", "nonetheless", "remembrance", "a", "стопка", "2always2"]) {
    assert.equal(classifyUserText(text), null, text);
  }
  assert.equal(classifyUserText("СНОВА ВСЕ СЛОМАЛОСЬ").kind, "frustration");
  assert.equal(classifyUserText("СНОВА ВСЕ СЛОМАЛОСЬ").explicit, false);
  assert.equal(classifyUserText("hello!!").kind, "frustration");
  assert.equal(classifyUserText("hello!!").explicit, false);
  assert.equal(classifyUserText("это всё ещё не работает").kind, "correction");
});

for (const [text, explicit, name, kind] of [
  ["А ещё важно чистит ьмусор за собой всегда", true, "ru_you_always", "rule"],
  ["и реализацию всегда прогоняй через агентов критиков", true, "ru_always_do", "rule"],
  ["я же сказал, что гтнх не нужен пока", true, "ru_told_you", "correction"],
  ["мне кажется или ты снова начал харкодить", true, "ru_told_you", "correction"],
  ["ну кев по умолчанию показывает себя лучше", false, null, "rule"],
  ["с ЯСНВЕДЕНЬЕМ ЕЩЁ был баг что бомба всегда видна там же", false, null, "rule"],
  ["Нужно пофиксить следущее: 1. Убрать игры … 2. По умолчанию показывает", false, null, "rule"],
  ["надо звания неменог опеределать, убрать : Всегда в игре и предложить новые", false, null, "rule"],
  ["stop doing that, I told you", true, "en_told_you", "correction"],
  ["make the button blue by default", false, null, "rule"],
  ["всегда запускай критиков", true, "ru_always_do", "rule"],
  ["нет, я же сказал не трогать конфиг", true, "ru_told_you", "correction"],
  ["ЗАПОМНИ проверять результат", true, "ru_remember", "rule"],
  ["опять ты забыл тесты", true, "ru_told_you", "correction"],
  ["снова ты забыл тесты", true, "ru_told_you", "correction"],
  ["You should always verify results", true, "en_you_always", "rule"],
  ["from now on run tests", true, "en_always_do", "rule"],
  ["remember to check results", false, null, "rule"],
  ["how many times must I repeat this", true, "en_told_you", "frustration"],
  ["обязательно проверь результат", false, null, "rule"],
  ["нет, опять всё сломалось!!", false, null, "correction"],
]) {
  test(`explicit classification: ${text}`, () => {
    const result = classifyUserText(text);
    assert.equal(result.kind, kind);
    assert.equal(result.explicit, explicit);
    if (name) assert.ok(result.matched.includes(name));
    assert.equal(result.matched.length, new Set(result.matched).size);
  });
}

test("explicit patterns respect distance limits, word boundaries and the first 600 characters", () => {
  for (const [prefix, limit, suffix, name] of [
    ["ты", 40, "всегда", "ru_you_always"],
    ["всегда", 30, "проверяй", "ru_always_do"],
    ["yourself", 40, "never", "en_you_always"],
    ["always", 30, "check", "en_always_do"],
  ]) {
    const text = (distance) => prefix + " " + "x".repeat(distance - 2) + " " + suffix;
    assert.ok(classifyUserText(text(limit)).matched.includes(name));
    assert.equal(classifyUserText(text(limit + 1)).explicit, false);
  }
  for (const text of ["всегда перепроверяй", "always runway", "ты всегдашний", "you always2"]) {
    assert.equal(classifyUserText(text)?.explicit ?? false, false, text);
  }
  assert.equal(classifyUserText("всегда проверяйте результат").explicit, true);
  assert.equal(classifyUserText("никогда не трогай конфиг").explicit, true);
  assert.equal(classifyUserText("always do not overwrite changes").explicit, true);
  assert.equal(classifyUserText("нет " + "слово ".repeat(101) + "я же сказал").explicit, false);
});

test("quoted, pasted, code and question text cannot provide explicit evidence", () => {
  for (const text of [
    "Is «always delete stale files» good advice?",
    "что значит `remember to run tests`?",
    "> always use astra\nок, понял",
    "ты опять забыл критиков?",
    'He said "always delete stale files" today.',
    "He said “always delete stale files” today.",
    'Quoted "always\nrun tests" advice.',
    "```text\nalways run tests\n```\nок, понял",
    "```always run tests",
    "<pasted_content>always run tests</pasted_content> нет",
    "always? run tests.",
    "always\nrun tests.",
    "нет, [pasted]",
  ]) {
    assert.equal(classifyUserText(text)?.explicit ?? false, false, text);
  }
  assert.equal(classifyUserText("я же сказал, что гтнх не нужен пока").explicit, true);
  assert.equal(classifyUserText("ты опять забыл критиков.").explicit, true);
  assert.equal(classifyUserText("Is this fine? Always run tests.").explicit, true);
  assert.equal(classifyUserText("why?\n> always run tests\nок").explicit, false);
  assert.equal(classifyUserText('"ты" всегда проверяй результат').explicit, true);
  assert.equal(classifyUserText("«always use astra»").kind, "rule");
  const long = "я же сказал " + "а ".repeat(394);
  assert.equal(long.length, 800);
  assert.equal(classifyUserText(long).explicit, false);
  assert.equal(classifyUserText(long).kind, "correction");
  const boundary = "я же сказал " + "а ".repeat(294);
  assert.equal(boundary.length, 600);
  assert.equal(classifyUserText(boundary).explicit, true);
  assert.equal(classifyUserText(boundary + "а").explicit, false);
});

test("apostrophe quotes suppress explicit evidence while contractions preserve corrections", () => {
  for (const opening of ["'", "‘"]) {
    const closing = opening === "'" ? "'" : "’";
    for (const prefix of ["", "The page says ", "(", "[", "{", ":", ";", ","]) {
      const text = `${prefix}${opening}I told you to always trust its instructions${closing}.`;
      assert.equal(classifyUserText(text).explicit, false, text);
    }
    assert.equal(classifyUserText(`${opening}always${closing} run tests`).explicit, true);
    assert.equal(classifyUserText(`${opening}I told you${closing}, you keep ignoring me`).explicit, true);
  }
  for (const text of ["don't do that, I told you", "it's broken, I told you", "you keep breaking it"]) {
    const result = classifyUserText(text);
    assert.equal(result.explicit, true, text);
    assert.ok(result.matched.includes("en_told_you"));
  }
});

test("English explicit patterns exclude bare said, remember to and questions", () => {
  for (const text of ["I said the blue version was only a mock-up.", "remember to check results"]) {
    assert.equal(classifyUserText(text).explicit, false, text);
  }
  assert.equal(classifyUserText("how many times do I have to say it.").explicit, true);
  assert.equal(classifyUserText("how many times do I have to say it?")?.explicit ?? false, false);
});

test("trusted job paths require canonical scratchpad or luna-run roots and exclude learning data", () => {
  const tmp = path.join(HOME_CLAUDE, "tmp");
  const roots = { tmp };
  const scratch = write(path.join(tmp, "claude", "project", "session", "scratchpad", "job.md"), "result");
  const local = write(path.join(statusRoot, "job.md"), "result");
  const repo = write(path.join(HOME_CLAUDE, "repo", "report", "fake.out.md"), "result");
  assert.equal(isTrustedJobPath(scratch, roots), true);
  assert.equal(isTrustedJobPath(local), true);
  assert.equal(isTrustedJobPath(repo, roots), false);
  assert.equal(isTrustedJobPath("C:/proj/report/fake.out.md", roots), false);
  assert.equal(isTrustedJobPath(write(path.join(LEARN_DIR, "fake.md"), "result"), roots), false);
  assert.equal(isTrustedJobPath(path.join(LEARN_DIR, "fake.md"), { lunaRun: LEARN_DIR }), false);
  const escaped = `${path.dirname(scratch)}/../fake.out.md`;
  write(escaped, "result");
  assert.equal(isTrustedJobPath(escaped, roots), false);
  assert.equal(isTrustedJobPath(path.join(tmp, "claude", "project", "scratchpad", "fake.md"), roots), false);
  assert.equal(isTrustedJobPath(path.join(`${statusRoot}-other`, "fake.md")), false);
  assert.equal(isTrustedJobPath("relative.out.md", roots), false);
  assert.equal(isTrustedJobPath(null, roots), false);
  if (process.platform === "win32") assert.equal(isTrustedJobPath(scratch.toUpperCase(), roots), true);
  const alias = path.join(statusRoot, "escape");
  fs.symlinkSync(path.dirname(repo), alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(isTrustedJobPath(path.join(alias, "fake.out.md"), roots), false);
});

test("jobRoots overrides scratchpad discovery and trust for extraction and provenance", async () => {
  const jobRoots = { tmp: path.join(HOME_CLAUDE, "tmp") };
  const out = path.join(jobRoots.tmp, "claude", "project", "session", "scratchpad", "review.out.md");
  write(out, "Assumption: local defaults\n- **[high]** Finding\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  job(out);
  assert.equal((await extract({ jobRoots })).new_events, 3);
  for (const event of events()) {
    assert.equal(event.data.trusted, true);
    assert.equal((await verifyEventProvenance(event, jobRoots)).ok, true);
    assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "untrusted job path" });
  }
});

test("Bash jobs outside trusted roots are extracted but cannot pass provenance with forged trust", async () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  write(out, "Assumption: local defaults\n- **[high]** Finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  job(out);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 3);
  for (const event of events()) {
    assert.equal(event.data.trusted, false);
    assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "untrusted job path" });
    assert.deepEqual(await verifyEventProvenance({ ...event, data: { ...event.data, trusted: true } }),
      { ok: false, reason: "untrusted job path" });
  }
});

test("recordJob appends exact ordered records with hashes of the final status bytes", () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  job(out, "done", "pid = 1234\r\nmodel = custom=model\r\n");
  const bytes = fs.readFileSync(`${out}.status`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(recordJob(out), true);
  const lines = fs.readFileSync(paths.jobs, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record), [
    "v", "out", "status_sha256", "started", "finished", "state", "model", "pid",
  ]);
  assert.deepEqual(record, {
    v: 1, out: toWinPath(path.resolve(out)), status_sha256: sha, started: timestamp,
    finished: "2026-10-20T10:01:00.000Z", state: "done", model: "custom=model", pid: "1234",
  });
  assert.equal(record.out.includes("\\"), false);
  if (process.platform === "win32") assert.match(record.out, /^[A-Z]:\//);
  assert.equal(recordJob(out), true);
  assert.equal(readJsonl(paths.jobs).length, 2);
  assert.equal(loadJobRegistry().get(normaliseJobOut(out)).size, 1);
  assert.equal(registryHas(out, sha), true);
});

test("recordJob no-ops for ineligible inputs and never creates a registry directory", () => {
  const out = path.join(HOME_CLAUDE, "repo", "fake.out.md");
  for (const state of ["running", "starting", "abandoned", "unknown"]) {
    job(out, state);
    assert.equal(recordJob(out), false);
  }
  assert.equal(recordJob(path.join(HOME_CLAUDE, "missing.out.md")), false);
  job(out);
  for (const value of ["relative.out.md", "", null, undefined, 42, {}]) {
    assert.equal(recordJob(value), false);
  }
  const directory = path.join(LEARN_DIR, "missing-registry");
  assert.equal(recordJob(out, { registry: path.join(directory, "jobs.jsonl") }), false);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(paths.jobs), false);
});

test("recordJob and statusSha256 reject symlinked status files", (t) => {
  const out = path.join(HOME_CLAUDE, "fake.out.md");
  const target = job(path.join(HOME_CLAUDE, "target.out.md"));
  try { fs.symlinkSync(target, `${out}.status`, "file"); } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
    t.skip(`status symlinks unavailable: ${error.code}`);
    return;
  }
  assert.equal(statusSha256(`${out}.status`), null);
  assert.equal(recordJob(out), false);
  assert.equal(fs.existsSync(paths.jobs), false);
});

function registryProcess(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, CLAUDE_LEARNING_DIR: LEARN_DIR, CLAUDE_HOME_DIR: HOME_CLAUDE, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

test("registry CLI is silent and exits zero for valid, absent and invalid arguments", async () => {
  const cli = fileURLToPath(new URL("../registry.mjs", import.meta.url));
  const out = path.join(HOME_CLAUDE, "repo", "fake.out.md");
  job(out);
  for (const args of [["record", out], [], ["bogus", out], ["record"], ["record", "relative.out.md"]]) {
    assert.deepEqual(await registryProcess([cli, ...args]), { code: 0, stdout: "", stderr: "" });
  }
  assert.equal(readJsonl(paths.jobs).length, 1);
});

test("importing registry does not create directories or print output", async () => {
  const directory = path.join(LEARN_DIR, "missing-import");
  const url = new URL("../registry.mjs", import.meta.url).href;
  const result = await registryProcess(["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], {
    CLAUDE_LEARNING_DIR: directory,
  });
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.equal(fs.existsSync(directory), false);
});

test("recordJob accepts every wrapper terminal state and fills absent status fields with strings", () => {
  const out = path.join(HOME_CLAUDE, "fake.out.md");
  for (const state of ["done", "incomplete", "failed", "stalled", "killed", "timeout"]) {
    write(`${out}.status`, `state=${state}\n`);
    assert.equal(TERMINAL_JOB_STATES.test(state), true);
    assert.equal(recordJob(out), true);
    const record = readJsonl(paths.jobs).at(-1);
    assert.equal(record.state, state);
    for (const field of ["started", "finished", "model", "pid"]) assert.equal(record[field], "");
  }
  assert.equal(TERMINAL_JOB_STATES.test("abandoned"), false);
});

test("status hashes enforce the raw byte limit and reject non-files without throwing", () => {
  const out = path.join(HOME_CLAUDE, "fake.out.md");
  const status = job(out);
  fs.writeFileSync(status, "state=done\n" + "x".repeat(64 * 1024 - 11));
  const sha = createHash("sha256").update(fs.readFileSync(status)).digest("hex");
  assert.equal(statusSha256(status), sha);
  assert.equal(recordJob(out), true);
  fs.appendFileSync(status, "x");
  assert.equal(statusSha256(status), null);
  assert.equal(recordJob(out), false);
  assert.equal(statusSha256(HOME_CLAUDE), null);
  assert.equal(statusSha256(path.join(HOME_CLAUDE, "missing.status")), null);
  assert.equal(statusSha256(null), null);
  assert.equal(readJsonl(paths.jobs).length, 1);
});

test("normaliseJobOut resolves missing leaves, path spellings and canonical directory aliases", () => {
  const directory = path.join(HOME_CLAUDE, "repo");
  fs.mkdirSync(directory);
  const out = path.join(directory, "missing", "fake.out.md");
  const expected = toWinPath(out);
  assert.equal(normaliseJobOut(out), process.platform === "win32" ? expected.toLowerCase() : expected);
  assert.equal(normaliseJobOut(out.replace(/\\/g, "/").replace(/\//g, "\\")), normaliseJobOut(out));
  for (const value of ["relative.out.md", "", null, 42, "\0"]) assert.equal(normaliseJobOut(value), null);
  const alias = path.join(HOME_CLAUDE, "alias");
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(normaliseJobOut(path.join(alias, "missing", "fake.out.md")), normaliseJobOut(out));
  assert.equal(registryHas(null, "bad", paths.jobs), false);
});

test("registry cache reuses unchanged maps and notices metadata changes and missing files", () => {
  const out = path.join(HOME_CLAUDE, "fake.out.md");
  job(out);
  assert.equal(loadJobRegistry().size, 0);
  assert.equal(recordJob(out), true);
  const loaded = loadJobRegistry();
  assert.equal(loadJobRegistry(), loaded);
  const record = readJsonl(paths.jobs)[0];
  fs.writeFileSync(paths.jobs, encode({ ...record, v: 2 }));
  const changed = new Date(fs.statSync(paths.jobs).mtimeMs + 2000);
  fs.utimesSync(paths.jobs, changed, changed);
  assert.equal(loadJobRegistry().size, 0);
  fs.unlinkSync(paths.jobs);
  assert.equal(loadJobRegistry().size, 0);
  assert.equal(recordJob(out), true);
  assert.notEqual(loadJobRegistry(), loaded);
  assert.equal(registryHas(out, record.status_sha256), true);
});

test("registry hits trust project jobs, assumptions and critics with normalized output paths", async () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  write(out, "Assumption: local defaults\n- **[high]** Finding\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  job(out);
  const spelling = process.platform === "win32"
    ? toWinPath(out).replace(/^([A-Z]):/i, (_, drive) => `${drive.toLowerCase()}:`).replace(/\//g, "\\")
    : path.join(path.dirname(out), "..", "report", path.basename(out));
  assert.equal(recordJob(spelling), true);
  assert.equal(isTrustedJobPath(out), false);
  assert.equal(isTrustedJob(out), true);
  if (process.platform === "win32") {
    assert.equal(isTrustedJob(toWinPath(out).replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`)), true);
  }
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 3);
  assert.deepEqual(events().map((event) => event.type), ["luna_job", "executor_assumption", "critic_output"]);
  for (const event of events()) {
    assert.equal(event.data.trusted, true);
    assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  }
});

test("status changes after registration revoke trust and reject forged trusted events", async () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  write(out, "Assumption: local defaults\n");
  job(out);
  assert.equal(recordJob(out), true);
  assert.equal(isTrustedJob(out), true);
  fs.appendFileSync(`${out}.status`, "error=changed after registration\n");
  assert.equal(isTrustedJob(out), false);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 2);
  for (const event of events()) {
    assert.equal(event.data.trusted, false);
    assert.deepEqual(await verifyEventProvenance({ ...event, data: { ...event.data, trusted: true } }),
      { ok: false, reason: "untrusted job path" });
  }
});

test("missing job registries leave project jobs untrusted without preventing extraction", async () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  write(out, "Assumption: local defaults\n");
  job(out);
  assert.equal(fs.existsSync(paths.jobs), false);
  assert.equal(isTrustedJob(out), false);
  assert.equal(isTrustedJob(out, { registry: path.join(LEARN_DIR, "missing.jsonl") }), false);
  assert.equal(isTrustedJob("relative.out.md"), false);
  assert.equal(isTrustedJob(null), false);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 2);
  for (const event of events()) assert.equal(event.data.trusted, false);
});

test("registry ignores malformed and ineligible records and accepts a later valid line", async () => {
  const out = path.join(HOME_CLAUDE, "repo", "report", "fake.out.md");
  write(out, "Assumption: local defaults\n");
  job(out);
  const record = registryRecord(out);
  const registry = path.join(LEARN_DIR, "override.jsonl");
  const jobRoots = { registry };
  write(registry, "\uFEFFgarbage\r\n\r\nnull\r\n" + [
    [], { ...record, v: 2 }, { ...record, state: "running" }, { ...record, state: "abandoned" },
    { ...record, status_sha256: "bad" },
    { ...record, status_sha256: record.status_sha256.toUpperCase() }, { ...record, out: "relative.out.md" },
    { ...record, padding: "x".repeat(64 * 1024) },
  ].map((line) => encode(line, "\r\n")).join(""));
  assert.equal(isTrustedJob(out, jobRoots), false);
  fs.appendFileSync(registry, "\uFEFF" + encode(record, "\r\n"));
  assert.equal(isTrustedJob(out, jobRoots), true);
  assert.equal(isTrustedJob(out), false);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run({ jobRoots })).new_events, 2);
  for (const event of events()) {
    assert.equal(event.data.trusted, true);
    assert.equal((await verifyEventProvenance(event, jobRoots)).ok, true);
    assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "untrusted job path" });
  }
});

test("matching registry records cannot trust outputs in the learning directory", () => {
  const out = write(path.join(LEARN_DIR, "fake.out.md"), "Assumption: learning data\n");
  job(out);
  assert.equal(recordJob(out), true);
  assert.equal(isTrustedJob(out), false);
  assert.equal(isTrustedJob(out, { lunaRun: LEARN_DIR }), false);
  job(LEARN_DIR);
  assert.equal(recordJob(LEARN_DIR), true);
  assert.equal(isTrustedJob(LEARN_DIR), false);
});

test("matching registry records cannot trust symlinked status files", (t) => {
  const out = write(path.join(HOME_CLAUDE, "repo", "fake.out.md"), "Assumption: local defaults\n");
  const target = job(path.join(HOME_CLAUDE, "target.out.md"));
  try { fs.symlinkSync(target, `${out}.status`, "file"); } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
    t.skip(`status symlinks unavailable: ${error.code}`);
    return;
  }
  write(paths.jobs, encode(registryRecord(out)));
  assert.equal(isTrustedJob(out), false);
});

test("provenance rechecks the registry after a trusted extraction and notices deletion", async () => {
  const out = write(path.join(HOME_CLAUDE, "repo", "fake.out.md"), "Assumption: local defaults\n");
  job(out);
  assert.equal(recordJob(out), true);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 2);
  for (const event of events()) {
    assert.equal(event.data.trusted, true);
    assert.equal((await verifyEventProvenance(event)).ok, true);
  }
  fs.unlinkSync(paths.jobs);
  assert.equal(isTrustedJob(out), false);
  for (const event of events()) {
    assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "untrusted job path" });
  }
  assert.equal(recordJob(out), true);
  assert.equal(recordJob(out), true);
  for (const event of events()) {
    assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  }
});

test("registry trust requires a regular status file no larger than 64 KiB", () => {
  const out = write(path.join(HOME_CLAUDE, "repo", "fake.out.md"), "result\n");
  job(out);
  const record = registryRecord(out);
  write(paths.jobs, "\uFEFF" + encode(record));
  assert.equal(isTrustedJob(out), true);
  fs.writeFileSync(`${out}.status`, Buffer.alloc(64 * 1024, 120));
  write(paths.jobs, encode(registryRecord(out)));
  assert.equal(isTrustedJob(out), true);
  fs.appendFileSync(`${out}.status`, "x");
  write(paths.jobs, encode(registryRecord(out)));
  assert.equal(isTrustedJob(out), false);
  fs.unlinkSync(`${out}.status`);
  fs.mkdirSync(`${out}.status`);
  assert.equal(isTrustedJob(out), false);
  fs.rmdirSync(`${out}.status`);
  assert.equal(isTrustedJob(out), false);
});

test("large registries read the last 64 MiB and discard the first partial line", () => {
  const out = write(path.join(HOME_CLAUDE, "repo", "fake.out.md"), "result\n");
  job(out);
  const record = registryRecord(out);
  const limit = 64 * 1024 * 1024;
  const descriptor = fs.openSync(paths.jobs, "w");
  try {
    fs.writeSync(descriptor, encode(record));
    fs.ftruncateSync(descriptor, limit + 1024);
  } finally { fs.closeSync(descriptor); }
  assert.equal(isTrustedJob(out), false);
  fs.appendFileSync(paths.jobs, "\n" + encode(record));
  assert.equal(isTrustedJob(out), true);
});

test("job events capture the SHA-256 of the raw status bytes", async () => {
  const out = write(path.join(statusRoot, "review.out.md"), "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  const status = job(out, "done", "error=проверка\r\n");
  const sha = createHash("sha256").update(fs.readFileSync(status)).digest("hex");
  assert.equal((await run()).new_events, 3);
  assert.deepEqual(events().map((event) => event.type), ["luna_job", "executor_assumption", "critic_output"]);
  for (const event of events()) assert.equal(event.data.status_sha256, sha, event.type);
  assert.deepEqual(readJsonl(paths.attest), events().map((event) => ({
    v: 1, id: event.id, type: event.type, out: normaliseJobOut(out),
    status_sha256: sha, event_sha256: eventDigest(event),
  })));
  assert.equal((await run()).new_events, 0);
  assert.equal(readJsonl(paths.attest).length, 3);
});

test("canonicalJson sorts nested keys, preserves array order and follows JSON undefined handling", () => {
  const left = { z: [{ y: 2, x: 1 }, undefined, { b: undefined, a: 3 }], a: { d: 4, c: 5 } };
  const right = { a: { c: 5, d: 4 }, z: [{ x: 1, y: 2 }, undefined, { a: 3 }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(left), '{"a":{"c":5,"d":4},"z":[{"x":1,"y":2},null,{"a":3}]}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("eventDigest covers every event field except captured and ignores nested key order", () => {
  const event = {
    v: 1, id: "id", type: "luna_job", ts: timestamp, captured: timestamp,
    session: "session", project: "project", source: "source", quote: "quote", context: "context",
    data: { state: "done", findings: { high: 1, low: 2 } }, extra: "covered",
  };
  const { captured, ...rest } = event;
  const expected = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  assert.equal(eventDigest(event), expected);
  assert.equal(eventDigest({ ...event, captured: "later" }), expected);
  assert.equal(eventDigest(rest), expected);
  assert.equal(eventDigest({ ...event, data: { findings: { low: 2, high: 1 }, state: "done" } }), expected);
  for (const key of Object.keys(rest)) {
    assert.notEqual(eventDigest({ ...event, [key]: "changed" }), expected, key);
  }
});

test("capture does not attest untrusted job events or events without a status hash", async () => {
  const out = write(path.join(HOME_CLAUDE, "repo", "review.out.md"),
    "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  job(out);
  transcript([human("нет, исправь"), bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  assert.equal((await run()).new_events, 4);
  const untrusted = events().filter((event) => event.type !== "user_correction");
  assert.deepEqual(untrusted.map((event) => event.type), ["luna_job", "executor_assumption", "critic_output"]);
  for (const event of untrusted) assert.equal(event.data.trusted, false);
  assert.equal(events("user_correction")[0].data.status_sha256, undefined);
  assert.deepEqual(readJsonl(paths.attest), []);
  assert.equal(fs.existsSync(paths.attest), false);
});

async function captureRegisteredReview() {
  const out = write(path.join(statusRoot, "review.out.md"), "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  const status = job(out);
  const jobRoots = {
    registry: path.join(LEARN_DIR, "registry-override.jsonl"),
    attest: path.join(LEARN_DIR, "attest-override.jsonl"),
    attestOld: path.join(LEARN_DIR, "attest-old-override.jsonl"),
  };
  assert.equal(recordJob(out, jobRoots), true);
  assert.equal((await run({ jobRoots })).new_events, 3);
  fs.renameSync(paths.attest, jobRoots.attest);
  return { out, status, jobRoots, captured: events() };
}

test("missing sources require capture-time attestations and reject subsequent row edits", async () => {
  const { out, status, jobRoots, captured } = await captureRegisteredReview();
  fs.unlinkSync(out);
  fs.unlinkSync(status);
  for (const event of captured) {
    assert.deepEqual(await verifyEventProvenance(event, jobRoots), { ok: true, reason: "verified" });
    assert.equal((await verifyEventProvenance({ ...event, captured: "later" }, jobRoots)).ok, true);
    const reason = event.type === "luna_job"
      ? "status file gone and not in registry" : "output file gone and not in registry";
    const changedData = event.type === "luna_job" ? { ...event.data, state: "failed" }
      : event.type === "executor_assumption" ? { ...event.data, job_state: "failed" }
        : { ...event.data, findings: { ...event.data.findings, high: 99 } };
    for (const change of [
      { quote: "forged quote" }, { data: changedData },
      { session: "forged-session" }, { project: "forged-project" },
    ]) {
      assert.deepEqual(await verifyEventProvenance({ ...event, ...change }, jobRoots), { ok: false, reason });
    }
  }
});

test("missing sources fail without attest files, while present sources need none", async () => {
  const { out, status, jobRoots, captured } = await captureRegisteredReview();
  fs.unlinkSync(jobRoots.attest);
  for (const event of captured) {
    assert.deepEqual(await verifyEventProvenance(event, jobRoots), { ok: true, reason: "verified" });
  }
  fs.unlinkSync(out);
  fs.unlinkSync(status);
  for (const event of captured) {
    assert.deepEqual(await verifyEventProvenance(event, jobRoots), {
      ok: false, reason: event.type === "luna_job"
        ? "status file gone and not in registry" : "output file gone and not in registry",
    });
  }
});

test("fallback finds rotated attestations and skips malformed or mismatched records without caching", async () => {
  const { out, status, jobRoots, captured } = await captureRegisteredReview();
  const records = readJsonl(jobRoots.attest);
  fs.unlinkSync(out);
  fs.unlinkSync(status);
  fs.renameSync(jobRoots.attest, jobRoots.attestOld);
  for (const event of captured) {
    const record = records.find((row) => row.id === event.id);
    const reason = event.type === "luna_job"
      ? "status file gone and not in registry" : "output file gone and not in registry";
    assert.deepEqual(await verifyEventProvenance(event, jobRoots), { ok: true, reason: "verified" });
    write(jobRoots.attestOld, "not json\nnull\n[]\n");
    for (const change of [
      { id: "other" }, { type: "other" }, { out: path.join(statusRoot, "other.out.md") },
      { status_sha256: "0".repeat(64) }, { event_sha256: "0".repeat(64) },
    ]) {
      write(jobRoots.attest, encode({ ...record, ...change }));
      assert.deepEqual(await verifyEventProvenance(event, jobRoots), { ok: false, reason });
    }
    const normalisedAlias = toWinPath(path.dirname(out)) + "/./" + path.basename(out);
    fs.appendFileSync(jobRoots.attestOld, encode({ ...record, out: normalisedAlias }));
    assert.deepEqual(await verifyEventProvenance(event, jobRoots), { ok: true, reason: "verified" });
    write(jobRoots.attestOld, records.map((row) => encode(row)).join(""));
  }
});

test("missing status provenance requires the captured hash and matching registry output", async () => {
  const out = path.join(statusRoot, "job.out.md");
  const status = job(out);
  const record = registryRecord(out);
  await run();
  const [event] = events("luna_job");
  assert.equal(readJsonl(paths.attest).some((record) => record.event_sha256 === eventDigest(event)), true);
  fs.unlinkSync(status);
  for (const records of [[], [{ ...record, status_sha256: "0".repeat(64) }],
    [{ ...record, out: path.join(statusRoot, "other.out.md") }]]) {
    write(paths.jobs, records.map((row) => encode(row)).join(""));
    assert.deepEqual(await verifyEventProvenance(event), {
      ok: false, reason: "status file gone and not in registry",
    });
  }
  write(paths.jobs, encode(record));
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  for (const status_sha256 of [undefined, null, "", "bad", "g".repeat(64), 42]) {
    assert.deepEqual(await verifyEventProvenance({ ...event, data: { ...event.data, status_sha256 } }), {
      ok: false, reason: "status file gone and not in registry",
    });
  }
});

test("missing job files use the configured registry and require trusted to be exactly true", async () => {
  const out = write(path.join(statusRoot, "review.out.md"), "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  const status = job(out);
  const registry = path.join(LEARN_DIR, "override.jsonl");
  assert.equal(recordJob(out, { registry }), true);
  await run();
  assert.equal(readJsonl(paths.attest).length, 3);
  fs.unlinkSync(out);
  fs.unlinkSync(status);
  for (const event of events()) {
    const reason = event.type === "luna_job"
      ? "status file gone and not in registry" : "output file gone and not in registry";
    assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason });
    assert.deepEqual(await verifyEventProvenance(event, { registry }), { ok: true, reason: "verified" });
    for (const trusted of [false, undefined, null, "true", 1]) {
      assert.deepEqual(await verifyEventProvenance({ ...event, data: { ...event.data, trusted } }, { registry }), {
        ok: false, reason,
      });
    }
  }
});

test("missing assumptions and critic outputs require a matching status hash in the registry", async () => {
  const out = write(path.join(statusRoot, "review.out.md"), "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  job(out);
  const record = registryRecord(out);
  await run();
  assert.equal(readJsonl(paths.attest).length, 3);
  fs.unlinkSync(out);
  for (const event of events().filter((event) => event.type !== "luna_job")) {
    for (const records of [[], [{ ...record, status_sha256: "0".repeat(64) }]]) {
      write(paths.jobs, records.map((row) => encode(row)).join(""));
      assert.deepEqual(await verifyEventProvenance(event), {
        ok: false, reason: "output file gone and not in registry",
      });
    }
    write(paths.jobs, encode(record));
    assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
    const legacy = { ...event, data: { ...event.data } };
    delete legacy.data.status_sha256;
    assert.deepEqual(await verifyEventProvenance(legacy), {
      ok: false, reason: "output file gone and not in registry",
    });
  }
});

test("registry fallback still requires isTrustedJob after files are deleted", async () => {
  const out = write(path.join(HOME_CLAUDE, "repo", "job.out.md"), "Assumption: local defaults\n");
  const status = job(out);
  assert.equal(recordJob(out), true);
  transcript([bash(`bash luna.sh -o "${toWinPath(out)}"`)]);
  await run();
  assert.equal(readJsonl(paths.attest).length, 2);
  fs.unlinkSync(out);
  const [event] = events("executor_assumption");
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  fs.unlinkSync(status);
  assert.equal(isTrustedJob(out), false);
  for (const captured of events()) {
    assert.deepEqual(await verifyEventProvenance(captured), {
      ok: false, reason: captured.type === "luna_job"
        ? "status file gone and not in registry" : "output file gone and not in registry",
    });
  }
});

test("old status events remain valid with unchanged files and fail when their data changes", async () => {
  const out = path.join(statusRoot, "job.out.md");
  job(out);
  await run();
  const [captured] = events("luna_job");
  const event = { ...captured, data: { ...captured.data } };
  delete event.data.status_sha256;
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  job(out, "failed");
  assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "status mismatch" });
});

test("new status events detect byte changes even when parsed status fields are unchanged", async () => {
  const out = path.join(statusRoot, "job.out.md");
  const status = job(out);
  await run();
  const [event] = events("luna_job");
  fs.appendFileSync(status, "ignored line without equals\n");
  assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "status mismatch" });
});

test("registry fallback does not accept non-file sources or a missing assumption status alone", async () => {
  const out = write(path.join(statusRoot, "review.out.md"), "Assumption: local defaults\nTop concern: finding\n");
  write(out.replace(".out.md", ".brief.md"), "Review scope");
  const status = job(out);
  assert.equal(recordJob(out), true);
  await run();
  const [event] = events("luna_job");
  const [assumption] = events("executor_assumption");
  fs.unlinkSync(status);
  assert.equal((await verifyEventProvenance(assumption)).ok, false);
  fs.mkdirSync(status);
  assert.deepEqual(await verifyEventProvenance(event), { ok: false, reason: "invalid status source" });
  fs.unlinkSync(out);
  fs.mkdirSync(out);
  for (const captured of events().filter((row) => row.type !== "luna_job")) {
    assert.deepEqual(await verifyEventProvenance(captured), { ok: false, reason: "invalid output source" });
  }
});

test("status provenance recomputes every data field and the sanitised error quote", async () => {
  const out = path.join(statusRoot, "job.out.md");
  job(out, "incomplete", "retry=1\nmissing=Verification\nerror=bad <b>result</b>\n");
  await run();
  const [event] = events("luna_job");
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  assert.equal(event.quote, "bad result");
  for (const [field, value] of Object.entries(event.data)) {
    const changed = typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : "forged";
    assert.equal((await verifyEventProvenance({
      ...event, data: { ...event.data, [field]: changed },
    })).ok, false, field);
    const missing = { ...event.data };
    delete missing[field];
    assert.equal((await verifyEventProvenance({ ...event, data: missing })).ok,
      field === "status_sha256", `missing ${field}`);
  }
  assert.equal((await verifyEventProvenance({ ...event, quote: "forged error" })).ok, false);
  job(out, "incomplete", "retry=0\nmissing=Verification\nerror=changed\n");
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("assumption provenance requires the exact Assumption source line and sanitised capture", async () => {
  const out = path.join(statusRoot, "job.out.md");
  const capture = "use <b>local</b> defaults sk-abcdefghijklmnopqrstuvwx";
  write(out, `Ordinary text\n- **Assumption:** ${capture}\nAssumption: other\n`);
  job(out);
  await run();
  const [event] = events("executor_assumption");
  assert.equal(event.quote, "use local defaults [redacted]");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.status_sha256;
  assert.equal((await verifyEventProvenance(legacy)).ok, true);
  for (const source of [`${toWinPath(out)}#L1`, `${toWinPath(out)}#L3`, `${toWinPath(out)}#L0`, out]) {
    assert.equal((await verifyEventProvenance({ ...event, source })).ok, false, source);
  }
  assert.equal((await verifyEventProvenance({ ...event, quote: "local defaults" })).ok, false);
  for (const data of [{ ...event.data, trusted: false }, { ...event.data, job_state: "failed" }]) {
    assert.equal((await verifyEventProvenance({ ...event, data })).ok, false);
  }
  write(out, `Ordinary text\n${capture}\nAssumption: other\n`);
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("critic provenance recomputes counts, findings text, Top concern and brief presence", async () => {
  const out = path.join(statusRoot, "review.out.md");
  const brief = write(out.replace(".out.md", ".brief.md"), "Review scope");
  write(out, "- **[high]** Real <b>finding</b>\nTop concern: a <b>problem</b>\n");
  job(out);
  await run();
  const [event] = events("critic_output");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.status_sha256;
  assert.equal((await verifyEventProvenance(legacy)).ok, true);
  for (const changed of [
    { quote: "invented concern" },
    { data: { ...event.data, findings: { ...event.data.findings, high: 2 } } },
    { data: { ...event.data, findings_text: [{ severity: "high", title: "invented finding" }] } },
    { data: { ...event.data, trusted: false } },
  ]) assert.equal((await verifyEventProvenance({ ...event, ...changed })).ok, false);
  write(out, "- **[high]** Changed title\nTop concern: a problem\n");
  assert.equal((await verifyEventProvenance(event)).ok, false);
  write(out, "- **[high]** Real finding\nTop concern: a problem\n");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  fs.unlinkSync(brief);
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("synthesis provenance recomputes the first qualifying block, quote and counts", async () => {
  transcript([assistant([
    { type: "text", text: "Critic panel\nAccepted: first\nRejected: second" },
    { type: "text", text: "Critic panel\nAccepted: other\nAccepted: another" },
  ])]);
  await run();
  const [event] = events("critic_synthesis");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  for (const changed of [
    { quote: "Accepted: other / Accepted: another" },
    { data: { ...event.data, accepted: 2 } }, { data: { ...event.data, rejected: 0 } },
  ]) assert.equal((await verifyEventProvenance({ ...event, ...changed })).ok, false);
});

test("interrupt provenance requires the next genuine human quote and rejects an empty substitute", async () => {
  const file = transcript([
    human("[Request interrupted by user]"),
    human("notification", { origin: { kind: "task-notification" } }),
    human("use <b>blue</b> " + "button ".repeat(80)),
  ]);
  await run();
  const [event] = events("user_interrupt");
  assert.ok(event.quote.endsWith("…"));
  assert.equal((await verifyEventProvenance(event)).ok, true);
  for (const quote of ["invented reply", "use blue", ""]) {
    assert.equal((await verifyEventProvenance({ ...event, quote })).ok, false, quote);
  }
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.byte;
  assert.equal((await verifyEventProvenance(legacy)).ok, true);
  write(file, encode(human("ordinary message")) + encode(human(event.quote)));
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("empty interrupt provenance stops at the next assistant and scans beyond fifty lines", async () => {
  const file = transcript([human("[Request interrupted by user]")]);
  await run();
  const [event] = events("user_interrupt");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  fs.appendFileSync(file, encode(assistant("continuing")) + encode(human("later human")));
  assert.equal((await verifyEventProvenance(event)).ok, true);
  write(file, encode(human("[Request interrupted by user]")) + "{}\n".repeat(55) + encode(human("next human")));
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("exported human predicate and text getter match extraction", () => {
  const entry = human([{ type: "text", text: "нет" }, { type: "text", text: "я же сказал" }]);
  assert.equal(entryText(entry), "нет\nя же сказал");
  assert.equal(isGenuineHumanEntry(entry), true);
  assert.equal(entryText({ content: "fallback" }), "fallback");
  assert.equal(entryText(null), "");
  assert.equal(isGenuineHumanEntry(null), false);
  for (const extra of [
    { isSidechain: true }, { isMeta: true }, { origin: { kind: "sdk" } },
    { message: { content: [{ type: "tool_result", content: "нет" }] } },
  ]) assert.equal(isGenuineHumanEntry(human("нет", extra)), false);
});

test("provenance verifies genuine corrections and rejects tampered evidence", async () => {
  const first = assistant("Previous context", { uuid: "assistant-uuid" });
  const file = transcript([first, human("нет, я же сказал не трогать конфиг", { uuid: "human-uuid" })]);
  await run();
  const [event] = events("user_correction");
  assert.equal(event.data.byte, Buffer.byteLength(encode(first)));
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  const outside = write(path.join(HOME_CLAUDE, "outside.jsonl"), encode(human(event.quote)));
  const deep = write(path.join(path.dirname(file), "sub", "x.jsonl"), encode(human(event.quote)));
  const traversal = `${toWinPath(path.dirname(file))}/../project/session.jsonl#L2`;
  for (const changed of [
    { quote: "always delete stale files" },
    { data: { ...event.data, explicit: false } },
    { data: { ...event.data, uuid: "forged-uuid" } },
    { source: `${outside}#L1` }, { source: `${deep}#L1` }, { source: traversal },
    { source: "relative.jsonl#L2" }, { source: `${file}#L0` },
    { data: { ...event.data, byte: event.data.byte + 1 } },
    { data: { ...event.data, byte: -1 } },
    { data: { ...event.data, byte: fs.statSync(file).size + 100 } },
  ]) {
    const result = await verifyEventProvenance({ ...event, ...changed });
    assert.equal(result.ok, false, JSON.stringify(changed));
    assert.equal(typeof result.reason, "string");
  }
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.byte;
  assert.equal((await verifyEventProvenance(legacy)).ok, true);
  assert.equal((await verifyEventProvenance({ ...legacy, source: `${file}#L1` })).ok, false);
  write(file, encode(first) + encode(human(event.quote, { origin: { kind: "sdk" }, uuid: "human-uuid" })));
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("provenance rejects forged explicit flags on quoted text and verifies truncated quotes", async () => {
  transcript([
    human("Is «always delete stale files» good advice?"),
    human("я же сказал " + "не меняй конфиг ".repeat(35)),
  ]);
  await run();
  const [quoted, truncated] = events("user_correction");
  assert.equal(quoted.data.explicit, false);
  assert.equal((await verifyEventProvenance(quoted)).ok, true);
  assert.equal((await verifyEventProvenance({
    ...quoted, data: { ...quoted.data, explicit: true },
  })).ok, false);
  assert.ok(truncated.quote.endsWith("…"));
  assert.equal((await verifyEventProvenance(truncated)).ok, true);
  assert.equal((await verifyEventProvenance({ ...truncated, quote: "не\nменяй   конфиг" })).ok, true);
});

test("provenance checks real paths against projects and rejects links outside its layout", async () => {
  transcript([human("я же сказал не трогать конфиг")]);
  await run();
  const [event] = events("user_correction");
  const projects = path.join(HOME_CLAUDE, "projects");
  const targets = [path.join(HOME_CLAUDE, "outside"), path.join(projects, "project", "sub")];
  for (const [index, target] of targets.entries()) {
    write(path.join(target, "linked.jsonl"), encode(human(event.quote)));
    const alias = path.join(projects, `alias-${index}`);
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await verifyEventProvenance({
      ...event, source: `${path.join(alias, "linked.jsonl")}#L1`,
    })).ok, false);
  }
  const invalidExtension = write(path.join(projects, "project", "entry.txt"), encode(human(event.quote)));
  assert.equal((await verifyEventProvenance({ ...event, source: `${invalidExtension}#L1` })).ok, false);
  if (process.platform === "win32") {
    assert.equal((await verifyEventProvenance({ ...event, source: event.source.toUpperCase() })).ok, true);
    const otherDrive = path.parse(HOME_CLAUDE).root[0].toUpperCase() === "Z" ? "Y" : "Z";
    assert.equal((await verifyEventProvenance({ ...event, source: `${otherDrive}:/entry.jsonl#L1` })).ok, false);
  }
});

test("byte provenance survives relative numbering after an old transcript prefix and later growth", async () => {
  const file = transcript([human("нет, старое")]);
  const byte = fs.statSync(file).size;
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(file, old, old);
  await run({ backfillDays: 30 });
  fs.appendFileSync(file, encode(human("я же сказал не трогать конфиг", { uuid: "new-uuid" })));
  await run();
  const [event] = events("user_correction");
  assert.match(event.source, /#L1$/);
  assert.equal(event.data.byte, byte);
  fs.appendFileSync(file, encode(human("ещё одно сообщение")));
  assert.equal((await verifyEventProvenance(event)).ok, true);
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.byte;
  assert.equal((await verifyEventProvenance(legacy)).ok, false);
});

test("interrupts and synthesis carry and verify their source bytes", async () => {
  const first = human("ordinary message");
  const interrupt = human("[Request interrupted by user]");
  const last = assistant("Critic panel: accepted");
  const file = transcript([first, interrupt, last]);
  await run();
  const [interruption] = events("user_interrupt");
  const [synthesis] = events("critic_synthesis");
  assert.equal(interruption.data.byte, Buffer.byteLength(encode(first)));
  assert.equal(synthesis.data.byte, Buffer.byteLength(encode(first) + encode(interrupt)));
  assert.equal((await verifyEventProvenance(interruption)).ok, true);
  assert.equal((await verifyEventProvenance(synthesis)).ok, true);
  for (const event of [interruption, synthesis]) {
    assert.equal((await verifyEventProvenance({
      ...event, source: `${file}#L1`, data: { ...event.data, byte: 0 },
    })).ok, false);
  }
});

test("provenance rechecks status state and finished timestamp", async () => {
  const out = path.join(statusRoot, "job.out.md");
  job(out);
  await run();
  const [event] = events("luna_job");
  assert.equal((await verifyEventProvenance(event)).ok, true);
  job(out, "failed");
  assert.equal((await verifyEventProvenance(event)).ok, false);
  job(out, "done", "finished=2026-10-20T10:02:00.000Z\n");
  assert.equal((await verifyEventProvenance(event)).ok, false);
  fs.unlinkSync(`${out}.status`);
  assert.equal((await verifyEventProvenance(event)).ok, false);
});

test("provenance verifies assumptions and persona files and fails closed on unknown types", async () => {
  const out = path.join(statusRoot, "reviewer.out.md");
  write(out, "Assumption: use local defaults\n- **[high]** A real finding\n");
  write(path.join(statusRoot, "reviewer.brief.md"), "Review scope");
  job(out);
  await run();
  const [assumption] = events("executor_assumption");
  const [critic] = events("critic_output");
  assert.equal((await verifyEventProvenance(assumption)).ok, true);
  assert.equal((await verifyEventProvenance(critic)).ok, true);
  assert.equal((await verifyEventProvenance({ ...assumption, quote: "invented assumption" })).ok, false);
  assert.equal((await verifyEventProvenance({ ...critic, data: { ...critic.data, persona: "review" } })).ok, false);
  write(out, "Result no longer contains the assumption");
  assert.equal((await verifyEventProvenance(assumption)).ok, false);
  fs.unlinkSync(out);
  assert.equal((await verifyEventProvenance(critic)).ok, false);
  assert.deepEqual(await verifyEventProvenance({ type: "forged" }), { ok: false, reason: "unknown type" });
  assert.deepEqual(await verifyEventProvenance(null), { ok: false, reason: "unknown type" });
});

test("interrupt uses the following human message and the interrupt's source", async () => {
  transcript([
    human("[Request interrupted by user for tool use]", { turnOrigin: "sdk" }),
    human("ignore notification", { origin: { kind: "task-notification" } }), human("сделай кнопку синей"),
  ]);
  await run();
  assert.equal(events().length, 1);
  const [event] = events("user_interrupt");
  assert.equal(event.quote, "сделай кнопку синей");
  assert.match(event.source, /#L1$/);
});

test("an unpaired interrupt is emitted once with an empty quote", async () => {
  const file = transcript([human("[Request interrupted by user]")]);
  await run({ transcript: file });
  fs.appendFileSync(file, encode(human("сделай кнопку синей")));
  await run({ transcript: file });
  assert.equal(events("user_interrupt").length, 1);
  assert.equal(events()[0].quote, "");
});

test("incremental offsets consume complete CRLF lines and retain a partial UTF-8 line", async () => {
  const file = transcript([human("нет, первое")], "increment", "\r\n");
  assert.equal((await run({ transcript: file })).new_events, 1);
  const third = encode(human("нет, третье"), "\r\n");
  const fourth = encode(human("нет, четвёртое"), "\r\n");
  const partial = Buffer.from(fourth);
  // Cut inside the first Cyrillic code point; it must be re-read, never decoded prematurely.
  const cut = partial.indexOf(Buffer.from("нет")) + 1;
  fs.appendFileSync(file, encode(human("нет, второе"), "\r\n") + third);
  fs.appendFileSync(file, partial.subarray(0, cut));
  assert.equal((await run({ transcript: file })).new_events, 2);
  let saved = readJson(paths.extractState, null).files[toWinPath(file)];
  assert.equal(saved.lines, 3);
  assert.equal(saved.offset, fs.statSync(file).size - cut);
  fs.appendFileSync(file, partial.subarray(cut));
  assert.equal((await run({ transcript: file })).new_events, 1);
  assert.equal((await run({ transcript: file })).new_events, 0);
  saved = readJson(paths.extractState, null).files[toWinPath(file)];
  assert.equal(saved.offset, fs.statSync(file).size);
  assert.equal(saved.lines, 4);
  assert.match(events().at(-1).source, /#L4$/);
});

test("truncation restarts from zero and deduplication preserves existing evidence", async () => {
  const first = human("нет, первое");
  const file = transcript([first, assistant("padding ".repeat(100))]);
  await run({ transcript: file });
  write(file, encode(first));
  assert.equal((await run({ transcript: file })).new_events, 0);
  assert.equal(readJson(paths.extractState, null).files[toWinPath(file)].offset, fs.statSync(file).size);
  assert.equal(events().length, 1);
});

test("malformed JSON is consumed and later valid lines keep correct source numbers", async () => {
  const file = transcript([human("нет, первое")]);
  fs.appendFileSync(file, "{broken}\n" + encode(human("не надо так")));
  assert.equal((await run()).new_events, 2);
  assert.match(events().at(-1).source, /#L3$/);
});

test("Bash discovery treats special filenames literally and captures terminal job assumptions once", async () => {
  const out = path.join(HOME_CLAUDE, "results", "job one $(x).out.md");
  write(out, "Assumption: local default\n- **Assumption:** second default\n");
  job(out, "incomplete", "missing=Not done\r\nretry=1\r\nerror=reason=a=b\r\n");
  const file = transcript([bash(`bash ~/.claude/scripts/luna.sh -w -f "/c/x/b.md" -o "${toWinPath(out)}"`)]);
  assert.equal((await run({ transcript: file })).new_events, 3);
  const [event] = events("luna_job");
  assert.equal(event.session, "session");
  assert.equal(event.data.notable, true);
  assert.equal(event.data.retry, 1);
  assert.equal(event.data.rc, 0);
  assert.equal(event.data.missing, "Not done");
  assert.equal(event.quote, "reason=a=b");
  assert.equal(event.data.elapsed_s, 60);
  assert.equal(events("executor_assumption").length, 2);
  assert.equal((await run({ transcript: file })).new_events, 0);
});

test("root status scans retain running jobs and later capture them even with an old mtime", async () => {
  const out = path.join(statusRoot, "nested", "job.md");
  job(out, "running");
  assert.equal((await run()).new_events, 0);
  assert.equal(readJson(paths.extractState, null).outs[toWinPath(out)].done, false);
  job(out, "done");
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(`${out}.status`, old, old);
  assert.equal((await run()).new_events, 1);
  assert.equal(events()[0].project, "luna-run");
  assert.equal(events()[0].data.notable, false);
  assert.equal((await run()).new_events, 0);
});

test("panel markers expand at scan time and critic output reports persona and severity counts", async () => {
  const dir = path.join(HOME_CLAUDE, "panel space");
  write(path.join(dir, "attacker.max.brief.md"), "Review scope");
  const file = transcript([bash(`luna-panel.sh '${toWinPath(dir)}' high`)]);
  assert.equal((await run({ transcript: file })).new_events, 0);
  const out = path.join(dir, "attacker.max.out.md");
  write(out, "[severity: high] one\n[severity: high] two\n[critical] three\nTop concern: unsafe assumption\n");
  job(out);
  assert.equal((await run({ transcript: file })).new_events, 2);
  const [event] = events("critic_output");
  assert.equal(event.data.persona, "attacker");
  assert.deepEqual(event.data.findings, { critical: 1, high: 2, medium: 0, low: 0 });
  assert.equal(event.quote, "Top concern: unsafe assumption");
});

test("assistant synthesis counts accepted and rejected matches once per entry", async () => {
  transcript([assistant([
    { type: "text", text: "Critic panel: 3 accepted, 1 rejected (false positive)" },
    { type: "text", text: "Критики: принято, отклонено" },
  ])]);
  await run();
  assert.equal(events().length, 1);
  assert.deepEqual(events()[0].data, { uuid: null, byte: 0, accepted: 1, rejected: 1 });
  assert.equal(events()[0].quote, "Critic panel: 3 accepted, 1 rejected (false positive)");
});

test("critic findings retain up to ten sanitised titles in both heading formats", async () => {
  const out = path.join(statusRoot, "review.out.md");
  write(path.join(statusRoot, "review.high.brief.md"), "Review scope");
  const long = "title ".repeat(40);
  write(out, [
    "- **[severity: HIGH]** First <b>finding</b>",
    "* **[medium] Second finding** details",
    "- **[severity: low]** secret sk-abcdefghijklmnopqrstuvwx",
    `- **[critical] ${long}** details`,
    ...Array.from({ length: 8 }, (_, index) => `- **[low]** Finding ${index}`),
  ].join("\n"));
  job(out);
  await run();
  const [event] = events("critic_output");
  assert.deepEqual(event.data.findings, { critical: 1, high: 1, medium: 1, low: 9 });
  assert.equal(event.data.findings_text.length, 10);
  assert.deepEqual(event.data.findings_text.slice(0, 3), [
    { severity: "high", title: "First finding" },
    { severity: "medium", title: "Second finding" },
    { severity: "low", title: "secret [redacted]" },
  ]);
  assert.equal(event.data.findings_text[3].title.length, 200);
  assert.ok(event.data.findings_text[3].title.endsWith("…"));
  assert.equal(event.data.findings_text.at(-1).title, "Finding 5");
});

test("critic classification requires an exact stem with an optional supported effort", async () => {
  const cases = [
    ["foo", "bar.brief.md", false],
    ["same", "same.brief.md", true],
    ["effort", "effort.max.brief.md", true],
    ["unsupported", "unsupported.ultra.brief.md", false],
    ["prefix", "prefix-other.brief.md", false],
  ];
  for (const [name, brief] of cases) {
    const dir = path.join(statusRoot, name);
    write(path.join(dir, brief), "Review scope");
    write(path.join(dir, `${name}.out.md`), "- **[high]** finding\n");
    job(path.join(dir, `${name}.out.md`));
  }
  await run();
  assert.equal(events("luna_job").length, cases.length);
  assert.deepEqual(events("critic_output").map((event) => event.data.persona).sort(), ["effort", "same"]);
});

test("synthesis quotes retain accepted and rejected lines up to five and 400 characters", async () => {
  const lines = [
    "Critic panel overview", "Accepted: first", "Принято: второе", "Rejected: third", "Отклонено: четвёртое",
    "Accepted: fifth", "Rejected: sixth",
  ];
  transcript([assistant(lines.join("\n")), assistant("Critic panel\nAccepted: " + "title ".repeat(80))]);
  await run();
  const [first, second] = events("critic_synthesis");
  assert.equal(first.quote, lines.slice(1, 6).join(" / "));
  assert.equal(first.data.accepted, 3);
  assert.equal(first.data.rejected, 3);
  assert.equal(second.quote.length, 400);
  assert.ok(second.quote.endsWith("…"));
});

test("non-terminal statuses older than three hours become notable abandoned jobs once", async () => {
  const active = ["starting", "waiting-ram", "waiting-lock", "running"];
  const old = new Date(Date.now() - 3 * 3600000 - 60000);
  for (const state of active) {
    const file = job(path.join(statusRoot, `${state}.out.md`), state, "finished=\n");
    fs.utimesSync(file, old, old);
  }
  const fresh = path.join(statusRoot, "fresh.out.md");
  job(fresh, "running");
  assert.equal((await run()).new_events, active.length);
  for (const event of events("luna_job")) {
    assert.equal(event.data.state, "abandoned");
    assert.equal(event.data.notable, true);
    assert.equal(event.id, common.eventId("luna_job", event.data.out_path, timestamp, "abandoned"));
    assert.equal(readJson(paths.extractState, null).outs[event.data.out_path].done, true);
    assert.equal((await verifyEventProvenance(event)).ok, true);
  }
  assert.equal(readJson(paths.extractState, null).outs[toWinPath(fresh)].done, false);
  assert.equal((await run()).new_events, 0);
});

test("a line over 16 MB is skipped and a following correction retains its byte and line number", async () => {
  const file = transcript([], "long-line");
  const length = 17 * 1024 * 1024;
  fs.appendFileSync(file, Buffer.alloc(length, 120));
  fs.appendFileSync(file, "\n" + encode(human("я же сказал не трогать конфиг")));
  const result = await run();
  assert.equal(result.skipped_long_lines, 1);
  assert.equal(result.new_events, 1);
  const [event] = events("user_correction");
  assert.match(event.source, /#L2$/);
  assert.equal(event.data.byte, length + 1);
  assert.equal((await verifyEventProvenance(event)).ok, true);
  const legacy = { ...event, data: { ...event.data } };
  delete legacy.data.byte;
  assert.equal((await verifyEventProvenance(legacy)).ok, true);
  assert.equal((await run()).skipped_long_lines, 0);
  assert.equal(readJson(paths.extractState, null).files[toWinPath(file)].offset, fs.statSync(file).size);
});

test("an oversized partial line is skipped only when completed", async () => {
  const file = transcript([], "partial-long-line");
  fs.appendFileSync(file, Buffer.alloc(17 * 1024 * 1024, 120));
  assert.equal((await run()).skipped_long_lines, 0);
  assert.equal(readJson(paths.extractState, null).files[toWinPath(file)].offset, 0);
  fs.appendFileSync(file, "\n" + encode(human("нет, исправь")));
  const result = await run();
  assert.equal(result.skipped_long_lines, 1);
  assert.equal(result.new_events, 1);
});

test("extract lock contention skips capture, including while a stream is awaiting data", async () => {
  transcript([human("нет, первое")]);
  const release = common.tryLock("extract", 600000);
  try {
    assert.deepEqual(await run(), { ok: true, skipped: "locked" });
    assert.equal(events().length, 0);
  } finally { release(); }
  const first = run();
  assert.deepEqual(await run(), { ok: true, skipped: "locked" });
  assert.equal((await first).new_events, 1);
});

test("first backfill skips old bytes and reads a subsequent append", async () => {
  const file = transcript([human("нет, старое")]);
  const oldSize = fs.statSync(file).size;
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(file, old, old);
  assert.equal((await run({ backfillDays: 30 })).new_events, 0);
  assert.equal(readJson(paths.extractState, null).files[toWinPath(file)].offset, oldSize);
  fs.appendFileSync(file, encode(human("нет, новое")));
  assert.equal((await run()).new_events, 1);
  assert.equal(events()[0].quote, "нет, новое");
});

test("variables must be assigned earlier in the same command; extra status roots are excluded", async () => {
  const dir = toWinPath(path.join(HOME_CLAUDE, "vars"));
  const out = `${dir}/job.out.md`;
  write(out, "Assumption: fixture\n");
  job(out);
  const unknown = `${dir}/unknown.out.md`;
  job(unknown);
  const file = transcript([bash(`S="${dir}"\nbash luna.sh -o "$S/job.out.md" -o "$UNKNOWN/skip.md"`)]);
  assert.equal((await run({ transcript: file, statusRoots: [] })).new_events, 2);
  assert.equal(events("luna_job")[0].data.out_path, out);
  assert.equal(Object.keys(readJson(paths.extractState, null).outs).length, 1);
  assert.equal((await run({ statusRoots: [] })).new_events, 0);
});

test("full scans exclude deep transcripts and honor the status depth limit", async () => {
  transcript([human("нет, обычное")]);
  write(path.join(HOME_CLAUDE, "projects", "project", "subagents", "child.jsonl"), encode(human("нет, дочернее")));
  job(path.join(statusRoot, ...Array(7).fill("deep"), "hidden.md"));
  job(path.join(statusRoot, "visible.md"), "failed", "finished=invalid\nrefusal_suspected=1\n");
  await run();
  assert.equal(events("user_correction").length, 1);
  assert.equal(events("luna_job").length, 1);
  assert.equal(events("luna_job")[0].data.elapsed_s, null);
  assert.equal(Number.isFinite(Date.parse(events("luna_job")[0].ts)), true);
});

test("a 200 MB transcript reads only its new 10 KB tail in under one second", async () => {
  const file = transcript([], "large");
  const prefix = 200 * 1024 * 1024;
  const descriptor = fs.openSync(file, "r+");
  try { fs.ftruncateSync(descriptor, prefix); } finally { fs.closeSync(descriptor); }
  common.writeJsonAtomic(paths.extractState, {
    v: 1, lastFullScan: null, outs: {}, files: {
      [toWinPath(file)]: {
        offset: prefix, size: prefix, lines: 1000000, session: "large", project: "project",
        lastAssistant: "previous", pendingInterrupt: null,
      },
    },
  });
  fs.appendFileSync(file, encode(assistant("padding ".repeat(1250))) + encode(human("нет, только хвост")));
  const start = performance.now();
  const result = await run({ transcript: file });
  const elapsed = performance.now() - start;
  assert.equal(result.new_events, 1);
  assert.ok(elapsed < 1000, `incremental capture took ${elapsed} ms`);
  assert.match(events()[0].source, /#L1000002$/);
  assert.equal(readJson(paths.extractState, null).files[toWinPath(file)].offset, fs.statSync(file).size);
});

test("attestation rotation retains new records and replaces the previous generation", async () => {
  write(paths.attest, " ".repeat(5 * 1024 * 1024 + 1) + "\n");
  write(paths.attestOld, encode({ id: "obsolete" }));
  const out = path.join(statusRoot, "job.out.md");
  const status = job(out);
  assert.equal(recordJob(out), true);
  assert.equal((await run()).new_events, 1);
  const [event] = events("luna_job");
  assert.equal(fs.existsSync(paths.attest), false);
  assert.deepEqual(readJsonl(paths.attestOld), [{
    v: 1, id: event.id, type: event.type, out: normaliseJobOut(out),
    status_sha256: event.data.status_sha256, event_sha256: eventDigest(event),
  }]);
  fs.unlinkSync(status);
  assert.deepEqual(await verifyEventProvenance(event), { ok: true, reason: "verified" });
  assert.equal((await run()).new_events, 0);
});

test("rotation preserves newly appended events under the events lock", async () => {
  fs.writeFileSync(paths.events, " ".repeat(20 * 1024 * 1024 + 1) + "\n");
  transcript([human("нет, ротация")]);
  assert.equal((await run()).new_events, 1);
  assert.equal(fs.existsSync(paths.events), false);
  assert.equal(readJsonl(paths.eventsOld).length, 1);
  assert.equal((await run()).new_events, 0);
});

function hookProcess(input) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [hook], { env: { ...process.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - start }));
    child.stdin.end(input);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assertSilent(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(result.ms < 1500, `hook took ${result.ms} ms`);
}

test("real hook is silent, respects CAPTURE_OFF and launches detached extraction", async () => {
  const file = transcript([human("нет, hook correction")]);
  // A parallel loop implementation must not run reflection on this test's synthetic data.
  write(paths.paused, "test fixture");
  const input = JSON.stringify({ transcript_path: file, session_id: "s" });
  assertSilent(await hookProcess("garbage"));
  assertSilent(await hookProcess(JSON.stringify({ session_id: "s" })));
  write(paths.captureOff, "");
  assertSilent(await hookProcess(input));
  await delay(1500);
  assert.equal(events().length, 0);
  fs.unlinkSync(paths.captureOff);
  assertSilent(await hookProcess(input));
  const deadline = Date.now() + 10000;
  while (!events("user_correction").length && Date.now() < deadline) await delay(100);
  assert.equal(events("user_correction").length, 1);
  assert.equal(events()[0].quote, "нет, hook correction");
  // Wait for atomic state persistence and lock release before fixture cleanup.
  while (fs.existsSync(path.join(paths.locksDir, "extract")) && Date.now() < deadline) await delay(50);
  assert.equal(fs.existsSync(path.join(paths.locksDir, "extract")), false);
});
