# luna-harness

The owner's Claude Code + Codex setup as a package: Claude orchestrates and decides, Codex (and Claude subagents)
execute, and lessons become deterministic checks instead of prose. One installer reproduces it on Linux and Windows.

**Агенту на новой машине: начни с [INSTALL.md](INSTALL.md).**

## What a machine gets

| Part | What it does |
|---|---|
| Process: Lauren Tan's **pstack** (vendored, `local-plugins/pstack`) with the `bro-harness.md` adapter | Playbooks per task type, named principles, proof against the real artifact; every session works in poteto-mode |
| **Tier dispatcher** `scripts/conveyor/exec.mjs` | Delegates by tier (`complex`, `simple`, `review`, `scout`, `approach`, `architect`, `planner`) and panel; providers, models and efforts come from `conveyor/orchestration.json`, edited in the Luna panel; fallbacks, quota thresholds, one write job per repository |
| **Approach review** | `approach` (GPT-6.2 Sol max) reviews the plan of a medium change; `architect` (GPT-6.2 Astra max) reviews complex architecture and work that failed the gate; `planner` (Astra) can write the technical plan, reviewed by another model. The dispatcher refuses the first complex write of a task until a review completed (exit 8) |
| **Gates** | Project checks after every executor write job with up to two fix rounds (`check.mjs`, profiles in `.claude/conveyor.json`); subagent gate; acceptance ledger with prompt capture, cross-check and a Stop gate (checks 1–10) |
| **Test budget** | A job may add at most 5 new test cases net (`budgets.new_tests`, or `Test budget: N` in a brief; generated or vendored paths in `budgets.new_tests_exclude`); a budget-only failure lets the fix round delete only the job's own test lines |
| **Review** | `interrogate.mjs` runs adversarial reviewers over the review panel in throwaway worktrees; a finding counts only with a rerun command. `luna-critics` adds persona critics |
| Luna daemon and wrappers (`luna.sh`, `luna-daemon.mjs`, …) | Every Codex job from every session runs as a thread of one shared `codex app-server`, scheduled fairly, gated by RAM, with stall watchdogs |
| Heavy-command gate, pytest gate, disk hygiene | Machine-wide limits for builds and test runs, worktree and temp-file hygiene, cleanup |
| **Luna panel** (`/luna`, `local-plugins/luna-panel`) | Limits and token usage of Claude, Codex and Gemini; executor chains and panels with inline editing; the model catalog fills itself from the Codex and Claude Code CLIs; CLI updates |
| **Self-learning** (after google-research/harness2), see [SELF-LEARNING.md](SELF-LEARNING.md) | Captures corrections and outcomes, proposes rule edits and checks daily, filtered by code and a critic, with rollback |
| Skills | `luna`, `luna-critics`, the server skills `bro-server-connect`, `personal-server-connect`, and vendored third-party design skills (see `payload-linux/claude/skills/THIRD-PARTY.md`) |
| Global `CLAUDE.md` section | The owner's rules; the Linux and Windows files share every process section and differ only in machine facts |
| Third-party tools (`external.json`) | GSD, Superpowers, Context7, Hookify, HyperFrames and the Codex plugin: exact install commands and installed-state probes; `install.mjs --owner-setup` installs what is missing |
| Windows only | Custom Codex build with a busybox shell (`codex-build/`), Codex plugin patches, tray widget (`widget/`) |

What does **not** move: credentials and sign-ins (Claude, Codex, GitHub), the owner's history and learning data,
caches, per-machine settings outside the harness (permissions, status line, MCP servers in `~/.codex/config.toml`),
and machine services (proxy, game server). The panel's live `conveyor/orchestration.json` is the owner's and is never
overwritten; a new machine starts from the shipped default, which is the owner's routing at packaging time.

## Repository layout

- `install.mjs`: the installer (`--dry-run`, `--check`, `--owner-setup`, `--self-test`, `--uninstall`). Idempotent,
  backs up what it replaces, refuses to overwrite local edits (exit 3) unless `--accept-local-drift`.
- `payload-linux/`: the source of truth for every shared file, installed into `~/.claude` on Linux.
- `payload/`: the Windows payload, **generated** from `payload-linux/` by `tools/sync-windows.mjs`; only the files listed
  in `tools/windows-exceptions.json` (Windows runtime, busybox, custom Codex, native process handling) are edited here.
- `external.json`: third-party tools with install commands and probes.
- `tools/manifest-sync.mjs` (Linux manifest) and `tools/sync-windows.mjs` (Windows payload and manifest); both have
  `--check`.
- `tests/`: `install-self-test.mjs` (installer mechanics), `verify-temp-home.mjs` (fresh Linux install and a simulated
  Windows install into temp homes, then the installed dispatcher), `account-lease-test.mjs`, `manifest-sync.test.mjs`.
- `codex-build/`: Windows custom Codex build kit. `docs/specs/`: design history.

## Changing the harness

Edit `payload-linux/` (or a Windows exception in `payload/`), then:

```bash
node tools/manifest-sync.mjs && node tools/sync-windows.mjs
node tools/manifest-sync.mjs --check && node tools/sync-windows.mjs --check
node install.mjs --self-test && node tests/verify-temp-home.mjs
```

On the live Linux machine `node install.mjs --check` must then report no local drift: the installed `~/.claude` and the
package are the same.
