#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running, so swapping the file mid-run is safe.
# luna-watch.sh — stall watcher for luna.sh / luna-pool jobs, meant to run under Claude's Monitor tool.
#
# Usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md|pattern> [<out.md|pattern> ...]
#   -i idle_s  report a job whose log has not grown for this long (default $LUNA_WATCH_IDLE_S or 300)
#   -p poll_s  poll interval (default 15)
#   Patterns are re-expanded each poll and track matching .md files, including files created later.
#
# Prints ONE line per event (each line = one Monitor notification):
#   STALL  <out> idle=<s>s elapsed=<min>m last_note=...   (once per stall episode; again only after the log moves)
#   RESUMED <out> after <s>s idle
#   END    <out> state=<done|failed|incomplete|stalled|unavailable> rc=<rc>
#   END    <out|pattern> state=missing rc= <reason>  (status removed or never created, or no pattern match)
#   GONE   <out> state=running but pid <pid> is dead (wrapper killed without updating status)
#   EXPIRED watcher after <min>m; re-arm if jobs still run
# Exits when all jobs end, the owner is gone, or the maximum lifetime expires.
# LUNA_WATCH_MISSING_S=600, LUNA_WATCH_REMOVED_S=30: grace periods for new and removed status files.
# LUNA_WATCH_MAX_S=14400: maximum lifetime in seconds (0 disables).
# LUNA_WATCH_PARENT_CHECK=0 disables owner checks; LUNA_WATCH_PARENT_EVERY_S=60 sets their interval.

set -u
PARENT_PID=$PPID
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-runtime.sh"
IDLE_S="${LUNA_WATCH_IDLE_S:-300}"; POLL_S=15
while getopts "i:p:" opt; do
  case "$opt" in i) IDLE_S="$OPTARG" ;; p) POLL_S="$OPTARG" ;; *) exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md> [...]" >&2; exit 2; }

declare -A size stalled since_move done_
declare -A tracked seen_status missing_since pattern_seen pattern_done
declare -a jobs=() patterns=()
nonnegative() {
  local name="$1" value="${!1}"
  case "$value" in ''|*[!0-9]*) value="$2" ;; esac
  value="${value#"${value%%[!0]*}"}"; value="${value:-0}"
  [ ${#value} -le 18 ] || value=999999999999999999
  printf -v "$name" '%s' "$value"
}
MISSING_S="${LUNA_WATCH_MISSING_S:-600}"; nonnegative MISSING_S 600
REMOVED_S="${LUNA_WATCH_REMOVED_S:-30}"; nonnegative REMOVED_S 30
MAX_S="${LUNA_WATCH_MAX_S:-14400}"; nonnegative MAX_S 14400
PARENT_CHECK="${LUNA_WATCH_PARENT_CHECK:-1}"; nonnegative PARENT_CHECK 1
PARENT_EVERY_S="${LUNA_WATCH_PARENT_EVERY_S:-60}"; nonnegative PARENT_EVERY_S 60
now_s() { date +%s; }
WATCH_START=$(now_s); parent_at=$WATCH_START; PARENT_START=""
if [ "$PARENT_CHECK" != 0 ] && [ "$PARENT_PID" != 1 ]; then
  PARENT_START=$(luna_pid_start "$PARENT_PID" 2>/dev/null) || PARENT_START=""
fi
BOOT_EPOCH="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000-require("os").uptime())))' \
  2>/dev/null)" || BOOT_EPOCH=0
add_job() {
  local path="$1"
  [ -n "$path" ] || return
  [ -z "${tracked[$path]:-}" ] || return
  tracked[$path]=1; jobs+=("$path")
}
for arg in "$@"; do
  case "$arg" in *'*'*|*'?'*|*'['*) patterns+=("$arg") ;; *) add_job "$arg" ;; esac
