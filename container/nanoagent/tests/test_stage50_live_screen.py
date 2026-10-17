"""Stage 50 phase 5 — the live screen's lifecycle.

The screen is up only while a human is driving. That is a product decision (a VNC
session costs CPU and bandwidth for as long as it is open, and watching does not need
it) but it is mostly a SAFETY one, and the tests here are about the safety half.

`NANOBOT_PERSISTENT=on` keeps one container warm across many cycles. Anything still
running when a run ends is still running when the next one starts — here that would be
an x11vnc holding a display, and a relay socket authenticated with a token that has
since been revoked. `xvfb_session.py` carries two corrections in its own docstring from
exactly this shape of bug, so the rule is: every way out of a takeover takes the screen
down, including the ones that are not the happy path.
"""

from __future__ import annotations

import asyncio

import pytest

from nanoagent.agent.effector import react_loop as rl
from nanoagent.agent.effector.live_screen import LiveScreen
from nanoagent.agent.effector.takeover import TakeoverSession


class _Page:
    def __init__(self):
        self.viewport_size = {"width": 1280, "height": 720}
        self.mouse = None
        self.keyboard = None


class _Screen:
    """Records what the loop did to it."""

    def __init__(self, starts_ok: bool = True):
        self.started = 0
        self.stopped = 0
        self._ok = starts_ok

    async def start(self):
        self.started += 1
        return self._ok

    async def stop(self):
        self.stopped += 1


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(rl, "_TAKEOVER_POLL_S", 0.01)
    monkeypatch.setattr(rl, "_TAKEOVER_TIMEOUT_S", 0.2)
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)


# ─── up for the takeover, down again afterwards ───────────────────────────────

@pytest.mark.asyncio
async def test_the_screen_comes_up_when_a_human_is_asked_for():
    session = TakeoverSession(_Page())
    screen = _Screen()

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    await rl._await_human_takeover(session, "Sign in", 1, None, screen)

    assert screen.started == 1


@pytest.mark.asyncio
async def test_handing_back_takes_it_down():
    session = TakeoverSession(_Page())
    screen = _Screen()

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    await rl._await_human_takeover(session, "Sign in", 1, None, screen)

    assert screen.stopped == 1


@pytest.mark.asyncio
async def test_nobody_coming_takes_it_down_too():
    """The path most likely to leak: the run gives up on its own, with no release and
    nobody watching to notice a server left behind."""
    session = TakeoverSession(_Page())
    screen = _Screen()

    granted = await rl._await_human_takeover(session, "Sign in", 1, None, screen)

    assert granted is False
    assert screen.stopped == 1


@pytest.mark.asyncio
async def test_stop_takes_it_down_too(monkeypatch):
    """Cancelled by an operator pressing Stop — an exit that returns from inside the
    wait loop, which is exactly the kind a `finally` exists for."""
    monkeypatch.setattr(rl, "_TAKEOVER_INTERRUPT_CHECK_S", 0.01)

    async def interrupted():
        return True

    monkeypatch.setattr(rl, "_is_interrupted", interrupted)

    session = TakeoverSession(_Page())
    screen = _Screen()

    await rl._await_human_takeover(session, "Sign in", 1, None, screen)

    assert screen.stopped == 1


@pytest.mark.asyncio
async def test_a_screen_that_will_not_start_does_not_stop_the_takeover():
    """No x11vnc on the image, or the remote lane with no container display. The human
    drives the screenshot instead — worse, not broken."""
    session = TakeoverSession(_Page())
    screen = _Screen(starts_ok=False)

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    granted = await rl._await_human_takeover(session, "Sign in", 1, None, screen)

    assert granted is True


@pytest.mark.asyncio
async def test_a_screen_that_raises_on_start_does_not_stop_the_takeover():
    session = TakeoverSession(_Page())

    class Exploding(_Screen):
        async def start(self):
            raise RuntimeError("x11vnc went missing")

    screen = Exploding()

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    assert await rl._await_human_takeover(session, "Sign in", 1, None, screen) is True
    assert screen.stopped == 1, "a failed start must still be cleaned up after"


