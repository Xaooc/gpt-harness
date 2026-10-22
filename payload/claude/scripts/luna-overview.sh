#!/usr/bin/env bash
# luna-overview.sh — one-screen status of the Luna/Codex job system on this machine.
# Usage: bash ~/.claude/scripts/luna-overview.sh            (add -w to refresh every 5 s, Ctrl-C to quit)
set -u
if [ -z "${LUNA_CUSTOM_CODEX_ROOT:-}" ] && [ -f "$HOME/.claude/luna-harness.env" ]; then
  LUNA_CUSTOM_CODEX_ROOT="$(sed -n 's/^LUNA_CUSTOM_CODEX_ROOT=//p' "$HOME/.claude/luna-harness.env" | head -n 1 | tr -d '\r')"
fi
LUNA_CUSTOM_CODEX_ROOT="${LUNA_CUSTOM_CODEX_ROOT:-${USERPROFILE:-$HOME}/codex-build}"
if command -v cygpath >/dev/null 2>&1; then
  LUNA_CUSTOM_CODEX_ROOT="$(cygpath -u "$LUNA_CUSTOM_CODEX_ROOT")"
fi
show() {
  echo "=== $(date '+%H:%M:%S')  Luna overview"
  powershell -NoProfile -Command "\$o=Get-CimInstance Win32_OperatingSystem; 'RAM free {0:N1} GB of {1:N1} GB' -f (\$o.FreePhysicalMemory/1MB),(\$o.TotalVisibleMemorySize/1MB); \$p=Get-Process codex,rustc,cargo,pwsh,sh -ErrorAction SilentlyContinue | Group-Object Name | % { '{0} x{1} = {2:N0} MB' -f \$_.Name,\$_.Count,((\$_.Group | Measure-Object WS -Sum).Sum/1MB) }; if (\$p) { 'Processes: ' + (\$p -join ' | ') }" 2>/dev/null | tr -d '\r'
  echo "--- Daemon"
  if [ -f "$HOME/.claude/luna-run/daemon.json" ]; then
    node "$HOME/.claude/scripts/luna-daemon.mjs" --status 2>/dev/null | awk -F'\t' 'NR==1{print; next} $2!="completed" && $2!="cancelled" {print}' | cut -c1-160
  else
    echo "not running (starts on the first job)"
  fi
  echo "--- Running/queued jobs (status files changed in the last 2 h)"
  find "$HOME/.claude" /tmp "${TMPDIR:-/tmp}" -maxdepth 6 -name '*.status' -mmin -120 2>/dev/null | sort -u | while read -r s; do
    st=$(sed -n 's/^state=//p' "$s" | head -1)
    case "$st" in running|queued|waiting-*|starting) printf '%-14s %-10s %s\n' "$st" "$(sed -n 's/^model=//p' "$s" | head -1)" "${s%.status}";; esac
  done
  if [ -f "$LUNA_CUSTOM_CODEX_ROOT/build.log" ]; then
    echo "--- Codex build: $(iconv -f utf-16 -t utf-8 "$LUNA_CUSTOM_CODEX_ROOT/build.log" 2>/dev/null |
      grep -E 'Compiling|Finished|^error|build exit' | tail -1 | sed 's/^ *//' | cut -c1-100)"
    if [ -f "$LUNA_CUSTOM_CODEX_ROOT/dist/bin/codex.exe" ]; then
      echo "    codex.exe built: $(date -r "$LUNA_CUSTOM_CODEX_ROOT/dist/bin/codex.exe" '+%H:%M')"
    fi
  fi
}
if [ "${1:-}" = "-w" ]; then while :; do clear; show; sleep 5; done; else show; fi
exit 0
