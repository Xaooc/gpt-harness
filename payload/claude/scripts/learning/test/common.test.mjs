import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.CLAUDE_LEARNING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learn-test-"));
process.env.CLAUDE_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learn-test-"));
const common = await import("../common.mjs");
const { paths } = common;

after(() => {
  fs.rmSync(process.env.CLAUDE_LEARNING_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_HOME_DIR, { recursive: true, force: true });
});

test("paths stay under the temporary learning directory and ensureDirs creates directories", () => {
  assert.equal(common.HOME_CLAUDE, process.env.CLAUDE_HOME_DIR);
  assert.equal(common.LEARN_DIR, process.env.CLAUDE_LEARNING_DIR);
  assert.equal(common.SCRIPTS_DIR, fileURLToPath(new URL("../", import.meta.url)));
  assert.equal(Object.isFrozen(paths), true);
  const names = {
    events: "events.jsonl", eventsOld: "events.1.jsonl", jobs: "jobs.jsonl", extractState: "extract-state.json",
    loopState: "loop-state.json", config: "config.json", adoptedJsonl: "adopted.jsonl",
    adoptedMd: "adopted.md", candidates: "candidates.jsonl", needsUser: "needs-user.md", logMd: "log.md",
    reportsDir: "reports", runsDir: "runs", backupsDir: "backups", locksDir: "locks",
    paused: "PAUSED", captureOff: "CAPTURE_OFF",
  };
  assert.deepEqual(Object.keys(paths), Object.keys(names));
  for (const [key, name] of Object.entries(names)) {
    assert.equal(paths[key], path.join(common.LEARN_DIR, name));
    assert.equal(path.isAbsolute(paths[key]), true);
  }
  common.ensureDirs();
  common.ensureDirs();
  for (const dir of [common.LEARN_DIR, paths.reportsDir, paths.runsDir, paths.backupsDir, paths.locksDir]) {
    assert.equal(fs.statSync(dir).isDirectory(), true);
  }
  assert.equal(common.findNode(), process.execPath);
  assert.equal(common.isPaused(), false);
  assert.equal(common.isCaptureOff(), false);
  fs.writeFileSync(paths.paused, "");
  fs.writeFileSync(paths.captureOff, "");
  assert.equal(common.isPaused(), true);
  assert.equal(common.isCaptureOff(), true);
  fs.unlinkSync(paths.paused);
  fs.unlinkSync(paths.captureOff);
});

test("tryLock excludes another owner and permits acquisition after idempotent release", () => {
  const release = common.tryLock("exclusive", 60000);
  assert.equal(typeof release, "function");
  const owner = common.readJson(path.join(paths.locksDir, "exclusive", "owner.json"), null);
  assert.deepEqual(owner, { pid: process.pid, host: os.hostname(), started: owner.started, nonce: owner.nonce });
  assert.match(owner.nonce, /^[a-f0-9]{32}$/);
  assert.equal(Number.isFinite(Date.parse(owner.started)), true);
  assert.equal(common.tryLock("exclusive", 60000), null);
  release();
  const next = common.tryLock("exclusive", 60000);
  assert.equal(typeof next, "function");
  release();
  assert.equal(common.tryLock("exclusive", 60000), null);
  next();
});

test("tryLock takes over stale owners and uses directory mtime for unreadable owners", () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const dir = path.join(paths.locksDir, "stale");
  fs.mkdirSync(dir);
  common.writeJsonAtomic(path.join(dir, "owner.json"), { pid: 1, host: "old", started: old.toISOString() });
  const release = common.tryLock("stale", 60000);
  assert.equal(typeof release, "function");
  release();
  for (const ownerText of [null, "malformed"]) {
    fs.mkdirSync(dir);
    if (ownerText !== null) fs.writeFileSync(path.join(dir, "owner.json"), ownerText);
    assert.equal(common.tryLock("stale", 60000), null);
    fs.utimesSync(dir, old, old);
    const takeover = common.tryLock("stale", 60000);
    assert.equal(typeof takeover, "function");
    takeover();
  }
});

test("withLock reports contention, returns values and releases when the callback throws", () => {
  const release = common.tryLock("callback", 60000);
  assert.deepEqual(common.withLock("callback", { waitMs: 0 }, () => assert.fail("busy")), { locked: false });
  assert.deepEqual(common.withLock("callback", { waitMs: 20, pollMs: 5 }, () => assert.fail("busy")), {
    locked: false,
  });
  release();
  assert.deepEqual(common.withLock("callback", {}, () => 42), { locked: true, value: 42 });
  const error = new Error("callback failure");
  assert.throws(() => common.withLock("callback", {}, () => { throw error; }), (caught) => caught === error);
  const next = common.tryLock("callback", 60000);
  assert.equal(typeof next, "function");
  next();
});

