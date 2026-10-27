# Shared Windows process identity and daemon request helpers.
luna_win_pid() {
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*|0) return 1 ;; esac
  if [ "${2:-}" = msys ] && [ -r "/proc/$$/winpid" ]; then
    [ -r "/proc/$pid/winpid" ] || return 1
    cat "/proc/$pid/winpid"
  else
    printf '%s\n' "$pid"
  fi
}

luna_pid_start() {
  local pid
  pid=$(luna_win_pid "${1:-}" "${2:-}") || return 1
  command -v powershell >/dev/null 2>&1 || return 0
  powershell -NoProfile -NonInteractive -Command \
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=$pid').CreationDate.ToString('o')" 2>/dev/null | tr -d '\r'
}

luna_pid_alive() {
  local pid="${1:-}" mode="${2:-}"
  case "$pid" in ''|*[!0-9]*|0) return 1 ;; esac
  if [ "$mode" = msys ]; then kill -0 "$pid" 2>/dev/null; return $?; fi
  if command -v tasklist >/dev/null 2>&1; then
    tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -qE "(^|[[:space:]])$pid([[:space:]]|$)"
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

luna_owned_pid() {
  local pid="${1:-}" expected="${2:-}" mode="${3:-}" actual
  luna_pid_alive "$pid" "$mode" || return 1
  [ -n "$expected" ] || return 0
  actual=$(luna_pid_start "$pid" "$mode")
  [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

luna_daemon_home() {
  local profile="${1:-default}" root="${LUNA_DAEMON_HOME:-$HOME/.claude/luna-run}"
  case "$profile" in
    default|'') printf '%s\n' "$root" ;;
    net) printf '%s\n' "$root/daemon-net" ;;
    *) return 1 ;;
  esac
}

luna_verify_wrapper() {
  local pid
  pid=$(luna_win_pid "${1:-}" msys) || return 1
  node -e '
    const { execFileSync } = require("child_process");
    const pid = Number(process.argv[1]), recorded = process.argv[2] || "";
    if (!Number.isSafeInteger(pid) || pid < 1) process.exit(2);
    const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      "if ($p) { $p | Select-Object Name,CommandLine | ConvertTo-Json -Compress }";
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8", windowsHide: true, timeout: 2500, stdio: ["ignore", "pipe", "ignore"]
      });
      const info = JSON.parse(output), line = String(info.CommandLine || "");
      const normalized = (value) => value.replace(/\\/g, "/").toLowerCase();
      const script = /(?:^|[\s"\x27])(?:[^"\x27\r\n]*[\\/])?luna\.sh(?=$|[\s"\x27])/i.test(line);
      const matchesRecorded = recorded && normalized(line).includes(normalized(recorded));
      process.exit(/^bash(?:\.exe)?$/i.test(info.Name || "") && (script || matchesRecorded) ? 0 : 1);
    } catch { process.exit(2); }
  ' "$pid" "${2:-}" >/dev/null 2>&1
}

luna_daemon_curl() {
  local token="$1"; shift
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 2
  curl --config - "$@" < <(printf 'header = "X-Luna-Token: %s"\n' "$token")
}
