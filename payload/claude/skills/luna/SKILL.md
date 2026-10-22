---
name: luna
description: Delegate execution to Codex - gpt-6.1-sol at high effort for every moderately complex or complex implementation, gpt-6-luna for simple/mechanical work, research and critics; reasoning effort chosen per task. Use for every clear, well-bounded job instead of doing it inline or spawning a Claude subagent - implementing features, fixes, refactors, tests, migrations, scripts, AND information gathering (codebase exploration, "find where X happens", reading logs/docs, summarising files, research). NOT for visual/UI/UX design work - Opus (the main Claude model) always does design itself, never delegated. Luna CAN generate raster images (imagegen) for sites and other tasks.
---

# Luna & Sol: Codex executors

**Codex `gpt-6.1-sol`** implements anything non-trivial; **`gpt-6-luna`** handles simple work, research and critics. Claude is the orchestrator: it
understands the request, slices the work, writes the briefs, runs independent slices in
parallel, verifies the results, and talks to the user.

Always call Luna through the wrapper. It pins model and effort on the command line (the
Codex app rewrites `$CODEX_HOME/config.toml`), closes stdin, and prepends standing rules
to every prompt (no sub-agents; in write mode: match neighbouring style, never loosen
tests, and use the result contract below):

```bash
bash ~/.claude/scripts/luna.sh -w -e <effort> -C "<repo root>" -f <brief.md> -o <result.md>   # write
bash ~/.claude/scripts/luna.sh -r -e <effort> -C "<repo root>" -f <brief.md> -o <result.md>   # read-only
bash ~/.claude/scripts/luna-status.sh <result.md> [...]                                        # state of a job
```

## Model routing: Sol 6.1 for anything non-trivial, Luna for simple work

| Model | When | How |
|---|---|---|
| `gpt-6.1-sol` (**default for implementation**) | **Every implementation beyond simple** (user decision, 2026-10-21): features (even single-module), non-trivial bug fixes, refactors, migrations, multi-file changes, new logic or architecture, data/API/auth/money/concurrency/security, debugging and root-cause work, fix rounds that need judgement, anything Luna failed at once. **When in doubt, Sol.** | `luna.sh -w -m gpt-6.1-sol -e high ...`. **Always `high`** (user decision, 2026-09-30): never max or ultra |
| `gpt-6-luna` | Simple, mechanical work with no decisions: renames, reformatting, boilerplate, trivial one-file edits, copying an existing pattern exactly, fix rounds made of precise one-line findings. Plus information gathering/scouts, critics and images | `luna.sh` as usual, effort from the table below |

- **Don't use `gpt-6-astra`** (user decision, 2026-09-30).
- **Best-of-2 for the riskiest pieces**: one implementation on Luna (`max`) and one on Sol 6.1 (`high`),
  each in its own worktree. Different models fail differently, so this pair beats two runs of one model.
- **Critics stay on Luna** (cheap, parallel, one shared process). For a serious panel you may add ONE
  extra critic on Sol for a different perspective: `luna.sh -r -m gpt-6.1-sol -e high -f critic.brief.md -o ...`,
  launched in parallel with the panel. `luna-pool.mjs` uses a single model per run (`LUNA_MODEL`).
- Sol is slower than Luna. Keep Sol slices coherent, but don't make them bigger just because the model is stronger.
- Sol 6.1 needs Codex CLI ≥ 0.159. Check it with `codex debug models | grep gpt-6.1-sol`.

## Effort routing — choose `-e` every time

`max` is slow. Use it only where deeper reasoning changes the outcome.

| Task | `-e` |
|---|---|
| New core logic, money/finance, concurrency/locking, security-sensitive code, reproducing tricky formulas/specs exactly, root-cause of a hard bug | `max` |
| Feature slice following an existing pattern, API/CRUD/services, UI wiring, migrations modelled on existing ones, fix rounds with precise findings | `high` |
| Reformatting, renames, mechanical multi-file edits, boilerplate, codebase exploration / "find where X", summarising files/logs | `medium` |
| Readiness check, trivial single-file edit you still want delegated | `low` |

Critics: `high` by default, `max` only for an attacker on auth/money/secrets (see `luna-critics`).

## Launch hygiene (a silent failure costs as much as a slow job)

