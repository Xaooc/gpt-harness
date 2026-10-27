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
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-win-runtime.sh"
IDLE_S="${LUNA_WATCH_IDLE_S:-300}"; POLL_S=15
while getopts "i:p:" opt; do
  case "$opt" in i) IDLE_S="$OPTARG" ;; p) POLL_S="$OPTARG" ;; *) exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "usage: luna-watch.sh [-i idle_s] [-p poll_s] <out.md> [...]" >&2; exit 2; }

declare -A size stalled since_move done_ identity_at identity_key identity_bad
BOOT_EPOCH="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000-require("os").uptime())))' \
  2>/dev/null)" || BOOT_EPOCH=0
now_s() { date +%s; }
# luna.sh records an MSYS pid, luna-pool.mjs a Windows pid: alive if either view knows it.
pid_alive() {
  local pid="$1" expected="$2" mode="$3" out="$4" now actual key
  luna_pid_alive "$pid" msys || luna_pid_alive "$pid" || return 1
  [ -n "$expected" ] || return 0
  now=$(now_s); key="$pid:$expected:$mode"
  if [ "${identity_key[$out]:-}" != "$key" ] || [ $(( now - ${identity_at[$out]:-0} )) -ge 60 ]; then
    actual=$(luna_pid_start "$pid" "$mode")
    identity_at[$out]=$now; identity_key[$out]="$key"; identity_bad[$out]=0
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then identity_bad[$out]=1; fi
  fi
  [ "${identity_key[$out]:-}" != "$key" ] || [ "${identity_bad[$out]:-0}" != 1 ]
}
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }
daemon_job_pid() {
  local out="$1" profile="$2" job="$3" directory
  directory=$(luna_daemon_home "$profile") || return 1
  if command -v cygpath >/dev/null 2>&1; then
    directory=$(cygpath -m "$directory"); out=$(cygpath -m "$out")
  fi
  node -e '
    try {
      const fs = require("fs"), d = JSON.parse(fs.readFileSync(`${process.argv[1]}/daemon.json`, "utf8"));
      const marker = fs.readFileSync(`${process.argv[2]}.daemon`, "utf8");
      const get = (key) => marker.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
      if (get("id") === process.argv[3] && Number(get("daemon_pid")) === d.pid &&
          (!get("daemon_start") || get("daemon_start") === d.pid_start)) {
        process.stdout.write(`${d.pid}\n`);
      }
    } catch {}
  ' "$directory" "$out" "$job" 2>/dev/null
}
daemon_replaced() {
  local out="$1" profile="$2" job="$3" directory
  directory=$(luna_daemon_home "$profile") || return 1
  if command -v cygpath >/dev/null 2>&1; then
    directory=$(cygpath -m "$directory"); out=$(cygpath -m "$out")
  fi
  node -e '
    const fs = require("fs");
    try {
      const marker = fs.readFileSync(`${process.argv[2]}.daemon`, "utf8");
      const get = (key) => marker.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || "";
      const id = get("id"), pid = Number(get("daemon_pid")), start = get("daemon_start");
      if (!/^[a-f0-9]{32}$/.test(id) || (process.argv[3] && id !== process.argv[3]) ||
          !Number.isSafeInteger(pid) || pid < 1 || !start) process.exit(1);
      let discovery;
      try { discovery = JSON.parse(fs.readFileSync(`${process.argv[1]}/daemon.json`, "utf8")); } catch {}
      process.exit(discovery?.pid === pid && discovery?.pid_start === start ? 1 : 0);
    } catch { process.exit(1); }
  ' "$directory" "$out" "$job" 2>/dev/null
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
    pid_mode=""
    engine=$(field engine "$st")
    if [ "$engine" = exec ]; then
      pid_mode=msys
    elif [ "$engine" = daemon ] && [ -z "$pid" ]; then
      pid=$(daemon_job_pid "$out" "$(field daemon_profile "$st")" "$(field daemon_job "$st")")
      pid_start=$(field daemon_start "$out.daemon")
    fi
    gone_reason=""
    if [ "$state" = running ]; then
      started="$(field started "$st")"; started_epoch=""
      if [ -n "$started" ]; then started_epoch="$(date -d "$started" +%s 2>/dev/null)" || started_epoch=""; fi
      if [ "$BOOT_EPOCH" -gt 0 ] && [ -n "$started_epoch" ] && [ "$started_epoch" -lt "$BOOT_EPOCH" ]; then
        gone_reason="started before last boot"
      elif [ "$engine" = daemon ] && [ -n "$(field wrapper_pid "$st")" ] &&
          ! pid_alive "$(field wrapper_pid "$st")" "$(field wrapper_start "$st")" msys "$out:wrapper" &&
          daemon_replaced "$out" "$(field daemon_profile "$st")" "$(field daemon_job "$st")"; then
        gone_reason="daemon discovery changed and wrapper is gone"
      elif [ -n "$pid" ] && ! pid_alive "$pid" "$pid_start" "$pid_mode" "$out"; then
        gone_reason="pid $pid is dead"
      fi
    fi
    if [ -n "$gone_reason" ]; then
      # The wrapper writes its final status just after the child exits: give it a moment before calling it GONE.
      sleep 3; state="$(field state "$st")"
      [ "$state" = running ] || continue
      if [ "$gone_reason" = 'daemon discovery changed and wrapper is gone' ]; then
        if pid_alive "$(field wrapper_pid "$st")" "$(field wrapper_start "$st")" msys "$out:wrapper" ||
            ! daemon_replaced "$out" "$(field daemon_profile "$st")" "$(field daemon_job "$st")"; then
          continue
        fi
      fi
      echo "GONE $out state=running but $gone_reason"
      done_[$out]=1; continue
    fi
    [ "$state" = running ] || continue          # starting / waiting-ram: not a stall
    if [ "$(field retry_waiting "$st")" = 1 ]; then
      t=$(now_s)
      if [ -n "${stalled[$out]:-}" ]; then echo "RESUMED $out after $(( t - ${since_move[$out]} ))s idle"; fi
      since_move[$out]=$t; stalled[$out]=""
      continue
    fi
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
