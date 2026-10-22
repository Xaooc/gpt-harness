---
name: luna-critics
description: Run a panel of clean-context role-play critics on Codex gpt-6-luna (high effort by default, max for attackers on auth/money) - ordinary user, attacker, designer, project manager, maintainer, QA, ops, domain expert - to surface what the main model missed. Use for ANY moderately complex task - after drafting a plan/spec (before implementing) and after implementing (before claiming done or committing). Skip only for trivial edits and pure Q&A.
---

# Luna critics — independent role-play review

**Why this works:** each critic runs in a **fresh Codex context**. It has no access to
Claude's reasoning or the conversation, and it is locked into one concrete persona.
That removes anchoring on the main model's assumptions, and each persona catches a
different class of problem.

## When to run

A task counts as "moderately complex" if it has any of these: more than one file, a new feature or flow,
a data/schema/API change, anything user-facing, auth/money/secrets/PII, concurrency,
deploy/infra, or a non-obvious design decision.

- **Default, always:** after Luna has executed the task (checkpoint B), before telling
  the user it's done or committing.
- **Optional:** after the plan/spec (checkpoint A), only for large or risky tasks where
  a wrong direction would be expensive.

Skip critics for trivial edits, pure questions, and conversational turns.
This trivial-edit exception holds everywhere, even where a project says "always run critics on implementations"
(user decision, 2026-10-22).

Loop: the critics find gaps → Claude verifies them → Luna fixes the accepted ones → re-run
only the critics whose critical/high findings were fixed. Stop after at most 2 rounds.

**Timing:** a critic round takes ~10–15 min. Don't sit idle during it: launch the panel
and, in parallel, start the next independent slice (other files) or do Claude-owned work.
Fix rounds go into one combined brief (see the `luna` skill).

## Pick the panel (size by risk, personas that actually fit the task)

Quota is not a concern, so the quality of the final result wins (see the `luna` skill).
Critics are cheap now, because the whole panel runs in one Codex process.
- Internal library / engine / refactor with no UI: **3–4** personas (typically Мейнтейнер, Тестировщик, Взломщик if it takes untrusted input).
- User-facing feature, data/API change: **5–6**.
- Large diff (several subsystems): add **one critic per subsystem** (e.g. "Мейнтейнер: storage layer"), each pointed at its own files. Don't send one critic to review everything.
- Plan/spec review (checkpoint A): 3–5, including Проджект and a domain expert.
Adding more critics is limited by Claude's synthesis, not by quota. Every finding still has to be verified, so choose personas that differ from each other, not near-duplicates.

| Persona | Hunts for |
|---|---|
| **Рядовой пользователь** — non-technical, impatient, first time using it | Confusing flows, unclear texts/errors, dead ends, "what do I click now", things that break with normal-but-unexpected input |
| **Взломщик** — hostile attacker / pentester | Injection, authz/authn gaps, IDOR, secrets in code/logs, unsafe defaults, abuse & DoS vectors, supply chain, trust boundaries |
| **Дизайнер** — senior product/UX designer | Visual inconsistency, hierarchy, spacing, states (empty/loading/error), accessibility, mobile, dark mode (critique only — fixes are done by Claude) |
| **Проджект** — PM who owns the outcome | Does it solve the real request? Missing requirements, scope creep, unclear acceptance, rollout/migration for existing users, what to tell stakeholders |
| **Мейнтейнер** — senior engineer who'll own this in a year | Architecture fit, needless complexity, duplication, naming, hidden coupling, missing/weak tests, breaking changes |
| **Тестировщик** — QA trying to break it | Edge cases, boundaries, null/empty/huge input, error paths, races, idempotency, time zones/encodings, regressions |
| **Эксплуатация** — SRE on call at 3am | Deploy/rollback, config & env, perf/cost, resource leaks, logging/observability, failure recovery, backups |
| **Эксперт предметки** — domain specialist (game designer, accountant, lawyer, etc.) | Domain rules and conventions the builder didn't know |
| **Ревизор пробелов** — reviewer who reads the user's goal, then the diff, and asks "what wasn't done?" | Ripples the executor skipped (other callers, docs, config, migrations, tests that should have moved with the change), cases the brief never mentioned, silent assumptions, places where the code does what was literally asked but not what was meant |

