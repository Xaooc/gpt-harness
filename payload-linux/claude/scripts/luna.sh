#!/usr/bin/env bash
{ # Whole script is one block: bash parses it all before running, so swapping the file mid-run is safe.
# luna.sh вЂ” run a task on Codex gpt-6-luna.
#
# Pins model/effort on the command line so it does NOT depend on
# $CODEX_HOME/config.toml (the Codex desktop app rewrites that default).
#
# Usage:
#   luna.sh [-w|-r] [-C dir] [-o out.md] [-e effort] [-m model] [-t tier] (-f prompt.md | "prompt text")
#     -w          write mode (workspace-write sandbox)  вЂ” implementation
#     -r          read-only mode (default)             вЂ” research, critics, review
#     -C dir      working directory for Codex (default: current dir)
#     -o file     save Codex's final message here (default: temp file, printed)
#     -f file     read the prompt from a file (preferred for long prompts)
#     -e effort   reasoning effort: low|medium|high|xhigh|max (default: max).
#                 Pick it per task вЂ” see the "Effort routing" table in the luna skill.
#     -m model    override model (default: gpt-6-luna)
#     -t tier     service tier (default: "default" = normal; "fast" = priority, ~1.5x speed but burns more quota)
#
# Files next to <out>:
#   <out>        Codex's final message (also printed to stdout)
#   <out>.log    Codex's full progress log
#   <out>.status one key=value per line: state, pid, started, finished, rc, effort,
#                sandbox, dir, error, model_retry. States: starting | waiting-ram | waiting-lock | running |
#                queued | waiting-daemon | done | incomplete | failed | stalled.
# Exit code is Codex's exit code (2 = setup error, 75 = admission timeout, 124 = watchdog stall).
#
# LUNA_NET=1 (default for -w): sandbox network access (local sockets for tests); uses the net daemon profile.
# Standing rules prepended to every prompt (disable with LUNA_NO_PREAMBLE=1):
#   - no sub-agents unless LUNA_ALLOW_SUBAGENTS=1;
#   - write mode: final message must use the result contract headings
#     (## Changes / ## Verification / ## Deviations / ## Not done). A write-mode
#     result missing any of them is marked state=incomplete (exit code unchanged).
#
# Codex launch: executable override, npm native binary, then PATH or the home npm shim.
# Linux jobs use bash; the native binary avoids the Node shim overhead.
# Admission defaults: reserve=max(1024 MB, 6% RAM), job=250 MB read-only or
# 700 MB write; LUNA_RAM_RESERVE_MB and LUNA_JOB_MB override these estimates.
# Sessions are removed by default; LUNA_KEEP_SESSION=1 keeps Codex session history.
# LUNA_MODEL_RETRIES=2: extra attempts after a retryable model error (0 disables).
# LUNA_MODEL_RETRY_DELAY_S=60: retry k waits base * k seconds plus 0-30% random jitter.
# Daemon mode is default when node/curl exist; LUNA_DAEMON=0 preserves codex exec.
# LUNA_DAEMON_MAX=12: running turns; queued jobs favor owners with fewer running turns.
# LUNA_DAEMON_OWNER_MAX=0: optional running cap per owner (0 disables).
# LUNA_OWNER defaults to CLAUDE_CODE_SESSION_ID, then pid-<clientPid>; eligible jobs keep FIFO per owner.
# LUNA_DAEMON_IDLE_S=600: daemon idle shutdown seconds (0 disables).
# LUNA_DAEMON_START_MB=150: admission RAM only when daemon startup is needed.
# LUNA_DAEMON_BUSY_MAX_S=300: maximum unresponsive seconds while the same daemon process is alive.
# The daemon owns turn admission; existing daemons accept submissions without a client RAM gate.
# LUNA_DAEMON_HOME: tests-only state directory override (default ~/.claude/luna-run).
# LUNA_DAEMON_APP_SERVER_CMD: tests-only JSON argv array replacing the app-server.
# Daemon MCP policy matches luna-pool: LUNA_POOL_ALLOW_MCP=1 preserves configured MCP;
# plugins/apps stay disabled; LUNA_FULL/LUNA_MCP only affect exec mode.
# Daemon launches via Node detached spawn + unref, with file-backed stdio, on all platforms.
# <out>.daemon is the atomic daemon attempt marker; status adds engine and daemon_job.
# Its id field recovers an accepted submission if the HTTP response is lost.
# An optional ephemeral JSON field carries LUNA_KEEP_SESSION independently for each caller.

set -u
. "$(cd "$(dirname "$0")" && pwd)/lib/luna-runtime.sh"
luna_proxy_env
MODEL="${LUNA_MODEL:-gpt-6-luna}"
EFFORT="${LUNA_EFFORT:-max}"
TIER="${LUNA_TIER:-default}"
SANDBOX="read-only"
DIR="$PWD"
OUT=""
PFILE=""
TEMP_PROMPT=""
FULLP=""
ENGINE=exec
DAEMON_JOB=""
DAEMON_ERROR=""
DAEMON_DIED=0
DAEMON_FALLBACK_USED=0
DAEMON_REASON="startup failed"
DAEMON_READMIT=0
MODEL_RETRIES="${LUNA_MODEL_RETRIES-2}"
MODEL_RETRY_DELAY_S="${LUNA_MODEL_RETRY_DELAY_S-60}"
MODEL_RETRY_COUNT=0
DAEMON_RETRY_BASE=0
DAEMON_RETRY_WAITING=0
MODEL_RETRY_DELAY_ACTUAL=""
EXEC_SESSION_ID=""
EXEC_SESSION_OFFSET=""
EXEC_LAST_ERROR=""
EXEC_ERROR=""
RETRY_SLEEP_PID=""
DAEMON_SCRIPT="$(cd "$(dirname "$0")" && pwd)/luna-daemon.mjs"
DAEMON_BASE="${LUNA_DAEMON_HOME:-$HOME/.claude/luna-run}"
DAEMON_HOME="$DAEMON_BASE"
DAEMON_PROFILE=default
HEAVY_GATE_JS="$HOME/.claude/scripts/heavy-gate.mjs"
if [ "${LUNA_DAEMON:-1}" != 0 ] && [ ! -e "$HOME/.claude/luna-daemon-off" ] &&
    command -v node >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  [ ! -f "$DAEMON_SCRIPT" ] || ENGINE=daemon
fi
cleanup_prompts() {
  [ -z "$TEMP_PROMPT" ] || rm -f -- "$TEMP_PROMPT"
  [ -z "$FULLP" ] || rm -f -- "$FULLP"
  return 0
}
capture_session() {
  [ -z "$EXEC_SESSION_ID" ] && [ -n "$EXEC_SESSION_OFFSET" ] && [ -r "${OUT:-}.log" ] || return 0
  EXEC_SESSION_ID=$(tail -c "+$(( EXEC_SESSION_OFFSET + 1 ))" "$OUT.log" | tr -d '\r' |
    sed -nE 's/^session id: ([0-9a-f-]{36})$/\1/p' | head -n 1)
}
cleanup_session() {
  if [ "${LUNA_KEEP_SESSION:-0}" != 1 ] && [ "${MODEL_RETRIES:-0}" != 0 ]; then
    capture_session
    if [[ "$EXEC_SESSION_ID" =~ ^[0-9a-f-]{36}$ ]] && [ -d "${CODEX_HOME:-$HOME/.codex}/sessions" ]; then
      find "${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name "*-$EXEC_SESSION_ID.jsonl" -exec rm -f -- {} +
    fi
  fi
  EXEC_SESSION_ID=""; EXEC_SESSION_OFFSET=""
}
# Learning-loop job registry: runs last (from the EXIT trap), after the final status write. It records only terminal
# states and never fails the job. LUNA_NO_REGISTRY=1 disables it.
record_job() {
  [ "${LUNA_NO_REGISTRY:-0}" != 1 ] && [ -n "${OUT:-}" ] && [ -f "$HOME/.claude/scripts/learning/registry.mjs" ] || return 0
  node "$HOME/.claude/scripts/learning/registry.mjs" record "$OUT" >/dev/null 2>&1 || true
  return 0
}
# Active-job index for the status pane / luna-overview: out path, then the wrapper PID.
ACTIVE_DIR="$HOME/.claude/luna-run/active"
ACTIVE_FILE=""
mark_active() {
  [ -z "$ACTIVE_FILE" ] && [ -n "${OUT:-}" ] || return 0
  mkdir -p "$ACTIVE_DIR" 2>/dev/null && ACTIVE_FILE="$ACTIVE_DIR/$$" &&
    { printf '%s\n' "$OUT" "$LOCK_PID" "$WRAPPER_START"; } \
      > "$ACTIVE_FILE" 2>/dev/null
  return 0
}
unmark_active() { [ -z "$ACTIVE_FILE" ] || rm -f -- "$ACTIVE_FILE"; return 0; }
trap 'cleanup_session; cleanup_prompts; unmark_active; record_job' EXIT
SESSION_ARGS=()
ARGV="$*"
REFUSAL_RE="\b(i|we)\b[^.\n]{0,25}\b"\
"(can(’|'|)t|cannot|am unable to|are unable to|am not able to|don(’|'|)t have|do not have|have no)\b"\
"[^.\n]{0,50}\b(read|access|run|use|execute|open|shell|command|tool)|"\
"\b(workspace|sandbox|filesystem|file system|environment)\b[^.\n]{0,20}\bis read-only\b|"\
"\bno (shell|command|terminal)[^.\n]{0,15}(access|tool|available)"
REFUSAL_RETRY_PROMPT='IMPORTANT: a previous attempt wrongly refused to read files. You DO have a shell tool. '
REFUSAL_RETRY_PROMPT+='Read-only only forbids modifying files. Read the files and run read-only commands '
REFUSAL_RETRY_PROMPT+='(cat, grep, rg, git diff) now, before answering.'
RETRY_EFFORT=""
REFUSAL_SUSPECTED=0

refusal_line_matches() {
  printf '%s\n' "$1" | LC_ALL=C grep -qiE "$REFUSAL_RE"
}

refusal_file_matches() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    refusal_line_matches "$line" && return 0
  done < "$1"
  return 1
}

