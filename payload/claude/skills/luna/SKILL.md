---
name: luna
description: Executor infrastructure for delegated work - the tier dispatcher (conveyor/exec.mjs) that routes each tier and panel to the providers the owner set in the Luna panel; brief writing, launch hygiene, stall watching, stopping jobs, images. Use for every clear, well-bounded job instead of doing it inline - implementing features, fixes, refactors, tests, migrations, scripts, AND information gathering (codebase exploration, reading logs/docs, summarising, research). The process around it (playbooks, principles, review) is pstack poteto-mode. NOT for visual/UI/UX design work - Opus always does design itself. Executors CAN generate raster images.
---

# Luna: executor infrastructure

Claude (Opus) is the orchestrator: it understands the request, follows the pstack playbook, slices the work,
writes the briefs, runs independent slices in parallel, verifies the results and talks to the user. The work
itself runs on executors through **one dispatcher, by tier** (user decisions 2026-11-16):

```bash
node ~/.claude/scripts/conveyor/exec.mjs run --tier complex -w -C "<repo>" -f <brief.md> -o <result.md>  # implementation
node ~/.claude/scripts/conveyor/exec.mjs run --tier simple  -w -C "<repo>" -f <brief.md> -o <result.md>  # mechanical edits
node ~/.claude/scripts/conveyor/exec.mjs run --tier scout   -r -C "<repo>" -f <brief.md> -o <result.md>  # research
node ~/.claude/scripts/conveyor/exec.mjs run --panel review --seat <n> -w -C "<worktree>" -f <brief> -o <out>  # one review seat
node ~/.claude/scripts/conveyor/exec.mjs status                  # chains, availability, Codex/Claude usage
bash ~/.claude/scripts/luna-status.sh <result.md> [...]           # state of a job (Codex or Gemini)
```

## Tiers and providers

| Tier | Chain (first available wins) | When |
|---|---|---|
| `complex` | as configured (Luna panel) | Every implementation beyond simple: features (even single-module), non-trivial bug fixes, refactors, migrations, multi-file changes, new logic or architecture, data/API/auth/money/concurrency/security, debugging and root-cause work, fix rounds that need judgement, anything a simple executor failed at once. When in doubt, complex. |
| `simple` | as configured (Luna panel) | Simple, mechanical work with no decisions: renames, reformatting, boilerplate, trivial one-file edits, copying an existing pattern exactly, fix rounds made of precise one-line findings. |
| `scout` / `review` | as configured | Information gathering, summaries, critics. |

- The config is `~/.claude/conveyor/orchestration.json` (tiers, models, efforts, panels, pstack roles, presets);
  the user edits it in the Luna panel. Do not hand-edit it; `exec.mjs config …` exists for scripted changes.
- **Automatic fallbacks:** Codex is skipped at 80 % usage (panel setting, hysteresis); a provider that returned a
  quota/region/auth/checksum error is skipped for its TTL; the dispatcher prints one `conveyor:` line per switch
  (tell the user). A write job that already started is never re-run on another provider.
- **Exit codes of `exec.mjs run`:** 0 done; 4 hand-off: read `<out>.dispatch.json` and spawn the `Agent` tool
  with its `model` and the same brief; 5 no provider available; 6 the executor gate stayed red (project checks or
  hygiene ratchet failed after 2 fix rounds; read `## Gate` in the result); 7 another write job already runs in the
  same repository (parallel write slices need their own worktrees via `wt-new.mjs`); others come from the executor.
- **Repo profiles must be trusted:** a repository's `.claude/conveyor.json` runs its commands only after you review it
  and run `node ~/.claude/scripts/conveyor/check.mjs trust --dir <repo>` (shared across worktrees for the last five reviewed versions);
  until then the gate uses autodetected checks and default language hygiene counters and reports `profileTrust: "untrusted"`.
  Missing hygiene sections also get defaults. Baselines start from the task base outside the repository at
  `~/.claude/conveyor/baselines/<repo-identity-hash>.json`, shared across worktrees.
- **Automatic profile setup:** on the first code task without a profile, run
  `node ~/.claude/scripts/conveyor/check.mjs init --dir <repo> --write`. Review and adjust generated checks, measure
  fast/turn on the change, tell the user, and propose committing `.claude/conveyor.json` and
  `.conveyor/hygiene-baseline.json`. Init seeds from the external baseline and trusts the generated profile;
  it refuses to overwrite a profile and never commits. Omit `--write` to print only.
