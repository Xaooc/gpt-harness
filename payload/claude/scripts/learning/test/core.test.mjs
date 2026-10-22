import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "learning-core-"));
process.env.CLAUDE_HOME_DIR = path.join(temporary, "home");
process.env.CLAUDE_LEARNING_DIR = path.join(temporary, "data");
fs.mkdirSync(process.env.CLAUDE_HOME_DIR);
const core = await import("../core.mjs");
const common = await import("../common.mjs");
const { paths, HOME_CLAUDE } = common;
const coreFile = fileURLToPath(new URL("../core.mjs", import.meta.url));
const revertScript = fileURLToPath(new URL("../../learning-revert.sh", import.meta.url));
const originals = Object.fromEntries(core.TARGETS.map((target) => [
  target, fs.readFileSync(path.join(root, target)),
]));
const quote = "Always preserve the local change when undoing an adopted lesson.";
const fixtures = [
  { id: "a", type: "luna_job", session: "session-A", source: "a.status", data: { trusted: true } },
  { id: "b", type: "luna_job", session: "session-B", source: "b.status", data: { trusted: true } },
  { id: "correction", type: "user_correction", session: "session-A", source: "x.jsonl#L4",
    data: { explicit: false } },
  { id: "explicit", type: "user_correction", session: "session-C", source: "path/x.jsonl#L5",
    data: { explicit: true } },
  { id: "status", type: "user_correction", session: "session-D", source: "path/x.status",
    data: { explicit: true } },
].map((event) => ({
  ...event, ts: "2026-10-20T12:00:00.000Z",
  quote: event.id === "b" ? `${quote} A separate job result.` : quote,
  context: "A separate context sentence.",
}));
const editable = "## Division of labour: Claude orchestrates, Luna executes";
const replacement = "## Division of labour and careful execution";

function writeTarget(text, target = "CLAUDE.md") {
  fs.writeFileSync(path.join(HOME_CLAUDE, target), text);
}

function readTarget(target = "CLAUDE.md") {
  return fs.readFileSync(path.join(HOME_CLAUDE, target), "utf8");
}

function proposal(overrides = {}) {
  return {
    id: "P1", kind: "edit", target: "CLAUDE.md", op: "replace", old_text: editable,
    new_text: replacement, lesson: "Preserve local changes during undo.",
    summary_ru: "При откате сохраняются ручные изменения.", rationale: "Repeated across independent sessions.",
    confidence: "high", evidence: ["a", "b"].map((event_id) => ({ event_id, quote })), ...overrides,
  };
}

function context(overrides = {}) {
  const config = core.loadConfig();
  return {
    events: core.eventsIndex(), files: core.readTargets(config), config, adoptions: core.loadAdoptions(), ...overrides,
  };
}

function validate(p, overrides = {}) {
  return core.validateProposal(p, context(overrides));
}

function apply(p = proposal(), overrides = {}) {
  return core.applyEdit(p, {
    runId: "test-run", critic: { verdict: "approve", reason: "Small supported improvement." },
    config: core.loadConfig(), events: core.eventsIndex(), ...overrides,
  });
}

function recordPastAdoption(before, p) {
  const text = before.replace(/\r/g, "");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  let start = text.indexOf(p.op === "insert" ? p.anchor : p.old_text);
  assert.ok(start >= 0);
  if (p.op === "insert") {
    const newline = text.indexOf("\n", start + p.anchor.length - 1);
    start = newline === -1 ? text.length : newline;
  }
  const inserted = p.op === "insert" ? "\n" + p.new_text.replace(/\n+$/, "") : p.new_text;
  const end = start + (p.op === "insert" ? 0 : p.old_text.length);
  const afterText = text.slice(0, start) + inserted + text.slice(end);
  const after = Buffer.from(afterText.replace(/\n/g, eol));
  const id = "L-past-adoption";
  const directory = path.join(paths.backupsDir, id);
  fs.mkdirSync(directory);
  const backup = path.join(directory, p.target.replaceAll("/", "__"));
  fs.writeFileSync(backup, before);
  const record = {
    event: "adopt", id, applied_at: "2026-10-20T12:00:00.000Z", run_id: "past-run",
    target: p.target, op: p.op, old_text: p.op === "insert" ? "" : p.old_text, anchor: p.anchor || "",
    new_text: p.new_text, inserted, lesson: p.lesson, summary_ru: p.summary_ru,
    rationale: p.rationale, confidence: p.confidence, evidence: p.evidence.map((item) => {
      const event = fixtures.find((event) => event.id === item.event_id);
      return { ...item, session: event.session, ts: event.ts, type: event.type };
    }),
    sessions: 2, explicit: false, critic: { verdict: "approve", reason: "Supported improvement." },
    backup, sha256_before: common.sha256(Buffer.from(before)), sha256_after: common.sha256(after),
    ctx_before: afterText.slice(Math.max(0, start - 80), start),
    ctx_after: afterText.slice(start + inserted.length, start + inserted.length + 80), diff: "",
  };
  writeTarget(after, p.target);
  common.appendJsonl(paths.adoptedJsonl, record);
  return record;
}

function assertFailure(p, pattern, overrides = {}) {
  const result = validate(p, overrides);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.failures.join("; "), pattern);
  return result;
}

function child(command, args) {
  return spawnSync(command, args, { cwd: temporary, encoding: "utf8", env: { ...process.env } });
}

function assertExit(result, expected) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, result.stderr);
}

beforeEach(() => {
  fs.rmSync(process.env.CLAUDE_LEARNING_DIR, { recursive: true, force: true });
  common.ensureDirs();
  for (const [target, bytes] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(HOME_CLAUDE, target)), { recursive: true });
    fs.writeFileSync(path.join(HOME_CLAUDE, target), bytes);
  }
  common.appendJsonl(paths.events, fixtures);
});

after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("valid replacement cites real evidence from two sessions", () => {
  const result = validate(proposal());
  assert.equal(result.ok, true, result.failures.join("; "));
  assert.equal(result.kind, "edit");
  assert.equal(result.plan.op, "replace");
  assert.equal(result.plan.afterText, result.plan.beforeText.replace(editable, replacement));
});

test("threshold requires separate sessions or an explicit transcript correction", () => {
  const evidence = (id) => [{ event_id: id, quote }];
  assertFailure(proposal({ evidence: evidence("correction") }), /threshold/);
  assert.equal(validate(proposal({ evidence: evidence("explicit") })).ok, true);
  assertFailure(proposal({ evidence: evidence("status") }), /threshold/);
  assert.equal(validate(proposal({ kind: "log", summary_ru: "", evidence: evidence("a") })).ok, true);
  assert.equal(validate(proposal({ kind: "needs_user", evidence: evidence("a") })).ok, true);
});

test("only transcript corrections and explicitly trusted job events count toward the threshold", () => {
  assert.deepEqual(core.COUNTING_TYPES, ["user_correction", "luna_job", "executor_assumption"]);
  for (const [type, data, source, passes] of [
    ["critic_synthesis", {}, "panel.out.md", false],
    ["critic_output", { trusted: true }, "critic.out.md", false],
    ["luna_job", { trusted: true }, "job.status", true],
    ["executor_assumption", { trusted: true }, "job.out.md", true],
    ["luna_job", {}, "job.status", false],
    ["luna_job", { trusted: "true" }, "job.status", false],
    ["executor_assumption", { trusted: false }, "job.out.md", false],
    ["user_interrupt", { explicit: true, trusted: true }, "x.jsonl#L1", false],
    ["user_correction", { explicit: true }, "job.status", false],
    ["user_correction", {}, "x.jsonl#L1", true],
  ]) {
    const events = new Map(fixtures.slice(0, 2).map((event) => [event.id, { ...event, type, data, source }]));
    const checked = validate(proposal(), { events });
    assert.equal(checked.ok, passes, `${type} ${JSON.stringify(data)}: ${checked.failures.join("; ")}`);
    if (!passes) assert.ok(checked.failures.includes("evidence threshold not met"));
  }
});