self_test_refusal() {
  local expected message failed=0 passed=0
  check_refusal() {
    local expected="$1" message="$2" matched=1
    refusal_line_matches "$message" && matched=0
    if { [ "$expected" = true ] && [ "$matched" = 0 ]; } || { [ "$expected" = false ] && [ "$matched" != 0 ]; }; then
      echo "PASS $message"
      passed=$((passed + 1))
    else
      echo "FAIL $message"
      failed=$((failed + 1))
    fi
  }
  check_refusal true "I can’t read files in this read-only workspace."
  check_refusal true "I can’t run \`cat greet.py\` here because the workspace is read-only and doesn’t provide \
shell access."
  check_refusal true "Unable to read \`greet.py\`; filesystem access is read-only."
  check_refusal true "I can’t read the workspace because filesystem access is read-only and no command tool is \
available"
  check_refusal true "I don’t have access to the shell."
  check_refusal true "I can't read files"
  check_refusal false "No access control is implemented on /admin."
  check_refusal false "- **[high]** Users cannot read the config when the cache is cold"
  check_refusal false "Unable to access the file due to its permissions is shown to users as a raw stack trace"
  check_refusal false "\`greet.py\` prints \`Hello, {name}!\`"
  check_refusal false "No findings"
  echo "refusal self-test: passed=$passed failed=$failed"
  [ "$failed" -eq 0 ]
}

if [ "${1:-}" = "--self-test-refusal" ]; then
  self_test_refusal
  exit $?
fi

while getopts "wrC:o:f:e:m:t:" opt; do
  case "$opt" in
    w) SANDBOX="workspace-write" ;;
    r) SANDBOX="read-only" ;;
    C) DIR="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    f) PFILE="$OPTARG" ;;
    e) EFFORT="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    t) TIER="$OPTARG" ;;
    *) echo "luna.sh: bad option (argv: $ARGV)" >&2; sed -n '2,30p' "$0" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
if [ "$SANDBOX" = workspace-write ] && [ "${LUNA_NET:-1}" != 0 ]; then
  DAEMON_PROFILE=net
  DAEMON_HOME="$DAEMON_BASE/daemon-net"
fi

# Absolutize paths before anything can fail, so the status file lands next to <out>.
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$PWD/$1" ;; esac; }
[ -n "$OUT" ] || OUT="$(mktemp -t luna-out.XXXXXX)"
OUT="$(abs "$OUT")"; DIR="$(abs "$DIR")"
STATUS="$OUT.status"
LOCK_PID=$$
WRAPPER_START=$(luna_pid_start "$$")
CSTART=""
OWNER="${LUNA_OWNER:-${CLAUDE_CODE_SESSION_ID:-pid-$LOCK_PID}}"

CODEX_CMD=()
CODEX_BIN=codex
resolve_codex() {
  CODEX_BIN=$(node "$LUNA_RUNTIME_JS" --resolve) || die 2 "codex executable not found"
  CODEX_CMD=("$CODEX_BIN")
  local package_root
  package_root=$(node "$LUNA_RUNTIME_JS" --package-root "$CODEX_BIN")
  if [ -n "$package_root" ]; then
    export CODEX_MANAGED_PACKAGE_ROOT="$package_root" CODEX_MANAGED_BY_NPM=1
    unset CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS
  fi
}

now() { date '+%Y-%m-%dT%H:%M:%S%z'; }
STARTED="$(now)"
status() { # status <state> [extra key=value lines...]
  local state="$1"; shift
  {
    echo "state=$state"
    echo "pid=${CPID:-}"
    echo "wrapper_pid=$$"
    echo "wrapper_start=$WRAPPER_START"
    echo "pid_start=${CSTART:-}"
    echo "owner=$OWNER"
    echo "started=$STARTED"
    echo "effort=$EFFORT"
    echo "sandbox=$SANDBOX"
    echo "model=$MODEL"
    echo "tier=$TIER"
    echo "dir=$DIR"
    echo "codex_bin=$CODEX_BIN"
    echo "shell=bash"
    echo "engine=$ENGINE"
    echo "daemon_profile=$DAEMON_PROFILE"
    if [ "$ENGINE" = daemon ] && [ -n "$DAEMON_JOB" ]; then echo "daemon_job=$DAEMON_JOB"; fi
    if [ -n "$RETRY_EFFORT" ]; then
      echo "retry=1"
      echo "retry_effort=$RETRY_EFFORT"
    fi
    if [ "$MODEL_RETRY_COUNT" -gt 0 ]; then echo "model_retry=$MODEL_RETRY_COUNT"; fi
    if [ -n "$MODEL_RETRY_DELAY_ACTUAL" ]; then echo "model_retry_delay_s=$MODEL_RETRY_DELAY_ACTUAL"; fi
    for kv in "$@"; do echo "$kv"; done
  } > "$STATUS.tmp" 2>/dev/null && mv -f "$STATUS.tmp" "$STATUS" 2>/dev/null
}
die() { # die <rc> <message> вЂ” setup failures are visible on stderr AND in the status file
  echo "luna.sh: $2 (argv: $ARGV)" >&2
  status failed "rc=$1" "finished=$(now)" "error=$2"
  exit "$1"
}

non_negative_safe() {
  local value="$1"
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  value="${value#"${value%%[!0]*}"}"; value="${value:-0}"
  [ "${#value}" -lt 16 ] || {
    [ "${#value}" -eq 16 ] && [[ "$value" < 9007199254740992 ]]
  } || return 1
  printf '%s' "$value"
}
MODEL_RETRIES=$(non_negative_safe "$MODEL_RETRIES") || die 2 "LUNA_MODEL_RETRIES must be a non-negative integer"
MODEL_RETRY_DELAY_S=$(non_negative_safe "$MODEL_RETRY_DELAY_S") ||
  die 2 "LUNA_MODEL_RETRY_DELAY_S must be non-negative integer seconds"
