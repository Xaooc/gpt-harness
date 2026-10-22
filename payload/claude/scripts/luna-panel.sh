#!/usr/bin/env bash
# luna-panel.sh — run every *.brief.md as a read-only Luna critic.
#
# Usage: luna-panel.sh <briefs-dir> <repo-root> [max-parallel]
#   The default engine is xargs + luna.sh: each brief uses the shared daemon.
#   max-parallel defaults to $LUNA_PAR or 16; the daemon queues beyond its own cap.
#   Set LUNA_POOL=1 to opt into luna-pool.mjs. A pool startup failure (exit 3)
#   falls back to luna.sh for briefs not already marked done.
#   LUNA_POOL_DRY_RUN=1 passes --dry-run to the pool for a safe plan preview.
#
# Effort: critics default to "high" ($LUNA_PANEL_EFFORT overrides the default).
# A single critic can pick its own effort through its file name:
#   attacker.max.brief.md   -> max        maintainer.brief.md -> default (high)
#   Allowed: low|medium|high|xhigh|max.
#
# Writes <stem>.out.md next to each brief (plus .log/.status files); prints one
# summary line per critic.

set -u
DIR="${1:?briefs dir}"; REPO="${2:?repo root}"; PAR="${3:-${LUNA_PAR:-16}}"
BRIEFS=( "$DIR"/*.brief.md )
[[ -f "${BRIEFS[0]}" ]] || { echo "luna-panel: no *.brief.md in $DIR" >&2; exit 2; }

export REPO
export LUNA_PANEL_EFFORT="${LUNA_PANEL_EFFORT:-high}"

legacy_run() {
  local brief_list=( "$@" )
  cd "$DIR" || return 2
  printf '%s\0' "${brief_list[@]##*/}" | xargs -0 -n1 -P "$PAR" bash -c '
  b="$1"; stem="${b%.brief.md}"; effort="$LUNA_PANEL_EFFORT"
  case "$stem" in
    *.low|*.medium|*.high|*.xhigh|*.max) effort="${stem##*.}"; stem="${stem%.*}" ;;
  esac
  o="${stem}.out.md"
  bash "$HOME/.claude/scripts/luna.sh" -r -e "$effort" -C "$REPO" -f "$b" -o "$o" >/dev/null
  echo "done rc=$? effort=$effort $o ($(wc -c < "$o" 2>/dev/null || echo 0) bytes)"
' _
}

if [[ "${LUNA_POOL:-0}" != 1 ]]; then
  legacy_run "${BRIEFS[@]}"
  exit $?
fi

POOL_ARGS=( "$DIR" "$REPO" --max "$PAR" )
if [[ "${LUNA_POOL_DRY_RUN:-0}" == 1 ]]; then POOL_ARGS+=( --dry-run ); fi
node "$HOME/.claude/scripts/luna-pool.mjs" "${POOL_ARGS[@]}"
pool_rc=$?
if (( pool_rc != 3 )); then exit "$pool_rc"; fi

PENDING=()
for brief in "${BRIEFS[@]}"; do
  name="${brief##*/}"
  stem="${name%.brief.md}"
  case "$stem" in
    *.low|*.medium|*.high|*.xhigh|*.max) stem="${stem%.*}" ;;
  esac
  status="$DIR/$stem.out.md.status"
  if ! grep -qx 'state=done' "$status" 2>/dev/null; then
    PENDING+=( "$brief" )
  fi
done

if (( ${#PENDING[@]} == 0 )); then exit 0; fi
legacy_run "${PENDING[@]}"