test("copies with the same UUID do not count as independent evidence even with different quotes", () => {
  const events = new Map(fixtures.slice(0, 2).map((event) => [event.id, {
    ...event, data: { ...event.data, uuid: "copied-message" },
  }]));
  assertFailure(proposal(), /threshold/, { events });
});

test("identical quotes ignore case and whitespace when counting independent sessions", () => {
  const events = new Map(fixtures.slice(0, 2).map((event, i) => [event.id, {
    ...event, quote: i ? `  ${quote.toUpperCase().replaceAll(" ", " \n ")}  ` : quote,
  }]));
  const evidence = [...events.values()].map((event) => ({ event_id: event.id, quote: event.quote }));
  assertFailure(proposal({ evidence }), /threshold/, { events });
});

test("different corrections in different sessions pass the evidence threshold", () => {
  const events = new Map(fixtures.slice(0, 2).map((event) => [event.id, {
    ...event, type: "user_correction", source: `${event.id}.jsonl#L1`,
  }]));
  assert.equal(validate(proposal(), { events }).ok, true);
});

test("evidence groups use the earliest timestamp then ID regardless of citation order", () => {
  for (const uuid of [null, "copied-message"]) {
    for (const tied of [false, true]) {
      const events = new Map([
        { ...fixtures[0], ts: "2026-10-20T11:00:00.000Z", data: { trusted: true, uuid } },
        { ...fixtures[1], quote, data: { trusted: true, uuid },
          ts: tied ? "2026-10-20T11:00:00.000Z" : "2026-10-20T12:00:00.000Z" },
        { ...fixtures[0], id: "c", quote: `${quote} Independent evidence.`, data: { trusted: true } },
      ].map((event) => [event.id, event]));
      for (const ids of [["b", "c", "a"], ["a", "c", "b"]]) {
        const evidence = ids.map((event_id) => ({ event_id, quote }));
        assertFailure(proposal({ evidence }), /threshold/, { events });
      }
      events.get("c").session = "session-B";
      assert.equal(validate(proposal({ evidence: ["b", "c", "a"].map((event_id) => ({ event_id, quote })) }),
        { events }).ok, true);
    }
  }
});

test("an empty earliest session does not inherit a copied event's later session", () => {
  const events = new Map(fixtures.slice(0, 2).map((event, i) => [event.id, {
    ...event, session: i ? event.session : "", data: { trusted: true, uuid: "copied-message" },
  }]));
  assertFailure(proposal(), /threshold/, { events });
});

test("a cited explicit transcript correction passes even when its evidence group has an earlier event", () => {
  const events = new Map(fixtures.slice(0, 2).map((event, i) => [event.id, {
    ...event, type: "user_correction", source: `${event.id}.jsonl#L1`,
    data: { uuid: "copied-message", explicit: i === 1 },
  }]));
  assert.equal(validate(proposal(), { events }).ok, true);
});

test("short event quotes fall back to IDs and quote groups include the event type", () => {
  for (const quote of ["", "short", "12345678901"]) {
    const events = new Map(fixtures.slice(0, 2).map((event) => [event.id, { ...event, quote }]));
    const evidence = ["a", "b"].map((event_id) => ({ event_id, quote: "separate context sentence" }));
    assert.equal(validate(proposal({ evidence }), { events }).ok, true);
  }
  const events = new Map(fixtures.slice(0, 2).map((event, i) => [event.id, {
    ...event, quote, type: i ? "user_correction" : "luna_job", source: i ? "b.jsonl#L1" : event.source,
  }]));
  assert.equal(validate(proposal(), { events }).ok, true);
});

test("fabricated, unknown and short evidence all fail", () => {
  assertFailure(proposal({ evidence: [{ event_id: "a", quote: "A completely fabricated statement." }] }), /substring/);
  assertFailure(proposal({ evidence: [{ event_id: "missing", quote }] }), /evidence missing: unknown/);
  assertFailure(proposal({ evidence: [{ event_id: "a", quote: "Always" }] }), /shorter than 12/);
  const collapsed = "Always \n preserve   the local change";
  assert.equal(validate(proposal({ evidence: [{ event_id: "explicit", quote: collapsed }] })).ok, true);
  const contextQuote = proposal({ evidence: [{ event_id: "explicit", quote: "separate context sentence" }] });
  assert.equal(validate(contextQuote).ok, true);
});

test("protected spans, repeated text and targets outside the allowlist fail", () => {
  const line = "Special instruction (user decision, 2026-10-21)";
  writeTarget(`Before\n${line}\nAfter\n`);
  assertFailure(proposal({ old_text: `Before\n${line}\nAfter` }), /protected/);
  writeTarget(`${editable}\n${editable}\n`);
  assertFailure(proposal(), /exactly once/);
  assertFailure(proposal({ target: "settings.json" }), /allowlisted/);
  assertFailure(proposal({ target: "../CLAUDE.md" }), /allowlisted/);
});

test("real CLAUDE critic panel line and target-specific review policy vocabulary are protected", () => {
  const text = originals["CLAUDE.md"].toString("utf8").replace(/\r/g, "");
  const lines = text.split("\n");
  const index = lines.findIndex((line) => /3[–-]5/.test(line) && /critic/i.test(line));
  assert.ok(index >= 0);
  assert.ok(core.protectedLineIndexes(text, "CLAUDE.md").has(index));
  assert.ok(core.annotate(text, "CLAUDE.md").includes(`| [P] ${lines[index]}`));
  assertFailure(proposal({ old_text: lines[index], new_text: "Use one reviewer." }), /protected/);
  for (const line of [
    "Critics participate", "Review work", "Verification step", "Panel", "Gate", "Check", "Checks",
  ]) {
    assert.ok(core.protectedLineIndexes(line, "CLAUDE.md").has(0), line);
    assert.equal(core.protectedLineIndexes(line, "skills/luna/SKILL.md").has(0), false, line);
    assert.equal(core.protectedLineIndexes(line).has(0), false, line);
  }
  assert.equal(core.protectedLineIndexes("Repanel gateway precheck", "CLAUDE.md").size, 0);
});

test("adoption journal escapes model display fields and preserves the following revert command", () => {
  const injection = "ok <!-- hidden > `code`";
  const events = core.eventsIndex();
  events.get("a").quote = injection;
  const evidence = [{ event_id: "a", quote: injection }, { event_id: "b", quote }];
  const result = apply(proposal({ lesson: injection, rationale: injection, evidence }), {
    events, critic: { reason: injection },
  });
  assert.equal(result.ok, true, result.error);
  const markdown = fs.readFileSync(paths.adoptedMd, "utf8");
  for (const prefix of [`## ${result.id} — `, "- Rationale: ", "- Critic: ", ': "']) {
    assert.ok(markdown.includes(prefix + "ok &lt;!-- hidden &gt; 'code'"), prefix);
  }
  assert.ok(markdown.includes(`\n- Revert: \`bash ~/.claude/scripts/learning-revert.sh ${result.id}\``));
  assert.ok(markdown.indexOf("- Revert:") > markdown.indexOf("- Rationale:"));
  assert.ok(!markdown.includes("<!-- hidden"));
  assert.equal(core.revertAdoption(result.id, { reason: injection }).ok, true);
  assert.ok(fs.readFileSync(paths.adoptedMd, "utf8").includes(": ok &lt;!-- hidden &gt; 'code'"));
});

