# luna-harness package spec (shared contract for all build slices)

Goal: a private git repo that an agent on ANOTHER Windows 10/11 machine clones, runs one installer, builds the custom
Codex, and gets exactly the same Claude Code + Codex orchestration as the source machine: the `luna`/`luna-critics`
skills, the Luna daemon & wrappers, heavy-command gate, broker reaper, the Luna pane plugin, the self-learning loop
(code + config, NO personal data), the patched Codex plugin, and the custom Codex build with busybox shell.
The owner's personal rules (global CLAUDE.md, skills text) are shipped AS-IS (owner decision).

## Layout (repo root = C:/dev/luna-harness)
```
README.md, INSTALL.md                 docs (written by the orchestrator, not by slices)
PACKAGE-SPEC.md                       this file
install.mjs                           installer (slice S2)
tests/verify-temp-home.mjs            installs into a temp home and runs --check (slice S2)
payload/manifest.json                 file list (slice S1)
payload/claude/...                    mirrors ~/.claude (slice S1)
payload/settings/hooks.json           settings fragments with placeholders (slice S1)
payload/claude-md/harness-section.md  global CLAUDE.md content (slice S1)
payload/codex-plugin-patches/         patched + orig plugin files and their manifest (slice S1)
codex-build/                          custom Codex build kit (slice S3)
```

## payload/manifest.json
```json
{ "version": 1,
  "files": [ { "src": "claude/scripts/luna.sh", "dest": "scripts/luna.sh",
               "kind": "file", "sha256": "<hex of src>" } ],
  "settings": "settings/hooks.json",
  "claudeMd": "claude-md/harness-section.md",
  "pluginPatches": "codex-plugin-patches/manifest.json" }
```
- `src` is relative to `payload/`; `dest` is relative to the Claude home (`<home>/.claude`), forward slashes.
- `kind`: `file` (install/replace), `config-if-absent` (install only when dest is missing), `binary` (like file,
  verify sha256 after copy).

## payload/settings/hooks.json
```json
{ "hooks": { "<EventName>": [ { "matcher": "Bash|PowerShell",
      "hooks": [ { "type": "command",
                   "command": "\"{{NODE}}\" \"{{CLAUDE_HOME}}/scripts/heavy-gate.mjs\" hook-pre",
                   "timeout": 660 } ] } ] },
  "extraKnownMarketplaces": { "luna-local": { "source": { "source": "directory", "path": "{{CLAUDE_HOME_WIN}}\\local-plugins" } } },
  "enabledPlugins": { "luna-panel@luna-local": true, "codex@openai-codex": true } }
```
Placeholders (installer substitutes): `{{NODE}}` = absolute node.exe path with forward slashes;
`{{CLAUDE_HOME}}` = `<home>/.claude` with forward slashes; `{{CLAUDE_HOME_WIN}}` = same with backslashes.
Entries omit `matcher` when the source entry has none. Merge identity of a hook entry = event name + the script
path inside the command (e.g. `scripts/heavy-gate.mjs` + first argument `hook-pre`).

## payload/codex-plugin-patches/manifest.json
```json
{ "plugin": "codex@openai-codex", "version": "1.0.3",
  "roots": ["plugins/cache/openai-codex/codex/1.0.3", "plugins/marketplaces/openai-codex/plugins/codex"],
  "files": [ { "rel": "scripts/app-server-broker.mjs", "origSha256": "...", "patchedSha256": "...",
               "patched": "patched/scripts/app-server-broker.mjs", "orig": "orig/scripts/app-server-broker.mjs" } ] }
```
`roots` are relative to the Claude home. Paths inside are forward slashes.

## Machine-specific settings
`<home>/.claude/luna-harness.env` (KEY=VALUE lines, written by the installer):
- `LUNA_CUSTOM_CODEX_ROOT=<Windows path of the custom Codex build root>`; default when absent:
  `%USERPROFILE%\codex-build`. The custom codex binary is `<root>\dist\bin\codex.exe`.
Scripts read this file when the env var of the same name is not set.

## Excluded from the package
Backups (`*.bak-*`, `*.orig*` except inside codex-plugin-patches/orig), `luna-run/`, learning DATA (everything in
`~/.claude/learning/` except `config.json`), GSD tooling (`scripts/changeset/`, `scripts/lib/cli-exit.cjs`,
`scripts/lib/allowlist-ratchet.cjs`), `scripts/pytest_gate.py`, plugin caches other than the patch files.
