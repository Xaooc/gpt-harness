#!/usr/bin/env bash
# luna-overview.sh — one-screen status of the Luna/Codex job system on this machine.
# Usage: bash ~/.claude/scripts/luna-overview.sh            (add -w to refresh every 5 s, Ctrl-C to quit)
set -u
script="$(dirname -- "${BASH_SOURCE[0]}")/luna-overview.mjs"
if [ "${1:-}" = "-w" ]; then
  while :; do
    clear
    node "$script" --human
    sleep 5
  done
fi
exec node "$script" --human
