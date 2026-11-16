# pstack vendor log

Upstream: https://github.com/cursor/plugins (directory `pstack`), MIT, author Lauren Tan.

| Date | Upstream commit | Upstream version | Local version |
| --- | --- | --- | --- |
| 2026-11-16 | bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7 | 0.15.42 | 0.15.42-bro.1, bro.2 (adapter: brief size by tier) |

Excluded from the install: `skills/make-bot-ui` (remote installer run as root, network-reachable server),
`automations/` (Benny Slack/tracker automation), the Cursor manifests (`plugin.json`, `.cursor-plugin/`).
Local additions: `.claude-plugin/plugin.json`, `docs/harness/bro-harness.md` (harness adapter; it overrides
poteto-mode "Autonomy"), this file. Upstream files are otherwise unmodified; update by re-copying a newer
upstream commit and re-reviewing every changed file before install.
