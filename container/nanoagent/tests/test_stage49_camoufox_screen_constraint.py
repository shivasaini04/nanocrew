"""The stealth engine has to actually launch, and a static test can prove most of it.

Camoufox fell back to plain Chromium on every run — the most detectable configuration
available, while still reporting `stealth: true`. Observed live in cycle `e1c1aecc`:

    native engine launch failed (No headers based on this input can be generated.
    Please relax or change some of the requirements you specified.)

The cause was `get_camoufox_engine_options` pinning the screen to exactly the viewport.
Measured 2026-09-03 against the engine's own FP_GENERATOR:

    os=linux + screen pinned 1280x720   FAIL
    os=linux + screen band 1280-1920    OK
    os=linux, no screen                 OK
    os=windows + screen pinned          OK

There is no Firefox-on-Linux fingerprint in the corpus with a screen of exactly
1280x720, so pinning it left nothing to draw from.

The existing tests missed it, and the file says why: none of them launched the engine.
They did not have to. Generating a fingerprint from the options this module builds needs
no browser, no display and no binary — and it is the step that was failing. That is what
these do.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.stealth.camoufox_driver import get_camoufox_engine_options
from nanoagent.agent.effector.stealth.fingerprint_pool import pick_device_profile


def _screen(**kwargs):
    return get_camoufox_engine_options(**kwargs).get("screen")


# ─── the bug ──────────────────────────────────────────────────────────────────

def test_the_screen_is_never_pinned_to_a_single_size():
    """The whole failure in one assertion. A pinned screen has no candidate to draw
    from, and the engine refuses rather than approximating."""
    profile = pick_device_profile("example.com")
    screen = _screen(profile=profile, viewport={"width": 1280, "height": 720})

    assert screen is not None
    assert screen.min_width < screen.max_width, "a pinned width is what broke the engine"
    assert screen.min_height < screen.max_height, "a pinned height is what broke the engine"


def test_the_window_is_a_floor_and_the_screen_can_be_bigger():
    """The conflation behind the pin: a 1280x720 viewport is a WINDOW, and a window sits
    on a monitor at least as large. Treating the two as the same number is what produced
    min == max."""
    profile = pick_device_profile("example.com")
    screen = _screen(profile=profile, viewport={"width": 1280, "height": 720})

    assert screen.min_width <= 1280 <= screen.max_width
    assert screen.max_width >= profile.screen_width or screen.max_width >= 1280


@pytest.mark.parametrize("viewport", [
    {"width": 1280, "height": 720},
    {"width": 1920, "height": 1080},
    {"width": 800, "height": 600},
])
def test_no_viewport_produces_a_pin(viewport):
    profile = pick_device_profile("example.com")
    screen = _screen(profile=profile, viewport=viewport)
    assert screen.min_width < screen.max_width and screen.min_height < screen.max_height


def test_it_still_works_with_no_profile_at_all():
    screen = _screen(viewport={"width": 1280, "height": 720})
    assert screen is not None
    assert screen.min_width < screen.max_width


# ─── the real thing: can a fingerprint actually be generated? ─────────────────

def test_the_options_this_module_builds_can_generate_a_fingerprint():
    """The test that would have caught it, and needs no browser to do so.

    This is the exact call the engine makes during launch (`utils.py:launch_options` →
    `fingerprints.generate_fingerprint` → `FP_GENERATOR.generate`), with the exact
    options this module hands it. If the constraints are unsatisfiable it raises here,
    in a fraction of a second, instead of at 3am on a real run.
    """
    fingerprints = pytest.importorskip("nanoagent.agent.effector.engine.fingerprints")

    profile = pick_device_profile("example.com")
    opts = get_camoufox_engine_options(
        profile=profile, viewport={"width": 1280, "height": 720}, headless=True,
    )

    # os is load-bearing and must stay in the request: left unconstrained the engine
    # picks Windows, and the container installs Linux fonts, which are measured rather
    # than read. A Windows claim there is a contradiction no JS patch can cover.
    assert opts["os"] == "linux"

    fingerprint = fingerprints.FP_GENERATOR.generate(screen=opts["screen"], os=opts["os"])
    assert fingerprint is not None


def test_a_pinned_screen_still_fails_so_this_test_is_worth_something():
    """Proves the check above can actually fail — otherwise it would pass for a
    constraint set that is satisfiable no matter what, and prove nothing."""
    fingerprints = pytest.importorskip("nanoagent.agent.effector.engine.fingerprints")
    from browserforge.fingerprints import Screen

    pinned = Screen(min_width=1280, max_width=1280, min_height=720, max_height=720)
    with pytest.raises(Exception):
        fingerprints.FP_GENERATOR.generate(screen=pinned, os="linux")