@pytest.mark.asyncio
async def test_a_screen_that_raises_on_stop_does_not_fail_the_run():
    """Teardown is the worst place to raise: the work is already done."""
    session = TakeoverSession(_Page())

    class Exploding(_Screen):
        async def stop(self):
            raise RuntimeError("could not stop")

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    assert await rl._await_human_takeover(session, "Sign in", 1, Exploding()) is True


@pytest.mark.asyncio
async def test_a_run_with_no_screen_at_all_behaves_as_before():
    session = TakeoverSession(_Page())

    async def hand_back():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(hand_back())
    assert await rl._await_human_takeover(session, "Sign in", 1) is True


# ─── LiveScreen itself ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_lane_with_no_display_starts_nothing(monkeypatch):
    """The remote lane drives the user's own browser on their own machine. There is no
    container screen to serve, and trying would be the wrong kind of noise."""
    from nanoagent.agent.effector.desktop import vnc_session

    def must_not_start(_display):
        raise AssertionError("nothing should have been started")

    monkeypatch.setattr(vnc_session, "start", must_not_start)

    screen = LiveScreen(None)
    assert await screen.start() is False
    assert screen.running is False


@pytest.mark.asyncio
async def test_no_x11vnc_means_no_screen_rather_than_an_error(monkeypatch):
    from nanoagent.agent.effector.desktop import vnc_session

    monkeypatch.setattr(vnc_session, "start", lambda _d: None)

    screen = LiveScreen(":99")
    assert await screen.start() is False
    assert screen.running is False


@pytest.mark.asyncio
async def test_x11vnc_is_stopped_when_there_is_nowhere_to_relay_to(monkeypatch):
    """Outside a real cycle there is no token and nowhere to dial. Starting the server
    and then walking away would leave it running for the life of the container."""
    from nanoagent.agent.effector.desktop import vnc_session

    stopped = []
    monkeypatch.setattr(vnc_session, "start", lambda _d: 5931)
    monkeypatch.setattr(vnc_session, "stop", lambda: stopped.append(True))
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)

    screen = LiveScreen(":99")
    assert await screen.start() is False
    assert stopped, "the server must not be left running with no relay"


@pytest.mark.asyncio
async def test_a_relay_that_will_not_dial_also_stops_the_server(monkeypatch):
    from nanoagent.agent.effector.desktop import vnc_session
    from nanoagent.agent.effector import vnc_relay

    stopped = []
    monkeypatch.setattr(vnc_session, "start", lambda _d: 5931)
    monkeypatch.setattr(vnc_session, "stop", lambda: stopped.append(True))
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    class Dud:
        async def start(self):
            return False

    monkeypatch.setattr(vnc_relay.VncRelay, "from_env", staticmethod(lambda _p: Dud()))

    screen = LiveScreen(":99")
    assert await screen.start() is False
    assert stopped


@pytest.mark.asyncio
async def test_stop_is_idempotent_and_safe_with_nothing_running():
    screen = LiveScreen(":99")
    await screen.stop()
    await screen.stop()    # must not raise
    assert screen.running is False


@pytest.mark.asyncio
async def test_starting_twice_does_not_start_twice(monkeypatch):
    from nanoagent.agent.effector.desktop import vnc_session
    from nanoagent.agent.effector import vnc_relay

    starts = []
    monkeypatch.setattr(vnc_session, "start", lambda _d: (starts.append(1), 5931)[1])
    monkeypatch.setattr(vnc_session, "stop", lambda: None)
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    class Fine:
        async def start(self):
            return True

        async def stop(self):
            return None

    monkeypatch.setattr(vnc_relay.VncRelay, "from_env", staticmethod(lambda _p: Fine()))

    screen = LiveScreen(":99")
    assert await screen.start() is True
    assert await screen.start() is True
    assert len(starts) == 1
    await screen.stop()
