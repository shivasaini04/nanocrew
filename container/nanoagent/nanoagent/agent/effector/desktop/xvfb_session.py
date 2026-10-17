"""Virtual display management for Linux desktop automation.

Not a TS port — new infrastructure the Linux path of desktop_driver.py/
desktop_vision.py needs. The container has no GUI; this starts a headless X server
(Xvfb) lazily on first use, so the ~99% of cycles that never touch desktop
automation never pay for it.

Correction, 2026-08-24: the "one process-lifetime instance, a container run is a
single cycle" assumption below was wrong for how this actually runs in prod —
`NANOBOT_PERSISTENT=on` keeps the SAME container/process warm across MANY cycles
for one agent (see docs/DEPLOY_GUIDE.md), so this module's state genuinely is
cross-cycle. Found live: Xvfb crashed once on a persistent daemon, left its lock
file behind, and every effector call on that SAME daemon afterward failed with
"no X server" — `ensure_virtual_display()` never checked whether the process it
just started was actually still alive, so it kept lying that the display was
ready. See `_clear_stale_lock`/the retry loop below.

Second correction, same day: the fix above (verify the process hasn't exited)
was necessary but not sufficient — found live AGAIN, against a genuinely fresh,
never-before-used ONE-SHOT container (agentId 344a5040..., not the persistent
daemon this module's first correction was about), so the stale-lock theory
didn't even apply here. Reproduced directly: launching Xvfb with nothing else
running, its socket appears in ~20ms — comfortably inside the old flat 0.3s
sleep. But a real cycle starts Xvfb at the SAME moment as several MCP server
processes, git, and the decision-model's own startup, all competing for CPU —
under that contention, "the process object hasn't reported an exit code yet"
(true almost immediately) is a much weaker signal than "the socket Chromium is
about to connect to actually exists yet." `_wait_for_display_ready` replaces
the flat sleep with a bounded poll for the real X11 socket file, so a slow
bind under load gets waited out instead of raced against.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from loguru import logger

_DISPLAY = os.environ.get("EFFECTOR_VIRTUAL_DISPLAY", ":99")
_xvfb_proc: subprocess.Popen | None = None
_current_xauth_path: Path | None = None


def _lock_path(display: str) -> Path:
    # X11 convention: display ":99" locks at /tmp/.X99-lock, containing the owning
    # Xvfb process's PID as ASCII text.
    return Path(f"/tmp/.X{display.lstrip(':')}-lock")


def _socket_path(display: str) -> Path:
    # X11 convention: display ":99" listens on the unix-domain socket at
    # /tmp/.X11-unix/X99 — the actual thing a client (Chromium) connects to, and
    # so the real signal that Xvfb is ready, unlike "the process hasn't exited".
    return Path(f"/tmp/.X11-unix/X{display.lstrip(':')}")


def _wait_for_display_ready(proc: subprocess.Popen, socket_path: Path, timeout_s: float = 3.0) -> bool:
    """Poll for the actual X11 socket to appear instead of trusting a fixed sleep.
    Returns False the moment the process dies (no point waiting out the rest of
    the timeout for a socket that will never appear), or after `timeout_s` with
    no socket — both are genuine "not ready" outcomes, not just the earlier
    process-death case alone. See the module docstring's second correction for
    why a flat sleep wasn't safe under real concurrent load."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        if socket_path.exists():
            return True
        time.sleep(0.02)
    return proc.poll() is None and socket_path.exists()


def _clear_stale_lock(display: str) -> None:
    """A crashed Xvfb leaves its lock file behind, which makes every later start
    attempt for the same display fail immediately (Xvfb refuses to bind a display
    whose lock file already exists) — this is exactly what turned one transient
    crash into a permanent failure for the rest of that daemon's lifetime. Only
    removes the lock when the PID it names is verifiably NOT running; a live lock
    from a genuinely running Xvfb is never touched."""
    lock = _lock_path(display)
    try:
        pid = int(lock.read_text().strip())
        os.kill(pid, 0)  # raises if that PID isn't running; no-op if it is
    except ProcessLookupError:
        lock.unlink(missing_ok=True)
        logger.debug(f"effector desktop: cleared a stale Xvfb lock ({lock}, dead pid)")
    except FileNotFoundError:
        pass  # no lock to clear
    except (ValueError, OSError):
        pass  # unreadable/unparseable — leave it; a real failure surfaces below anyway