- Run long jobs with Bash `run_in_background: true`. You are notified when they finish; don't poll.
- **Never discard the wrapper's output** (`> /dev/null 2>&1` hides setup errors). Redirect only stdout if you must; keep stderr.
- **Right after launching, check once** with `luna-status.sh <result.md>`. Expect `state=running` (or `waiting-ram`). `failed` → read `error=` and fix now, not when the notification arrives.
- **Then always arm a stall watcher** (user requirement, 2026-10-21: hung agents went unnoticed and wasted a lot of time).
  A hung job never sends a completion notification, so waiting for one is not enough. Use the Monitor tool:
  `Monitor(command: "bash ~/.claude/scripts/luna-watch.sh -i 300 <out.md> [<out.md> ...]", timeout_ms: 1800000,
  description: "<job>: stall or end")`. One watcher can cover several jobs. It emits `STALL` when a running job's log hasn't
  grown for `-i` seconds (use 300 normally; 600 for Sol/max jobs that think long between steps), `RESUMED`, `END state=…`,
  and `GONE` when the wrapper died without updating its status. Re-arm it when it expires while jobs still run.
  **On `STALL`, act immediately**: read the tail of `<out>.log` and `luna-status.sh`. If it's really stuck (no new commands,
  the model isn't thinking), kill it (`taskkill //PID <winpid> //T //F`, or Ctrl-C the wrapper task), tell the user, and
  re-brief smaller or switch model. Don't wait it out silently. The wrapper also has its own idle and total timeouts
  (`LUNA_IDLE_MAX_S`, `LUNA_TIMEOUT_S`) that end a hung job with `state=stalled`.
- When the user asks "is it stuck?", answer from `luna-status.sh` (`state`, `elapsed_min`, `log_idle_s`, `last_note`), not from memory.
- `state=waiting-ram` means the machine is short of memory. Say so, and don't stack more write jobs.
- **NEVER edit the shared wrappers in place** (`luna.sh`, `luna-pool.mjs`, `luna-daemon.mjs`, `luna-panel.sh`): every Claude
  session runs them, and bash reads a script WHILE running it. An in-place edit crashed a live job on 2026-10-21. To change them, write
  `<file>.next`, test it, then swap atomically (`mv -f`) when `luna-daemon.mjs --status` and the process list show nothing running.
  A job that edits a wrapper runs through a COPY (`cp luna.sh "$TMP/luna-run.sh"`) and its brief forbids touching the live file.
  Tested 2026-10-22: even `mv -f` breaks a running bash script on this machine. Since then `luna.sh` and `luna-watch.sh` are wrapped
  in one `{ … exit $?; }` block (bash parses the whole file first), so swapping THEM mid-run is safe; keep that wrapper (line 2 and
  the last two lines) in every edit and add it to any new long-running bash script. For a file without it, swap with
  `bash ~/.claude/scripts/luna-swap-when-idle.sh <next> <live> [...]` started detached: it waits until no non-ghost job runs
  (log `~/.claude/luna-run/swap.log`).
- **Stopping a job**: `bash ~/.claude/scripts/luna-stop.sh <out.md> [...]`. Stopping the Claude Bash task (TaskStop) does NOT stop the
  wrapper or its Codex turn; an orphaned job kept editing files after its task was stopped (2026-10-21).
  Since 2026-10-22 the daemon keeps a job whose wrapper died running for `LUNA_DAEMON_ORPHAN_GRACE_S` (600 s): relaunching
  the SAME brief with the SAME `-o` reattaches to it (same job, no rerun); a changed brief on the same `-o` fails fast
  (rc 1, "output or log already in use"), so give it a fresh `-o`. `luna-stop.sh` also cancels such orphaned jobs; after a
  raw `taskkill` of a wrapper, run it too.
- **Refusal guard**: read-only jobs that answer "I can't read files" without running any command are
  retried once automatically at `high` (status `retry=1`). Low/medium read-only jobs refuse this way quite often.
  The retry fixes it, but it costs time, so prefer `high` for scouts whose answers matter.
