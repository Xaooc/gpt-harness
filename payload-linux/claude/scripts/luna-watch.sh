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
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-runtime.sh"
IDLE_S="${LUNA_WATCH_IDLE_S:-300}"; POLL_S=15
while getopts "i:p:" opt; do
  case "$opt" in i) IDLE_S="$OPTARG" ;; p) POLL_S="$OPTARG" ;; *) exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md> [...]" >&2; exit 2; }

declare -A size stalled since_move done_
BOOT_EPOCH="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000-require("os").uptime())))' 2>/dev/null)" || BOOT_EPOCH=0
now_s() { date +%s; }
pid_alive() { luna_owned_pid "$1" "$2"; }
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }
daemon_marker_alive() {
  local marker_pid marker_start marker_job marker_profile status_profile
  [ "$(field state "$out.daemon")" = running ] || return 1
  marker_pid="$(field daemon_pid "$out.daemon")"; marker_start="$(field daemon_start "$out.daemon")"
  marker_job="$(field id "$out.daemon")"
  marker_profile="$(field daemon_profile "$out.daemon")"; marker_profile="${marker_profile:-default}"
  status_profile="$(field daemon_profile "$st")"; status_profile="${status_profile:-default}"
  [ "$marker_profile" = "$status_profile" ] || return 1
  [ -n "$marker_pid" ] && [ -n "$marker_start" ] && [ -n "$marker_job" ] || return 1
  [ "$marker_pid" = "$(field pid "$st")" ] && [ "$marker_start" = "$(field pid_start "$st")" ] &&
    [ "$marker_job" = "$(field daemon_job "$st")" ] && pid_alive "$marker_pid" "$marker_start"
}

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
    pid_start="$(field pid_start "$st")"
    daemon_mode=0
    if [ "$(field engine "$st")" = daemon ]; then
      daemon_mode=1
      pid="$(field wrapper_pid "$st")"; pid_start="$(field wrapper_start "$st")"
    fi
    gone_reason=""
    if [ "$state" = running ]; then
      started="$(field started "$st")"; started_epoch=""
      if [ -n "$started" ]; then started_epoch="$(date -d "$started" +%s 2>/dev/null)" || started_epoch=""; fi
      if [ "$BOOT_EPOCH" -gt 0 ] && [ -n "$started_epoch" ] && [ "$started_epoch" -lt "$BOOT_EPOCH" ]; then
        gone_reason="started before last boot"
      elif [ -n "$pid" ] && ! pid_alive "$pid" "$pid_start"; then
        gone_reason="pid $pid is dead"
        if [ "$daemon_mode" = 1 ] && daemon_marker_alive; then gone_reason=""; fi
      fi
    fi
    if [ -n "$gone_reason" ]; then
      # The wrapper writes its final status just after the child exits: give it a moment before calling it GONE.
      sleep 3; state="$(field state "$st")"
      case "$state" in
        done|failed|incomplete|stalled)
          echo "END $out state=$state rc=$(field rc "$st") $(field error "$st")"
          done_[$out]=1; continue ;;
      esac
      [ "$state" = running ] || continue
      if [ "$daemon_mode" = 1 ] && [ "$gone_reason" != "started before last boot" ]; then
        pid="$(field wrapper_pid "$st")"; pid_start="$(field wrapper_start "$st")"
        if pid_alive "$pid" "$pid_start" || daemon_marker_alive; then continue; fi
      fi
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
