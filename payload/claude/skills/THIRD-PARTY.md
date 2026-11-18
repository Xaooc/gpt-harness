# Third-party skills vendored in this package

These skills are copied unchanged from the owner's live setup so a new machine gets exactly the versions in use.
Update them by copying the newer upstream files over these and running `node tools/manifest-sync.mjs`.

| Skills | Upstream | License |
|---|---|---|
| `banner-design`, `brand`, `design`, `design-system`, `slides`, `ui-styling` | ClaudeKit (claudekit.ai) design skills | MIT (per each SKILL.md; `ui-styling/LICENSE.txt`) |
| `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` on GitHub | MIT |

The harness's own skills here are `luna`, `luna-critics`, `bro-server-connect` and `personal-server-connect`.
GSD's `gsd-*` skills are not vendored: GSD installs them itself (see `external.json`, entry `gsd-core`).