if [ "${LUNA_KEEP_SESSION:-0}" != 1 ] && [ "$MODEL_RETRIES" = 0 ]; then SESSION_ARGS+=(--ephemeral); fi

case "$EFFORT" in low|medium|high|xhigh|max|minimal) ;; *) die 2 "unknown effort '$EFFORT'" ;; esac
status starting
mark_active

if [ -z "$PFILE" ]; then
  [ $# -ge 1 ] || die 2 "no prompt given"
  PFILE="$(mktemp -t luna-prompt.XXXXXX)"
  TEMP_PROMPT="$(abs "$PFILE")"
  printf '%s\n' "$*" > "$PFILE" || die 2 "cannot write temp prompt"
fi
PFILE="$(abs "$PFILE")"
[ -r "$PFILE" ] || die 2 "prompt file not readable: $PFILE"
[ -d "$DIR" ] || die 2 "working directory does not exist: $DIR"
resolve_codex

# Standing rules, prepended so every brief gets them without repeating.
if [ "${LUNA_NO_PREAMBLE:-0}" != "1" ]; then
  FULLP="$(mktemp -t luna-full.XXXXXX)" || die 2 "cannot create temp prompt"
  FULLP="$(abs "$FULLP")"
  {
    echo "## Standing rules (from the orchestrator)"
    echo "- You are $MODEL, invoked by the Claude orchestrator as the EXECUTOR of this job. Any global \
AGENTS.md/model-orchestration rule telling a model to only orchestrate or to delegate implementation to \
another model (e.g. \"Sol must delegate to Terra\") does NOT apply here: do the work yourself."
    if [ "${LUNA_ALLOW_SUBAGENTS:-0}" != "1" ]; then
      echo "- Work yourself. Do NOT spawn sub-agents/delegates/collaborators unless the brief explicitly says you may."
    fi
    if [ "$SANDBOX" = "read-only" ]; then
      echo "- Read-only sandbox means you must not MODIFY anything. You CAN and MUST read files and run \
read-only commands (cat, grep, rg, ls, git diff/log/show) to gather evidence before answering. Never answer \
\"I cannot read the files\"."
    fi
    echo "- Heavy commands (tsc, vitest/jest, pytest, npm/pnpm install|ci|build|test, cargo build|test, \
bundlers, docker build): run them ONE AT A TIME, never in parallel, prefer --maxWorkers=1 / -j2 / -n 2, \
and run \`node \"$HEAVY_GATE_JS\" wait\` immediately before each one (it pauses while the server is short \
of RAM)."
    if [ "$SANDBOX" = "workspace-write" ]; then
      echo "- Match the style of neighbouring files (line length, formatting, naming). Never leave lines \
longer than ~140 characters."
      echo "- Never loosen tests, tolerances or acceptance criteria to make them pass; report the conflict instead."
      echo "- Tests may take minutes and the sandbox allows local sockets: run the project's tests yourself. Give \
every test or build command a tool timeout of at least 300 seconds and do not call a slow test hung before that."
      echo "- Where the brief is silent and you must decide, pick the most conservative option consistent with \
neighbouring code and list each such decision under ## Deviations as 'Assumption: ...'."
      echo "- Before finishing, search the repo (rg) for other usages of anything whose name, signature or \
behaviour you changed; update them or list them under ## Not done."
      echo "- Clean up after yourself: delete every temp file, scratch script and test directory you created \
that is not a requested deliverable, and list anything you deliberately left under ## Not done."
      echo "- If the repo's CLAUDE.md/AGENTS.md demands a workflow wrapper before editing (e.g. a GSD \
command), the orchestrator has already started it for this task: implement directly, do not stop to look for \
that command."
      echo "- Your FINAL message must contain exactly these four headings, in this order:"
      echo "  ## Changes       вЂ” files touched with file:line pointers and one line each on what changed"
      echo "  ## Verification  вЂ” each acceptance command you ran and its result (pass/fail counts, verbatim \
tail on failure)"
      echo "  ## Deviations    вЂ” anything you did differently from the brief and why (write 'None' if none)"
      echo "  ## Not done      вЂ” anything left undone or uncertain (write 'None' if none)"
    fi
    echo
    cat "$PFILE"
  } > "$FULLP" || die 2 "cannot assemble prompt"
  PFILE="$FULLP"
fi

# Lean mode (default): don't spawn MCP servers / plugins / apps вЂ” each run then
# costs ~190 MB instead of ~320 MB (foundry/node_repl/computer-use node procs).
# Keep specific servers with LUNA_MCP="name1 name2"; LUNA_FULL=1 disables lean mode.
LEAN=()
if [ "${LUNA_FULL:-0}" != "1" ]; then
  CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [ -f "$CFG" ]; then
    for s in $(grep -oE '^\[mcp_servers\.[A-Za-z0-9_-]+\]' "$CFG" | sed -E 's/^\[mcp_servers\.(.*)\]$/\1/'); do
      case " ${LUNA_MCP:-} " in *" $s "*) ;; *) LEAN+=(-c "mcp_servers.$s.enabled=false") ;; esac
    done
  fi
  LEAN+=(--disable plugins --disable apps)
fi
# Write jobs may open sockets (owner 2026-10-26): project tests start local servers and talk to them over
# sockets; without network_access they hang. LUNA_NET=0 restores the closed sandbox.
if [ "$SANDBOX" = workspace-write ] && [ "${LUNA_NET:-1}" != 0 ]; then
  LEAN+=(-c "sandbox_workspace_write.network_access=true")
fi
# ---- RAM-aware admission (shared by ALL luna.sh callers, across sessions) ----
# A job starts only if free RAM minus its estimated cost stays above a reserve.
# Starts are serialized through a lock and spaced by a ramp-up pause so that
# concurrent callers see each other's real allocation, not a stale free figure.
#   LUNA_RAM_RESERVE_MB  keep at least this free (default max(1024 MB, 6% of RAM))
#   LUNA_JOB_MB          estimated cost of this job (default 250 read-only / 700 write)
#   LUNA_RAMP_S          hold the start lock this long after launch (default 4)
#   LUNA_WAIT_MAX_S      give up waiting for RAM or the lock, exit 75 (default 1800)
#   LUNA_ADMIT_LOCK      shared lock directory (default $HOME/.claude/luna-run/admit.lock)
#   LUNA_POOL_SERVER_MB  pool app-server estimate in MB (default 120; used by luna-pool.mjs)
#   LUNA_POOL_RAMP_MS    pool start-lock hold in ms (default 2000; used by luna-pool.mjs)
#   LUNA_IDLE_MAX_S      stall after no log size change this long (default 900; 0 disables)
#   LUNA_TIMEOUT_S       hard cap on attempt duration (default 28800 = 8 h; 0 disables). A working job is never cut
#                       short: stalls are caught by LUNA_IDLE_MAX_S (no log growth), this only stops runaway loops.
#                       The pool uses LUNA_IDLE_MAX_S for events and LUNA_TURN_TIMEOUT_S (2400).
#   LUNA_NO_GATE=1       skip admission entirely
#   LUNA_CODEX_BIN       executable override; otherwise prefer the npm native binary.
mem_mb() { awk -v k="$1:" '$1==k{print int($2/1024)}' /proc/meminfo; }
free_mb() { mem_mb MemAvailable; }
TOTAL_MB=$(mem_mb MemTotal 2>/dev/null); TOTAL_MB=${TOTAL_MB:-16384}
RESERVE_MB="${LUNA_RAM_RESERVE_MB:-$(( TOTAL_MB*6/100 > 1024 ? TOTAL_MB*6/100 : 1024 ))}"
if [ "$SANDBOX" = "workspace-write" ]; then JOB_MB="${LUNA_JOB_MB:-700}"; else JOB_MB="${LUNA_JOB_MB:-250}"; fi
RAMP_S="${LUNA_RAMP_S:-4}"; WAIT_MAX_S="${LUNA_WAIT_MAX_S:-1800}"
IDLE_MAX_S="${LUNA_IDLE_MAX_S:-900}"; TIMEOUT_S="${LUNA_TIMEOUT_S:-28800}"
DAEMON_BUSY_MAX_S="${LUNA_DAEMON_BUSY_MAX_S-300}"
for setting in "$IDLE_MAX_S" "$TIMEOUT_S"; do
  case "$setting" in ''|*[!0-9]*) die 2 "watchdog limits must be non-negative integer seconds" ;; esac
