# Server access

## Local administration

Claude runs on bro-server as `bro`; no SSH or key is needed. Run commands directly:

```bash
hostname
systemctl status gtnh-server --no-pager
journalctl -u gtnh-server -n 200 --no-pager
journalctl -u gtnh-server -f
df -h /home
```

Use RCON first for in-game commands (see `deploy.md`). The password stays in
`references/credentials.local.md`; never print it. Preserve the live world and all backups.
Stop the service cleanly before changing world files. `bro` has passwordless sudo;
use it only for operations requiring root, such as unit edits under `/etc/systemd/system/`
or service control when systemd requires authorization.

## Troubleshooting

- Inspect `journalctl -u gtnh-server` before changing the service or its files.
- Check `/proc/meminfo` (`MemAvailable`), disk space and backups before heavy maintenance.
  GTNH (`gtnh-server.service`) and Claude/Codex work are never run at the same time on this box,
  so the full machine is available to Claude; do not start GTNH while Claude work is running unless the user asks.
- For NucBox use `personal-server-connect`. LAN IPs drift with DHCP: compare the recorded
  SSH host key in `~/.ssh/known_hosts` before connecting to any newly discovered address.
  A changed host key needs confirmation of a reinstall; never silently accept it.

## RDP / desktop

`xrdp` + `xorgxrdp` (since 2026-10-24) listen on port `3389`, LAN-only
(`192.168.1.0/24`). The session is XFCE via `~/.xsession` (`exec startxfce4`).
`/etc/polkit-1/rules.d/45-xrdp-colord.rules` suppresses colord password prompts.
Login is `bro` with the user's password (never handled by Claude).

The NVIDIA driver causes xorgxrdp to abort in `libglx.so`; GLX is disabled with
`Disable "glx"` in `/etc/X11/xrdp/xorg.conf` (backup `xorg.conf.bak-glx`).
OpenGL apps will not run inside RDP. Log out of the local GDM session before RDP login
with the same user. Claude Desktop is installed from Anthropic's apt repository.

### RDP clipboard stops (text and screenshots from the PC never arrive)

Windows mstsc sometimes silently stops sending clipboard updates in a long session. Check before touching the
bridge: `DISPLAY=:10 xclip -selection clipboard -t TARGETS -o` does not change after a copy on the PC, and
`~/.local/share/xrdp/xrdp-chansrv.<display>.log` shows no new lines while `xrdp-chansrv` sleeps in poll.
Fix: the user closes the RDP window with the X (not Log Out) and reopens `Bro-server.rdp`; the session and its
apps survive. Screenshots then arrive as `image/bmp` and `/usr/local/bin/rdp-clip-png` (XFCE autostart) offers PNG.

### Only the first PC screenshot pastes (clipboard managers wedge xrdp-chansrv)

Root cause found 2026-10-25: a clipboard manager re-owning CLIPBOARD after every copy (the xfsettingsd built-in
manager, diodon from the LXDE task) makes xrdp-chansrv start a server-to-client INCR that never finishes; while that
flag is set chansrv ignores every new PC copy ("don't interrupt incr" in sesman/chansrv/clipboard.c), so the first image
stays forever. Fix in place: `export XFSETTINGSD_NO_CLIPBOARD=1` in `~/.xsession`, user autostart overrides with
`Hidden=true` for `diodon-autostart` and `xfce4-clipman-plugin-autostart`. Never re-enable a clipboard manager in the
RDP session. Check: `pgrep -x diodon` is empty, and after a PC copy the CLIPBOARD owner is xrdp-chansrv or rdp-clip-png
(which also serves the original image/bmp so chansrv stays on its normal path).
