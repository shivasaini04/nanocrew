"""God-level gap fix, 2026-08-24: two separate, sequential fixes to the same
function, found live against two different real failure modes.

Fix 1 — ensure_virtual_display() never verified Xvfb actually stayed alive after
launch; it slept 0.3s and unconditionally reported success. Found live against a
real PERSISTENT agent daemon (NANOBOT_PERSISTENT=on keeps the same
container/process warm across many cycles): Xvfb crashed once, left its lock file
behind, and every subsequent effector call on that SAME daemon failed with "no
XServer running" — a one-time crash became a permanent failure for the daemon's
whole remaining lifetime.

Fix 2 — checking "the process hasn't exited" turned out not to be enough. Found
live AGAIN, minutes later, against a genuinely fresh ONE-SHOT container (not a
persistent daemon — the stale-lock theory didn't even apply): a real cycle starts
Xvfb at the same moment as several other processes (MCP servers, git, the
decision-model call) competing for CPU, and under that contention "the process
object hasn't reported an exit code yet" (true almost instantly) is a much weaker
signal than "the actual X11 socket exists yet." Replaced the flat 0.3s sleep with
`_wait_for_display_ready`, which polls for the real socket file Chromium is about
to connect to.

These tests drive ensure_virtual_display()/_wait_for_display_ready()/
_clear_stale_lock() directly, with subprocess.Popen faked (a real Xvfb can't run
in a unit test) and lock/socket file paths monkeypatched into tmp_path so nothing
touches real system files.
"""

from __future__ import annotations

import os
import sys

import pytest

from nanoagent.agent.effector.desktop import xvfb_session


class _FakeProc:
    """Stands in for subprocess.Popen's return value. `poll_sequence` lets a test
    control what .poll() returns on successive calls — None means "still running"."""

    def __init__(self, poll_sequence, returncode=1):
        self._poll_sequence = list(poll_sequence)
        self.returncode = returncode
        self.terminate_called = False
        self.wait_called = False

    def poll(self):
        if self._poll_sequence:
            return self._poll_sequence.pop(0)
        return None  # sequence exhausted — behaves as "still running" from here on

    def terminate(self):
        self.terminate_called = True

    def wait(self, timeout=None):
        self.wait_called = True

    def kill(self):
        pass


@pytest.fixture(autouse=True)
def _reset_module_state(monkeypatch):
    """The module-level _xvfb_proc global is genuinely cross-cycle in prod (that's
    fix 1's whole point) — but must not leak between tests here."""
    monkeypatch.setattr(xvfb_session, "_xvfb_proc", None)
    monkeypatch.setattr(xvfb_session.shutil, "which", lambda _: "/usr/bin/Xvfb")


# ─── ensure_virtual_display: orchestration (retry/lock/terminate logic) ────────
# _wait_for_display_ready is mocked directly here — these tests care about the
# retry/lock/cleanup ORCHESTRATION, not the socket-polling mechanics (covered in
# their own section below).

def test_returns_none_when_xvfb_is_not_installed(monkeypatch):
    monkeypatch.setattr(xvfb_session.shutil, "which", lambda _: None)
    assert xvfb_session.ensure_virtual_display() is None


def test_returns_the_display_and_sets_env_when_xvfb_becomes_ready(monkeypatch):
    monkeypatch.setattr(xvfb_session.subprocess, "Popen", lambda *a, **kw: _FakeProc(poll_sequence=[None]))
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", lambda proc, path: True)
    monkeypatch.delenv("DISPLAY", raising=False)

    result = xvfb_session.ensure_virtual_display()

    assert result == xvfb_session._DISPLAY
    assert os.environ["DISPLAY"] == xvfb_session._DISPLAY


