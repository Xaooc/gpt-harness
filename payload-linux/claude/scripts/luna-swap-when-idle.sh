#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running.
# luna-swap-when-idle.sh — replace live wrapper scripts with their .next versions once no Luna job is running.
# Usage: luna-swap-when-idle.sh <next-file> <live-file> [<next-file> <live-file> ...]
# A running bash script breaks if its file is replaced (bash reads scripts incrementally), so luna.sh & co. may only
# be swapped while no job runs. Jobs started before the last OS boot are ghosts and do not count. Gives up after 48 h.
# Log: ~/.claude/luna-run/swap.log
set -u
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-runtime.sh"
LOG="$HOME/.claude/luna-run/swap.log"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
BOOT=$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000-require("os").uptime())))' 2>/dev/null || echo 0)

busy() {
  local f o w s ws
  for f in "$HOME"/.claude/luna-run/active/*; do
    [ -f "$f" ] || continue
    o=$(sed -n 1p "$f" | tr -d '\r'); w=$(sed -n 2p "$f" | tr -d '\r')
    s=$(grep -m1 '^started=' "$o.status" 2>/dev/null | cut -d= -f2-)
    if [ -n "$s" ] && [ "$(date -d "$s" +%s 2>/dev/null || echo 0)" -lt "$BOOT" ]; then continue; fi
    ws=$(sed -n 3p "$f")
    luna_owned_pid "$w" "$ws" && return 0
  done
  return 1
}

[ $(( $# % 2 )) -eq 0 ] && [ $# -gt 0 ] || { echo "usage: $0 <next> <live> [...]" >&2; exit 2; }
for a in "$@"; do :; done
log "waiting to swap: $*"
deadline=$(( $(date +%s) + 48*3600 ))
while :; do
  if ! busy; then
    sleep 2
    if ! busy; then break; fi
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { log "gave up after 48 h: $*"; exit 1; }
  sleep 20
done
args=("$@")
for ((i = 0; i < ${#args[@]}; i += 2)); do
  next=${args[i]}; live=${args[i+1]}
  if bash -n "$next" 2>>"$LOG"; then mv -f "$next" "$live" && log "swapped $next -> $live"; else log "syntax error, NOT swapped: $next"; fi
done
exit 0
}
