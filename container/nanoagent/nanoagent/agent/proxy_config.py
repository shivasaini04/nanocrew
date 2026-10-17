"""Residential proxy configuration — shared, not effector-specific.

`agent/tools/linkedin_jobs.py` and `agent/tools/yc_jobs.py` each carry their own copy
of this exact env-var read (their own comments already note the duplication: "see
linkedin_jobs.py's copy of this"). Effector is a third consumer (its stealth/
proxy_router.py); rather than tripling the copy, this is the one shared place —
matches stage43 doc 03's "reuse what's already paid for" instruction for the
DataImpulse/Crawler residential proxy infra.
Existing tools are untouched; this is additive.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

RESIDENTIAL_DOMAINS = [
    "linkedin.com", "apollo.io", "indeed.com", "glassdoor.com", "zoominfo.com",
    "instagram.com", "twitter.com", "x.com", "facebook.com", "reddit.com",
    # Added 2026-09-01, measured rather than assumed. Google serves
    # /sorry/index ("unusual traffic from your computer network", quoting the
    # datacenter IP) to BROWSER traffic from this host — while plain curl from the
    # same IP gets real results. Confirmed it is not a fingerprint problem: stock
    # Chromium with no stealth at all is blocked identically to the fully stealthed
    # session, headless and headful alike. The decision is made on the IP before the
    # browser is looked at, so no amount of fingerprint work fixes it.
    #
    # Google also geolocated this server to Germany (gl=DE on the consent redirect)
    # while the profile claimed America/New_York — a mismatch a residential exit in
    # the claimed region also resolves.
    "google.com",
]


@dataclass
class ProxyConfig:
    server: str
    username: str | None = None
    password: str | None = None


def get_residential_proxy_config() -> ProxyConfig | None:
    """Playwright-shaped proxy config ({server, username, password} as separate
    fields — Playwright's launch()/new_context() `proxy` param needs this shape,
    unlike httpx's embedded-auth URL). Checks DATAIMPULSE_* first (this repo's
    actual paid provider), then the generic PROXY_* names linkedin_jobs.py/
    yc_jobs.py already use, so all three consumers share one source of truth."""
    host = os.environ.get("DATAIMPULSE_HOST", "").strip() or os.environ.get("PROXY_HOST", "").strip()
    port = os.environ.get("DATAIMPULSE_PORT", "").strip() or os.environ.get("PROXY_PORT", "").strip()
    if not host or not port:
        return None

    username = os.environ.get("DATAIMPULSE_USER", "").strip() or os.environ.get("PROXY_USER", "").strip()
    password = os.environ.get("DATAIMPULSE_PASS", "").strip() or os.environ.get("PROXY_PASS", "").strip()

    server = f"{host}:{port}" if host.startswith(("http", "socks")) else f"http://{host}:{port}"

    return ProxyConfig(server=server, username=username or None, password=password or None)


# Which HTTP tools may use the proxy. Effector is NOT governed by this — it is the
# intended consumer and routes on RESIDENTIAL_DOMAINS below, always.
#
# Decision 2026-08-30: the residential pool is for the effector super-tool. Before this,
# any tool that read PROXY_HOST used it silently just by having the credentials in scope,
# which is how a paid pool ended up with four independent consumers nobody had decided on.
# Default is now "none": an HTTP tool proxies only if it is named here.
#
#   PROXY_FOR_HTTP_TOOLS=                  -> effector only (default)
#   PROXY_FOR_HTTP_TOOLS=reddit_search     -> effector + that one tool
#   PROXY_FOR_HTTP_TOOLS=reddit_search,yc_jobs
#   PROXY_FOR_HTTP_TOOLS=all               -> effector + every HTTP tool (the old behaviour)
_HTTP_TOOL_ALLOWLIST_ENV = "PROXY_FOR_HTTP_TOOLS"
_ALL_TOKENS = {"1", "on", "true", "yes", "all", "*"}


def http_tool_may_proxy(tool_name: str) -> bool:
    """Whether `tool_name` is allowed to route through the residential pool."""
    raw = os.environ.get(_HTTP_TOOL_ALLOWLIST_ENV, "").strip().lower()
    if not raw:
        return False
    if raw in _ALL_TOKENS:
        return True
    return tool_name.strip().lower() in {p.strip() for p in raw.split(",") if p.strip()}


def get_proxy_url_for(tool_name: str) -> str | None:
    """`get_proxy_url()` for an HTTP tool, or None when that tool is not allowlisted.

    The one place the three HTTP tools now read proxy credentials from — each used to
    carry its own copy of the same four os.environ reads, which this module's docstring
    already called out as duplication and which made "who uses the proxy" unanswerable
    without grepping."""
    if not http_tool_may_proxy(tool_name):
        return None
    return get_proxy_url()


def get_proxy_url_for_url(url_or_domain: str | None) -> str | None:
    """Proxy URL for a *destination*, with no reference to which tool is asking.

    This is the capability form, and the one `agent/source_fetch.py` uses. It is the same
    gate effector has always had (`should_route_through_proxy`) — the site decides, not a
    hardcoded caller list.

    Why both this and `get_proxy_url_for(tool_name)` exist: the 2026-08-30 decision that
    created the name allowlist was aimed at a specific failure — a tool that reads
    PROXY_HOST builds one client and then sends *all* its traffic through the paid pool,
    including the traffic that never needed it. yc_jobs is the live example: allowlisted
    by name, so every ycombinator.com request spends residential bandwidth on a public
    job board.

    Routing on the destination is a strictly tighter control than that allowlist, not a
    loosening of it: only the domains in RESIDENTIAL_DOMAINS can spend the pool, and they
    can spend it no matter who calls. That is what lets an agent-generated tool reach
    linkedin.com at all — under the name allowlist it silently got the datacenter IP and
    saw an empty page rather than an error.
    """
    if not should_route_through_proxy(url_or_domain):
        return None
    return get_proxy_url()


def get_proxy_url() -> str | None:
    """httpx-shaped proxy URL with embedded auth (`http://user:pass@host:port`) —
    same convention as linkedin_jobs.py/yc_jobs.py's `_proxy_url()`, for a caller
    that wants the URL form rather than Playwright's separate-fields form."""
    cfg = get_residential_proxy_config()
    if cfg is None:
        return None
    if cfg.username and cfg.password:
        scheme, rest = cfg.server.split("://", 1)
        return f"{scheme}://{cfg.username}:{cfg.password}@{rest}"
    return cfg.server


def should_route_through_proxy(domain_or_url: str | None) -> bool:
    """Whether a domain/URL is one of the sites known to rate-limit/block by IP
    reputation, and should therefore go through the residential proxy pool."""
    if not domain_or_url:
        return False
    lower = domain_or_url.lower()
    return any(d in lower for d in RESIDENTIAL_DOMAINS)
