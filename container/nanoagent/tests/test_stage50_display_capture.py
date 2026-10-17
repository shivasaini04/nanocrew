"""Stage 50 phase 1 — the live view captures the SCREEN, not one page.

`page.screenshot()` photographs a single Playwright Page object, so anything drawn
outside it is invisible to the person watching: a popup, an OAuth window, a native file
picker, a JS alert(). That is not a hypothetical. On 2026-09-03 a human took over to
sign in with Google, the flow opened a second tab, and the live view froze on the first
one — the click had worked, the camera was pointed at the wrong thing.

Commit fd413f3 pointed the camera at the *active* page, which fixed that instance.
This removes the class: the browser already renders headed onto an Xvfb display
(browser_session.py:322-331), both engines share it (camoufox's own 1x1 virtual display
is only used for headless='virtual', which we never pass), so grabbing the display shows
whatever is actually on screen regardless of which page object owns it.

The rule throughout: a display grab that does not work must leave the page screenshot
exactly as it was. A worse picture is not the same as no picture.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from nanoagent.agent.effector import browser_session as bs

_JPEG = b"\xff\xd8\xff" + b"DISPLAY-GRAB"
_PAGE_SHOT = b"\xff\xd8\xff" + b"PAGE-SHOT"


class _Page:
    def __init__(self):
        self.calls = 0

    async def screenshot(self, **_kw):
        self.calls += 1
        return _PAGE_SHOT


# One visible browser window, as xdotool --shell reports it. Real numbers, measured in
# the deployed image on 2026-09-03.
_ONE_WINDOW = b"WINDOW=2097155\nX=10\nY=10\nWIDTH=1288\nHEIGHT=805\nSCREEN=0\n"
# The same, plus a popup that opened as its own window beside it.
_TWO_WINDOWS = _ONE_WINDOW + b"WINDOW=2097170\nX=700\nY=300\nWIDTH=608\nHEIGHT=485\nSCREEN=0\n"


class _Proc:
    def __init__(self, returncode: int = 0, hang: bool = False, stdout: bytes = b""):
        self.returncode = returncode
        self._hang = hang
        self._stdout = stdout
        self.killed = False

    async def wait(self):
        # Hangs only until killed, like a real process: the code under test kills a
        # timed-out grab and then reaps it, and a fake that hung on the reap too would
        # deadlock the test rather than the thing it is testing.
        if self._hang and not self.killed:
            await asyncio.sleep(3600)
        return self.returncode

    async def communicate(self):
        if self._hang and not self.killed:
            await asyncio.sleep(3600)
        return self._stdout, b""

    def kill(self):
        self.killed = True


def _fake_tools(*, payload: bytes = _JPEG, returncode: int = 0, write: bool = True,
                hang: bool = False, seen: list | None = None,
                windows: bytes = _ONE_WINDOW):
    """Stands in for both tools the grab shells out to.

    `xdotool` answers with geometry on stdout; `scrot` writes the file it was told to
    write. Dispatching on argv[0] rather than having two patches keeps a test honest
    about the ORDER things happen in.
    """
    async def run(*args, **kwargs):
        if seen is not None:
            seen.append((args, kwargs))
        if args[0] == "xdotool":
            return _Proc(0, stdout=windows)
        if write:
            Path(args[-1]).write_bytes(payload)
        return _Proc(returncode, hang=hang)
    return run


def _call(seen: list, tool: str) -> tuple:
    """The (args, kwargs) of one tool's invocation out of everything the fake saw."""
    return next((a, k) for a, k in seen if a[0] == tool)


def _session(display: str | None = ":99") -> bs.EffectorSession:
    s = bs.EffectorSession.__new__(bs.EffectorSession)
    s.page = _Page()
    s._display = display
    return s


# ─── the point: what gets photographed ────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_run_with_a_display_grabs_the_whole_screen(monkeypatch):
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools())
    s = _session()

    assert await s._pump_screenshot() == _JPEG
    assert s.page.calls == 0, "the page must not be photographed when a display exists"


