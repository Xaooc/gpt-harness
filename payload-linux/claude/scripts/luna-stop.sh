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
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-runtime.sh"
[ $# -ge 1 ] || { echo "usage: luna-stop.sh <out.md> [...]" >&2; exit 2; }
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }
cancel_daemon_job() {
  local out="$1" id port token discovery profile marker_profile
  CANCELLED_DAEMON_JOB=""
  id=$(field id "$out.daemon")
  [[ "$id" =~ ^[a-f0-9]{32}$ ]] || return 1
  profile=$(field daemon_profile "$out.status"); profile="${profile:-default}"
  marker_profile=$(field daemon_profile "$out.daemon"); marker_profile="${marker_profile:-default}"
  [ "$profile" = "$marker_profile" ] || return 1
  discovery="${LUNA_DAEMON_HOME:-$HOME/.claude/luna-run}"
  case "$profile" in default) ;; net) discovery="$discovery/daemon-net" ;; *) return 1 ;; esac
  discovery="$discovery/daemon.json"
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
rc_all=0
for out in "$@"; do
  st="$out.status"
  state="$(field state "$st")"
  case "$state" in
    done|failed|incomplete|stalled|'') echo "$out: nothing to stop (state=${state:-missing})"; continue ;;
  esac
  wp="$(field wrapper_pid "$st")"
  ws="$(field wrapper_start "$st")"
  if [ -z "$wp" ] || ! luna_owned_pid "$wp" "$ws"; then
    if [ -f "$out.daemon" ] && cancel_daemon_job "$out"; then
      echo "$out: wrapper gone; cancelled daemon job $CANCELLED_DAEMON_JOB"
      continue
    fi
    child_pid="$(field pid "$st")"
    if [ "$(field engine "$st")" != daemon ] && [ -n "$child_pid" ] &&
        luna_stop_group "$child_pid" "$(field pid_start "$st")" >/dev/null 2>&1; then
      { printf 'state=failed\nrc=130\nerror=force-stopped\nfinished=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
        grep -v -E '^(state|rc|error|finished)=' "$st"; } > "$st.tmp" && mv -f "$st.tmp" "$st"
      echo "$out: wrapper gone; stopped Codex group"
      continue
    fi
    echo "$out: wrapper pid '${wp:-?}' not alive; state=$state (use luna-status.sh / luna-daemon.mjs --status)" >&2
    rc_all=1; continue
  fi
  kill -TERM "$wp" 2>/dev/null
  for _ in $(seq 1 5); do luna_owned_pid "$wp" "$ws" || break; sleep 1; done
  if luna_owned_pid "$wp" "$ws"; then
    child_pid="$(field pid "$st")"
    if [ "$(field engine "$st")" != daemon ] && [ -n "$child_pid" ]; then
      luna_stop_group "$child_pid" "$(field pid_start "$st")" >/dev/null 2>&1 || true
    fi
    if luna_owned_pid "$wp" "$ws"; then kill -KILL "$wp" 2>/dev/null || true; fi
    if [ -f "$out.daemon" ] && ! cancel_daemon_job "$out"; then
      echo "$out: WARNING: could not cancel the daemon job; it may keep running until the orphan grace ends" >&2
      rc_all=1
    fi
    { printf 'state=failed\nrc=130\nerror=force-stopped\nfinished=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
      grep -v -E '^(state|rc|error|finished)=' "$st"; } > "$st.tmp" && mv -f "$st.tmp" "$st"
    echo "$out: force-stopped (wrapper ignored TERM)"
  else
    echo "$out: stopped ($(field state "$st") rc=$(field rc "$st"))"
  fi
done
exit $rc_all
