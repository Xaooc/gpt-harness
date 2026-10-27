"""Machine-wide gate for pytest runs, so parallel executors cannot freeze the PC or fill the disk.

Usage (from the repo or worktree root, any shell):
    python ~/.claude/scripts/pytest_gate.py -n 4 -- tests/engine_v2/test_x.py -q

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
- workers default to 4 and are capped at MAX_WORKERS and POOL_SIZE.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import base64
import json
import errno
import msvcrt
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

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
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = str(Path(os.environ.get("USERPROFILE") or Path.home()) / "AppData" / "Local")
    return Path(local) / "Temp" / "pytest-gate"


SLOT_DIR = Path(os.environ.get("PYTEST_GATE_DIR") or default_slot_dir())
POOL_IS_PRIVATE = False
RUNS_DIR = Path(os.environ.get("PYTEST_GATE_RUNS", Path(tempfile.gettempdir()) / "pytest-gate-runs"))
POLL_SECONDS = 5
REFUSED_DISK = 75  # not a pytest exit code (pytest uses 0-5)
GREEN = {0, 5}  # passed, or nothing collected: no failing test dir worth keeping

if os.name == "nt":
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD


class _MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def free_ram_gb() -> float:
    status = _MemoryStatus()
    status.dwLength = ctypes.sizeof(_MemoryStatus)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    return status.ullAvailPhys / 1024**3


def free_disk_gb(path: Path) -> float:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free / 1024**3


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not handle:
        return ctypes.get_last_error() == 5  # access denied: conservatively keep the owner
    code = wintypes.DWORD()
    ok = kernel.GetExitCodeProcess(handle, ctypes.byref(code))
    kernel.CloseHandle(handle)
    if not ok:
        return True
    return code.value == 259  # STILL_ACTIVE


def process_start(pid: int) -> str:
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        return handle_start(handle)
    finally:
        kernel.CloseHandle(handle)


def handle_start(handle: int) -> str:
    created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
    if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                  ctypes.byref(system), ctypes.byref(user)):
        return ""
    return str((created.dwHighDateTime << 32) | created.dwLowDateTime)


def same_process(pid: int, start: str) -> bool:
    if not pid_alive(pid):
        return False
    current = process_start(pid) if start else ""
    return not start or not current or current == start


def slot_text(pid: int, start: str, child: int = 0, child_start: str = "") -> str:
    return (f"{pid} {os.getcwd()}\npid_start={start}\nchild={child}\n"
            f"child_start={child_start}\ntime={time.time():.6f}\n")


def _owner_pids(run: Path) -> list[int]:
    """The gate and its pytest child that own a run (``<run>.owner``, beside the run dir:
    pytest wipes ``--basetemp`` at start). Without the file, the gate pid in the name."""
    owner = run.with_name(run.name + ".owner")
    try:
        lines = owner.read_text().splitlines()
        pids = [int(value) for value in lines[0].split()]
        starts = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
        return [pid for pid in pids if same_process(pid, starts.get(f"start_{pid}", ""))]
    except (OSError, ValueError, IndexError):
        pass
    try:
        return [int(run.name.split("-")[1])]
    except (IndexError, ValueError):
        return []


XDIST_WORKER = "exec(eval(sys.stdin.readline()))"  # execnet's popen worker bootstrap


def _processes() -> list[dict] | None:
    """Every running process (pid, parent pid, command line, creation time), or None."""
    import json

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,"
             "CommandLine,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}} "
             "| ConvertTo-Json -Compress"],
            capture_output=True, timeout=60, encoding="utf-8", errors="replace",
        )
        rows = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return rows if isinstance(rows, list) and rows else None


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

    A killed gate or launcher can leave pytest itself running a level below (``uv.exe`` →
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


def _open_slot(index: int) -> int | None:
    path = SLOT_DIR / f"slot-{index}.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.set_inheritable(fd, False)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
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
    data = slot_text(os.getpid(), process_start(os.getpid()), child, child_start).encode("utf-8", errors="replace")
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


class _StartupInfo(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("reserved", wintypes.LPWSTR), ("desktop", wintypes.LPWSTR),
                ("title", wintypes.LPWSTR), ("x", wintypes.DWORD), ("y", wintypes.DWORD),
                ("xsize", wintypes.DWORD), ("ysize", wintypes.DWORD), ("xchars", wintypes.DWORD),
                ("ychars", wintypes.DWORD), ("fill", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("show", wintypes.WORD), ("reserved2size", wintypes.WORD),
                ("reserved2", ctypes.POINTER(ctypes.c_byte)), ("stdin", wintypes.HANDLE),
                ("stdout", wintypes.HANDLE), ("stderr", wintypes.HANDLE)]


class _ProcessInfo(ctypes.Structure):
    _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE),
                ("pid", wintypes.DWORD), ("tid", wintypes.DWORD)]


class _BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("min_working", ctypes.c_size_t),
                ("max_working", ctypes.c_size_t), ("active_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", _BasicLimits), ("io", _IoCounters), ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                ("peak_job", ctypes.c_size_t)]


class _Accounting(ctypes.Structure):
    _fields_ = [("user", ctypes.c_longlong), ("kernel", ctypes.c_longlong),
                ("period_user", ctypes.c_longlong), ("period_kernel", ctypes.c_longlong),
                ("faults", wintypes.DWORD), ("total", wintypes.DWORD), ("active", wintypes.DWORD),
                ("terminated", wintypes.DWORD)]


def make_job() -> int:
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                wintypes.DWORD, ctypes.c_void_p]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = _ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel.CloseHandle(job)
        raise ctypes.WinError(ctypes.get_last_error())
    return job


def job_active(job: int) -> int:
    stats = _Accounting()
    if not kernel.QueryInformationJobObject(job, 1, ctypes.byref(stats), ctypes.sizeof(stats), None):
        raise ctypes.WinError(ctypes.get_last_error())
    return stats.active


def start_job_child(job: int, command: list[str]) -> tuple[_ProcessInfo, str]:
    kernel.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                      wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                      ctypes.POINTER(_StartupInfo), ctypes.POINTER(_ProcessInfo)]
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    startup, info = _StartupInfo(), _ProcessInfo()
    startup.cb = ctypes.sizeof(startup)
    line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
    # Assign the suspended child before it can create descendants.
    if not kernel.CreateProcessW(None, line, None, None, True, 0x4, None, None,
                                 ctypes.byref(startup), ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.AssignProcessToJobObject(job, info.process):
            raise ctypes.WinError(ctypes.get_last_error())
        started = handle_start(info.process)
        if not started:
            raise ctypes.WinError(ctypes.get_last_error())
        return info, started
    except BaseException:
        kernel.TerminateProcess(info.process, 1)
        kernel.WaitForSingleObject(info.process, 0xFFFFFFFF)
        kernel.CloseHandle(info.thread)
        kernel.CloseHandle(info.process)
        raise


def guardian(config: dict) -> int:
    global SLOT_DIR, POOL_IS_PRIVATE
    SLOT_DIR = Path(config["slot_dir"])
    POOL_IS_PRIVATE = config["private_pool"]
    workers = config["workers"]
    cancel = Path(config["cancel"])
    own_temp = Path(config["temp"]) if config["temp"] else None
    owner = own_temp.with_name(own_temp.name + ".owner") if own_temp else None
    guardian_pid, guardian_start = os.getpid(), process_start(os.getpid())
    parent = kernel.OpenProcess(0x101000, False, config["parent"])
    job, child = None, None
    slots: list[int] = []
    code = 1
    try:
        if not parent or handle_start(parent) != config["parent_start"] or not guardian_start:
            return 1
        started, announced = time.monotonic(), False
        while True:
            if cancel.exists() or kernel.WaitForSingleObject(parent, 0) == 0:
                return 130
            enough_ram = free_ram_gb() >= MIN_FREE_GB
            try:
                if enough_ram:
                    slots = try_acquire(workers)
                    if slots:
                        break
                if not announced:
                    busy = busy_slots()
                    print(f"[pytest_gate] waiting for {workers} of {POOL_SIZE} slots ({busy} busy) / "
                          f"{MIN_FREE_GB} GB free RAM", flush=True)
                    announced = True
            except OSError as exc:
                use_private_pool(exc)
                continue
            deadline = time.monotonic() + POLL_SECONDS
            while time.monotonic() < deadline:
                if cancel.exists() or kernel.WaitForSingleObject(parent, 100) == 0:
                    return 130
        if announced:
            print(f"[pytest_gate] acquired after {time.monotonic() - started:.0f}s", flush=True)
        if cancel.exists() or kernel.WaitForSingleObject(parent, 0) == 0:
            return 130
        job = make_job()
        child, child_start = start_job_child(job, config["command"])
        for slot in slots:
            write_slot(slot, child.pid, child_start)
        if owner:
            owner.parent.mkdir(parents=True, exist_ok=True)
            owner.write_text(f"{guardian_pid} {child.pid}\nstart_{guardian_pid}={guardian_start}\n"
                             f"start_{child.pid}={child_start}\n")
        if cancel.exists() or kernel.WaitForSingleObject(parent, 0) == 0:
            code = 130
            return code
        if kernel.ResumeThread(child.thread) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(child.thread)
        child.thread = None
        while kernel.WaitForSingleObject(child.process, 100) == 0x102:
            if cancel.exists() or kernel.WaitForSingleObject(parent, 0) == 0:
                code = 130
                break
        else:
            exit_code = wintypes.DWORD()
            if kernel.GetExitCodeProcess(child.process, ctypes.byref(exit_code)):
                code = exit_code.value
        return code
    finally:
        # The guardian keeps the OS locks until all processes in its job have exited.
        if job:
            if job_active(job):
                kernel.TerminateJobObject(job, 1)
            while job_active(job):
                time.sleep(0.05)
            kernel.CloseHandle(job)
        if child:
            if child.thread:
                kernel.CloseHandle(child.thread)
            kernel.CloseHandle(child.process)
        if parent:
            kernel.CloseHandle(parent)
        release_slots(slots)
        cancel.unlink(missing_ok=True)
        if owner and child:
            owner.unlink(missing_ok=True)
            if code in GREEN:
                shutil.rmtree(own_temp, ignore_errors=True)
            else:
                print(f"[pytest_gate] failing tests' dirs kept in {own_temp}", flush=True)


def launch_guardian(command: list[str], workers: int, own_temp: Path | None) -> int:
    parent_start = process_start(os.getpid())
    if not parent_start:
        raise RuntimeError("cannot read gate process creation time")
    cancel = SLOT_DIR / f"guardian-{uuid.uuid4().hex}.cancel"
    config = {"parent": os.getpid(), "parent_start": parent_start, "command": command,
              "slot_dir": str(SLOT_DIR), "private_pool": POOL_IS_PRIVATE, "workers": workers,
              "temp": str(own_temp) if own_temp else "", "cancel": str(cancel)}
    payload = base64.urlsafe_b64encode(json.dumps(config).encode()).decode()
    child = None
    interrupted = False
    previous = signal.getsignal(signal.SIGINT)

    def interrupt(_sig, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGINT, interrupt)
    try:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--guardian", payload],
                                 creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        while child.poll() is None:
            if interrupted:
                cancel.touch(exist_ok=True)
            time.sleep(0.05)
        return child.returncode
    finally:
        signal.signal(signal.SIGINT, previous)
        if child and child.poll() is None:
            cancel.touch(exist_ok=True)
            child.wait()
        cancel.unlink(missing_ok=True)


def main() -> int:
    argv = sys.argv[1:]
    workers = 4
    if len(argv) >= 2 and argv[0] == "-n":
        workers = int(argv[1])
        argv = argv[2:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    argv, workers, pytest_workers, serial_count = select_workers(argv, workers)
    if serial_count:
        print(f"[pytest_gate] {serial_count} test ids: running without xdist workers", flush=True)
    prepare_pool()
    prune_runs()
    disk = free_disk_gb(RUNS_DIR)
    if disk < MIN_FREE_DISK_GB:
        print(f"[pytest_gate] refused: {disk:.1f} GB free on the temp drive, need "
              f"{MIN_FREE_DISK_GB:.0f} GB. Clean up before testing.", flush=True)
        return REFUSED_DISK
    own_temp = None
    if not any(arg == "--basetemp" or arg.startswith("--basetemp=") for arg in argv):
        own_temp = RUNS_DIR / f"run-{os.getpid()}-{int(time.time())}"
        argv = [f"--basetemp={own_temp}", "-o", "tmp_path_retention_policy=failed", *argv]
    command = [sys.executable, "-m", "uv", "run", "pytest", "-n", str(pytest_workers), *argv]
    return launch_guardian(command, workers, own_temp)


def self_test() -> int:
    global SLOT_DIR, RUNS_DIR, POOL_SIZE, MAX_WORKERS, SERIAL_MAX, POOL_IS_PRIVATE
    from contextlib import redirect_stdout
    from io import StringIO
    from unittest.mock import patch

    POOL_SIZE, MAX_WORKERS, SERIAL_MAX = 2, 2, 3
    passed = 0

    def check(name: str, condition: bool) -> None:
        nonlocal passed
        if not condition:
            raise AssertionError(name)
        passed += 1
        print(f"PASS {name}", flush=True)

    def eventually(predicate, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.05)
        return False

    def free(index=0):
        fd = _open_slot(index)
        if fd is None:
            return False
        os.close(fd)
        return True

    def terminate_pid(pid, start):
        handle = kernel.OpenProcess(0x101001, False, pid)
        if handle:
            try:
                if handle_start(handle) == start:
                    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 10000)
            finally:
                kernel.CloseHandle(handle)

    with tempfile.TemporaryDirectory(prefix="pytest-gate-self-test-") as directory:
        root = Path(directory)
        SLOT_DIR, RUNS_DIR = root / "slots", root / "runs"
        SLOT_DIR.mkdir()
        start = process_start(os.getpid())
        check("process creation identity", bool(start) and same_process(os.getpid(), start))
        check("reused pid rejected", not same_process(os.getpid(), "1"))
        check("legacy pid accepted", same_process(os.getpid(), ""))
        stale = SLOT_DIR / "slot-0.lock"
        stale.write_text(slot_text(os.getpid(), "1"))
        check("unlocked old owner text is ignored", free())
        run = RUNS_DIR / f"run-{os.getpid()}-1"
        run.parent.mkdir()
        run.with_name(run.name + ".owner").write_text(f"{os.getpid()}\nstart_{os.getpid()}=1\n")
        check("reused run owner rejected", _owner_pids(run) == [])

        script = str(Path(__file__).resolve())
        env = {**os.environ, "PYTEST_GATE_DIR": str(SLOT_DIR), "PYTEST_GATE_RUNS": str(RUNS_DIR),
               "PYTEST_GATE_MIN_FREE_GB": "0", "PYTEST_GATE_MIN_FREE_DISK_GB": "0",
               "PYTEST_GATE_POOL": "2", "PYTEST_GATE_MAX_WORKERS": "2", "PYTHONDONTWRITEBYTECODE": "1"}
        config_env = env.copy()
        config_env.pop("PYTEST_GATE_POOL")
        config_env.pop("PYTEST_GATE_MAX_WORKERS")
        command = [sys.executable, script, "--self-test-config"]
        config = json.loads(subprocess.check_output(command, env=config_env, text=True))
        check("pool defaults to usable CPUs", config["pool"] == config["cpus"]
              and config["max_workers"] == min(4, config["pool"]))
        config_env["PYTEST_GATE_POOL"] = "2"
        config = json.loads(subprocess.check_output(command, env=config_env, text=True))
        check("pool override and default worker cap", config["pool"] == 2 and config["max_workers"] == 2)

        for count in range(1, 4):
            ids = [f"tests/test_a.py::test_{index}" for index in range(count)]
            _, slots, pytest_workers, selected = select_workers(ids + ["-q"], 2)
            check(f"{count} node ids select in-process pytest", (slots, pytest_workers, selected) == (1, 0, count))
        _, slots, pytest_workers, selected = select_workers(["tests/test_a.py::test_a", "-n", "2"], 1)
        check("explicit pytest worker count is respected", (slots, pytest_workers, selected) == (2, 2, 0))
        _, slots, pytest_workers, selected = select_workers(["tests/test_a.py::test_a", "--numprocesses=0"], 2)
        check("explicit in-process pytest uses one slot", (slots, pytest_workers, selected) == (1, 0, 0))
        _, slots, pytest_workers, selected = select_workers(["tests/"], 2)
        check("directory keeps xdist", (slots, pytest_workers, selected) == (2, 2, 0))
        check("option values do not count as node ids", node_id_count(["-k", "x::y"]) == 0)
        ids = [f"tests/test_a.py::test_{index}" for index in range(4)]
        check("four node ids keep xdist", select_workers(ids, 2)[1:] == (2, 2, 0))
        SERIAL_MAX = 2
        check("serial threshold override is respected", select_workers(ids[:3], 2)[1:] == (2, 2, 0))
        SERIAL_MAX = 3

        real_check = _check_pool_dir
        original_slot_dir = SLOT_DIR
        SLOT_DIR = root / "unwritable"
        private = root / "private-temp"
        private.mkdir()
        def deny_shared_pool():
            if SLOT_DIR == root / "unwritable":
                raise PermissionError("access denied")
            real_check()
        output = StringIO()
        try:
            with patch(__name__ + "._check_pool_dir", side_effect=deny_shared_pool), \
                    patch.object(tempfile, "gettempdir", return_value=str(private)), redirect_stdout(output):
                prepare_pool()
                locked = try_acquire(1)
                release_slots(locked)
            check("unwritable pool falls back to usable private pool", len(locked) == 1
                  and output.getvalue().count("shared pool unavailable (access denied)") == 1)
        finally:
            SLOT_DIR = original_slot_dir
            POOL_IS_PRIVATE = False

        lock_ready = root / "lock.json"
        holder = None
        leaf = None
        try:
            holder = subprocess.Popen([sys.executable, script, "--self-test-lock", str(lock_ready)], env=env)
            check("lock owner starts", eventually(lock_ready.exists))
            leaf = json.loads(lock_ready.read_text())
            check("slot is locked and descriptor is non-inheritable", not free() and leaf["noninheritable"])
            holder.terminate()
            holder.wait(timeout=10)
            check("killed lock owner frees slot while child lives", free() and same_process(leaf["pid"], leaf["start"]))
        finally:
            if holder and holder.poll() is None:
                holder.terminate()
                holder.wait(timeout=10)
            if leaf:
                terminate_pid(leaf["pid"], leaf["start"])

        ready = root / "tree.json"
        parent = None
        processes = []
        try:
            parent = subprocess.Popen([sys.executable, script, "--self-test-parent", str(ready)], env=env)
            check("test tree starts", eventually(ready.exists))
            processes = json.loads(ready.read_text())
            check("reservation held for running tree", not free())
            parent.terminate()
            parent.wait(timeout=10)
            safe = True
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                live = any(same_process(row["pid"], row["start"]) for row in processes)
                available = free()
                if live and available:
                    # The tree can exit between the liveness snapshot and the lock probe.
                    live = any(same_process(row["pid"], row["start"]) for row in processes)
                    if live:
                        safe = False
                        print(f"FAIL reservation released while tree was live: {processes}", flush=True)
                if not live and available:
                    break
                time.sleep(0.05)
            check("killed launcher terminates tree before releasing reservation", safe and free() and not any(
                same_process(row["pid"], row["start"]) for row in processes))
        finally:
            if parent and parent.poll() is None:
                parent.terminate()
                parent.wait(timeout=10)
            for row in processes:
                terminate_pid(row["pid"], row["start"])
            if not eventually(free):
                raise RuntimeError("guardian did not release slot")

        (root / "uv.py").write_text(
            'import json,os,sys,time\n'
            'from pathlib import Path\n'
            'ready=Path(os.environ["FIXTURE_READY"])\n'
            'pending=ready.with_suffix(".tmp")\n'
            'pending.write_text(json.dumps(sys.argv[1:])); pending.replace(ready)\n'
            'release=Path(os.environ["FIXTURE_RELEASE"])\n'
            'while not release.exists(): time.sleep(0.05)\n')
        gates, files, releases = [], [], []

        def launch(label, temp, args, extra=None, workers=2):
            temp.mkdir()
            gate_env = env.copy()
            gate_env.pop("PYTEST_GATE_DIR", None)
            gate_env.pop("PYTEST_GATE_RUNS", None)
            gate_env.update({"LOCALAPPDATA": str(root / "profile"), "TMP": str(temp), "TEMP": str(temp),
                             "TMPDIR": str(temp), "PYTHONPATH": str(root),
                             "FIXTURE_READY": str(root / f"{label}.json"),
                             "FIXTURE_RELEASE": str(root / f"{label}.release")})
            if extra:
                gate_env.update(extra)
            output = root / f"{label}.log"
            stream = output.open("w")
            files.append(stream)
            releases.append(Path(gate_env["FIXTURE_RELEASE"]))
            gate = subprocess.Popen([sys.executable, script, "-n", str(workers), "--", *args], env=gate_env,
                                    cwd=str(root), stdout=stream, stderr=subprocess.STDOUT)
            gates.append(gate)
            return gate, Path(gate_env["FIXTURE_READY"]), output

        try:
            first, first_ready, first_log = launch("first", root / "temp-a", ["tests/"])
            check("first gate holds two slots", eventually(first_ready.exists))
            SLOT_DIR = root / "profile" / "Temp" / "pytest-gate"
            check("two workers hold shared locks", not free(0) and not free(1))
            second, second_ready, second_log = launch("second", root / "temp-b", ["tests/"], workers=1)
            check("different temp gate waits for the same pool", eventually(
                lambda: "waiting for 1 of 2 slots (2 busy)" in second_log.read_text()) and not second_ready.exists())
            releases[0].touch()
            check("first gate exits successfully", first.wait(timeout=20) == 0)
            check("second gate acquires released slots", eventually(second_ready.exists))
            releases[1].touch()
            check("second gate exits successfully", second.wait(timeout=20) == 0)

            serial, serial_ready, serial_log = launch("serial", root / "temp-c", ["tests/test_a.py::test_one"])
            check("serial fixture starts", eventually(serial_ready.exists))
            args = json.loads(serial_ready.read_text())
            index = args.index("-n")
            check("serial command uses -n 0 and one lock", args[index + 1] == "0" and not free(0) and free(1)
                  and "1 test ids: running without xdist workers" in serial_log.read_text())
            releases[-1].touch()
            check("serial gate exits successfully", serial.wait(timeout=20) == 0)

            bad = root / "not-a-directory"
            bad.write_text("x")
            fallback, fallback_ready, fallback_log = launch(
                "fallback", root / "temp-d", ["tests/"], {"PYTEST_GATE_DIR": str(bad / "slots")})
            check("fallback fixture starts", eventually(fallback_ready.exists))
            SLOT_DIR = root / "temp-d" / "pytest-gate"
            check("unavailable shared pool uses working private pool", "shared pool unavailable (" in
                  fallback_log.read_text() and "using private pool" in fallback_log.read_text()
                  and not free(0) and not free(1))
            releases[-1].touch()
            check("fallback gate exits successfully", fallback.wait(timeout=20) == 0)
        finally:
            for release in releases:
                release.touch(exist_ok=True)
            for gate in gates:
                if gate.poll() is None:
                    try:
                        gate.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        gate.terminate()
                        gate.wait(timeout=10)
            for stream in files:
                stream.close()
    print(f"{passed} passed, 0 failed", flush=True)
    return 0


def self_test_parent(ready: str) -> int:
    prepare_pool()
    return launch_guardian([sys.executable, str(Path(__file__).resolve()), "--self-test-child", ready], 1, None)


def self_test_lock(ready: str) -> int:
    prepare_pool()
    slots = try_acquire(1)
    if not slots:
        return 1
    leaf = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--self-test-leaf"], close_fds=False)
    Path(ready).write_text(json.dumps({"pid": leaf.pid, "start": process_start(leaf.pid),
                                      "noninheritable": all(not os.get_inheritable(fd) for fd in slots)}))
    leaf.wait()
    release_slots(slots)
    return 0


def self_test_child(ready: str) -> int:
    leaf = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--self-test-leaf"])
    rows = [{"pid": pid, "start": process_start(pid)} for pid in (os.getpid(), leaf.pid)]
    Path(ready).write_text(json.dumps(rows))
    leaf.wait()
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--guardian":
        sys.exit(guardian(json.loads(base64.urlsafe_b64decode(sys.argv[2]).decode())))
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(self_test())
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test-config":
        print(json.dumps({"pool": POOL_SIZE, "cpus": usable_cpus(), "max_workers": MAX_WORKERS}))
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[1] == "--self-test-lock":
        sys.exit(self_test_lock(sys.argv[2]))
    if len(sys.argv) > 2 and sys.argv[1] == "--self-test-parent":
        sys.exit(self_test_parent(sys.argv[2]))
    if len(sys.argv) > 2 and sys.argv[1] == "--self-test-child":
        sys.exit(self_test_child(sys.argv[2]))
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test-leaf":
        time.sleep(60)
        sys.exit(0)
    sys.exit(main())
