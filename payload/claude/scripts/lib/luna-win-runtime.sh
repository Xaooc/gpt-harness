# Shared Windows process identity and daemon request helpers.
LUNA_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
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
  if command -v timeout >/dev/null 2>&1; then
    timeout 2.5s powershell -NoProfile -NonInteractive -Command \
      "(Get-CimInstance Win32_Process -Filter 'ProcessId=$pid').CreationDate.ToString('o')" 2>/dev/null | tr -d '\r'
  elif command -v node >/dev/null 2>&1; then
    node -e '
      const { spawnSync } = require("child_process"), pid = Number(process.argv[1]);
      const command = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToString("o")`;
      const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true, timeout: 2500, stdio: ["ignore", "pipe", "ignore"] });
      if (result.status === 0) process.stdout.write(result.stdout.replace(/\r/g, ""));
    ' "$pid"
  fi
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
  local pid script="$LUNA_RUNTIME_DIR/luna.sh"
  pid=$(luna_win_pid "${1:-}" msys) || return 1
  if command -v cygpath >/dev/null 2>&1; then script=$(cygpath -m "$script"); fi
  luna_verify_process "$pid" wrapper "$script" "${2:-}"
}

luna_verify_exec() {
  local pid bin="${3:-}"
  [ -n "${2:-}" ] && [ -n "$bin" ] || return 1
  pid=$(luna_win_pid "${1:-}" msys) || return 1
  if command -v cygpath >/dev/null 2>&1; then bin=$(cygpath -m "$bin"); fi
  luna_verify_process "$pid" exec "$bin" "$2"
}

luna_verify_process() {
  node -e '
    const { execFileSync } = require("child_process"), fs = require("fs"), path = require("path");
    const [pidText, kind, expected, start] = process.argv.slice(1), pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1) process.exit(2);
    const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      "if ($p) { $s=if ($p.CreationDate) { $p.CreationDate.ToString(\u0027o\u0027) } else { \"\" }; " +
      "@{ Name=$p.Name; CommandLine=$p.CommandLine; ExecutablePath=$p.ExecutablePath; Start=$s } " +
      "| ConvertTo-Json -Compress }";
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8", windowsHide: true, timeout: 2500, stdio: ["ignore", "pipe", "ignore"]
      });
      const info = JSON.parse(output);
      const canonical = (value) => {
        value = String(value || "").replace(/\\/g, "/").replace(/^\/(?:cygdrive\/)?([a-z])\//i, "$1:/");
        if (!/^[a-z]:\//i.test(value)) return "";
        value = path.resolve(value);
        try { value = fs.realpathSync(value); } catch {}
        return value.replace(/\\/g, "/").toLowerCase();
      };
      if (start && info.Start !== start) process.exit(1);
      if (kind === "exec") {
        const bin = canonical(expected);
        process.exit(bin && /\/codex\.exe$/.test(bin) && canonical(info.ExecutablePath) === bin ? 0 : 1);
      }
      if (!/^bash(?:\.exe)?$/i.test(info.Name || "")) process.exit(1);
      const args = [...String(info.CommandLine || "").matchAll(/"([^"]*)"|\x27([^\x27]*)\x27|(\S+)/g)]
        .map((match) => match[1] ?? match[2] ?? match[3]);
      let index = 1;
      while (index < args.length && args[index].startsWith("-")) {
        if (args[index] === "--") { index++; break; }
        if (!/^--(?:login|noprofile|norc|posix)$/.test(args[index]) && !/^-[ilr]+$/.test(args[index])) {
          process.exit(1);
        }
        index++;
      }
      const script = canonical(expected);
      process.exit(script && canonical(args[index]) === script ? 0 : 1);
    } catch { process.exit(2); }
  ' "$@" >/dev/null 2>&1
}

luna_daemon_curl() {
  local token="$1"; shift
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 2
  curl --config - "$@" < <(printf 'header = "X-Luna-Token: %s"\n' "$token")
}
