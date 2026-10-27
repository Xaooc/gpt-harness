# luna-harness

A ready-made Claude Code + Codex setup: Claude orchestrates, Codex executes. One installer supports Windows and Linux.

**Агенту на новой машине: начни с [INSTALL.md](INSTALL.md).**

## What it contains

| Part | What it does |
|---|---|
| `luna` and `luna-critics` skills | Rules for orchestration: who executes what, how to write briefs, the critic panels |
| Luna daemon and wrappers (`luna.sh`, `luna-daemon.mjs`, …) | Every Codex job from every session runs as a thread of one shared `codex app-server`, scheduled fairly, gated by RAM, with a stall watchdog |
| Heavy-command gate (`heavy-gate.mjs`) | At most 2 heavy commands machine-wide, and only while RAM is free. This protects the PC from freezing |
| Broker reaper and Codex plugin patches | Reap process leaks; on Windows, patch the plugin for the review gate |
| Luna pane (`/luna`) and tray widget (`widget/`) | Live status: RAM, Claude/Codex limits, jobs per session — inside Claude Code and as a Windows tray widget |
| **Self-learning** (after google-research/harness2), see [SELF-LEARNING.md](SELF-LEARNING.md) | Collects corrections and outcomes, proposes rule edits daily, filtered by code and a critic, with rollback |
| `codex-build/` | Windows build of Codex 0.164.0 with the busybox patch, so commands run in a 6 MB shell |
| Global `CLAUDE.md` | The owner's rules, tailored to the selected platform |

## Self-learning, after the idea of [google-research/harness2](https://github.com/google-research/harness2)

Every session learns from the past ones. A run happens automatically, once a day, in the background:
- **Capture.** It records the owner's corrections, interruptions, Codex job results, the assumptions executors
  made on their own, and the critics' conclusions.
- **Proposal.** Luna proposes edits to the rules: `CLAUDE.md`, the `luna` and `luna-critics` skills.
- **Filter.** Code accepts an edit only if the problem repeats in at least 2 sessions or the owner corrected it
  explicitly. Then a Sol critic checks it. Lines marked as the owner's decisions and safety rules cannot be changed.
- **Application and rollback.** Each edit has a backup, an entry in the journal and an id for rollback. An edit
  after which failures grew is reverted automatically.

On a new machine it starts with empty data: only the code and settings move over, not the owner's history.
Details and controls: [SELF-LEARNING.md](SELF-LEARNING.md).

## Linux

Use Node.js 22+, `bash`, `curl`, and `python3`, then install the stock CLI with
`npm i -g @openai/codex@0.164.0`. GSD is recommended, as on Windows. No custom Codex build or plugin patches are
needed. An optional proxy file defaults to `~/.config/luna-proxy.env` and can be selected with `LUNA_PROXY_ENV_FILE`;
when unset, the legacy `~/.config/bro-env.sh` is used if the default is absent. Disk audit has no default repositories;
configure `~/.claude/disk-audit.json` to enable it for specific repositories. See [INSTALL.md](INSTALL.md) for setup.

## Repo structure
- `install.mjs`: the installer. It is idempotent, makes backups, and `--check` runs all self-tests.
- `payload/`: the Windows payload installed into `~/.claude`.
- `payload-linux/`: the Linux snapshot and portable settings installed into `~/.claude` (see `PACKAGE-SPEC.md`).
- `codex-build/`: build kit for the custom Codex.
- `tests/verify-temp-home.mjs`: installs into a temporary home folder and checks everything there.
