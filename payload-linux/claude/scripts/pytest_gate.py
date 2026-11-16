"""Machine-wide gate for pytest runs, so parallel executors cannot freeze the PC or fill the disk.

Usage (from the repo or worktree root, any shell):
    python3 ~/.claude/scripts/pytest_gate.py -n 4 -- tests/engine_v2/test_x.py -q

It waits until `n` worker slots are free in a shared pool (POOL_SIZE total across
all runs on this machine) and until free RAM is above MIN_FREE_GB, then runs
`python -m uv run pytest -n <n> <args>` in the current directory, releases the
slots and exits with pytest's own exit code. The OS releases locks when their owner exits.

Disk and garbage (owner rule 2026-10-24: test runs must not kill the SSD or leave files):
- a run does not start while the temp drive has less than MIN_FREE_DISK_GB free (exit 75);
- `-n`/`--numprocesses` given after `--` count too: the cap and the slots are what pytest
  really starts;
- every run gets its own --basetemp under RUNS_DIR (unless the caller passed one) and
  `tmp_path_retention_policy=failed`, so only failing tests keep their directories;
- a green run deletes its directory; a red one keeps it for inspection, and runs older
  than KEEP_HOURS (or beyond the newest KEEP_FAILED) are deleted at the next start;
- workers default to 4 and are capped at MAX_WORKERS (default 4) and POOL_SIZE.

Queue: flocked tickets are served FIFO. A smaller run may backfill only while the
oldest eligible ticket has been head for less than BACKFILL_SECONDS and no earlier
waiter fits. After that, slots stay idle until the head fits; its extra delay is
bounded by the window plus the runtime of runs admitted during it. With finite
runs, active waiters each become head and do not starve. Ticket liveness uses
flock, not PIDs, since PIDs differ between namespaces. Frozen tickets are skipped
until they heartbeat. Use --status to inspect the pool. During a transition, old
gates ignore tickets and queue.lock and compete with the head for slots; once old
waiters drain, the head is served. A freed slot can remain idle for one poll
interval. A stopped queue.lock holder is reported by waiters and by --status,
which shows a read-only snapshot if it cannot acquire the lock.
"""

from __future__ import annotations

import errno
import os
import secrets
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

if sys.platform == "linux":
    import fcntl

def usable_cpus() -> int:
    if sys.platform == "linux" and hasattr(os, "sched_getaffinity"):
        try:
            return max(1, len(os.sched_getaffinity(0)))
        except OSError:
            pass
    return max(1, os.cpu_count() or 1)


POOL_SIZE = max(1, int(os.environ.get("PYTEST_GATE_POOL", str(usable_cpus()))))
MIN_FREE_GB = float(os.environ.get("PYTEST_GATE_MIN_FREE_GB", "2.0"))
MIN_FREE_DISK_GB = float(os.environ.get("PYTEST_GATE_MIN_FREE_DISK_GB", "10"))
MAX_WORKERS = max(1, int(os.environ.get("PYTEST_GATE_MAX_WORKERS", str(min(4, POOL_SIZE)))))
SERIAL_MAX = max(0, int(os.environ.get("PYTEST_GATE_SERIAL_MAX", "3")))
KEEP_HOURS = float(os.environ.get("PYTEST_GATE_KEEP_HOURS", "24"))
KEEP_FAILED = int(os.environ.get("PYTEST_GATE_KEEP_FAILED", "3"))
def default_slot_dir() -> Path:
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return Path("/tmp") / f"pytest-gate-{uid}"


SLOT_DIR = Path(os.environ.get("PYTEST_GATE_DIR") or default_slot_dir())
POOL_IS_PRIVATE = False
RUNS_DIR = Path(os.environ.get("PYTEST_GATE_RUNS", Path(tempfile.gettempdir()) / "pytest-gate-runs"))
POLL_SECONDS = float(os.environ.get("PYTEST_GATE_POLL_S", "5"))
BACKFILL_SECONDS = float(os.environ.get("PYTEST_GATE_BACKFILL_S", "600"))
FROZEN_SECONDS = float(os.environ.get("PYTEST_GATE_FROZEN_S", "120"))
REFUSED_DISK = 75  # not a pytest exit code (pytest uses 0-5)
GREEN = {0, 5}  # passed, or nothing collected: no failing test dir worth keeping
RUN_SLOTS = ""
RUN_PYTEST_WORKERS = ""


