# Global instructions (all projects)

> Project-level `CLAUDE.md`, explicit user requests, and any active project
> workflow (e.g. GSD) take precedence over this file when they conflict.

## Machines

Claude now runs on **bro-server**: Debian 13, 4 CPU cores, 15 GB RAM. The Windows PC is a backup.
GTNH (`gtnh-server.service`) and Claude/Codex work are never run at the same time on this box,
so the full machine is available to Claude; do not start GTNH while Claude work is running unless the user asks.
This box is bro-server itself: run `gtnh-server` admin commands locally, with no SSH to itself.
The Windows Docker host **NucBox** is reached over SSH (see `personal-server-connect`).
LAN IPs drift with DHCP: identify hosts by their SSH host key, not their IP.

## Harness source

How this Claude→Codex harness is built (scripts, daemon, skills, hooks, installer, learning loop) lives in the repo
`~/dev/gpt-harness` (private GitHub repo `Xaooc/gpt-harness`). The GitHub CLI is signed in as the owner, so this clone
can pull and can push with the owner's approval. Read it to understand the design: `README.md`, `PACKAGE-SPEC.md`, `INSTALL.md`,
`SELF-LEARNING.md`; `payload-linux/` is what this machine runs, `payload/` is the Windows PC version,
`codex-build/` is the Windows-only custom Codex build (Rust, busybox-shell patch; not used on Linux).
`~/.claude` is the installed copy: when you change a harness script or skill there, make the same change in
`payload-linux/` (the only place shared files are edited), run `node tools/manifest-sync.mjs && node
tools/sync-windows.mjs` (Linux manifest, generated Windows payload), check that `node install.mjs --check` reports no
local drift, commit, and push with the owner's yes.

## Network

Anthropic/OpenAI are reachable only via the local xray proxy: `HTTPS_PROXY` comes from
`~/.config/bro-env.sh`. `xray.service` exposes SOCKS on 10808 and HTTP on 10809, with
automatic failover across EU servers and daily subscription refresh by `xray-sub-update.timer`.
If Codex or Claude calls fail with 403/timeouts, recover in this order:
1. `systemctl status xray` and `journalctl -u xray -n 30` (each request line shows which server `p-NN` it used).
2. `ss -tln | grep 1080` should list 127.0.0.1:10808 and :10809; if not, `sudo systemctl restart xray`.
3. Empty or stale server list: `sudo systemctl start xray-sub-update.service` (re-downloads the subscription,
   keeps the old config if the new one fails `xray run -test`), then `sudo systemctl restart xray`.
4. Verify: `curl -s -m 10 -x http://127.0.0.1:10809 https://ipinfo.io/country` must not print `RU`, and
   `echo $HTTPS_PROXY` must be `http://127.0.0.1:10809` (else `. ~/.config/bro-env.sh`).

## Process: Lauren Tan's pstack is the default (user decision 2026-11-16)

