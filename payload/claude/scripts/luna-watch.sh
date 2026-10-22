#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running, so swapping the file mid-run is safe.
# luna-watch.sh — stall watcher for luna.sh / luna-pool jobs, meant to run under Claude's Monitor tool.
#
# Usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md> [<out.md> ...]
#   -i idle_s  report a job whose log has not grown for this long (default $LUNA_WATCH_IDLE_S or 300)
#   -p poll_s  poll interval (default 15)
#
# Prints ONE line per event (each line = one Monitor notification):
#   STALL  <out> idle=<s>s elapsed=<min>m last_note=...   (once per stall episode; again only after the log moves)
#   RESUMED <out> after <s>s idle
#   END    <out> state=<done|failed|incomplete|stalled> rc=<rc>
#   GONE   <out> state=running but pid <pid> is dead (wrapper killed without updating status)
# Exits when every job has reached a terminal state.

set -u
IDLE_S="${LUNA_WATCH_IDLE_S:-300}"; POLL_S=15
while getopts "i:p:" opt; do
  case "$opt" in i) IDLE_S="$OPTARG" ;; p) POLL_S="$OPTARG" ;; *) exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md> [...]" >&2; exit 2; }

declare -A size stalled since_move done_
BOOT_EPOCH="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000-require("os").uptime())))' 2>/dev/null)" || BOOT_EPOCH=0
now_s() { date +%s; }
# luna.sh records an MSYS pid, luna-pool.mjs a Windows pid: alive if either view knows it.
pid_alive() {
  kill -0 "$1" 2>/dev/null && return 0
  command -v tasklist >/dev/null 2>&1 || return 1
  tasklist //FI "PID eq $1" //NH 2>/dev/null | grep -qE "(^|[[:space:]])$1([[:space:]]|$)"
}
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }

while :; do
  pending=0
  for out in "$@"; do
    [ -n "${done_[$out]:-}" ] && continue
    st="$out.status"; log="$out.log"
    state="$(field state "$st")"
    case "$state" in
      done|failed|incomplete|stalled)
        echo "END $out state=$state rc=$(field rc "$st") $(field error "$st")"
        done_[$out]=1; continue ;;
    esac
    pending=1
    pid="$(field pid "$st")"
    gone_reason=""
    if [ "$state" = running ]; then
      started="$(field started "$st")"; started_epoch=""
      if [ -n "$started" ]; then started_epoch="$(date -d "$started" +%s 2>/dev/null)" || started_epoch=""; fi
      if [ "$BOOT_EPOCH" -gt 0 ] && [ -n "$started_epoch" ] && [ "$started_epoch" -lt "$BOOT_EPOCH" ]; then
        gone_reason="started before last boot"
      elif [ -n "$pid" ] && ! pid_alive "$pid"; then
        gone_reason="pid $pid is dead"
      fi
    fi
    if [ -n "$gone_reason" ]; then
      # The wrapper writes its final status just after the child exits: give it a moment before calling it GONE.
      sleep 3; state="$(field state "$st")"
      [ "$state" = running ] || continue
      echo "GONE $out state=running but $gone_reason"
      done_[$out]=1; continue
    fi
    [ "$state" = running ] || continue          # starting / waiting-ram: not a stall
    cur=$(stat -c %s "$log" 2>/dev/null || echo 0); t=$(now_s)
    if [ "$cur" != "${size[$out]:-}" ]; then
      if [ -n "${stalled[$out]:-}" ]; then echo "RESUMED $out after $(( t - ${since_move[$out]} ))s idle"; fi
      size[$out]=$cur; since_move[$out]=$t; stalled[$out]=""
    elif [ -z "${stalled[$out]:-}" ] && [ $(( t - ${since_move[$out]:-$t} )) -ge "$IDLE_S" ]; then
      note="$(tail -c 400 "$log" 2>/dev/null | tr '\r\n' '  ' | tail -c 160)"
      echo "STALL $out idle=$(( t - ${since_move[$out]} ))s last_log=...$note"
      stalled[$out]=1
    fi
  done
  [ "$pending" = 1 ] || exit 0
  sleep "$POLL_S"
done

exit $?
}