test("stale takeover renames the old directory and excludes a second contender", (t) => {
  const dir = path.join(paths.locksDir, "takeover");
  fs.mkdirSync(dir);
  common.writeJsonAtomic(path.join(dir, "owner.json"), { started: "2000-01-01T00:00:00.000Z" });
  const rename = t.mock.method(fs, "renameSync");
  const release = common.tryLock("takeover", 60000);
  assert.equal(typeof release, "function");
  try {
    assert.equal(rename.mock.callCount(), 1);
    assert.equal(rename.mock.calls[0].arguments[0], dir);
    assert.ok(rename.mock.calls[0].arguments[1].startsWith(`${dir}.stale-${process.pid}-`));
    const owner = common.readJson(path.join(dir, "owner.json"), null);
    assert.equal(common.tryLock("takeover", 60000), null);
    assert.deepEqual(common.readJson(path.join(dir, "owner.json"), null), owner);
    assert.equal(fs.readdirSync(paths.locksDir).some((name) => name.startsWith("takeover.stale-")), false);
  } finally {
    release();
  }
});

test("release leaves a lock with a changed nonce intact", () => {
  const dir = path.join(paths.locksDir, "nonce");
  const release = common.tryLock("nonce", 60000);
  assert.equal(typeof release, "function");
  const ownerFile = path.join(dir, "owner.json");
  const owner = common.readJson(ownerFile, null);
  common.writeJsonAtomic(ownerFile, { ...owner, nonce: "successor" });
  release();
  assert.equal(common.readJson(ownerFile, null).nonce, "successor");
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const contender of [false, true]) {
  test(`fresh quarantined owner is preserved when restore ${contender ? "loses" : "succeeds"}`, (t) => {
    const name = `fresh-quarantine-${contender}`;
    const dir = path.join(paths.locksDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ started: "2000-01-01T00:00:00Z" }));
    const rename = fs.renameSync;
    let quarantined;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (from === dir) {
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ started: common.nowIso(), nonce: "fresh" }));
        rename(from, to);
        quarantined = to;
        if (contender) {
          fs.mkdirSync(dir);
          fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ started: common.nowIso(), nonce: "next" }));
        }
        return;
      }
      if (contender && from === quarantined) throw Object.assign(new Error("busy"), { code: "EEXIST" });
      return rename(from, to);
    });
    assert.equal(common.tryLock(name, 60000), null);
    const preserved = contender ? quarantined : dir;
    assert.equal(common.readJson(path.join(preserved, "owner.json"), null).nonce, "fresh");
    assert.equal(fs.existsSync(quarantined), contender);
    if (contender) assert.equal(common.readJson(path.join(dir, "owner.json"), null).nonce, "next");
    fs.rmSync(dir, { recursive: true, force: true });
    if (contender) fs.rmSync(quarantined, { recursive: true, force: true });
  });
}

