"""The session key comes from the URL when nobody named one.

The encrypted vault has worked since stage 49 phase 2 and was proven end to end. It
still did nothing for most runs, because it only engaged when the MODEL passed
`session_domain` — an optional argument it cannot know it needs, since it has not
reached the login yet.

Measured live 2026-09-04: a person took over, signed into Google, handed back, and
nothing was saved. The call was `effector(goal=..., url=...)`. The vault on disk was
two days stale. The next run would have asked them to sign in again.

So the key is derived from the starting URL. An explicit argument still wins — a caller
that names a domain means it.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.tools.effector import _domain_of


# ─── the derivation ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://nanocrew.example.com", "nanocrew.example.com"),
    ("https://nanocrew.example.com/agents/123?x=1#frag", "nanocrew.example.com"),
    ("http://example.test:8080/login", "example.test"),
    ("https://EXAMPLE.TEST/Login", "example.test"),
])
def test_the_host_becomes_the_session_key(url, expected):
    assert _domain_of(url) == expected


def test_www_is_stripped_so_one_site_is_one_session():
    """Otherwise www.example.com and example.com are two half-logged-in sessions, and
    which one you get depends on how the URL happened to be written."""
    assert _domain_of("https://www.example.com/in") == _domain_of("https://example.com/in")


# ─── no key is better than the wrong key ──────────────────────────────────────

@pytest.mark.parametrize("url", ["", "not a url", "/just/a/path", "about:blank"])
def test_a_url_with_no_host_yields_nothing(url):
    """react_loop's `_domain_of` answers "default" for these, which is right for a
    rate-limit bucket and wrong for a vault: every unparseable URL would pour its
    cookies into one shared "default" file."""
    assert _domain_of(url) is None


def test_it_never_raises_on_rubbish():
    for value in ("://", "http://[", "\x00"):
        assert _domain_of(value) is None or isinstance(_domain_of(value), str)


# ─── the vault key is what the session is actually built with ─────────────────

def test_a_derived_key_is_a_safe_filename():
    """SessionVault writes `<key>.vault`. A key with a slash or a colon in it would
    escape the vault directory or fail to open."""
    key = _domain_of("http://example.test:8080/login")
    assert key and "/" not in key and ":" not in key and "\\" not in key


def test_two_different_sites_do_not_share_a_session():
    """The property that keeps one site's cookies out of another's vault."""
    assert _domain_of("https://nanocrew.example.com") != _domain_of("https://google.com")
