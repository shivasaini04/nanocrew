"""Phase 5.1 — the user-browser lane has to be watchable too.

`EffectorSession.__aenter__` returns early for the remote lane (correctly: there is no
Playwright and no CDP session there), which meant `_start_screencast()` was never
reached, `last_frame_data_url` stayed None, and `frame_source` fed the dashboard
nothing. The one lane phase 5 is built around was the one lane you could not watch.

The extension already exposes `page.screenshot`, so the fix gives the same attribute a
different producer rather than giving the live view a second path to read from.

Generalised 2026-09-03: the same pump now serves the CONTAINER lane too. The native
stealth engine is Gecko, CDP is Chromium-only, and the live view is built on CDP's
screencast — so the moment camoufox started launching, the container lane went dark for
exactly the same reason the user-browser lane always had. One pump, two lanes, and the
interval is the only difference between them.

Also covers the bridge lock: the pump is a second caller on a timer, and the extension
attaches/detaches the CDP debugger around input commands, so two interleaving commands
would have one detach the debugger the other is using.
"""

from __future__ import annotations

import asyncio
import base64

import pytest

from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage


def _config() -> RemoteConfig:
    return RemoteConfig(
        host="http://orchestrator.test",
        agent_id="agent-1",
        cycle_token="tok",
        controller_id="ctrl-1",
        browser_profile_id="default",
        timeout_s=5,
    )


# ─── one command at a time over the bridge ────────────────────────────────────

@pytest.mark.asyncio
async def test_dispatch_serialises_concurrent_callers():
    """The agent and the frame pump share one browser at the far end. The broker
    correlates replies by id, so the wire is fine; the single browser is not."""
    page = RemotePage(_config())
    overlaps = 0
    in_flight = 0

    async def fake_locked(capability, payload=None):
        nonlocal overlaps, in_flight
        in_flight += 1
        if in_flight > 1:
            overlaps += 1
        await asyncio.sleep(0.01)
        in_flight -= 1
        return {"dataUrl": "data:image/jpeg;base64,QUJD"}

    page._dispatch_locked = fake_locked  # type: ignore[assignment]

    await asyncio.gather(*(page._dispatch("page.screenshot") for _ in range(6)))

    assert overlaps == 0, "commands must not overlap on a single shared browser"


@pytest.mark.asyncio
async def test_screenshot_decodes_the_bridges_data_url():
    page = RemotePage(_config())

    async def fake_locked(capability, payload=None):
        assert capability == "page.screenshot"
        return {"dataUrl": "data:image/jpeg;base64,QUJD"}  # "ABC"

    page._dispatch_locked = fake_locked  # type: ignore[assignment]
    assert await page.screenshot() == b"ABC"


# ─── the pump ─────────────────────────────────────────────────────────────────

class _FakeRemotePage:
    """Just the surface the pump touches."""

    def __init__(self, shots: list):
        self._shots = shots
        self.calls = 0

    async def screenshot(self, **_kw):
        self.calls += 1
        shot = self._shots[min(self.calls - 1, len(self._shots) - 1)]
        if isinstance(shot, Exception):
            raise shot
        return shot


def _session_with(page, monkeypatch):
    """A session object with only what the pump needs, and no real browser anywhere."""
    from nanoagent.agent.effector import browser_session as bs

    session = bs.EffectorSession.__new__(bs.EffectorSession)
    session.page = page
    session.last_frame_data_url = None
    session._frame_pump = None
    return session


@pytest.mark.asyncio
async def test_the_pump_publishes_frames_the_live_view_can_read(monkeypatch):
    """The whole point: on this lane `last_frame_data_url` must fill, because that is
    what `frame_source` reads and what reaches the dashboard."""
    session = _session_with(_FakeRemotePage([b"ABC"]), monkeypatch)
    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.06)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"


@pytest.mark.asyncio
async def test_a_refused_screenshot_keeps_the_last_frame_and_carries_on(monkeypatch):
    """A refusal is the EXPECTED case, not a fault: the extension checks its allowlist
    against the tab as it is now, so the moment the user opens a tab they have not
    allowed, this starts being told no. That is the allowlist working — it must not end
    the run, and it must not blank the view."""
    page = _FakeRemotePage([b"ABC", RuntimeError("blocked: not on the allowlist")])
    session = _session_with(page, monkeypatch)

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.1)
    running = not task.done()
    task.cancel()

    assert running, "a refused frame must not kill the pump"
    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"
    assert page.calls >= 2, "it must keep asking after a refusal"