done
expand_pattern() {
  local pattern="$1" out restore_nullglob=0 IFS=
  local -a matches=()
  shopt -q nullglob || restore_nullglob=1
  shopt -s nullglob
  matches=( $pattern )
  [ "$restore_nullglob" = 0 ] || shopt -u nullglob
  for out in "${matches[@]}"; do
    case "$out" in *.md) pattern_seen[$pattern]=1; add_job "$out" ;; esac
  done
}
check_guards() {
  local t actual proc_stat proc_state
  t=$(now_s)
  if [ "$PARENT_CHECK" != 0 ] && [ "$PARENT_PID" != 1 ] &&
      [ $(( t - parent_at )) -ge "$PARENT_EVERY_S" ]; then
    parent_at=$t
    kill -0 "$PARENT_PID" 2>/dev/null || exit 0
    if [ -r "/proc/$PARENT_PID/stat" ]; then
      IFS= read -r proc_stat 2>/dev/null < "/proc/$PARENT_PID/stat" || proc_stat=""
      proc_state=${proc_stat##*) }
      [ "${proc_state%% *}" != Z ] || exit 0
    fi
    if [ -n "$PARENT_START" ]; then
      actual=$(luna_pid_start "$PARENT_PID" 2>/dev/null) || actual=""
      [ -z "$actual" ] || [ "$actual" = "$PARENT_START" ] || exit 0
    fi
  fi
  if [ "$MAX_S" -gt 0 ] && [ $(( t - WATCH_START )) -ge "$MAX_S" ]; then
    echo "EXPIRED watcher after $(( (t - WATCH_START) / 60 ))m; re-arm if jobs still run"
    exit 0
  fi
}
sleep_poll() {
  local whole fraction chunk t until_guard
  if [[ ! "$POLL_S" =~ ^([0-9]+)(\.[0-9]+)?$ ]]; then sleep "$POLL_S"; return; fi
  whole="${BASH_REMATCH[1]}"; fraction="${BASH_REMATCH[2]:-}"; nonnegative whole 0
  while [ "$whole" -gt 0 ]; do
    chunk=$whole; t=$(now_s)
    if [ "$PARENT_CHECK" != 0 ] && [ "$PARENT_PID" != 1 ]; then
      until_guard=$(( PARENT_EVERY_S - (t - parent_at) ))
      [ "$until_guard" -gt 0 ] || until_guard=1
      [ "$chunk" -le "$until_guard" ] || chunk=$until_guard
    fi
    if [ "$MAX_S" -gt 0 ]; then
      until_guard=$(( MAX_S - (t - WATCH_START) ))
      [ "$until_guard" -gt 0 ] || until_guard=1
      [ "$chunk" -le "$until_guard" ] || chunk=$until_guard
    fi
    sleep "$chunk"; whole=$(( whole - chunk )); check_guards
  done
  [ -z "$fraction" ] || sleep "0$fraction"
}
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
  check_guards
  pending=0
  t=$(now_s)
  for pattern in "${patterns[@]}"; do
    [ -z "${pattern_done[$pattern]:-}" ] || continue
    expand_pattern "$pattern"
    if [ -z "${pattern_seen[$pattern]:-}" ]; then
      if [ $(( t - WATCH_START )) -ge "$MISSING_S" ]; then
        echo "END $pattern state=missing rc= no file matched"
        pattern_done[$pattern]=1
      else
        pending=1
      fi
    fi
  done
  for out in "${jobs[@]}"; do
    [ -n "${done_[$out]:-}" ] && continue
    st="$out.status"; log="$out.log"
    if [ ! -e "$st" ]; then
      t=$(now_s); missing_since[$out]="${missing_since[$out]:-$t}"
      if [ -n "${seen_status[$out]:-}" ]; then
        missing_limit=$REMOVED_S; missing_reason='job files removed'
      else
        missing_limit=$MISSING_S; missing_reason='no status file'
      fi
      if [ $(( t - ${missing_since[$out]} )) -ge "$missing_limit" ]; then
        echo "END $out state=missing rc= $missing_reason"
        done_[$out]=1
      else
        pending=1
      fi
      continue
    fi
    seen_status[$out]=1; missing_since[$out]=""
    state="$(field state "$st")"
    case "$state" in
      done|failed|incomplete|stalled|unavailable)
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
        done|failed|incomplete|stalled|unavailable)
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
  sleep_poll
done

exit $?
}
