---
name: bro-server-connect
description: >-
  Administer this machine locally: bro-server (Debian 13), hosting the GT New Horizons (GTNH)
  Minecraft server as gtnh-server.service. Use for bro-server, GTNH, "второй сервер",
  "мой Linux-сервер", service control, RCON, backups, auto-region-repair, server updates,
  or server-side mods. Run commands directly on this box; no SSH or key is needed.
---

# bro-server (second personal server)

Claude runs **on bro-server itself**, as Linux user `bro`. This Debian 13 (trixie) box runs
**GT New Horizons 2.8.4** (Minecraft 1.7.10 / Forge, via lwjgl3ify) as a systemd service.
Run admin commands locally: no SSH to itself and no SSH key. It has 4 cores and 15 GB RAM.
GTNH (`gtnh-server.service`) and Claude/Codex work are never run at the same time on this box,
so the full machine is available to Claude; do not start GTNH while Claude work is running unless the user asks.
The Windows PC is a backup.
The separate Windows Docker host **NucBox** is accessed using `personal-server-connect`.
LAN IPs drift with DHCP; identify remote hosts by their recorded SSH host key, not IP.

## Security first — read before doing anything

- **Never print, log, echo, or paste the RCON password or other credentials into chat,
  commits, or final answers.** The RCON details live in `references/credentials.local.md` (gitignored).
  Refer to them by path, never by value.
- `bro` has passwordless `sudo` (desktop-class install). Only use `sudo` for things that
  actually need root (systemd unit edits, package installs) — never for routine server
  administration, which runs fine as `bro`.
- **Never blindly `rm`/overwrite `/home/bro/gtnh-server`** — it's a live world with players.
  Treat `World/`, `server.properties`, `PregenTaskList.dat`-equivalents, and `backups/` as
  precious. Stop the service cleanly before touching world files on disk.
- The `backups/` directory already holds large (20GB+) full-world zips and dated
  auto-region-repair / crash-recovery folders from an existing self-healing setup — don't
  delete anything in there without the user's say-so.
- This is a **live multiplayer server** with players online at times — prefer RCON commands
  (`save-off`/`save-all`/`stop` via RCON) or a clean `systemctl stop` over killing the java
  process directly.

## Quick orientation

| Thing | Value |
|-------|-------|
| Machine | `bro-server` (this box), local user `bro`; no SSH or key |
| OS | Debian GNU/Linux 13 (trixie), kernel 6.12.x |
| Java | OpenJDK 21.0.12 (`/usr/bin/java`) |
| Server root | `/home/bro/gtnh-server` |
| systemd unit | `gtnh-server.service`, mirrored at `deploy/bro/gtnh-server.service` in the gtnh repo |
| Minecraft port | `25566` |
| RCON | enabled, port `25576`, password in `references/credentials.local.md` |
| online-mode | `false` |
| Modpack | GT New Horizons 2.8.4, via `lwjgl3ify-forgePatches.jar` |
| Notable server-side mods | JourneyMapServer (multiplayer waypoint sync only, no web map), Opis (mapless build — profiling/TPS dashboard, map feature stripped), ProjectBlue |

## Local administration

```bash
hostname
systemctl status gtnh-server --no-pager
journalctl -u gtnh-server -n 100 --no-pager
```

Use passwordless `sudo` only if an operation requires root. See `references/server-access.md`
for local checks and the RDP / desktop setup.

## What to read for the task at hand

- **Local access, desktop, troubleshooting** → `references/server-access.md`
- **Managing the service, deploying updates, RCON, backups** → `references/deploy.md`
- **Actual RCON password** → `references/credentials.local.md` (local-only, gitignored)

## Standard workflow

1. **Confirm local state** with `systemctl status gtnh-server --no-pager`.
2. **Inspect** before changing anything — `journalctl -u gtnh-server -n 100 --no-pager`,
   check `backups/` for recent auto-repair activity that might explain current state.
3. **Prefer RCON or `systemctl` over touching files** for routine control (start/stop/restart,
   `save-all`, broadcasting messages). See `references/deploy.md` for exact commands.
4. **For file changes** (mods, configs, server.properties): stop the service first
   (`systemctl stop gtnh-server` or RCON `stop`), make the change, and restart only if the user asks
   to start GTNH during Claude work. After an authorized restart, tail the log to confirm a clean boot.
5. **Report** what changed and the service's state afterward. Never include the
   RCON password or other secrets in the report.
