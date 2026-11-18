#!/usr/bin/env bash
# Focused offline regressions for the Windows watcher; no installed scripts or daemons are used.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" != --case ]; then
  temp_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
  ROOT=$(mktemp -d)
  ROOT=$(cd "$ROOT" && pwd -P)
  case "$ROOT" in "$temp_parent"/*) ;; *) echo 'FAIL unsafe temporary directory'; exit 1 ;; esac
  export ROOT SCRIPT_DIR
  trap 'rm -rf -- "$ROOT"' EXIT
  failures=0
  for case_name in unmatched late_match removed expired parent_gone; do
    if timeout -k 5s 30s bash "$0" --case "$case_name"; then
      echo "PASS $case_name"
    else
      echo "FAIL $case_name"
      failures=$(( failures + 1 ))
    fi
  done
  [ "$failures" = 0 ]
  exit $?
fi

watch_pid=""
cleanup() {
  if [ -z "$watch_pid" ] && [ -n "${pid_file:-}" ] && [ -f "$pid_file" ]; then
    watch_pid=$(cat "$pid_file")
  fi
  [ -z "$watch_pid" ] || kill "$watch_pid" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 1' INT TERM
export LUNA_WATCH_MAX_S=0 LUNA_WATCH_PARENT_CHECK=0 LUNA_WATCH_IDLE_S=300
dir="$ROOT/jobs with spaces"
mkdir -p "$dir"
watcher="$SCRIPT_DIR/luna-watch.sh"
result="$ROOT/$2.result"

case "$2" in
  unmatched)
    pattern="$dir/*.out.md"
    LUNA_WATCH_PARENT_CHECK=0 LUNA_WATCH_MISSING_S=2 \
      bash "$watcher" -p 0.25 "$pattern" > "$result" 2>&1 || { cat "$result"; exit 1; }
    grep -Fx "END $pattern state=missing rc= no file matched" "$result" >/dev/null
    ;;
  late_match)
    out="$dir/a.out.md"
    LUNA_WATCH_PARENT_CHECK=0 LUNA_WATCH_MISSING_S=8 \
      bash "$watcher" -p 0.25 "$dir/*" "$dir/a*.md" > "$result" 2>&1 &
    watch_pid=$!
    sleep 1
    : > "$out"; : > "$out.log"
    printf 'state=running\nengine=exec\npid=%s\n' "$$" > "$out.status"
    sleep 2
    printf 'state=done\nrc=0\n' > "$out.status"
    wait "$watch_pid" || { cat "$result"; exit 1; }
    watch_pid=""
    grep -Fx "END $out state=done rc=0 " "$result" >/dev/null
    [ "$(wc -l < "$result")" -eq 1 ]
    ;;
  removed)
    out="$dir/removed.md"
    : > "$out.log"
    printf 'state=running\nengine=exec\npid=%s\n' "$$" > "$out.status"
    LUNA_WATCH_PARENT_CHECK=0 LUNA_WATCH_REMOVED_S=1 \
      bash "$watcher" -i 0 -p 0.25 "$out" > "$result" 2>&1 &
    watch_pid=$!
    until grep -q '^STALL ' "$result"; do sleep 0.25; done
    rm "$out.status"
    wait "$watch_pid" || { cat "$result"; exit 1; }
    watch_pid=""
    grep -Fx "END $out state=missing rc= job files removed" "$result" >/dev/null
    ;;
  expired)
    out="$dir/forever.md"
    : > "$out.log"
    printf 'state=running\nengine=exec\npid=%s\n' "$$" > "$out.status"
    LUNA_WATCH_PARENT_CHECK=0 LUNA_WATCH_MAX_S=2 \
      bash "$watcher" -p 0.25 "$out" > "$result" 2>&1 || { cat "$result"; exit 1; }
    grep -Fx 'EXPIRED watcher after 0m; re-arm if jobs still run' "$result" >/dev/null
    ;;
  parent_gone)
    out="$dir/parent.md"; pid_file="$ROOT/parent.pid"
    : > "$out.log"
    printf 'state=running\nengine=exec\npid=%s\n' "$$" > "$out.status"
    LUNA_WATCH_PARENT_CHECK=1 LUNA_WATCH_PARENT_EVERY_S=1 LUNA_WATCH_MAX_S=0 \
      bash -c '
        bash "$1" -i 0 -p 0.25 "$2" > "$3" 2>&1 &
        child=$!; printf "%s\n" "$child" > "$4"
        until grep -q "^STALL " "$3"; do kill -0 "$child" || exit 1; sleep 0.25; done
      ' _ "$watcher" "$out" "$result" "$pid_file"
    watch_pid=$(cat "$pid_file")
    for attempt in {1..40}; do
      if ! kill -0 "$watch_pid" 2>/dev/null; then watch_pid=""; rm "$pid_file"; break; fi
      sleep 0.25
    done
    [ -z "$watch_pid" ] || { cat "$result"; exit 1; }
    ;;
  *) exit 2 ;;
esac