def free_ram_gb() -> float:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1024**2
    raise RuntimeError("MemAvailable missing from /proc/meminfo")


def free_disk_gb(path: Path) -> float:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free / 1024**3


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_identity(pid: int) -> dict | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        return {"pid": pid, "start": fields[19], "pgid": int(fields[2]),
                "state": fields[0], "command": command}
    except (OSError, ValueError, IndexError):
        return None


def same_process(pid: int, start: str, pattern: str = "pytest_gate.py") -> bool:
    row = process_identity(pid)
    return bool(row and row["state"] != "Z" and start and row["start"] == start
                and pattern in row["command"])


def group_members(pgid: int, start: str) -> list[dict]:
    if pgid <= 1 or not start.isdigit():
        return []
    leader = process_identity(pgid)
    if leader and leader["start"] != start:
        return []  # the group id has been reused
    rows = (process_identity(int(entry.name)) for entry in Path("/proc").iterdir() if entry.name.isdigit())
    return [row for row in rows if row and row["pgid"] == pgid and row["state"] != "Z"
            and int(row["start"]) >= int(start)]


def signal_group(pgid: int, start: str, sig: int) -> None:
    if not group_members(pgid, start):
        return
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def stop_group(pgid: int, start: str) -> None:
    signal_group(pgid, start, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while group_members(pgid, start) and time.monotonic() < deadline:
        time.sleep(0.05)
    signal_group(pgid, start, signal.SIGKILL)
    # Keep reservations until live members have actually exited.
    while group_members(pgid, start):
        time.sleep(0.05)


def pid_namespace() -> str:
    try:
        return os.readlink("/proc/self/ns/pid")
    except OSError:
        return ""


def slot_text(pgid: int = 0, child_start: str = "") -> str:
    start = process_identity(os.getpid())["start"]
    return (f"{os.getpid()} {os.getcwd()}\n" +
            f"pid_start={start}\npgid={pgid}\npgid_start={child_start}\n" +
            f"time={time.time():.6f}\nslots={RUN_SLOTS}\n" +
            f"pytest_workers={RUN_PYTEST_WORKERS}\npidns={pid_namespace()}\n")


def _owner_pids(run: Path) -> list[int]:
    """The gate and its pytest child that own a run (``<run>.owner``, beside the run dir:
    pytest wipes ``--basetemp`` at start). Without the file, the gate pid in the name."""
    owner = run.with_name(run.name + ".owner")
    try:
        lines = owner.read_text().splitlines()
        pids = [int(value) for value in lines[0].split()]
        starts = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
        live = []
        for index, pid in enumerate(pids):
            start = starts.get(f"start_{pid}", "")
            pattern = "pytest_gate.py" if index == 0 else "-m uv"
            if same_process(pid, start, pattern) or (index > 0 and same_process(pid, start, "pytest")):
                live.append(pid)
        return live
    except (OSError, ValueError, IndexError):
        return []


XDIST_WORKER = "exec(eval(sys.stdin.readline()))"  # execnet's popen worker bootstrap


def _processes() -> list[dict] | None:
    """Every running process (pid, parent pid, command line, creation time), or None."""
    rows = []
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return None
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            rows.append({"ProcessId": int(entry.name), "ParentProcessId": int(stat[1]),
                         "Created": int(stat[19]), "CommandLine": command})
        except FileNotFoundError:
            continue  # exited during the snapshot
        except (OSError, ValueError, IndexError):
            return None  # incomplete ancestry must protect temp runs
    return rows


def _covered(worker: dict, processes: list[dict]) -> bool:
    """True when the worker's real ancestry reaches a pytest started with ``--basetemp``."""
    by_pid = {row.get("ProcessId"): row for row in processes}
    child = worker
    for _ in range(8):
        parent = by_pid.get(child.get("ParentProcessId"))
        if (parent is None or parent is child
                or not isinstance(parent.get("Created"), int)
                or not isinstance(child.get("Created"), int)
                or parent["Created"] > child["Created"]):
            return False  # dead parent, or its pid was reused by a newer process
        if "--basetemp" in (parent.get("CommandLine") or ""):
            return True
        child = parent
    return False


def prune_runs() -> None:
    """Delete finished runs past their keep window; never a run some process still uses.

    A killed gate or launcher can leave pytest itself running a level below (``uv`` →
    pytest). Every process of that chain carries ``--basetemp=<run>`` on its command
    line, so a run named on any live command line is kept. xdist workers do not carry it:
    a worker counts as covered only when its real ancestry (parents created before their
    children, so a reused pid does not count) reaches a ``--basetemp`` process, whose run
    is then kept by name. While any other worker runs (orphaned, reused parent pid, a
    pytest started outside the gate), nothing is deleted; nor when processes are unreadable.
    """
    if not RUNS_DIR.is_dir():
        return
    finished = []
    for run in RUNS_DIR.glob("run-*"):
        if run.suffix == ".owner":
            if not run.with_suffix("").exists():
                run.unlink(missing_ok=True)
            continue
        if any(pid_alive(pid) for pid in _owner_pids(run)):
            continue
        try:
            finished.append((run.stat().st_mtime, run))
        except OSError:
            continue  # removed meanwhile by another gate
    finished.sort(reverse=True)
    cutoff = time.time() - KEEP_HOURS * 3600
    doomed = [run for index, (mtime, run) in enumerate(finished)
              if index >= KEEP_FAILED or mtime < cutoff]
    if not doomed:
        return
    processes = _processes()
    if processes is None:
        return
    if any(XDIST_WORKER in (row.get("CommandLine") or "") and not _covered(row, processes)
           for row in processes):
        return  # an xdist worker of an unknown run may still write into one of these
    lines = "\n".join(row.get("CommandLine") or "" for row in processes)
    for run in doomed:
        if run.name in lines:
            continue  # a process still runs pytest in it
        shutil.rmtree(run, ignore_errors=True)
        run.with_name(run.name + ".owner").unlink(missing_ok=True)


def split_workers(argv: list[str], workers: int) -> tuple[list[str], int]:
    """Take any ``-n``/``--numprocesses`` from the pytest args, so the cap and the reserved
    slots are the workers pytest really starts (``auto`` means the cap)."""
    rest, index = [], 0
    while index < len(argv):
        arg = argv[index]
        value = None
        if arg in {"-n", "--numprocesses"} and index + 1 < len(argv):
            value, index = argv[index + 1], index + 2
        elif arg.startswith("--numprocesses="):
            value, index = arg.split("=", 1)[1], index + 1
        elif arg.startswith("-n") and len(arg) > 2 and not arg.startswith("--"):
            value, index = arg[2:], index + 1
        else:
            rest.append(arg)
            index += 1
            continue
        workers = MAX_WORKERS if value in {"auto", "logical"} else int(value)
    return rest, workers


def node_id_count(argv: list[str]) -> int:
    # Unknown options may take values, so do not guess which arguments are positional.
    values = {"-k", "-m", "-o", "-p", "-r", "--override-ini", "--rootdir", "--confcutdir",
              "--ignore", "--ignore-glob", "--deselect", "--junitxml", "--junit-xml",
              "--basetemp", "--capture", "--tb", "--maxfail", "--durations", "--color"}
    flags = {"--collect-only", "--co", "--disable-warnings", "--no-header", "--no-summary",
             "--strict-markers", "--strict-config", "--last-failed", "--lf", "--failed-first",
             "--ff", "--exitfirst", "--quiet", "--verbose", "--showlocals", "--trace"}
    ids, index, positional = [], 0, False
    while index < len(argv):
        arg = argv[index]
        if not positional and arg == "--":
            positional = True
        elif not positional and arg in values:
            index += 1
            if index == len(argv):
                return 0
        elif not positional and arg.startswith("-"):
            short_flags = arg.startswith("-") and not arg.startswith("--") and set(arg[1:]) <= set("qvsx")
            if arg not in flags and not short_flags and "=" not in arg and not arg.startswith("-r"):
                return 0
        else:
            ids.append(arg)
        index += 1
    return len(ids) if ids and all("::" in item and all(item.split("::")) for item in ids) else 0


def select_workers(argv: list[str], workers: int) -> tuple[list[str], int, int, int]:
    explicit = any(arg in {"-n", "--numprocesses"} or arg.startswith("--numprocesses=")
                   or (arg.startswith("-n") and not arg.startswith("--") and len(arg) > 2) for arg in argv)
    argv, workers = split_workers(argv, workers)
    if explicit and workers == 0:
        return argv, 1, 0, 0
    workers = max(1, min(workers, POOL_SIZE, MAX_WORKERS))
    count = node_id_count(argv) if not explicit else 0
    if count and count <= SERIAL_MAX:
        return argv, 1, 0, count
    return argv, workers, workers, 0


def _check_pool_dir() -> None:
    SLOT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=SLOT_DIR) as probe:
        probe.write(b"pytest-gate")
        probe.flush()