- **UI proof:** the first UI task in a UI repository without `.claude/skills/verify-*/SKILL.md` creates a skill via
  pstack `create-verification-skill` (isolated free port and data, Playwright drive, desktop/mobile screenshots
  retained after cleanup; see kriminalist's `verify-kriminalist`). Stop reason 9 requires fresh image artifact evidence
  for UI changes: `ledger.mjs evidence <L> --artifact <screenshot>`; calibration and user gate waivers apply.
- **Executor gate:** every write job is followed by `check.mjs` fast+turn on the job's own changes (profile
  `.claude/conveyor.json`, autodetected when absent); failures go back to the same executor as fix rounds.
- **Providers are the owner's choice**: the dispatcher picks them from the Luna panel's chains and panels
  (`exec.mjs status` shows the live setting). Never call `gem.sh` or `luna.sh` yourself for delegated work; a
  PreToolUse guard blocks `gem.sh` (diagnostic only: prefix `CONVEYOR_DIRECT_PROVIDER=1`).
- **Don't use `gpt-6-astra`** (user decision, 2026-09-30). Never the fast tier unless the user asks.
- **Best-of-2 for the riskiest pieces**: pstack `arena` with the `design` panel (one seat per worktree).
- **Reviews**: pstack `interrogate` on the `review` panel seats; persona critics from `luna-critics` for UI work.

## Effort routing — choose effort per task (simple/scout tiers)

| Task | `-e` |
|---|---|
| Scouts whose answers matter, critics, fix rounds with precise findings, pattern-following edits | `high` |
| Reformatting, renames, mechanical multi-file edits, boilerplate, codebase exploration / "find where X", summarising files/logs | `medium` |
| Readiness check, trivial single-file edit you still want delegated | `low` |

Critics: `high` by default, `max` only for an attacker on auth/money/secrets (see `luna-critics`).
- Keep implementation slices coherent, but don't make them bigger just because the model is capable.

## Launch hygiene (a silent failure costs as much as a slow job)

- **Write jobs can run the project's tests themselves** (owner 2026-10-26). `luna.sh -w` opens the sandbox to
  network/local sockets (`LUNA_NET=1`, the default for write jobs; `LUNA_NET=0` closes it) and runs those jobs as
  threads in a second shared daemon (profile `net`, `<run>/daemon-net/`; status `daemon_profile=net`; 2026-10-27:
  per-job exec cost ~180-300 MB each), so tests that start a local server or app-server subprocess work inside the job. The standing rules
  tell the executor to give test commands a ≥300 s tool timeout: under load a harness test looked «hung» only
  because the command timed out. So briefs can say «run these tests and iterate until green» instead of
  «reviewer runs»; Claude still re-runs the decisive tests before committing.
- Run long jobs with Bash `run_in_background: true`. You are notified when they finish; don't poll.
- **Never discard the wrapper's output** (`> /dev/null 2>&1` hides setup errors). Redirect only stdout if you must; keep stderr.
- **Right after launching, check once** with `luna-status.sh <result.md>`. Expect `state=running` (or `waiting-ram`). `failed` → read `error=` and fix now, not when the notification arrives.
- **Then always arm a stall watcher** (user requirement, 2026-10-21: hung agents went unnoticed and wasted a lot of time).
  A hung job never sends a completion notification, so waiting for one is not enough. Use the Monitor tool:
  `Monitor(command: "bash ~/.claude/scripts/luna-watch.sh -i 300 <out.md> [<out.md> ...]", timeout_ms: 1800000,
  description: "<job>: stall or end")`. One watcher can cover several jobs. It emits `STALL` when a running job's log hasn't
  grown for `-i` seconds (use 300 normally; 600 for complex-tier jobs that think long between steps), `RESUMED`, `END state=…`,
  and `GONE` when the wrapper died without updating its status. Re-arm it when it expires while jobs still run. Since 2026-11-18 a watcher also ends by itself: a glob argument is re-expanded every poll (`END <pattern> state=missing` if nothing matches for 10 min), a job whose files were removed ends as `state=missing`, it exits when its parent shell is gone, and after 4 h it prints `EXPIRED` (re-arm).
  **On `STALL`, act immediately**: read the tail of `<out>.log` and `luna-status.sh`. If it's really stuck (no new commands,
  the model isn't thinking), stop it (`bash ~/.claude/scripts/luna-stop.sh <out.md>`), tell the user, and
  re-brief smaller or switch model. Don't wait it out silently. The wrapper also has its own idle and total timeouts
  (`LUNA_IDLE_MAX_S`, `LUNA_TIMEOUT_S`) that end a hung job with `state=stalled`. A job that keeps making progress is
  NOT cut short (user decision, 2026-10-22: a 90-minute cap killed working jobs): stalls are caught by idle time
  (`LUNA_IDLE_MAX_S`, 15 min without log growth); `LUNA_TIMEOUT_S` is only an 8 h runaway cap.
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
  an interrupted wrapper, run it too.
