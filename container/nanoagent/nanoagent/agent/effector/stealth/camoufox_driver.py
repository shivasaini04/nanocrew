"""Camoufox inlined native anti-detection engine integration for Effector.

Interfaces directly with the inlined native engine (`nanoagent.agent.effector.engine`)
to provide native C++ Juggler isolated automation scope, C++ WebGL/Canvas/Audio/Font
masking, and BrowserForge statistical fingerprint generation without userland JavaScript
proxy overhead.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from loguru import logger

from nanoagent.agent.effector.stealth.fingerprint_pool import DeviceProfile
from nanoagent.agent.effector.stealth.geo_profile import GeoProfile


def engine_status() -> tuple[bool, str]:
    """(available, reason). Reason explains WHY when unavailable.

    R3, 2026-08-31: this used to call `get_installed_browser_path`, which does not
    exist anywhere in the vendored engine — the ImportError was swallowed by a bare
    `except Exception: return False`, so the engine reported "unavailable" on every
    machine including ones with the browser installed. The engine could never start.
    Resolved against the real API (`launch_path`, which raises CamoufoxNotInstalled
    when the binary is absent) and the reason is returned rather than discarded, so
    a missing binary and a broken integration are no longer the same silent False.
    """
    try:
        from nanoagent.agent.effector.engine.multiversion import get_active_path
        from nanoagent.agent.effector.engine.pkgman import INSTALL_DIR, LAUNCH_FILE, OS_NAME
    except Exception as err:  # engine package itself is broken or deps missing
        return False, f"engine package not importable ({type(err).__name__}: {err})"

    # Deliberately NOT via pkgman.camoufox_path()/launch_path(). Both are written for
    # the CLI's install flow, and a probe must not have either of their side effects:
    # camoufox_path() defaults to download_if_missing=True (a multi-hundred-MB fetch
    # that blocks the caller), and it opens with an unconditional
    # shutil.rmtree(INSTALL_DIR) "clean up old data" branch. Asking whether the engine
    # is ready must never download anything and must never delete an install.
    # Fetching is an explicit build step — see container/Dockerfile.
    try:
        base = get_active_path() or (INSTALL_DIR if INSTALL_DIR.exists() else None)
    except Exception as err:
        return False, f"engine install state unreadable ({type(err).__name__}: {err})"

    if base is None:
        return False, "engine browser binary not installed (no active install)"

    exec_path = Path(base) / LAUNCH_FILE[OS_NAME]
    if OS_NAME == "mac":
        exec_path = Path(base) / "Camoufox.app" / "Contents" / "Resources" / LAUNCH_FILE[OS_NAME]

    if not exec_path.exists():
        return False, f"engine binary missing at {exec_path}"
    return True, f"engine binary at {exec_path}"


def is_camoufox_available() -> bool:
    """True if the inlined engine and its browser binary are both usable."""
    available, reason = engine_status()
    if not available:
        logger.debug(f"camoufox_driver: native engine unavailable — {reason}")
    return available


def get_camoufox_engine_options(
    profile: DeviceProfile | None = None,
    geo: GeoProfile | None = None,
    headless: bool = False,
    viewport: dict[str, int] | None = None,
    proxy: dict[str, str] | None = None,
    target_os: str | None = None,
) -> dict[str, Any]:
    """Builds engine configuration kwargs for AsyncCamoufox using Effector's session profiles."""
    opts: dict[str, Any] = {
        "headless": headless,
        "geoip": False,  # Managed by Effector proxy router to prevent leaks
        "humanize": False,  # Retain Effector's custom kinematics
    }

    # The engine expects a browserforge Screen constraint object, NOT a (w, h) tuple.
    # Passing a tuple crashed the launch with "'tuple' object has no attribute
    # 'is_set'" — found 2026-08-31 on the first live run of the native engine, which
    # then fell back to Chromium. The static tests never caught it because none of
    # them actually launched the engine.
    screen_cls = None
    try:
        from browserforge.fingerprints import Screen as screen_cls  # type: ignore
    except Exception:
        try:
            from nanoagent.agent.effector.engine.fingerprints import Screen as screen_cls  # type: ignore
        except Exception:
            screen_cls = None

    if screen_cls is not None:
        # The constraint describes the MONITOR, not the browser window.
        #
        # This read the viewport first and fell back to the profile, which conflated the
        # two: a 1280x720 viewport does not mean a 1280x720 monitor, because a real
        # browser window is smaller than the screen it sits on. With the default viewport
        # the arithmetic below then collapsed to min == max — the exact pin the comment
        # it replaced warned against — and the engine failed on every launch with "No
        # headers based on this input can be generated", falling back to plain Chromium.
        #
        # Measured 2026-09-03 against the engine's own FP_GENERATOR
        # (browser='firefox', os=('linux','macos','windows')):
        #
        #     os=linux + screen pinned 1280x720   FAIL
        #     os=linux + screen band 1280-1920    OK
        #     os=linux, no screen                 OK
        #     os=windows + screen pinned          OK
        #
        # There is no Firefox-on-Linux fingerprint in the corpus with a screen of exactly
        # 1280x720, so pinning it left nothing to draw from. os=linux is load-bearing
        # (see below) and the viewport is ours to choose, so the screen is what gives.
        #
        # The window is therefore a FLOOR — a screen can never be smaller than the window
        # on it — and the profile's screen is the ceiling. A band, and a physically
        # coherent one.
        floor_w = floor_h = None
        if viewport:
            floor_w, floor_h = viewport.get("width", 1280), viewport.get("height", 720)
        ceil_w = profile.screen_width if profile else None
        ceil_h = profile.screen_height if profile else None
        if floor_w is None and ceil_w:
            floor_w, floor_h = min(ceil_w, 1280), min(ceil_h or 720, 720)
        if ceil_w is None and floor_w:
            # No profile: widen upwards to the common desktop sizes rather than pinning.
            ceil_w, ceil_h = max(floor_w, 1920), max(floor_h or 720, 1080)

        # Never let the band collapse. A viewport that happens to match the profile's
        # screen exactly — 1920x1080 against a 1920-wide profile — would otherwise
        # reproduce the very pin this exists to remove, on some profiles and not others,
        # which is worse than failing every time because it fails unpredictably.
        if floor_w and ceil_w and ceil_w <= floor_w:
            ceil_w = max(floor_w + 640, 1920)
        if floor_h and ceil_h and ceil_h <= floor_h:
            ceil_h = max(floor_h + 360, 1080)

        if floor_w and floor_h and ceil_w and ceil_h:
            opts["screen"] = screen_cls(
                min_width=min(floor_w, ceil_w), max_width=max(floor_w, ceil_w),
                min_height=min(floor_h, ceil_h), max_height=max(floor_h, ceil_h),
            )

    if profile:
        # Match target OS from profile: windows | macos | linux.
        #
        # Load-bearing: left unconstrained the engine picks its own OS and defaulted to
        # Windows (measured 2026-08-31 — it reported "Windows NT 10.0; Win64; x64" in a
        # Debian container). The image installs Linux fonts, and font metrics are
        # measured rather than read, so a Windows claim here is a contradiction that
        # cannot be patched from JS. Confirmed os="linux" is honoured: the engine then
        # reports "X11; Linux x86_64" and oscpu "Linux x86_64".
        opts["os"] = "linux" if profile.platform == "Linux x86_64" else "windows"
        # NB: `profile.voices` is the speechSynthesis voice list, NOT a font list.
        # It used to be passed as opts["fonts"], which would have handed the engine
        # TTS voice names ("Microsoft David Desktop") as installed font families —
        # a font set no real machine has, i.e. the opposite of what it was for.
        # The container's real font set is installed in the Dockerfile and is what
        # the engine should measure; don't override it.

    if target_os:
        opts["os"] = target_os.lower()

    if geo:
        # `locale` is the ONLY one of these the engine takes. timezone_id and languages
        # are Playwright context kwargs, not engine launch options — passing them raised
        # TypeError, the launch wrapper reported "native engine launch failed", and the
        # engine fell back to Chromium on every session while launching fine in a bare
        # test. That is why the earlier bisect passed: it never exercised the geo path.
        #
        # The engine derives timezone and Accept-Language from the locale itself, which
        # is the coherent behaviour anyway — a locale and timezone set independently can
        # disagree, and this way they cannot.
        opts["locale"] = geo.locale

    if proxy:
        opts["proxy"] = proxy

    # WebRTC: block it outright so a STUN request cannot leak the container's real IP
    # from behind the residential proxy.
    #
    # The option is `block_webrtc: bool`. It was previously written as
    # `webrtc={"policy": ...}` — a Chromium-flag shape this engine does not accept —
    # and the resulting TypeError was caught by the launch wrapper and reported as
    # "native engine launch failed", so the engine silently fell back to Chromium on
    # EVERY run. Isolated by bisecting the option set against the live engine
    # 2026-08-31, after a guess at the screen constraint cost a full build cycle.
    opts["block_webrtc"] = True

    return opts