def use_private_pool(reason: OSError) -> None:
    global SLOT_DIR, POOL_IS_PRIVATE
    if POOL_IS_PRIVATE:
        raise reason
    POOL_IS_PRIVATE = True
    SLOT_DIR = Path(tempfile.gettempdir()) / "pytest-gate"
    print(f"[pytest_gate] shared pool unavailable ({reason}); using private pool {SLOT_DIR}", flush=True)
    _check_pool_dir()


def prepare_pool() -> None:
    try:
        _check_pool_dir()
    except OSError as exc:
        use_private_pool(exc)


def _open_slot(index: int | str, create: bool = True) -> int | None:
    path = SLOT_DIR / f"slot-{index}.lock"
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags | (os.O_CREAT if create else 0), 0o600)
    try:
        os.set_inheritable(fd, False)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            os.close(fd)
            return None
        return fd
    except BaseException:
        os.close(fd)
        raise


def release_slots(slots: list[int]) -> None:
    for fd in slots:
        os.close(fd)


def write_slot(fd: int, child: int = 0, child_start: str = "") -> None:
    data = slot_text(child, child_start).encode("utf-8", errors="replace")
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, data)
    os.ftruncate(fd, len(data))


def try_acquire(count: int) -> list[int]:
    taken: list[int] = []
    try:
        for index in range(POOL_SIZE):
            fd = _open_slot(index)
            if fd is not None:
                taken.append(fd)
            if len(taken) == count:
                break
        if len(taken) < count:
            release_slots(taken)
            return []
        for fd in taken:
            write_slot(fd)
        return taken
    except BaseException:
        release_slots(taken)
        raise


