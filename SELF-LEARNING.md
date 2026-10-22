# Self-learning loop

The idea comes from [google-research/harness2](https://github.com/google-research/harness2): the agent harness gets
better from its own sessions. Here it is applied to Claude Code: the global rules and skills evolve from what
actually happened in past sessions, automatically, with deterministic guards. Full design:
`payload/claude/scripts/learning/DESIGN.md`.

## What is installed
| File (in `~/.claude`) | Role |
|---|---|
| `hooks/learning-capture.mjs` | Stop / SessionEnd hook. Starts transcript extraction in the background. |
| `hooks/learning-session-start.mjs` | SessionStart hook. Starts a due run, shows a short report and decisions awaiting the user. |
| `scripts/learning/extract.mjs` | Turns transcripts into events: corrections, interrupts, Luna jobs, executor assumptions, critic outputs. |
| `scripts/learning/loop.mjs` | One run: proposer → code gates → critic → apply/log. CLI: `run`, `status`, `list`, `report`, `revert`. |
| `scripts/learning/core.mjs` | Validation, application and reversal of edits (the guards live here, not in prompts). |
| `scripts/learning/registry.mjs` | Registry of Luna jobs. `luna.sh` records every finished job. |
| `scripts/learning/prompts/` | Proposer (Luna, effort max) and adversarial critic (Sol, effort high) prompts. |
| `scripts/learning-revert.sh <id>` | Reverts one adopted edit. |
| `learning/config.json` | Thresholds and budgets. Installed only if absent. |

Data accumulates in `~/.claude/learning/` (`events.jsonl`, `adopted.md`, `candidates.jsonl`, `runs/`,
`reports/`, `backups/`). It is never shipped in this repo.

## How a run works
1. **Trigger.** At session start, if more than 24 h passed since the last run and there are at least 5 new events.
   A failed run is retried after 6 h.
2. **Proposer.** Luna reads the new events and suggests at most 3 edits to `CLAUDE.md`, `skills/luna/SKILL.md` or
   `skills/luna-critics/SKILL.md`. Each edit cites events with verbatim quotes.
3. **Code gates.** An edit passes only if:
   - its evidence comes from **≥ 2 different sessions** or includes **an explicit correction by the user**, and every
     quote is re-checked against the source transcript;
   - it stays within the file size budget;
   - it touches no protected line. Protected lines are user decisions, `NEVER`, safety and confirmation rules, the
     `learning:protected` block, and frontmatter;
   - it adds no wording that weakens safeguards.
4. **Critic.** Sol checks each edit: is the evidence real, is the rule over-generalised, does it conflict with a
   user decision, does it weaken safety. Its default answer is reject.
5. **Apply or log.** Approved edits are applied with a backup, an `adopted.md` entry and an id. Everything else
   goes to `candidates.jsonl` and is re-offered when more evidence arrives. Questions only the user can decide
   appear at session start as "needs your decision".
6. **Regression revert.** If failures tied to an adopted edit grow afterwards, the edit is reverted automatically.
   This needs a 3-day window or an explicit user correction.

## Control
```bash
node ~/.claude/scripts/learning/loop.mjs status        # last run, candidates, paused?
node ~/.claude/scripts/learning/loop.mjs run --force   # run now
node ~/.claude/scripts/learning/loop.mjs list          # adopted edits with ids
bash ~/.claude/scripts/learning-revert.sh <id>          # revert one edit
```
- **Pause all runs:** create `~/.claude/learning/PAUSED`.
- **Stop capturing events:** create `~/.claude/learning/CAPTURE_OFF`.
- **Human-readable history:** `~/.claude/learning/adopted.md` and `~/.claude/learning/reports/`.

## On a new machine
Nothing to configure. The installer wires the hooks and installs `config.json`. The first run happens after
enough sessions, once there are 5 or more new events. To check it works, run after a few sessions:
`node ~/.claude/scripts/learning/loop.mjs status`. It should show growing event counts and `paused=false`.