- **Refusal guard**: read-only jobs that answer "I can't read files" without running any command are
  retried once automatically at `high` (status `retry=1`). Low/medium read-only jobs refuse this way quite often.
  The retry fixes it, but it costs time, so prefer `high` for scouts whose answers matter.
- **Model-error retry** (user request, 2026-10-27, after 5 jobs died mid-work on `Selected model is at capacity`):
  a turn that fails with a transient model/server error (capacity, overloaded, 5xx, stream disconnected) is continued
  automatically up to 2 more times on the SAME model, effort and session — daemon: new turn in the same thread; exec:
  `codex exec resume <session>` — after a pause of 60 s, then 120 s, each plus 0–30 % random jitter so jobs that failed together don’t retry in one wave. The agent gets a `LUNA AUTO-RETRY k/N` note telling
  it to check what it already did and carry on. Never retried: usage limit/quota, auth, 4xx/invalid request, stops,
  stalls, daemon crashes. Status shows `model_retry=<k>`; the log shows `luna: model error: …; retry k/N`. Knobs:
  `LUNA_MODEL_RETRIES` (default 2, `0` = old behaviour), `LUNA_MODEL_RETRY_DELAY_S` (default 60). With retries on, exec
  sessions are recorded (not `--ephemeral`) and their rollout file is deleted when the job ends.
