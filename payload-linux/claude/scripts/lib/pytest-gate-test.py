#!/usr/bin/env python3
"""Offline lifecycle and PID identity regressions; no pytest/uv installation needed."""
from contextlib import redirect_stdout
from io import StringIO
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "pytest_gate.py"
spec = importlib.util.spec_from_file_location("pytest_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def eventually(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pytest-gate-test-")
        self.root = Path(self.temp.name)
        self.child = None
        self.info = None
        self.gates = []
        self.streams = []
        self.releases = []
        self.original_slots = gate.SLOT_DIR
        self.original_limits = gate.POOL_SIZE, gate.MAX_WORKERS, gate.SERIAL_MAX
        gate.POOL_SIZE, gate.MAX_WORKERS, gate.SERIAL_MAX = 2, 2, 3
        gate.SLOT_DIR = self.root / "slots"
        gate.SLOT_DIR.mkdir()
        (self.root / "uv.py").write_text(
            'import json,os,signal,subprocess,time\n'
            'from pathlib import Path\n'
            'kid=subprocess.Popen(["bash","-c","trap \'\' TERM INT HUP; sleep 300 & wait"])\n'
            'Path(os.environ["FIXTURE_INFO"]).write_text(json.dumps([os.getpid(),kid.pid]))\n'
            'while True: time.sleep(1)\n')

    def tearDown(self):
        for release in self.releases:
            release.touch(exist_ok=True)
        for child in self.gates:
            if child.poll() is None:
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)
        for stream in self.streams:
            stream.close()
        if self.info:
            pgid, start = self.info
            gate.signal_group(pgid, start, signal.SIGKILL)
        if self.child and self.child.poll() is None:
            self.child.kill()
        if self.child:
            self.child.wait(timeout=10)
        gate.SLOT_DIR = self.original_slots
        gate.POOL_SIZE, gate.MAX_WORKERS, gate.SERIAL_MAX = self.original_limits
        self.temp.cleanup()

    def launch(self):
        (self.root / "info").unlink(missing_ok=True)
        env = {**os.environ, "HOME": str(self.root), "PYTHONPATH": str(self.root),
               "PYTEST_GATE_DIR": str(gate.SLOT_DIR), "PYTEST_GATE_RUNS": str(self.root / "runs"),
               "PYTEST_GATE_MIN_FREE_DISK_GB": "0", "PYTEST_GATE_MIN_FREE_GB": "0",
               "FIXTURE_INFO": str(self.root / "info"), "PYTHONDONTWRITEBYTECODE": "1"}
        self.child = subprocess.Popen([sys.executable, str(SCRIPT), "-n", "1", "--", "-q"],
                                      env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertTrue(eventually(lambda: (self.root / "info").exists()))
        pgid, descendant = json.loads((self.root / "info").read_text())
        self.info = (pgid, gate.process_identity(pgid)["start"])
        self.assertTrue(eventually(lambda: any("pgid=" + str(pgid) in p.read_text()
                                              for p in gate.SLOT_DIR.glob("slot-*.lock"))))
        self.assertEqual(os.getpgid(descendant), pgid)
        return pgid, descendant

    def test_gate_termination_stops_descendants_before_releasing_slots(self):
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig):
                self.launch()
                self.child.send_signal(sig)  # only the gate is signaled
                self.assertEqual(self.child.wait(timeout=10), 128 + sig)
                self.assertFalse(gate.group_members(*self.info))
                self.assertTrue(self.slot_free())

    def slot_free(self, index=0):
        fd = gate._open_slot(index)
        if fd is None:
            return False
        os.close(fd)
        return True

    def test_hard_killed_gate_frees_slot_even_if_child_survives(self):
        self.launch()
        self.assertFalse(self.slot_free())
        self.child.kill()
        self.child.wait(timeout=10)
        self.assertTrue(gate.group_members(*self.info))
        self.assertTrue(self.slot_free())  # a surviving child did not inherit the lock
        gate.signal_group(*self.info, signal.SIGKILL)
        self.assertTrue(eventually(lambda: not gate.group_members(*self.info)))

    def test_reused_gate_and_group_ids_are_not_trusted(self):
        slot = gate.SLOT_DIR / "slot-0.lock"
        slot.write_text(f"{os.getpid()} path with spaces\npid_start=reused\npgid=0\npgid_start=\n")
        self.assertTrue(self.slot_free())
        row = gate.process_identity(os.getpid())
        self.assertFalse(gate.same_process(os.getpid(), "reused", row["command"]))
        self.assertTrue(gate.same_process(os.getpid(), row["start"], row["command"]))
        self.assertEqual(gate.group_members(os.getpid(), "reused"), [])
        self.assertEqual(gate.group_members(2147483647, "1"), [])

    def fixture(self):
        (self.root / "uv.py").write_text(
            'import json,os,sys,time\n'
            'from pathlib import Path\n'
            'ready=Path(os.environ["FIXTURE_READY"])\n'
            'pending=ready.with_suffix(".tmp")\n'
            'pending.write_text(json.dumps(sys.argv[1:])); pending.replace(ready)\n'
            'release=Path(os.environ["FIXTURE_RELEASE"])\n'
            'while not release.exists(): time.sleep(0.05)\n')

    def fixture_env(self, label, temp):
        temp.mkdir()
        env = {**os.environ, "PYTHONPATH": str(self.root), "PYTEST_GATE_DIR": str(gate.SLOT_DIR),
               "PYTEST_GATE_POOL": "2", "PYTEST_GATE_MAX_WORKERS": "2", "PYTEST_GATE_MIN_FREE_GB": "0",
               "PYTEST_GATE_MIN_FREE_DISK_GB": "0", "TMPDIR": str(temp), "TEMP": str(temp),
               "TMP": str(temp), "PYTHONDONTWRITEBYTECODE": "1", "FIXTURE_READY": str(self.root / label),
               "FIXTURE_RELEASE": str(self.root / (label + ".release"))}
        env.pop("PYTEST_GATE_RUNS", None)
        env.pop("PYTEST_GATE_SERIAL_MAX", None)
        return env

    def fixture_launch(self, label, temp, workers, args, extra=None):
        env = self.fixture_env(label, temp)
        if extra:
            env.update(extra)
        output = self.root / (label + ".log")
        stream = output.open("w")
        self.streams.append(stream)
        self.releases.append(Path(env["FIXTURE_RELEASE"]))
        child = subprocess.Popen([sys.executable, str(SCRIPT), "-n", str(workers), "--", *args],
                                 cwd=str(self.root), env=env, stdout=stream, stderr=subprocess.STDOUT)
        self.gates.append(child)
        return child, Path(env["FIXTURE_READY"]), output

    def test_waiters_are_served_in_arrival_order(self):
        self.fixture()
        config = {"PYTEST_GATE_POOL": "1", "PYTEST_GATE_MAX_WORKERS": "1", "PYTEST_GATE_POLL_S": "0.2"}
        holder, holder_ready, _ = self.fixture_launch("holder", self.root / "temp-holder", 1, ["tests/"], config)
        self.assertTrue(eventually(holder_ready.exists))
        waiters = []
        for label, poll in (("a", "2"), ("b", "0.5"), ("c", "0.05")):
            if label == "c":
                time.sleep(2)  # Also stagger the original gate's fixed five-second polls.
            options = {**config, "PYTEST_GATE_POLL_S": poll}
            child, ready, output = self.fixture_launch(label, self.root / ("temp-" + label), 1,
                                                       ["tests/"], options)
            waiters.append((child, ready))
            self.assertTrue(eventually(lambda: "waiting for 1 of 1 slots" in output.read_text()))
            if label == "b":
                b_waiting = time.monotonic()
        time.sleep(max(0, b_waiting + 5.2 - time.monotonic()))
        (self.root / "holder.release").touch()
        self.assertEqual(holder.wait(timeout=20), 0)
        for index, (child, ready) in enumerate(waiters):
            self.assertTrue(eventually(lambda: any(row[1].exists() for row in waiters[index:])))
            actual = [label for label, (_, item) in zip(("a", "b", "c"), waiters) if item.exists()]
            self.assertTrue(ready.exists(), f"expected {('a', 'b', 'c')[index]} first; ready: {actual}")
            self.assertTrue(eventually(ready.exists))
            for _, later_ready in waiters[index + 1:]:
                self.assertFalse(later_ready.exists())
            (self.root / (("a", "b", "c")[index] + ".release")).touch()
            self.assertEqual(child.wait(timeout=20), 0)
        self.assertTrue(gate.may_start(0, [2, 1], 2, 0))
        self.assertTrue(gate.may_start(1, [2, 1], 1, 0))
        self.assertFalse(gate.may_start(1, [2, 1], 1, float("inf")))
        self.assertFalse(gate.may_start(2, [3, 1, 1], 1, 0))
        self.assertFalse(gate.may_start(1, [3, 2], 1, 0))

    def test_dead_waiter_ticket_is_dropped(self):
        self.fixture()
        config = {"PYTEST_GATE_POOL": "1", "PYTEST_GATE_MAX_WORKERS": "1", "PYTEST_GATE_POLL_S": "0.2"}
        holder, holder_ready, _ = self.fixture_launch("holder", self.root / "temp-holder", 1, ["tests/"], config)
        self.assertTrue(eventually(holder_ready.exists))
        first, _, _ = self.fixture_launch("x", self.root / "temp-x", 1, ["tests/"], config)
        queue = gate.SLOT_DIR / "queue"
        self.assertTrue(eventually(lambda: len(list(queue.glob("*.ticket"))) == 1))
        dead_ticket = next(queue.glob("*.ticket"))
        first.kill()
        self.assertEqual(first.wait(timeout=20), -signal.SIGKILL)
        second, second_ready, _ = self.fixture_launch("y", self.root / "temp-y", 1, ["tests/"], config)
        self.assertTrue(eventually(lambda: not dead_ticket.exists() and len(list(queue.glob("*.ticket"))) == 1))
        second_ticket = next(queue.glob("*.ticket"))
        self.assertIn(f"-{second.pid}-", second_ticket.name)
        old_inode = second_ticket.stat().st_ino
        with gate.queue_lock():
            second_ticket.unlink()
            queue.rmdir()
        self.assertTrue(eventually(lambda: second_ticket.exists() and second_ticket.stat().st_ino != old_inode))
        abandoned, recent = queue / ".abandoned.ticket.new", queue / ".recent.ticket.new"
        abandoned.touch()
        recent.touch()
        os.utime(abandoned, (time.time() - 61, time.time() - 61))
        with gate.queue_lock():
            gate.queue_entries()
        self.assertFalse(abandoned.exists())
        self.assertTrue(recent.exists())
        earlier = int(second_ticket.name.split("-", 1)[0]) - 1
        name = f"{earlier:020d}-{first.pid}-deadbeef.ticket"
        pending, foreign = queue / f".{name}.new", queue / name
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            content = (f"pid={first.pid}\npid_start=1\ncwd={self.root}\nslots=1\n"
                       f"pytest_workers=1\narrived={time.time()}\nargs=tests/\n")
            os.write(fd, content.encode())
            os.rename(pending, foreign)
            before = second_ticket.stat().st_mtime_ns
            self.assertTrue(eventually(lambda: second_ticket.stat().st_mtime_ns > before))
            self.assertTrue(foreign.exists())
            old = time.time() - gate.FROZEN_SECONDS - 1
            os.utime(fd, (old, old))
            with gate.queue_lock():
                rows = gate.queue_entries()
            self.assertTrue(next(row for row in rows if row["name"] == name)["frozen"])
            self.assertEqual([row["name"] for row in rows], [name, second_ticket.name])
            with gate.queue_lock():
                content = second_ticket.read_text()
                second_ticket.write_text("\n".join(line for line in content.splitlines()
                                                   if not line.startswith("pidns=")) + "\n")
            output = StringIO()
            legacy_paths = [gate.SLOT_DIR / f"slot-{index}.lock" for index in (2, 3, 4)]
            with legacy_paths[0].open("w+") as legacy_one, legacy_paths[1].open("w+") as legacy_two, \
                    legacy_paths[2].open("w+") as local:
                for stream in (legacy_one, legacy_two):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    stream.write(f"{first.pid} /a path with spaces\npid_start=1\ntime={time.time() - 63}\n")
                    stream.flush()
                fcntl.flock(local.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                start = gate.process_identity(holder.pid)["start"]
                local.write(f"{holder.pid} /local legacy\npid_start={start}\ntime={time.time()}\n")
                local.flush()
                with patch.object(gate, "_head_since", wraps=gate._head_since) as head, redirect_stdout(output):
                    self.assertEqual(gate.status(), 0)
            self.assertFalse(head.call_args.args[2])
            self.assertIn(": 2 slots, 1 busy, 1 free; RAM ", output.getvalue())
            self.assertIn("holders:", output.getvalue())
            self.assertIn(f"pid {first.pid} (other pid ns)  -n ?  slots 2", output.getvalue())
            self.assertIn(f"pid {holder.pid}  -n ?  slots 1", output.getvalue())
            self.assertIn("(outside pool of 2)", output.getvalue())
            self.assertIn("/a path with spaces", output.getvalue())
            self.assertIn("queue (2 waiting;", output.getvalue())
            self.assertIn("backfill open", output.getvalue())
            self.assertIn(f"pid {first.pid} (other pid ns)  -n 1  slots 1  waited", output.getvalue())
            self.assertIn(f"pid {second.pid}  -n 1  slots 1  waited", output.getvalue())
            self.assertIn("[frozen]", output.getvalue())
            self.assertFalse((gate.SLOT_DIR / "slot-1.lock").exists())
            dead = queue / f"{earlier - 1:020d}-{first.pid}-deadbeef.ticket"
            with gate.queue_lock():
                dead.write_text(f"pid={first.pid}\npid_start=1\ncwd={self.root}\n")
                abandoned.touch()
                os.utime(abandoned, (old, old))
                unlocked = StringIO()
                with redirect_stdout(unlocked):
                    self.assertEqual(gate.status(), 0)
                self.assertIn("queue.lock busy for 3s+: held by pid", unlocked.getvalue())
                self.assertIn("[dead]", unlocked.getvalue())
                self.assertIn("[frozen]", unlocked.getvalue())
                self.assertTrue(dead.exists())
                self.assertTrue(abandoned.exists())
                dead.unlink()
                abandoned.unlink()
                warning = StringIO()
                with patch.object(gate.time, "monotonic", side_effect=[0, 31, 32]), \
                        patch.object(gate.time, "sleep", side_effect=[None, RuntimeError("stop waiting")]), \
                        redirect_stdout(warning):
                    with self.assertRaisesRegex(RuntimeError, "stop waiting"):
                        with gate.queue_lock():
                            self.fail("contended lock was acquired")
                self.assertEqual(warning.getvalue().count("queue.lock held for 30s+"), 1)
                self.assertIn(f"pid {os.getpid()}", warning.getvalue())
                self.assertIn("a gate may be stopped mid-decision", warning.getvalue())
            closed = StringIO()
            with patch.object(gate, "BACKFILL_SECONDS", 0), redirect_stdout(closed):
                self.assertEqual(gate.status(), 0)
            self.assertIn("backfill closed", closed.getvalue())
            os.utime(fd, None)
            with gate.queue_lock():
                rows = gate.queue_entries()
            self.assertFalse(next(row for row in rows if row["name"] == name)["frozen"])
            os.utime(fd, (old, old))
            (self.root / "holder.release").touch()
            self.assertEqual(holder.wait(timeout=20), 0)
            self.assertTrue(eventually(second_ready.exists))
            self.assertTrue(foreign.exists())
            (self.root / "y.release").touch()
            self.assertEqual(second.wait(timeout=20), 0)
        finally:
            os.close(fd)
        with gate.queue_lock():
            self.assertEqual(gate.queue_entries(), [])
        self.assertFalse(foreign.exists())

    def test_queue_ignoring_gate_is_not_blocked_and_head_survives_it(self):
        self.fixture()
        config = {"PYTEST_GATE_POOL": "2", "PYTEST_GATE_MAX_WORKERS": "2", "PYTEST_GATE_POLL_S": "0.2"}
        h1, h1_ready, _ = self.fixture_launch("h1", self.root / "temp-h1", 1, ["tests/"], config)
        h2, h2_ready, _ = self.fixture_launch("h2", self.root / "temp-h2", 1, ["tests/"], config)
        self.assertTrue(eventually(lambda: h1_ready.exists() and h2_ready.exists()))
        killed, _, _ = self.fixture_launch("k", self.root / "temp-k", 1, ["tests/"], config)
        queue = gate.SLOT_DIR / "queue"
        self.assertTrue(eventually(lambda: len(list(queue.glob("*.ticket"))) == 1))
        dead_ticket = next(queue.glob("*.ticket"))
        dead_content = dead_ticket.read_bytes()
        killed.kill()
        self.assertEqual(killed.wait(timeout=20), -signal.SIGKILL)
        new, new_ready, _ = self.fixture_launch("n", self.root / "temp-n", 2, ["tests/"], config)
        self.assertTrue(eventually(lambda: any(f"-{new.pid}-" in path.name for path in queue.glob("*.ticket"))))
        new_ticket = next(path for path in queue.glob("*.ticket") if f"-{new.pid}-" in path.name)
        old_code = ('import importlib.util,os,sys,time\n'
                    'from pathlib import Path\n'
                    'spec=importlib.util.spec_from_file_location("pytest_gate",sys.argv[1])\n'
                    'gate=importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)\n'
                    'while not (slots:=gate.try_acquire(1)): time.sleep(0.2)\n'
                    'Path(os.environ["FIXTURE_READY"]).touch()\n'
                    'while not Path(os.environ["FIXTURE_RELEASE"]).exists(): time.sleep(0.05)\n'
                    'gate.release_slots(slots)\n')
        env = self.fixture_env("o", self.root / "temp-o")
        env.update(config)
        self.releases.append(Path(env["FIXTURE_RELEASE"]))
        with gate.queue_lock():
            # N may already have pruned K; restore its unlocked ticket to exercise both cases.
            if not dead_ticket.exists():
                dead_ticket.write_bytes(dead_content)
            old = subprocess.Popen([sys.executable, "-c", old_code, str(SCRIPT)], cwd=str(self.root), env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.gates.append(old)
            (self.root / "h1.release").touch()
            self.assertEqual(h1.wait(timeout=20), 0)
            self.assertTrue(eventually(Path(env["FIXTURE_READY"]).exists))
            self.assertTrue(dead_ticket.exists())
            self.assertFalse(new_ready.exists())
        (self.root / "h2.release").touch()
        self.assertEqual(h2.wait(timeout=20), 0)
        before = new_ticket.stat().st_mtime_ns
        time.sleep(1)
        self.assertFalse(new_ready.exists())
        self.assertIsNone(new.poll())
        self.assertGreater(new_ticket.stat().st_mtime_ns, before)
        (self.root / "o.release").touch()
        self.assertEqual(old.wait(timeout=20), 0)
        self.assertTrue(eventually(new_ready.exists))
        (self.root / "n.release").touch()
        self.assertEqual(new.wait(timeout=20), 0)
        self.assertFalse(dead_ticket.exists())

    def test_different_temp_directories_share_pool(self):
        self.fixture()
        first_env = self.fixture_env("config-a", self.root / "config-temp-a")
        second_env = self.fixture_env("config-b", self.root / "config-temp-b")
        for env in (first_env, second_env):
            env.pop("PYTEST_GATE_DIR")
        probe = ('import runpy,sys; print(runpy.run_path(sys.argv[1])["SLOT_DIR"])')
        first_dir = subprocess.check_output([sys.executable, "-c", probe, str(SCRIPT)], env=first_env, text=True).strip()
        second_dir = subprocess.check_output([sys.executable, "-c", probe, str(SCRIPT)], env=second_env, text=True).strip()
        self.assertEqual(first_dir, f"/tmp/pytest-gate-{os.getuid()}")
        self.assertEqual(first_dir, second_dir)
        first, first_ready, _ = self.fixture_launch("first", self.root / "temp-a", 2, ["tests/"])
        self.assertTrue(eventually(first_ready.exists))
        self.assertFalse(self.slot_free(0))
        self.assertFalse(self.slot_free(1))
        second, second_ready, output = self.fixture_launch("second", self.root / "temp-b", 1, ["tests/"])
        self.assertTrue(eventually(lambda: "waiting for 1 of 2 slots (2 busy)" in output.read_text()))
        self.assertFalse(second_ready.exists())
        self.releases[0].touch()
        self.assertEqual(first.wait(timeout=20), 0)
        self.assertTrue(eventually(second_ready.exists))
        self.releases[1].touch()
        self.assertEqual(second.wait(timeout=20), 0)

    def test_pool_defaults_and_override(self):
        expected = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1
        self.assertEqual(gate.usable_cpus(), expected)
        env = self.fixture_env("config", self.root / "config-temp")
        env.pop("PYTEST_GATE_POOL")
        env.pop("PYTEST_GATE_MAX_WORKERS")
        probe = ('import json,runpy,sys; d=runpy.run_path(sys.argv[1]); '
                 'print(json.dumps([d["POOL_SIZE"],d["MAX_WORKERS"]]))')
        command = [sys.executable, "-c", probe, str(SCRIPT)]
        self.assertEqual(json.loads(subprocess.check_output(command, env=env, text=True)),
                         [expected, min(4, expected)])
        env["PYTEST_GATE_POOL"] = "2"
        self.assertEqual(json.loads(subprocess.check_output(command, env=env, text=True)), [2, 2])

    def test_tiny_node_ids_and_explicit_workers(self):
        for count in range(1, 4):
            ids = [f"tests/test_a.py::test_{index}" for index in range(count)]
            self.assertEqual(gate.select_workers(ids + ["-q"], 2)[1:], (1, 0, count))
        self.assertEqual(gate.select_workers(["tests/test_a.py::test_a", "-n", "2"], 1)[1:], (2, 2, 0))
        self.assertEqual(gate.select_workers(["tests/test_a.py::test_a", "--numprocesses=0"], 2)[1:], (1, 0, 0))
        self.assertEqual(gate.select_workers(["tests/"], 2)[1:], (2, 2, 0))
        self.assertEqual(gate.node_id_count(["-k", "x::y"]), 0)
        ids = [f"tests/test_a.py::test_{index}" for index in range(4)]
        self.assertEqual(gate.select_workers(ids, 2)[1:], (2, 2, 0))
        gate.SERIAL_MAX = 2
        self.assertEqual(gate.select_workers(ids[:3], 2)[1:], (2, 2, 0))
        gate.SERIAL_MAX = 3
        self.fixture()
        child, ready, output = self.fixture_launch("serial", self.root / "temp-serial", 2,
                                                   ["tests/test_a.py::test_a"])
        self.assertTrue(eventually(ready.exists))
        args = json.loads(ready.read_text())
        self.assertEqual(args[args.index("-n") + 1], "0")
        self.assertFalse(self.slot_free(0))
        self.assertTrue(self.slot_free(1))
        self.assertIn("1 test ids: running without xdist workers", output.read_text())
        self.releases[0].touch()
        self.assertEqual(child.wait(timeout=20), 0)

    def test_unwritable_shared_pool_falls_back(self):
        real_check = gate._check_pool_dir
        original_slot_dir = gate.SLOT_DIR
        gate.SLOT_DIR = self.root / "unwritable"
        private = self.root / "private-temp"
        private.mkdir()

        def deny_shared_pool():
            if gate.SLOT_DIR == self.root / "unwritable":
                raise PermissionError("access denied")
            real_check()

        output = StringIO()
        try:
            with patch.object(gate, "_check_pool_dir", side_effect=deny_shared_pool), \
                    patch.object(gate.tempfile, "gettempdir", return_value=str(private)), redirect_stdout(output):
                gate.prepare_pool()
                slots = gate.try_acquire(1)
                gate.release_slots(slots)
            self.assertEqual(len(slots), 1)
            self.assertEqual(output.getvalue().count("shared pool unavailable (access denied)"), 1)
        finally:
            gate.SLOT_DIR = original_slot_dir
            gate.POOL_IS_PRIVATE = False
        self.fixture()
        bad = self.root / "not-a-directory"
        bad.write_text("x")
        child, ready, output = self.fixture_launch("fallback", self.root / "temp-fallback", 2, ["tests/"],
                                                   {"PYTEST_GATE_DIR": str(bad / "slots")})
        self.assertTrue(eventually(ready.exists))
        self.assertIn("shared pool unavailable (", output.read_text())
        self.assertIn("using private pool", output.read_text())
        gate.SLOT_DIR = self.root / "temp-fallback" / "pytest-gate"
        self.assertFalse(self.slot_free(0))
        self.assertFalse(self.slot_free(1))
        self.releases[0].touch()
        self.assertEqual(child.wait(timeout=20), 0)


if __name__ == "__main__":
    unittest.main()
