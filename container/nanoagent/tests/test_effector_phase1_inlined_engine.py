"""Phase 1: Verification tests for inlined Camoufox native engine integration.

Tests data file integrity, inlined module imports, profile translation, and
browser session fallback orchestration.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.browser_session import EffectorSession
from nanoagent.agent.effector.engine.fingerprints import generate_fingerprint
from nanoagent.agent.effector.engine.pkgman import LOCAL_DATA
from nanoagent.agent.effector.stealth.camoufox_driver import (
    get_camoufox_engine_options,
    is_camoufox_available,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
from nanoagent.agent.effector.stealth.geo_profile import GeoProfile


def test_inlined_engine_data_files_exist():
    """Verify all statistical fingerprint datasets and WebGL databases are present in engine/."""
    assert (LOCAL_DATA / "fingerprint-presets-v150.json").exists()
    assert (LOCAL_DATA / "fingerprint-presets.json").exists()
    assert (LOCAL_DATA / "fonts.json").exists()
    assert (LOCAL_DATA / "voices.json").exists()
    assert (LOCAL_DATA / "webgl" / "webgl_data.db").exists()


def test_inlined_engine_driver_bridge_builds_config():
    """Verify profile and geo translation into native Camoufox configuration."""
    profile = DEVICE_PROFILES[0]
    geo = GeoProfile(
        timezone_id="America/Chicago",
        locale="en-US",
        accept_language="en-US,en;q=0.9",
        source="test",
    )

    cfg = get_camoufox_engine_options(
        profile=profile,
        geo=geo,
        headless=True,
        viewport={"width": 1440, "height": 900},
        proxy={"server": "http://127.0.0.1:8080"},
    )

    assert cfg["headless"] is True
    # A (w, h) tuple crashed the real launch with "'tuple' object has no attribute
    # 'is_set'" — the engine wants a browserforge Screen constraint. Found live
    # 2026-08-31; this assertion had encoded the bug.
    # A RANGE, not an exact pin: min==max was rejected by the engine's own header
    # generator ("No headers based on this input can be generated"), measured live
    # 2026-08-31.
    #
    # This used to assert max == the viewport, which contradicted the sentence right
    # above it ("the upper bound still comes from the profile") and encoded the bug
    # fixed 2026-09-03: reading the viewport as the screen collapsed the range to a pin
    # on the default 1280x720, so the engine could never launch. A viewport is a WINDOW
    # and the screen it sits on is at least as large, so the window is the floor and the
    # profile's screen the ceiling.
    screen = cfg["screen"]
    assert screen.min_width <= 1440 <= screen.max_width, "the window must fit on the screen"
    assert screen.min_height <= 900 <= screen.max_height
    # And strictly a range, which is the property the engine actually requires.
    assert screen.min_width < screen.max_width
    assert screen.min_height < screen.max_height
    assert cfg["locale"] == "en-US"
    # timezone_id and languages are Playwright CONTEXT kwargs, not engine launch
    # options — passing them raised TypeError and the session silently fell back to
    # Chromium. The engine derives both from the locale, which is more coherent anyway:
    # a locale and timezone set independently can disagree.
    assert "timezone_id" not in cfg and "languages" not in cfg
    assert cfg["proxy"] == {"server": "http://127.0.0.1:8080"}
    # The engine takes `block_webrtc: bool`, not a Chromium-shaped policy dict. The
    # old shape raised TypeError at launch, which the wrapper reported as "native
    # engine launch failed" — so the engine silently fell back to Chromium on every
    # single run while its binary sat there working.
    assert cfg["block_webrtc"] is True
    assert "webrtc" not in cfg


def test_is_camoufox_available_returns_boolean():
    """Verify that is_camoufox_available executes cleanly without uncaught exceptions."""
    result = is_camoufox_available()
    assert isinstance(result, bool)


def test_fingerprint_generation_from_inlined_engine():
    """Verify BrowserForge statistical distribution generator functions from inlined engine."""
    fp = generate_fingerprint(os="linux")
    assert fp is not None
    assert hasattr(fp, "screen")
    assert hasattr(fp, "navigator")
    assert hasattr(fp, "headers")


@pytest.mark.asyncio
async def test_effector_session_dual_engine_fallback(tmp_path, monkeypatch):
    """Verify that EffectorSession gracefully initializes Chromium fallback when
    EFFECTOR_ENGINE=chromium or Camoufox is not present."""
    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")

    # Mock Playwright to verify launch path without needing a real browser process
    with patch("playwright.async_api.async_playwright") as mock_pw_factory:
        mock_pw = MagicMock()
        mock_pw_factory.return_value.start = AsyncMock(return_value=mock_pw)

        mock_browser = MagicMock()
        mock_browser.version = "128.0.0.0"
        mock_browser.close = AsyncMock()
        mock_pw.chromium.launch = AsyncMock(return_value=mock_browser)
        mock_pw.stop = AsyncMock()

        mock_context = MagicMock()
        mock_context.add_init_script = AsyncMock()
        mock_context.close = AsyncMock()
        mock_browser.new_context = AsyncMock(return_value=mock_context)

        mock_page = MagicMock()
        mock_page.route = AsyncMock()
        mock_context.new_page = AsyncMock(return_value=mock_page)
        mock_context.new_cdp_session = AsyncMock(side_effect=Exception("No CDP in test"))

        async with EffectorSession(workspace=tmp_path, headless=True) as session:
            assert session._native_engine is False
            assert session.page is not None
            mock_pw.chromium.launch.assert_called_once()
