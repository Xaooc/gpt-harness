# INSTALL — for the agent installing luna-harness on a new machine

You are a Claude Code agent on a fresh Windows 10/11 machine. Follow this file top to bottom. Every step has a check;
do not continue past a failed check — fix it or report it to your user. Steps marked **[ASK]** download, install or
need admin rights: ask your user for a clear "yes" first and tell them what will be downloaded or changed.

## What this installs
The same Claude Code + Codex setup as the source machine:
- **Orchestration:** Claude plans and talks to the user; Codex models (`gpt-6.1-sol` for non-trivial
  implementation, `gpt-6-luna` for simple work, research and critics) execute through `~/.claude/scripts/luna.sh`,
  as threads of one shared `codex app-server` daemon (`luna-daemon.mjs`). The daemon does fair scheduling between
  sessions, RAM admission, stall watchdogs and cancellation.
- **Skills:** `luna` (how to brief and route executors) and `luna-critics` (panels of role-play critics).
- **Global rules:** the owner's `CLAUDE.md`, installed as-is.
- **Heavy-command gate:** `heavy-gate.mjs`, a Pre/PostToolUse hook. At most 2 heavy commands machine-wide
  (tsc, vitest, pytest, installs, builds), and only while ≥ 2.5 GB RAM is free.
- **Codex plugin review-gate fixes:** the broker reaper, plus patches to the `codex@openai-codex` plugin (broker
  orphaning, thread leak, unelevated sandbox).
- **Luna pane:** a Claude Code plugin, `/luna`, showing live RAM, Claude/Codex limits and jobs per session.
- **Self-learning loop:** captures corrections and job outcomes, proposes rule edits daily, gated by code and a Sol
  critic, every edit revertible. It starts with **empty data** on this machine.
- **Custom Codex build:** Codex 0.162.1 plus a patch, so model commands run in busybox `sh` (~6 MB) instead of
  PowerShell (~65 MB). You build it here (step 7).

## 0. Facts to collect first (no changes)
Run these and keep the output:
```bash
node --version                 # need v20+; v22.17 tested
git --version; ls "C:/Program Files/Git/bin/bash.exe"
codex --version                # need codex-cli 0.162.1 (npm @openai/codex)
claude --version               # Claude Code CLI if present (the desktop app also works)
powershell -NoProfile -Command "[int]((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB)"  # GB RAM, 16+ recommended
powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select Name,@{n='FreeGB';e={[int]($_.Free/1GB)}}"
```

## 1. Prerequisites [ASK for anything missing]
- **Node.js 20+:** `winget install OpenJS.NodeJS.LTS`.
- **Git for Windows:** `winget install Git.Git`. It provides Git Bash; every `.sh` here runs in it.
- **Codex CLI 0.162.1, exactly this version:** `npm i -g @openai/codex@0.162.1`. Then `codex login`; the user
  signs in with their ChatGPT account. The account must have the models `gpt-6.1-sol` and `gpt-6-luna`; check with
  `codex debug models | grep -E "gpt-6.1-sol|gpt-6-luna"`.