def busy_slots() -> int:
    busy = 0
    for index in range(POOL_SIZE):
        fd = _open_slot(index)
        if fd is None:
            busy += 1
        else:
            os.close(fd)
    return busy


def _lock_holder(pool: Path) -> tuple[str, str]:
    try:
        lines = (pool / "queue.lock").read_text(errors="replace").splitlines()
        fields = dict(line.split("=", 1) for line in lines if "=" in line)
    except OSError:
        fields = {}
    namespace = fields.get("pidns", "")
    label = " (other pid ns)" if namespace and namespace != pid_namespace() else ""
    holder = f"pid {fields.get('pid') or '?'}{label} ({fields.get('cwd') or '?'})"
    return holder, fields.get("since", "")


@contextmanager
def queue_lock(pool: Path | None = None, timeout: float | None = None):
    pool = SLOT_DIR if pool is None else pool
    fd = os.open(pool / "queue.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        started = time.monotonic()
        warned = False
        while not _try_ticket_lock(fd):
            waited = time.monotonic() - started
            if timeout is not None and waited >= timeout:
                yield False
                return
            if timeout is None and waited > 30 and not warned:
                holder, _ = _lock_holder(pool)
                print(f"[pytest_gate] queue.lock held for 30s+ by {holder}; "
                      "a gate may be stopped mid-decision", flush=True)
                warned = True
            time.sleep(0.05)
        try:
            holder = (f"pid={os.getpid()}\npidns={pid_namespace()}\n"
                      f"cwd={os.getcwd()}\nsince={time.time()}\n")
            os.ftruncate(fd, 0)
            os.write(fd, holder.encode("utf-8", errors="replace"))
        except OSError:
            pass
        (pool / "queue").mkdir(exist_ok=True)
        yield True
    finally:
        os.close(fd)


def _same_file(path: Path, fd: int) -> bool:
    try:
        named, opened = path.stat(), os.fstat(fd)
        return (named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino)
    except FileNotFoundError:
        return False


class Ticket:
    def __init__(self, workers: int, pytest_workers: int, argv: list[str]):
        self.name = f"{time.monotonic_ns():020d}-{os.getpid()}-{secrets.token_hex(4)}.ticket"
        self.path = SLOT_DIR / "queue" / self.name
        self.fd = None
        identity = process_identity(os.getpid()) or {}
        args = " ".join(argv).replace("\n", " ").replace("\r", " ")[:300]
        self.content = (f"pid={os.getpid()}\npid_start={identity.get('start', '')}\n"
                        f"pidns={pid_namespace()}\ncwd={os.getcwd()}\nslots={workers}\n"
                        f"pytest_workers={pytest_workers}\narrived={time.time():.6f}\nargs={args}\n")

    def create(self) -> None:
        self.path.parent.mkdir(exist_ok=True)
        pending = self.path.with_name(f".{self.name}.new")
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            data = self.content.encode("utf-8", errors="replace")
            while data:
                data = data[os.write(fd, data):]
            os.rename(pending, self.path)
        except BaseException:
            try:
                if _same_file(self.path, fd):
                    self.path.unlink(missing_ok=True)
                if _same_file(pending, fd):
                    pending.unlink(missing_ok=True)
            finally:
                os.close(fd)
            raise
        old_fd, self.fd = self.fd, fd
        if old_fd is not None:
            os.close(old_fd)

    def heartbeat(self) -> None:
        os.utime(self.fd)
        if os.fstat(self.fd).st_nlink == 0:
            self.create()

    def remove(self) -> None:
        if self.fd is not None:
            try:
                if _same_file(self.path, self.fd):
                    self.path.unlink(missing_ok=True)
            finally:
                os.close(self.fd)
                self.fd = None


def cleanup_ticket(ticket: Ticket | None) -> None:
    if ticket is None or ticket.fd is None:
        return
    try:
        with queue_lock(ticket.path.parent.parent):
            ticket.remove()
    except OSError:
        # If the pool cannot be locked, closing makes the ticket prunable.
        if ticket.fd is not None:
            os.close(ticket.fd)
            ticket.fd = None


def _try_ticket_lock(fd: int) -> bool:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as exc:
        if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK}:
            return False
        raise


