# Global instructions (all projects)

> Project-level `CLAUDE.md`, explicit user requests, and any active project
> workflow (e.g. GSD) take precedence over this file when they conflict.

## Harness source

How this Claude→Codex harness is built (scripts, daemon, skills, hooks, installer, learning loop) lives in the package
repo `Xaooc/gpt-harness` (private), cloned at `C:/dev/luna-harness`. Read it to understand the design: `README.md`,
`PACKAGE-SPEC.md`, `INSTALL.md`, `SELF-LEARNING.md`; `payload/` is what this machine runs, `payload-linux/` is the
other platform's version, `codex-build/` is this PC's custom Codex build (Rust, busybox-shell patch; see `BUILD.md`, `LUNA-PATCH.md`).
`~/.claude` is the installed copy: when you change a harness script or skill there, make the same change in
`payload/` (and in `payload-linux/` unless it is platform-specific), update the payload `manifest.json` hashes, and
commit and push (or tell the user it needs a push when this clone has no GitHub credentials).

## Division of labour: Claude orchestrates, Luna executes

**Executors = Codex, normal service tier, two levels** (user decisions 2026-10-26): **`-m gpt-6.1-terra -e max`**
for everything that was Sol (any implementation more than simple; never Terra `medium`/`high`: they stop long jobs
early), and **`gpt-6-luna`** — the wrapper's default model, unchanged («простое лучше вернуть как было») — for simple/
mechanical work, scouts, critics and images, with Luna's effort chosen per task (see the `luna` skill). Pass
`-m gpt-6.1-terra -e max` explicitly for complex jobs. The fast tier is OFF because it burns too much quota. Don't pass `-t fast` unless the user asks.
It is always called through
`bash ~/.claude/scripts/luna.sh` (`-w` write / `-r` read-only). The wrapper pins
model and effort on the command line. Don't rely on `$CODEX_HOME/config.toml`,
because the Codex desktop app rewrites it. Use it proactively, without waiting to be
asked. Keep slices ≤ ~40 min, run independent slices in parallel, never discard the
wrapper's output, and check `luna-status.sh` right after launching.

**Any implementation that is more than simple goes to Terra at `max`** (user decisions 2026-10-21, 2026-10-26: formerly Sol 6.1 high): `luna.sh -w -m gpt-6.1-terra -e max`. In the rest of this paragraph «Sol» means this level and «Luna» means `gpt-6-luna`. That means every moderately complex or complex job: features (even single-module ones), non-trivial bug fixes, refactors, migrations, multi-file changes, new logic, anything touching data/API/auth/money/concurrency/security, debugging, and anything Luna failed at once. **Luna** keeps only simple, mechanical work (renames, reformatting, boilerplate, one-file trivial edits, pattern copy with no decisions), information gathering/scouts, critics and images. When in doubt, use Sol. Sol is literal (see the `luna` skill, "The executors are literal"), so a Sol brief must be exhaustive. Never use `gpt-6-astra`. See "Model routing" in the `luna` skill.

**Priorities: quality of the final result > speed through parallelism > quota.** Codex
quota is effectively unlimited (user, 2026-09-29), so never economise on Luna jobs. Fan out
research scouts, use best-of-2 for the riskiest core pieces, use bigger critic panels, and
run independent slices in parallel. Decompose by independence, never into pieces smaller
than a coherent unit.

### The loop (default for every non-trivial task)

1. **Execute**: Claude briefs Luna, Luna does the work (skill `luna`).
2. **Critique**: Luna critics with clean context and personas review the result (skill `luna-critics`).
3. **Close the gaps**: Claude verifies the findings. Luna fixes the accepted ones. Re-run the
   critics once if critical/high findings were fixed (at most 2 rounds).
4. **Done**: Claude runs the checks, commits, and reports what the critics caught.

### 1. Clear tasks go to Luna (skill: `luna`)

Every clear, well-bounded job goes to Luna instead of being done inline or by a
Claude/Sonnet subagent:
- **Implementation**: features, fixes, refactors, tests, scripts, migrations.
- **Information gathering**: exploring a codebase, tracing flows, finding usages,
  reading logs/docs, summarising. Use Luna read-only (`-r`) instead of the
  `Explore`/`general-purpose` subagents.

Claude writes a self-contained brief, verifies the result (diff, gates, spot-checks),
and commits itself. Luna never commits.

