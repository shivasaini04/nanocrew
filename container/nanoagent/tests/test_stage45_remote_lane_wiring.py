"""The remote lane is only ever on when someone said so — stage45 doc 05, phase 3 wiring.

The lane moves a real mouse in a browser signed into the user's email, so the interesting
property is not "it works" (the live harness proves that) but "it does not turn itself on."
Two gates gate it, and both have to be open:

    allow_remote      this CALLER may use the lane at all
    NC_BROWSER_...    the ORCHESTRATOR opted THIS RUN in, having checked that a browser is
                      attached to this agent's owner right now

Every test below is about one of those gates, or about what the session looks like once
the lane is on: no Playwright, no context, and no tab manager, because there is no local
browser to have any of them.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage

from test_effector_phase2 import _fake_playwright_chain


REMOTE_ENV = {
    "NC_BROWSER_CONTROLLER_ID": "controller-abc",
    "NANOCREW_CYCLE_TOKEN": "tok-1",
    "AGENT_ID": "agent-1",
    "NANOCREW_HOST": "http://orchestrator:3002",
}


def _opt_the_run_in(monkeypatch, **over):
    # The "stays local" assertions mean "does not use the remote lane", and local used
    # to mean Chromium only because the native engine could not launch (screen
    # constraint pinned; fixed 2026-09-03). Pin the local lane explicitly so these test
    # the gate they are about rather than which engine happens to be working.
    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    env = {**REMOTE_ENV, **over}
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)


# ─── Gate 1: the run has to be opted in ─────────────────────────────────────


def test_remote_config_needs_every_piece(monkeypatch):
    """Any one missing means no lane. A half-configured lane is the shape that would
    dispatch to the wrong browser or with no way to prove who is asking."""
    _opt_the_run_in(monkeypatch)
    assert RemoteConfig.from_env() is not None

    for missing in REMOTE_ENV:
        _opt_the_run_in(monkeypatch, **{missing: None})
        assert RemoteConfig.from_env() is None, f"{missing} alone should disable the lane"


def test_an_unconfigured_run_is_not_an_error(monkeypatch):
    """"No remote browser" is the ordinary case — every cycle that never opted in — so it
    returns None rather than raising into a caller that would have to catch it."""
    for key in REMOTE_ENV:
        monkeypatch.delenv(key, raising=False)
    assert RemoteConfig.from_env() is None


# ─── Gate 2: the caller has to be allowed ───────────────────────────────────


@pytest.mark.asyncio
async def test_a_caller_that_says_no_stays_local_even_on_an_opted_in_run(tmp_path, monkeypatch):
    """A keepalive or a swarm branch must not hijack the user's browser just because the
    run was opted in.

    The constraint is unchanged; what changed is how it is expressed. It used to ride on
    `allow_remote` defaulting to False, which meant a session was in the container unless
    a caller asked otherwise — and exactly one caller ever asked. So "which browser am I
    driving" depended on which TOOL the model happened to pick: the same agent, the same
    run, the same configuration, and `browser` went to the container while `effector` went
    to the user's machine.

    Now the orchestrator's decision applies by default and the two genuine exceptions —
    session_keepalive.py and effector_swarm.py — state their reason at the call site. This
    test pins the exception, and the one below it pins the new default.
    """
    from nanoagent.agent.effector.browser_session import EffectorSession

    _opt_the_run_in(monkeypatch)
    fake_async_playwright, _browser, _context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path, allow_remote=False) as session:
            assert session.page is fake_page          # the container's own Chromium
            assert session.context is not None


@pytest.mark.asyncio
async def test_the_default_follows_the_orchestrator_not_the_caller(tmp_path, monkeypatch):
    """The new contract: an opted-in run reaches the user's browser without the caller
    having to ask.

    This is the fix for the failure mode above — a tool could previously send a run to the
    container merely by not knowing the lane existed, and nothing anywhere reported it.
    Same shape as reference_gate_is_per_tool_not_system: authorisation attached to a tool
    is authorisation that can be routed around.
    """
    from nanoagent.agent.effector.browser_session import EffectorSession

    _opt_the_run_in(monkeypatch)
    fake_async_playwright, _browser, _context, _fake_page = _fake_playwright_chain()

    # Same patches the both-gates-open test uses: refresh_info and close talk to a broker
    # that does not exist here, and the question is which LANE was chosen, not whether a
    # socket opened.
    with patch("playwright.async_api.async_playwright", fake_async_playwright),             patch.object(RemotePage, "refresh_info", AsyncMock()),             patch.object(RemotePage, "close", AsyncMock()):
        async with EffectorSession(tmp_path) as session:
            # No allow_remote passed anywhere — the run was opted in, so this is remote.
            assert isinstance(session.page, RemotePage)
            # The remote lane has no Playwright context, and nothing may pretend it does.
            assert session.context is None


@pytest.mark.asyncio
async def test_an_allowed_caller_stays_local_when_the_run_was_never_opted_in(tmp_path, monkeypatch):
    """The other half of the same rule: being allowed is not being on."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    for key in REMOTE_ENV:
        monkeypatch.delenv(key, raising=False)
    # Same reason as _opt_the_run_in: "local" is the assertion, not "Chromium", and the
    # two stopped being synonyms once the native engine could launch.
    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    fake_async_playwright, _browser, _context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path, allow_remote=True) as session:
            assert session.page is fake_page