def _ticket_data(fd: int) -> dict:
    text = os.pread(fd, 65536, 0).decode("utf-8", errors="replace")
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def queue_entries(own: Ticket | None = None, prune: bool = True) -> list[dict]:
    queue_dir = SLOT_DIR / "queue"
    now = time.time()
    if prune:
        for path in queue_dir.glob(".*.new"):
            try:
                fd = os.open(path, os.O_RDWR)
            except FileNotFoundError:
                continue
            try:
                if _try_ticket_lock(fd) and now - os.fstat(fd).st_mtime > 60 and _same_file(path, fd):
                    path.unlink(missing_ok=True)
            finally:
                os.close(fd)
    entries = []
    for path in sorted(queue_dir.glob("*.ticket")):
        is_own = own is not None and path.name == own.name
        if is_own:
            fd = own.fd
        else:
            try:
                fd = os.open(path, os.O_RDWR if prune else os.O_RDONLY)
            except FileNotFoundError:
                continue
        try:
            dead = not is_own and _try_ticket_lock(fd)
            if dead and prune:
                if _same_file(path, fd):
                    path.unlink(missing_ok=True)
                continue
            row = _ticket_data(fd)
            row["name"] = path.name
            row["dead"] = dead
            row["frozen"] = not dead and not is_own and now - os.fstat(fd).st_mtime > FROZEN_SECONDS
            entries.append(row)
        finally:
            if not is_own:
                os.close(fd)
    return entries


