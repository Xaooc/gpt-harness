# Sourced by Luna launchers; paths are relative to this helper, independent of installation location.
LUNA_RUNTIME_JS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/luna-runtime.mjs"
if [ -z "${HOME:-}" ]; then HOME=$(node -p 'require("os").homedir()'); export HOME; fi
luna_proxy_env() {
  [ -n "${HTTPS_PROXY:-}" ] && return
  local proxy_file=${LUNA_PROXY_ENV_FILE:-"$HOME/.config/luna-proxy.env"}
  case "$proxy_file" in
    '~') proxy_file=$HOME ;;
    '~/'*) proxy_file="$HOME/${proxy_file#\~/}" ;;
  esac
  if [ -z "${LUNA_PROXY_ENV_FILE:-}" ] && [ ! -e "$proxy_file" ]; then
    proxy_file="$HOME/.config/bro-env.sh"
  fi
  [ ! -f "$proxy_file" ] || . "$proxy_file"
}
luna_start_group() { setsid "$@" <&0 & CPID=$!; CSTART=$(luna_pid_start "$CPID"); }
luna_stop_group() { node "$LUNA_RUNTIME_JS" --stop "$1" "${2:-}"; }
luna_owned_pid() { node "$LUNA_RUNTIME_JS" --owned "$1" "${2:-}"; }
luna_pid_start() { node "$LUNA_RUNTIME_JS" --start "$1"; }
# Keep authentication out of process argv; fd 3 preserves a streamed request body.
luna_daemon_curl() {
  local token="$1"; shift
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 2
  curl --config - "$@" 3<&0 < <(printf 'header = "X-Luna-Token: %s"\n' "$token")
}
