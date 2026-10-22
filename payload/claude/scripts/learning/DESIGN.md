# Self-improvement loop for the global Claude Code setup — design

Inspired by google-research/harness2 ("harnessing-level recursion": a persistent harness of
adopted edits plus evidence-backed lessons). harness2 itself is NOT used (Linux/Vertex/OpenCode only).
All model work runs on the user's Codex subscription through `~/.claude/scripts/luna.sh`.

**User decision (2026-10-21): full automation.** Lessons are applied without asking, including edits to
`~/.claude/CLAUDE.md` and the `luna` / `luna-critics` skills, behind the mandatory safeguards below.

## Data flow

```
Stop / SessionEnd hook ──► extract.mjs (incremental, deterministic, no LLM) ──► learning/events.jsonl
SessionStart hook ───────► loop.mjs run --if-due (detached)        └─ also run by loop.mjs before every reflection
                           │
                           ├─ 1. extract (catch up)
                           ├─ 2. digest of new events + open candidates + active adoptions + target files
                           ├─ 3. PROPOSER (Codex, read-only)  → JSON proposals with cited event ids + verbatim quotes
                           ├─ 4. deterministic gate (core.mjs validate): evidence real? threshold? allowlist?
                           │     protected lines untouched? denylist? size budget?
                           ├─ 5. ADVERSARIAL CRITIC (Codex, other model, read-only, clean context) → verdict per proposal
                           ├─ 6. apply approved edits (backup + adopted.jsonl/.md + id) / log the rest / needs-user
                           ├─ 7. regression reverts (same evidence rules, events newer than the adoption)
                           └─ 8. log.md line ("nothing met the threshold" when nothing applied), weekly report
SessionStart hook ───────► surfaces the pending weekly report (Russian) + open "needs user" items
learning-revert.sh <id> ─► core.mjs revert (reverse patch; whole-file restore only if file unchanged since)
```

## Files

Code (`~/.claude/scripts/learning/`): `common.mjs` (paths, locks, IO, sanitising), `extract.mjs`,
`core.mjs` (validate / apply / revert / report), `loop.mjs` (CLI), `prompts/proposer.md`,
`prompts/critic.md`, `test/*.mjs`. Hooks: `~/.claude/hooks/learning-capture.mjs` (Stop, SessionEnd),
`~/.claude/hooks/learning-session-start.mjs` (SessionStart). Entry point: `~/.claude/scripts/learning-revert.sh`.

Data (`~/.claude/learning/`, override with `CLAUDE_LEARNING_DIR`; targets root `~/.claude` override with
`CLAUDE_HOME_DIR` — tests always set both to temp dirs):

| File | What |
|---|---|
| `events.jsonl` (+ `events.1.jsonl` after rotation at 20 MB) | normalised evidence events |
| `extract-state.json` | per-transcript byte offsets, seen status files, known luna out paths |
| `loop-state.json` | last run, last report, pending report + shown count |
| `config.json` | thresholds and budgets (defaults written on first run) |
| `adopted.jsonl` | append-only records `{"event":"adopt",...}` / `{"event":"revert",...}`; status = fold |
| `adopted.md` | human-readable journal of every applied edit (diff, evidence, rationale, revert command) |
| `candidates.jsonl` | lessons that did not pass (below threshold / gate / critic) — evidence accumulates across runs |
| `needs-user.md` | conflicts with user decisions or safety; items `NU-…`, surfaced at session start |
| `log.md` | one line per run |
| `reports/YYYY-MM-DD.md` | weekly Russian report |
| `runs/<run-id>/` | proposer/critic briefs and outputs, validation results, summary |
| `backups/<adoption-id>/` | full copy of the target file before the edit (and before a revert) |
| `PAUSED` | kill switch: reflection/apply stop, capture continues |
| `CAPTURE_OFF` | kill switch for capture hooks |

## Event schema (one JSON object per line)

```json
{"v":1,"id":"<16 hex>","type":"user_correction","ts":"2026-10-21T09:12:00.000Z","captured":"…",
 "session":"<uuid or ''>","project":"<projects/ dir name or ''>","source":"<abs path>#L<line> | <status path>",
 "quote":"<= 400 chars, sanitised","context":"<= 300 chars: previous assistant text","data":{}}
```

Types and `data`:
- `user_correction` — a genuine human message that corrects / pushes back / states a rule.
  `data: {kind: "correction"|"frustration"|"rule", explicit: bool, matched: [pattern names], uuid, byte}`.
  `explicit` needs a corrective speech act ("я же сказал", "ты снова", "всегда делай…", "I told you") outside
  quoted/pasted/code spans and not in a question, in a message ≤ 600 chars.
- `user_interrupt` — `[Request interrupted by user…]`; quote = the next human message (if any).
  Transcript-derived events use `id = eventId(type, "uuid", entry.uuid)`, so lines copied into forked/resumed
  transcripts dedupe; `data.byte` = byte offset of the source line (for provenance re-checks).
- `luna_job` — terminal state of a luna.sh / luna-pool job read from `<out>.status`.
  `data: {state, finished, rc, model, effort, sandbox, retry, refusal_suspected, missing, error, elapsed_s, out_path,
  notable}`; `notable` = state not `done`, or retry, or refusal_suspected, or missing headings. A status left
  non-terminal for > 3 h (wrapper died) becomes `state: "abandoned"`.
- `executor_assumption` — an `Assumption:` line from a job's result. `data: {out_path, job_state}`.
- `critic_output` — one critic's result file. `data: {persona, findings: {critical, high, medium, low}, findings_text: [{severity, title}], out_path}`;
  only when a brief with the same stem sits next to the out file.
