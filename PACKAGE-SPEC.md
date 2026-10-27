# luna-harness package spec (shared contract for all build slices)

Goal: a private git repo that an agent on another Windows or Linux machine clones and runs one installer. On Windows it builds the custom
Codex, and gets exactly the same Claude Code + Codex orchestration as the source machine: the `luna`/`luna-critics`
skills, the Luna daemon & wrappers, heavy-command gate, broker reaper, the Luna pane plugin, the self-learning loop
(code + config, NO personal data), the patched Codex plugin, and the custom Codex build with busybox shell.
The Windows owner's personal rules are shipped as-is. Linux carries the server rules with host-specific details removed.

On Linux, the installer uses the server-derived `payload-linux/`, stock Codex 0.164.0 and an unpatched plugin.
Linux prerequisites are Node 22+, bash, curl, python3 and `npm i -g @openai/codex@0.164.0`; GSD is recommended.
No custom Codex build, busybox or tray widget is required. Set `LUNA_PROXY_ENV_FILE` for an optional proxy environment
file; it defaults to `~/.config/luna-proxy.env` and falls back to `~/.config/bro-env.sh` if the default is absent.
Linux disk-audit defaults to no repositories; configure `~/.claude/disk-audit.json` before auditing specific projects.

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
payload-linux/manifest.json           Linux file list and hashes
payload-linux/claude/...              Linux server scripts, hooks, skills and local plugin
payload-linux/settings/hooks.json     Linux hook registrations and local marketplace
payload-linux/claude-md/harness-section.md  portable Linux global rules
payload/codex-plugin-patches/         patched + orig plugin files and their manifest (slice S1)
payload/claude/scripts/luna-harness-plugin-patch.mjs  shared patch engine + silent session repair command
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
- All files under `payload/codex-plugin-patches/` are also installed under
  `<CLAUDE_HOME>/luna-harness/codex-plugin-patches/` so session repair works without the checkout.
- Linux uses the same schema without `pluginPatches`. Its `settingsSha256` and `claudeMdSha256` cover the two
  non-installed source files, and `executable: true` marks scripts that need executable permissions on Linux.
  Linux includes the snapshot's tests, pytest gate and disk/changeset tooling; GSD hooks and runtime data are excluded.

## Installation, upgrades, and uninstall

The installer selects `payload/` on `win32` and `payload-linux/` on `linux`; `--platform win32|linux` overrides this
for testing. Before writing, it verifies source hashes, parses settings (UTF-8 BOM accepted, comments rejected),
validates a single ordered CLAUDE.md marker pair or no markers, substitutes the hook fragment, and on Windows
validates both copies of every plugin patch. `--dry-run` plans without writes; `--check` installs and runs checks.

After installation, `<CLAUDE_HOME>/luna-harness.installed.json` is written atomically:
```json
{ "v": 1, "installedAt": "<ISO timestamp>", "repoCommit": "<git HEAD or null>",
  "files": { "scripts/example.mjs": "<sha256 as installed>" },
  "hooks": ["<JSON-encoded event, script path, first argument identity>"],
  "marketplaces": ["luna-local"], "createdSentinel": true, "createdEnv": true,
  "restoration": { "settings.json": { "before": "<base64 original bytes or null>",
    "restoreExact": true, "installedSha256": "<hash>" }, "CLAUDE.md": {} },
  "pluginFiles": ["<relative plugin target path>"] }
```
`restoration` and `pluginFiles` are additional v1 metadata for exact restoration. Uninstall validates plugin
backups using the patch manifest and variant files from `<CLAUDE_HOME>/luna-harness/codex-plugin-patches/`, or the
repository payload when that installed copy is unavailable; without either source, plugin restoration is skipped
with a warning.
Pre-existing `config-if-absent` files are not claimed. Previously installed config hashes are retained if the user
edits them. Creation flags survive upgrades. A no-op reinstall leaves the record and timestamp unchanged.

Upgrade pruning uses the previous record: removed manifest files are deleted only if their hashes still match;
edited files are retained with a warning. Dropped hook identities are removed, including newly empty matcher groups.
Before replacing a locally edited payload destination, save a timestamped `.bak-luna-harness-YYYYMMDD-HHMMSS`
backup (numeric suffix on collisions) and warn. The first install also retains the once-only `.bak-luna-harness`.

`node install.mjs --home <home> --uninstall` requires the record. It validates settings and markers first, removes
recorded hook identities, the `luna-local` marketplace and `luna-panel@luna-local` enabled-plugin entry, and the
CLAUDE.md marker block. Unchanged settings/CLAUDE.md can be restored byte-for-byte from restoration metadata;
if subsequently edited, selective removal preserves user content. Pre-existing managed entries are removed rather
than resurrected. Installed files are deleted only on a recorded hash match. Plugin targets with
`.orig-luna-harness` backups are restored using the original bytes. Only installer-created env/sentinel files are
deleted. The record is removed last. `--uninstall --dry-run` performs the same validation and planning without writes.
Never remove `luna-run/`, `learning/`, or any `.bak-luna-harness*` / `.orig-luna-harness` backups.

