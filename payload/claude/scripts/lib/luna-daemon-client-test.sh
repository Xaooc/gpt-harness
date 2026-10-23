#!/usr/bin/env bash
# End-to-end candidate-wrapper tests. Run outside the Codex sandbox with bash and node on PATH.
export LUNA_NO_REGISTRY=1 # tests must not write to the real learning journal
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/luna-client-test.XXXXXX") || exit 1
ROOT=$(cd "$ROOT" && pwd -P) || exit 1
TEST_HOME="$ROOT/home"
mkdir -p "$TEST_HOME"
export HOME="$TEST_HOME"
passed=0; failed=0; serial=0
declare -a clients=()
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}
HELPER=$(native "$ROOT/helper.mjs")
PIDS=$(native "$ROOT/pids")
helper() { node "$HELPER" "$@"; }
cleanup() {
  local pid daemon_home
  for pid in "${clients[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for daemon_home in "$ROOT"/daemon-*; do helper stop "$(native "$daemon_home")" >/dev/null 2>&1 || true; done
  helper cleanup ignored "$PIDS" >/dev/null 2>&1 || true
  # ROOT was resolved above and belongs only to this test; never delete a caller-supplied directory.
  case "$ROOT" in /luna-client-test.*|/*/luna-client-test.*) rm -rf -- "$ROOT" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cat > "$ROOT/helper.mjs" <<'JS'
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
const [action, home, route, arg] = process.argv.slice(2);
const info = () => JSON.parse(readFileSync(`${home}/daemon.json`, 'utf8'));
async function api(method, route, body) {
  const d = info();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: d.port, path: route, method,
      headers: { 'X-Luna-Token': d.token, 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (action === 'freeze') { resolve({ status: res.statusCode, reason: data }); return; }
        try { resolve({ status: res.statusCode, ...JSON.parse(data) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}
try {
  if (action === 'ready') {
    const d = info(), h = await api('GET', '/health');
    if (!h.ok || h.pid !== d.pid) process.exit(1);
    appendFileSync(route, `${d.pid}\n${h.appServerPid}\n`);
  } else if (action === 'api') {
    const body = arg ? readFileSync(arg, 'utf8') : undefined;
    process.stdout.write(JSON.stringify(await api(body ? 'POST' : 'GET', route, body)));
  } else if (action === 'freeze') {
    const seconds = Number(route);
    const result = await api('POST', `/test/block?ms=${seconds * 1000}`);
    if (result.status !== 200) throw new Error(`freeze HTTP ${result.status}: ${result.reason}`);
    if (arg) appendFileSync(arg, 'blocked\n');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  } else if (action === 'turns') {
    const entries = readFileSync(home, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const turns = entries.filter((entry) => entry.method === 'turn/start' && entry.params.input[0].text === route);
    process.stdout.write(`${turns.length}\n`);
  } else if (action === 'cancel' || action === 'owner' || action === 'orphaned') {
    const marker = readFileSync(route, 'utf8');
    const id = /^id=(.+)$/m.exec(marker)?.[1];
    if (!id) process.exit(1);
    if (action === 'cancel') await api('POST', `/jobs/${id}/cancel`);
    else {
      const job = (await api('GET', '/jobs')).jobs.find((job) => job.id === id);
      if (action === 'orphaned') {
        if (job?.orphaned !== true) process.exit(1);
      } else {
        const expected = arg === 'pid' ? `pid-${job?.clientPid}` : arg;
        if (!job || job.owner !== expected) process.exit(1);
      }
    }
  } else if (action === 'stop') {
    await api('POST', '/stop');
  } else if (action === 'kill') {
    process.kill(info().pid, 'SIGKILL');
  } else if (action === 'cleanup') {
    for (const pid of new Set(readFileSync(route, 'utf8').trim().split(/\s+/).map(Number))) {
      if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
} catch (error) {
  if (action === 'freeze') console.error(error.message);
  process.exitCode = 1;
}
JS
cat > "$ROOT/fake-exec" <<'SH'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
cat >/dev/null
printf 'TEMP=%s\nTMP=%s\nTMPDIR=%s\n' "${TEMP:-}" "${TMP:-}" "${TMPDIR:-}"
if [ -f "${TEMP:-}/.owner" ]; then printf 'TEMP_OWNER=%s\n' "$(cat "$TEMP/.owner")"; fi
if [ "${LUNA_FAKE_WAIT:-0}" = 1 ]; then sleep 60; fi
printf 'fake exec answer\n' > "$out"
printf 'fake-exec\n' >> "$LUNA_FAKE_AUDIT"
SH
chmod +x "$ROOT/fake-exec"
touch "$ROOT/pids"
touch "$ROOT/fake-audit"
check() {
  local name="$1"; shift
  if "$@"; then
    echo "PASS $name"; passed=$((passed + 1))
  else
    echo "FAIL $name"; failed=$((failed + 1))
  fi
}
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1 | tr -d '\r'; }
has_state() { [ "$(field state "$1.status")" = "$2" ]; }
wait_state() {
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do has_state "$1" "$2" && return 0; sleep 0.1; done
  return 1
}
wait_turn() {
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do
    [ -n "$(field turn "$1.daemon")" ] && return 0
    sleep 0.1
  done
  return 1
}
start_daemon() {
  serial=$((serial + 1))
  DAEMON_DIR="$ROOT/daemon-$serial"; mkdir -p "$DAEMON_DIR"
  export LUNA_DAEMON_HOME="$(native "$DAEMON_DIR")"
  export LUNA_ADMIT_LOCK="$(native "$DAEMON_DIR/admit.lock")"
  export LUNA_DAEMON_MAX=1 LUNA_DAEMON_QUEUE_MAX=64 LUNA_DAEMON_QUEUE_BYTES=33554432
  export LUNA_DAEMON_OWNER_MAX=0
  export LUNA_DAEMON_TEST_HOOKS=1
  export LUNA_DAEMON_IDLE_S=0 LUNA_DAEMON_RAMP_MS=10 LUNA_DAEMON_RPC_TIMEOUT_MS=1000
  export LUNA_RAM_RESERVE_MB=0 LUNA_DAEMON_TURN_MB=0 LUNA_DAEMON=1 LUNA_NO_GATE=1
  export LUNA_LOW_PRIORITY=0 LUNA_JOB_TEMP=1 LUNA_NO_REGISTRY=1
  export LUNA_RAMP_S=0 LUNA_WAIT_MAX_S=40 LUNA_IDLE_MAX_S=0 LUNA_TIMEOUT_S=0
  export LUNA_NO_PREAMBLE=1 LUNA_NO_REFUSAL_RETRY=1 LUNA_STUB_DELAY_MS=1500
  export LUNA_FAKE_AUDIT="$(native "$ROOT/fake-audit")"
  export LUNA_CODEX_BIN="$(native "$ROOT/fake-exec")" LUNA_DIRECT_EXE=0
  LUNA_DAEMON_APP_SERVER_CMD=$(node -e \
    'process.stdout.write(JSON.stringify([process.execPath, ...process.argv.slice(1)]))' \
    "$(native "$SCRIPT_DIR/lib/luna-daemon-stub.mjs")" "$(native "$DAEMON_DIR/audit")")
  export LUNA_DAEMON_APP_SERVER_CMD
  node "$(native "$SCRIPT_DIR/luna-daemon.mjs")" --serve > "$DAEMON_DIR/launcher.log" 2>&1 &
  clients+=("$!")
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do
    helper ready "$LUNA_DAEMON_HOME" "$PIDS" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}
run_client() {
  local name="$1" mode="$2" prompt="$3"
  OUT="$ROOT/$name.md"
  bash "$SCRIPT_DIR/luna.sh" "$mode" ${CLIENT_MODEL:+-m "$CLIENT_MODEL"} -C "$ROOT" -o "$OUT" "$prompt" \
    > "$OUT.stdout" 2> "$OUT.stderr" &
  CLIENT=$!; clients+=("$CLIENT")
}
reap() { if wait "$1"; then RC=0; else RC=$?; fi; }
equals() { [ "$1" = "$2" ]; }
starts_with() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }
hard_kill() { taskkill //PID "$(cat /proc/$1/winpid)" //T //F >/dev/null 2>&1 || true; }
killed_without_trap() {
  case "$(field state "$OUT.status")" in
    starting|queued|running|waiting-*) return 0 ;;
    *) return 1 ;;
  esac
}
cancelled_in_audit() {
  local turn
  turn=$(field turn "$1.daemon")
  [ -n "$turn" ] && grep '"method":"turn/interrupt"' "$DAEMON_DIR/audit" | grep -qF "\"turnId\":\"$turn\""
}

if start_daemon; then
  LUNA_OWNER=client-owner CLAUDE_CODE_SESSION_ID=ignored-session run_client normal -r hello
  reap "$CLIENT"
  check 'normal job rc 0 and out file' test "$RC" = 0
  check 'normal answer written' grep -q 'answer hello' "$OUT"
  check 'LUNA_OWNER is propagated ahead of session id' helper owner \
    "$LUNA_DAEMON_HOME" "$(native "$OUT.daemon")" client-owner

  LUNA_OWNER= CLAUDE_CODE_SESSION_ID=client-session run_client session-owner -r hello
  reap "$CLIENT"
  check 'session id is the fallback owner' helper owner \
    "$LUNA_DAEMON_HOME" "$(native "$OUT.daemon")" client-session

  LUNA_OWNER= CLAUDE_CODE_SESSION_ID= run_client pid-owner -r hello
  reap "$CLIENT"
  check 'client pid is the final fallback owner' helper owner "$LUNA_DAEMON_HOME" "$(native "$OUT.daemon")" pid

  run_client holder -r 'WAIT holder'; holder_pid=$CLIENT; holder_out=$OUT
  check 'holder turn started' wait_turn "$holder_out"
  run_client queued -r 'DELAY:2500 queued'; queued_pid=$CLIENT; queued_out=$OUT
  check 'client reports queued' wait_state "$queued_out" queued
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$holder_out.daemon")" >/dev/null
  check 'client switches queued to running' wait_state "$queued_out" running
  reap "$queued_pid"; check 'queued client completes' equals "$RC" 0
  reap "$holder_pid"

  run_client wait-holder -r 'WAIT wait-holder'; holder_pid=$CLIENT; holder_out=$OUT
  check 'queue timeout holder started' wait_turn "$holder_out"
  LUNA_WAIT_MAX_S=1 run_client queue-timeout -r hello
  reap "$CLIENT"; check 'queued wait budget returns 75' equals "$RC" 75
  check 'queued wait error is preserved' equals "$(field error "$OUT.status")" \
    'gave up waiting in daemon queue'
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$holder_out.daemon")" >/dev/null
  reap "$holder_pid"

  run_client term -r 'WAIT term'
  check 'TERM target turn started' wait_turn "$OUT"
  kill -TERM "$CLIENT"; reap "$CLIENT"
  check 'TERM returns 130' equals "$RC" 130
  check 'cancel reaches daemon' cancelled_in_audit "$OUT"

  LUNA_IDLE_MAX_S=1 run_client idle -r 'WAIT idle'
  reap "$CLIENT"; check 'idle stall returns 124' equals "$RC" 124

  run_client die-read -r 'WAIT die-read'
  check 'read retry target turn started' wait_turn "$OUT"
  helper kill "$LUNA_DAEMON_HOME"
  reap "$CLIENT"; check 'daemon death retries read-only through exec' equals "$RC" 0
  check 'fake exec wrote retry answer' grep -q 'fake exec answer' "$OUT"
else
  check 'first daemon starts' false
fi

if start_daemon; then
  before=$(wc -l < "$ROOT/fake-audit" 2>/dev/null || echo 0)
  run_client die-write -w 'WAIT die-write'
  check 'write target turn started' wait_turn "$OUT"
  helper kill "$LUNA_DAEMON_HOME"
  reap "$CLIENT"; check 'daemon death fails write job' equals "$RC" 1
  after=$(wc -l < "$ROOT/fake-audit" 2>/dev/null || echo 0)
  check 'write job never uses exec retry' equals "$before" "$after"
else
  check 'write-test daemon starts' false
fi

if start_daemon; then
  # A single queued slot makes the third wrapper receive 429 before its body is read.
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
  end=$((SECONDS + 10))
  while [ -f "$DAEMON_DIR/daemon.json" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  export LUNA_DAEMON_QUEUE_MAX=1
  node "$(native "$SCRIPT_DIR/luna-daemon.mjs")" --serve >> "$DAEMON_DIR/launcher.log" 2>&1 &
  clients+=("$!")
  end=$((SECONDS + 30))
  until helper ready "$LUNA_DAEMON_HOME" "$PIDS" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || break
    sleep 0.2
  done
  run_client full-holder -r 'WAIT full-holder'; holder_pid=$CLIENT; holder_out=$OUT
  check 'queue-full holder started' wait_turn "$holder_out"
  run_client full-queued -r 'DELAY:2500 full-queued'; queued_pid=$CLIENT; queued_out=$OUT
  check 'queue-full queued client visible' wait_state "$queued_out" queued
  run_client full-retry -r 'DELAY:1500 full-retry'; retry_pid=$CLIENT; retry_out=$OUT
  check '429 reports waiting-daemon' wait_state "$retry_out" waiting-daemon
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$holder_out.daemon")" >/dev/null
  reap "$retry_pid"; check '429 retries to success' equals "$RC" 0
  check '429 uses daemon answer' grep -q 'answer DELAY:1500 full-retry' "$retry_out"
  reap "$queued_pid"; reap "$holder_pid"

  run_client expiry-holder -r 'WAIT expiry-holder'; holder_pid=$CLIENT; holder_out=$OUT
  check '429 expiry holder started' wait_turn "$holder_out"
  run_client expiry-queued -r 'WAIT expiry-queued'; queued_pid=$CLIENT; queued_out=$OUT
  check '429 expiry queue populated' wait_state "$queued_out" queued
  before=$(wc -l < "$ROOT/fake-audit")
  LUNA_WAIT_MAX_S=1 run_client full-timeout -r hello
  reap "$CLIENT"; check '429 wait budget returns 75' equals "$RC" 75
  check '429 timeout reports daemon queue full' equals "$(field error "$OUT.status")" 'daemon queue full'
  check '429 timeout never falls back to exec' equals "$before" "$(wc -l < "$ROOT/fake-audit")"
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$queued_out.daemon")" >/dev/null
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$holder_out.daemon")" >/dev/null
  reap "$queued_pid"; reap "$holder_pid"
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'queue-test daemon starts' false
fi

if start_daemon; then
  run_client busy -r 'DELAY:12000 busy'
  check 'busy target turn started' wait_turn "$OUT"
  helper freeze "$LUNA_DAEMON_HOME" 10 &
  freeze_pid=$!
  reap "$CLIENT"; check 'frozen daemon is busy, not dead' equals "$RC" 0
  check 'busy daemon answer written' grep -q 'answer DELAY:12000 busy' "$OUT"
  check 'busy daemon status has no error' equals "$(field error "$OUT.status")" ''
  reap "$freeze_pid"; check 'busy freeze helper succeeds' equals "$RC" 0
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'busy-test daemon starts' false
fi

if start_daemon; then
  LUNA_DAEMON_BUSY_MAX_S=3 run_client busy-max -w 'WAIT busy-max'
  check 'busy budget target turn started' wait_turn "$OUT"
  helper freeze "$LUNA_DAEMON_HOME" 10 &
  freeze_pid=$!
  reap "$CLIENT"; check 'busy budget still ends a frozen daemon' equals "$RC" 1
  check 'busy budget records daemon death' starts_with "$(field error "$OUT.status")" 'daemon died'
  reap "$freeze_pid"; check 'busy budget freeze helper succeeds' equals "$RC" 0
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'busy-budget daemon starts' false
fi

export LUNA_DAEMON_CLIENT_CHECK_MS=200 LUNA_DAEMON_ORPHAN_GRACE_S=20
if start_daemon; then
  run_client reattach -w 'DELAY:6000 reattach'
  check 'reattach target turn started' wait_turn "$OUT"
  id1=$(field id "$OUT.daemon")
  hard_kill "$CLIENT"; reap "$CLIENT"
  check 'reattach wrapper killed without traps' killed_without_trap
  end=$((SECONDS + 15))
  until helper orphaned "$LUNA_DAEMON_HOME" "$(native "$OUT.daemon")"; do
    [ "$SECONDS" -lt "$end" ] || break
    sleep 0.1
  done
  check 'reattach target becomes orphaned' helper orphaned "$LUNA_DAEMON_HOME" "$(native "$OUT.daemon")"
  run_client reattach -w 'DELAY:6000 reattach'
  reap "$CLIENT"; check 'killed wrapper: resubmission attaches and completes once' equals "$RC" 0
  check 'reattached answer written' grep -q 'answer DELAY:6000 reattach' "$OUT"
  check 'reattach preserves daemon job id' equals "$(field daemon_job "$OUT.status")" "$id1"
  turns=$(helper turns "$(native "$DAEMON_DIR/audit")" $'DELAY:6000 reattach\n')
  check 'reattach starts only one turn' equals "$turns" 1
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'reattach-test daemon starts' false
fi
unset LUNA_DAEMON_CLIENT_CHECK_MS LUNA_DAEMON_ORPHAN_GRACE_S

export LUNA_DAEMON_CLIENT_CHECK_MS=200 LUNA_DAEMON_ORPHAN_GRACE_S=2
if start_daemon; then
  run_client orphan-expiry -r 'WAIT orphan-expiry'
  check 'orphan expiry target turn started' wait_turn "$OUT"
  hard_kill "$CLIENT"; reap "$CLIENT"
  check 'orphan expiry wrapper killed without traps' killed_without_trap
  end=$((SECONDS + 15))
  while [ "$(field state "$OUT.daemon")" != cancelled ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  check 'orphan expires within grace budget' equals "$(field state "$OUT.daemon")" cancelled
  check 'expired orphan records client gone' equals "$(field error "$OUT.daemon")" 'client gone'
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'orphan-expiry daemon starts' false
fi
unset LUNA_DAEMON_CLIENT_CHECK_MS LUNA_DAEMON_ORPHAN_GRACE_S

if start_daemon; then
  run_client conflict -r 'WAIT conflict-holder'; holder_pid=$CLIENT; holder_out=$OUT
  check 'conflict holder turn started' wait_turn "$holder_out"
  holder_marker=$(cat "$holder_out.daemon")
  before=$(wc -l < "$ROOT/fake-audit")
  run_client conflict -r 'WAIT conflict-other'
  reap "$CLIENT"; check '409 output conflict fails' equals "$RC" 1
  check '409 output conflict records failed state' equals "$(field state "$OUT.status")" failed
  check '409 output conflict records rc 1' equals "$(field rc "$OUT.status")" 1
  check '409 output conflict error is preserved' equals "$(field error "$OUT.status")" \
    'output or log already in use by another daemon job'
  check '409 never falls back to exec' equals "$before" "$(wc -l < "$ROOT/fake-audit")"
  check '409 restores the live job marker' equals "$(field id "$holder_out.daemon")" \
    "$(printf '%s\n' "$holder_marker" | sed -n 's/^id=//p')"
  helper cancel "$LUNA_DAEMON_HOME" "$(native "$holder_out.daemon")" >/dev/null
  reap "$holder_pid"
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'conflict-test daemon starts' false
fi

export LUNA_DAEMON_ORPHAN_GRACE_S=600 LUNA_DAEMON_CLIENT_CHECK_MS=200
if start_daemon; then
  run_client stop-orphan -r 'WAIT stop-orphan'
  check 'stop orphan target turn started' wait_turn "$OUT"
  hard_kill "$CLIENT"; reap "$CLIENT"
  check 'stop orphan wrapper killed without traps' killed_without_trap
  bash "$SCRIPT_DIR/luna-stop.sh" "$OUT"
  stop_rc=$?
  check 'luna-stop cancels an orphan' equals "$stop_rc" 0
  end=$((SECONDS + 10))
  while [ "$(field state "$OUT.daemon")" != cancelled ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  check 'stopped orphan marker becomes cancelled' equals "$(field state "$OUT.daemon")" cancelled
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'stop-orphan daemon starts' false
fi
unset LUNA_DAEMON_CLIENT_CHECK_MS LUNA_DAEMON_ORPHAN_GRACE_S

if start_daemon; then
  for mode in -r -w; do
    before=$(wc -l < "$ROOT/fake-audit")
    CLIENT_MODEL=hang-thread run_client "thread-timeout-${mode#-}" "$mode" 'no turn should run'
    reap "$CLIENT"
    check "$mode thread-start-timeout falls back successfully" equals "$RC" 0
    check "$mode thread-start-timeout invokes exec exactly once" \
      equals "$(( before + 1 ))" "$(wc -l < "$ROOT/fake-audit")"
    check "$mode thread-start-timeout records fallback" equals "$(field fallback "$OUT.status")" exec
    check "$mode thread-start-timeout records reason" equals "$(field reason "$OUT.status")" thread-start-timeout
    check "$mode thread-start-timeout writes an exec answer" grep -q 'fake exec answer' "$OUT"
  done
  check 'timed-out thread starts never start a daemon turn' \
    equals "$(helper turns "$(native "$DAEMON_DIR/audit")" $'no turn should run\n')" 0
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'thread-start-timeout daemon starts' false
fi

if start_daemon; then
  before=$(grep -c '"event":"spawn"' "$DAEMON_DIR/audit")
  discovery_before=$(cat "$DAEMON_DIR/daemon.json")
  log_before=$(cat "$DAEMON_DIR/daemon.log")
  helper freeze "$LUNA_DAEMON_HOME" 25 "$(native "$ROOT/startup-blocked")" &
  freeze_pid=$!
  end=$((SECONDS + 10))
  while [ ! -f "$ROOT/startup-blocked" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  LUNA_NO_GATE=0 LUNA_DAEMON_BUSY_MAX_S=3 run_client slow-start -w hello
  check 'alive slow startup reports waiting-daemon' wait_state "$OUT" waiting-daemon
  check 'alive slow startup releases shared admission while waiting' test ! -d "$DAEMON_DIR/admit.lock"
  reap "$CLIENT"; check 'alive slow startup falls back after busy budget' equals "$RC" 0
  check 'alive slow startup uses exec' grep -q 'fake exec answer' "$OUT"
  check 'alive slow startup preserves discovery' equals "$discovery_before" "$(cat "$DAEMON_DIR/daemon.json")"
  check 'alive slow startup spawns no second app-server' \
    equals "$before" "$(grep -c '"event":"spawn"' "$DAEMON_DIR/audit")"
  check 'alive slow startup never launches a second daemon' equals "$log_before" "$(cat "$DAEMON_DIR/daemon.log")"
  reap "$freeze_pid"; check 'startup freeze helper succeeds' equals "$RC" 0
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'slow-start daemon starts' false
fi

# The switch lives only under TEST_HOME; an explicit environment value wins.
if start_daemon; then
  mkdir -p "$HOME/.claude"
  touch "$HOME/.claude/luna-daemon-off"
  unset LUNA_DAEMON
  run_client file-off -r hello
  reap "$CLIENT"; check 'daemon-off file selects exec' equals "$(field engine "$OUT.status")" exec
  LUNA_DAEMON=1 run_client file-overridden -r hello
  reap "$CLIENT"; check 'explicit LUNA_DAEMON=1 ignores off file' equals "$(field engine "$OUT.status")" daemon
  rm -f "$HOME/.claude/luna-daemon-off"
  helper stop "$LUNA_DAEMON_HOME" >/dev/null
else
  check 'off-switch daemon starts' false
fi

export LUNA_DAEMON=0
DAEMON_DIR="$ROOT/exec-temp"; mkdir -p "$DAEMON_DIR/tmp"
export LUNA_DAEMON_HOME="$(native "$DAEMON_DIR")"
mkdir -p "$ROOT/priority-stubs"
cat > "$ROOT/priority-stubs/wmic" <<'SH'
#!/usr/bin/env bash
printf 'priority\n' >> "$LUNA_PRIORITY_AUDIT"
SH
cp "$ROOT/priority-stubs/wmic" "$ROOT/priority-stubs/renice"
cat > "$ROOT/priority-stubs/powershell" <<'SH'
#!/usr/bin/env bash
case "$*" in *PriorityClass*) printf 'priority\n' >> "$LUNA_PRIORITY_AUDIT" ;; esac
SH
chmod +x "$ROOT/priority-stubs/"*
export PATH="$ROOT/priority-stubs:$PATH"
export LUNA_PRIORITY_AUDIT="$(native "$ROOT/priority-audit")"
: > "$ROOT/priority-audit"
temp_path() {
  local value
  value=$(field TEMP "$OUT.log")
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$value"; else printf '%s\n' "$value"; fi
}
mkdir -p "$DAEMON_DIR/tmp/job-stale" "$DAEMON_DIR/tmp/job-fresh" "$DAEMON_DIR/tmp/other-stale"
mkdir -p "$DAEMON_DIR/tmp/job-live-owner" "$DAEMON_DIR/tmp/job-dead-owner"
printf '%s\n' "$$" > "$DAEMON_DIR/tmp/job-live-owner/.owner"
printf '%s\n' 2147483647 > "$DAEMON_DIR/tmp/job-dead-owner/.owner"
touch -d '2 days ago' "$DAEMON_DIR/tmp/job-stale" "$DAEMON_DIR/tmp/other-stale"
touch -d '2 days ago' "$DAEMON_DIR/tmp/job-live-owner" "$DAEMON_DIR/tmp/job-dead-owner"
unset LUNA_LOW_PRIORITY
run_client exec-temp -r hello
reap "$CLIENT"; check 'exec with small TEMP succeeds' equals "$RC" 0
job_temp=$(temp_path)
check 'exec passes TEMP under daemon home tmp/job-*' starts_with "$job_temp" "$DAEMON_DIR/tmp/job-"
check 'exec TEMP/TMP/TMPDIR match' equals "$(field TEMP "$OUT.log")" "$(field TMP "$OUT.log")"
check 'exec TMPDIR matches TEMP' equals "$(field TEMP "$OUT.log")" "$(field TMPDIR "$OUT.log")"
check 'exec removes per-job TEMP after completion' test ! -d "$job_temp"
check 'exec writes its wrapper owner PID in TEMP' equals "$(field TEMP_OWNER "$OUT.log")" "$CLIENT"
check 'startup sweeps job TEMP older than 24 hours' test ! -d "$DAEMON_DIR/tmp/job-stale"
check 'startup preserves old job TEMP with a live owner' test -d "$DAEMON_DIR/tmp/job-live-owner"
check 'startup removes old job TEMP with a dead owner' test ! -d "$DAEMON_DIR/tmp/job-dead-owner"
check 'startup preserves fresh job TEMP' test -d "$DAEMON_DIR/tmp/job-fresh"
check 'startup preserves unrelated stale directory' test -d "$DAEMON_DIR/tmp/other-stale"
check 'default priority does not invoke a priority command' test ! -s "$ROOT/priority-audit"
LUNA_LOW_PRIORITY=1 run_client exec-low-priority -r hello
reap "$CLIENT"; check 'opt-in priority invokes the priority command' test -s "$ROOT/priority-audit"
LUNA_FAKE_WAIT=1 LUNA_IDLE_MAX_S=1 run_client exec-temp-watchdog -r hello
reap "$CLIENT"; check 'exec TEMP watchdog returns 124' equals "$RC" 124
job_temp=$(temp_path)
check 'watchdog child received dedicated job TEMP' starts_with "$job_temp" "$DAEMON_DIR/tmp/job-"
check 'watchdog removes per-job TEMP' test ! -d "$job_temp"
mkdir -p "$ROOT/inherited-temp"
inherited_temp=$(native "$ROOT/inherited-temp")
TEMP="$inherited_temp" TMP="$inherited_temp" TMPDIR="$inherited_temp" LUNA_JOB_TEMP=0 \
  run_client exec-inherited-temp -r hello
reap "$CLIENT"; check 'LUNA_JOB_TEMP=0 exec succeeds' equals "$RC" 0
check 'LUNA_JOB_TEMP=0 passes inherited TEMP' equals "$(field TEMP "$OUT.log")" "$inherited_temp"
check 'inherited TEMP remains after completion' test -d "$ROOT/inherited-temp"
mkdir -p "$ROOT/unwritable-temp"
touch "$ROOT/unwritable-temp/tmp"
LUNA_DAEMON_HOME="$(native "$ROOT/unwritable-temp")" \
  TEMP="$inherited_temp" TMP="$inherited_temp" TMPDIR="$inherited_temp" \
  run_client exec-unwritable-temp -r hello
reap "$CLIENT"; check 'unwritable job TEMP still runs exec successfully' equals "$RC" 0
check 'unwritable job TEMP passes inherited TEMP' equals "$(field TEMP "$OUT.log")" "$inherited_temp"
check 'unwritable job TEMP records inherited fallback and reason' \
  grep -q '^job_temp=inherited reason=mkdir-failed$' "$OUT.status"
check 'unwritable job TEMP prints one warning' \
  equals "$(grep -c 'warning: job_temp=inherited reason=mkdir-failed' "$OUT.stderr")" 1

# A file as the state directory prevents daemon startup, without touching any real daemon.
export LUNA_DAEMON=1
touch "$ROOT/not-a-directory"
export LUNA_DAEMON_HOME="$(native "$ROOT/not-a-directory")"
run_client fallback -r hello
reap "$CLIENT"; check 'unstartable daemon falls back to exec' equals "$RC" 0
check 'fallback output came from fake exec' grep -q 'fake exec answer' "$OUT"
echo "client test: passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
