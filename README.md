# luna-harness

A ready-made Claude Code + Codex setup: Claude orchestrates, Codex executes. Moved to a new Windows machine with one
installer.

**Агенту на новой машине: начни с [INSTALL.md](INSTALL.md).**

## What it contains

| Part | What it does |
|---|---|
| `luna` and `luna-critics` skills | Rules for orchestration: who executes what, how to write briefs, the critic panels |
| Luna daemon and wrappers (`luna.sh`, `luna-daemon.mjs`, …) | Every Codex job from every session runs as a thread of one shared `codex app-server`, scheduled fairly, gated by RAM, with a stall watchdog |
| Heavy-command gate (`heavy-gate.mjs`) | At most 2 heavy commands machine-wide, and only while RAM is free. This protects the PC from freezing |
| Broker reaper and Codex plugin patches | Fix process leaks in the review gate and enable its sandbox |
| Luna pane (`/luna`) | Live status: RAM, Claude/Codex limits, jobs per session |
| Self-learning | Collects corrections and outcomes, proposes rule edits daily, filtered by code and a critic, with rollback |
| `codex-build/` | Build of Codex 0.162.1 with the busybox patch, so commands run in a 6 MB shell instead of PowerShell |
| Global `CLAUDE.md` | The owner's rules, as-is |

## Repo structure
- `install.mjs`: the installer. It is idempotent, makes backups, and `--check` runs all self-tests.
- `payload/`: what gets installed into `~/.claude` (see `PACKAGE-SPEC.md`).
- `codex-build/`: build kit for the custom Codex.
- `tests/verify-temp-home.mjs`: installs into a temporary home folder and checks everything there.