- **Claude Code 2.1.299 or newer** (desktop app or CLI). This is the tested version. It needs:
  - function-hook plugins (the Luna pane's `register.tsx`);
  - the built-in **Monitor** tool. The `luna` skill uses it for stall watchers. If Monitor is missing, run
    `bash ~/.claude/scripts/luna-watch.sh -i 300 <out.md>` with Bash `run_in_background` instead, and check its
    output whenever you get control back.

Check: every command in step 0 succeeds; `codex --version` prints `codex-cli 0.162.1`; `claude --version` prints
2.1.299 or newer (or the desktop app's About shows a Claude Code version that new).

## 1b. GSD (recommended)
The owner's global rules refer to GSD workflows (phases in a project's `.planning/`, the `/gsd-*` commands).
Sessions use GSD's task log (`.planning/quick/`) and state queries (`gsd-tools query`) to keep track of work
between sessions. Install it **before** step 4 [ASK]:
```bash
npx -y @opengsd/gsd-core@latest
```
GSD's installer edits `settings.json`. Running ours afterwards keeps both sets of hooks. Two of our hooks exist for
GSD projects: `codex-code-edit-block` and `codex-gsd-executor-override`. They route implementation in
`.planning/` projects to Codex. Without GSD they simply stay idle. Skip this step only if the user explicitly says
they don't want GSD on this machine.

## 2. Get the repo
Clone the private repo the user gives you, e.g. into `C:\dev\luna-harness`, then `cd` there.
Check: `node install.mjs --self-test` prints PASS.

## 3. Install the Codex plugin (the review gate) [ASK]
```bash
claude plugin marketplace add https://github.com/openai/codex-plugin-cc.git
claude plugin install codex@openai-codex
```
If the CLI form is unavailable, ask the user to run `/plugin marketplace add https://github.com/openai/codex-plugin-cc.git`
and `/plugin install codex@openai-codex` inside Claude Code.
Check: `ls ~/.claude/plugins/cache/openai-codex/codex/` lists a version directory. The patches cover **1.0.3 and 1.0.6**
and later versions with known file content after CRLF normalisation. Every cache version directory and the marketplace
copy are checked. Unknown files remain unpatched; see `payload/codex-plugin-patches/README.md`.

## 4. Run the installer
First a dry run, then the real install with checks:
```bash
ROOT="$(cygpath -w "$USERPROFILE/codex-build")"      # or e.g. ROOT='D:\codex-build' on a drive with more space
node install.mjs --dry-run --codex-build-root "$ROOT"
node install.mjs --check --codex-build-root "$ROOT"
```
These commands are for Git Bash. In PowerShell use `$env:USERPROFILE\codex-build`. Pick a build root on a drive
with ≥ 15 GB free; use a non-system drive if C: is tight.

What the installer does:
- copies scripts, hooks, skills, the pane plugin and busybox into `~/.claude`;
- merges its hooks into `settings.json` (foreign hooks are untouched; one backup `settings.json.bak-luna-harness`);
- wraps the rules in `<!-- luna-harness:begin/end -->` in `CLAUDE.md`;
- writes `~/.claude/luna-harness.env` (custom build root);
- creates the `codex-gate-runner-off` sentinel;
- patches the Codex plugin;
- runs every self-test.

It is idempotent: re-running changes nothing.

Check: the PASS/FAIL table has no FAIL. `[warn] custom Codex not built yet` is expected until step 7.
If it says `CLAUDE.md` was appended because one already existed, show the user the duplicate rules and merge them
with the user's consent.

## 5. Enable the Luna pane plugin [ASK]
```bash
claude plugin install luna-panel@luna-local
```
The installer already registered the `luna-local` marketplace (`~/.claude/local-plugins`). You can also use
`/plugin install luna-panel@luna-local`.
Check: in a NEW session, `/luna` opens the pane. The pane also opens on its own at the first prompt of each session.
Claude Code runs the pane from its plugin cache (`~/.claude/plugins/cache/luna-local/luna-panel/<version>/`), not
from `~/.claude/local-plugins/`. After a package update changes the pane, bump its version, then run:
`claude plugin marketplace update luna-local && claude plugin update luna-panel@luna-local`, then restart sessions.
Without the update every session keeps running the old pane.

## 5b. Luna tray widget
A small native Windows app, ~25 MB RAM. It shows the same view as the pane, outside Claude Code, and does not
depend on which session is open.

**What it does.**
- A tray icon by the clock:
  - its colour is the overall state: green OK, amber needs a look, red stuck or out of memory;
  - a number on it is the count of running Codex jobs.
- Left click opens a flyout with everything that needs attention, resources (RAM, Claude and Codex limits, the
  daemon) and every session with its Claude status and Codex jobs. Click outside it, or press Esc, to hide it.
- The pin button turns the flyout into a widget that stays on screen and can be dragged.
- The right-click menu has: pin, always-on-top, start with Windows, refresh, exit.

**Build and start.** No SDK is needed; it compiles with the C# compiler that ships with Windows:
```bash
cmd //c "$(cygpath -w widget/build-widget.cmd)"     # → %USERPROFILE%\.claude\bin\luna-widget\LunaWidget.exe
start "" "$USERPROFILE/.claude/bin/luna-widget/LunaWidget.exe"
```
"Start with Windows" writes the user's Run registry key. Leave that to the user, via the widget's right-click menu.
`LunaWidget.exe --render out.png` draws the panel once into an image; `--self-test` checks the card-order logic
(result in `%TEMP%unawidget.selftest.txt`, exit code 0 = pass).

## 6. Restart and smoke-test
Hooks load at session start, so close and reopen Claude Code (or start a new session). Then:
```bash
bash ~/.claude/scripts/luna.sh -r -e low -o "$TEMP/ready.md" "Reply with exactly: OK"   # expect OK within ~30 s
grep -E "^(state|engine|shell)=" "$TEMP/ready.md.status"
node ~/.claude/scripts/luna-daemon.mjs --status                        # ok:true, appServer up
node ~/.claude/scripts/heavy-gate.mjs --status                         # JSON, off:false
node ~/.claude/scripts/learning/loop.mjs status                        # paused=false
```
Check: the readiness job prints `OK`, and its status shows `state=done` and `engine=daemon`. Before step 7 the
`shell=` line shows the stock shell; after step 7 it shows `busybox-sh`.

## 7. Build the custom Codex [ASK: installs Rust, VS Build Tools, Windows SDK; ~1 h; ~7 GB RAM; ~12 GB disk]
Follow `codex-build/BUILD.md` exactly:
1. prerequisites;
2. `setup-source.ps1`;
3. `build.ps1 -Jobs 2`;
4. `assemble-dist.ps1`;
5. `node install.mjs --codex-build-root <root>`.

Rules for the build:
- Run the build in the background and do no other heavy work meanwhile.
- Keep `-Jobs 2`: 4 jobs ran a 16 GB machine out of memory.

Check: `<root>\dist\bin\codex.exe --version` prints `codex-cli 0.162.1`. A new readiness job shows
`shell=busybox-sh` in its status. Then run `node ~/.claude/scripts/luna-daemon.mjs --stop` once, so the next job
starts a daemon on the new binary.

## 8. Optional, user action only
- **Windows Defender exclusions** for the project folders and `%USERPROFILE%\.claude` cut CPU load from scanning
  `node_modules` a lot. This is a security setting: explain the trade-off and let the user do it themselves
  (Windows Security → Virus & threat protection → Exclusions).
- **Desktop apps:** if the user doesn't use the ChatGPT/Codex desktop app, closing it saves ~2 GB RAM. Our jobs don't
  need it.

## Operating notes (read once; the `luna` skill has the full rules)
- **Off switches:**

  | Switch | What it turns off |
  |---|---|
  | `~/.claude/heavy-gate-off` (file) | the heavy gate |
  | `~/.claude/luna-autoload-off` | skill autoload digest |
  | `~/.claude/codex-gate-paused` | review gate |
  | `~/.claude/learning/PAUSED` | learning runs |
  | `~/.claude/learning/CAPTURE_OFF` | learning capture |
  | `LUNA_DAEMON=0` (env) | the daemon; jobs fall back to one process each |
  | `~/.claude/luna-daemon-off` (file) | the daemon, unless `LUNA_DAEMON` is explicitly set |

- **CPU priority:** inherited by default; `LUNA_LOW_PRIORITY=1` opts the Codex tree into BelowNormal.
- **Small TEMP:** exec jobs and the daemon use dedicated temporary directories; `LUNA_JOB_TEMP=0` keeps inherited TEMP.
- **State and logs:** `~/.claude/luna-run/` (daemon, heavy gate, reaper, swap logs) and `~/.claude/learning/`.
- **Updating:** `git pull`, then `node install.mjs --check`. Mid-run replacement is safe for `luna.sh` and
  `luna-watch.sh` (whole-script `{ … }` wrapper) and for Node scripts. A running daemon keeps the old code until it
  exits after 10 idle minutes; `luna-daemon.mjs --stop` forces it.
- **Never** edit `luna.sh`/`luna-daemon.mjs` in place while jobs run. Write `<file>.next`, test it, then swap; for
  scripts without the wrapper use `luna-swap-when-idle.sh`.
- **The Codex plugin may update itself.** At every session start, `luna-harness-plugin-patch.mjs` re-applies the
  patches for 1.0.3 and 1.0.6 across all cache version directories and the marketplace. Per-file variants match known
  original or patched content after CRLF normalisation, including later versions with identical content. Unknown
  content is logged once per target/hash in `~/.claude/luna-run/plugin-patch.log` and left unpatched.
  `node ~/.claude/scripts/luna-harness-plugin-patch.mjs --check` shows the state. Port the patches
  (see `payload/codex-plugin-patches/README.md`) or ask the owner.
- **Uninstall:** `node install.mjs --uninstall` (`--dry-run` to preview). It removes our hooks, files, the
  `CLAUDE.md` block and the plugin patches. Files the user edited stay, with a warning. Data in `luna-run/` and
  `learning/` stays.
- **Known incidents and fixes:** see the `luna` skill (`~/.claude/skills/luna/SKILL.md`): RAM gate,
  ECONNRESET/busy daemon, ghost jobs after reboot, broker leaks, unelevated sandbox, heavy gate.

## Not transferred
- Codex login: per machine, `codex login`.
- Learning data: events, adopted edits, candidates. The loop starts fresh.
- Runtime state (`luna-run`).
- GSD itself (step 1b installs it from npm).
