# Global instructions (all projects)

> Project-level `CLAUDE.md`, explicit user requests, and any active project
> workflow (e.g. GSD) take precedence over this file when they conflict.

## Machines

This Windows PC is the backup Claude/Codex host. **bro-server** is the primary host and runs Debian 13.
**NucBox** is the separate Windows Docker host. Use the `bro-server-connect` and `personal-server-connect`
skills for remote administration.

## Harness source

The harness package repo is `Xaooc/gpt-harness` (private), cloned at `C:/dev/luna-harness`. The GitHub CLI may
pull and can push with the owner's yes. Read `README.md`, `PACKAGE-SPEC.md`, `INSTALL.md` and `SELF-LEARNING.md`
for the design. This PC installs from `payload/`. Edit shared files only in `payload-linux/`, then run
`node tools/sync-windows.mjs` to generate `payload/` and `node tools/manifest-sync.mjs` to refresh the Linux
manifest and check Windows. `~/.claude` holds the installed copy. `codex-build/` holds this PC's custom Codex build
(Rust, busybox-shell patch; see `BUILD.md` and `LUNA-PATCH.md`).

## Network

Use the SSH host keys to identify bro-server and NucBox because their LAN addresses can change with DHCP.
The server connection skills document how to find the hosts and verify their identities.
