"""stage44 doc 01, step 1 of 5: CDP live-frame screencast start/stop in
EffectorSession — docs/research/stage44/01-live-browser-view-architecture.md.

No consumer wired yet (that's steps 2-4: react_loop.py's throttle+POST, the
new /frame endpoint + socket emit, and the dashboard <img>). This step only
has to prove: the screencast starts with the documented params, a delivered
frame updates `last_frame_data_url` and gets ACKed, it stops cleanly on
session exit, and none of this ever breaks the agent's actual task if the
CDP session can't be created (e.g. running under a Chromium build without
screencast support, or the fake test double used elsewhere in this suite
that has no CDP session wired at all).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from test_effector_phase2 import _fake_playwright_chain


@pytest.fixture(autouse=True)
def _pin_the_chromium_lane(monkeypatch):
    """These tests are about the CHROMIUM lane, and used to reach it by accident.

    They patch `playwright.async_api` and assert on the context, the proxy, the headless
    fallback or the CDP screencast — all Chromium-side. Until 2026-09-03 the native
    engine could never launch (its screen constraint was pinned rather than banded), so
    every session fell back to Chromium and into the fake. Once the engine worked, the
    fake was simply never used.

    CDP is the sharpest case: the vendored engine is Gecko and has no CDP session at
    all, so the screencast tests below have nothing to assert against on that lane.

    Pin the lane rather than depend on the other one being broken.
    """
    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")


@pytest.mark.asyncio
async def test_screencast_starts_with_the_documented_params(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_cdp_session = fake_context.new_cdp_session.return_value

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session._cdp_session is fake_cdp_session

    fake_context.new_cdp_session.assert_awaited_once_with(fake_page)
    fake_cdp_session.on.assert_called_once()
    event_name, handler = fake_cdp_session.on.call_args[0]
    assert event_name == "Page.screencastFrame"

    start_call = next(
        c for c in fake_cdp_session.send.call_args_list if c.args[0] == "Page.startScreencast"
    )
    params = start_call.args[1]
    assert params["format"] == "jpeg"
    assert params["quality"] == 60
    assert params["maxWidth"] == 800
    assert params["maxHeight"] == 600


@pytest.mark.asyncio
async def test_a_delivered_frame_updates_last_frame_and_is_acked(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_cdp_session = fake_context.new_cdp_session.return_value

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            handler = fake_cdp_session.on.call_args[0][1]
            handler({"data": "ZmFrZWpwZWc=", "sessionId": 42})
            # the ACK is scheduled via asyncio.ensure_future, not awaited inline
            await asyncio.sleep(0)

            assert session.last_frame_data_url == "data:image/jpeg;base64,ZmFrZWpwZWc="

    ack_call = next(
        c for c in fake_cdp_session.send.call_args_list if c.args[0] == "Page.screencastFrameAck"
    )
    assert ack_call.args[1] == {"sessionId": 42}


@pytest.mark.asyncio
async def test_a_frame_with_no_data_clears_last_frame_without_acking(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_cdp_session = fake_context.new_cdp_session.return_value

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            session.last_frame_data_url = "stale"
            handler = fake_cdp_session.on.call_args[0][1]
            handler({"data": None, "sessionId": None})
            await asyncio.sleep(0)

            assert session.last_frame_data_url is None

    ack_calls = [c for c in fake_cdp_session.send.call_args_list if c.args[0] == "Page.screencastFrameAck"]
    assert ack_calls == []


@pytest.mark.asyncio
async def test_screencast_stops_on_session_exit(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_cdp_session = fake_context.new_cdp_session.return_value

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path):
            pass

    stop_calls = [c for c in fake_cdp_session.send.call_args_list if c.args[0] == "Page.stopScreencast"]
    assert len(stop_calls) == 1


@pytest.mark.asyncio
async def test_screencast_stop_is_a_noop_when_it_never_started(tmp_path):
    """A session where _start_screencast failed (cdp_session stays None) must not
    error on exit trying to stop something that never started."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_context.new_cdp_session = AsyncMock(side_effect=RuntimeError("no CDP in this build"))

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session._cdp_session is None
            assert session.last_frame_data_url is None
    # no exception raised — that's the assertion


@pytest.mark.asyncio
async def test_screencast_start_failure_never_breaks_the_session(tmp_path):
    """Same 'degrade, don't fail the agent's real work' contract as dialog
    handling / stealth / network shield elsewhere in this file — a screencast
    that can't start must still leave page/context usable."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_context.new_cdp_session = AsyncMock(side_effect=RuntimeError("boom"))

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session.page is fake_page
            assert session.context is fake_context