**Design is done by Opus itself, NEVER delegated.** Opus is the main Claude model in this session, and it is far better than GPT with the visual side of websites and apps. Design means visual/UI/UX, layout, styling/CSS, look & feel, typography, colour, design tokens, component markup and artifact pages. Don't hand any of it to Luna, and don't hand it to Sonnet or other subagents either. Luna may do only the non-visual wiring (data, logic, API) around it, and may generate raster images on request (see the `luna` skill, "Image generation").
Claude also keeps talking to the user and includes requested text directly in the reply when asked. Claude owns final decisions, synthesis of Luna/critic output, and trivial one-liners that are faster to do than to brief. For mixed tasks, split them: Luna does the
logic/wiring, Claude does the visuals.

This also applies to inline paths such as `/gsd-fast` or direct edits: the code is
written through `luna.sh -w`, and Claude verifies and commits.

**Images: Luna can generate raster images** (Codex imagegen) for sites and any other task: hero art, illustrations, icons, backgrounds, assets. Opus writes the prompt and judges the result, which is art direction and therefore design. Luna runs it as a `luna.sh -w` job and saves the file into the project. See the `luna` skill, "Image generation".

**Generate images proactively, without asking** (user rule, 2026-10-21). Whenever a deliverable would look or work
better with real imagery, generate it as part of the work. That covers websites and landing pages (hero, section art,
backgrounds, empty states, OG/social previews), apps and games (sprites, icons, textures, splash screens), artifacts and
dashboards, presentations, docs and READMEs, mockups, favicons, and placeholders for content that isn't ready yet. Don't
fall back to grey boxes, stock-photo URLs, emoji or "add an image here" notes when you can generate the real thing. Don't
ask permission first: the cost isn't a concern. Generate 2–4 variants for important visuals and pick the best. Mention in the
report what was generated. Limits: no text inside images (put it in HTML/CSS), no real people's likenesses or trademarked
logos/brands, and optimise the files (size/format) before they ship.

### 2. Critics for anything moderately complex (skill: `luna-critics`)

For any task that isn't trivial (multi-file, new feature/flow, user-facing,
data/API change, auth/money/secrets, concurrency, infra, or a non-obvious
decision), run a panel of 3–5 **clean-context role-play critics on Luna** via
`luna-panel.sh`, which runs the whole panel as threads in ONE shared Codex process (`luna-pool.mjs`, ~16 MB per extra critic) (3–4 for internal code, 5–6 for user-facing, plus one per subsystem on large diffs; `high` effort by default,
run in parallel with the next independent slice). They review statically, without running tests or scripts. Concurrency
adapts to free RAM: `luna.sh` admits a job only while a reserve stays free; the Luna daemon defaults to max 12 jobs.
Launch freely and the machine won't hang: рядовой пользователь, взломщик, дизайнер, проджект, мейнтейнер,
тестировщик, эксплуатация, эксперт предметки. Run them after the plan (before
implementing) and/or after implementing (before saying "done" or committing).
Claude verifies every finding, fixes the accepted ones, and reports what was
accepted and what was rejected.

### 3. Stuck or uncertain

If you're looping or unsure, hand a fresh root-cause investigation to Luna (`-r`)
with a clean brief instead of retrying the same approach.

### 4. Fallback: never stall

If Luna/Codex is unavailable (quota or rate limit, auth, CLI errors, repeated
timeouts), do the work inline or via a Sonnet subagent (critics included), say in one
line that Luna was skipped and why, and go back to Luna once it recovers.

### 5. Always clean up after yourself (user rule, 2026-10-21)

