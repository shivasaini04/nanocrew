"""Stealth hardening — the review pass of 2026-08-30.

The findings these cover are the ones no amount of fingerprint JS could fix, because
they lived in the layers around it: the browser context's own timezone/locale, the
Client Hints request headers, which pages got the network shield, and whether the
"human cadence" work ran on the path clicks actually take.

Companion to test_effector_phase2.py, which covers the injected script itself.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.executor import Coordinate, ExecutorOptions, _click_locator
from nanoagent.agent.effector.stealth.geo_profile import (
    DEFAULT_TIMEZONE,
    GeoProfile,
    resolve_geo_profile,
    reset_geo_cache,
)

from test_effector_phase2 import _fake_playwright_chain


@pytest.fixture(autouse=True)
def _clean_geo_cache(monkeypatch):
    reset_geo_cache()
    monkeypatch.delenv("EFFECTOR_TIMEZONE", raising=False)
    monkeypatch.delenv("EFFECTOR_LOCALE", raising=False)
    # These tests are about the CHROMIUM stealth surface: they patch
    # playwright.async_api and assert a Chrome user agent. They used to reach it by
    # accident — the native engine could not launch (its screen constraint was pinned,
    # fixed 2026-09-03) so every session fell back to Chromium. Once it launched, the
    # faked Playwright chain was simply never used and the assertions had nothing to
    # read. Pin the lane rather than depend on the other one being broken.
    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    yield
    reset_geo_cache()


# ─── Geo profile ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_proxy_still_gets_an_explicit_non_utc_timezone():
    """A context with no timezone_id reports the container's clock, which is UTC —
    and a consumer browser reporting UTC is itself the tell. The default is a real
    zone, not "unset"."""
    geo = await resolve_geo_profile(None)
    assert geo.timezone_id == DEFAULT_TIMEZONE
    assert geo.timezone_id != "UTC"
    assert geo.source == "default"


@pytest.mark.asyncio
async def test_env_override_wins_and_skips_the_probe():
    """An operator who knows where their pool exits shouldn't pay for a lookup."""
    with patch.dict("os.environ", {"EFFECTOR_TIMEZONE": "Europe/Berlin", "EFFECTOR_LOCALE": "de-DE"}):
        with patch("httpx.AsyncClient") as fake_client:
            geo = await resolve_geo_profile("http://user:pass@proxy.example:8080")
    assert geo.timezone_id == "Europe/Berlin"
    assert geo.locale == "de-DE"
    assert geo.source == "env"
    fake_client.assert_not_called()


@pytest.mark.asyncio
async def test_a_proxied_session_asks_the_exit_node_where_it_is():
    """The whole point: the probe must run THROUGH the proxy, describing the exit
    node rather than this container."""
    response = MagicMock()
    response.json = MagicMock(return_value={"status": "success", "timezone": "America/Chicago", "countryCode": "US"})

    client = MagicMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch("httpx.AsyncClient", return_value=client) as ctor:
        geo = await resolve_geo_profile("http://user:pass@proxy.example:8080")

    assert ctor.call_args.kwargs["proxy"] == "http://user:pass@proxy.example:8080"
    assert geo.timezone_id == "America/Chicago"
    assert geo.locale == "en-US"
    assert geo.source == "proxy-lookup"


@pytest.mark.asyncio
async def test_a_failed_probe_degrades_instead_of_breaking_the_session():
    client = MagicMock()
    client.get = AsyncMock(side_effect=RuntimeError("proxy unreachable"))
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch("httpx.AsyncClient", return_value=client):
        geo = await resolve_geo_profile("http://proxy.example:8080")

    assert geo.timezone_id == DEFAULT_TIMEZONE
    assert geo.source == "default"


def test_navigator_languages_are_derived_from_the_accept_language_header():
    """Anything that lets the JS value and the HTTP header drift apart reintroduces
    the mismatch this is meant to prevent."""
    geo = GeoProfile(
        timezone_id="Europe/London", locale="en-GB",
        accept_language="en-GB,en;q=0.9", source="test",
    )
    assert geo.languages == ("en-GB", "en")


# ─── Session wiring ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_session_sets_timezone_locale_and_accept_language(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path):
            pass

    _, kwargs = fake_browser.new_context.call_args
    assert kwargs["timezone_id"] == DEFAULT_TIMEZONE
    assert kwargs["locale"] == "en-US"
    assert kwargs["extra_http_headers"]["Accept-Language"].startswith("en-US")


