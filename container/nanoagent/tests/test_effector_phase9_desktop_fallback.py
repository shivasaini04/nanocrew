"""Tests for the last gap from the evaluation, 2026-08-23: desktop automation
(desktop/desktop_driver.py, desktop/desktop_vision.py) wired into the live
resolution chain as a genuine last resort, not just built-and-tested-in-isolation.

Two pieces, proven separately:
1. EffectorSession now defaults to non-headless, rendering onto a lazily-started
   Xvfb virtual display — with a graceful fallback to headless when Xvfb isn't
   installed (a dev machine, an older image).
2. executor.py's plain `click` action falls through to an OS-level click
   (desktop_vision.os_visual_click) when every DOM-based resolution layer fails
   AND a vision-capable provider is configured — scoped to click only, since
   os_visual_click has no typing/select equivalent yet.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.types import Step

from test_effector_phase0 import FakePage
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


# ─── EffectorSession: non-headless by default, with a graceful fallback ────────

@pytest.mark.asyncio
async def test_effector_session_launches_non_headless_when_a_virtual_display_is_available(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright), \
         patch("nanoagent.agent.effector.desktop.xvfb_session.ensure_virtual_display", return_value=":99"):
        async with EffectorSession(tmp_path) as session:
            pass

    chromium = fake_async_playwright.return_value.start.return_value.chromium
    _, launch_kwargs = chromium.launch.call_args
    assert launch_kwargs["headless"] is False


@pytest.mark.asyncio
async def test_effector_session_falls_back_to_headless_when_no_virtual_display(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright), \
         patch("nanoagent.agent.effector.desktop.xvfb_session.ensure_virtual_display", return_value=None):
        async with EffectorSession(tmp_path) as session:
            pass

    chromium = fake_async_playwright.return_value.start.return_value.chromium
    _, launch_kwargs = chromium.launch.call_args
    assert launch_kwargs["headless"] is True


@pytest.mark.asyncio
async def test_ensure_virtual_display_is_resolved_before_playwright_is_started(tmp_path):
    """Real production bug, 2026-08-24, found only after two other genuine fixes
    to ensure_virtual_display() itself didn't stop the failure recurring:
    async_playwright().start() forks Playwright's own Node.js driver subprocess,
    whose environment is a snapshot taken at fork time — not a live view into
    this Python process's os.environ. Calling it BEFORE ensure_virtual_display()
    sets os.environ["DISPLAY"] means the driver process that actually launches
    Chromium never sees DISPLAY at all, no matter how correctly Xvfb started.
    This is an ordering bug, not a timing one — assert the actual call order,
    not just the eventual headless/headed outcome (which every prior test here
    already covered and which stayed green through the whole bug's lifetime)."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    call_order: list[str] = []

    real_start = fake_async_playwright.return_value.start

    async def tracked_start(*a, **kw):
        call_order.append("playwright_start")
        return await real_start(*a, **kw)

    fake_async_playwright.return_value.start = AsyncMock(side_effect=tracked_start)

    def tracked_ensure(*a, **kw):
        call_order.append("ensure_virtual_display")
        return ":99"

    with patch("playwright.async_api.async_playwright", fake_async_playwright), \
         patch("nanoagent.agent.effector.desktop.xvfb_session.ensure_virtual_display", side_effect=tracked_ensure):
        async with EffectorSession(tmp_path) as session:
            pass

    assert call_order == ["ensure_virtual_display", "playwright_start"], (
        f"ensure_virtual_display() must resolve DISPLAY before the Playwright "
        f"driver subprocess is forked, not after — got order {call_order}"
    )


@pytest.mark.asyncio
async def test_effector_session_respects_an_explicit_headless_true(tmp_path):
    """A caller that explicitly wants headless (e.g. a resource-constrained batch
    job) must not be overridden into starting Xvfb it didn't ask for."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright), \
         patch("nanoagent.agent.effector.desktop.xvfb_session.ensure_virtual_display") as mock_ensure:
        async with EffectorSession(tmp_path, headless=True) as session:
            pass

    mock_ensure.assert_not_called()
    chromium = fake_async_playwright.return_value.start.return_value.chromium
    _, launch_kwargs = chromium.launch.call_args
    assert launch_kwargs["headless"] is True


# ─── executor.py: OS-level click as the click action's genuine last resort ─────

@pytest.mark.asyncio
async def test_click_falls_through_to_desktop_when_every_dom_layer_fails(tmp_path):
    page = FakePage()  # "#does-not-exist" resolves on no layer — see test_effector_phase0.py
    step = Step(step=1, action="click", target="#does-not-exist", description="the hidden canvas button")

    class FakeVisionProvider:
        async def chat(self, *a, **kw):
            raise AssertionError("resolver's own vision/OCR layers should still run and fail first")

    opts = ExecutorOptions(provider=FakeVisionProvider(), vision_model="fake/vision", use_human_cadence=False)

    with patch("nanoagent.agent.effector.desktop.desktop_vision.os_visual_click", AsyncMock(return_value=True)) as mock_click:
        result = await execute_step(step, page, opts)

    assert result.status == "success", result
    assert result.data["desktop_fallback"] is True
    mock_click.assert_awaited_once()
    call_args = mock_click.call_args
    assert call_args.args[0] == "the hidden canvas button"  # description preferred over raw selector
    assert call_args.args[1] is opts.provider
    assert call_args.args[2] == "fake/vision"


@pytest.mark.asyncio
async def test_click_fails_honestly_when_desktop_fallback_also_fails(tmp_path):
    """Desktop fallback is a genuine last resort, not a guaranteed success — when
    the OS-level click ALSO can't find anything, the step must still fail with the
    original resolution error, not swallow it into a false success."""
    page = FakePage()
    step = Step(step=1, action="click", target="#does-not-exist")
    opts = ExecutorOptions(provider=object(), vision_model="fake/vision", use_human_cadence=False)

    with patch("nanoagent.agent.effector.desktop.desktop_vision.os_visual_click", AsyncMock(return_value=False)):
        result = await execute_step(step, page, opts)

    assert result.status == "failed"
    assert "does-not-exist" in result.error or "resolve" in result.error.lower()


@pytest.mark.asyncio
async def test_click_never_attempts_desktop_fallback_without_a_vision_provider(tmp_path):
    """The common case (no vision provider configured at all) must fail exactly
    as it did before this pass — no wasted attempt, no new failure mode."""
    page = FakePage()
    step = Step(step=1, action="click", target="#does-not-exist")
    opts = ExecutorOptions(use_human_cadence=False)  # provider=None, vision_model=None (defaults)

    with patch("nanoagent.agent.effector.desktop.desktop_vision.os_visual_click", AsyncMock(return_value=True)) as mock_click:
        result = await execute_step(step, page, opts)

    assert result.status == "failed"
    mock_click.assert_not_awaited()


@pytest.mark.asyncio
async def test_desktop_fallback_is_never_reached_for_a_click_that_resolves_normally(tmp_path):
    """Cheapest possible regression guard: the ordinary path (target actually
    resolves via CSS) must not even consider the desktop layer."""
    page = FakePage()
    step = Step(step=1, action="click", target="#submit")  # a real element in FakePage
    opts = ExecutorOptions(provider=object(), vision_model="fake/vision", use_human_cadence=False)

    with patch("nanoagent.agent.effector.desktop.desktop_vision.os_visual_click", AsyncMock(return_value=True)) as mock_click:
        result = await execute_step(step, page, opts)

    assert result.status == "success"
    assert result.data == {"clicked": True}  # no desktop_fallback key at all
    mock_click.assert_not_awaited()