- `critic_synthesis` — Claude's synthesis of a panel. `data: {accepted: n, rejected: n}`; quote = up to 5 accepted/rejected lines.

Genuine human message = `type:"user"`, not `isSidechain`, not `isMeta`, no `tool_result` block, and
(`origin.kind == "human"` or `turnOrigin == "human"`, or — for old transcripts without these fields — text that
does not start with `<` and is not a "This session is being continued…" summary). Messages that came from other
sessions, task notifications, hooks or system reminders are never evidence of a user correction.

## Evidence threshold (enforced in code, not by the model)

A lesson may be applied only if its cited events (ids must exist; quotes must be verbatim substrings of the stored
event) come from **≥ 2 distinct sessions**, or include **≥ 1 `user_correction` with `explicit: true`** read from a
transcript. Everything else is logged to `candidates.jsonl` and re-offered to the next run with its evidence.
Only `user_correction` events and `luna_job` / `executor_assumption` events with `data.trusted` count (trusted = out
file under a Claude scratchpad or `~/.claude/luna-run`, **or** a record in `~/.claude/learning/jobs.jsonl` whose
`status_sha256` matches the current `.status` bytes).
critic_output, critic_synthesis, user_interrupt and untrusted job events are context only. The adversarial critic
must also return an `evidence_map` tying a counting event to the new text, checked by code.
Independence: cited events are grouped by `data.uuid` (else by identical quote text); each group counts once, for
the session of its earliest event. Every cited event is re-verified against its source (`verifyEventProvenance`:
the transcript line at `data.byte` must still be a genuine human message containing the quote and re-classify the
same way; status/out files must still say the same) — a forged row in events.jsonl fails the gate.
A regression revert needs the same threshold using events newer than the adoption.

## Protected content (read-only for the loop)

In every target file a line is protected if it matches any of:
`user decision|user requirement|user observation|user correction|user says|решение пользователя`,
`\(user, \d{4}-\d\d-\d\d\)`, `\buser\b.*\b20\d\d-\d\d-\d\d\b`, `\bNEVER\b`, or lies inside
`<!-- learning:protected:begin -->` … `<!-- learning:protected:end -->` or YAML frontmatter.
Safety and confirmation lines are also read-only, using the case-insensitive `SAFETY_LINE_RE` list:
`\bnever\b`, `\bdon'?t\b.*\b(delete|remove|push|commit|use|hand|run)\b`, `\bdo not\b`, `\bmust not\b`,
`\bask\b`, `\bconfirm`, `\bpermission`, `\bapprov`, `\bconsent`, `\bdestructive\b`, `\birreversib`,
`\bdelete\b`, `\bsafety\b`, `\bsecurity\b`, `\bsecret`, `\bcredential`, `\bpassword`, `\btoken`,
`prompt[- ]injection`, `\buntrusted\b`, `\bcommits? itself\b`, `\bnever commits\b`, `\bgit (push|commit|reset)\b`.
An edit may not overlap a protected line, and the multiset of protected lines must be identical after the edit.
`new_text` is checked for minted user decisions using the original `PROTECT_RE` and protected markers;
the extra safety patterns are used only for line protection. Newly added weakening vocabulary (exceptions,
skipping checks, automatic approval, disabling safeguards and proceeding without confirmation) is denied
deterministically. Such conflicts go to `needs-user.md`; model-generated display text is sanitised there and in reports.
Automatic regression reverts require a three-day observation window unless newer cited evidence includes an
explicit user correction from a transcript. Reverse patches require the entire adopted region and its saved
adjacent contexts to be intact and unique; whole-file restoration requires the unchanged post-adoption hash.

## Allowed targets and budgets (defaults in `config.json`)

`CLAUDE.md` ≤ 11500 bytes, `skills/luna/SKILL.md` ≤ 24000, `skills/luna-critics/SKILL.md` ≤ 10500.
Net growth per edit ≤ 700 chars; ≤ 3 edits per run. If the resulting file exceeds its byte budget, growth must be
strictly negative; equal-length replacements fail. Target realpaths must equal their allowlisted paths beneath
the real home directory, rejecting directory junctions and symlinks even when they lead elsewhere inside that home.
Apply rechecks the original byte hash immediately before writing; either journal append failing restores the backup
and records a compensating revert if the adoption was already journaled.
Candidate evidence merges by event id across observations; candidate appends and size-triggered atomic compaction
share a lock. Compaction defaults to 2 MB and retains recent records while dropping expired or old closed keys.
Nothing else (settings.json, hooks, scripts, memory) is ever edited by the loop.

## Prompt-injection stance

Job registry: wrappers call `registry.mjs` (`recordJob` / CLI `node registry.mjs record <out>`) immediately after
writing the final status. JSONL records: `{v:1,out,status_sha256,started,finished,state,model,pid}`; all but `v` are
strings. The CLI exits 0, stays silent and never creates directories; any later `.status` rewrite invalidates
the record. Old jobs are not backfilled: only jobs finished after wrappers call it can gain registry trust.
Anything running commands as the user can also call `recordJob` or append a line: this closes the path-pattern
hole and detects later status edits, but is not cryptographic proof, like the transcript-forgery limit.
The registry cannot tell wrapper records from same-user records (no same-user secret can). Only the last 64 MiB
is read (~190k records), and there is no compaction yet.

Transcripts and job outputs are untrusted data. Defences, in order: only genuine human messages become correction
events; quotes are sanitised (pasted content, system reminders, tags, secrets removed); both model passes receive the
data inside fenced blocks marked as data; the deterministic gate rejects anything outside the allowlist, any
URL / shell download / credential / permission / kill-switch vocabulary added by `new_text`, fabricated quotes and
thin evidence; a second model (different from the proposer) must approve; every edit is small, journaled, reported
and revertable with one command.