def _head_since(name: str, now: int, write: bool) -> int:
    path = SLOT_DIR / "queue-head"
    try:
        old_name, value = path.read_text().split()
        since = int(value)
        if old_name == name and 0 <= since <= now:
            return since
    except (OSError, ValueError):
        pass
    if write:
        fd, temporary = tempfile.mkstemp(prefix=".queue-head-", dir=SLOT_DIR)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(f"{name} {now}\n")
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return now


def may_start(position: int, slots_needed: list[int], free: int, head_age: float) -> bool:
    if free < slots_needed[position]:
        return False
    if position == 0:
        return True
    return head_age < BACKFILL_SECONDS and all(free < needed for needed in slots_needed[:position])


def _needed(row: dict) -> int:
    try:
        needed = int(row["slots"])
        return needed if needed > 0 else POOL_SIZE
    except (KeyError, ValueError):
        return POOL_SIZE


def decide(ticket: Ticket, workers: int, report_busy: bool) -> tuple[list[int], int, int, int]:
    with queue_lock():
        ticket.heartbeat()
        queue = [row for row in queue_entries(ticket) if not row["frozen"]]
        if not any(row["name"] == ticket.name for row in queue) and os.fstat(ticket.fd).st_nlink == 0:
            ticket.create()
            queue = [row for row in queue_entries(ticket) if not row["frozen"]]
        position = next(index for index, row in enumerate(queue) if row["name"] == ticket.name)
        now = time.monotonic_ns()
        head_age = (now - _head_since(queue[0]["name"], now, True)) / 1e9
        if free_ram_gb() < MIN_FREE_GB:
            return [], position, len(queue), busy_slots() if report_busy else 0
        taken = []
        try:
            for index in range(POOL_SIZE):
                fd = _open_slot(index)
                if fd is not None:
                    taken.append(fd)
            busy = POOL_SIZE - len(taken)
            if may_start(position, [_needed(row) for row in queue], len(taken), head_age):
                release_slots(taken[workers:])
                del taken[workers:]
                for fd in taken:
                    write_slot(fd)
                ticket.remove()
                slots, taken = taken, []
                return slots, position, len(queue), busy
            return [], position, len(queue), busy
        finally:
            release_slots(taken)


def wait_for_slots(workers: int, pytest_workers: int, argv: list[str]) -> list[int]:
    ticket = None
    started = time.monotonic()
    announced = False
    announced_head = False
    try:
        while True:
            try:
                if ticket is None:
                    with queue_lock():
                        ticket = Ticket(workers, pytest_workers, argv)
                        ticket.create()
                slots, position, count, busy = decide(ticket, workers, not announced)
            except OSError as exc:
                use_private_pool(exc)
                cleanup_ticket(ticket)
                ticket = None
                continue
            try:
                if announced and position == 0 and not announced_head:
                    print("[pytest_gate] first in queue", flush=True)
                    announced_head = True
                if slots:
                    if announced:
                        print(f"[pytest_gate] acquired after {time.monotonic() - started:.0f}s", flush=True)
                    return slots
                if not announced:
                    print(f"[pytest_gate] waiting for {workers} of {POOL_SIZE} slots ({busy} busy) / "
                          f"{MIN_FREE_GB} GB free RAM; queue position {position + 1} of {count}", flush=True)
                    announced = True
            except BaseException:
                release_slots(slots)
                raise
            time.sleep(POLL_SECONDS)
    finally:
        cleanup_ticket(ticket)


