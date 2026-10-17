"""Stage 61 (founder decision 2026-09-19): human-cadence movement and typing only where
bot detection is known — proxy_config.RESIDENTIAL_DOMAINS — and always in the user's
own browser. Phase 0 measured it at 7–9 s per typed field."""

from __future__ import annotations

from nanoagent.agent.effector.react_loop import _wants_human_cadence


class _Page:
    url = "https://example.test/"


def test_plain_sites_type_at_machine_speed():
    assert _wants_human_cadence(True, "https://books.toscrape.com/", _Page()) is False
    assert _wants_human_cadence(True, "https://demoqa.com/text-box", _Page()) is False


def test_bot_sensitive_sites_keep_human_cadence():
    assert _wants_human_cadence(True, "https://www.linkedin.com/in/someone", _Page()) is True
    assert _wants_human_cadence(True, "https://www.google.com/search?q=x", _Page()) is True


def test_turned_off_means_off_everywhere():
    assert _wants_human_cadence(False, "https://www.linkedin.com/", _Page()) is False


def test_an_ordinary_site_types_at_machine_speed_even_in_the_users_browser(monkeypatch):
    """This asserted the opposite until 2026-09-21, and the cost was measured live.

    An "organic" mouse path is 16 mouse.move calls plus a click; human typing is one
    call PER CHARACTER. In the container each is about a millisecond. Over the bridge to
    the user's machine each is a network hop of ~600 ms, so one click took 10.1 s and
    typing 25 characters took 19.4 s — 39 s of a 107 s run, on a site that does not
    fingerprint anything.
    """
    from nanoagent.agent.effector import react_loop
    monkeypatch.setattr(react_loop, "_is_remote_lane", lambda page: True)
    assert _wants_human_cadence(True, "https://music.youtube.com/", _Page()) is False
    assert _wants_human_cadence(True, "https://books.toscrape.com/", _Page()) is False


def test_a_fingerprinting_site_still_gets_human_cadence_in_the_users_browser(monkeypatch):
    """The protection that mattered is kept: it now follows the SITE on both lanes
    rather than the lane, so a real logged-in account on a site known to block bots is
    still typed like a person."""
    from nanoagent.agent.effector import react_loop
    monkeypatch.setattr(react_loop, "_is_remote_lane", lambda page: True)
    assert _wants_human_cadence(True, "https://www.linkedin.com/in/someone", _Page()) is True


def test_no_url_falls_back_to_machine_speed():
    assert _wants_human_cadence(True, None, _Page()) is False