def setup_xauth_cookie(display: str = _DISPLAY, xauth_path: Path | None = None) -> Path:
    """Generates a 128-bit MIT-MAGIC-COOKIE-1 and writes to an xauthority file with 0600 permissions."""
    global _current_xauth_path
    if xauth_path is None:
        raw_env = os.environ.get("XAUTHORITY")
        if raw_env:
            xauth_path = Path(raw_env)
        else:
            xauth_path = Path(os.environ.get("TMPDIR", "/tmp")) / ".effector_xauth"

    xauth_path.parent.mkdir(parents=True, exist_ok=True)
    cookie = secrets.token_hex(16)

    if shutil.which("xauth") is not None:
        try:
            subprocess.run(
                ["xauth", "-f", str(xauth_path), "add", display, ".", cookie],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
        except Exception as err:
            logger.debug(f"xvfb_session: xauth command fallback ({err})")
            xauth_path.write_text(f"{display} MIT-MAGIC-COOKIE-1 {cookie}\n", encoding="utf-8")
    else:
        xauth_path.write_text(f"{display} MIT-MAGIC-COOKIE-1 {cookie}\n", encoding="utf-8")

    try:
        os.chmod(xauth_path, 0o600)
    except OSError:
        pass

    os.environ["XAUTHORITY"] = str(xauth_path)
    _current_xauth_path = xauth_path
    return xauth_path


def ensure_authenticated_virtual_display(
    width: int = 1920,
    height: int = 1080,
    xauth_path: Path | None = None,
) -> str | None:
    """Spawns Xvfb display protected with MIT-MAGIC-COOKIE-1 authentication."""
    setup_xauth_cookie(_DISPLAY, xauth_path)
    return ensure_virtual_display(width, height)


def ensure_virtual_display(width: int = 1920, height: int = 1080) -> str | None:
    """Idempotently start Xvfb on `_DISPLAY` if not already running in this
    process. Returns the DISPLAY string to use, or None if Xvfb isn't installed or
    genuinely can't start — desktop automation degrades to the same
    silent-fallback contract the TS original already has for unsupported
    platforms, not a hard error.

    Waits for the actual X11 socket to appear (bounded, see
    `_wait_for_display_ready`) rather than trusting a fixed sleep — a
    not-yet-crashed process isn't the same guarantee as "ready to accept
    connections" under real concurrent load — and retries once after clearing a
    stale lock before giving up."""
    global _xvfb_proc

    if _xvfb_proc is not None and _xvfb_proc.poll() is None:
        return _DISPLAY

    if shutil.which("Xvfb") is None:
        logger.warning("effector desktop: Xvfb not installed — desktop automation unavailable on this image")
        return None

    _clear_stale_lock(_DISPLAY)
    socket_path = _socket_path(_DISPLAY)

    cmd = ["Xvfb", _DISPLAY, "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp"]
    if _current_xauth_path and _current_xauth_path.exists():
        cmd.extend(["-auth", str(_current_xauth_path)])

    for attempt in range(1, 3):
        try:
            _xvfb_proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as err:
            logger.warning(f"effector desktop: failed to start Xvfb — {err}")
            return None

        if _wait_for_display_ready(_xvfb_proc, socket_path):
            os.environ["DISPLAY"] = _DISPLAY
            return _DISPLAY

        logger.warning(
            f"effector desktop: Xvfb did not become ready in time (attempt {attempt}/2, "
            f"exit code {_xvfb_proc.poll()}) — clearing any lock and retrying"
        )
        if _xvfb_proc.poll() is None:
            # Timed out waiting for the socket but the process is still alive —
            # don't leave two Xvfb instances racing for the same display on the retry.
            _xvfb_proc.terminate()
            try:
                _xvfb_proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _xvfb_proc.kill()
        _clear_stale_lock(_DISPLAY)

    logger.warning("effector desktop: Xvfb failed to start after retry — falling back to headless")
    _xvfb_proc = None
    return None


def is_virtual_display_running() -> bool:
    return _xvfb_proc is not None and _xvfb_proc.poll() is None


def stop_virtual_display() -> None:
    global _xvfb_proc
    if _xvfb_proc is not None and _xvfb_proc.poll() is None:
        _xvfb_proc.terminate()
        try:
            _xvfb_proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _xvfb_proc.kill()
    _xvfb_proc = None