## payload/settings/hooks.json
```json
{ "hooks": { "<EventName>": [ { "matcher": "Bash|PowerShell",
      "hooks": [ { "type": "command",
                   "command": "\"{{NODE}}\" \"{{CLAUDE_HOME}}/scripts/heavy-gate.mjs\" hook-pre",
                   "timeout": 660 } ] } ] },
  "extraKnownMarketplaces": { "luna-local": {
    "source": { "source": "directory", "path": "{{CLAUDE_HOME_WIN}}\\local-plugins" } } },
  "enabledPlugins": { "luna-panel@luna-local": true, "codex@openai-codex": true } }
```
Placeholders (installer substitutes): `{{NODE}}` = absolute node.exe path with forward slashes;
`{{CLAUDE_HOME}}` = `<home>/.claude` with forward slashes; `{{CLAUDE_HOME_WIN}}` = same with backslashes.
On Linux `{{NODE}}` is the Node executable, the local marketplace uses `{{CLAUDE_HOME}}/local-plugins`,
and the heavy-gate hooks match `Bash` rather than `Bash|PowerShell`.
Entries omit `matcher` when the source entry has none. Merge identity of a hook entry = event name + the script
path inside the command (e.g. `scripts/heavy-gate.mjs` + first argument `hook-pre`).

## payload/codex-plugin-patches/manifest.json
```json
{ "plugin": "codex@openai-codex", "versions": ["1.0.3", "1.0.6"],
  "roots": ["plugins/cache/openai-codex/codex/*", "plugins/marketplaces/openai-codex/plugins/codex"],
  "files": [ { "rel": "scripts/lib/app-server.mjs", "variants": [
    { "versions": ["1.0.3"], "orig": "orig/scripts/lib/app-server.mjs", "origSha256": "...",
      "patched": "patched/scripts/lib/app-server.mjs", "patchedSha256": "..." },
    { "versions": ["1.0.6"], "orig": "1.0.6/orig/scripts/lib/app-server.mjs", "origSha256": "...",
      "patched": "1.0.6/patched/scripts/lib/app-server.mjs", "patchedSha256": "..." } ] } ] }
```
`roots` are relative to the Claude home. Paths inside are forward slashes. A trailing `/*` expands every direct
subdirectory in sorted order; other uses of `*` and paths escaping the Claude home are invalid.
Versions label known content; files are selected by hashes after CRLF normalisation, even on later plugin versions.
Broker and lifecycle files share one variant with `versions: ["1.0.3", "1.0.6"]`; only app-server and process
need separate 1.0.6 copies. Original storage preserves exact plugin bytes (CRLF); patched storage uses LF.
Every variant's stored SHA256 is verified. Equal normalised originals with differing patches and variants whose
patched hash equals another variant's original hash are rejected. Legacy file-level `orig`/`patched` remains supported.
Install records store concrete `pluginFiles` paths with backups for known patched content, so uninstall restores
each recorded version from its original bytes without expanding wildcards.

The installer imports the matching engine from `luna-harness-plugin-patch.mjs`. It validates the manifest's raw
payload hashes, then compares target/original/patched content with CRLF normalized to LF. Patching preserves CRLF
when the target contains any CRLF, otherwise LF; `.orig-luna-harness` stores the exact original bytes.

The installed script reads its patch set from `<CLAUDE_HOME>/luna-harness/codex-plugin-patches/`. The silent
SessionStart clean hook launches it detached alongside `luna-clean.mjs` when present. Default mode patches known
originals, logs actions to `luna-run/plugin-patch.log`, and remembers unknown file/hash pairs in
`luna-run/plugin-patch-state.json` to log each only once. Errors in default mode are silent with exit 0.
`--check` prints target status and exits 1 for patchable or unknown versions; missing targets are skipped.
`--self-test` uses disposable fixtures. `CLAUDE_HOME` can override the default `<home>/.claude` for this script/hook.

## Machine-specific settings
On Linux, `LUNA_PROXY_ENV_FILE` selects an optional file with proxy exports. If unset, the default is
`~/.config/luna-proxy.env`, with `~/.config/bro-env.sh` as a legacy fallback when that default is absent.
Linux does not create `luna-harness.env` or set a custom Codex build root.

`<home>/.claude/luna-harness.env` (KEY=VALUE lines, written by the installer):
- `LUNA_CUSTOM_CODEX_ROOT=<Windows path of the custom Codex build root>`; default when absent:
  `%USERPROFILE%\codex-build`. The custom codex binary is `<root>\dist\bin\codex.exe`.
Scripts read this file when the env var of the same name is not set.

## Excluded from the package
Windows excludes backups (`*.bak-*`, `*.orig*` except inside codex-plugin-patches/orig), `luna-run/`, learning DATA (everything in
`~/.claude/learning/` except `config.json`), GSD tooling (`scripts/changeset/`, `scripts/lib/cli-exit.cjs`,
`scripts/lib/allowlist-ratchet.cjs`), `scripts/pytest_gate.py`, plugin caches other than the patch files.
Linux excludes GSD hooks and the GSD managed-hooks registry, backups, caches, runtime data and the Windows tray app.
