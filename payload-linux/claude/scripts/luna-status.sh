#!/usr/bin/env bash
# luna-status.sh — one-glance status of a luna.sh job.
#
# Usage: luna-status.sh <out.md> [<out.md> ...]
# Prints the state from <out>.status, elapsed time, how long ago the log last
# moved, and Codex's latest progress note from <out>.log. Cheap and read-only:
# use it right after launching (expect state=running) and when the user asks
# "is it stuck?" instead of guessing.

set -u
[ $# -ge 1 ] || { echo "usage: luna-status.sh <out.md> [...]" >&2; exit 2; }

epoch() { date -d "$1" +%s 2>/dev/null || echo ""; }
for OUT in "$@"; do
  echo "== $OUT"
  if [ ! -f "$OUT.status" ]; then
    echo "state=unknown (no status file — launched by an old wrapper, or never started)"
  else
    cat "$OUT.status"
    started=$(sed -n 's/^started=//p' "$OUT.status")
    finished=$(sed -n 's/^finished=//p' "$OUT.status")
    s=$(epoch "$started"); e=$(epoch "${finished:-now}")
    [ -n "$s" ] && [ -n "$e" ] && echo "elapsed_min=$(( (e - s) / 60 ))"
    pid=$(sed -n 's/^pid=//p' "$OUT.status")
    state=$(sed -n 's/^state=//p' "$OUT.status")
    if [ "$state" = running ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "warning=status says running but pid $pid is gone (wrapper killed?)"
    fi
  fi
  if [ -f "$OUT.log" ]; then
    age=$(( $(date +%s) - $(date -r "$OUT.log" +%s) ))
    echo "log_bytes=$(wc -c < "$OUT.log") log_idle_s=$age"
    # Latest free-text progress note Codex wrote (block after the last "codex" line).
    note=$(tr -d '\r' < "$OUT.log" | awk '/^codex$/{buf=""; grab=1; next} /^(exec|collab:|tokens used|thinking)/{grab=0} grab{buf=buf $0 " "} END{print buf}' | cut -c1-400)
    [ -n "$note" ] && echo "last_note=$note"
  else
    echo "log=missing"
  fi
done
