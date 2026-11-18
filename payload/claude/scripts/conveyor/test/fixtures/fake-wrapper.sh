#!/usr/bin/env bash
set -eu

args=("$@")
mode=read
model= effort= dir= brief= out=
while getopts 'wrm:e:C:f:o:' opt; do
  case "$opt" in
    w) mode=write ;;
    r) mode=read ;;
    m) model="$OPTARG" ;;
    e) effort="$OPTARG" ;;
    C) dir="$OPTARG" ;;
    f) brief="$OPTARG" ;;
    o) out="$OPTARG" ;;
    *) exit 1 ;;
  esac
done

case "$model" in
  gpt-*)
    provider=codex
    rc="${FAKE_CODEX_RC:-0}"
    state="${FAKE_CODEX_STATE:-running}"
    error="${FAKE_CODEX_ERROR:-}"
    reason="${FAKE_CODEX_REASON:-}"
    modify="${FAKE_CODEX_MODIFY:-0}"
    ;;
  *)
    provider=gemini
    rc="${FAKE_GEMINI_RC:-0}"
    state="${FAKE_GEMINI_STATE:-running}"
    error="${FAKE_GEMINI_ERROR:-}"
    reason="${FAKE_GEMINI_REASON:-}"
    modify="${FAKE_GEMINI_MODIFY:-0}"
    ;;
esac

printf '%s\n' "${args[@]}" > "$out.log"
printf 'state=%s\n' "$state" > "$out.status.tmp"
mv -- "$out.status.tmp" "$out.status"
sleep "${FAKE_WRAPPER_DELAY_S:-0.1}"
if [ "$modify" = 1 ]; then printf 'changed\n' > "$dir/changed-by-$provider.txt"; fi
printf '%s %s %s %s\n' "$provider" "$model" "$effort" "$mode" > "$out"
if [ "$rc" = 0 ]; then final=done; elif [ "$rc" = 3 ]; then final=unavailable; else final=failed; fi
printf 'state=%s\nerror=%s\nunavailable_reason=%s\n' "$final" "$error" "$reason" > "$out.status.tmp"
mv -- "$out.status.tmp" "$out.status"
cat -- "$out"
exit "$rc"
