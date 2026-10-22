# Global instructions (all projects)

> Project-level `CLAUDE.md`, explicit user requests, and any active project
> workflow (e.g. GSD) take precedence over this file when they conflict.

## Division of labour: Claude orchestrates, Luna executes

**Executor = Codex `gpt-6-luna`, normal service tier, reasoning effort chosen per task**
(`-e max` for new core logic, money, concurrency, security and exact spec reproduction;
`high` for pattern-following features, CRUD, fix rounds and critics; `medium` for
mechanical edits, reformatting and exploration; see the effort table in the `luna` skill).
The fast tier is OFF because it burns too much quota. Don't pass `-t fast` unless the user asks.
It is always called through
`bash ~/.claude/scripts/luna.sh` (`-w` write / `-r` read-only). The wrapper pins
model and effort on the command line. Don't rely on `$CODEX_HOME/config.toml`,
because the Codex desktop app rewrites it. Use it proactively, without waiting to be
asked. Keep slices ≤ ~40 min, run independent slices in parallel, never discard the
wrapper's output, and check `luna-status.sh` right after launching.

**Any implementation that is more than simple goes to Sol 6.1 at `high`** (user decision, 2026-10-21): `luna.sh -w -m gpt-6.1-sol -e high`. That means every moderately complex or complex job: features (even single-module ones), non-trivial bug fixes, refactors, migrations, multi-file changes, new logic, anything touching data/API/auth/money/concurrency/security, debugging, and anything Luna failed at once. **Luna** keeps only simple, mechanical work (renames, reformatting, boilerplate, one-file trivial edits, pattern copy with no decisions), information gathering/scouts, critics and images. When in doubt, use Sol. Sol is literal (see the `luna` skill, "The executors are literal"), so a Sol brief must be exhaustive. Never use `gpt-6-astra`. See "Model routing" in the `luna` skill.

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
adapts to free RAM: `luna.sh` admits a job only while a reserve stays free, so launch
freely and the machine won't hang: рядовой пользователь, взломщик, дизайнер, проджект, мейнтейнер,
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

A task isn't done until its garbage is gone. This applies to Claude itself AND to everything it launches (Luna/Sol jobs,
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