# ─── Both gates open ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_both_gates_open_gives_a_remote_page_and_launches_no_browser(tmp_path, monkeypatch):
    from nanoagent.agent.effector.browser_session import EffectorSession

    _opt_the_run_in(monkeypatch)
    fake_async_playwright, fake_browser, _context, _page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright), \
            patch.object(RemotePage, "refresh_info", AsyncMock()), \
            patch.object(RemotePage, "close", AsyncMock()):
        async with EffectorSession(tmp_path, allow_remote=True) as session:
            assert isinstance(session.page, RemotePage)
            # No context, and nothing pretending to be one: every caller branches on it
            # (the TabManager in tools/effector.py is the one that matters).
            assert session.context is None

    # The whole point: the container never started a browser of its own.
    fake_browser.new_context.assert_not_awaited()
    fake_async_playwright.assert_not_called()


@pytest.mark.asyncio
async def test_leaving_a_remote_session_does_not_close_the_user_browser(tmp_path, monkeypatch):
    """Only the HTTP client goes. The browser belongs to the person sitting at it."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    _opt_the_run_in(monkeypatch)
    closed = AsyncMock()

    with patch.object(RemotePage, "refresh_info", AsyncMock()), \
            patch.object(RemotePage, "close", closed):
        async with EffectorSession(tmp_path, allow_remote=True):
            pass

    closed.assert_awaited_once()


# ─── Settling, where there is no evaluate to settle with ────────────────────


@pytest.mark.asyncio
async def test_the_dom_settler_does_not_call_evaluate_on_the_remote_lane():
    """RemotePage.evaluate raises by design (MV3 forbids string-to-code). The settler used
    to hit that every single turn and swallow it; now it takes a short wait instead."""
    from nanoagent.agent.effector.dom_settler import wait_for_dom_settled

    page = MagicMock()
    page.nc_remote_snapshot = AsyncMock()
    page.evaluate = AsyncMock(side_effect=AssertionError("evaluate must not be called"))

    assert await wait_for_dom_settled(page, quiet_period_ms=1) is False
    page.evaluate.assert_not_awaited()


# ─── extract, which is the one action that had no coordinate path ───────────
#
# Found live 2026-08-31 on the first real task run through this lane: extract always
# returned {} on the remote lane — the schema branch called page.locator (refused here)
# inside a bare except, and the target branch did nothing at all once the target resolved
# to a coordinate, which on this lane it always does. The model asked for the same text
# four turns running and then gave up. These pin the fix.


class FakeRemotePage:
    """Page-shaped, remote-shaped: no locator, and text only through a named probe."""

    def __init__(self, texts: dict | None = None, page_text: str = "the whole page"):
        self.url = "http://localhost:8917/"
        self.viewport_size = {"width": 1280, "height": 720}
        self._texts = texts or {}
        self._page_text = page_text
        self.points_asked: list = []
        self.selectors_asked: list = []

    async def nc_extract_selectors(self, selectors):
        self.selectors_asked.append(list(selectors))
        return {s: self._texts[s] for s in selectors if s in self._texts}

    async def nc_text(self, point=None):
        self.points_asked.append(point)
        return self._page_text

    async def nc_remote_snapshot(self):  # marks it as the remote lane for other callers
        raise AssertionError("not needed by these tests")

    def locator(self, *_a, **_kw):
        raise AssertionError("the remote lane has no Locator — extract must not reach for one")


async def _extract(page, **step_kw):
    from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
    from nanoagent.agent.effector.types import Step

    result = await execute_step(
        Step(step=1, action="extract", **step_kw), page,
        ExecutorOptions(require_approval=False, use_human_cadence=False),
    )
    return result


@pytest.mark.asyncio
async def test_extract_with_a_schema_reads_through_the_probe():
    page = FakeRemotePage({"h1": "Frame fixture", ".status": "paused"})

    result = await _extract(page, extract_schema={"title": "h1", "status": ".status"})

    assert result.status == "success"
    assert result.data == {"title": "Frame fixture", "status": "paused"}
    assert page.selectors_asked == [["h1", ".status"]]


@pytest.mark.asyncio
async def test_extract_with_a_css_target_reads_that_element():
    page = FakeRemotePage({"body": "Ledger-886E30 paused"})

    result = await _extract(page, target="body")

    assert result.data == {"text": "Ledger-886E30 paused"}


@pytest.mark.asyncio
async def test_a_selector_that_matches_nothing_falls_back_to_the_page_text():
    """An empty answer is what sends the model round the loop again — the live failure
    was four identical extract turns in a row. Something real beats {}."""
    page = FakeRemotePage({}, page_text="Ledger-886E30 is paused")

    result = await _extract(page, target="#nope")

    assert result.data == {"text": "Ledger-886E30 is paused"}


@pytest.mark.asyncio
async def test_extract_with_no_target_returns_the_page_text():
    page = FakeRemotePage({}, page_text="everything on the page")

    result = await _extract(page)

    assert result.data == {"text": "everything on the page"}
    assert page.points_asked == [None]