@pytest.mark.asyncio
async def test_session_overrides_client_hints_over_cdp(tmp_path):
    """new_context(user_agent=...) rewrites the UA string only — Chromium keeps
    sending its own sec-ch-ua headers, so the header and navigator.userAgentData
    disagree. Emulation.setUserAgentOverride is the only thing that moves both."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    cdp = await fake_context.new_cdp_session()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path):
            pass

    ua_calls = [c for c in cdp.send.call_args_list if c.args and c.args[0] == "Emulation.setUserAgentOverride"]
    assert ua_calls, "client hints were never overridden — headers will contradict the JS fingerprint"
    payload = ua_calls[0].args[1]
    metadata = payload["userAgentMetadata"]
    # The override must carry the SAME UA the context was built with, or the two
    # halves of the identity disagree again in a new way.
    _, ctx_kwargs = fake_browser.new_context.call_args
    assert payload["userAgent"] == ctx_kwargs["user_agent"]
    assert payload["acceptLanguage"] == ctx_kwargs["extra_http_headers"]["Accept-Language"]
    assert metadata["platform"] == "Linux"
    assert metadata["architecture"] == "x86"
    # The brand version must match the UA the same call advertises.
    major = payload["userAgent"].split("Chrome/")[1].split(".")[0]
    assert any(b["version"] == major for b in metadata["brands"])


@pytest.mark.asyncio
async def test_session_hardens_newly_opened_tabs_too(tmp_path):
    """The network shield used to be bound to the first page only, so a popup or a
    target=_blank tab got none of it."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            handlers = [c.args for c in fake_context.on.call_args_list if c.args and c.args[0] == "page"]
            assert handlers, "no handler registered for newly opened pages"

            popup = MagicMock()
            popup.route = AsyncMock()
            popup.on = MagicMock()
            await session._on_new_page(popup)

    popup.route.assert_awaited()  # the shield reached the popup


@pytest.mark.asyncio
async def test_session_restates_the_profile_for_the_live_chromium(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()
    fake_browser.version = "141.0.7390.54"

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session._profile.chrome_version == "141.0.7390.54"

    _, kwargs = fake_browser.new_context.call_args
    assert "Chrome/141.0.0.0" in kwargs["user_agent"]


# ─── Human cadence on the locator path ──────────────────────────────────────────

def _fake_locator(box):
    locator = MagicMock()
    locator.scroll_into_view_if_needed = AsyncMock()
    locator.bounding_box = AsyncMock(return_value=box)
    locator.click = AsyncMock()
    locator.dblclick = AsyncMock()
    return locator


@pytest.mark.asyncio
async def test_locator_click_routes_through_organic_movement_when_cadence_is_on():
    """Review finding: _move_and_click only ran for raw-Coordinate targets. Selector
    targets — the common case — went straight to locator.click(), so the Bezier
    trajectory work almost never executed on a real run."""
    page = MagicMock()
    locator = _fake_locator({"x": 100, "y": 200, "width": 40, "height": 20})

    with patch("nanoagent.agent.effector.executor._move_and_click", new=AsyncMock()) as move:
        await _click_locator(page, ExecutorOptions(use_human_cadence=True), locator)

    move.assert_awaited_once()
    target = move.await_args.args[2]
    assert target == Coordinate(x=120, y=210)  # the element's centre
    locator.click.assert_not_awaited()


@pytest.mark.asyncio
async def test_locator_click_falls_back_when_there_is_no_bounding_box():
    """Detached, zero-size or cross-origin-framed elements have no box — the click
    must still happen rather than silently doing nothing."""
    page = MagicMock()
    locator = _fake_locator(None)

    with patch("nanoagent.agent.effector.executor._move_and_click", new=AsyncMock()) as move:
        await _click_locator(page, ExecutorOptions(use_human_cadence=True), locator)

    move.assert_not_awaited()
    locator.click.assert_awaited_once()


@pytest.mark.asyncio
async def test_locator_click_stays_instant_when_cadence_is_off():
    page = MagicMock()
    locator = _fake_locator({"x": 0, "y": 0, "width": 10, "height": 10})

    with patch("nanoagent.agent.effector.executor._move_and_click", new=AsyncMock()) as move:
        await _click_locator(page, ExecutorOptions(use_human_cadence=False), locator)

    move.assert_not_awaited()
    locator.click.assert_awaited_once()
    locator.scroll_into_view_if_needed.assert_not_awaited()