Every session works in **poteto-mode** from pstack (MIT, vendored as the local plugin `pstack@luna-local`). The
session-start hook prints the pstack path. Before the first task, read `<pstack>/docs/harness/claude-code.md`,
then `<pstack>/docs/harness/bro-harness.md` (this harness's adapter; it wins over pstack), then follow
`<pstack>/skills/poteto-mode/SKILL.md`: playbooks per task type, named principles read from their leaf skills,
verification against the real artifact, lessons encoded as checks rather than prose. The adapter overrides
pstack's "Autonomy": anything external (messages, tickets, PRs, push, merge, deploy) needs the user's yes.
superpowers and GSD skills stay installed but are not the default process: use them only when the user asks for
one by name or the project is a GSD project. The `luna` skill keeps the executor infrastructure details.

## Executors: Claude orchestrates, executors do the work (user decisions 2026-11-16)

Claude (Opus) orchestrates, designs and decides; implementation, research and review run on executors through one
dispatcher, by **tier**, never by naming a tool:

```
node ~/.claude/scripts/conveyor/exec.mjs run --tier <complex|simple|review|scout> (-w|-r) -C <dir> -f <brief.md> -o <out.md>
```

| Tier | Use |
| --- | --- |
| `complex` | any implementation beyond simple: features, non-trivial fixes, refactors, migrations, multi-file, data/API/auth/money/concurrency/security, debugging |
| `simple` | mechanical edits, summaries |
| `review` / `scout` | critics and second opinions / information gathering |
| `architect` | approach review of complex architecture (several subsystems, a new subsystem, data model, concurrency, money/security core, migrations) and of any problem that keeps coming back |
| `approach` | approach review of a medium change (a feature or fix across a few files with a real design choice); also the independent review of a `planner` plan |
| `planner` | the technical plan of a complex architecture, written from the scouts' facts within Claude's requirements |

Which provider, model and effort serve each tier and panel is the owner's choice in the **Luna panel**; the
session-start digest prints the current setting and `node ~/.claude/scripts/conveyor/exec.mjs status` shows it live.
Never name a provider yourself: no direct `gem.sh`/`mlai.sh`/`luna.sh` calls for delegated work (a PreToolUse guard
blocks `gem.sh` and `mlai.sh`; a diagnostic may prefix `CONVEYOR_DIRECT_PROVIDER=1`).

- The chains, models, efforts, panels and pstack roles live in `~/.claude/conveyor/orchestration.json`; the user
  edits them in the **Luna panel** (model and effort per task kind, presets). Do not hand-edit it.
- Codex is skipped automatically at **80 %** usage (configurable in the panel; hysteresis), a provider that hit a
  quota/region/auth error is skipped for its TTL, and a write job that already started is never re-run on
  another provider (one exception: an mlai write run that stopped unfinished with changes is continued by the next
  chain entry on the same tree). Exit 4 means "spawn a Claude subagent" with the model in `<out>.dispatch.json`; exit 5: no provider
  available; exit 6: the project's checks stayed red after the fix rounds; exit 7: another write job already runs in
  that repository, so start the slice in its own worktree (`wt-new.mjs`) or wait for it.
- Never `gpt-6-astra` on Codex. `gpt-6.2-astra` is allowed there (owner 2026-11-18) and serves the `architect` tier.
  Through ML AI Code the owner allows `gpt-6-astra` (2026-11-24): `mlai/gpt-6-astra` is the Astra seat of that provider.
  Never `ultra` effort (it delegates to sub-agents). Never the fast tier (`-t fast`) unless the user asks.
- **ML AI Code** (`mlai`, owner 2026-11-24) is the first entry of each chain: `pixis-sol`/`pixis-opus` in the Sol role,
  `gpt-6-astra` as Astra, `pixis` as Luna. Its slots are always filled first: each account runs 2 sessions, accounts in
  order; only when all are busy does the dispatcher go to the next chain entry (one `conveyor:` line, no mark). An
  account may have its own VPN exit (proxy). Sign-ins last 7 days; the Luna panel warns before one expires
  (`node ~/.claude/scripts/mlai-accounts.mjs add <id>` prints that account's sign-in command).
- Briefs are self-contained and exhaustive: executors are literal and see only the brief (see the `luna` skill,
  "The executors are literal"). Every write brief ends with "Edit files only. Do NOT run git add / commit / push".
  Claude verifies every result (diff, gates, spot-checks) and commits itself.
- After each launch check `luna-status.sh <out>` and arm `luna-watch.sh` with the Monitor tool; stop jobs with
  `luna-stop.sh`. Keep slices ≤ ~40 min and run independent slices in parallel.

**Priorities: quality of the final result > speed through parallelism > quota.** Fan out scouts, use best-of-2
(pstack `arena`) for the riskiest core pieces, run independent slices in parallel; decompose by independence,
never into pieces smaller than a coherent unit.

**Approach review: a high-level critic before code and when stuck** (owner decision 2026-11-18, every repository).
A trial on three real problems showed GPT-6.2 Astra and Sol at max find design flaws and better approaches that
ordinary critics and fix rounds found only after two rounds or missed. So:
- **Before implementing** anything beyond a small change, after the scouts and Claude's own plan: run the plan
  through `--tier approach` (medium change) or `--tier architect` (complex architecture: several subsystems, a new
  subsystem or data model, concurrency, money/security core, migrations). For the riskiest architecture use the
  `architect` panel (Astra and Sol seats in parallel) for two independent views.
- **Complex architecture, planned by Astra:** after the scouts, Claude writes the requirements and limits (the
  owner's intent stays with Claude), `--tier planner` writes the technical plan from the facts (modules, order of
  verifiable steps, risks), then `--tier approach` (a different model) reviews that plan; Claude merges, decides and
  slices the work into briefs. The reviewer is never the plan's author.
- **When a problem loops** (the same failure twice, `exec.mjs` exit 6, two fix rounds without convergence, or the
  user correcting the same thing again): stop retrying and run `--tier architect` with the history.
- **The brief** (Astra is literal and lazy, strong but without creative or directorial vision; OpenAI advises
  outcome-first prompts with few rules): the goal and why; the facts the scouts found (short, pre-digested); the
  current plan; one question. Ask for up to three options, the strongest first, each in 2–4 sentences with why it
  works and the one fact or scenario that would kill it, then a pick. Read-only (`-r`), no code or patches, state
  assumptions, "before you finish, check you answered the question and each option says how it fails". Point it at
  the repository; do not paste the whole conversation.
- **Never for** visual/UI/UX/product/game design (Opus), implementation, or line-by-line diff review (critics and
  `interrogate`).
- Claude judges the answer, verifies the claims it relies on by a run, and tells the user what it accepted and
  rejected. Enforced at the point where the plan can still change: `exec.mjs run` refuses the first `complex` write
  of a ledger task (exit 8) until an approach review has completed in that task, refuses a new attempt after a gate
  failure until an `architect` review has completed, and refuses a write after a `planner` plan until `approach`
  reviewed it; `--review-skip "<reason>"` is for a change with no design choice and is recorded. These rules are
  enforced only at dispatch (the stop hook no longer re-audits them); exit 6 prints the `architect` command.

**Design is done by Opus itself, NEVER delegated.** Opus is the main Claude model in this session, and it is far
better than GPT with the visual side of websites and apps. Design means visual/UI/UX, layout, styling/CSS, look &
feel, typography, colour, design tokens, component markup and artifact pages. Don't hand any of it to executors or
subagents. Executors may do only the non-visual wiring (data, logic, API) around it, and generate raster images on
request (see the `luna` skill, "Image generation"). Claude also keeps talking to the user and includes requested
text directly in the reply when asked. Claude owns final decisions, synthesis of executor and review output, and
trivial one-liners that are faster to do than to brief.

**Images: executors can generate raster images** (Codex imagegen) for sites and any other task. Opus writes the
prompt and judges the result (art direction is design); the executor saves the file into the project.

**Generate images proactively, without asking** (user rule, 2026-10-21). Whenever a deliverable would look or work
better with real imagery, generate it as part of the work. That covers websites and landing pages (hero, section art,
backgrounds, empty states, OG/social previews), apps and games (sprites, icons, textures, splash screens), artifacts and
dashboards, presentations, docs and READMEs, mockups, favicons, and placeholders for content that isn't ready yet. Don't
fall back to grey boxes, stock-photo URLs, emoji or "add an image here" notes when you can generate the real thing. Don't
ask permission first: the cost isn't a concern. Generate 2–4 variants for important visuals and pick the best. Mention in the
report what was generated. Limits: no text inside images (put it in HTML/CSS), no real people's likenesses or trademarked
logos/brands, and optimise the files (size/format) before they ship.

### Acceptance ledger and gates (enforced by hooks)

Acceptance is kept per **request** (one owner request = one ledger task) and checked once, at delivery. On every
non-trivial request that changes code:
1. `node ~/.claude/scripts/conveyor/ledger.mjs start` (after a delivered request the next owner message starts a new one
   by itself), play back the owner's requirements in your first message (pstack trigger 1) and record each as an
   observable outcome: `ledger.mjs add "<outcome>" --from <M3>`. Later corrections: `ledger.mjs amend <L> --from <M7>
   "<corrected outcome>"`. Captured imperative sentences are only hints (`ledger.mjs show`); nothing needs linking.
   Text the owner pasted from elsewhere is a requirement only when the owner adopts it.
2. Prove each outcome once: `ledger.mjs evidence <L> --cmd "<check command>"` (run now, must exit 0), `--artifact
   <screenshot>` (a fresh file), `--check <out>.dispatch.json` (a passing gate) or `--owner-message <M>` (the owner's
   own screenshot); then `ledger.mjs done <L>`. Proof goes stale only through this request's own later edits, never
   through other sessions. A check only the owner can do: `ledger.mjs pending <L> --reason "<what only the owner can
   check>"`; name it once in the final message; settle it later with `ledger.mjs pending <L> --resolve <M> --result
   accepted|needs-work`.
3. When the request is finished: `ledger.mjs deliver` runs the request's turn checks and screenshot coverage once and
   one independent review of the owner's messages, the outcomes and this request's own diff. Answer each finding once:
   `ledger.mjs link X<id> <L>`, `ledger.mjs add "<missing outcome>" --from X<id>`, or `ledger.mjs link X<id> none --reason
   "<why>"`. If no reviewer is available, the delivery is recorded with a review gap; say so once.
4. The final message gives the result, the evidence that matters, the gaps and any pending owner checks. No checklist.
The stop hook looks only at this request's own changes (editor writes, this session's commits, its executor jobs) and
blocks only on what Claude can fix: a code change with no request (1), an open outcome (3), lost proof (4), red turn
checks on the request's files (5), a missing delivery or unanswered findings (6), this session's leftover temps and
expired worktrees (8), a changed UI outcome without a screenshot or owner proof (9). The same unchanged blocker never
blocks twice: the second identical stop is allowed with a note. A session with no owner prompt of its own (driven by
an orchestrator's messages) is not checked. Exceptions only in the user's own words: `ledger.mjs waive <item|gate>
--quote "<the user's words>"` (verified against the transcript). Executor writes are gated by the dispatcher: project
checks run after every write job, failures go back to the same executor (≤ 2 rounds); exit 6 means the gate stayed red
and the decision is yours. While your own executor jobs still run, the stop hook lets the turn end (work in progress).
A repository's own `.claude/conveyor.json` commands run
only after you review it and run `node ~/.claude/scripts/conveyor/check.mjs trust --dir <repo>`; trust covers the last
five reviewed versions across all worktrees of the repository. Until then checks
use the autodetected profile and default language hygiene counters. Repositories without a hygiene section also
get default counters; their initial debt is seeded from the task base in
`~/.claude/conveyor/baselines/<repo-identity-hash>.json`, shared by worktrees without adding repository files.
On the first code task in a repository without a profile, run
`node ~/.claude/scripts/conveyor/check.mjs init --dir <repo> --write`, review and adjust the generated checks,
measure fast/turn on the change, tell the user, and propose committing `.claude/conveyor.json` and
`.conveyor/hygiene-baseline.json`. Init seeds the local baseline from the external baseline, trusts its generated
profile, refuses to overwrite an existing profile, and never commits.
UI repositories without `.claude/skills/verify-*/SKILL.md` create a verify skill on their first UI task with pstack
`create-verification-skill`: isolated launch on a free port with separate data, Playwright drive, retained desktop/mobile
screenshots after cleanup (see kriminalist's `verify-kriminalist`). Stop reason 9 needs, for each UI outcome this
request changed, a fresh screenshot (`ledger.mjs evidence <L> --artifact <screenshot>`), the owner's screenshot
(`--owner-message <M>`) or a pending owner check. It uses the same user gate waiver as turn checks and cleanup.

### Review: pstack `interrogate` on diverse executors

Review every non-trivial change before calling it done with pstack `interrogate`: its reviewers are the seats of
the `review` panel (as configured in the Luna panel; `interrogate.mjs` runs them), each in a throwaway worktree, and a finding counts only with
the command and output that prove it. For user-facing work add the `luna-critics` persona briefs that pstack does not
cover (Рядовой пользователь on screenshots and flows, Дизайнер for visuals), and for Terra/Sol implementations a
gap reviewer that reads the user's goal and the diff. Claude verifies every finding and reports accepted and
rejected ones. Trivial edits and pure questions skip review.

### Stuck, or an executor is down

Looping or unsure: follow pstack "Attack the Premise" and hand a fresh root-cause investigation to the `scout` tier
with a clean brief. If a whole chain is unavailable (`exec.mjs` exit 5), do the work inline, say in one line which
providers were down, and return to the dispatcher once they recover.

## Infrastructure rules

### Always clean up after yourself (user rule, 2026-10-21)

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
  `codex` from your jobs is left running.
- **Worktrees/branches** you created and no longer need: remove them (never the user's).
- Never delete what you didn't create (the user's files, Codex desktop history, other sessions' artifacts).
- Last line of the report: what was cleaned up and what was deliberately kept (and why).
`~/.claude/scripts/luna-clean.mjs` (`--dry-run` to preview) removes the wrappers' own leftovers (old temp prompt files, stale lock dirs,
luna-run job dirs older than 7 days, luna-made Codex sessions). It also runs automatically at session start.

**Disk hygiene: worktrees and shared data (user rule, 2026-10-24).** The projects had grown to ~90 GB: 15 full
worktrees,
each with its own node_modules, `.next` and `public/`, nobody removing them, game data copied instead of linked.
- **Create worktrees only with** `node ~/.claude/scripts/disk/wt-new.mjs --repo <repo> --path <dir> --new-branch <b>
  --base <ref>
  --owner <session/task> --purpose "<why>" --until <date ≤ 30 days> --no-public`. It records owner/purpose/until in
  git's
  worktree lock and links the shared `node_modules` instead of installing a copy. Never a bare `git worktree add` for
  work
  that lives longer than one command. Session briefs say the same.
- **Remove them with** `node ~/.claude/scripts/disk/wt-done.mjs <dir>` (`--archive` to commit + tag uncommitted work
  first).
  It unlinks symlinks before deleting, so a shared `node_modules` or data folder is never deleted through a link.
- **One copy of big data.** Game sources, OCR, downloads live once; worktrees link to them (symlink). Raw originals that
  cannot be re-downloaded go to `~/dev/_sources/<game>/` with a README, never into `.tmp`.
- **`.tmp` is temporary.** `node ~/.claude/scripts/disk/audit.mjs` lists worktrees (verdict: removable / dirty / in-use
  /
  expired) and free space; `--apply` deletes only `.next` idle > 24 h, `.tmp` children older than 7 days (a `KEEP` file
  or a
  `.tmp/.keep` entry protects one) and old test reports. The SessionStart hook `~/.claude/hooks/disk-audit-hook.mjs`
  shows a
  short report when action is needed and runs `--apply` once a day. Act on what it reports before starting heavy work.

### Tests: a budget, not a free-for-all (user rule, 2026-10-24)

Test runs have killed this PC before: about 10 GB of RAM, about 20 GB of temp files on the SSD, and
1.5–2 hours of waiting. That is Windows PC history; the limits below apply to bro-server now.
A test run is a resource with a budget, in every project, for Claude and for
everything it launches (put these rules into executor briefs). The shared heavy-gate defaults
to 3 slots (`Bash` hooks; `HEAVY_GATE_MAX`):
- **Every pytest run goes through `python3 ~/.claude/scripts/pytest_gate.py -n K -- <args>`.** The gate
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
  **Enforced since 2026-11-17** (the prose alone was ignored: 6,139 tests added to rpg in 30 days): the executor
  and subagent gates reject a change that adds more than 5 new test cases net (`budgets.new_tests` in the project
  profile; a brief may raise it for one job with a line `Test budget: N`, which Claude writes only for lost-work,
  data, production, money or security risks). The fix round then trims the job's own new tests. Executors run
  only the tests the brief names plus affected tests, never the full suite.
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