done
case "$DAEMON_BUSY_MAX_S" in
  ''|*[!0-9]*) die 2 "LUNA_DAEMON_BUSY_MAX_S must be non-negative integer seconds" ;;
esac
LOCK="${LUNA_ADMIT_LOCK:-$HOME/.claude/luna-run/admit.lock}"; mkdir -p "$(dirname "$LOCK")"
HAVE_LOCK=0
LOCK_TOKEN=""

lock_token() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }

lock_read_owner() {
  READ_PID=""; READ_START=""; READ_KIND=""; READ_SINCE=""; READ_TOKEN=""; READABLE=0
  local key value
  if [ -r "$1/owner" ]; then
    READABLE=1
    while IFS='=' read -r key value; do
      case "$key" in
        pid) READ_PID="$value" ;; pid_start) READ_START="$value" ;; kind) READ_KIND="$value" ;;
        since) READ_SINCE="$value" ;; token) READ_TOKEN="$value" ;;
      esac
    done < "$1/owner" 2>/dev/null
  fi
}

lock_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

lock_details() {
  local since
  lock_read_owner "$LOCK"
  since="$READ_SINCE"
  if [ "$READABLE" != 1 ]; then since=$(lock_mtime "$LOCK") || since=""; fi
  LOCK_KIND="${READ_KIND:-unknown}"; LOCK_AGE_S=0
  case "$since" in ''|*[!0-9]*) ;; *) LOCK_AGE_S=$(( $(date +%s) - since )) ;; esac
  [ "$LOCK_AGE_S" -ge 0 ] || LOCK_AGE_S=0
}

lock_rename() {
  if [ "$(uname -s)" = Darwin ]; then
    # BSD mv can move into an existing directory; Node provides a direct rename instead.
    node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2" 2>/dev/null
  else
    mv -T "$1" "$2" 2>/dev/null
  fi
}

lock_remove_dir() {
  rm -f "$1/owner" "$1/owner.tmp" 2>/dev/null
  rmdir "$1" 2>/dev/null
}

lock_owner_dead() {
  case "$1" in ''|*[!0-9]*|0) return 1 ;; esac
  ! luna_owned_pid "$1" "$READ_START"
}

lock_reclaim_if_stale() {
  local epoch reason="" judged_token stale leftover modified age judged_mtime="" changed=0
  epoch=$(date +%s)
  lock_read_owner "$LOCK"
  judged_token="$READ_TOKEN"
  if [ "$READABLE" = 1 ]; then
    case "$READ_SINCE" in
      ''|*[!0-9]*) ;;
      *)
        age=$(( epoch - READ_SINCE ))
        if [ "$age" -gt 600 ]; then
          reason="owner age exceeds 600s"
        elif [ "$age" -gt 5 ] && lock_owner_dead "$READ_PID"; then
          reason="owner pid $READ_PID is dead"
        fi ;;
    esac
  else
    modified=$(lock_mtime "$LOCK") || return
    judged_mtime="$modified"
    [ $(( epoch - modified )) -le 10 ] || reason="missing owner older than 10s"
  fi
  [ -n "$reason" ] || return
  for leftover in "$LOCK".stale.* "$LOCK".rel.*; do
    [ -d "$leftover" ] || continue
    modified=$(lock_mtime "$leftover") || continue
    [ $(( epoch - modified )) -le 600 ] || lock_remove_dir "$leftover"
  done
  stale="$LOCK.stale.$(lock_token)"
  lock_rename "$LOCK" "$stale" || return
  lock_read_owner "$stale"
  if [ -n "$judged_mtime" ]; then
    modified=$(lock_mtime "$stale") || modified=""
    [ "$modified" = "$judged_mtime" ] || changed=1
  fi
  if [ "$READ_TOKEN" != "$judged_token" ] || [ "$changed" = 1 ]; then
    if [ -e "$LOCK" ] || ! lock_rename "$stale" "$LOCK"; then
      echo "luna.sh: warning: fresh owner moved during reclaim; retained $stale" >&2
    fi
    return
  fi
  echo "luna.sh: reclaimed admission lock: $reason" >&2
  lock_remove_dir "$stale"
}

lock_acquire() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    lock_reclaim_if_stale
    return 1
  fi
  HAVE_LOCK=1
  LOCK_TOKEN=$(lock_token)
  if ! { printf 'pid=%s\npid_start=%s\nkind=luna.sh\nsince=%s\ntoken=%s\n' \
      "$LOCK_PID" "$WRAPPER_START" "$(date +%s)" "$LOCK_TOKEN" \
      > "$LOCK/owner.tmp" && mv -f "$LOCK/owner.tmp" "$LOCK/owner"; }; then
    die 2 "cannot write admission lock owner"
  fi
}

lock_release() {
  local released="$LOCK.rel.$LOCK_TOKEN"
  if [ "$HAVE_LOCK" = 1 ] && [ -n "$LOCK_TOKEN" ] && lock_rename "$LOCK" "$released"; then
    lock_read_owner "$released"
    if [ "$READ_TOKEN" = "$LOCK_TOKEN" ]; then
      lock_remove_dir "$released"
    elif [ -e "$LOCK" ] || ! lock_rename "$released" "$LOCK"; then
      echo "luna.sh: warning: foreign owner moved during release; retained $released" >&2
    fi
  fi
  HAVE_LOCK=0
  LOCK_TOKEN=""
}
release() { lock_release; }
trap 'release; cleanup_session; cleanup_prompts; unmark_active; record_job' EXIT
kill_child_tree() {
  [ -z "${CPID:-}" ] || luna_stop_group "$CPID" "${CSTART:-}" >/dev/null 2>&1 || true
}
interrupt() {
  if [ -n "$RETRY_SLEEP_PID" ]; then
    kill "$RETRY_SLEEP_PID" 2>/dev/null || true
    wait "$RETRY_SLEEP_PID" 2>/dev/null || true
  fi
  if [ "$ENGINE" = daemon ]; then daemon_cancel; else kill_child_tree; fi
  status failed "rc=130" "finished=$(now)" "error=interrupted"
  release
  exit 130
}
trap interrupt INT TERM HUP

attempt_prompt() {
  [ -z "$RETRY_EFFORT" ] || printf '%s\n\n' "$REFUSAL_RETRY_PROMPT"
  cat "$PFILE"
}

retryable_model_error() {
  local allow='at capacity|overloaded|server_error|internal server error|service unavailable|bad gateway|'
  allow+='gateway timeout|stream disconnected|high demand|temporarily unavailable|"status":\s*5[0-9][0-9]|'
  allow+='\b(500|502|503|504)\b|try again later'
  local deny='usage limit|quota|insufficient|billing|unauthorized|forbidden|\b40[0134]\b|"status":\s*4[0-9][0-9]|'
  deny+='model_not_found|not supported|invalid|context window|context_length|too long'
  printf '%s\n' "$1" | LC_ALL=C grep -qiE "$allow" && ! printf '%s\n' "$1" | LC_ALL=C grep -qiE "$deny"
}