@pytest.mark.asyncio
async def test_stopping_the_pump_is_idempotent_and_does_not_raise(monkeypatch):
    """It is stopped on the teardown path, which must never be the thing that fails a
    run that already finished its work."""
    session = _session_with(_FakeRemotePage([b"ABC"]), monkeypatch)
    session._frame_pump = asyncio.create_task(session._screenshot_frame_pump(0.01))

    await session._stop_frame_pump()
    assert session._frame_pump is None
    await session._stop_frame_pump()  # again — nothing left to stop


@pytest.mark.asyncio
async def test_the_pump_survives_a_page_that_is_not_there_yet(monkeypatch):
    session = _session_with(None, monkeypatch)
    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    running = not task.done()
    task.cancel()
    assert running
    assert session.last_frame_data_url is None


# ─── the container lane needs it too, since camoufox has no CDP ───────────────

@pytest.mark.asyncio
async def test_the_pump_serves_the_container_lane_at_its_own_interval(monkeypatch):
    """One pump, two lanes. A local screenshot is a plain call; one over the extension
    bridge is a round trip competing with the agent for the single browser it drives —
    so the interval differs and nothing else does."""
    from nanoagent.agent.effector import browser_session as bs

    assert bs._LOCAL_FRAME_INTERVAL_S < bs._REMOTE_FRAME_INTERVAL_S

    page = _FakeRemotePage([b"ABC"])
    session = bs.EffectorSession.__new__(bs.EffectorSession)
    session.page = page
    session.last_frame_data_url = None
    session._frame_pump = None

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"


def test_a_session_starts_with_no_screencast_claimed():
    """`_screencast_on` is what decides whether the pump starts, so it must begin False
    and only become True when CDP actually accepted Page.startScreencast. Defaulting it
    the other way would leave every non-Chromium lane with no live view and no fallback
    — which is the bug this generalisation fixes."""
    from nanoagent.agent.effector import browser_session as bs
    from pathlib import Path

    session = bs.EffectorSession(Path("/tmp"))
    assert session._screencast_on is False
    assert session._frame_pump is None


# ─── the pump must follow a popup, not the tab it replaced ────────────────────
#
# Found live 2026-09-03 alongside the takeover-input version of the same bug: the pump
# always screenshotted `session.page`, captured once at launch, so a popup or new tab
# (an OAuth "Continue with Google" flow is exactly this) never appeared in the live
# view at all — the human driving kept watching the original, now-backgrounded page,
# frozen, forever.

@pytest.mark.asyncio
async def test_the_pump_screenshots_the_resolved_page_when_one_is_set(monkeypatch):
    original = _FakeRemotePage([b"ORIGINAL"])
    popup = _FakeRemotePage([b"POPUP"])
    session = _session_with(original, monkeypatch)
    session.active_page_resolver = lambda: popup

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64," + base64.b64encode(b"POPUP").decode()
    assert original.calls == 0, "the backgrounded launch tab must not be the one screenshotted"


@pytest.mark.asyncio
async def test_a_resolver_returning_none_falls_back_to_the_launch_page(monkeypatch):
    page = _FakeRemotePage([b"ABC"])
    session = _session_with(page, monkeypatch)
    session.active_page_resolver = lambda: None

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"


@pytest.mark.asyncio
async def test_a_broken_resolver_falls_back_rather_than_going_dark(monkeypatch):
    page = _FakeRemotePage([b"ABC"])
    session = _session_with(page, monkeypatch)

    def exploding():
        raise RuntimeError("context has no pages")

    session.active_page_resolver = exploding

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"


@pytest.mark.asyncio
async def test_a_session_with_no_resolver_attribute_at_all_still_pumps(monkeypatch):
    """`EffectorSession.__new__` in the tests above never sets `active_page_resolver` —
    a real session built through `__init__` always will, but the pump must not assume
    that and blow up on the attribute existing at all."""
    session = _session_with(_FakeRemotePage([b"ABC"]), monkeypatch)
    assert not hasattr(session, "active_page_resolver")

    task = asyncio.create_task(session._screenshot_frame_pump(0.01))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.last_frame_data_url == "data:image/jpeg;base64,QUJD"