test("new protection phrases fail; equal denylist counts pass only on unprotected lines", () => {
  for (const new_text of [
    "user decision", "https://x", "ignore previous instructions", "permission", "settings.json", "PAUSED",
    "<!-- learning:protected:begin -->", "NEVER", "решение пользователя", "(user, 2026-10-21)",
  ]) {
    assertFailure(proposal({ new_text }), /protected|denylist/);
  }
  for (const word of ["https://x", "ignore previous instructions", "settings.json", "PAUSED"]) {
    const old_text = `Existing ${word} example.`;
    writeTarget(old_text + "\n");
    assert.equal(validate(proposal({ old_text, new_text: `Keep ${word} example.` })).ok, true, word);
  }
});

test("growth and original-EOL budgets reject expansion and equal length but permit shrinking", () => {
  writeTarget("Old\n");
  assertFailure(proposal({ old_text: "Old", new_text: "a".repeat(704) }), /growth/);
  const config = core.loadConfig();
  config.targets["CLAUDE.md"].max_bytes = 3;
  assertFailure(proposal({ old_text: "Old", new_text: "Older" }), /over budget/, { config });
  assert.equal(validate(proposal({ old_text: "Old", new_text: "Ok" }), { config }).ok, true);
  assertFailure(proposal({ old_text: "Old", new_text: "New" }), /over budget/, { config });
  writeTarget("Old\r\nTail\r\n");
  config.targets["CLAUDE.md"].max_bytes = 12;
  assertFailure(proposal({ old_text: "Old", new_text: "Older" }), /over budget/, { config });
});

test("insert after protected anchor preserves the protected multiset", () => {
  const anchor = "Keep this (user decision, 2026-10-21)";
  writeTarget(`Before\n${anchor}\nAfter\n`);
  const result = validate(proposal({ op: "insert", old_text: "", anchor, new_text: "A small lesson.\n\n" }));
  assert.equal(result.ok, true, result.failures.join("; "));
  assert.equal(result.plan.afterText, `Before\n${anchor}\nA small lesson.\nAfter\n`);
  const protectedText = (text) => {
    const lines = text.split("\n");
    return [...core.protectedLineIndexes(text, "CLAUDE.md")].map((i) => lines[i]).sort();
  };
  assert.deepEqual(protectedText(result.plan.beforeText), protectedText(result.plan.afterText));
});