continue_prompt() {
  local error
  error=$(printf '%s' "$EXEC_LAST_ERROR" | node -e '
    process.stdout.write(Array.from(require("fs").readFileSync(0, "utf8")).slice(0, 300).join(""));
  ')
  printf 'LUNA AUTO-RETRY %s/%s: your previous turn was cut off by a model-side error ("%s"), ' \
    "$MODEL_RETRY_COUNT" "$MODEL_RETRIES" "$error"
  printf '%s\n' 'not by anything you did.'
  printf '%s%s\n' 'Continue the SAME task in this same session from where you stopped. ' \
    'Do not restart and do not redo finished steps:'
  printf '%s%s\n' 'first check the current state (files you already edited; `git status` / `git diff` ' \
    'if this is a git repo), then'
  printf '%s%s\n' 'finish the remaining work and end with the final message in exactly the format ' \
    'the original instructions require.'
}

retry_pause() {
  local remaining="$1" part seconds
  while [ "$remaining" != 0 ]; do
    if [ "${#remaining}" -gt 5 ] || [ "$remaining" -gt 30000 ]; then part=30000; else part="$remaining"; fi
    printf -v seconds '%d.%03d' "$((part / 1000))" "$((part % 1000))"
    sleep "$seconds" & RETRY_SLEEP_PID=$!
    wait "$RETRY_SLEEP_PID" || true
    RETRY_SLEEP_PID=""
    [ "$remaining" != "$part" ] || break
    remaining=$(node -e 'process.stdout.write(String(BigInt(process.argv[1]) - 30000n))' "$remaining")
    printf '%s\n' 'luna: waiting for model retry on the same session' >> "$OUT.log"
  done
}

native_path() { printf '%s\n' "$1"; }

daemon_health() {
  DAEMON_PID=""; DAEMON_START=""; DAEMON_PORT=""; DAEMON_TOKEN=""
  DAEMON_MISMATCH=0
  local identity
  read -r DAEMON_PID DAEMON_PORT DAEMON_TOKEN identity DAEMON_START < <(node -e '
    try {
      const fs = require("fs"), path = require("path");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (d.version !== 1 || !Number.isInteger(d.pid) || d.pid <= 0 ||
          !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !/^[a-f0-9]{32}$/.test(d.token)) {
        process.exit(1);
      }
      const testCommand = process.env.LUNA_DAEMON_APP_SERVER_CMD;
      let bin = testCommand ? JSON.parse(testCommand)[0] : process.argv[2];
      const key = (value) => {
        if (typeof value !== "string" || !value) return "";
        let file = path.resolve(value);
        try { file = fs.realpathSync(file); } catch {}
        return file;
      };
      const shell = "bash";
      const matches = key(d.codexBin) === key(bin) && (d.shell || "bash") === shell;
      const fields = [d.pid, d.port, d.token, matches ? "match" : "mismatch", d.pid_start || ""];
      process.stdout.write(fields.join(" ") + "\n");
    } catch { process.exit(1); }
  ' "$(native_path "$DAEMON_HOME/daemon.json")" "$(native_path "${CODEX_CMD[0]}")" 2>/dev/null)
  [ -n "$DAEMON_PID" ] && [ -n "$DAEMON_PORT" ] && [ -n "$DAEMON_TOKEN" ] || return 1
  luna_owned_pid "$DAEMON_PID" "$DAEMON_START" || return 1
  local response
  response=$(luna_daemon_curl "$DAEMON_TOKEN" --noproxy '*' -fs --max-time 3 \
    "http://127.0.0.1:$DAEMON_PORT/health") || return 1
  # A live but old daemon must not receive jobs or be replaced while it still owns work.
  printf '%s' "$response" | node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.exit(d.ok === true && d.pid === Number(process.argv[1]) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$DAEMON_PID" 2>/dev/null || return 1
  if ! printf '%s' "$response" | node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.exit(Number.isInteger(d.protocol) && d.protocol >= 2 && d.profile === process.argv[1] ? 0 : 1);
    } catch { process.exit(1); }
  ' "$DAEMON_PROFILE" 2>/dev/null; then
    DAEMON_MISMATCH=1
    DAEMON_REASON="running daemon has an incompatible protocol or profile"
    return 0
  fi
  if [ "$identity" != match ]; then
    DAEMON_MISMATCH=1
    DAEMON_REASON="running daemon uses a different Codex binary or shell"
  fi
  return 0
}

# A rejected duplicate submission must not hide the live job that owns this out path.
restore_marker() {
  [ -n "${SAVED_MARKER:-}" ] && [ ! -e "$OUT.daemon" ] || return 0
  printf '%s\n' "$SAVED_MARKER" > "$OUT.daemon"
}

daemon_process_alive() {
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  luna_owned_pid "$pid" "${2:-}"
}

daemon_ensure() {
  if daemon_health; then
    [ "$DAEMON_MISMATCH" = 0 ] && return 0
    return 1
  fi
  DAEMON_REASON="startup failed"
  # A daemon can idle-exit after admission. Recheck the startup RAM before spawning it.
  if [ "${LUNA_NO_GATE:-0}" != 1 ] && [ -r /proc/meminfo ]; then
    local need available
    need="${LUNA_DAEMON_START_MB:-150}"; available=$(free_mb)
    if [ $(( available - need )) -lt "$RESERVE_MB" ]; then DAEMON_READMIT=1; return 1; fi
  fi
  mkdir -p "$DAEMON_HOME" || return 1
  # No inherited terminal or pipe: Node creates a detached process.
  LUNA_DAEMON_PROFILE="$DAEMON_PROFILE" node -e '
    const fs = require("fs"), path = require("path"), cp = require("child_process");
    const log = fs.openSync(path.join(process.argv[2], "daemon.log"), "a");
    const child = cp.spawn(process.execPath, [process.argv[1], "--serve"], {
      cwd: require("os").homedir(), detached: true, windowsHide: true, stdio: ["ignore", log, log]
    });
    fs.closeSync(log);
    child.on("error", () => { process.exitCode = 1; });
    child.unref();
  ' "$(native_path "$DAEMON_SCRIPT")" "$(native_path "$DAEMON_HOME")" 2>/dev/null || return 1
  local deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if daemon_health; then
      [ "$DAEMON_MISMATCH" = 0 ] && return 0
      return 1
    fi
    sleep 1
  done
  DAEMON_REASON="health timeout after 30s"
  return 1
}

daemon_cancel() {
  [ -n "$DAEMON_JOB" ] || daemon_recover_submission || return 0
  [ -n "$DAEMON_JOB" ] && [ -n "${DAEMON_PORT:-}" ] && [ -n "${DAEMON_TOKEN:-}" ] || return 0
  local response retries
  response=$(luna_daemon_curl "$DAEMON_TOKEN" --noproxy '*' -fs --max-time 5 -X POST \
    "http://127.0.0.1:$DAEMON_PORT/jobs/$DAEMON_JOB/cancel" 2>/dev/null) || return 0
  retries=$(printf '%s' "$response" | node -e '
    try {
      const count = JSON.parse(require("fs").readFileSync(0, "utf8")).modelRetries;
      if (Number.isSafeInteger(count) && count >= 0) process.stdout.write(String(count));
    } catch {}
  ')
  case "$retries" in ''|*[!0-9]*) ;; *) MODEL_RETRY_COUNT="$retries" ;; esac
}

daemon_submit() {
  local response code
  response=$(attempt_prompt | node -e '
    const fs = require("fs");
    const [cwd, out, log, sandbox, model, effort, tier, idle, timeout, keep, pid, exclusive, owner,
      retries, delay, offset] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({prompt: fs.readFileSync(0, "utf8"), cwd, out, log,
      sandbox, model, effort, tier, idleMaxS: Number(idle), timeoutS: Number(timeout), ephemeral: keep !== "1",
      clientPid: Number(pid), owner, exclusiveRepo: sandbox === "workspace-write" && exclusive === "1",
      modelRetries: Number(retries), modelRetryDelayS: Number(delay), modelRetryOffset: Number(offset)}));
  ' "$(native_path "$DIR")" "$(native_path "$OUT")" "$(native_path "$OUT.log")" \
    "$SANDBOX" "$MODEL" "${RETRY_EFFORT:-$EFFORT}" "$TIER" "$IDLE_MAX_S" "$TIMEOUT_S" \
    "${LUNA_KEEP_SESSION:-0}" "$LOCK_PID" "${LUNA_REPO_EXCLUSIVE:-0}" \
    "$OWNER" "$MODEL_RETRIES" "$MODEL_RETRY_DELAY_S" "$DAEMON_RETRY_BASE" | \
    luna_daemon_curl "$DAEMON_TOKEN" --noproxy '*' -s --max-time 10 -w '\n%{http_code}' \
      -H 'Content-Type: application/json' --data-binary @/dev/fd/3 "http://127.0.0.1:$DAEMON_PORT/jobs") || {
    daemon_recover_submission
    return $?
  }
  code="${response##*$'\n'}"; response="${response%$'\n'*}"
  # 75 retries a full queue; 76 rejects an output conflict without exec fallback.
  if [ "$code" = 409 ]; then
    DAEMON_ERROR="output or log already in use by another daemon job"
    return 76
  fi
  if [ "$code" = 429 ]; then
    DAEMON_RETRY_AFTER=$(printf '%s' "$response" | node -e '
      try {
        const n = JSON.parse(require("fs").readFileSync(0, "utf8")).retryAfterS;
        process.stdout.write(String(Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 2));
      } catch { process.stdout.write("2"); }
    ')
    return 75
  fi
  [ "$code" = 200 ] || { daemon_recover_submission; return $?; }
  DAEMON_JOB=$(printf '%s' "$response" | node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (!/^[a-f0-9]{32}$/.test(d.id)) process.exit(1);
      process.stdout.write(d.id);
    } catch { process.exit(1); }
  ' 2>/dev/null) || { daemon_recover_submission; return $?; }
  CPID="$DAEMON_PID"; CSTART="$DAEMON_START"
}

daemon_recover_submission() {
  local key value
  [ -r "$OUT.daemon" ] || return 1
  while IFS='=' read -r key value; do
    if [ "$key" = id ] && [[ "$value" =~ ^[a-f0-9]{32}$ ]]; then
      DAEMON_JOB="$value"; CPID="$DAEMON_PID"; CSTART="$DAEMON_START"
      return 0
    fi
  done < "$OUT.daemon"
  return 1
}

daemon_submit_wait() {
  local submitted waiting=0 remaining pause
  while :; do
    if [ "$waiting" = 1 ] && [ $(( $(date +%s) - DAEMON_WAIT_STARTED )) -ge "$WAIT_MAX_S" ]; then
      DAEMON_ERROR="daemon queue full"; rc=75
      return 75
    fi
    daemon_submit; submitted=$?
    [ "$submitted" = 75 ] || return "$submitted"
    waiting=1
    release
    status waiting-daemon "reason=queue-full" "waited_s=$(( $(date +%s) - DAEMON_WAIT_STARTED ))"
    if [ $(( $(date +%s) - DAEMON_WAIT_STARTED )) -ge "$WAIT_MAX_S" ]; then
      DAEMON_ERROR="daemon queue full"; rc=75
      return 75
    fi
    remaining=$(( WAIT_MAX_S - $(date +%s) + DAEMON_WAIT_STARTED ))
    [ "$remaining" -gt 0 ] || continue
    pause=$DAEMON_RETRY_AFTER
    [ "$pause" -le "$remaining" ] || pause=$remaining
    sleep "$pause"
  done
}

daemon_marker() {
  DAEMON_STATE=""; DAEMON_RC=""; DAEMON_ERROR=""; DAEMON_QUEUE_POS=""; DAEMON_QUEUE_REASON=""; DAEMON_STARTED=""
  DAEMON_RETRY_WAITING=0
  local key value
  [ -r "$OUT.daemon" ] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      state) DAEMON_STATE="$value" ;; rc) DAEMON_RC="$value" ;; error) DAEMON_ERROR="$value" ;;
      queue_pos) DAEMON_QUEUE_POS="$value" ;; reason) DAEMON_QUEUE_REASON="$value" ;;
      started) DAEMON_STARTED="$value" ;;
      retry_waiting) [ "$value" != 1 ] || DAEMON_RETRY_WAITING=1 ;;
      model_retry_delay_s) MODEL_RETRY_DELAY_ACTUAL="$value" ;;
      model_retry)
        case "$value" in ''|*[!0-9]*) ;; *) MODEL_RETRY_COUNT="$value" ;; esac ;;
    esac
  done < "$OUT.daemon"
  case "$DAEMON_STATE:$DAEMON_RC" in
    completed:0|failed:1|cancelled:130|stalled:124) return 0 ;; *) return 1 ;;
  esac
}