A task isn't done until its garbage is gone. This applies to Claude itself AND to everything it launches (Luna/Terra jobs,
subagents, other sessions it starts: tell them in their brief). **Clean up as you go**: after each finished step, remove that
step's leftovers right away, as soon as they've been verified and used. Don't let them pile up until the end. Anything still
in use (a running job's files, a backup needed for a possible rollback) is cleaned as soon as it's free. Before the final
report of every task, in every project, make a last pass:
- **Delete** everything you created only to get the work done: briefs, `*.out.md`/`.log`/`.status` of finished
  Luna jobs (once their results are verified and used), smoke-test/scratch dirs, wrapper copies (`luna-run.sh`),
  temp files, throwaway scripts, test lock dirs.
- **Backups** (`*.bak-*`) you made: delete them once the change is verified, unless the user may want to roll back
  soon. Then keep only ONE pre-change backup per file and say so in the report.
- **Processes**: stop the monitors, background jobs, dev servers and Codex processes you started; make sure no
  `codex.exe` from your jobs is left running.
- **Worktrees/branches** you created and no longer need: remove them (never the user's).
- Never delete what you didn't create (the user's files, Codex desktop history, other sessions' artifacts).
- Last line of the report: what was cleaned up and what was deliberately kept (and why).
`~/.claude/scripts/luna-clean.mjs` (`--dry-run` to preview) removes the wrappers' own leftovers (old temp prompt files, stale lock dirs,
luna-run job dirs older than 7 days, luna-made Codex sessions). It also runs automatically at session start.

**Disk hygiene: worktrees and shared data (user rule, 2026-10-24).** The projects had grown to ~90 GB: 15 full worktrees,
each with its own node_modules, `.next` and `public/`, nobody removing them, game data copied instead of linked.
- **Create worktrees only with** `node ~/.claude/scripts/disk/wt-new.mjs --repo <repo> --path <dir> --new-branch <b> --base <ref>
  --owner <session/task> --purpose "<why>" --until <date ≤ 30 days> --no-public`. It records owner/purpose/until in git's
  worktree lock and links the shared `node_modules` instead of installing a copy. Never a bare `git worktree add` for work
  that lives longer than one command. Session briefs say the same.
- **Remove them with** `node ~/.claude/scripts/disk/wt-done.mjs <dir>` (`--archive` to commit + tag uncommitted work first).
  It unlinks junctions before deleting, so a shared `node_modules` or data folder is never deleted through a link.
- **One copy of big data.** Game sources, OCR, downloads live once; worktrees link to them (junction). Raw originals that
  cannot be re-downloaded go to `%USERPROFILE%\dev\_sources\<game>\` (`DISK_SOURCES_ROOT`) with a README, never into `.tmp`.
- **`.tmp` is temporary.** `node ~/.claude/scripts/disk/audit.mjs` lists worktrees (verdict: removable / dirty / in-use /
  expired) and free space; `--apply` deletes only `.next` idle > 24 h, `.tmp` children older than 7 days (a `KEEP` file or a
  `.tmp/.keep` entry protects one) and old test reports. The SessionStart hook `~/.claude/hooks/disk-audit-hook.mjs` shows a
  short report when action is needed and runs `--apply` once a day. Act on what it reports before starting heavy work.

### 6. Tests: a budget, not a free-for-all (user rule, 2026-10-24)

Test runs have killed this PC before: about 10 GB of RAM, about 20 GB of temp files on the SSD, and
1.5–2 hours of waiting. A test run is a resource with a budget, in every project, for Claude and for
everything it launches (put these rules into executor briefs):
- **Every pytest run goes through `python ~/.claude/scripts/pytest_gate.py -n K -- <args>`.** The gate
  does the following:
  - caps workers per run (default 4) and shares ONE machine-wide worker pool sized to the CPU count
    (`PYTEST_GATE_POOL`), held by file locks, so all sessions and Codex jobs together never run more workers than
    cores; 1–3 explicit test ids run without xdist (`-n 0`, 1 slot) (2026-10-27: per-job TMPDIRs had split the pool
    and 10 workers ran on 4 cores);
  - waits for free RAM;
  - refuses to start below 10 GB free disk;
  - gives each run its own temp dir with `tmp_path_retention_policy=failed`;
  - deletes that dir after a green run, and prunes old red runs.

  Don't bypass it with a bare `pytest`. Don't pass your own `--basetemp` unless you delete it yourself.
  Other test runners (vitest, jest, cargo, go) get the same treatment: limit workers and clean their output.
- **Default to the smallest check that answers the question.** Run the tests of the files you changed
  and their direct dependents (an affected-tests tool if the project has one). The full suite runs
  **once per release** on the merged result, never per wave or per fix. Never run it concurrently
  with another heavy run (another full suite, a build, a load probe). Before a long run, check free
  RAM and disk and say how long it will take.
- **Results must survive a stop.** Use `-rf` and a junit report (or verbose names), so a killed run
  still says what failed. Never pipe through `tail` in a way that loses the exit code.
- **How many tests (user rule, 2026-10-24: «куда столько тестов? Ты на каждый символ тесты делаешь?»):**
  write tests only for what could destroy work, lose data, break prod, or touch money/security —
  usually 1–3 test files per change. Everything else is checked by one real run (report, smoke,
  screenshot). Executor briefs list the exact few tests and say "No other tests".
- **Writing tests:** a new test must be cheap by design.
  - Share heavy setup (session or module fixtures, prebuilt snapshots, hardlinks instead of copying
    big data).
  - Don't start a subprocess server per test when one shared server will do.
  - No real-time waits: use small timeouts or fake clocks.
  - Every temp dir and process a test (or the code under test) creates is removed in `finally`.
  - A test slower than about 5 s is marked `slow` and justified.
  - Before adding a scenario test, check whether an existing one already covers the behaviour, and
    extend it rather than copy it.
- **Lessons of the rpg suite that grew to 3 h (2026-10-24), apply in every project:**
  - **Never key a cache by a per-instance path** (a temp dir, a campaign folder, a room id) when the
    cached thing is a function of CONTENT. Key it by a content hash, and bound it (`maxsize`). A
    path-keyed cache never hits in tests (each test has a fresh path) and grew one worker from 150 MB
    to 1.1 GB and 1.5 million objects in 270 tests; in production it holds one parsed copy of the same
    data per campaign. When reviewing code, treat `lru_cache`/dict caches keyed by `Path`/`root` as a bug.
  - **Measure the suite like production:** worker RSS growth over a run, total time, top-20 slowest
    tests. A worker that keeps growing is a leak to fix, not a reason to run fewer workers.
  - **Tests switch off background work by default** (post-turn workers, schedulers, ingest, indexers);
    a test that is about that work opts in explicitly. Production can never run with it off.
  - **Tiers, not one big run:** a fast release tier (target ≤ 20 min) that gates deploys, and a separate
    `slow` tier for long replays and load, which must be excluded by default, not just labelled.
  - **Don't copy what can be read from one place — spare the SSD.** Immutable data (world packs, canon,
    fixtures, templates, reference corpora) lives once, read-only, under a content hash; each test,
    campaign or tenant keeps only what it actually changes and reads the rest through one resolver
    (shared base + per-instance overlay). A test that copies hundreds of unchanged files per case (the rpg
    suite wrote ~2 million such files per run) is a defect to fix, not a cost of testing. Never hardlink
    files that can be written.
  - **Acceptance ≠ everything end-to-end:** one full scenario per invariant; other behaviour is tested
    through the real write path without the expensive layer (model turn, subprocess server) when that
    layer is not what is under test.
- **After any test work:**
  - no leftover test processes;
  - no new `pytest-of-*`, `pytest-gate-runs/*` (except kept red runs) or project temp dirs;
  - no clones, worktrees or venvs created only for the run.

  Report what was removed.

### Plugin commands (secondary)

The `codex@openai-codex` plugin (`codex-rescue`, `/codex:review`,
`/codex:adversarial-review`) uses the config.toml default model and can't set `max`
effort, so prefer `luna.sh` and `luna-critics`. The plugin is still fine for job
control: `/codex:status` · `/codex:result <id>` · `/codex:cancel <id>`.

If the **review gate** starts blocking every turn with a quota/limit error,
that's the signal Codex limits are exhausted. Pause the gate so the session
isn't held hostage:

```bash
# pause everywhere (survives restarts) — gate auto-disables on next session start
touch ~/.claude/codex-gate-paused
# also clear it for the CURRENT session/project right now:
/codex:setup --disable-review-gate
```

Resume when limits are back: `rm ~/.claude/codex-gate-paused` (the SessionStart
hook re-enables the gate on the next session).

### Automatic stop-time review gate

A `SessionStart` hook (`~/.claude/hooks/codex-review-gate-autoenable.mjs`)
auto-enables the Codex **review gate** in every workspace, unless
`~/.claude/codex-gate-paused` exists. On each turn's Stop, Codex reviews the
previous response and **blocks completion** until issues are resolved.

- Disable in one project (current session): `/codex:setup --disable-review-gate`
- Pause everywhere: `touch ~/.claude/codex-gate-paused` → resume with `rm ~/.claude/codex-gate-paused`.
- Disable everywhere permanently: remove the `codex-review-gate-autoenable.mjs`
  entry from the `SessionStart` hooks in `~/.claude/settings.json`.
- Check readiness anytime: `/codex:setup`.