def _duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{seconds:02d}s"
    return f"{seconds}s"


def _elapsed(value: str, now: float) -> str:
    try:
        return _duration(now - float(value))
    except (ValueError, OverflowError):
        return "?"


def _namespace_label(namespace: str, own: str, pid: str, start: str) -> str:
    if namespace:
        return " (other pid ns)" if namespace != own else ""
    try:
        local = same_process(int(pid), start, "pytest_gate.py")
    except ValueError:
        local = False
    return "" if local else " (other pid ns)"


def status() -> int:
    if not SLOT_DIR.is_dir():
        print(f"[pytest_gate] no pool at {SLOT_DIR}")
        return 0
    with queue_lock(timeout=3) as locked:
        if not locked:
            holder, since = _lock_holder(SLOT_DIR)
            print(f"[pytest_gate] queue.lock busy for 3s+: held by {holder} "
                  f"since {_elapsed(since, time.time())} ago")
        configured = {str(index) for index in range(POOL_SIZE)}
        indexes = configured | {path.name[5:-5] for path in SLOT_DIR.glob("slot-*.lock")}
        indexes = sorted(indexes, key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value))
        holders, unknown = {}, []
        free = 0
        now = time.time()
        namespace = pid_namespace()
        for index in indexes:
            try:
                fd = _open_slot(index, create=False)
            except FileNotFoundError:
                fd = -1
            if fd is not None:
                if fd != -1:
                    os.close(fd)
                if index in configured:
                    free += 1
                continue
            try:
                lines = (SLOT_DIR / f"slot-{index}.lock").read_text(errors="replace").splitlines()
                pid, cwd = lines[0].split(maxsplit=1)
                if not pid.isdigit() or int(pid) <= 0:
                    raise ValueError("invalid pid")
                fields = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
            except (OSError, ValueError, IndexError):
                unknown.append(index)
                continue
            outside = index not in configured
            key = pid, fields.get("pid_start", ""), outside
            if key not in holders:
                holders[key] = {"pid": pid, "cwd": cwd, "count": 0, "outside": outside, **fields}
            holders[key]["count"] += 1
        queue = queue_entries(prune=locked)
        active = [row for row in queue if not row["frozen"] and not row["dead"]]
        if active:
            monotonic = time.monotonic_ns()
            age = (monotonic - _head_since(active[0]["name"], monotonic, False)) / 1e9
            backfill = (f"backfill open {_duration(BACKFILL_SECONDS - age)} more"
                        if age < BACKFILL_SECONDS else "backfill closed")
            detail = f"head for {_duration(age)}, {backfill}"
        elif any(not row["dead"] for row in queue):
            detail = "all frozen"
        else:
            detail = "no live waiters"
    busy = POOL_SIZE - free
    print(f"[pytest_gate] pool {SLOT_DIR}: {POOL_SIZE} slots, {busy} busy, {free} free; "
          f"RAM {free_ram_gb():.1f} GB free (min {MIN_FREE_GB:.1f})")
    if not holders and not unknown:
        print("holders: none")
    else:
        print("holders:")
        for row in holders.values():
            label = _namespace_label(row.get("pidns", ""), namespace, row["pid"], row.get("pid_start", ""))
            workers = row.get("pytest_workers") or "?"
            duration = _elapsed(row.get("time", ""), now)
            outside = f" (outside pool of {POOL_SIZE})" if row["outside"] else ""
            print(f"  pid {row['pid']}{label}  -n {workers}  slots {row['count']}  "
                  f"{duration}  {row['cwd']}{outside}")
        for index in unknown:
            outside = f" (outside pool of {POOL_SIZE})" if index not in configured else ""
            print(f"  busy slot {index} (unknown holder){outside}")
    if not queue:
        print("queue: empty")
        return 0
    print(f"queue ({len(queue)} waiting; {detail}):")
    for index, row in enumerate(queue, 1):
        label = _namespace_label(row.get("pidns", ""), namespace, row.get("pid", ""), row.get("pid_start", ""))
        duration = _elapsed(row.get("arrived", ""), now)
        frozen = " [frozen]" if row["frozen"] else ""
        dead = " [dead]" if row["dead"] else ""
        print(f"  {index}. pid {row.get('pid') or '?'}{label}  -n {row.get('pytest_workers') or '?'}"
              f"  slots {row.get('slots') or '?'}  waited {duration}  {row.get('cwd', '?')}"
              f"  {row.get('args', '')}{frozen}{dead}")
    return 0


