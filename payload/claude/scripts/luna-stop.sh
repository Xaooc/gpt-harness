#!/usr/bin/env bash
# luna-stop.sh — stop Luna/Sol jobs for real.
#
# Stopping the Claude Bash task that launched a job does NOT stop the job: the wrapper (luna.sh) keeps running
# and so does its Codex turn. Use this instead.
#
# Usage: luna-stop.sh <out.md> [<out.md> ...]
#   Sends TERM to the wrapper (its trap cancels the daemon turn or kills the codex tree and writes
#   state=failed rc=130 error=interrupted). If the wrapper is still alive after 5 s, its process tree is
#   force-killed, its daemon job is cancelled, and the status is set to failed with error=force-stopped.
#   If the wrapper is gone, cancels its orphaned daemon job using <out>.daemon and daemon discovery.
# Needs the wrapper_pid= status key (luna.sh with daemon support). Jobs that already finished are left alone.

set -u
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-win-runtime.sh"
[ $# -ge 1 ] || { echo "usage: luna-stop.sh <out.md> [...]" >&2; exit 2; }
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }
cancel_daemon_job() {
  local out="$1" id port token discovery profile
  CANCELLED_DAEMON_JOB=""
  id=$(field id "$out.daemon")
  [[ "$id" =~ ^[a-f0-9]{32}$ ]] || return 1
  profile=$(field daemon_profile "$out.status")
  discovery="$(luna_daemon_home "$profile")/daemon.json" || return 1
  if command -v cygpath >/dev/null 2>&1; then discovery=$(cygpath -m "$discovery"); fi
  read -r port token < <(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !/^[a-f0-9]{32}$/.test(d.token)) {
        process.exit(1);
      }
      process.stdout.write(`${d.port} ${d.token}\n`);
    } catch { process.exit(1); }
  ' "$discovery" 2>/dev/null)
  [ -n "$port" ] && [ -n "$token" ] || return 1
  luna_daemon_curl "$token" --noproxy '*' -fs --max-time 5 -X POST \
    "http://127.0.0.1:$port/jobs/$id/cancel" >/dev/null 2>&1 || return 1
  CANCELLED_DAEMON_JOB=$id
}
wrapper_present() {
  local diagnostic
  luna_pid_alive "$1" msys && return 0
  [ -r "/proc/$1/winpid" ] && return 0
  diagnostic=$(LC_ALL=C kill -0 "$1" 2>&1) && return 0
  case "$diagnostic" in *'No such process'*|*'no such process'*) return 1 ;; *) return 0 ;; esac
}
verify_wrapper() {
  local pid="$1" expected="$2" command="$3" actual
  luna_pid_alive "$pid" msys || return 1
  if [ -n "$expected" ]; then
    actual=$(luna_pid_start "$pid" msys)
    if [ -n "$actual" ]; then [ "$actual" = "$expected" ]; return $?; fi
  fi
  luna_verify_wrapper "$pid" "$command" && return 0
  sleep 1
  luna_verify_wrapper "$pid" "$command"
}
stop_verified_child() {
  local pid="$1" expected="$2" winpid
  [ -n "$pid" ] && [ -n "$expected" ] || return 1
  luna_owned_pid "$pid" "$expected" msys || return 1
  winpid=$(luna_win_pid "$pid" msys) || return 1
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$winpid" //T //F >/dev/null 2>&1
  else
    kill -TERM "$pid" 2>/dev/null
  fi
}
stop_exec_child() {
  local st="$1" start
  [ "$(field engine "$st")" = exec ] || return 1
  start=$(field child_start "$st")
  [ -n "$start" ] || start=$(field pid_start "$st")
  stop_verified_child "$(field pid "$st")" "$start"
}
rc_all=0
for out in "$@"; do
  st="$out.status"
  state="$(field state "$st")"
  conflict_error="$(field error "$st")"
  if [ "${state%$'\r'}" = failed ] &&
      [ "${conflict_error%$'\r'}" = 'output or log already in use by another daemon job' ]; then
    marker_state="$(field state "$out.daemon")"
    case "${marker_state%$'\r'}" in
      queued|running)
        if cancel_daemon_job "$out"; then
          echo "$out: cancelled live daemon job $CANCELLED_DAEMON_JOB after output conflict"
        else
          echo "$out: could not cancel live daemon job after output conflict" >&2
          [ "$rc_all" = 3 ] || rc_all=1
        fi
        continue ;;
    esac
  fi
  case "$state" in
    done|failed|incomplete|stalled|'') echo "$out: nothing to stop (state=${state:-missing})"; continue ;;
  esac
  if [ "$(field engine "$st")" = pool ]; then
    echo "$out: pool jobs must be stopped through their pool owner" >&2
    [ "$rc_all" = 3 ] || rc_all=1; continue
  fi
  wp="$(field wrapper_pid "$st")"
  ws="$(field wrapper_start "$st")"
  wrapper_command="$(field wrapper_command "$st")"
  if [ -n "$wp" ] && ! wrapper_present "$wp"; then
    if stop_exec_child "$st"; then
      echo "$out: wrapper gone; stopped verified Codex child"
      continue
    fi
    if [ -f "$out.daemon" ] && cancel_daemon_job "$out"; then
      echo "$out: wrapper gone; cancelled daemon job $CANCELLED_DAEMON_JOB"
      continue
    fi
    echo "$out: wrapper pid '${wp:-?}' not alive; state=$state (use luna-status.sh / luna-daemon.mjs --status)" >&2
    [ "$rc_all" = 3 ] || rc_all=1; continue
  fi
  if [ -z "$wp" ] || ! verify_wrapper "$wp" "$ws" "$wrapper_command"; then
    if stop_exec_child "$st"; then
      echo "$out: stopped verified Codex child; wrapper $wp could not be verified"
      continue
    fi
    echo "luna-stop: cannot verify wrapper ${wp:-?}; not stopped" >&2
    rc_all=3; continue
  fi
  winpid="$(cat "/proc/$wp/winpid" 2>/dev/null || true)"
  kill -TERM "$wp" 2>/dev/null
  for _ in $(seq 1 5); do wrapper_present "$wp" || break; sleep 1; done
  if wrapper_present "$wp"; then
    if ! verify_wrapper "$wp" "$ws" "$wrapper_command"; then
      echo "luna-stop: cannot verify wrapper $wp; not stopped" >&2
      rc_all=3; continue
    fi
    if [ -n "$winpid" ]; then taskkill //PID "$winpid" //T //F >/dev/null 2>&1; else kill -KILL "$wp" 2>/dev/null; fi
    if [ -f "$out.daemon" ] && ! cancel_daemon_job "$out"; then
      echo "$out: WARNING: could not cancel the daemon job; it may keep running until the orphan grace ends" >&2
      [ "$rc_all" = 3 ] || rc_all=1
    fi
    { printf 'state=failed\nrc=130\nerror=force-stopped\nfinished=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
      grep -v -E '^(state|rc|error|finished)=' "$st"; } > "$st.tmp" && mv -f "$st.tmp" "$st"
    echo "$out: force-stopped (wrapper ignored TERM)"
  else
    echo "$out: stopped ($(field state "$st") rc=$(field rc "$st"))"
  fi
done
exit $rc_all
