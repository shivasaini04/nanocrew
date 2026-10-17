"""Who is allowed to spend the residential proxy.

Decision 2026-08-30: the pool is for the effector super-tool. Before this, any tool that
happened to read PROXY_HOST used it silently just by having the credentials in scope —
which is how a paid proxy ended up with four independent consumers nobody had decided on,
and why "is anything using the proxy?" could not be answered without grepping.

Effector routes on RESIDENTIAL_DOMAINS and is not governed by the allowlist. Every HTTP
tool is off unless named in PROXY_FOR_HTTP_TOOLS.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.proxy_config import (
    get_proxy_url,
    get_proxy_url_for,
    http_tool_may_proxy,
    should_route_through_proxy,
)

_CREDS = {
    "PROXY_HOST": "gw.example-proxy.com",
    "PROXY_PORT": "823",
    "PROXY_USER": "u",
    "PROXY_PASS": "p",
}
_TOOLS = ("web_fetch", "http_request", "custom_tool")


@pytest.fixture(autouse=True)
def creds(monkeypatch):
    """Credentials present for every test here — the point is never whether they exist,
    only who is allowed to use them."""
    for k, v in _CREDS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("DATAIMPULSE_HOST", raising=False)
    monkeypatch.delenv("DATAIMPULSE_PORT", raising=False)
    monkeypatch.delenv("PROXY_FOR_HTTP_TOOLS", raising=False)


# ─── the default: effector only ─────────────────────────────────────────────

def test_credentials_alone_do_not_entitle_a_tool():
    """The regression this exists for. Having PROXY_HOST in scope used to be the whole
    qualification."""
    assert get_proxy_url() is not None, "premise: credentials are configured"
    for tool in _TOOLS:
        assert get_proxy_url_for(tool) is None, f"{tool} proxied with no allowlist entry"


def test_effector_is_not_governed_by_the_allowlist():
    """Effector's gate is the site, not the tool list — it is the intended consumer."""
    assert should_route_through_proxy("linkedin.com") is True
    assert should_route_through_proxy("example.com") is False


# ─── turning one on ─────────────────────────────────────────────────────────

def test_naming_one_tool_enables_exactly_that_tool(monkeypatch):
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "reddit_search")
    assert get_proxy_url_for("reddit_search") is not None
    assert get_proxy_url_for("linkedin_jobs") is None
    assert get_proxy_url_for("yc_jobs") is None


def test_a_comma_list_enables_several(monkeypatch):
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "reddit_search, yc_jobs")
    assert get_proxy_url_for("reddit_search") is not None
    assert get_proxy_url_for("yc_jobs") is not None
    assert get_proxy_url_for("linkedin_jobs") is None


@pytest.mark.parametrize("token", ["all", "*", "on", "true", "1", "yes"])
def test_the_all_tokens_restore_the_old_behaviour(monkeypatch, token):
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", token)
    for tool in _TOOLS:
        assert get_proxy_url_for(tool) is not None


def test_matching_ignores_case_and_padding(monkeypatch):
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "  Reddit_Search  ")
    assert get_proxy_url_for("reddit_search") is not None


def test_an_unknown_name_enables_nothing(monkeypatch):
    """A typo must fail closed, not open."""
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "reddit-search")  # hyphen, not underscore
    assert get_proxy_url_for("reddit_search") is None


# ─── no credentials ─────────────────────────────────────────────────────────

def test_allowlisting_a_tool_without_credentials_still_routes_direct(monkeypatch):
    for k in _CREDS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "all")
    assert get_proxy_url() is None
    for tool in _TOOLS:
        assert get_proxy_url_for(tool) is None