def main() -> int:
    global RUN_SLOTS, RUN_PYTEST_WORKERS
    argv = sys.argv[1:]
    workers = 4
    if len(argv) >= 2 and argv[0] == "-n":
        workers = int(argv[1])
        argv = argv[2:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    ticket_args = argv[:]
    argv, workers, pytest_workers, serial_count = select_workers(argv, workers)
    RUN_SLOTS, RUN_PYTEST_WORKERS = workers, pytest_workers
    if serial_count:
        print(f"[pytest_gate] {serial_count} test ids: running without xdist workers", flush=True)
    prepare_pool()
    prune_runs()
    disk = free_disk_gb(RUNS_DIR)
    if disk < MIN_FREE_DISK_GB:
        print(f"[pytest_gate] refused: {disk:.1f} GB free on the temp drive, need "
              f"{MIN_FREE_DISK_GB:.0f} GB. Clean up before testing.", flush=True)
        return REFUSED_DISK
    slots = wait_for_slots(workers, pytest_workers, ticket_args)
    own_temp = None
    if not any(arg == "--basetemp" or arg.startswith("--basetemp=") for arg in argv):
        own_temp = RUNS_DIR / f"run-{os.getpid()}-{int(time.time())}"
        argv = [f"--basetemp={own_temp}", "-o", "tmp_path_retention_policy=failed", *argv]
    owner = own_temp.with_name(own_temp.name + ".owner") if own_temp is not None else None
    code = 1
    child = None
    child_start = ""
    previous = {}

    def forward(sig, _frame):
        if child is not None:
            signal_group(child.pid, child_start, sig)
        raise SystemExit(128 + sig)

    try:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[sig] = signal.signal(sig, forward)
        command = [sys.executable, "-m", "uv", "run", "pytest", "-n", str(pytest_workers), *argv]
        # Block termination until the child's identity and slot reservations are durable.
        signals = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        try:
            child = subprocess.Popen(command, start_new_session=True,
                                     restore_signals=True,
                                     preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, mask))
            identity = process_identity(child.pid)
            child_start = identity["start"] if identity else ""
            for slot in slots:
                write_slot(slot, child.pid, child_start)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        if owner is not None:
            owner.parent.mkdir(parents=True, exist_ok=True)
            owner.write_text(f"{os.getpid()} {child.pid}\n" +
                             f"start_{os.getpid()}={process_identity(os.getpid())['start']}\n" +
                             f"start_{child.pid}={child_start}\n")
        code = child.wait()
        return code
    finally:
        # A repeated interrupt must not release slots before descendants are stopped.
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        if child is not None:
            stop_group(child.pid, child_start)
            child.wait()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        release_slots(slots)
        if own_temp is not None:
            owner.unlink(missing_ok=True)
            if code in GREEN:
                shutil.rmtree(own_temp, ignore_errors=True)
            else:
                print(f"[pytest_gate] failing tests' dirs kept in {own_temp}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--status":
        sys.exit(status())
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        if sys.platform != "linux":
            print("[pytest_gate] Linux self-test skipped: requires Linux", flush=True)
            sys.exit(0)
        test = Path(__file__).resolve().parent / "lib" / "pytest-gate-test.py"
        sys.exit(subprocess.call([sys.executable, str(test)]))
    sys.exit(main())
