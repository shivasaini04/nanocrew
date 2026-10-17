"""Profile/engine coherence — the disguise and the browser wearing it must agree.

Measured 2026-08-31 inside the prod image. The vendored engine is Gecko (Camoufox 152
ships an `application.ini` and a Firefox version line). Every profile in the pool claims
Chrome, and the stealth init script defines `window.chrome`, `navigator.userAgentData`,
`deviceMemory` and a Chrome PDF plugin list — none of which exist in Firefox.

Pairing them is not a partial disguise. It produces a browser whose JS surface says
Chrome while its TLS handshake, HTTP/2 SETTINGS and header order all say Firefox, which
is *easier* to detect than plain unmodified Chromium. fingerprint_pool's own rule:
**detection scores inconsistency, not rarity.**

This is also why the uTLS forwarder was not built. A Chrome-preset ClientHello in front
of a Gecko browser would have manufactured exactly this contradiction at the transport
layer, at considerable cost, and made things worse.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.agent.effector.capability_manifest import CapabilityManifest
from nanoagent.agent.effector.stealth.fingerprint_pool import (
    DEVICE_PROFILES,
    pick_device_profile,
)

SESSION = Path(__file__).resolve().parents[1] / "nanoagent" / "agent" / "effector" / "browser_session.py"


# ------------------------------------------------------------------ profile family


def test_every_shipped_profile_declares_a_family():
    for profile in DEVICE_PROFILES:
        assert profile.browser_family in ("chromium", "gecko"), profile.name


def test_the_default_pool_is_chromium():
    """DEVICE_PROFILES is the Chromium pool; Gecko is selected explicitly."""
    families = {p.browser_family for p in DEVICE_PROFILES}
    assert families == {"chromium"}, (
        f"the default pool now contains {families}; Chromium callers would silently "
        f"start wearing a Firefox disguise"
    )


def test_family_is_derived_from_the_user_agent_not_hardcoded():
    from dataclasses import replace

    chrome = DEVICE_PROFILES[0]
    assert chrome.browser_family == "chromium"

    gecko = replace(
        chrome,
        user_agent="Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    )
    assert gecko.browser_family == "gecko"


def test_profiles_claiming_chrome_are_internally_consistent():
    """A Chrome claim commits the profile to the rest of the Chrome surface."""
    for p in DEVICE_PROFILES:
        if p.browser_family != "chromium":
            continue
        assert "Chrome/" in p.user_agent, p.name
        assert "AppleWebKit/537.36" in p.user_agent, p.name
        assert p.chrome_version, p.name


# ------------------------------------------------------------------ the gate itself


def test_session_gates_the_engine_on_coherence():
    """Reachability guard: the gate must exist in the production launch path."""
    source = SESSION.read_text(encoding="utf-8")
    assert "browser_family" in source, (
        "browser_session no longer checks profile/engine coherence — a Chrome profile "
        "can again be worn by the Gecko engine, which is more detectable than Chromium"
    )
    assert "coherent" in source
    # The gate has to be part of the decision, not merely logged next to it.
    assert "and coherent" in source, (
        "coherence is computed but does not gate use_native"
    )


def test_gate_runs_before_the_engine_is_launched():
    source = SESSION.read_text(encoding="utf-8")
    assert source.index("coherent = pool_family") < source.index("AsyncCamoufox"), (
        "coherence is decided after the engine has already been launched"
    )


def test_manifest_reports_the_profile_family():
    """A run must not be able to silently wear the wrong disguise."""
    d = CapabilityManifest().to_dict()
    assert "profile_family" in d
    assert d["profile_family"] in ("chromium", "gecko")


def test_incoherent_pairing_reports_a_reason_naming_both_sides():
    """The degradation must say what mismatched, not just that something did."""
    m = CapabilityManifest()
    m.degrade(
        "native engine held back — engine is gecko but the fingerprint pool is chromium",
        requested=True,
    )
    assert m.degraded
    assert "gecko" in m.degradations[0] and "chromium" in m.degradations[0]


def test_pick_device_profile_is_stable_for_a_domain():
    """The gate calls pick_device_profile once for the family check and again for the
    launch; a non-deterministic pool would let those disagree."""
    a = pick_device_profile("example.com")
    b = pick_device_profile("example.com")
    assert a.name == b.name
    assert a.browser_family == b.browser_family


# ------------------------------------------------ measured against a real browser


def test_interceptor_documents_why_per_target_sends_no_op():
    """A browser-level CDP session cannot route Page.*/Network.* to a target.

    Measured 2026-08-31: both come back "Protocol error ('X' wasn't found)". The
    patching is covered anyway by context.add_init_script, which Playwright applies to
    every page in the context — popups included — before that page's first script.
    Verified live: an opener and a popup reading its own fingerprint from its first
    inline <script> agree on ua/platform/hardwareConcurrency/deviceMemory/webdriver.

    So the ring's real job is narrower than its name: hold each new target paused until
    the context-level patching is in place, then release it. This asserts the code says
    so, because a reader who believes the per-target sends are load-bearing will
    "fix" them back into an error path.
    """
    src = (
        Path(__file__).resolve().parents[1]
        / "nanoagent" / "agent" / "effector" / "lifecycle" / "cdp_target_interceptor.py"
    ).read_text(encoding="utf-8")

    assert "add_init_script" in src, (
        "the interceptor no longer explains that context-level init scripts cover the "
        "popup patching — the per-target sends look load-bearing without it"
    )
    assert "Nothing here is load-bearing" in src, (
        "the note explaining that the per-target sends are best-effort is gone — a "
        "reader will take them for the mechanism and 'fix' them into an error path"
    )
    assert "waitForDebuggerOnStart" in src, (
        "the reason targets are not paused must stay recorded; re-enabling the pause "
        "hangs every navigation"
    )


# ------------------------------------------------------------------- the Gecko pool


def test_gecko_pool_exists_and_claims_firefox():
    from nanoagent.agent.effector.stealth.fingerprint_pool import _GECKO_PROFILES

    assert _GECKO_PROFILES, "no Gecko pool — the engine has nothing coherent to wear"
    for p in _GECKO_PROFILES:
        assert p.browser_family == "gecko", p.name
        assert "Firefox/" in p.user_agent and "Gecko/" in p.user_agent, p.name
        assert "Chrome" not in p.user_agent, p.name
        assert "AppleWebKit" not in p.user_agent, p.name


def test_gecko_profiles_match_what_the_engine_actually_reports():
    """Measured from the engine on 2026-08-31 with os="linux", inside the prod image.

    Anchoring to a measurement rather than a Firefox release note is the whole point:
    a pool built from plausible-looking guesses is how the Chrome-on-Gecko mismatch
    would come back in a new form.
    """
    from nanoagent.agent.effector.stealth.fingerprint_pool import _GECKO_PROFILES

    for p in _GECKO_PROFILES:
        assert p.platform == "Linux x86_64", p.name
        assert "X11; Linux x86_64" in p.user_agent, p.name
        assert "rv:152.0" in p.user_agent, p.name
        # chrome_version is meaningless on Gecko and must not leak a Chrome number.
        assert p.chrome_version == "", (
            f"{p.name} carries a Chrome version; a Chrome-shaped consumer would emit "
            f"it from a Firefox browser"
        )


def test_gecko_pool_has_no_windows_variant():
    """The container installs Linux fonts; font metrics are measured, not read."""
    from nanoagent.agent.effector.stealth.fingerprint_pool import _active_pool

    for p in _active_pool("gecko"):
        assert "Windows" not in p.user_agent, p.name
        assert p.platform == "Linux x86_64", p.name


def test_pool_selection_follows_the_browser_family():
    from nanoagent.agent.effector.stealth.fingerprint_pool import pick_device_profile

    assert pick_device_profile("x.com", "gecko").browser_family == "gecko"
    assert pick_device_profile("x.com").browser_family == "chromium"
    # Still deterministic per domain within a family.
    assert pick_device_profile("x.com", "gecko").name == pick_device_profile("x.com", "gecko").name


def test_native_branch_never_applies_the_chromium_stealth_script():
    """window.chrome / userAgentData / deviceMemory are undefined on real Firefox.

    Injecting them into the Gecko engine would manufacture the contradiction the pool
    exists to avoid. The native branch returns before apply_stealth_to_context; this
    asserts the reasoning is recorded so it is not "tidied up" later.
    """
    src = SESSION.read_text(encoding="utf-8")
    # The end marker is the first line of the Chromium path. It used to be the
    # `async_playwright()` assignment, which stage 62's browser pool moved inside a
    # nested launcher and renamed — a slice by a name that can be renamed will go on
    # reporting a pass, or a confusing failure, long after it stopped reading the branch.
    native = src[src.index("if use_native:"):src.index("chromium_path = os.environ.get(")]
    # Strip comments: the branch NAMES the function in a note explaining why it is not
    # called, which would otherwise trip this check.
    native_code = " ".join(
        line.split("#", 1)[0] for line in native.splitlines()
    )
    assert "apply_stealth_to_context" not in native_code, (
        "the Chrome-shaped stealth script is being applied on the Gecko engine path"
    )
    assert "deliberately NOT called on this" in src


def test_engine_is_pinned_to_linux():
    """Unconstrained, the engine picks Windows — measured. The image has Linux fonts."""
    from nanoagent.agent.effector.stealth.camoufox_driver import get_camoufox_engine_options
    from nanoagent.agent.effector.stealth.fingerprint_pool import _GECKO_PROFILES

    opts = get_camoufox_engine_options(profile=_GECKO_PROFILES[0], headless=True)
    assert opts["os"] == "linux"


def test_every_engine_option_is_accepted_by_the_engine():
    """Guard against options the engine does not take.

    `webrtc={"policy": ...}` — a Chromium-flag shape — raised TypeError at launch, the
    wrapper caught it as "native engine launch failed", and the engine silently fell
    back to Chromium on every run while the binary sat there working. Two build cycles
    were spent guessing before bisecting the option set against the live engine.

    Checked against the real signature so a wrong name fails here, in a second, rather
    than as a silent fallback in production.
    """
    import inspect

    from nanoagent.agent.effector.engine.utils import launch_options
    from nanoagent.agent.effector.stealth.camoufox_driver import get_camoufox_engine_options
    from nanoagent.agent.effector.stealth.fingerprint_pool import _GECKO_PROFILES

    from nanoagent.agent.effector.stealth.geo_profile import GeoProfile

    accepted = set(inspect.signature(launch_options).parameters)

    # Exercise EVERY branch of the builder, not just the bare one. The first version of
    # this test only covered the no-geo, no-proxy path — so it passed while the session
    # was still passing timezone_id, languages, viewport and storage_state, none of
    # which the engine accepts. A test that misses the branch production uses is the
    # same failure as no test.
    geo = GeoProfile(
        locale="en-US", timezone_id="America/New_York",
        accept_language="en-US,en;q=0.9", source="test",
    )
    variants = {
        "bare": {},
        "geo": {"geo": geo},
        "viewport": {"viewport": {"width": 1440, "height": 900}},
        "proxy": {"proxy": {"server": "http://127.0.0.1:1"}},
        "full": {"geo": geo, "viewport": {"width": 1440, "height": 900},
                 "proxy": {"server": "http://127.0.0.1:1"}},
    }

    for profile in _GECKO_PROFILES:
        for label, extra in variants.items():
            opts = get_camoufox_engine_options(profile=profile, headless=True, **extra)
            unknown = set(opts) - accepted
            assert not unknown, (
                f"[{label}] engine options {sorted(unknown)} are not parameters of "
                f"launch_options; the launch will TypeError and fall back to Chromium "
                f"silently while the binary sits there working"
            )


def test_webrtc_is_blocked_not_policy_shaped():
    """A STUN request must not leak the container IP from behind the proxy."""
    from nanoagent.agent.effector.stealth.camoufox_driver import get_camoufox_engine_options
    from nanoagent.agent.effector.stealth.fingerprint_pool import _GECKO_PROFILES

    opts = get_camoufox_engine_options(profile=_GECKO_PROFILES[0], headless=True)
    assert opts.get("block_webrtc") is True
    assert "webrtc" not in opts, "the Chromium-shaped webrtc option is back"
