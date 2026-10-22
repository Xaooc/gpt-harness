#!/usr/bin/env bash
# learning-revert.sh — revert one adopted lesson by id (see ~/.claude/learning/adopted.md).
# Usage: learning-revert.sh <id> [reason…]   |   learning-revert.sh --list

set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))
node_bin=$(command -v node || true)
if [[ -z "$node_bin" ]]; then
  node_bin="C:/Program Files/nodejs/node.exe"
fi
if [[ $# -eq 0 ]]; then
  echo "Usage: learning-revert.sh <id> [reason…] | learning-revert.sh --list" >&2
  exit 2
fi
if [[ "$1" == "--list" ]]; then
  exec "$node_bin" "$script_dir/learning/core.mjs" list
fi
exec "$node_bin" "$script_dir/learning/core.mjs" revert "$@"
