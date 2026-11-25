"""pytest plugin for ML AI Code jobs: every pytest run in the sandbox takes its slots in the host's machine-wide pool.

The agent was told to type plain `pytest` (bin/pytest asks the host gate through the bridge folder), but it also ran
`.venv/bin/python -m pytest`, which no PATH shim sees (2026-11-25). PYTEST_PLUGINS loads this module into every pytest
the sandbox starts; it asks the same bridge (mlai/gate-bridge.mjs) at configure time and says done at the end. Runs the
shim already granted (MLAI_GATE_GRANTED) and xdist workers do not ask again.
"""
import os
import sys
import time


def _bridge():
    if os.environ.get("MLAI_GATE_GRANTED") or os.environ.get("PYTEST_XDIST_WORKER"):
        return None
    path = os.environ.get("PYTEST_GATE_BRIDGE", "")
    return path if path and os.path.isdir(path) else None


def pytest_configure(config):
    bridge = _bridge()
    if bridge is None or hasattr(config, "workerinput"):
        return
    request = f"{os.getpid()}-{time.time_ns()}"
    args = [str(arg) for arg in sys.argv[1:]]
    lines = [str(os.getpid()), str(os.getpgrp()), "0", *args]
    temp = os.path.join(bridge, f".req-{request}")
    with open(temp, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.replace(temp, os.path.join(bridge, f"req-{request}"))
    print("[pytest] waiting for the machine's test gate", file=sys.stderr, flush=True)
    while not os.path.exists(os.path.join(bridge, f"grant-{request}")):
        denied = os.path.join(bridge, f"deny-{request}")
        if os.path.exists(denied):
            with open(denied, encoding="utf-8") as handle:
                reason = handle.read().strip()
            raise SystemExit(f"[pytest] the machine's test gate refused this run: {reason}")
        time.sleep(1)
    os.environ["MLAI_GATE_GRANTED"] = "1"
    config._mlai_gate = (bridge, request)


def pytest_unconfigure(config):
    held = getattr(config, "_mlai_gate", None)
    if held is None:
        return
    bridge, request = held
    try:
        with open(os.path.join(bridge, f"done-{request}"), "w", encoding="utf-8") as handle:
            handle.write("done\n")
    except OSError:
        pass