- The wrappers tell the model it is the EXECUTOR and must ignore global AGENTS.md rules about delegating
  implementation (the user's Codex AGENTS.md says "Sol must delegate to Terra"). Without this, Sol 6.1 refuses to implement.
- Exit codes: `2` = wrapper/setup error (see `.status`), `75` = gave up waiting for RAM → run later or inline.

## Priorities: quality first, then speed through parallelism (quota is not a concern)

The user says Codex quota is effectively unlimited (2026-09-29). **Never economise on Luna
jobs.** Spend them wherever they raise the quality of the final result or cut wall-clock time:

- **Research fan-out before implementing.** For anything non-trivial, launch several
  read-only scouts at once, one per subsystem or open question ("how does X work",
  "where is Y used", "what breaks if Z changes"). Run them through `luna-pool.mjs`, which
  puts many read-only jobs in one Codex process. Claude merges their findings into the spec
  and briefs. This is cheaper than one scout that has to hold everything.
- **Best-of-2 for the riskiest core pieces** (new core logic, money, concurrency, security).
  Two independent `max` implementations of the same brief, each in its own git worktree.
  Claude compares them, picks or merges, and runs critics on the result.
- **Bigger, sharper critic panels.** Size them by risk (see `luna-critics`). For a large diff,
  give each subsystem its own critic instead of one critic for everything.
- **Decompose by independence, not by size.** A slice is the biggest coherent unit that
  one engineer could finish without talking to anyone. Don't cut below that: tiny slices
  lose the big picture, and seams between them are where bugs appear. Parallelise across
  independent slices, not inside one.

## Slicing and parallelism

- **Keep each slice to ~40 minutes of Luna work or less.** Split anything bigger into slices with their own acceptance commands (e.g. "parser + evaluator" and "scheme + golden tests" instead of one "engine" job).
- **Run independent slices at the same time.** Slices are independent when their write sets (files) don't overlap. Never let two write-mode jobs touch the same files. A slice that only *imports* another slice's API can start once that API's names/types are fixed in the brief.
- **Don't idle while a job runs.** Launch the next independent slice, do Claude-owned work (design/UI, reviewing the previous slice, drafting the next brief), or run critics on the previous slice.
- Concurrency is RAM-gated by the wrapper: a job starts only while available RAM minus its estimate (250 MB read-only, 700 MB write) stays above a reserve (max(1 GB, 6% of RAM)). Starts are spaced ~5 s apart through a lock shared across sessions. Knobs: `LUNA_RAM_RESERVE_MB`, `LUNA_JOB_MB`, `LUNA_NO_GATE=1`. Set `LUNA_JOB_MB` to match what the job's acceptance commands actually run: `LUNA_JOB_MB=300` for a write job whose checks are only syntax/lint (e.g. `node --check`, `bash -n`), and raise it for heavy suites (a big jest/pytest run can take 1–2 GB).
- **Heavy builds are the real RAM risk, not Codex itself** (measured 2026-10-21: a 4-job `cargo build` of Codex dropped free RAM
  to 346 MB; big Rust crates take 1.5–3 GB per rustc). Any job whose checks compile Rust/C++, run webpack/tsc on a large repo, or
  run big test suites must (a) say in the brief how many build threads to use (`CARGO_BUILD_JOBS=2`, `-j2`, `--maxWorkers=2`), and
  (b) set `LUNA_JOB_MB` to a realistic figure (Rust workspace build ≈ 3000–4000, large jest/pytest ≈ 1500). Never run two such jobs at once.
- **Heavy-command gate (machine-wide, 2026-10-21, after heavy checks from 4 sessions crashed the Claude app and froze the PC).**
  `scripts/heavy-gate.mjs` is a PreToolUse/PostToolUse hook on Bash|PowerShell in every session: tsc, vitest/jest,
  pytest, npm/pnpm install|ci|build|test, cargo, bundlers, docker build take one of 2 slots and start only while
  ≥ 2500 MB RAM is free (waits up to 10 min, then runs anyway; fail-open). Dev servers (`npm run dev`, `vite`,
  `tsx server.ts`) only wait for RAM (≤ 3 min), no slot. Codex jobs get a preamble rule to run
  `node heavy-gate.mjs wait` before each heavy command (RAM-only, writes nothing). State/log:
  `~/.claude/luna-run/heavy/`; `node ~/.claude/scripts/heavy-gate.mjs --status`. Off switch: `HEAVY_GATE_OFF=1` or
  the file `~/.claude/heavy-gate-off`. Knobs: `HEAVY_GATE_MAX`, `HEAVY_GATE_MIN_FREE_MB`, `HEAVY_GATE_MAX_WAIT_S`.
  A `heavy-gate: waited …` system message is the gate working, not a hang.
- Measured on this machine (2026-10-21): one job costs ~120 MB (codex.exe + node_repl + code-mode-host), plus ~65 MB of pwsh while a shell command runs, plus whatever its tests use. The wrapper calls the native `codex.exe` directly and skips the npm `sh` + `node` shim (−40 MB per job; `LUNA_DIRECT_EXE=0` turns that off, `LUNA_CODEX_BIN` pins a binary). Don't disable `code_mode_host`: the shell tool runs through it. The biggest RAM consumer on this machine is usually the **Codex desktop app** (ChatGPT.exe + app-server + leaked MCP node processes, 2–3 GB). If jobs sit in `waiting-ram`, suggest the user restart or close it.
- **The Luna daemon (default engine): every `luna.sh` job, from every session, runs as a thread in ONE shared `codex app-server`**
  (`luna-daemon.mjs`, started on demand, exits after 10 idle minutes). A job costs ~16 MB instead of ~120 MB. The daemon owns RAM admission
  (shared lock + free-RAM check before every turn start), caps concurrent turns (`LUNA_DAEMON_MAX`, default 12), schedules
  **fairly between Claude sessions** (owner = `CLAUDE_CODE_SESSION_ID`; the session with the fewest running jobs goes next), and enforces
  idle/total timeouts and "client gone" on its side. Status states: `queued` (waiting for a slot or RAM, NOT a stall),
  `waiting-daemon` (queue full, HTTP 429), then `running`. See everything that's running: `node ~/.claude/scripts/luna-daemon.mjs --status`.
  `LUNA_DAEMON=0` forces the old one-process-per-job `codex exec` path; the wrapper falls back to it by itself if the daemon can't start.
  If the daemon dies mid-job, read-only jobs are retried once via exec; write jobs are never re-run.
  `luna-panel.sh` (critics) now runs each brief as a `luna.sh -r` job, i.e. as threads in the same daemon with the same busybox shell
  and fair scheduling; `LUNA_POOL=1` opts back into the old one-app-server-per-panel `luna-pool.mjs` engine.
  HTTP resets fixed (2026-10-21): early rejections (401/413/404/429 before the body is read) now use a lingering close; crash-loop
  and idle shutdowns wait for a quiet moment and close connections gracefully; tree kills no longer block the event loop. Residual:
  under extreme machine load (disk saturated + paging) every process, the daemon included, can freeze for 10–25 s, so curl may time
  out. Since 2026-10-22 luna.sh treats such a daemon as busy, not dead, while its process is alive and discovery is unchanged
  (budget `LUNA_DAEMON_BUSY_MAX_S`, default 300 s), so freezes no longer cancel jobs machine-wide.
- **Custom Codex build (busybox shell)**: `<LUNA_CUSTOM_CODEX_ROOT>/dist/bin/codex.exe` is Codex 0.162.1 + our patch
  (`<LUNA_CUSTOM_CODEX_ROOT>/codex/LUNA-PATCH.md`, `luna-shell.patch`) adding the `default_shell` / `default_shell_path` config keys. luna.sh
  uses it automatically when it and `~/.claude/bin/luna-sh/sh.exe` (busybox-w32) exist: model commands then run in a POSIX `sh` of
  ~5–7 MB instead of PowerShell at ~65 MB (`shell=busybox-sh` in the status). Git Bash can NOT be used: MSYS dies in Codex's
  sandbox. `allow_login_shell=false` is required (busybox's login shell cd's to HOME). `LUNA_CUSTOM_CODEX=0` forces the stock Codex.
  After a Codex upgrade, the custom build stays at its version: re-apply the patch on the new tag and rebuild
  (`powershell -File <LUNA_CUSTOM_CODEX_ROOT>/build.ps1 -Jobs 2`; ~65 min, needs ~7 GB RAM, so run it when nothing else is heavy), copy
  `target/release/codex.exe` over `dist/bin/codex.exe`, then `node ~/.claude/scripts/luna-daemon.mjs --stop` so the next job starts a
  daemon on the new binary (a running daemon keeps the old one in memory).
  The root is set in `~/.claude/luna-harness.env` (default `%USERPROFILE%\codex-build`),
  see `codex-build/BUILD.md` in the luna-harness repo.
- **Changing the Luna pane** (`~/.claude/local-plugins/luna-panel`): sessions run it from the plugin CACHE
  (`~/.claude/plugins/cache/luna-local/luna-panel/<version>/`), so an edit reaches nobody until you bump `version`
  in `.claude-plugin/plugin.json`, run `claude plugin marketplace update luna-local && claude plugin update
  luna-panel@luna-local`, and sessions restart (lost a day of fixes to this on 2026-10-22). `/luna` does not reload code.
- **Seeing everything**: the Claude Desktop pane **Luna** (`/luna`, mod `luna-panel`) shows RAM, Claude + Codex limits, the daemon
  per session, and every running job with what it's doing now and how long it's been silent. In a terminal:
  `bash ~/.claude/scripts/luna-overview.sh` (`-w` to refresh), or `node ~/.claude/scripts/luna-overview.mjs --human`.
- **Leaked Codex-plugin brokers froze the PC once** (2026-10-21: 58 orphan `app-server-broker.mjs` + `codex.exe` trees, ~1.5 GB).
  Causes: the plugin abandoned slow brokers alive, and two Stop hooks (the plugin's own + `hooks/codex-review-gate-run.mjs`) raced
  on one `broker.json`. Fixes: plugin patch in `scripts/lib/broker-lifecycle.mjs` (both plugin copies; originals `*.orig-luna`,
  lost on plugin update), the duplicate runner is off while `~/.claude/codex-gate-runner-off` exists, and
  `scripts/luna-reap-brokers.mjs` (started by the collector/cleaner at most every 10 min) kills brokers no `broker.json` names.
  Check: `node ~/.claude/scripts/luna-reap-brokers.mjs --dry-run`; log `~/.claude/luna-run/reap-brokers.log`.
  2026-10-22: a long-lived broker also leaked one node_repl/node/conhost kit per review thread (116 node_repl, ~5 GB in 13 h)
  because the plugin never unsubscribed threads. Patched in both plugin copies (`app-server-broker.mjs` unsubscribes a
  client's threads on disconnect; `lib/app-server.mjs` adds `-c thread_unload_delay_secs=0`; originals `*.orig-luna2`),
  verified end-to-end (tree unchanged after shell-using tasks). The reaper also recycles a broker whose tree holds more than
  `LUNA_REAP_MAX_REPL` (40) node_repl after 60 min, in case a plugin update drops the patch.
  Same patch line also passes `-c windows.sandbox=unelevated` (like luna.sh): with config.toml's `elevated`, npm codex
  0.162.x's setup helper fails "setup refresh had errors" (node_repl.exe held open by other Codex processes), so the
  review gate could not run any shell command. Verified: a plugin task now runs `echo` fine.
- The wrapper runs lean (no MCP servers, plugins, apps). A task that needs a server: `LUNA_MCP="name"`; everything: `LUNA_FULL=1`. Sub-agents inside Luna are off by default; allow them only for a genuinely parallel job with `LUNA_ALLOW_SUBAGENTS=1`.

## Image generation (Codex imagegen)

Luna can generate raster images with Codex's built-in image tool. Use it for website hero art,
illustrations, backgrounds, icons, textures, placeholders, mockup imagery, game and marketing assets,
or any other picture a task needs. It was verified on 2026-09-29: it works through `luna.sh` in lean mode.

- **Be proactive** (user rule, 2026-10-21): don't wait to be asked. If a site, app, game, artifact, deck or doc would be better
  with real imagery, generate it as part of the task instead of leaving placeholders, stock URLs or emoji. No permission needed.
- **Opus owns the art direction.** Choosing what the image should be is design: subject, style, palette,
  composition and mood must fit the page. So Opus writes the prompt and judges the result. Luna only
  executes the generation and the file handling.
- **Run it as a write job**, because Luna has to copy the file into the project:
  `LUNA_JOB_MB=400 bash ~/.claude/scripts/luna.sh -w -e medium -C "<project dir>" -f img.brief.md -o img.out.md`.
  The tool stores the original under `$CODEX_HOME/generated_images/<thread>/exec-*.png`, and Luna copies it.
  `luna-pool.mjs` is read-only, so it can't save into the project.
- **Brief:**
  - the full visual prompt: subject, style, palette, composition, aspect ratio (e.g. "wide 16:9"),
    and "no text";
  - the exact target path and file name;
  - what to report back: the source path, the final path and the pixel size.
  Ask for post-processing in the same brief if needed (resize, crop, WebP/AVIF conversion, several sizes).
- **Check every image visually**: Opus opens it with Read before using it. If it misses, re-brief with
  concrete corrections.
- **Variants are cheap** (quota is not a concern). For important visuals, launch 2–4 parallel jobs with
  different prompts or seeds, each writing its own file (`hero-a.png`, `hero-b.png` …). Opus picks the best.
- **Keep text out of images.** Put headings and labels in HTML/CSS, because generated lettering is unreliable.
- It takes about 1 min per image at `medium`, with a PNG of roughly 1–2 MB. Optimise before shipping to production.

## Routing

| Goes to Luna | Stays with Claude |
|---|---|
| Implementing a feature slice, bug fix, refactor, tests, scripts, config-as-code | **Design is done by Opus itself, never delegated** (not to Luna, not to Sonnet/subagents). That covers visual/UI/UX, layout, styling/CSS, typography, colour, component markup and look & feel, design tokens, artifact pages, anything aesthetic. Opus is far better than GPT with the visuals of websites. |
| Information gathering: explore a codebase, trace a flow, find usages, read logs, summarise docs/files, compare options from sources | Talking to the user, clarifying intent, final decisions and trade-offs |
| Mechanical multi-file edits, migrations, renames | Synthesising Luna/critic output, verifying it, deciding what to accept |
| Drafting a plan for a clear task (Claude reviews it) | Trivial one-line edits, when briefing takes longer than doing |
| Critic roles → see the `luna-critics` skill | Anything Luna failed at twice. Take over or re-brief, don't loop |

Mixed tasks: split them. Luna handles logic, data and wiring; Claude handles markup, styles
and visual decisions. Use Luna (read-only, usually `-e medium`) instead of the
`Explore`/`general-purpose`/Sonnet subagents for information gathering. Use Claude's own
WebSearch/WebFetch only when the job needs the live web and Luna can't reach it.

## The executors are literal: diligent, but they don't think beyond the brief

User observation (2026-10-21), true for Sol and Luna alike, and most true of Sol: **they do exactly
what the brief says, and do it well, but miss things nobody wrote down, or do those things wrong.**
They don't ask "what else does this touch?" and they don't push back on a bad plan. The judgement
stays with Claude. Treat every brief as the complete spec: whatever isn't in it gets skipped or guessed.

**Before sending a brief, ask yourself "what will it miss?"** and write the answers into the brief:

- **System fit and ripples.** For bug fixes, trace the end-to-end flow and root cause before choosing a local patch; check whether the same gap exists elsewhere or calls for a shared layer. List every place that must change: callers, types/interfaces, config, migrations, fixtures, docs/README, i18n, feature flags, and tests. For each, write "also update X"; never leave it implied. For a rename or a signature change, require an `rg` over the repo for the old name.
- **Edge cases.** Name the cases explicitly: empty/null/missing, very large, unicode/encoding, Windows paths
  and CRLF, concurrent calls, retries/partial failure, timezones, permissions. Write the expected behaviour
  for each one, not just "handle edge cases".
- **Decisions, not open questions.** Where there are options, Claude picks one and states it with the reason.
  If you can't decide yet, run a read-only scout first and then brief. Ambiguity gets resolved by a guess,
  and the guess is often wrong.
- **What must not change.** List the invariants and the behaviour outside scope, plus explicit non-goals
  ("don't refactor neighbours", "don't change the public API").
- **Intent.** Add one paragraph on WHY the change exists and who uses it, so the unavoidable small
  guesses go in the right direction.
- **Observable done.** Give the exact commands and the expected output, not "make sure it works".
- **Ask for its guesses.** Every brief must say: "List every assumption you made where the brief was silent
  under `## Deviations` as `Assumption: …`." That turns its silent guesses into things Claude can check.

**After it returns, review what the brief didn't say**, not only what it did:
- Grep for ripples it may have skipped (old names, other call sites, docs mentioning the behaviour).
- Read the `Assumption:` lines and check each one.
- Look for behaviour changes outside the requested scope, and for unhandled cases on the main path.
- Give critics the original user goal, not just the brief, so they can catch "did what was asked, missed what was meant".

**Fix rounds**: name the exact gap and the general rule ("you changed X but not its 3 callers; whenever a
signature changes, update every caller"), because it won't generalise from a single example on its own.

**Sol vs Luna under this lens**: Sol executes a long, precise brief over many files very reliably, so the
more complex the job, the more exhaustive the brief must be. A thin brief to Sol is the most expensive
mistake: it will confidently build the wrong thing at scale.

## Writing the brief

Luna sees none of this conversation. Every brief stands alone. Before writing it, spend a
minute collecting the house style from 2–3 neighbouring files (line length, formatting,
test layout) and the exact verification commands. Then go through the "what will it miss?"
list above.

1. **Goal**: what "done" means, in 1–3 sentences.
2. **Context**: repo root, relevant files/dirs, stack, house rules from CLAUDE.md/AGENTS.md.
3. **Exact scope**: files to create/touch, files not to touch, what is out of scope.
4. **Quality bar** (mandatory; this is what saves a rework round):
   - Style observed in neighbouring files: max line length (default ≤120–140), one statement per line, how tests are grouped (`describe`/`it` blocks), naming.
   - **The exact list of tests that must exist** (cases, not "add tests").
   - **Invariants that must not change** (golden counts/tolerances, public API names/signatures, behaviour of X), and "report instead of loosening".
   - Known pitfalls you already spotted (e.g. "column is named minutes but holds hours").
5. **Acceptance**: checkable bullets plus the **exact** commands to run (typecheck/lint + only the targeted tests). Add: "Run only these commands. No full test suites, benchmarks, memory/scale reports, or dev servers unless listed."
6. **Output**: the wrapper already enforces the result contract (`## Changes` / `## Verification` / `## Deviations` / `## Not done`)
   and tells it to list its guesses as `Assumption:` lines under Deviations; add anything task-specific you need reported.
7. Write mode, literally: **"Edit files only. Do NOT run git add / git commit / git push."**

For research, ask for **evidence** (file:line or source for every claim) and for an explicit
list of what could not be determined.

For a **fix round**, put every accepted finding (critics + your own review) into ONE brief,
each with evidence and the expected behaviour, plus the invariants to preserve.

## After Luna returns

- **Clean up right away** (user rule; see CLAUDE.md section 5): once a job's result is verified and used, delete its brief,
  `.out.md`/`.log`/`.status`/`.err`, any wrapper copy and any smoke/test dirs it needed. Delete each extra backup once the change
  is verified, keeping at most one pre-change backup per file. Stop the job's `luna-watch` monitor. Every brief you write also
  says: "delete any temp files/scripts you created outside the requested deliverables before finishing".

- Check `luna-status.sh`: `done` is expected; `incomplete` means contract headings are
  missing — read the result carefully and ask for the missing part if it matters.
- Write mode: `git status` + `git diff`; check the diff against the acceptance criteria and
  the quality bar (line lengths, test list, invariants); run the verification gates
  yourself. Wrong or incomplete → re-brief with the specific gap.
- Research: spot-check the key claims before relying on them.
- Commit yourself (never Luna), following the repo's commit rules.
- Moderately complex change → run `luna-critics`, ideally **in parallel with starting the
  next independent slice**.

## Fallback (never stall)

If Luna errors, hits a quota or rate limit, has an auth problem, or times out repeatedly, do
the work inline or via a Sonnet subagent, tell the user in one line that Codex was skipped
and why, and go back to Luna once it recovers. Quick readiness check:
`bash ~/.claude/scripts/luna.sh -e low "Reply with exactly: OK"`.

<!-- learning:protected:begin -->
## Self-improvement loop (automatic, all projects)

User decision (2026-10-21): lessons from past sessions are applied automatically, including to this skill,
`luna-critics` and `~/.claude/CLAUDE.md`. Code and design: `~/.claude/scripts/learning/` (DESIGN.md); data: `~/.claude/learning/`.
- **Capture** (Stop/SessionEnd hook, no model): user corrections, interrupts, luna job failures/stalls/refusal retries,
  `Assumption:` lines, critic outputs and accepted/rejected syntheses → `events.jsonl`.
- **Daily** (SessionStart, >24 h and ≥5 new events): Luna proposes edits; code gates them (≥2 independent sessions or
  1 explicit correction, verbatim quotes, protected lines, size budget); a Sol critic must approve. Rest is logged.
- Every edit gets a backup, an `adopted.md` entry and an id: `bash ~/.claude/scripts/learning-revert.sh <id>`
  (`--list`). Edits that later correlate with new failures are auto-reverted.
- Session start may show a short Russian report or "needs your decision" items: relay them to the user in 2–4 lines.
- Pause: create `~/.claude/learning/PAUSED`. State: `node ~/.claude/scripts/learning/loop.mjs status`.
- Feed it: keep `Assumption:` lines and "accepted / rejected (reason)" in critic syntheses.
<!-- learning:protected:end -->