@pytest.mark.asyncio
async def test_the_grab_targets_the_display_the_browser_is_actually_on(monkeypatch):
    """Not $DISPLAY as it happens to be in this process — the one the session recorded
    when it started the browser. Those can differ on a warm daemon."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools(seen=seen))
    monkeypatch.setenv("DISPLAY", ":0")

    await _session(":99")._pump_screenshot()

    for tool in ("xdotool", "scrot"):
        _, kwargs = _call(seen, tool)
        assert kwargs["env"]["DISPLAY"] == ":99", f"{tool} was pointed at the wrong display"


# ─── every failure degrades to the old behaviour, never to nothing ────────────

@pytest.mark.asyncio
async def test_a_failed_grab_falls_back_to_the_page(monkeypatch):
    monkeypatch.setattr(asyncio, "create_subprocess_exec",
                        _fake_tools(returncode=1, write=False))
    s = _session()

    assert await s._pump_screenshot() == _PAGE_SHOT
    assert s.page.calls == 1


@pytest.mark.asyncio
async def test_a_grab_that_writes_nothing_falls_back_to_the_page(monkeypatch):
    """scrot exited cleanly but produced no file — seen when a display goes away
    mid-run. Success is the file existing, not the exit code alone."""
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools(write=False))
    s = _session()

    assert await s._pump_screenshot() == _PAGE_SHOT


@pytest.mark.asyncio
async def test_no_scrot_on_the_image_falls_back_to_the_page(monkeypatch):
    async def missing(*_a, **_kw):
        raise FileNotFoundError("scrot")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", missing)
    s = _session()

    assert await s._pump_screenshot() == _PAGE_SHOT


@pytest.mark.asyncio
async def test_a_hung_grab_is_killed_and_does_not_wedge_the_pump(monkeypatch):
    """The pump runs once a second forever. A grab that never returns must be dropped,
    and its process must not be left behind on a warm daemon that outlives this cycle."""
    procs: list = []

    async def hanging(*args, **_kwargs):
        proc = _Proc(hang=True)
        procs.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", hanging)
    monkeypatch.setattr(bs, "_DISPLAY_GRAB_TIMEOUT_S", 0.02)
    s = _session()

    assert await s._pump_screenshot() == _PAGE_SHOT
    assert procs[0].killed is True, "a timed-out grab must not leave the process running"


# ─── the lanes that have no display must not pay for this ─────────────────────

@pytest.mark.asyncio
async def test_a_run_with_no_display_never_forks_anything(monkeypatch):
    """The remote lane drives the user's own browser on their own machine: there is no
    container display to grab, and forking scrot once a second to find that out would be
    pure waste."""
    async def must_not_run(*_a, **_kw):
        raise AssertionError("no display: nothing should have been forked")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", must_not_run)
    s = _session(display=None)

    assert await s._pump_screenshot() == _PAGE_SHOT
    assert s.page.calls == 1


@pytest.mark.asyncio
async def test_a_session_that_never_set_a_display_still_pumps(monkeypatch):
    """Several tests build a session with __new__ and set only `page`. The pump must not
    assume the attribute exists."""
    s = bs.EffectorSession.__new__(bs.EffectorSession)
    s.page = _Page()

    assert await s._pump_screenshot() == _PAGE_SHOT


# ─── housekeeping ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_frame_file_is_not_left_behind(monkeypatch):
    """Once a second for the length of a run, inside a container whose /tmp is not
    swept. Leaking a JPEG per frame fills the disk the browser is running on."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools(seen=seen))

    await _session()._pump_screenshot()

    args, _ = _call(seen, "scrot")
    assert not Path(args[-1]).exists(), "the temp frame must be cleaned up"


@pytest.mark.asyncio
async def test_two_grabs_do_not_share_a_filename(monkeypatch):
    """Warm daemons run many cycles in one container, and nothing says two sessions
    cannot overlap. A fixed filename would have them overwrite each other's frames."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools(seen=seen))
    s = _session()

    await s._pump_screenshot()
    await s._pump_screenshot()

    paths = [a[-1] for a, _ in seen if a[0] == "scrot"]
    assert len(paths) == 2 and paths[0] != paths[1]


# ─── cropping to the browser, so the frame is not mostly black desktop ────────

@pytest.mark.asyncio
async def test_the_grab_is_cropped_to_the_browser_window(monkeypatch):
    """Measured in the deployed image: a 1288x805 browser on a 1920x1080 root leaves
    ~49% of every frame as black desktop, paid for on every frame."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_tools(seen=seen))

    await _session()._pump_screenshot()

    args, _ = _call(seen, "scrot")
    assert "-a" in args
    assert args[args.index("-a") + 1] == "10,10,1288,805"


@pytest.mark.asyncio
async def test_the_crop_covers_a_popup_that_opened_beside_the_main_window(monkeypatch):
    """The union, not the first window. A popup opening outside the crop would be
    invisible again — which is the entire bug this change exists to remove."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec",
                        _fake_tools(seen=seen, windows=_TWO_WINDOWS))

    await _session()._pump_screenshot()

    args, _ = _call(seen, "scrot")
    # main   10,10  1288x805 -> right 1298, bottom 815
    # popup 700,300  608x485 -> right 1308, bottom 785
    # union: x=10 y=10 w=1308-10=1298 h=815-10=805
    assert args[args.index("-a") + 1] == "10,10,1298,805"


@pytest.mark.asyncio
async def test_no_windows_found_grabs_the_whole_display(monkeypatch):
    """"Could not tell" must mean the full screen, never a guessed rectangle."""
    seen: list = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec",
                        _fake_tools(seen=seen, windows=b""))

    assert await _session()._pump_screenshot() == _JPEG
    args, _ = _call(seen, "scrot")
    assert "-a" not in args


@pytest.mark.asyncio
async def test_a_window_partly_off_screen_does_not_produce_a_negative_origin(monkeypatch):
    """scrot refuses a region that starts outside the root window."""
    seen: list = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec",
        _fake_tools(seen=seen,
                    windows=b"WINDOW=1\nX=-40\nY=-20\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n"),
    )

    await _session()._pump_screenshot()

    args, _ = _call(seen, "scrot")
    x, y, w, h = args[args.index("-a") + 1].split(",")
    assert int(x) >= 0 and int(y) >= 0


@pytest.mark.asyncio
async def test_a_broken_xdotool_still_gets_you_a_frame(monkeypatch):
    """Geometry is an optimisation. Losing it costs black borders, not the live view."""
    async def run(*args, **_kwargs):
        if args[0] == "xdotool":
            raise FileNotFoundError("xdotool")
        Path(args[-1]).write_bytes(_JPEG)
        return _Proc(0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", run)

    assert await _session()._pump_screenshot() == _JPEG
