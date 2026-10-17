"""Stage 50 phase 2 — x11vnc against the display the browser is already on.

Two things carry the safety of this, and each has a test that fails loudly if relaxed:

1. **It listens on loopback only.** A VNC server reachable from outside the container is
   an unauthenticated remote-control surface on a browser that may be signed into
   things. The cycle token on the relay is the boundary; the port must never be.
2. **It does not leak across cycles.** `NANOBOT_PERSISTENT=on` keeps one container warm
   for many cycles, so module-level state is cross-cycle state — the exact shape that
   bit xvfb_session.py twice (see its docstring's two corrections). A server left
   running would hold the display of a run that already ended.

Everything else degrades: no x11vnc, a server that dies, a port that never answers —
all of them leave the live view on screenshots, which is what it does today anyway.
"""

from __future__ import annotations

import subprocess

import pytest

from nanoagent.agent.effector.desktop import vnc_session as vs


@pytest.fixture(autouse=True)
def _clean_module_state():
    """Module state is process-global and this module's whole risk is that it outlives
    a cycle — so no test may inherit another's."""
    vs._proc, vs._port = None, None
    yield
    vs._proc, vs._port = None, None


class _Popen:
    """A spawned x11vnc, as far as this module cares."""

    def __init__(self, alive: bool = True):
        self._alive = alive
        self.terminated = False
        self.killed = False

    def poll(self):
        return None if self._alive else 1

    def terminate(self):
        self.terminated = True
        self._alive = False

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True
        self._alive = False


def _arrange(monkeypatch, *, installed=True, alive=True, ready=True, seen=None):
    monkeypatch.setattr(vs.shutil, "which",
                        lambda _n: "/usr/bin/x11vnc" if installed else None)
    monkeypatch.setattr(vs, "_free_port", lambda: 5931)
    monkeypatch.setattr(vs, "_accepts_connections", lambda *_a, **_k: ready)

    def fake_popen(cmd, **_kw):
        if seen is not None:
            seen.append(cmd)
        return _Popen(alive=alive)

    monkeypatch.setattr(vs.subprocess, "Popen", fake_popen)


# ─── 1. loopback only ─────────────────────────────────────────────────────────

def test_it_binds_to_loopback_and_never_the_world(monkeypatch):
    seen: list = []
    _arrange(monkeypatch, seen=seen)

    vs.start(":99")

    assert "-localhost" in seen[0], "a VNC port reachable off-box is a remote-control hole"
    assert vs._BIND == "127.0.0.1"


def test_it_serves_the_display_it_was_given(monkeypatch):
    seen: list = []
    _arrange(monkeypatch, seen=seen)

    vs.start(":99")

    cmd = seen[0]
    assert cmd[cmd.index("-display") + 1] == ":99"
    assert cmd[cmd.index("-rfbport") + 1] == "5931"


def test_a_viewer_disconnecting_does_not_end_the_server(monkeypatch):
    """Someone closes the tab, thinks again, comes back. Without -forever x11vnc exits
    on the first disconnect and the second look gets nothing."""
    seen: list = []
    _arrange(monkeypatch, seen=seen)

    vs.start(":99")

    assert "-forever" in seen[0]


# ─── 2. it must not outlive its cycle ─────────────────────────────────────────

def test_starting_twice_reuses_the_running_server(monkeypatch):
    """A warm daemon runs many cycles in one process. Spawning a second x11vnc on the
    same display would leave the first one orphaned and holding the port."""
    seen: list = []
    _arrange(monkeypatch, seen=seen)

    first = vs.start(":99")
    second = vs.start(":99")

    assert first == second == 5931
    assert len(seen) == 1, "the second start must not spawn anything"


def test_stop_ends_it_and_forgets_the_port(monkeypatch):
    _arrange(monkeypatch)
    vs.start(":99")
    proc = vs._proc

    vs.stop()

    assert proc.terminated is True
    assert vs.is_running() is False
    assert vs.current_port() is None


def test_stop_is_safe_to_call_twice(monkeypatch):
    """It runs on a teardown path, and a teardown that raises the second time is how a
    finished run turns into a failed one."""
    _arrange(monkeypatch)
    vs.start(":99")

    vs.stop()
    vs.stop()   # must not raise


def test_stop_with_nothing_running_is_a_no_op():
    vs.stop()
    assert vs.is_running() is False


def test_a_server_that_refuses_to_die_is_killed(monkeypatch):
    _arrange(monkeypatch)
    vs.start(":99")

    def refuse(timeout=None):
        raise subprocess.TimeoutExpired("x11vnc", timeout or 3)

    vs._proc.wait = refuse
    vs.stop()

    assert vs.is_running() is False


# ─── everything else degrades to screenshots ──────────────────────────────────

def test_no_x11vnc_on_the_image_is_not_an_error(monkeypatch):
    """An image built before this shipped keeps working, on the screenshot path it
    already used."""
    _arrange(monkeypatch, installed=False)

    assert vs.start(":99") is None
    assert vs.is_running() is False


def test_a_server_that_dies_immediately_reports_failure(monkeypatch):
    _arrange(monkeypatch, alive=False, ready=False)

    assert vs.start(":99") is None
    assert vs.is_running() is False


def test_a_port_that_never_answers_is_cleaned_up_rather_than_trusted(monkeypatch):
    """The lesson xvfb_session.py records: 'the process has not exited' is a much weaker
    signal than 'the thing a client connects to actually answers'."""
    _arrange(monkeypatch, ready=False)
    monkeypatch.setattr(vs, "_READY_TIMEOUT_S", 0.05)

    assert vs.start(":99") is None
    assert vs.is_running() is False, "a server that never came up must not be left behind"


def test_a_spawn_that_raises_does_not_take_the_run_down(monkeypatch):
    _arrange(monkeypatch)

    def explode(*_a, **_kw):
        raise OSError("fork failed")

    monkeypatch.setattr(vs.subprocess, "Popen", explode)

    assert vs.start(":99") is None
    assert vs.is_running() is False


# ─── xauth, only when there is one ────────────────────────────────────────────

def test_the_cookie_is_passed_when_the_display_has_one(monkeypatch, tmp_path):
    cookie = tmp_path / ".Xauthority"
    cookie.write_text("x")
    seen: list = []
    _arrange(monkeypatch, seen=seen)
    monkeypatch.setenv("XAUTHORITY", str(cookie))

    vs.start(":99")

    assert seen[0][seen[0].index("-auth") + 1] == str(cookie)


def test_no_cookie_means_no_auth_flag(monkeypatch):
    """ensure_virtual_display() only gives Xvfb `-auth` when a cookie was set up first,
    so passing one here unconditionally would name a path that need not exist."""
    seen: list = []
    _arrange(monkeypatch, seen=seen)
    monkeypatch.delenv("XAUTHORITY", raising=False)

    vs.start(":99")

    assert "-auth" not in seen[0]


def test_a_stale_xauthority_path_is_ignored(monkeypatch, tmp_path):
    seen: list = []
    _arrange(monkeypatch, seen=seen)
    monkeypatch.setenv("XAUTHORITY", str(tmp_path / "gone"))

    vs.start(":99")

    assert "-auth" not in seen[0]