Defaults: always include **Рядовой пользователь** for anything user-facing; include **Дизайнер** for user-facing interfaces or visual changes and **Взломщик** for anything that touches input, network, auth, files, or secrets. Add other relevant personas, or invent a sharper one that fits the task.

**After any Sol/Luna implementation, include Ревизор пробелов.** The executors are literal:
they do what the brief says and miss what it didn't say (see the `luna` skill). This critic exists
to catch exactly that. Give it the **user's original goal** (not just the brief) plus the diff, and point it
at the `Assumption:` lines in the executor's result.

## Brief template (one file per critic)

Don't include Claude's rationale or the conversation. Give only the goal, the artifact, and the persona.

```markdown
You are <PERSONA>: <one-line vivid description, mindset and priorities>.
You are reviewing someone else's work. You did not write it, and you owe it nothing.

## What it is supposed to achieve
<the user's goal and constraints, 2–6 lines, neutral wording>

## What to review
<Checkpoint A: path to the plan/spec file>
<Checkpoint B: the spec/brief path + repo root + the exact diff command (`git diff <base>...HEAD` / `git diff` / list of new untracked files) — review the change, not the whole repo>
You may read any file in the repo and use cheap read-only commands (cat, grep, git diff/log).
Do NOT modify anything. Do NOT run tests, builds, servers, installs, or project
scripts (python/node/uv/npm, etc.). This is a static review, and the test results are below.
<Claude pastes the relevant test/gate output here, if any>
Put the shared context first and your persona last. (Claude: keep this whole block
identical across critics, so the Codex prompt cache is reused.)

## Your job
Find the problems that <PERSONA> would hit or care about. Stay in character. Only report
things this persona would actually notice. Be concrete, and skip generic best-practice advice.
Try to break it before you judge it.

## Output (markdown, nothing else)
For each finding:
- **[severity: critical|high|medium|low]** one-line title
  - Scenario: concrete steps/inputs → what goes wrong
  - Evidence: file:line or quote from the plan
  - Suggested fix: 1–2 lines
End with "Top concern:" (one line). If you found nothing real, say "No findings" and
don't invent any.
```

## Run them in parallel

Write the briefs to the scratchpad as `<name>.brief.md`, then launch the panel in **one**
background Bash call:

```bash
bash ~/.claude/scripts/luna-panel.sh "<scratchpad>/critics" "<repo root>"      # 3rd arg / LUNA_PAR = hard upper bound (default 16)
```

Engine: `luna-pool.mjs` runs every critic as a thread inside ONE `codex app-server`, which
is about half the RAM of separate processes. It admits jobs by free RAM, times out stuck turns
(`LUNA_TURN_TIMEOUT_S`, default 2400), and always runs with MCP/plugins/apps disabled.
`LUNA_POOL=0` forces the old one-process-per-critic engine. A pool startup failure falls
back to that engine automatically. `LUNA_POOL_DRY_RUN=1` prints the plan and starts nothing.

Effort: critics run at `high` by default (`LUNA_PANEL_EFFORT` changes the default). Give one
critic its own effort through the file name: `attacker.max.brief.md` → `max`. Use `max` only
for the attacker on auth/money/secrets or a domain expert on genuinely hard rules.

Use `run_in_background: true` and keep the output visible (don't redirect to `/dev/null`).
Check once right after launch with `luna-status.sh <dir>/*.out.md` (expect `running` /
`waiting-ram`). You'll be notified when the panel finishes. The real concurrency
adapts to free RAM: `luna.sh` admits each critic only while there's headroom above the
reserve, and the rest wait their turn. That makes it safe to launch the whole panel
even while other Luna jobs are running.

## Synthesis (Claude does this and never forwards the output raw)

1. Read every `*.out.md`. Merge duplicates. When several personas hit the same thing, give it more weight.
2. **Verify each finding** against the actual code or plan. Critics hallucinate too. Mark each one
   `accepted` or `rejected (reason)`.
3. Fix the accepted ones. Code fixes go to Luna (`luna` skill). Design fixes Claude does itself.
   If a fix changes behaviour significantly, run only the relevant critic(s) again.
4. Tell the user briefly: which panel ran, what was accepted and fixed, what was rejected
   and why, and what is still open for their decision.

If Luna is unavailable, run the same briefs on `general-purpose` Sonnet subagents,
one agent per persona and each with only the brief. Say that Luna was skipped.