def test_an_already_running_instance_is_reused_without_relaunching(monkeypatch):
    calls = []
    monkeypatch.setattr(
        xvfb_session.subprocess, "Popen",
        lambda *a, **kw: calls.append(1) or _FakeProc(poll_sequence=[None]),
    )
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", lambda proc, path: True)

    xvfb_session.ensure_virtual_display()
    assert len(calls) == 1

    # Second call — the tracked process is still alive (poll() keeps returning None
    # since _FakeProc's sequence is exhausted and falls through) — must not relaunch.
    xvfb_session.ensure_virtual_display()
    assert len(calls) == 1


def test_this_is_fix_1s_bug_a_dead_process_is_no_longer_reported_as_ready(monkeypatch):
    """Before fix 1: Popen is called, the process exits immediately, and
    ensure_virtual_display STILL returned the display string as if it worked."""
    monkeypatch.setattr(xvfb_session.subprocess, "Popen", lambda *a, **kw: _FakeProc(poll_sequence=[1, 1]))
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", lambda proc, path: False)
    monkeypatch.setattr(xvfb_session, "_clear_stale_lock", lambda display: None)

    result = xvfb_session.ensure_virtual_display()

    assert result is None  # honest failure, not a lie


def test_retries_once_after_a_stale_lock_and_succeeds(monkeypatch):
    """The realistic fix-1 recovery case: attempt 1 dies (stale lock from a prior
    crash), the lock gets cleared, attempt 2 actually binds the display."""
    attempts = {"n": 0}

    def fake_popen(*a, **kw):
        attempts["n"] += 1
        return _FakeProc(poll_sequence=[1] if attempts["n"] == 1 else [None])

    def fake_ready(proc, path):
        return attempts["n"] > 1  # only "ready" on the second attempt

    monkeypatch.setattr(xvfb_session.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", fake_ready)
    cleared = []
    monkeypatch.setattr(xvfb_session, "_clear_stale_lock", lambda display: cleared.append(display))

    result = xvfb_session.ensure_virtual_display()

    assert result == xvfb_session._DISPLAY
    assert attempts["n"] == 2
    assert len(cleared) == 2  # once before the first attempt, once after it failed


def test_this_is_fix_2s_bug_a_process_thats_alive_but_never_readied_up_is_terminated_and_retried(monkeypatch):
    """The fix-2 case: the process never dies (poll() stays None throughout — it's
    genuinely running, just slow to bind under load) but _wait_for_display_ready
    times out. Must not be left alive racing the retry attempt for the same
    display — terminate() must be called before clearing the lock and retrying."""
    proc_holder = {}

    def fake_popen(*a, **kw):
        p = _FakeProc(poll_sequence=[])  # never exits on its own — poll() always None
        proc_holder.setdefault("first", p)
        return p

    ready_calls = {"n": 0}

    def fake_ready(proc, path):
        ready_calls["n"] += 1
        return ready_calls["n"] > 1  # first attempt times out, second succeeds

    monkeypatch.setattr(xvfb_session.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", fake_ready)
    monkeypatch.setattr(xvfb_session, "_clear_stale_lock", lambda display: None)

    result = xvfb_session.ensure_virtual_display()

    assert result == xvfb_session._DISPLAY
    assert proc_holder["first"].terminate_called  # the stuck-but-alive first attempt was killed


def test_gives_up_and_returns_none_after_exhausting_the_retry(monkeypatch):
    monkeypatch.setattr(xvfb_session.subprocess, "Popen", lambda *a, **kw: _FakeProc(poll_sequence=[1]))
    monkeypatch.setattr(xvfb_session, "_wait_for_display_ready", lambda proc, path: False)
    monkeypatch.setattr(xvfb_session, "_clear_stale_lock", lambda display: None)

    result = xvfb_session.ensure_virtual_display()

    assert result is None
    assert xvfb_session._xvfb_proc is None  # doesn't leave a dead process "tracked" as live


def test_a_popen_exception_still_returns_none_immediately_no_retry_needed(monkeypatch):
    def raise_err(*a, **kw):
        raise OSError("no such file or directory: Xvfb")
    monkeypatch.setattr(xvfb_session.subprocess, "Popen", raise_err)

    assert xvfb_session.ensure_virtual_display() is None


# ─── _wait_for_display_ready: the actual socket-polling logic (fix 2) ──────────

def test_wait_for_display_ready_returns_true_as_soon_as_the_socket_appears(tmp_path):
    socket_path = tmp_path / "X99"
    socket_path.write_text("")  # already exists before the poll loop even starts
    proc = _FakeProc(poll_sequence=[])  # stays "alive" (poll() -> None) throughout

    assert xvfb_session._wait_for_display_ready(proc, socket_path, timeout_s=0.2) is True


def test_wait_for_display_ready_returns_false_immediately_if_the_process_dies(tmp_path):
    socket_path = tmp_path / "X99"  # never created
    proc = _FakeProc(poll_sequence=[1])  # dead on the very first poll

    # A generous timeout that would fail the test if this actually waited it out —
    # dying should short-circuit, not wait for the full timeout window.
    assert xvfb_session._wait_for_display_ready(proc, socket_path, timeout_s=5.0) is False


def test_wait_for_display_ready_returns_false_after_timeout_with_no_socket(tmp_path):
    socket_path = tmp_path / "X99"  # never created
    proc = _FakeProc(poll_sequence=[])  # alive the whole time, just never binds

    assert xvfb_session._wait_for_display_ready(proc, socket_path, timeout_s=0.1) is False


# ─── _socket_path / _lock_path: naming conventions ─────────────────────────────

def test_socket_path_follows_the_real_x11_naming_convention():
    assert xvfb_session._socket_path(":99").name == "X99"
    assert xvfb_session._socket_path(":0").name == "X0"
    assert xvfb_session._socket_path(":99").parent.name == ".X11-unix"


def test_lock_path_follows_the_real_x11_naming_convention():
    assert xvfb_session._lock_path(":99").name == ".X99-lock"
    assert xvfb_session._lock_path(":0").name == ".X0-lock"


# ─── _clear_stale_lock: the actual lock-file logic (fix 1, unchanged by fix 2) ─

@pytest.mark.skipif(
    sys.platform == "win32",
    reason="dead-PID detection relies on os.kill(pid, 0) raising ProcessLookupError, "
           "POSIX-only semantics — this module (Xvfb) only ever runs in the Linux "
           "container in production, never on Windows",
)
def test_clear_stale_lock_removes_a_lock_naming_a_dead_pid(tmp_path, monkeypatch):
    lock = tmp_path / ".X99-lock"
    # A PID essentially guaranteed not to be running — the classic "check a dead pid"
    # trick used by process-liveness code everywhere.
    dead_pid = 2**31 - 1
    lock.write_text(str(dead_pid))
    monkeypatch.setattr(xvfb_session, "_lock_path", lambda display: lock)

    xvfb_session._clear_stale_lock(":99")

    assert not lock.exists()


def test_clear_stale_lock_leaves_a_lock_naming_a_live_pid_untouched(tmp_path, monkeypatch):
    lock = tmp_path / ".X99-lock"
    lock.write_text(str(os.getpid()))  # this test process — guaranteed alive
    monkeypatch.setattr(xvfb_session, "_lock_path", lambda display: lock)

    xvfb_session._clear_stale_lock(":99")

    assert lock.exists()  # a REAL running Xvfb's lock must never be removed


def test_clear_stale_lock_is_a_no_op_when_no_lock_file_exists(tmp_path, monkeypatch):
    lock = tmp_path / ".X99-lock"  # never created
    monkeypatch.setattr(xvfb_session, "_lock_path", lambda display: lock)

    xvfb_session._clear_stale_lock(":99")  # must not raise

    assert not lock.exists()


def test_clear_stale_lock_is_a_no_op_on_unparseable_content(tmp_path, monkeypatch):
    lock = tmp_path / ".X99-lock"
    lock.write_text("not a pid at all")
    monkeypatch.setattr(xvfb_session, "_lock_path", lambda display: lock)

    xvfb_session._clear_stale_lock(":99")  # must not raise

    assert lock.exists()  # left alone rather than guessed at
