"""x11vnc against the display the browser is already on (stage 50 phase 2).

## Why a VNC server at all

The live view ships a JPEG of the screen roughly once a second. That is fine for
glancing at what the agent is doing, and poor for actually driving: every frame is a
whole image even when one pixel moved, and a second of latency is a long time when you
are trying to click something. VNC sends only the rectangles that changed and carries
input back on the same connection.

It also does not care which browser drew the pixels, which is the part that matters
here. CDP's `Page.startScreencast` is a real push-stream but is Chromium-only, and our
stealth engine is Gecko — so a CDP-based live view structurally cannot serve the lane we
most want to watch. Reading the framebuffer is below the browser, so both lanes look
identical to it.

## What this does NOT do

It does not start a display. `desktop/xvfb_session.py` already did that, the browser is
already rendering onto it (browser_session.py launches headed), and starting a second
one would give us a blank screen to serve. This attaches to what is there.

It is also not the security boundary. x11vnc listens on 127.0.0.1 only and takes no
password: nothing outside the container can reach the port, and inside the container
everything already runs as the same user with the same access to the display. The real
gate is the cycle token on the relay that carries these bytes out (phase 3).

## Lifecycle, which is the part that bites

`xvfb_session.py` has two corrections in its own docstring, both from the same cause:
`NANOBOT_PERSISTENT=on` keeps one container warm across MANY cycles, so module state is
cross-cycle state. A leaked x11vnc is exactly that shape of bug — it would sit holding
the display of a run that ended, and the next cycle's viewer would be looking at it.
So: one instance per process, verified alive rather than assumed, and stopped explicitly
when the run that asked for it finishes.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time

from loguru import logger

# Bound to loopback, always. A VNC server reachable from outside the container would be
# an unauthenticated remote-control surface on a browser that may be signed into things.
_BIND = "127.0.0.1"

# How long to wait for x11vnc to actually accept a connection. It forks, scans the
# display and binds; on a loaded container that is not instant. Polled rather than
# slept, for the reason xvfb_session.py learned the hard way — "the process has not
# exited yet" is a much weaker signal than "the port answers".
_READY_TIMEOUT_S = 6.0

_proc: subprocess.Popen | None = None
_port: int | None = None


def _free_port() -> int:
    """A port the OS says is free, rather than a fixed 5900.

    Warm daemons run many cycles in one container and nothing guarantees the previous
    server is fully gone, so a hardcoded port is a collision waiting to happen. Racy in
    principle — the socket closes before x11vnc binds — but the window is microseconds
    and the alternative (parsing x11vnc's own port selection out of its log) is worse.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((_BIND, 0))
        return s.getsockname()[1]


def _accepts_connections(port: int, timeout_s: float = 0.25) -> bool:
    try:
        with socket.create_connection((_BIND, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _wait_until_ready(proc: subprocess.Popen, port: int) -> bool:
    deadline = time.monotonic() + _READY_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False          # died; no point waiting out the rest
        if _accepts_connections(port):
            return True
        time.sleep(0.05)
    return False


def is_running() -> bool:
    return _proc is not None and _proc.poll() is None


def current_port() -> int | None:
    return _port if is_running() else None


def start(display: str) -> int | None:
    """Serve `display` over VNC on loopback. Returns the port, or None.

    None is a supported outcome, not a failure to shout about: no x11vnc on the image
    means the live view stays on screenshots, which is exactly what it does today.
    """
    global _proc, _port

    if is_running():
        return _port

    if shutil.which("x11vnc") is None:
        logger.debug("effector vnc: x11vnc not installed — live view stays on screenshots")
        return None

    port = _free_port()
    cmd = [
        "x11vnc",
        "-display", display,
        "-rfbport", str(port),
        "-localhost",      # loopback only; the relay's cycle token is the real gate
        "-nopw",           # see the module docstring: the port is not the boundary
        "-forever",        # outlive a viewer disconnect — a person may come back
        "-shared",         # a second viewer must not evict the first
        "-quiet",
        # DAMAGE stays ON. This carried `-noxdamage` on the theory that Xvfb's damage
        # reporting is unreliable, which cost exactly what turning it off costs: without
        # DAMAGE, x11vnc has no idea which pixels changed and must poll the whole
        # 1920x1080 screen looking for differences. Reported from a live run as "so much
        # slow". Xvfb implements DAMAGE properly; if a stale region ever does appear,
        # the fix is `-noxdamage` on that deployment, not on everyone by default.
        #
        # Wait a little for a burst to finish rather than shipping a half-drawn frame,
        # and cap the rate so a busy page cannot saturate the relay.
        "-defer", "30",
        "-wait", "30",
        # A pointer that moves without a full framebuffer update. Without this every
        # mouse move is a screen region to re-send, which is most of what a person
        # driving actually does.
        "-cursor", "most",
    ]
    # Only if the display is actually cookie-protected. ensure_virtual_display() adds
    # `-auth` to Xvfb only when a cookie was set up first, so passing one here
    # unconditionally would hand x11vnc a path that need not exist.
    xauth = os.environ.get("XAUTHORITY")
    if xauth and os.path.exists(xauth):
        cmd.extend(["-auth", xauth])

    try:
        _proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as err:  # noqa: BLE001
        logger.warning(f"effector vnc: could not start x11vnc — {err}")
        _proc = None
        return None

    if not _wait_until_ready(_proc, port):
        logger.warning(
            f"effector vnc: x11vnc did not accept connections in time "
            f"(exit {_proc.poll()}) — live view stays on screenshots"
        )
        stop()
        return None

    _port = port
    logger.info(f"effector vnc: serving {display} on {_BIND}:{port}")
    return port


def stop() -> None:
    """Idempotent, and safe to call on a teardown path that may run twice."""
    global _proc, _port
    if _proc is not None and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None
    _port = None