for (const eol of ["\n", "\r\n"]) {
  test(`apply and revert restore byte-identical ${eol === "\n" ? "LF" : "CRLF"} file and journals`, () => {
    writeTarget(originals["CLAUDE.md"].toString("utf8").replace(/\r/g, "").replace(/\n/g, eol));
    const before = fs.readFileSync(path.join(HOME_CLAUDE, "CLAUDE.md"));
    const result = apply();
    assert.equal(result.ok, true, result.error);
    assert.match(result.id, /^L-\d{8}-\d{6}-1$/);
    assert.match(result.diff, /---/);
    const adoption = core.loadAdoptions().active[0];
    assert.equal(adoption.sessions, 2);
    assert.equal(adoption.explicit, false);
    assert.equal(adoption.critic.reason, "Small supported improvement.");
    assert.equal(fs.existsSync(adoption.backup), true);
    assert.equal(common.sha256(before), adoption.sha256_before);
    assert.equal(adoption.evidence[0].session, "session-A");
    const markdown = fs.readFileSync(paths.adoptedMd, "utf8");
    assert.ok(markdown.includes(result.id));
    assert.ok(markdown.includes(quote));
    assert.ok(markdown.includes(`bash ~/.claude/scripts/learning-revert.sh ${result.id}`));
    const reverted = core.revertAdoption(result.id, { reason: "test restore" });
    assert.equal(reverted.ok, true, reverted.message);
    assert.equal(reverted.status, "reverted");
    assert.deepEqual(fs.readFileSync(path.join(HOME_CLAUDE, "CLAUDE.md")), before);
    const records = common.readJsonl(paths.adoptedJsonl);
    assert.deepEqual(records.map((record) => record.event), ["adopt", "revert"]);
    assert.equal(fs.existsSync(records[1].backup), true);
    assert.match(fs.readFileSync(paths.adoptedMd, "utf8"), /## Revert log\n/);
    assert.equal(core.loadAdoptions().active.length, 0);
  });
}

test("reverse patch preserves later manual edits elsewhere", () => {
  const result = apply();
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget() + "\nA later hand edit.\n");
  const reverted = core.revertAdoption(result.id);
  assert.equal(reverted.ok, true, reverted.message);
  assert.ok(readTarget().endsWith("A later hand edit.\n"));
  assert.ok(readTarget().includes(editable));
  assert.equal(readTarget().includes(replacement), false);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

for (const eol of ["\n", "\r\n"]) {
  test(`reverse patch restores a past adoption now protected by never with ${JSON.stringify(eol)}`, () => {
    const before = ["Start.", "keep the brief short", "End.", ""].join(eol);
    const adoption = recordPastAdoption(before, proposal({
      old_text: "keep the brief short", new_text: "never leave the brief implied",
    }));
    assert.ok(core.protectedLineIndexes(readTarget(), adoption.target).has(1));
    const result = core.revertAdoption(adoption.id);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(fs.readFileSync(path.join(HOME_CLAUDE, adoption.target)), Buffer.from(before));
    assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
  });
}

test("reverse patch restores critic policy across multiple lines ending mid-line", () => {
  const old_text = "Use the critic output.\nFor mixed tasks, split them: Luna does the";
  const new_text = "Use the synthesis of Luna/critic output.\nFor mixed tasks, Claude does the";
  const before = `Start.\n${old_text} implementation.\nEnd.\n`;
  const adoption = recordPastAdoption(before, proposal({ old_text, new_text }));
  assert.ok(core.protectedLineIndexes(before, adoption.target).has(1));
  assert.ok(core.protectedLineIndexes(readTarget(), adoption.target).has(1));
  const result = core.revertAdoption(adoption.id);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(fs.readFileSync(path.join(HOME_CLAUDE, adoption.target)), Buffer.from(before));
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

test("reverse patch leaves all bytes outside its span intact, including a later protected line in context", () => {
  const old_text = "Original lesson.";
  const new_text = "never leave it implied.";
  const before = `never change the header.\n${old_text}\n` + "Context padding.\n".repeat(5) + "Tail.\n";
  const adoption = recordPastAdoption(before, proposal({ old_text, new_text }));
  writeTarget(readTarget().replace("Context padding.\n".repeat(3),
    "Context padding.\n".repeat(3) + "never erase this later line.\n"));
  const current = readTarget();
  const start = current.indexOf(new_text);
  assert.ok(current.indexOf("never erase") < start + new_text.length + adoption.ctx_after.length);
  const result = core.revertAdoption(adoption.id);
  assert.equal(result.ok, true, result.message);
  const restored = readTarget();
  assert.equal(restored.slice(0, start), current.slice(0, start));
  assert.equal(restored.slice(start + old_text.length), current.slice(start + new_text.length));
  assert.equal(restored.slice(start, start + old_text.length), old_text);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

test("verified backup restoration accepts protection rules widened since adoption", () => {
  const before = "Start.\r\nkeep the brief short\r\nEnd.\r\n";
  const adoption = recordPastAdoption(before, proposal({
    old_text: "keep the brief short", new_text: "never leave the brief implied",
  }));
  common.writeFileAtomic(paths.adoptedJsonl, JSON.stringify({ ...adoption, ctx_before: "Missing context" }) + "\n");
  const result = core.revertAdoption(adoption.id);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(fs.readFileSync(path.join(HOME_CLAUDE, adoption.target)), Buffer.from(before));
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "restore-backup");
});

for (const suffix of ["now.\nEnd.\n", ""]) {
  test(`zero-length reverse patch excludes its containing protected line with suffix ${JSON.stringify(suffix)}`, () => {
    const before = "Start.\nnever leave it short " + suffix;
    const adoption = recordPastAdoption(before, proposal({ old_text: "short ", new_text: "" }));
    const result = core.revertAdoption(adoption.id);
    assert.equal(result.ok, true, result.message);
    assert.equal(readTarget(), before);
    assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
  });
}

test("reverting an insertion excludes the protected line containing the zero-length restored span", () => {
  const before = "never change this anchor.\nEnd.\n";
  const adoption = recordPastAdoption(before, proposal({
    op: "insert", old_text: "", anchor: "never change this anchor.", new_text: "never leave it implied.",
  }));
  const result = core.revertAdoption(adoption.id);
  assert.equal(result.ok, true, result.message);
  assert.equal(readTarget(), before);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

test("reverse patch rejects changed protection of lines outside its span", () => {
  const before = "Start.\n<!-- learning:protected:begin -->\nOriginal tail.\n";
  const adoption = recordPastAdoption(before, proposal({
    old_text: "<!-- learning:protected:begin -->", new_text: "Adopted sentence.",
  }));
  const current = readTarget();
  const result = core.revertAdoption(adoption.id);
  assert.equal(result.status, "failed");
  assert.match(result.message, /protected line multiset would change/);
  assert.equal(readTarget(), current);
  assert.equal(core.loadAdoptions().active.length, 1);
  assert.ok(core.openNeedsUser()[0].text.includes(adoption.id));
});

test("pure deletion of unprotected text is restored using adjacent contexts", () => {
  writeTarget("Start context.\nObsolete sentence.\nEnd context.\n");
  const before = readTarget();
  const result = apply(proposal({ old_text: "Obsolete sentence.\n", new_text: "" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(readTarget(), "Start context.\nEnd context.\n");
  assert.equal(core.revertAdoption(result.id).status, "reverted");
  assert.equal(readTarget(), before);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

test("changed lesson cannot be reverted and remains active with a needs-user item", () => {
  writeTarget("Start.\nAnchor.\nEnd.\n");
  const result = apply(proposal({ op: "insert", old_text: "", anchor: "Anchor.", new_text: "Inserted lesson." }));
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget().replace("Inserted lesson.", "Hand rewritten lesson."));
  const before = readTarget();
  const reverted = core.revertAdoption(result.id, { reason: "regression" });
  assert.equal(reverted.ok, false);
  assert.equal(reverted.status, "failed");
  assert.equal(readTarget(), before);
  assert.equal(core.loadAdoptions().active[0].id, result.id);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).event, "revert_failed");
  assert.ok(core.openNeedsUser()[0].text.includes(result.id));
  assert.ok(core.openNeedsUser()[0].text.includes("Backup:"));
});

test("revert is idempotent and unknown ids have a distinct status", () => {
  const result = apply();
  assert.equal(result.ok, true, result.error);
  assert.equal(core.revertAdoption(result.id).status, "reverted");
  assert.equal(core.revertAdoption(result.id).status, "already");
  assert.equal(core.revertAdoption("NOPE").status, "unknown");
});

test("CLI unknown revert exits 2", () => {
  const result = child(process.execPath, [coreFile, "revert", "NOPE"]);
  assertExit(result, 2);
  assert.match(result.stdout, /Unknown adoption/);
  assert.equal(fs.existsSync(paths.config), false);
});

test("real bash revert script without arguments exits 2 from another cwd", () => {
  const result = child("bash", [revertScript]);
  assertExit(result, 2);
  assert.match(result.stderr, /Usage:/);
});

test("real bash revert script lists adoptions from another cwd", () => {
  const result = child("bash", [revertScript, "--list"]);
  assertExit(result, 0);
  assert.equal(result.stdout.trim(), "No adoptions yet.");
  assert.equal(fs.existsSync(paths.config), false);
});

test("mixed line endings are rejected through raw text and readTargets metadata", () => {
  writeTarget(`${editable}\r\nA bare line.\n`);
  assertFailure(proposal(), /mixed line endings/);
  assertFailure(proposal(), /mixed line endings/, { files: { "CLAUDE.md": readTarget() } });
});

test("fresh apply validation rejects stale proposals without changing bytes", () => {
  assert.equal(validate(proposal()).ok, true);
  writeTarget(readTarget().replace(editable, "Changed in the meantime."));
  const before = readTarget();
  const result = apply();
  assert.equal(result.ok, false);
  assert.match(result.error, /exactly once/);
  assert.equal(readTarget(), before);
  assert.deepEqual(common.readJsonl(paths.adoptedJsonl), []);
});

test("candidates fold case-insensitively, expire and close", () => {
  const first = core.recordCandidate(proposal(), { runId: "one", reason: "thin evidence" });
  core.recordCandidate(proposal({ lesson: proposal().lesson.toUpperCase() }), { runId: "two", reason: "again" });
  let candidates = core.loadCandidates({ openOnly: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].times_seen, 2);
  assert.equal(candidates[0].candidate_key, first.candidate_key);
  assert.match(first.candidate_key, /^[a-f0-9]{12}$/);
  const old = core.recordCandidate(proposal({ lesson: "A different old lesson." }), { reason: "old" });
  fs.writeFileSync(paths.candidates, common.readJsonl(paths.candidates).map((record) => JSON.stringify({
    ...record, at: record.candidate_key === old.candidate_key ? "2000-01-01T00:00:00.000Z" : record.at,
  })).join("\n") + "\n");
  assert.equal(core.loadCandidates().find((record) => record.candidate_key === old.candidate_key).status, "expired");
  assert.equal(core.loadCandidates({ openOnly: true }).length, 1);
  core.closeCandidates([first.candidate_key], { runId: "three", reason: "adopted" });
  candidates = core.loadCandidates();
  assert.equal(candidates.find((record) => record.candidate_key === first.candidate_key).status, "closed");
  assert.equal(core.loadCandidates({ openOnly: true }).length, 0);
});

test("needs-user suppresses open duplicates and respects checked items", () => {
  core.recordNeedsUser(proposal(), { runId: "one" });
  core.recordNeedsUser(proposal(), { runId: "two" });
  assert.equal(core.openNeedsUser().length, 1);
  assert.match(core.openNeedsUser()[0].id, /^NU-\d{8}-1$/);
  assert.ok(core.openNeedsUser()[0].text.includes(proposal().summary_ru));
  assert.match(fs.readFileSync(paths.needsUser, "utf8"), /evidence: E:a, E:b/);
  fs.writeFileSync(paths.needsUser, fs.readFileSync(paths.needsUser, "utf8").replace("- [ ] NU-", "- [x] NU-"));
  assert.deepEqual(core.openNeedsUser(), []);
  core.recordNeedsUser(proposal(), { runId: "three" });
  assert.equal(core.openNeedsUser().length, 1);
  assert.match(core.openNeedsUser()[0].id, /-2$/);
});

test("weekly Russian reports preserve state, respect due dates and use unique paths", () => {
  const applied = apply();
  assert.equal(applied.ok, true, applied.error);
  const now = new Date(Date.now() + 1000);
  assert.equal(core.generateReport({ now }), null);
  common.writeJsonAtomic(paths.loopState, { lastRunAt: now.toISOString(), foo: 1 });
  fs.writeFileSync(paths.logMd, `- ${new Date(now.getTime() - 500).toISOString()} run complete\n`);
  core.recordCandidate(proposal(), { reason: "thin evidence" });
  core.recordNeedsUser(proposal());
  const report = core.generateReport({ now });
  assert.ok(report);
  assert.match(report.text, /Самообучение: отчёт/);
  assert.ok(report.text.includes(applied.id));
  assert.ok(report.text.includes(`bash ~/.claude/scripts/learning-revert.sh ${applied.id}`));
  assert.match(report.text, /Прогонов: 1 · применено: 1/);
  assert.match(report.text, /Размеры файлов:/);
  assert.ok(report.short.length <= 1200);
  assert.equal(fs.readFileSync(report.path, "utf8"), report.text);
  const state = common.readJson(paths.loopState, {});
  assert.equal(state.foo, 1);
  assert.deepEqual(state.report, { path: report.path, created: now.toISOString(), shown: 0 });
  assert.equal(core.generateReport({ now: new Date(now.getTime() + DAY_MS) }), null);
  const forced = core.generateReport({ now, force: true });
  assert.match(forced.path, /-2\.md$/);
  assert.notEqual(report.path, forced.path);
});

const DAY_MS = 86400000;

test("protected indexes cover frontmatter, case-insensitive never, blocks and dated user attribution", () => {
  const text = [
    "---", "name: example", "description: example", "---", "never alone", "NEVER remove this",
    "<!-- learning:protected:begin -->", "Inside block", "<!-- learning:protected:end -->",
    "Attribution (user, 2026-09-29)", "Ordinary line", "<!-- learning:protected:begin -->", "To EOF",
  ].join("\n");
  assert.deepEqual([...core.protectedLineIndexes(text)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
  assert.match(core.annotate(text), /^0001\| \[P\] ---/);
  assert.ok(core.annotate(text).includes("0005| [P] never alone"));
});

test("shape validation never throws and gathers independent failures", () => {
  for (const p of [null, [], "bad", 3]) assert.equal(core.validateProposal(p, context()).ok, false);
  const result = validate({ id: 3, kind: "unknown", lesson: "", summary_ru: 4, evidence: [] });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 5);
  assertFailure(proposal({ new_text: "x".repeat(4001) }), /4000/);
  assertFailure(proposal({ op: "other" }), /op must/);
  assertFailure(proposal({ op: "insert", anchor: editable, new_text: "" }), /must not be empty/);
});

test("regression reverts count only evidence strictly after the active adoption", () => {
  const adoptions = { list: [{ id: "L-test", status: "active", applied_at: "2026-10-20T12:00:00.000Z" }] };
  const p = proposal({ kind: "revert", revert_id: "L-test" });
  assertFailure(p, /threshold/, { adoptions });
  const events = new Map(fixtures.map((event) => [event.id, {
    ...event, ts: "2026-10-20T13:00:00.000Z",
  }]));
  const now = new Date("2026-10-23T12:00:00.000Z");
  assert.equal(validate(p, { adoptions, events, now }).ok, true);
  adoptions.list[0].status = "reverted";
  assertFailure(p, /active adoption/, { adoptions, events });
});

test("config deep merges defaults and never extends the three-target allowlist", () => {
  assert.equal(fs.existsSync(paths.config), false);
  const defaults = core.loadConfig();
  assert.equal(fs.existsSync(paths.config), true);
  assert.equal(defaults.max_edits_per_run, 3);
  common.writeJsonAtomic(paths.config, {
    targets: { "CLAUDE.md": { max_bytes: 10000 }, "settings.json": { max_bytes: 100000 } },
    proposer: { effort: "medium" },
  });
  const config = core.loadConfig();
  assert.equal(config.targets["CLAUDE.md"].max_bytes, 10000);
  assert.equal(config.targets["skills/luna/SKILL.md"].max_bytes, 24000);
  assert.equal(Object.hasOwn(config.targets, "settings.json"), false);
  assert.equal(config.proposer.model, "gpt-6-luna");
  assert.equal(config.proposer.effort, "medium");
  assert.deepEqual(Object.keys(core.readTargets(config)), core.TARGETS);
  fs.unlinkSync(path.join(HOME_CLAUDE, "skills/luna/SKILL.md"));
  assert.equal(Object.hasOwn(core.readTargets(config), "skills/luna/SKILL.md"), false);
});

test("config rejects invalid numeric types, non-finite values and values outside every stated range", () => {
  const defaults = core.loadConfig();
  const ranges = {
    min_new_events: [1, 20], min_hours_between_runs: [1, 48], retry_after_failure_hours: [1, 12],
    report_days: [1, 14], max_edits_per_run: [0, 10], max_edit_growth_chars: [0, 2000],
    candidate_expiry_days: [1, 90],
  };
  for (const [key, [min, valid]] of Object.entries(ranges)) {
    for (const value of ["daily", null, true, {}, [], min - 1,
      ...(["max_edits_per_run", "max_edit_growth_chars"].includes(key) ? [valid + 1] : [])]) {
      common.writeJsonAtomic(paths.config, { [key]: value });
      assert.equal(core.loadConfig()[key], defaults[key], `${key}: ${JSON.stringify(value)}`);
    }
    fs.writeFileSync(paths.config, `{"${key}":1e999}`);
    assert.equal(core.loadConfig()[key], defaults[key], `${key}: Infinity`);
    for (const value of [min, valid]) {
      common.writeJsonAtomic(paths.config, { [key]: value });
      assert.equal(core.loadConfig()[key], value, key);
    }
  }
  for (const target of core.TARGETS) {
    for (const max_bytes of ["1000", null, false, {}, [], 999]) {
      common.writeJsonAtomic(paths.config, { targets: { [target]: { max_bytes } } });
      assert.equal(core.loadConfig().targets[target].max_bytes, defaults.targets[target].max_bytes);
    }
    fs.writeFileSync(paths.config, `{"targets":{"${target}":{"max_bytes":1e999}}}`);
    assert.equal(core.loadConfig().targets[target].max_bytes, defaults.targets[target].max_bytes);
    common.writeJsonAtomic(paths.config, { targets: { [target]: { max_bytes: 1000 } } });
    assert.equal(core.loadConfig().targets[target].max_bytes, 1000);
  }
  common.writeJsonAtomic(paths.config, { min_hours_between_runs: "daily", max_edits_per_run: 99 });
  assert.equal(core.loadConfig().min_hours_between_runs, 24);
  assert.equal(core.loadConfig().max_edits_per_run, 3);
});

test("config validates model names and efforts and restores distinct proposer and critic models", () => {
  const defaults = core.loadConfig();
  for (const role of ["proposer", "critic"]) {
    for (const model of ["", "GPT-6", "model name", "x\n", "--model=x", null, 12, {}]) {
      common.writeJsonAtomic(paths.config, { [role]: { model } });
      assert.equal(core.loadConfig()[role].model, defaults[role].model);
    }
    for (const effort of ["", "ultra", "HIGH", null, 12, {}]) {
      common.writeJsonAtomic(paths.config, { [role]: { effort } });
      assert.equal(core.loadConfig()[role].effort, defaults[role].effort);
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      common.writeJsonAtomic(paths.config, { [role]: { model: "test-6.1", effort } });
      assert.deepEqual(core.loadConfig()[role], { model: "test-6.1", effort });
    }
  }
  for (const model of ["same-model", defaults.proposer.model, defaults.critic.model]) {
    common.writeJsonAtomic(paths.config, { proposer: { model }, critic: { model } });
    const config = core.loadConfig();
    assert.equal(config.critic.model, defaults.critic.model);
    assert.equal(config.proposer.model, model === defaults.critic.model ? defaults.proposer.model : model);
    assert.notEqual(config.proposer.model, config.critic.model);
  }
});

for (const change of ["adopt", "revert", "needs_user", "closed_item"]) {
  test(`report refresh checks newer ${change} changes before its weekly due date`, () => {
    const first = new Date(Date.now() - 10000);
    common.writeJsonAtomic(paths.loopState, { lastRunAt: first.toISOString() });
    const report = core.generateReport({ now: first });
    assert.ok(report);
    assert.equal(core.generateReport({ now: first }), null);
    const at = new Date(first.getTime() + 1000).toISOString();
    if (change === "adopt" || change === "revert") {
      common.appendJsonl(paths.adoptedJsonl, {
        event: change, id: "L-new", applied_at: at, reverted_at: at, target: "CLAUDE.md",
        sessions: 2, lesson: "A newly adopted lesson.", reason: "A recent regression.",
      });
    } else {
      fs.writeFileSync(paths.needsUser, change === "needs_user" ? "- [ ] NU-new: Decide.\n" : "- [x] Done.\n");
      fs.utimesSync(paths.needsUser, new Date(at), new Date(at));
    }
    const refreshed = core.generateReport({ now: new Date(first.getTime() + 2000) });
    if (change === "closed_item") {
      assert.equal(refreshed, null);
    } else {
      assert.ok(refreshed);
      assert.notEqual(refreshed.path, report.path);
      assert.ok(refreshed.text.includes(change === "needs_user" ? "Decide." : "L-new"));
      assert.equal(core.generateReport({ now: new Date(first.getTime() + 3000) }), null);
    }
  });
}

test("apply enforces the run edit limit and assigns unique incrementing ids", () => {
  writeTarget("One line.\nSecond line.\nThird line.\nFourth line.\n");
  const ids = [];
  for (const old_text of ["One line.", "Second line.", "Third line."]) {
    const result = apply(proposal({ old_text, new_text: old_text + " Improved." }));
    assert.equal(result.ok, true, result.error);
    ids.push(result.id);
  }
  assert.equal(new Set(ids).size, 3);
  const before = readTarget();
  const result = apply(proposal({ old_text: "Fourth line.", new_text: "Fourth line. Improved." }));
  assert.equal(result.ok, false);
  assert.match(result.error, /max_edits_per_run/);
  assert.equal(readTarget(), before);
});

test("a revert cannot erase a protected line added since adoption", () => {
  writeTarget("Start.\nOriginal lesson.\nEnd.\n");
  const result = apply(proposal({ old_text: "Original lesson.", new_text: "Changed lesson." }));
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget().replace("Changed lesson.", "Changed lesson. (user decision, 2026-10-21)"));
  const before = readTarget();
  const reverted = core.revertAdoption(result.id);
  assert.equal(reverted.status, "failed");
  assert.match(reverted.message, /reverse patch/);
  assert.equal(readTarget(), before);
  assert.equal(core.loadAdoptions().active.length, 1);
});

test("ambiguous replacement is disambiguated by saved context", () => {
  writeTarget("First context.\nOriginal.\nLast context.\n");
  const result = apply(proposal({ old_text: "Original.", new_text: "Changed." }));
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget() + "Different context.\nChanged.\nOther ending.\n");
  assert.equal(core.revertAdoption(result.id).status, "reverted");
  assert.equal(readTarget(), "First context.\nOriginal.\nLast context.\nDifferent context.\nChanged.\nOther ending.\n");
});

test("context disambiguates an intact inserted region in an unchanged file", () => {
  writeTarget("Anchor.\nRepeated lesson.\nEnd.\n");
  const before = readTarget();
  const result = apply(proposal({
    op: "insert", old_text: "", anchor: "Anchor.", new_text: "Repeated lesson.",
  }));
  assert.equal(result.ok, true, result.error);
  const reverted = core.revertAdoption(result.id);
  assert.equal(reverted.status, "reverted", reverted.message);
  assert.equal(readTarget(), before);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "reverse-patch");
});

test("context disambiguates an inserted region while preserving another copy and manual work", () => {
  writeTarget("Anchor.\nEnd.\n");
  const result = apply(proposal({
    op: "insert", old_text: "", anchor: "Anchor.", new_text: "Repeated lesson.",
  }));
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget() + "\nRepeated lesson.\nLater hand edit.\n");
  assert.equal(core.revertAdoption(result.id).status, "reverted");
  assert.equal(readTarget(), "Anchor.\nEnd.\n\nRepeated lesson.\nLater hand edit.\n");
  assert.equal(core.loadAdoptions().active.length, 0);
});

test("unused optional edit fields cannot interrupt adoption after the file is written", () => {
  const result = apply(proposal({ anchor: 12 }));
  assert.equal(result.ok, true, result.error);
  assert.equal(core.loadAdoptions().active[0].id, result.id);
  assert.equal(core.revertAdoption(result.id).status, "reverted");
});

test("forced empty report omits empty sections and limits long lists", () => {
  const report = core.generateReport({ force: true });
  assert.match(report.text, /Правок за период не было/);
  assert.equal(report.text.includes("Что изменилось:"), false);
  for (let i = 0; i < 8; i++) core.appendNeedsUserText(`Question number ${i}.`);
  const long = core.generateReport({ force: true });
  assert.match(long.text, /и ещё 3/);
  assert.ok(long.short.length <= 1200);
});

test("real CLAUDE safety, permission and ask lines are protected against replacement", () => {
  const text = originals["CLAUDE.md"].toString("utf8").replace(/\r/g, "");
  const lines = text.split("\n");
  const indexes = core.protectedLineIndexes(text, "CLAUDE.md");
  assert.ok(lines.some((line) => /Never delete/i.test(line)));
  assert.ok(lines.some((line) => /permission|\bask\b/i.test(line)));
  for (const [i, line] of lines.entries()) {
    if (!/Never delete|permission|\bask\b/i.test(line)) continue;
    assert.equal(indexes.has(i), true, line);
    assertFailure(proposal({ old_text: line, new_text: "A different instruction." }), /protected/, {
      files: { "CLAUDE.md": text },
    });
  }
});

test("every safety pattern protects lines without extending the new_text decision patterns", () => {
  for (const line of [
    "never overwrite", "don't remove files", "dont use it", "Do not continue", "must not proceed",
    "ask first", "confirmation", "permissions", "approval", "consent", "destructive operation",
    "irreversible operation", "delete files", "safety rule", "security rule", "secrets", "credentials",
    "passwords", "tokens", "prompt-injection", "prompt injection", "untrusted input", "commit itself",
    "commits itself", "never commits", "git push", "git commit", "git reset",
  ]) {
    writeTarget(line + "\n");
    assert.equal(core.protectedLineIndexes(line).has(0), true, line);
    assertFailure(proposal({ old_text: line, new_text: "Updated." }), /protected/);
  }
  assert.equal(core.PROTECT_RE.some((re) => re.test("never repeat work")), false);
  assert.equal(core.SAFETY_LINE_RE.some((re) => re.test("never repeat work")), true);
});

test("deterministic weakening families reject newly added vocabulary case-insensitively", () => {
  for (const new_text of [
    "without asking", "without confirming", "without approval", "without permission", "without checking",
    "without reviewing", "no need to ask", "no need to confirm", "no need to check", "no need to review",
    "no need to wait", "no need to run", "unless", "except", "exception", "exceptions", "instead of asking",
    "don't ask", "dont confirm", "don't wait for", "don't check with", "skip critic", "skipping the critics",
    "skip review", "skip confirmation", "skip check", "skipping the checks", "skip test", "skip tests",
    "skip gate", "optional", "optionally", "auto-approve", "autoapprove", "silently", "no longer", "disable",
  ]) {
    assertFailure(proposal({ new_text: new_text.toUpperCase() }), /denylist/);
  }
  writeTarget("This step is optional.\n");
  assert.equal(validate(proposal({ old_text: "This step is optional.", new_text: "A step is optional." })).ok, true);
});

for (const inside of [true, false]) {
  test(`a target directory junction resolving ${inside ? "inside" : "outside"} HOME is rejected`, () => {
    const link = path.join(HOME_CLAUDE, "skills", "luna");
    const actual = path.join(inside ? HOME_CLAUDE : temporary, "junction-destination");
    fs.renameSync(link, actual);
    try {
      fs.symlinkSync(actual, link, "junction");
      assert.throws(() => core.readTargets(), /resolves through a link/);
      const before = fs.readFileSync(path.join(actual, "SKILL.md"));
      const result = apply(proposal({ target: "skills/luna/SKILL.md" }));
      assert.equal(result.ok, false);
      assert.match(result.error, /resolves through a link/);
      assert.deepEqual(fs.readFileSync(path.join(actual, "SKILL.md")), before);
    } finally {
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      fs.renameSync(actual, link);
    }
  });
}

test("apply aborts when target bytes change after preparation and before the atomic write", (t) => {
  const file = path.join(HOME_CLAUDE, "CLAUDE.md");
  const changed = readTarget() + "\nA concurrent local edit.\n";
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (name, ...args) => {
    if (name === file && ++reads === 2) fs.writeFileSync(file, changed);
    return read(name, ...args);
  });
  const result = apply();
  assert.deepEqual(result, { ok: false, error: "target changed during apply" });
  assert.equal(readTarget(), changed);
  assert.deepEqual(common.readJsonl(paths.adoptedJsonl), []);
});

for (const journal of ["adoptedMd", "adoptedJsonl"]) {
  test(`apply rolls back byte-identically when ${journal} is a directory`, () => {
    const file = path.join(HOME_CLAUDE, "CLAUDE.md");
    const before = fs.readFileSync(file);
    fs.mkdirSync(paths[journal]);
    const result = apply();
    assert.equal(result.ok, false);
    assert.match(result.error, /^journal write failed: /);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(core.loadAdoptions().active.length, 0);
    if (journal === "adoptedMd") {
      const records = common.readJsonl(paths.adoptedJsonl);
      assert.deepEqual(records.map((record) => record.event), ["adopt", "revert"]);
      assert.equal(records[1].id, records[0].id);
      assert.equal(records[1].reason, "rollback: journal write failed");
      assert.equal(records[1].method, "restore-backup");
      assert.equal(records[1].auto, true);
    }
  });
}

for (const op of ["replace", "insert"]) {
  test(`${op} revert refuses an adjacent user extension and preserves all bytes`, () => {
    writeTarget("Start.\nAnchor.\nOriginal lesson.\nEnd.\n");
    const result = apply(proposal({
      op, old_text: "Original lesson.", anchor: "Anchor.", new_text: "Adopted lesson.",
    }));
    assert.equal(result.ok, true, result.error);
    writeTarget(readTarget().replace("Adopted lesson.", "Adopted lesson. with my detail."));
    const before = readTarget();
    assert.equal(core.revertAdoption(result.id).status, "failed");
    assert.equal(readTarget(), before);
    assert.ok(core.openNeedsUser()[0].text.includes(result.id));
    assert.equal(core.loadAdoptions().active.length, 1);
  });

  test(`${op} revert preserves an unrelated edit three lines away`, () => {
    writeTarget("Start.\nAnchor.\nOriginal lesson.\n" + "Context padding.\n".repeat(3) + "Later line.\n");
    const before = readTarget();
    const result = apply(proposal({
      op, old_text: "Original lesson.", anchor: "Anchor.", new_text: "Adopted lesson.",
    }));
    assert.equal(result.ok, true, result.error);
    writeTarget(readTarget().replace("Later line.", "Manual later line."));
    assert.equal(core.revertAdoption(result.id).status, "reverted");
    assert.equal(readTarget(), before.replace("Later line.", "Manual later line."));
  });
}

test("revert boundary contexts anchor the full region to file start and end", () => {
  for (const before of ["Original.", "Original.\nEnd.\n", "Start.\nOriginal."]) {
    writeTarget(before);
    const result = apply(proposal({ old_text: "Original.", new_text: "Changed." }), { runId: before });
    assert.equal(result.ok, true, result.error);
    writeTarget(before.startsWith("Original.") ? "Prefix.\n" + readTarget() : readTarget() + "\nSuffix.");
    const changed = readTarget();
    assert.equal(core.revertAdoption(result.id).status, "failed");
    assert.equal(readTarget(), changed);
  }
});

test("unchanged file uses its backup if stored context cannot identify the region", () => {
  const before = readTarget();
  const result = apply();
  assert.equal(result.ok, true, result.error);
  const records = common.readJsonl(paths.adoptedJsonl);
  records[0].ctx_before = "Missing context";
  common.writeFileAtomic(paths.adoptedJsonl, records.map((record) => JSON.stringify(record) + "\n").join(""));
  assert.equal(core.revertAdoption(result.id).status, "reverted");
  assert.equal(readTarget(), before);
  assert.equal(common.readJsonl(paths.adoptedJsonl).at(-1).method, "restore-backup");
});

test("reverts wait three days unless a newer explicit transcript correction is cited", () => {
  assert.equal(core.REVERT_MIN_DAYS, 3);
  const applied_at = "2026-10-20T12:00:00.000Z";
  const adoptions = { list: [{ id: "L-window", status: "active", applied_at }] };
  const events = new Map(fixtures.map((event) => [event.id, { ...event, ts: "2026-10-20T13:00:00.000Z" }]));
  const p = proposal({ kind: "revert", revert_id: "L-window" });
  const now = new Date(Date.parse(applied_at) + 3 * DAY_MS - 1);
  assertFailure(p, /revert: observation window < 3 days/, { adoptions, events, now });
  assert.equal(validate(p, { adoptions, events, now: new Date(now.getTime() + 1) }).ok, true);
  const explicit = { ...p, evidence: [{ event_id: "explicit", quote }] };
  assert.equal(validate(explicit, { adoptions, events, now }).ok, true);
  events.get("explicit").ts = applied_at;
  assertFailure(explicit, /observation window/, { adoptions, events, now });
  const status = { ...p, evidence: [...p.evidence, { event_id: "status", quote }] };
  assertFailure(status, /observation window/, { adoptions, events, now });
  adoptions.list[0].applied_at = new Date().toISOString();
  assertFailure(p, /observation window/, { adoptions, events });
});

test("candidate folding merges evidence by id and keeps the first quote and latest fields", () => {
  const first = core.recordCandidate(proposal({ evidence: [{ event_id: "a", quote: "first quote" }] }), {
    reason: "first", runId: "session-A",
  });
  const last = core.recordCandidate(proposal({
    evidence: [{ event_id: "a", quote: "second quote" }, { event_id: "b", quote }],
    summary_ru: "Новое описание.", lesson: proposal().lesson.toUpperCase(),
  }), { reason: "latest", status: "closed", runId: "session-B" });
  const [folded] = core.loadCandidates();
  assert.deepEqual(folded.evidence, [{ event_id: "a", quote: "first quote" }, { event_id: "b", quote }]);
  assert.equal(folded.times_seen, 2);
  assert.equal(folded.first_at, first.at);
  assert.equal(folded.last_at, last.at);
  for (const key of ["reason", "status", "lesson", "summary_ru"]) assert.equal(folded[key], last[key]);
});

test("candidate evidence merging tolerates malformed proposals saved after gate rejection", () => {
  core.recordCandidate(proposal({ evidence: {} }));
  core.recordCandidate(proposal({ evidence: [null, "bad", {}, { event_id: "a", quote }] }));
  const [folded] = core.loadCandidates();
  assert.equal(folded.times_seen, 2);
  assert.deepEqual(folded.evidence, [{ event_id: "a", quote }]);
});

test("candidate compaction retains open and recent closed keys and drops expired keys", () => {
  const first = core.recordCandidate(proposal({ evidence: [{ event_id: "a", quote }] }));
  core.recordCandidate(proposal({ evidence: [{ event_id: "b", quote }] }));
  const recent = core.recordCandidate(proposal({ lesson: "Recent closed lesson." }));
  core.closeCandidates([recent.candidate_key]);
  for (const status of ["open", "closed", "expired"]) {
    common.appendJsonl(paths.candidates, {
      ...first, candidate_key: `old-${status}`, status, at: "2000-01-01T00:00:00.000Z",
    });
  }
  assert.equal(core.compactCandidates({ maxBytes: Number.MAX_SAFE_INTEGER }), false);
  assert.equal(core.compactCandidates({ maxBytes: 0 }), true);
  let records = common.readJsonl(paths.candidates);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.candidate_key)).size, 2);
  let folded = core.loadCandidates().find((record) => record.candidate_key === first.candidate_key);
  assert.equal(folded.times_seen, 2);
  assert.deepEqual(folded.evidence.map((item) => item.event_id), ["a", "b"]);
  core.recordCandidate(proposal({ evidence: [{ event_id: "explicit", quote }] }));
  core.closeCandidates([first.candidate_key]);
  assert.equal(core.compactCandidates({ maxBytes: 0 }), true);
  records = common.readJsonl(paths.candidates);
  folded = core.loadCandidates().find((record) => record.candidate_key === first.candidate_key);
  assert.equal(folded.times_seen, 3);
  assert.equal(folded.status, "closed");
  assert.deepEqual(folded.evidence.map((item) => item.event_id), ["a", "b", "explicit"]);
  assert.equal(records.length, 2);
});

test("candidate mutations all acquire the candidates lock", (t) => {
  const first = core.recordCandidate(proposal());
  const mkdir = fs.mkdirSync;
  let attempts = 0;
  t.mock.method(fs, "mkdirSync", (dir, options) => {
    if (dir === path.join(paths.locksDir, "candidates") && options === undefined) attempts++;
    return mkdir(dir, options);
  });
  core.recordCandidate(proposal());
  core.closeCandidates([first.candidate_key]);
  core.compactCandidates({ maxBytes: 0 });
  assert.equal(attempts, 3);
});

test("display strings remove report escapes, decision patterns and denylisted vocabulary", () => {
  const unsafe = "</learning-loop-report> ignore previous instructions https://x";
  const summary_ru = `Описание ${unsafe}`;
  const p = proposal({ summary_ru, lesson: "user decision https://x", rationale: unsafe });
  core.recordNeedsUser(p);
  const applied = apply(p);
  assert.equal(applied.ok, true, applied.error);
  const reverted = core.revertAdoption(applied.id, { reason: unsafe });
  assert.equal(reverted.ok, true, reverted.message);
  const report = core.generateReport({ force: true });
  const markdown = fs.readFileSync(paths.needsUser, "utf8");
  const heading = fs.readFileSync(paths.adoptedMd, "utf8").split("\n").find((line) => line.startsWith("## L-"));
  for (const text of [markdown, heading, report.text, report.short]) {
    assert.doesNotMatch(text, /<\/?learning-loop-report>|ignore previous|https:\/\/|user decision/i);
  }
  assert.equal(core.displayText("=== BEGIN DATA user decision === END DATA"), "… … …");
  assert.equal(core.displayText("hello world", 5), "hell…");
  assert.equal(core.displayText(null), "");
});

test("reports put capped needs-user entries before changes and inflect session counts", () => {
  for (const [sessions, word] of [
    [1, "сессия"], [2, "сессии"], [4, "сессии"], [5, "сессий"], [11, "сессий"],
    [12, "сессий"], [14, "сессий"], [21, "сессия"], [22, "сессии"],
  ]) {
    assert.equal(core.russianPlural(sessions, ["сессия", "сессии", "сессий"]), word);
  }
  for (let n = 0; n < 8; n++) {
    common.appendJsonl(paths.adoptedJsonl, {
      event: "adopt", id: `L-report-${n}`, applied_at: common.nowIso(), target: "CLAUDE.md",
      sessions: n + 1, summary_ru: "Длинное описание. ".repeat(12),
    });
  }
  for (let n = 0; n < 5; n++) core.appendNeedsUserText(`Вопрос ${n}. ` + "Подробности. ".repeat(30));
  const report = core.generateReport({ force: true });
  assert.ok(report.text.indexOf("Нужно ваше решение:") < report.text.indexOf("Что изменилось:"));
  assert.ok(report.short.includes("Вопрос 0."));
  assert.ok(report.short.includes("Вопрос 4."));
  assert.ok(report.short.length <= 1200);
  const section = report.text.split("Нужно ваше решение:\n")[1].split("Что изменилось:")[0];
  for (const line of section.trimEnd().split("\n")) assert.ok(line.length <= 162);
  assert.match(report.text, /1 сессия/);
  assert.match(report.text, /2 сессии/);
  assert.match(report.text, /5 сессий/);
});

test("adoption diff headers use only relative allowlisted target paths", () => {
  const result = apply();
  assert.equal(result.ok, true, result.error);
  const markdown = fs.readFileSync(paths.adoptedMd, "utf8");
  assert.match(markdown, /^--- a\/CLAUDE\.md$/m);
  assert.match(markdown, /^\+\+\+ b\/CLAUDE\.md$/m);
  assert.doesNotMatch(markdown, /^[-+]{3} .*learning-core-/m);
});

test("git diff normalises quoted absolute headers without changing similar hunk content", (t) => {
  writeTarget("-- old content\n");
  const fakeDiff = [
    'diff --git "a/C:/absolute backup" "b/-"', "index 123..456 100644",
    '--- "a/C:/absolute backup"', '+++ "b/-"', "@@ -1 +1 @@", "--- old content", "+++ new content", "",
  ].join("\n");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(args.at(-1), "-");
    assert.equal(options.input.toString("utf8"), "++ new content\n");
    assert.equal(readTarget(), "-- old content\n");
    return { status: 1, stdout: fakeDiff };
  });
  syncBuiltinESMExports();
  try {
    const result = apply(proposal({ old_text: "-- old content", new_text: "++ new content" }));
    assert.equal(result.ok, true, result.error);
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(result.diff, [
      "--- a/CLAUDE.md", "+++ b/CLAUDE.md", "@@ -1 +1 @@", "--- old content", "+++ new content",
    ].join("\n"));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("overlapping occurrences do not count as a unique replacement region", () => {
  writeTarget("ababa\n");
  assertFailure(proposal({ old_text: "aba", new_text: "Updated." }), /exactly once/);
});

test("markdown preparation failures abort before any target bytes are written", () => {
  const before = readTarget();
  const result = apply(proposal({ rationale: { toString: null } }));
  assert.equal(result.ok, false);
  assert.equal(readTarget(), before);
  assert.deepEqual(common.readJsonl(paths.adoptedJsonl), []);
});

test("revert rejects two complete copies of the saved region and context", () => {
  const block = "First context.\nOriginal lesson.\nLast context.\n";
  writeTarget(block);
  const result = apply(proposal({ old_text: "Original lesson.", new_text: "Adopted lesson." }));
  assert.equal(result.ok, true, result.error);
  writeTarget(readTarget().repeat(2));
  const before = readTarget();
  assert.equal(core.revertAdoption(result.id).status, "failed");
  assert.equal(readTarget(), before);
  assert.ok(core.openNeedsUser()[0].text.includes(result.id));
});