- The wrappers tell the model it is the EXECUTOR and must ignore global AGENTS.md rules about delegating
  implementation (the user's Codex AGENTS.md says "Sol must delegate to Terra"). This keeps the executor focused on implementation.
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
  Two independent complex-tier implementations of the same brief (pstack `arena`, `design` panel seats), each in its own git worktree.
  Claude compares them, picks or merges, and runs critics on the result.
- **Bigger, sharper critic panels.** Size them by risk (see `luna-critics`). For a large diff,
  give each subsystem its own critic instead of one critic for everything.
- **Decompose by independence, not by size.** A slice is the biggest coherent unit that
  one engineer could finish without talking to anyone. Don't cut below that: tiny slices
  lose the big picture, and seams between them are where bugs appear. Parallelise across
  independent slices, not inside one.

## Slicing and parallelism

- **Parallelise as much as possible without losing quality** (owner rule, restated 2026-10-26). The default plan is
  waves, not a chain: every slice, scout and critic whose inputs are ready starts at once, limited only by the RAM gate
  and by write sets not overlapping. When a plan looks sequential, look for the cut that makes it a wave — e.g. one
  small core slice that fixes the API, then one job per family/module in parallel, each in its own worktree and its
  own files (2026-10-26: 9 tool-registry families ran at once instead of 7 serial slices). Quality limits: never two
  writers on the same files, never slices smaller than a coherent unit, and every parallel result is still verified.
- **Keep each slice to ~40 minutes of Luna work or less.** Split anything bigger into slices with their own acceptance commands (e.g. "parser + evaluator" and "scheme + golden tests" instead of one "engine" job).
- **Run independent slices at the same time.** Slices are independent when their write sets (files) don't overlap. Never let two write-mode jobs touch the same files. A slice that only *imports* another slice's API can start once that API's names/types are fixed in the brief.
- **Don't idle while a job runs.** Launch the next independent slice, do Claude-owned work (design/UI, reviewing the previous slice, drafting the next brief), or run critics on the previous slice.
- Concurrency is RAM-gated by the wrapper: a job starts only while available RAM minus its estimate (250 MB read-only, 700 MB write) stays above a reserve (max(1 GB, 6% of RAM)). Starts are spaced ~5 s apart through a lock shared across sessions. Knobs: `LUNA_RAM_RESERVE_MB`, `LUNA_JOB_MB`, `LUNA_NO_GATE=1`. Set `LUNA_JOB_MB` to match what the job's acceptance commands actually run: `LUNA_JOB_MB=300` for a write job whose checks are only syntax/lint (e.g. `node --check`, `bash -n`), and raise it for heavy suites (a big jest/pytest run can take 1–2 GB).
- **Heavy builds are the real RAM risk.** Any job whose checks compile Rust/C++, run webpack/tsc on a large repo, or
  run big test suites must (a) say in the brief how many build threads to use (`CARGO_BUILD_JOBS=2`, `-j2`, `--maxWorkers=2`), and
  (b) set `LUNA_JOB_MB` to a realistic figure (Rust workspace build ≈ 3000–4000, large jest/pytest ≈ 1500).
  Never run two such jobs at once.
- **Heavy-command gate (machine-wide, 2026-10-21, after heavy checks from 4 sessions crashed the Claude app and froze the PC).**
  `scripts/heavy-gate.mjs` is a PreToolUse/PostToolUse hook on Bash in every session: tsc, vitest/jest,
  pytest, npm/pnpm install|ci|build|test, cargo, bundlers, docker build take one of two default slots; they start while
  ≥ 2500 MB RAM is free (waits up to 10 min, then runs anyway; fail-open). Dev servers (`npm run dev`, `vite`,
  `tsx server.ts`) only wait for RAM (≤ 3 min), no slot. Codex jobs get a preamble rule to run
  `node heavy-gate.mjs wait` before each heavy command (RAM-only, writes nothing). State/log:
  `~/.claude/luna-run/heavy/`; `node ~/.claude/scripts/heavy-gate.mjs --status`. Off switch: `HEAVY_GATE_OFF=1` or
  the file `~/.claude/heavy-gate-off`. Knobs: `HEAVY_GATE_MAX`, `HEAVY_GATE_MIN_FREE_MB`, `HEAVY_GATE_MAX_WAIT_S`.
  A `heavy-gate: waited …` system message is the gate working, not a hang.
- **Codex account lease (Linux):** Luna turns, the harness review runner and live probes (check16, bot runs, deploy
  smoke with a turn) all take SHARED leases and run alongside each other: owner decision 2026-10-30 «Считать по одному
  замеру» — a live check16 under ~6 concurrent Codex jobs delivered normally, account queue near zero — so live runs
  need no quiet account. The exclusive lease is only for a measurement that itself needs an idle account. For one, in
  every active Claude session run `/codex:setup --disable-review-gate` (the SessionStart sentinel does not affect
  running sessions), `touch ~/.claude/codex-gate-paused` to pause new sessions and drain existing plugin and direct
  Codex work, then `node ~/.claude/scripts/account-lease.mjs run --mode exclusive --purpose "<probe>"`
  `--report <report.json> -- <command>`. Such a probe is valid only if the report has zero `intrusions` and zero
  `sampling_errors`; a missing report is invalid. Sampling can miss short-lived processes and cannot observe other
  machines, and a daemon started before the lease code ignores leases, so coordinate all account users. Re-enable the
  gates afterward and restore the sentinel's previous state.
- **Linux**: Use `/proc/meminfo` (`MemAvailable`) for free RAM. Exec wrappers and daemon/pool app-servers use `renice +10`;
  children inherit the lower CPU priority.
  The wrapper prefers the npm package's native binary, avoiding the Node shim; `LUNA_CODEX_BIN` pins an executable.
  Codex uses system bash (`shell=bash`). Do not disable `code_mode_host`: the shell tool runs through it.
  The wrapper/panel source `LUNA_PROXY_ENV_FILE` (default `~/.config/luna-proxy.env`, with a legacy fallback)
  if `HTTPS_PROXY` is empty; a directly started daemon reads only proxy/PATH exports. Logs/status hide proxy values.
  `pytest_gate.py` defaults to 4 workers (cap 4); the free-disk floor is 10 GB. Env overrides remain available.
- **The Luna daemon (default engine): every `luna.sh` job, from every session, runs as a thread in ONE shared `codex app-server`**
  (`luna-daemon.mjs`, started on demand, exits after 10 idle minutes). The daemon owns RAM admission
  (shared lock + free-RAM check before each turn start), caps turns (`LUNA_DAEMON_MAX`, default 12), schedules
  **fairly between Claude sessions** (owner = `CLAUDE_CODE_SESSION_ID`; the session with the fewest running jobs goes next), and enforces
  idle/total timeouts and "client gone" on its side. Status states: `queued` (waiting for a slot or RAM, NOT a stall),
  `waiting-daemon` (queue full, HTTP 429), then `running`. See everything that's running: `node ~/.claude/scripts/luna-daemon.mjs --status`.
  `LUNA_DAEMON=0` forces the old one-process-per-job `codex exec` path; the wrapper falls back to it by itself if the daemon can't start.
  If the daemon dies mid-job, read-only jobs are retried once via exec; write jobs are never re-run.
  `luna-panel.sh` (critics) runs each brief as a `luna.sh -r` job, as threads in the shared daemon with system bash
  and fair scheduling; `LUNA_POOL=1` opts back into the old one-app-server-per-panel `luna-pool.mjs` engine.
  HTTP resets fixed (2026-10-21): early rejections (401/413/404/429 before the body is read) now use a lingering close; crash-loop
  and idle shutdowns wait for a quiet moment and close connections gracefully; tree kills no longer block the event loop. Residual:
  under extreme machine load (disk saturated + paging) every process, the daemon included, can freeze for 10–25 s, so curl may time
  out. Since 2026-10-22 luna.sh treats such a daemon as busy, not dead, while its process is alive and discovery is unchanged
  (budget `LUNA_DAEMON_BUSY_MAX_S`, default 300 s), so freezes no longer cancel jobs machine-wide.
- **Changing the Luna pane** (`~/.claude/local-plugins/luna-panel`): sessions run it from the plugin CACHE
  (`~/.claude/plugins/cache/luna-local/luna-panel/<version>/`), so an edit reaches nobody until you bump `version`
  in `.claude-plugin/plugin.json`, run `claude plugin marketplace update luna-local && claude plugin update
  luna-panel@luna-local`, and sessions restart (lost a day of fixes to this on 2026-10-22). `/luna` does not reload code.
- **Seeing everything**: the Claude Desktop pane **Luna** (`/luna`, mod `luna-panel`) shows RAM, Claude + Codex limits, the daemon
  per session, and every running job with what it's doing now and how long it's been silent. In a terminal:
  `bash ~/.claude/scripts/luna-overview.sh` (`-w` to refresh), or `node ~/.claude/scripts/luna-overview.mjs --human`.
- **Leaked Codex-plugin brokers**: `scripts/luna-reap-brokers.mjs` runs at most every 10 min from the collector/cleaner.
  It reads `/proc/*/cmdline` and `/proc/*/stat`, rechecks process identities, and stops orphan broker trees
  not named by any `broker.json`; recorded brokers with more than `LUNA_REAP_MAX_REPL` (40) node_repl are recycled
  after 60 min. Check: `node ~/.claude/scripts/luna-reap-brokers.mjs --dry-run`;
  log: `~/.claude/luna-run/reap-brokers.log`. Fresh plugin installs have no local lifecycle patches.
  The review-gate hooks use `~/.claude/plugins/cache/openai-codex/codex/<version>/` and system Node.
  While `~/.claude/codex-gate-runner-off` exists, only the plugin's own Stop hook runs the gate.
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
- **Stylize, never ask for high detail** (user rule, 2026-10-22). Prompts like "rich texture", "highly detailed", "many fine
  details" make the model produce noise, ripples and cobweb-like hairlines. Ask for a stylized illustration: large clean
  shapes, soft gradients, a limited palette, readable silhouettes, minimal texture; explicitly forbid noise, grain, speckle,
  hairline cracks and dense micro-detail; draw paving, brick and roof tiles as broad simple shapes. Keep the area under UI or
  game objects calm and put detail at the edges. Anything the user should touch or move is a separate sprite, not painted
  into the background.
- **Keep text out of images.** Put headings and labels in HTML/CSS, because generated lettering is unreliable.
- It takes about 1 min per image at `medium`, with a PNG of roughly 1–2 MB. Optimise before shipping to production.

## Routing

| Goes to an executor (by tier) | Stays with Claude |
|---|---|
| Implementing a feature slice, bug fix, refactor, tests, scripts, config-as-code | **Design is done by Opus itself, never delegated** (not to any executor, not to Sonnet/subagents). That covers visual/UI/UX, layout, styling/CSS, typography, colour, component markup and look & feel, design tokens, artifact pages, anything aesthetic. Opus is far better than GPT with the visuals of websites. |
| Information gathering: explore a codebase, trace a flow, find usages, read logs, summarise docs/files, compare options from sources | Talking to the user, clarifying intent, final decisions and trade-offs |
| Mechanical multi-file edits, migrations, renames | Synthesising Luna/critic output, verifying it, deciding what to accept |
| Drafting a plan for a clear task (Claude reviews it) | Trivial one-line edits, when briefing takes longer than doing |
| Review → pstack `interrogate` (`review` panel); persona critics → `luna-critics` | Anything an executor failed at twice. Take over or re-brief, don't loop |

Mixed tasks: split them. Executors handle logic, data and wiring; Claude handles markup, styles
and visual decisions. Use the `scout` tier (read-only) instead of the
`Explore`/`general-purpose`/Sonnet subagents for information gathering. Use Claude's own
WebSearch/WebFetch only when the job needs the live web and executors can't reach it.

## The executors are literal: diligent, but they don't think beyond the brief

User observation (2026-10-21), applying to every executor (Sol, Luna, Gemini): **they do exactly
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

**After it returns, review the diff against the original goal and scope:**
- Grep for skipped ripples (old names, call sites, docs); check every assumption, out-of-scope changes and unhandled main paths.
- For user-facing flows, map each request to its visible state, available choice, action order and acceptance check.
- Give critics the original goal and diff.

**Fix rounds**: state the exact gap and general rule; if failure recurs, inspect the prior fix and recheck the failure path.

**Complex tier under this lens**: the executor handles long, precise briefs over many files, so the
more complex the job, the more exhaustive the brief must be. A thin brief to the complex tier is an expensive
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
   - **Tests: none by default** — the change is proven by the Acceptance commands and one real run. Name a test only
     for what could lose work or data, break production, or touch money/security: the exact cases (≤ 3, extending an
     existing test or one parametrized test where possible), then "No other tests". The gate allows 5 new test cases
     per job; a real need gets a line `Test budget: N` in the brief.
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

- **Clean up right away** (user rule; see CLAUDE.md "Always clean up after yourself"): once a job's result is verified and used, delete its brief,
  `.out.md`/`.log`/`.status`/`.err`, any wrapper copy and any smoke/test dirs it needed. Delete each extra backup once the change
  is verified, keeping at most one pre-change backup per file. Stop the job's `luna-watch` monitor. Every brief you write also
  says: "delete any temp files/scripts you created outside the requested deliverables before finishing".

- Check `luna-status.sh`: `done` is expected; `incomplete` means contract headings are
  missing — read the result carefully and ask for the missing part if it matters.
- Write mode: check status; compare diff to acceptance and quality; run gates yourself. Wrong/incomplete → re-brief with the gap. Verify deployed fixes live before claiming done. Widespread blanks: separate missing source data from incomplete retrieval.
- Research: spot-check key claims first.
- Commit yourself (never Luna), following the repo's commit rules.
- Moderately complex change → run `luna-critics`, ideally **in parallel with starting the
  next independent slice**.

## Fallback (never stall)

The dispatcher already falls back along each chain as configured in the Luna panel. If a whole chain is
unavailable (`exec.mjs` exit 5) or an executor times out repeatedly, do the work inline, tell the user in one line
which providers were down and why, and go back to the dispatcher once they recover. Readiness checks:
`node ~/.claude/scripts/conveyor/exec.mjs status` (live chains and why a provider is skipped).

<!-- learning:protected:begin -->
## Self-improvement loop (automatic, all projects)

User decision (2026-10-21): lessons from past sessions are applied automatically, including to this skill,
`luna-critics` and `~/.claude/CLAUDE.md`. Code and design: `~/.claude/scripts/learning/` (DESIGN.md); data: `~/.claude/learning/`.
- **Capture** (Stop/SessionEnd hook, no model): user corrections, interrupts, luna job failures/stalls/refusal retries,
  `Assumption:` lines, critic outputs and accepted/rejected syntheses → `events.jsonl`.
- **Daily** (SessionStart, >24 h and ≥5 new events): Luna proposes edits; code gates them (≥2 independent sessions or
  1 explicit correction, verbatim quotes, protected lines, size budget); a Codex Sol critic must approve. Rest is logged.
- Every edit gets a backup, an `adopted.md` entry and an id: `bash ~/.claude/scripts/learning-revert.sh <id>`
  (`--list`). Edits that later correlate with new failures are auto-reverted.
- Session start may show a short Russian report or "needs your decision" items: relay them to the user in 2–4 lines.
- Pause: create `~/.claude/learning/PAUSED`. State: `node ~/.claude/scripts/learning/loop.mjs status`.
- Feed it: keep `Assumption:` lines and "accepted / rejected (reason)" in critic syntheses.
- **Checks first**: lessons a program could detect become proposed checks (harness hook/gate or project lint/test),
  never built automatically. They queue in `~/.claude/learning/checks.md`; session start shows only their ids.
  Build one only after the user's yes, then `node ~/.claude/scripts/learning/loop.mjs checks done <id>`
  (`… checks dismiss <id>` if declined).
<!-- learning:protected:end -->
