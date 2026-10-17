"""Phase 2 (stealth) reachability tests for Effector — stage43 doc 03.

Covers: the fixed `as any` bug never regresses, human-cadence typing/movement is
actually invoked (not just available), network shield actually blocks a tracking
request, proxy config reads the right env vars, and — the one genuinely new piece
this phase needed real Playwright bindings for — EffectorSession actually wires
stealth/network-shield/proxy into a session, verified against a fully faked
Playwright object chain (no real browser launched).
"""

from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.stealth.stealth import (
    ULTRA_STEALTH_INIT_SCRIPT,
    build_stealth_init_script,
    generate_bezier_trajectory,
    human_mouse_move,
    human_scroll,
    human_type,
    is_challenge_page,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES, pick_device_profile
from nanoagent.agent.effector.stealth.network_shield import (
    BLOCKED_MEDIA_EXTENSIONS,
    TRACKING_DOMAINS,
    apply_network_shield,
)
from nanoagent.agent.effector.types import Point, Step
from nanoagent.agent.proxy_config import get_proxy_url, get_residential_proxy_config, should_route_through_proxy

from test_effector_phase0 import FakeKeyboard, FakeMouse


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


# ─── The bug fix, guarded against regressing ────────────────────────────────────

def test_the_init_script_contains_no_typescript_only_syntax():
    """The original TS source embeds `as any` casts inside the browser-injected
    string itself — invalid JS, meaning the whole init script fails to parse in a
    real browser. Fixed during the port; this guards it from coming back if the
    script is ever edited again."""
    assert "as any" not in ULTRA_STEALTH_INIT_SCRIPT
    assert ": any" not in ULTRA_STEALTH_INIT_SCRIPT


def test_the_init_script_still_covers_all_evasion_layers():
    """Covers all evasion layers including prototype-safe Function.toString,
    genuine PluginArray, WebGL extensions, SpeechSynthesis, and screen geometry."""
    for marker in [
        "'webdriver'", "hardwareConcurrency", "userAgentData",
        "'plugins'", "getParameter", "toDataURL",
        "getFloatFrequencyData", "enumerateDevices", "navigator.connection",
        "navigator.permissions", "speechSynthesis", "PluginArray", "availWidth",
    ]:
        assert marker in ULTRA_STEALTH_INIT_SCRIPT, f"missing evasion layer marker: {marker}"


def test_navigator_overrides_land_on_the_prototype_not_the_instance():
    """Review finding, 2026-08-30. Every override used to be defined directly on
    `navigator`, leaving eight own properties on an object that has none in a real
    browser — `Object.getOwnPropertyNames(navigator)` is `[]` in real Chrome. This
    is the check CreepJY-style detectors make, so the fix has to stay fixed."""
    assert "Object.getPrototypeOf(navigator)" in ULTRA_STEALTH_INIT_SCRIPT
    for instance_define in [
        "Object.defineProperty(navigator, 'webdriver'",
        "Object.defineProperty(navigator, 'plugins'",
        "Object.defineProperty(navigator, 'platform'",
        "Object.defineProperty(navigator, 'hardwareConcurrency'",
        "Object.defineProperty(navigator, 'languages'",
    ]:
        assert instance_define not in ULTRA_STEALTH_INIT_SCRIPT, (
            f"{instance_define} defines on the navigator INSTANCE — must go on Navigator.prototype"
        )


def test_webdriver_reports_false_rather_than_undefined():
    """A normal Chrome reports `false`. `undefined` says "someone deleted this"
    just as loudly as `true` says "automated"."""
    assert "defineOn(navProto, 'webdriver', () => false)" in ULTRA_STEALTH_INIT_SCRIPT


def test_webgl_extension_list_is_intersected_and_get_extension_is_hooked():
    """The claimed extension list used to be asserted wholesale while getExtension
    was left untouched, so asking for an advertised extension returned null — a
    one-line self-contradiction."""
    assert "origGetExtension" in ULTRA_STEALTH_INIT_SCRIPT
    assert "proto.getExtension = makeNative" in ULTRA_STEALTH_INIT_SCRIPT
    assert "claimedExts.filter" in ULTRA_STEALTH_INIT_SCRIPT


def test_canvas_and_audio_noise_are_deterministic_not_random():
    """The docstring always claimed deterministic noise; the code was Math.random(),
    so two reads of one canvas gave two different hashes and a read-twice-and-compare
    probe detected the randomisation itself."""
    assert "const NOISE_SEED" in ULTRA_STEALTH_INIT_SCRIPT
    assert "noiseAt" in ULTRA_STEALTH_INIT_SCRIPT
    # Comments may still name Math.random to explain what was wrong; executable
    # lines may not use it.
    code_lines = [
        line for line in ULTRA_STEALTH_INIT_SCRIPT.splitlines()
        if not line.strip().startswith("//")
    ]
    offenders = [line for line in code_lines if "Math.random" in line]
    assert not offenders, f"noise must be seeded, never Math.random: {offenders}"


def test_canvas_noise_covers_every_read_path():
    """Only toDataURL was hooked, so a getImageData-based fingerprinter read clean
    pixels AND got a different answer than toDataURL — worse than not spoofing."""
    for hook in ["getImageData", "toDataURL", "toBlob"]:
        assert hook in ULTRA_STEALTH_INIT_SCRIPT, f"canvas read path not covered: {hook}"


def test_notification_permission_agrees_with_the_permissions_query():
    """Forcing query() to 'prompt' while Notification.permission stayed 'denied'
    (its value on the headless fallback path) manufactures the textbook headless
    tell rather than avoiding it."""
    assert "Notification, 'permission'" in ULTRA_STEALTH_INIT_SCRIPT
    assert "queryState" in ULTRA_STEALTH_INIT_SCRIPT


def test_window_reports_real_browser_chrome():
    """outerHeight === innerHeight means a window with no tab strip or omnibox,
    which no interactive browser session looks like."""
    assert "outerHeight" in ULTRA_STEALTH_INIT_SCRIPT
    assert "CHROME_HEIGHT" in ULTRA_STEALTH_INIT_SCRIPT


def test_build_stealth_init_script_substitutes_all_profile_parameters():
    script = build_stealth_init_script(DEVICE_PROFILES[0])
    assert "__HW_CONCURRENCY__" not in script
    assert "__GPU_VENDOR__" not in script
    assert "__WEBGL_EXTENSIONS__" not in script
    assert "__VOICES__" not in script
    assert "__SCREEN_WIDTH__" not in script
    assert "__NOISE_SEED__" not in script
    assert "__LANGUAGES__" not in script
    assert "__PLATFORM_VERSION__" not in script
    assert "__ARCHITECTURE__" not in script
    assert "__WORKER_STEALTH_SNIPPET__" not in script
    assert DEVICE_PROFILES[0].voices[0] in script


def test_profile_pool_is_consistent_with_the_container_it_runs_in():
    """Review finding, 2026-08-30: the pool claimed Windows and Apple Silicon from a
    Debian container with neither's fonts, and shipped x86/10.0.0 client hints for an
    M2. Detection scores inconsistency, not rarity — so the default pool is Linux."""
    for profile in DEVICE_PROFILES:
        assert profile.ua_platform == "Linux"
        assert "Linux" in profile.user_agent
        assert profile.platform == "Linux x86_64"


def test_profile_restates_itself_for_the_live_chromium_version():
    """The pool hardcoded Chrome 123/124 while the image installs Debian's unpinned
    chromium, so the UA advertised one version and the TLS fingerprint underneath it
    belonged to another."""
    profile = DEVICE_PROFILES[0].with_chrome_version("141.0.7390.54")
    assert profile.chrome_version == "141.0.7390.54"
    assert "Chrome/141.0.0.0" in profile.user_agent
    assert "Chrome/124" not in profile.user_agent
    # A junk version must not corrupt a working UA.
    assert DEVICE_PROFILES[0].with_chrome_version("") == DEVICE_PROFILES[0]
    assert DEVICE_PROFILES[0].with_chrome_version("not-a-version") == DEVICE_PROFILES[0]


def test_noise_seed_is_stable_per_device_and_differs_across_devices():
    """The whole point of deterministic noise: one device, one canvas hash, forever."""
    assert DEVICE_PROFILES[0].noise_seed == DEVICE_PROFILES[0].noise_seed
    seeds = {p.noise_seed for p in DEVICE_PROFILES}
    assert len(seeds) == len(DEVICE_PROFILES)


def test_languages_are_templated_from_the_geo_profile():
    script = build_stealth_init_script(DEVICE_PROFILES[0], languages=("en-GB", "en"))
    assert '["en-GB", "en"]' in script


def test_challenge_page_detection_signatures():
    assert is_challenge_page("https://challenges.cloudflare.com/turnstile", "Cloudflare", "") is True
    assert is_challenge_page("https://example.com", "Just a moment...", "") is True
    assert is_challenge_page("https://example.com", "Title", "Please verify you are human to continue") is True
    assert is_challenge_page("https://example.com", "Title", "datadome block response") is True
    assert is_challenge_page("https://example.com", "Title", "kpsdk challenge") is True
    assert is_challenge_page("https://example.com", "Normal page", "Welcome to dashboard") is False


# ─── Human-cadence movement/typing ───────────────────────────────────────────────

def test_bezier_trajectory_starts_and_ends_at_the_exact_points():
    path = generate_bezier_trajectory(Point(x=0, y=0), Point(x=300, y=200))
    assert path[0].x == 0 and path[0].y == 0
    assert path[-1].x == 300 and path[-1].y == 200
    assert len(path) > 2  # real intermediate points, not a straight jump


def test_bezier_trajectory_short_hop_is_just_the_two_points():
    path = generate_bezier_trajectory(Point(x=10, y=10), Point(x=12, y=11))
    assert path == [Point(x=10, y=10), Point(x=12, y=11)]


@pytest.mark.asyncio
async def test_human_type_sends_one_keyboard_call_per_character():
    class FakePageForTyping:
        def __init__(self):
            self.keyboard = FakeKeyboard(self)
            self.actions = []

    page = FakePageForTyping()
    await human_type(page, "Hi!")

    typed_chars = [a[1] for a in page.actions if a[0] == "kb_type"]
    assert typed_chars == ["H", "i", "!"]


@pytest.mark.asyncio
async def test_human_scroll_sends_wheel_events_with_dwell():
    class FakeMouseForScroll:
        def __init__(self, page):
            self.page = page

        async def wheel(self, dx, dy):
            self.page.actions.append(("mouse_wheel", dx, dy))

    class FakePageForScroll:
        def __init__(self):
            self.mouse = FakeMouseForScroll(self)
            self.actions = []

        async def wait_for_timeout(self, ms):
            self.actions.append(("wait", ms))

    page = FakePageForScroll()
    await human_scroll(page, delta_y=500)

    wheel_actions = [a for a in page.actions if a[0] == "mouse_wheel"]
    assert len(wheel_actions) >= 5
    total_y = sum(a[2] for a in wheel_actions)
    assert total_y == 500
    waits = [a[1] for a in page.actions if a[0] == "wait"]
    assert any(w >= 150 for w in waits)



@pytest.mark.asyncio
async def test_default_executor_options_use_human_cadence_by_default():
    """The default matters: an agent tool tiered DangerFullAccess, browsing
    arbitrary real sites, should be stealthy by default, not opt-in."""
    assert ExecutorOptions().use_human_cadence is True


@pytest.mark.asyncio
async def test_a_coordinate_click_with_cadence_on_moves_before_clicking():
    class FakePageForClick:
        def __init__(self):
            self.mouse = FakeMouse(self)
            self.keyboard = FakeKeyboard(self)
            self.actions = []
            self.url = "https://example.test"

        async def evaluate(self, script, arg=None):
            return True if "MutationObserver" in script else []

        async def wait_for_timeout(self, ms):
            pass

        def locator(self, selector):
            from test_effector_phase0 import FakeLocator
            return FakeLocator(self, selector, matched=False)

        def get_by_text(self, *a, **kw):
            from test_effector_phase0 import FakeLocator
            return FakeLocator(self, "x", matched=False)

        def get_by_role(self, *a, **kw):
            from test_effector_phase0 import FakeLocator
            return FakeLocator(self, "x", matched=False)

        def get_by_label(self, *a, **kw):
            from test_effector_phase0 import FakeLocator
            return FakeLocator(self, "x", matched=False)

        def get_by_placeholder(self, *a, **kw):
            from test_effector_phase0 import FakeLocator
            return FakeLocator(self, "x", matched=False)

    page = FakePageForClick()
    step = Step(step=1, action="click", target="150,80")  # coordinate target — layer 1
    options = ExecutorOptions(require_approval=False, use_human_cadence=True)

    result = await execute_step(step, page, options)

    assert result.status == "success", result
    # The Bezier path (human_mouse_move) runs first, then the click — confirm the
    # click still lands exactly on target despite the organic path in between,
    # i.e. cadence doesn't corrupt the final coordinate.
    assert ("mouse_click", 150.0, 80.0) in page.actions


# ─── Network shield ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_network_shield_aborts_a_tracking_request_and_allows_a_real_one():
    routed_handler = {}

    class FakeRoutablePage:
        async def route(self, pattern, handler):
            routed_handler["fn"] = handler

    class FakeRequest:
        def __init__(self, url, resource_type="document"):
            self.url = url
            self.resource_type = resource_type

    class FakeRoute:
        def __init__(self, url):
            self.request = FakeRequest(url)
            self.aborted = False
            self.continued = False

        async def abort(self):
            self.aborted = True

        async def continue_(self):
            self.continued = True

    page = FakeRoutablePage()
    await apply_network_shield(page)
    handler = routed_handler["fn"]

    tracker_route = FakeRoute(f"https://{TRACKING_DOMAINS[0]}/collect?x=1")
    await handler(tracker_route)
    assert tracker_route.aborted is True
    assert tracker_route.continued is False

    real_route = FakeRoute("https://example.test/api/data.json")
    await handler(real_route)
    assert real_route.continued is True
    assert real_route.aborted is False


def test_blocked_media_extensions_match_video_and_audio_urls():
    assert any(p.search("https://cdn.example.com/clip.mp4?v=2") for p in BLOCKED_MEDIA_EXTENSIONS)
    assert any(p.search("https://cdn.example.com/track.mp3") for p in BLOCKED_MEDIA_EXTENSIONS)
    assert not any(p.search("https://cdn.example.com/photo.jpg") for p in BLOCKED_MEDIA_EXTENSIONS)


# ─── Proxy config ───────────────────────────────────────────────────────────────

# Every proxy variable the resolution order in agent/proxy_config.py reads. Cleared before
# each test in this file so these are hermetic regardless of the developer's environment.
#
# Real bug, 2026-08-30: proxy credentials were added to the local .env so a local effector
# run would behave like a prod one, and this section started failing. The tests set
# PROXY_HOST and PROXY_PORT but never cleared PROXY_USER/PROXY_PASS, so those resolved
# from the ambient environment and the built config carried real credentials the
# assertions did not expect. The failure output then PRINTED them, which is the part that
# actually matters — an under-isolated test is a credential-disclosure path the moment it
# goes red on a machine that has the real values.
#
# Setting only the variables a test needs is not isolation when the code reads eight.
_PROXY_ENV_VARS = (
    "DATAIMPULSE_HOST", "DATAIMPULSE_PORT", "DATAIMPULSE_USER", "DATAIMPULSE_PASS",
    "PROXY_HOST", "PROXY_PORT", "PROXY_USER", "PROXY_PASS",
)


@pytest.fixture(autouse=True)
def _hermetic_proxy_env(monkeypatch):
    for var in _PROXY_ENV_VARS:
        monkeypatch.delenv(var, raising=False)



def test_no_proxy_configured_is_a_silent_none_not_an_error(monkeypatch):
    for var in ("DATAIMPULSE_HOST", "DATAIMPULSE_PORT", "PROXY_HOST", "PROXY_PORT"):
        monkeypatch.delenv(var, raising=False)
    assert get_residential_proxy_config() is None
    assert get_proxy_url() is None


def test_dataimpulse_env_vars_take_priority_over_generic_proxy_vars(monkeypatch):
    monkeypatch.setenv("DATAIMPULSE_HOST", "gw.dataimpulse.example")
    monkeypatch.setenv("DATAIMPULSE_PORT", "823")
    monkeypatch.setenv("DATAIMPULSE_USER", "user1")
    monkeypatch.setenv("DATAIMPULSE_PASS", "pass1")
    monkeypatch.setenv("PROXY_HOST", "other.example")
    monkeypatch.setenv("PROXY_PORT", "9999")

    cfg = get_residential_proxy_config()
    assert cfg.server == "http://gw.dataimpulse.example:823"
    assert cfg.username == "user1"

    url = get_proxy_url()
    assert url == "http://user1:pass1@gw.dataimpulse.example:823"


def test_should_route_through_proxy_matches_known_residential_targets():
    assert should_route_through_proxy("www.linkedin.com") is True
    assert should_route_through_proxy("apollo.io") is True
    assert should_route_through_proxy("some-random-blog.example") is False
    assert should_route_through_proxy(None) is False


# ─── EffectorSession wiring (fully faked Playwright chain — no real browser) ────

def _fake_playwright_chain():
    """Builds a fake async_playwright()...start().chromium.launch()...new_context()
    ...new_page() chain that records what it was called with, so EffectorSession's
    wiring can be verified without a real browser."""
    fake_page = MagicMock()
    fake_page.route = AsyncMock()

    fake_cdp_session = MagicMock()
    fake_cdp_session.send = AsyncMock()
    fake_cdp_session.on = MagicMock()

    fake_context = MagicMock()
    fake_context.new_page = AsyncMock(return_value=fake_page)
    fake_context.add_init_script = AsyncMock()
    fake_context.close = AsyncMock()
    fake_context.storage_state = AsyncMock(return_value={})
    fake_context.new_cdp_session = AsyncMock(return_value=fake_cdp_session)

    fake_browser = MagicMock()
    fake_browser.new_context = AsyncMock(return_value=fake_context)
    fake_browser.close = AsyncMock()

    fake_chromium = MagicMock()
    fake_chromium.launch = AsyncMock(return_value=fake_browser)

    fake_pw_instance = MagicMock()
    fake_pw_instance.chromium = fake_chromium
    fake_pw_instance.stop = AsyncMock()

    fake_pw_cm = MagicMock()
    fake_pw_cm.start = AsyncMock(return_value=fake_pw_instance)

    fake_async_playwright = MagicMock(return_value=fake_pw_cm)
    return fake_async_playwright, fake_browser, fake_context, fake_page


@pytest.mark.asyncio
async def test_effector_session_applies_stealth_and_network_shield_by_default(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session.page is fake_page

    fake_context.add_init_script.assert_awaited_once()
    call_arg = fake_context.add_init_script.call_args[0][0]
    assert "navigator.webdriver" in call_arg  # actually the real stealth script, not a stub
    fake_page.route.assert_awaited_once()  # network shield registered its handler


@pytest.mark.asyncio
async def test_effector_session_can_disable_stealth_and_network_shield(tmp_path):
    from nanoagent.agent.effector.browser_session import EffectorSession

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path, stealth=False, network_shield=False) as session:
            pass

    fake_context.add_init_script.assert_not_awaited()
    fake_page.route.assert_not_awaited()


@pytest.mark.asyncio
async def test_effector_session_routes_a_residential_domain_through_the_proxy(tmp_path, monkeypatch):
    from nanoagent.agent.effector.browser_session import EffectorSession

    monkeypatch.setenv("PROXY_HOST", "residential.example")
    monkeypatch.setenv("PROXY_PORT", "8080")
    monkeypatch.delenv("DATAIMPULSE_HOST", raising=False)

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path, session_domain="www.linkedin.com") as session:
            pass

    _, kwargs = fake_browser.new_context.call_args
    assert kwargs.get("proxy") == {"server": "http://residential.example:8080"}


@pytest.mark.asyncio
async def test_effector_session_does_not_proxy_a_non_residential_domain(tmp_path, monkeypatch):
    from nanoagent.agent.effector.browser_session import EffectorSession

    monkeypatch.setenv("PROXY_HOST", "residential.example")
    monkeypatch.setenv("PROXY_PORT", "8080")

    fake_async_playwright, fake_browser, fake_context, fake_page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path, session_domain="some-random-blog.example") as session:
            pass

    _, kwargs = fake_browser.new_context.call_args
    assert "proxy" not in kwargs
