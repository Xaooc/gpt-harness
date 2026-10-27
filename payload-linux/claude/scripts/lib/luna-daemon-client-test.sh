#!/usr/bin/env bash
# End-to-end candidate-wrapper tests. Run outside the Codex sandbox with bash and node on PATH.
export LUNA_NO_REGISTRY=1 # tests must not write to the real learning journal
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/luna-client-test.XXXXXX") || exit 1
ROOT=$(cd "$ROOT" && pwd -P) || exit 1
export HOME="$ROOT/home"
mkdir -p "$HOME"
passed=0; failed=0; serial=0
declare -a clients=()
native() { printf '%s\n' "$1"; }

HELPER=$(native "$ROOT/helper.mjs")
PIDS=$(native "$ROOT/pids")
helper() { node "$HELPER" "$@"; }
cleanup() {
  local pid daemon_home
  for pid in "${clients[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for daemon_home in "$ROOT"/daemon-*; do
    helper stop "$(native "$daemon_home/daemon-net")" >/dev/null 2>&1 || true
    helper stop "$(native "$daemon_home")" >/dev/null 2>&1 || true
  done
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
const info = (dir = home) => JSON.parse(readFileSync(`${dir}/daemon.json`, 'utf8'));
async function api(method, route, body, dir = home) {
  const d = info(dir);
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
  } else if (action === 'profiles') {
    const net = `${home}/daemon-net`, a = info(), b = info(net);
    const first = await api('GET', '/health'), second = await api('GET', '/health', undefined, net);
    const entries = readFileSync(route, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const netSpawn = entries.find((entry) => entry.event === 'spawn' && entry.pid === second.appServerPid);
    const defaultSpawn = entries.find((entry) => entry.event === 'spawn' && entry.pid === first.appServerPid);
    const hasNetArg = (entry) => entry?.args.some((value, i, args) =>
      value === '-c' && args[i + 1] === 'sandbox_workspace_write.network_access=true');
    const marker = readFileSync(arg, 'utf8');
    const thread = /^thread=(.+)$/m.exec(marker)?.[1];
    const turns = entries.filter((entry) => entry.method === 'turn/start' &&
      entry.pid === second.appServerPid && entry.params.threadId === thread);
    if (a.pid === b.pid || a.port === b.port || a.token === b.token || !first.ok || !second.ok ||
        first.profile !== 'default' || second.profile !== 'net' || first.protocol !== 2 || second.protocol !== 2 ||
        !second.features.includes('model-retry') || !second.features.includes('profiles') ||
        !defaultSpawn || !netSpawn || hasNetArg(defaultSpawn) || !hasNetArg(netSpawn) || turns.length !== 2 ||
        !turns[1].params.input[0].text.startsWith('LUNA AUTO-RETRY 1/')) process.exit(1);
  } else if (action === 'freeze') {
    const seconds = Number(route);
    const result = await api('POST', `/test/block?ms=${seconds * 1000}`);
    if (result.status !== 200) throw new Error(`freeze HTTP ${result.status}: ${result.reason}`);
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
    const pid = info().pid;
    if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('luna-daemon.mjs')) process.kill(pid, 'SIGKILL');
  } else if (action === 'cleanup') {
    for (const pid of new Set(readFileSync(route, 'utf8').trim().split(/\s+/).map(Number))) {
      if (pid > 0) {
        try {
          const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (/luna-daemon(?:-stub)?\.mjs/.test(command)) process.kill(pid, 'SIGKILL');
        } catch {}
      }
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
wait_discovery_gone() {
  local end=$((SECONDS + 15))
  while [ -e "$1/daemon.json" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  [ ! -e "$1/daemon.json" ]
}
wait_reason() {
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do
    [ "$(field reason "$1.daemon")" = "$2" ] && return 0
    sleep 0.1
  done
  return 1
}
start_daemon() {
  serial=$((serial + 1))
  DAEMON_DIR="$ROOT/daemon-$serial"; mkdir -p "$DAEMON_DIR"
  export LUNA_DAEMON_HOME="$(native "$DAEMON_DIR")"
  export LUNA_DAEMON_PROFILE=default LUNA_NET=0
  export LUNA_ADMIT_LOCK="$(native "$DAEMON_DIR/admit.lock")"
  export LUNA_DAEMON_MAX=1 LUNA_DAEMON_QUEUE_MAX=64 LUNA_DAEMON_QUEUE_BYTES=33554432
  export LUNA_DAEMON_OWNER_MAX=0
  export LUNA_DAEMON_TEST_HOOKS=1
  export LUNA_DAEMON_IDLE_S=0 LUNA_DAEMON_RAMP_MS=10 LUNA_DAEMON_RPC_TIMEOUT_MS=1000
  export LUNA_RAM_RESERVE_MB=0 LUNA_DAEMON_TURN_MB=0 LUNA_DAEMON=1 LUNA_NO_GATE=1
  export LUNA_RAMP_S=0 LUNA_WAIT_MAX_S=40 LUNA_IDLE_MAX_S=0 LUNA_TIMEOUT_S=0
  export LUNA_NO_PREAMBLE=1 LUNA_NO_REFUSAL_RETRY=1 LUNA_STUB_DELAY_MS=1500
  export LUNA_FAKE_AUDIT="$(native "$ROOT/fake-audit")"
  export LUNA_CODEX_BIN="$(native "$ROOT/fake-exec")"
  LUNA_DAEMON_APP_SERVER_CMD=$(node -e \
    'process.stdout.write(JSON.stringify([process.execPath, ...process.argv.slice(1)]))' \
    "$(native "$SCRIPT_DIR/lib/luna-daemon-stub.mjs")" "$(native "$DAEMON_DIR/audit")")
  export LUNA_DAEMON_APP_SERVER_CMD
  node "$(native "$SCRIPT_DIR/luna-daemon.mjs")" --serve > "$DAEMON_DIR/launcher.log" 2>&1 &
  local launcher_pid=$!
  clients+=("$launcher_pid")
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do
    helper ready "$LUNA_DAEMON_HOME" "$PIDS" >/dev/null 2>&1 && return 0
    kill -0 "$launcher_pid" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
run_client() {
  local name="$1" mode="$2" prompt="$3"
  OUT="$ROOT/$name.md"
  bash "$SCRIPT_DIR/luna.sh" "$mode" -C "$ROOT" -o "$OUT" "$prompt" \
    > "$OUT.stdout" 2> "$OUT.stderr" &
  CLIENT=$!; clients+=("$CLIENT")
}
reap() { if wait "$1"; then RC=0; else RC=$?; fi; }
equals() { [ "$1" = "$2" ]; }
starts_with() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }
hard_kill() {
  # The daemon publishes a turn before the wrapper's next poll updates its status.
  wait_state "$OUT" running || return 1
  if tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q 'luna.sh'; then
    kill -KILL "$1" 2>/dev/null || true
  fi
}
killed_without_trap() { [ "$RC" = 137 ] && [ "$(field state "$OUT.status")" = running ]; }
cancelled_in_audit() {
  local turn
  turn=$(field turn "$1.daemon")
  [ -n "$turn" ] && grep '"method":"turn/interrupt"' "$DAEMON_DIR/audit" | grep -qF "\"turnId\":\"$turn\""
}

if start_daemon; then
  LUNA_NET=1 LUNA_MODEL_RETRY_DELAY_S=1 run_client net-retry -w 'MODEL_FAIL_ONCE:Selected model is at capacity'
  reap "$CLIENT"
  check 'network write completes in the net daemon' equals "$RC" 0
  check 'network write records daemon engine and profile' equals "$(field engine "$OUT.status")" daemon
  check 'network write records the net profile' equals "$(field daemon_profile "$OUT.status")" net
  check 'profiles coexist with separate discovery and net retry uses one thread' helper profiles \
    "$LUNA_DAEMON_HOME" "$(native "$DAEMON_DIR/audit")" "$(native "$OUT.daemon")"
  check 'net retry delay is reported within jitter bounds' node -e '
    const fs = require("fs");
    const status = fs.readFileSync(process.argv[1] + ".status", "utf8");
    const log = fs.readFileSync(process.argv[1] + ".log", "utf8");
    const delay = /^model_retry_delay_s=(\d+\.\d{3})$/m.exec(status)?.[1];
    if (!(Number(delay) >= 1 && Number(delay) <= 1.3) || !log.includes(`same session in ${delay}s`)) process.exit(1);
  ' "$(native "$OUT")"
  helper ready "$LUNA_DAEMON_HOME/daemon-net" "$PIDS" >/dev/null 2>&1 || true
  end=$((SECONDS + 10))
  while [ -e "$LUNA_ADMIT_LOCK" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  if mkdir "$LUNA_ADMIT_LOCK"; then
    printf 'pid=%s\npid_start=%s\nkind=test\nsince=%s\ntoken=fixture\n' "$$" \
      "$(node "$SCRIPT_DIR/lib/luna-runtime.mjs" --start "$$")" "$(date +%s)" > "$LUNA_ADMIT_LOCK/owner"
    run_client shared-default -r 'WAIT shared-default'; default_pid=$CLIENT; default_out=$OUT
    LUNA_NET=1 run_client shared-net -w 'WAIT shared-net'; net_pid=$CLIENT; net_out=$OUT
    check 'shared admission lock blocks the default profile' wait_reason "$default_out" lock
    check 'shared admission lock blocks the net profile' wait_reason "$net_out" lock
    rm -f "$LUNA_ADMIT_LOCK/owner"
    rmdir "$LUNA_ADMIT_LOCK"
    check 'default profile resumes after shared lock release' wait_turn "$default_out"
    check 'net profile resumes after shared lock release' wait_turn "$net_out"
    helper cancel "$LUNA_DAEMON_HOME" "$(native "$default_out.daemon")" >/dev/null
    helper cancel "$LUNA_DAEMON_HOME/daemon-net" "$(native "$net_out.daemon")" >/dev/null
    reap "$default_pid"; reap "$net_pid"
  else
    check 'shared admission lock fixture is available' false
  fi
  check 'status selects the net profile' bash -c '
    node "$1" --status --profile net | node -e '\''
      let data = ""; process.stdin.on("data", (chunk) => data += chunk);
      process.stdin.on("end", () => { if (JSON.parse(data.split("\n")[0]).profile !== "net") process.exit(1); });
    '\''
  ' _ "$SCRIPT_DIR/luna-daemon.mjs"
  node "$SCRIPT_DIR/luna-daemon.mjs" --stop --profile net
  check 'profile stop removes only net discovery' wait_discovery_gone "$LUNA_DAEMON_HOME/daemon-net"
  check 'profile stop leaves default daemon healthy' helper ready "$LUNA_DAEMON_HOME" "$PIDS"

  LUNA_NET=1 run_client net-orphan -w 'WAIT net-orphan'
  check 'network orphan turn started' wait_turn "$OUT"
  hard_kill "$CLIENT"; reap "$CLIENT"
  check 'network orphan wrapper was killed' killed_without_trap
  check 'stop finds the network daemon for an orphan' bash "$SCRIPT_DIR/luna-stop.sh" "$OUT"
  end=$((SECONDS + 10))
  while [ "$(field state "$OUT.daemon")" != cancelled ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
  check 'network orphan was cancelled' equals "$(field state "$OUT.daemon")" cancelled
  check 'network cancellation leaves the default daemon healthy' helper ready "$LUNA_DAEMON_HOME" "$PIDS"
  helper ready "$LUNA_DAEMON_HOME/daemon-net" "$PIDS" >/dev/null 2>&1 || true

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

if start_daemon; then
  LUNA_NET=1 run_client stop-both -w 'stop both'
  reap "$CLIENT"
  check 'second profile starts for stop-both check' equals "$RC" 0
  helper ready "$LUNA_DAEMON_HOME/daemon-net" "$PIDS" >/dev/null 2>&1 || true
  LUNA_DAEMON_PROFILE=net node "$SCRIPT_DIR/luna-daemon.mjs" --stop
  check 'unqualified stop removes default discovery' wait_discovery_gone "$LUNA_DAEMON_HOME"
  check 'unqualified stop removes net discovery' wait_discovery_gone "$LUNA_DAEMON_HOME/daemon-net"
else
  check 'stop-both daemon starts' false
fi

mkdir -p "$HOME/.claude"
touch "$HOME/.claude/luna-daemon-off"
LUNA_NET=1 run_client disabled-net -w 'disabled net'
reap "$CLIENT"; check 'daemon off disables the network profile' equals "$(field engine "$OUT.status")" exec
run_client disabled-default -r 'disabled default'
reap "$CLIENT"; check 'daemon off disables the default profile' equals "$(field engine "$OUT.status")" exec
rm -f "$HOME/.claude/luna-daemon-off"

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

# A file as the state directory prevents daemon startup, without touching any real daemon.
touch "$ROOT/not-a-directory"
export LUNA_DAEMON_HOME="$(native "$ROOT/not-a-directory")"
run_client fallback -r hello
reap "$CLIENT"; check 'unstartable daemon falls back to exec' equals "$RC" 0
check 'fallback output came from fake exec' grep -q 'fake exec answer' "$OUT"
echo "client test: passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
