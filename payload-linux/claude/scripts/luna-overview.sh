#!/usr/bin/env bash
# luna-overview.sh — one-screen status of the Luna/Codex job system on this machine.
# Usage: bash ~/.claude/scripts/luna-overview.sh            (add -w to refresh every 5 s, Ctrl-C to quit)
set -u
show() {
  echo "=== $(date '+%H:%M:%S')  Luna overview"
  awk '/^MemAvailable:/{a=$2} /^MemTotal:/{t=$2}
    END{printf "RAM free %.1f GB of %.1f GB\n", a/1048576, t/1048576}' /proc/meminfo
  ps -eo comm=,rss= | awk '$1 ~ /^(codex|rustc|cargo|bash|node)$/ {n[$1]++; m[$1]+=$2}
    END{for (p in n) printf "%s x%d = %.0f MB\n", p, n[p], m[p]/1024}'
  echo "--- Daemons"
  daemon_base="${LUNA_DAEMON_HOME:-$HOME/.claude/luna-run}"
  for profile in default net; do
    daemon_home="$daemon_base"
    [ "$profile" != net ] || daemon_home="$daemon_base/daemon-net"
    if [ -f "$daemon_home/daemon.json" ]; then
      echo "$profile:"
      node "$HOME/.claude/scripts/luna-daemon.mjs" --status --profile "$profile" 2>/dev/null |
        awk -F'\t' 'NR==1{print; next} $2!="completed" && $2!="cancelled" {print}' | cut -c1-160
    else
      echo "$profile: not running (starts on the first job)"
    fi
  done
  echo "--- Running/queued jobs (status files changed in the last 2 h)"
  find "$HOME/.claude" /tmp "${TMPDIR:-/tmp}" -maxdepth 6 -name '*.status' -mmin -120 2>/dev/null | sort -u | while read -r s; do
    st=$(sed -n 's/^state=//p' "$s" | head -1)
    case "$st" in
      running|queued|waiting-*|starting)
        printf '%-14s %-10s %s\n' "$st" "$(sed -n 's/^model=//p' "$s" | head -1)" "${s%.status}" ;;
    esac
  done

}
if [ "${1:-}" = "-w" ]; then while :; do clear; show; sleep 5; done; else show; fi
exit 0