daemon_wait() {
  local failures=0 epoch current_size busy_since=0 busy_note=0 busy_elapsed
  local discovery_pid discovery_token
  attempt_started=0; last_output=0
  log_size=$(wc -c < "$OUT.log")
  release
  while :; do
    if daemon_marker; then
      rc="$DAEMON_RC"
      # A crashed app-server has the same replay risk as a crashed daemon.
      case "$DAEMON_ERROR" in 'app-server exited ('*|'app-server crash loop') DAEMON_DIED=1 ;; esac
      if [ "$DAEMON_STATE" = stalled ]; then STALL_REASON="$DAEMON_ERROR"; DAEMON_ERROR=""; fi
      return
    fi
    epoch=$(date +%s); current_size=$(wc -c < "$OUT.log")
    if [ "$DAEMON_STATE" = queued ]; then
      status queued ${DAEMON_QUEUE_POS:+"queue_pos=$DAEMON_QUEUE_POS"} \
        ${DAEMON_QUEUE_REASON:+"reason=$DAEMON_QUEUE_REASON"}
      if [ $(( epoch - DAEMON_WAIT_STARTED )) -ge "$WAIT_MAX_S" ]; then
        daemon_cancel
        DAEMON_ERROR="gave up waiting in daemon queue"; rc=75
        return
      fi
    elif [ "$DAEMON_STATE" = running ]; then
      if [ "$attempt_started" = 0 ]; then
        attempt_started=$(date -d "$DAEMON_STARTED" +%s 2>/dev/null || echo "$epoch")
        last_output=$epoch
      fi
      status running
      if [ "$current_size" != "$log_size" ]; then last_output=$epoch; log_size=$current_size; fi
      if [ "$TIMEOUT_S" -gt 0 ] && [ $(( epoch - attempt_started )) -gt "$TIMEOUT_S" ]; then
        STALL_REASON="exceeded total timeout ${TIMEOUT_S}s"
      elif [ "$DAEMON_RETRY_WAITING" = 1 ]; then
        last_output=$epoch
      elif [ "$IDLE_MAX_S" -gt 0 ] && [ $(( epoch - last_output )) -ge "$IDLE_MAX_S" ]; then
        STALL_REASON="no events for ${IDLE_MAX_S}s"
      fi
    fi
    if [ -n "$STALL_REASON" ]; then
      daemon_cancel
      printf 'luna.sh: watchdog: %s\n' "$STALL_REASON" >> "$OUT.log"
      echo "luna.sh: watchdog: $STALL_REASON" >&2
      rc=124
      return
    fi
    # Keep the original connection identity for cancellation, even if discovery is replaced.
    local saved_start="$DAEMON_START" saved_pid="$DAEMON_PID" saved_port="$DAEMON_PORT" saved_token="$DAEMON_TOKEN"
    # A TERM trap must never see the cleared or replaced globals while health reads discovery.
    if (daemon_health && [ "$DAEMON_PID" = "$saved_pid" ] && [ "$DAEMON_START" = "$saved_start" ] &&
        [ "$DAEMON_TOKEN" = "$saved_token" ]); then
      failures=0; busy_since=0
    else
      discovery_pid=""; discovery_token=""
      read -r discovery_pid discovery_token < <(node -e '
        try {
          const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (d.version !== 1 || !Number.isInteger(d.pid) || d.pid <= 0 ||
              !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !/^[a-f0-9]{32}$/.test(d.token)) {
            process.exit(1);
          }
          process.stdout.write(`${d.pid} ${d.token}\n`);
        } catch { process.exit(1); }
      ' "$(native_path "$DAEMON_HOME/daemon.json")" 2>/dev/null)
      if [ -n "$discovery_pid" ] && [ "$discovery_pid" = "$saved_pid" ] &&
          [ "$discovery_token" = "$saved_token" ] && daemon_process_alive "$saved_pid" "$saved_start"; then
        epoch=$(date +%s)
        [ "$busy_since" != 0 ] || busy_since=$epoch
        busy_elapsed=$(( epoch - busy_since ))
        if [ "$busy_note" = 0 ] || [ $(( epoch - busy_note )) -ge 30 ]; then
          echo "luna.sh: daemon not responding for ${busy_elapsed}s (process alive); waiting" >&2
          busy_note=$epoch
        fi
        [ "$busy_elapsed" -lt "$DAEMON_BUSY_MAX_S" ] || failures=2
      else
        failures=$(( failures + 1 ))
      fi
    fi
    DAEMON_PID="$saved_pid"; DAEMON_START="$saved_start"; DAEMON_PORT="$saved_port"; DAEMON_TOKEN="$saved_token"
    if [ "$failures" -ge 2 ]; then
      daemon_marker && continue
      daemon_cancel
      DAEMON_DIED=1; DAEMON_ERROR="daemon died"; rc=1
      return
    fi
    sleep 1
  done
}