for (const successor of [false, true]) {
  test(`owner write failure ${successor ? "preserves a different nonce" : "removes its empty directory"}`, (t) => {
    const name = `write-failure-${successor}`;
    const dir = path.join(paths.locksDir, name);
    const ownerFile = path.join(dir, "owner.json");
    const write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (file, ...args) => {
      if (file !== ownerFile) return write(file, ...args);
      if (successor) write(file, JSON.stringify({ started: common.nowIso(), nonce: "successor" }));
      throw new Error("fixture owner write failure");
    });
    assert.equal(common.tryLock(name, 60000), null);
    assert.equal(fs.existsSync(dir), successor);
    if (successor) {
      assert.equal(common.readJson(ownerFile, null).nonce, "successor");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const code of ["ENOENT", "EPERM", "EEXIST"]) {
  test(`takeover losing rename with ${code} retries mkdir without deleting the successor`, (t) => {
    const name = `lost-${code}`;
    const dir = path.join(paths.locksDir, name);
    fs.mkdirSync(dir);
    const ownerFile = path.join(dir, "owner.json");
    common.writeJsonAtomic(ownerFile, { started: "2000-01-01T00:00:00.000Z" });
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (from !== dir) return rename(from, to);
      fs.writeFileSync(ownerFile, JSON.stringify({ started: new Date().toISOString(), nonce: "winner" }));
      throw Object.assign(new Error("lost takeover"), { code });
    });
    assert.equal(common.tryLock(name, 60000), null);
    assert.equal(common.readJson(ownerFile, null).nonce, "winner");
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("atomic JSON roundtrips and readJson falls back on missing, empty and malformed files", () => {
  const file = path.join(common.LEARN_DIR, "roundtrip.json");
  const value = { text: "example", nested: [1, true, null] };
  common.writeJsonAtomic(file, value);
  assert.deepEqual(common.readJson(file, null), value);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
  common.writeJsonAtomic(file, { replaced: true });
  assert.deepEqual(common.readJson(file, null), { replaced: true });
  const fallback = { fallback: true };
  assert.equal(common.readJson(path.join(common.LEARN_DIR, "missing"), fallback), fallback);
  for (const text of ["", "{malformed"]) {
    common.writeFileAtomic(file, text);
    assert.equal(common.readJson(file, fallback), fallback);
  }
  assert.equal(fs.readdirSync(common.LEARN_DIR).some((name) => name.endsWith(".tmp")), false);
});

test("appendJsonl writes array lines and readJsonl skips malformed and partial lines", () => {
  const file = path.join(common.LEARN_DIR, "records.jsonl");
  assert.deepEqual(common.readJsonl(file), []);
  const records = [{ id: "a" }, { id: "b" }, { id: "c" }];
  common.appendJsonl(file, records);
  assert.equal(fs.readFileSync(file, "utf8"), records.map((obj) => JSON.stringify(obj) + "\n").join(""));
  assert.deepEqual(common.readJsonl(file), records);
  fs.writeFileSync(file, JSON.stringify(records[0]) + "\n{broken}\n" + JSON.stringify(records[1]) + "\n");
  common.appendJsonl(file, records[2]);
  fs.appendFileSync(file, '{"partial":');
  assert.deepEqual(common.readJsonl(file), records);
});

test("loadEvents merges rotated events first, deduplicates ids and filters timestamps", () => {
  const old = { id: "old", ts: "2026-10-20T10:00:00.000Z" };
  const first = { id: "shared", ts: "2026-10-21T10:00:00.000Z", quote: "first" };
  const second = { ...first, quote: "second" };
  const recent = { id: "new", ts: "2026-10-21T11:00:00.000Z" };
  assert.deepEqual(common.loadEvents(), []);
  common.appendJsonl(paths.eventsOld, [old, first]);
  common.appendJsonl(paths.events, [second, recent]);
  assert.deepEqual(common.loadEvents(), [old, first, recent]);
  assert.deepEqual(common.loadEvents({ sinceIso: first.ts }), [first, recent]);
  assert.deepEqual(common.loadEvents({ sinceIso: "2026-10-22T00:00:00.000Z" }), []);
});

test("sanitizeQuote removes injected markup, redacts secrets, collapses whitespace and truncates", () => {
  const input = 'before <pasted_content source="user">line one\nline two</pasted_content> after';
  assert.equal(common.sanitizeQuote(input), "before [pasted] after");
  assert.equal(common.sanitizeQuote("a<system-reminder>hidden\ntext</system-reminder>b"), "ab");
  assert.equal(common.sanitizeQuote('<div class="x">inner <b>text</b></div>'), "inner text");
  for (const secret of [
    "sk-abcdefghijklmnopqrstuvwx", "ghp_" + "a".repeat(20), "xoxb-" + "a".repeat(10),
    "AKIA" + "A".repeat(16), "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + ".signature",
    "A".repeat(50),
  ]) {
    assert.equal(common.sanitizeQuote("key " + secret), "key [redacted]");
  }
  assert.equal(common.sanitizeQuote(" a\r\n\tb \t c "), "a b c");
  const long = common.sanitizeQuote("word ".repeat(100));
  assert.equal(long.length, 400);
  assert.equal(long.endsWith("…"), true);
  assert.equal(common.sanitizeQuote("hello world", 5), "hell…");
  assert.equal(common.sanitizeQuote("hello", 0), "");
  for (const value of [null, undefined, 123, {}, Symbol("quote")]) {
    assert.equal(common.sanitizeQuote(value), "");
  }
});

test("toWinPath handles Git Bash drives, quotes, home paths and backslashes without resolving", () => {
  const home = os.homedir().replace(/\\/g, "/");
  assert.equal(common.toWinPath("/c/Users/PC/x y.md"), "C:/Users/PC/x y.md");
  assert.equal(common.toWinPath('"~/a/b"'), home + "/a/b");
  assert.equal(common.toWinPath("C:\\a\\b"), "C:/a/b");
  assert.equal(common.toWinPath("$HOME/z"), home + "/z");
  assert.equal(common.toWinPath("${HOME}/z"), home + "/z");
  assert.equal(common.toWinPath("'~'"), home);
  assert.equal(common.toWinPath("/tmp/x"), "/tmp/x");
  assert.equal(common.toWinPath("../a"), "../a");
  assert.equal(common.toWinPath(""), "");
  assert.equal(common.toWinPath(null), "");
});

test("eventId is deterministic, separates parts and changes with input; sha256 matches a known digest", () => {
  const id = common.eventId("one", "two");
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(common.eventId("one", "two"), id);
  assert.notEqual(common.eventId("other", "two"), id);
  assert.notEqual(common.eventId("one", "other"), id);
  assert.notEqual(common.eventId("onetwo"), id);
  assert.equal(common.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("importing common prints nothing to stdout", () => {
  const url = new URL("../common.mjs", import.meta.url);
  const stdout = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(url.href)})`], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(stdout, "");
});
