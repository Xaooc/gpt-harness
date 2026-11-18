# Managing the GTNH server

## Service control (preferred over touching the java process directly)

Do not start or restart GTNH during Claude/Codex work unless the user asks.

```bash
sudo systemctl start gtnh-server
sudo systemctl restart gtnh-server
sudo systemctl stop gtnh-server      # TimeoutStopSec=120, sends SIGINT — graceful
systemctl status gtnh-server --no-pager
systemctl is-enabled gtnh-server      # should be 'enabled' (boots with the OS)
```

The unit (`/etc/systemd/system/gtnh-server.service`, mirrored in the gtnh repo at
`deploy/bro/gtnh-server.service`) already has `Restart=on-failure` with a 15s backoff, so
crashes self-recover without intervention — don't add a second supervisor layer on top.

## RCON (for in-game commands without touching the process)

RCON is enabled on port `25576`; password is in `references/credentials.local.md`. Use any
local RCON client, e.g. `mcrcon` if installed:

```bash
export MCRCON_PASS="<read it from references/credentials.local.md into the variable; never type it into chat>"
mcrcon -H 127.0.0.1 -P 25576 'save-all'
mcrcon -H 127.0.0.1 -P 25576 'list'
unset MCRCON_PASS
```

If `mcrcon` is missing, use an available local RCON client or install it if needed
(`sudo apt install mcrcon`). Pass the password only via the `MCRCON_PASS` environment variable (never `-p`,
which exposes it in `ps` and shell history), and never paste it into a chat message.

Common RCON commands before any maintenance that touches world files on disk:
```
save-off      # stop autosave so files are quiescent
save-all      # flush current state to disk
stop          # graceful shutdown (same effect as systemctl stop)
```

## Deploying file changes (mods, configs, jar updates)

1. `save-all` via RCON (or just `systemctl stop` — the unit's SIGINT handling is graceful).
2. `systemctl stop gtnh-server` and confirm with `systemctl status` that it's fully down.
3. Make the change under `/home/bro/gtnh-server/` (mods in `mods/`, configs in `config/`,
   server.properties at the root). Back up anything you're overwriting first — copy to
   `backups/manual-<desc>-<date>/` alongside the existing auto-generated backup folders,
   don't overwrite the auto-repair ones.
4. Leave GTNH stopped unless the user asks to start it during Claude/Codex work.
5. After an authorized `systemctl start gtnh-server`, use `journalctl -u gtnh-server -f`
   until you see the world finish loading and no mod-loading
   errors, then Ctrl-C.

## Backups already in place

`/home/bro/gtnh-server/backups/` contains:
- Full world zips (20GB+, e.g. `2026-09-20-10-13-51.zip`) from an existing scheduled backup
- `auto-region-repair-*` — automated corrupted-region-fix output (same pattern as the local
  Windows server's supervisor, described in the gtnh repo's `README.md`)
- `crash-recovery-*`, `gameplay-chunkloader-cap-*`, `gameplay-entity-ticking-*` — other
  automated maintenance snapshots

Don't delete or "clean up" these without explicit confirmation — they're the safety net for
a live world.

## Adding a web map (open question as of 2026-09-20)

No web-viewable map is currently installed. What's present:
- `JourneyMapServer1.0.5_MC1.7.10.jar` — only syncs waypoints/world-ID for the JourneyMap
  *client* mod; does not serve a web map on its own.
- `Opis-1.4.6-mapless.jar` — the **mapless** build (GTNH ships this deliberately with the
  map feature stripped, likely for performance at this world's pregen scale); has a web
  dashboard for TPS/profiling but no map.

For an actual browser-viewable interactive map on 1.7.10/Forge, the standard option is
**Dynmap** (`Dynmap-Forge-1.7.10-*.jar`, drop into `mods/`, opens its own HTTP port —
default 8123 — with a Leaflet-based web viewer). Confirm with the user before installing:
it does a full initial world scan which can be heavy given this is a large pregenerated
world, and it needs a firewall rule if they want to view it from outside the LAN.