run_exec_attempt() {
  local mode="$1"
  EXEC_LOG_OFFSET=$(wc -c < "$OUT.log")
  if [ "$mode" = first ]; then
    EXEC_SESSION_OFFSET="$EXEC_LOG_OFFSET"
    # Prompt goes via stdin ("-"): no arg-length limits or inherited stdin.
    luna_start_group "${CODEX_CMD[@]}" exec \
      ${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"} \
      -m "$MODEL" \
      -c "model_reasoning_effort=\"${RETRY_EFFORT:-$EFFORT}\"" \
      -c "service_tier=\"$TIER\"" \
      -s "$SANDBOX" \
      -C "$DIR" \
      --skip-git-repo-check \
      "${LEAN[@]}" \
      -o "$OUT" \
      - < <(attempt_prompt) >> "$OUT.log" 2>&1
  else
    luna_start_group bash -c 'cd -- "$1" || exit 2; shift; exec "$@"' luna-resume "$DIR" \
      "${CODEX_CMD[@]}" exec resume -m "$MODEL" \
      -c "model_reasoning_effort=\"${RETRY_EFFORT:-$EFFORT}\"" \
      -c "service_tier=\"$TIER\"" -c "sandbox_mode=\"$SANDBOX\"" \
      --skip-git-repo-check "${LEAN[@]}" -o "$OUT" "$EXEC_SESSION_ID" \
      - < <(continue_prompt) >> "$OUT.log" 2>&1
  fi
  attempt_started=$(date +%s); last_output=$attempt_started
  log_size=$(wc -c < "$OUT.log")
  status running
  # hold the start lock while the new process ramps up, then let the next job in
  for _ in $(seq 1 "$RAMP_S"); do kill -0 "$CPID" 2>/dev/null || break; sleep 1; done
  release
  while kill -0 "$CPID" 2>/dev/null; do
    sleep 5
    kill -0 "$CPID" 2>/dev/null || break
    epoch=$(date +%s); current_size=$(wc -c < "$OUT.log")
    if [ "$current_size" != "$log_size" ]; then last_output=$epoch; log_size=$current_size; fi
    if [ "$TIMEOUT_S" -gt 0 ] && [ $(( epoch - attempt_started )) -gt "$TIMEOUT_S" ]; then
      STALL_REASON="exceeded total timeout ${TIMEOUT_S}s"
    elif [ "$IDLE_MAX_S" -gt 0 ] && [ $(( epoch - last_output )) -ge "$IDLE_MAX_S" ]; then
      STALL_REASON="no log output for ${IDLE_MAX_S}s"
    else
      continue
    fi
    kill_child_tree
    wait "$CPID" 2>/dev/null || true
    printf 'luna.sh: watchdog: %s\n' "$STALL_REASON" >> "$OUT.log"
    echo "luna.sh: watchdog: $STALL_REASON" >&2
    rc=124
    return
  done
  wait "$CPID"; rc=$?
}

last_exec_error() {
  tail -c "+$(( EXEC_LOG_OFFSET + 1 ))" "$OUT.log" | tr -d '\r' | sed -n 's/^ERROR: *//p' | tail -n 1
}

run_attempt() {
  DAEMON_JOB=""; DAEMON_ERROR=""; DAEMON_DIED=0; DAEMON_READMIT=0
  if [ "$ENGINE" = daemon ]; then
    DAEMON_RETRY_BASE="$MODEL_RETRY_COUNT"
    case "${LUNA_DAEMON_START_MB:-150}" in
      ''|*[!0-9]*) die 2 "LUNA_DAEMON_START_MB must be non-negative integer MB" ;;
    esac
    JOB_MB="${LUNA_DAEMON_START_MB:-150}"
  fi
  if [ "${LUNA_NO_GATE:-0}" != "1" ]; then
    waited=0; last_note=0; last_lock_note=0
    while :; do
      if [ "$ENGINE" = daemon ] && daemon_health; then release; break; fi
      short=0
      if lock_acquire; then
        if [ "$ENGINE" = daemon ]; then
          # Only starting the shared daemon consumes client-side admission RAM.
          if daemon_health; then release; break; fi
          JOB_MB="${LUNA_DAEMON_START_MB:-150}"
        fi
        [ -r /proc/meminfo ] || break   # macOS: skip only the RAM comparison
        free=$(free_mb)
        [ $(( free - JOB_MB )) -ge "$RESERVE_MB" ] && break
        release; short=1
      fi
      if [ "$short" = 1 ]; then
        status waiting-ram "free_mb=${free}" "need_mb=${JOB_MB}" "reserve_mb=${RESERVE_MB}" "waited_s=${waited}"
        if [ $(( waited - last_note )) -ge 60 ] || [ "$last_note" = 0 ]; then
          echo "luna.sh: waiting for RAM (free ${free} MB, need ${JOB_MB} + reserve ${RESERVE_MB})" >&2
          last_note=$(( waited > 0 ? waited : 1 ))
        fi
        cause="RAM"
      else
        lock_details
        status waiting-lock "waited_s=$waited" "lock_kind=$LOCK_KIND" "lock_age_s=$LOCK_AGE_S"
        if [ $(( waited - last_lock_note )) -ge 60 ] || [ "$last_lock_note" = 0 ]; then
          echo "luna.sh: waiting for admission lock (kind=$LOCK_KIND age=${LOCK_AGE_S}s waited=${waited}s)" >&2
          last_lock_note=$(( waited > 0 ? waited : 1 ))
        fi
        cause="admission lock"
      fi
      [ "$waited" -ge "$WAIT_MAX_S" ] && die 75 "gave up waiting for $cause after ${waited}s"
      if [ "$short" = 1 ]; then sleep 3; waited=$(( waited + 3 )); else sleep 1; waited=$(( waited + 1 )); fi
      if [ "$ENGINE" = daemon ]; then waited=$(( $(date +%s) - DAEMON_WAIT_STARTED )); fi
    done
  fi

  if [ "$ENGINE" = daemon ]; then
    if daemon_ensure; then
      release
      # A 409 means another live job owns this out path: keep (and restore) its marker.
      SAVED_MARKER=""; [ ! -r "$OUT.daemon" ] || SAVED_MARKER=$(cat "$OUT.daemon")
      rm -f -- "$OUT.daemon"
      daemon_submit_wait; submitted=$?
      if [ "$submitted" = 76 ]; then restore_marker; rc=1; release; return; fi
      if [ "$submitted" = 75 ]; then return; fi
      if [ "$submitted" != 0 ]; then
        # The daemon may have idle-exited between health and submit. Re-ensure once.
        # Retry only after proving that this attempt was not accepted (no marker).
        if [ ! -e "$OUT.daemon" ]; then
          if daemon_ensure; then
            release
            daemon_submit_wait; submitted=$?
            if [ "$submitted" = 76 ]; then restore_marker; rc=1; release; return; fi
            if [ "$submitted" = 75 ]; then return; fi
          fi
          if [ -z "$DAEMON_JOB" ] && [ "$DAEMON_MISMATCH" = 0 ]; then DAEMON_REASON="submit failed"; fi
        else
          DAEMON_REASON="submit response lost after acceptance"
          DAEMON_DIED=1; DAEMON_ERROR="daemon died"; rc=1
          release
          return
        fi
      fi
      if [ -n "$DAEMON_JOB" ]; then daemon_wait; return; fi
    fi
    if [ "$DAEMON_READMIT" = 1 ]; then release; run_attempt; return; fi
    echo "luna.sh: daemon unavailable ($DAEMON_REASON); using codex exec" >&2
    ENGINE=exec; DAEMON_JOB=""; CPID=""
    if [ "$SANDBOX" = workspace-write ]; then JOB_MB="${LUNA_JOB_MB:-700}"; else JOB_MB="${LUNA_JOB_MB:-250}"; fi
    release
    run_attempt
    return
  fi

  # Below-normal CPU priority; inherited by codex and everything it runs (tests,
  # python, node), so the desktop stays responsive under load.
  renice -n 10 -p $$ >/dev/null 2>&1

  cleanup_session
  EXEC_ERROR=""; EXEC_LAST_ERROR=""
  run_exec_attempt first
  if [ "$MODEL_RETRIES" -gt 0 ]; then capture_session; fi
  while [ "$rc" != 0 ] && [ "$rc" != 124 ] && [ -z "$STALL_REASON" ] &&
      [ "$MODEL_RETRY_COUNT" -lt "$MODEL_RETRIES" ]; do
    EXEC_LAST_ERROR=$(last_exec_error)
    [ -n "$EXEC_LAST_ERROR" ] && retryable_model_error "$EXEC_LAST_ERROR" || break
    case "${EXEC_LAST_ERROR,,}" in
      *output*writ*|*writ*output*|*"final message"*writ*|*writ*"final message"*|\
      *"last message"*writ*|*writ*"last message"*|*output*sav*|*sav*output*|\
      *"final message"*sav*|*sav*"final message"*|*"last message"*sav*|*sav*"last message"*) break ;;
    esac
    if [ -z "$EXEC_SESSION_ID" ]; then
      printf '%s\n' 'luna: model error but no session id; not retried' >> "$OUT.log"
      break
    fi
    if ! { : >> "$OUT"; } 2>/dev/null; then EXEC_ERROR="final output write failed"; rc=1; break; fi
    MODEL_RETRY_COUNT=$(( MODEL_RETRY_COUNT + 1 ))
    read -r MODEL_RETRY_DELAY_ACTUAL pause < <(node "$LUNA_RUNTIME_JS" --retry-delay \
      "$MODEL_RETRY_DELAY_S" "$MODEL_RETRY_COUNT")
    printf 'luna: model error: %s; retry %s/%s on the same session in %ss\n' \
      "$EXEC_LAST_ERROR" "$MODEL_RETRY_COUNT" "$MODEL_RETRIES" "$MODEL_RETRY_DELAY_ACTUAL" >> "$OUT.log"
    CPID=""; CSTART=""
    status running
    retry_pause "$pause"
    if ! : > "$OUT"; then EXEC_ERROR="final output write failed"; rc=1; break; fi
    run_exec_attempt resume
  done
  if [ "$rc" != 0 ] && [ "$MODEL_RETRY_COUNT" -gt 0 ] && [ -z "$STALL_REASON" ]; then
    EXEC_LAST_ERROR=$(last_exec_error)
  fi
  cleanup_session
}

# Real codex exec logs use a standalone "exec" line before each command.
command_count() { awk '/^exec\r?$/{n++} END{print n+0}' "$OUT.log"; }
: > "$OUT.log"
STALL_REASON=""
while :; do
  commands_before=$(command_count)
  if [ "$ENGINE" = daemon ]; then DAEMON_WAIT_STARTED=$(date +%s); fi
  run_attempt
  if [ "$DAEMON_DIED" = 1 ]; then
    if [ "$SANDBOX" = read-only ] && [ "$DAEMON_FALLBACK_USED" = 0 ]; then
      DAEMON_FALLBACK_USED=1
      printf '%s\n' 'luna.sh: daemon died; retrying read-only job once with codex exec' >> "$OUT.log"
      ENGINE=exec; DAEMON_JOB=""; CPID=""
      DAEMON_ERROR=""; DAEMON_DIED=0
      : > "$OUT"
      if [ "$SANDBOX" = workspace-write ]; then JOB_MB="${LUNA_JOB_MB:-700}"; else JOB_MB="${LUNA_JOB_MB:-250}"; fi
      continue
    fi
    DAEMON_ERROR="daemon died; not retried (write job)"
    break
  fi
  [ -z "$DAEMON_ERROR" ] || break
  [ -z "$EXEC_ERROR" ] || break
  [ -z "$STALL_REASON" ] || break
  if [ "$SANDBOX" = "read-only" ] && [ "${LUNA_NO_REFUSAL_RETRY:-0}" != "1" ] &&
      { [ "$rc" = 0 ] || [ "$MODEL_RETRY_COUNT" = 0 ]; }; then
    commands_after=$(command_count)
    if [ "$commands_before" = "$commands_after" ] && [ -s "$OUT" ] && refusal_file_matches "$OUT"; then
      if [ -n "$RETRY_EFFORT" ]; then
        REFUSAL_SUSPECTED=1
        note="second refusal suspected; keeping retry answer"
        printf '%s\n' "$note" >> "$OUT.log"
        break
      fi
      printf 'first refusal answer follows:\n' >> "$OUT.log"
      cat "$OUT" >> "$OUT.log"
      printf '\nend first refusal answer\n' >> "$OUT.log"
      case "$EFFORT" in low|medium|minimal) RETRY_EFFORT=high ;; *) RETRY_EFFORT="$EFFORT" ;; esac
      note="refusal detected; retrying at effort=$RETRY_EFFORT"
      echo "luna.sh: $note" >&2
      printf '%s\n' "$note" >> "$OUT.log"
      : > "$OUT"
      status starting
      continue
    fi
  fi
  break
done

if [ -n "$DAEMON_ERROR" ]; then
  [ ! -s "$OUT" ] || cat "$OUT"
  status failed "rc=$rc" "finished=$(now)" "error=$DAEMON_ERROR"
  exit "$rc"
fi
if [ -n "$EXEC_ERROR" ]; then
  status failed "rc=$rc" "finished=$(now)" "error=$EXEC_ERROR"
  exit "$rc"
fi

missing=""
if [ -n "$STALL_REASON" ]; then
  [ ! -s "$OUT" ] || cat "$OUT"
  status stalled "rc=124" "finished=$(now)" "error=$STALL_REASON"
  exit 124
fi
if [ -s "$OUT" ]; then
  cat "$OUT"
  state=done
  if [ "$rc" != 0 ] && [ "$REFUSAL_SUSPECTED" != 1 ]; then
    state=failed
  elif [ "$SANDBOX" = "workspace-write" ] && [ "${LUNA_NO_PREAMBLE:-0}" != "1" ]; then
    missing=""
    for h in "## Changes" "## Verification" "## Deviations" "## Not done"; do
      grep -qF "$h" "$OUT" || missing="$missing|$h"
    done
    if [ -n "$missing" ]; then
      state=incomplete
      echo "luna.sh: result is missing contract headings: ${missing#|}" >&2
    fi
  fi
  suspected_status=""
  [ "$REFUSAL_SUSPECTED" != 1 ] || suspected_status="refusal_suspected=1"
  final_error=""
  if [ "$rc" != 0 ] && [ "$MODEL_RETRY_COUNT" -gt 0 ]; then final_error="$EXEC_LAST_ERROR"; fi
  status "$state" "rc=$rc" "finished=$(now)" ${missing:+"missing=${missing#|}"} \
    ${suspected_status:+"$suspected_status"} ${final_error:+"error=$final_error"}
else
  echo "luna.sh: Codex produced no final message (exit $rc). Tail of log:" >&2
  tail -20 "$OUT.log" >&2
  final_error="no final message"
  if [ "$rc" != 0 ] && [ "$MODEL_RETRY_COUNT" -gt 0 ] && [ -n "$EXEC_LAST_ERROR" ]; then
    final_error="$EXEC_LAST_ERROR"
  fi
  status failed "rc=$rc" "finished=$(now)" "error=$final_error"
fi
exit $rc

exit $?
}
