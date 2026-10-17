"""Firecrawl v2 client — keyless-capable search and scrape.

Firecrawl serves ``/v2/search`` and ``/v2/scrape`` without an API key. That access is
gated on IP reputation and capped **per IP per day** by an unpublished request and
credit budget, so it is a fallback leg, never the only one. Setting
``FIRECRAWL_API_KEY`` moves us onto our own team bucket (1 000 credits/month free)
and is strictly preferred; the key is optional purely so the keyless path keeps
working when nobody has configured one.

Measured 2026-08-29 from the prod host: search 200, scrape 200, map 401, crawl 401.
The same unauthenticated search returned 403 "your IP address looks suspicious" from a
residential connection the same day — treat availability as unreliable by design.

See docs/research/stage46/02-firecrawl.md.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger("nanoagent.tools.firecrawl")

BASE_URL = "https://api.firecrawl.dev/v2"


def _base_url() -> str:
    """The orchestrator's key relay when it set one (stage 64 phase 2), else Firecrawl itself.

    The relay only sets FIRECRAWL_API_BASE when a key exists, so the keyless tier still
    goes straight to Firecrawl."""
    return os.environ.get("FIRECRAWL_API_BASE", "").rstrip("/") or BASE_URL

#: Predefined recency windows, mapped to Firecrawl's Google-style ``tbs`` grammar.
RECENCY_TBS = {
    "hour": "qdr:h",
    "day": "qdr:d",
    "week": "qdr:w",
    "month": "qdr:m",
    "year": "qdr:y",
}

#: ``mode`` values that select a Firecrawl *source* rather than a category.
_SOURCE_MODES = {"web", "news"}
#: ``mode`` values that select a Firecrawl *category* (still a web-source search).
_CATEGORY_MODES = {"research", "pdf", "developer"}

#: Ceiling on URLs one map may return. Firecrawl's own default is 5 000 — a number sized
#: for a data pipeline, not for a tool call whose result is pasted into a context window
#: and paid for by the cycle. Map bills flat-rate, so this bounds reading, not spending.
MAX_MAP_LIMIT = 500

#: Ceiling on pages one crawl may fetch. Unlike map, crawl bills **one credit per page**
#: against a 1 000/month plan, so a single unbounded call can spend a third of the month
#: before anyone sees it. This is the most an agent may spend without being asked.
MAX_CRAWL_LIMIT = 50

#: Crawl is a job, not a request: the POST returns an id and the pages land later.
_CRAWL_POLL_INTERVAL = 3.0
_CRAWL_POLL_TIMEOUT = 240.0

#: Job states that mean no more pages are coming.
_CRAWL_TERMINAL = frozenset({"completed", "failed", "cancelled"})


class FirecrawlError(RuntimeError):
    """Firecrawl refused or failed the request. Carries a caller-safe message."""


def api_key() -> str:
    """Resolve the key at call time so env changes are picked up without a restart."""
    return os.environ.get("FIRECRAWL_API_KEY", "").strip()


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    key = api_key()
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _explain_status(status: int, body: str) -> str:
    """Turn an HTTP failure into something an agent can act on."""
    keyed = "with an API key" if api_key() else "keyless"
    if status == 402:
        return f"Firecrawl ({keyed}): out of credits."
    if status == 403:
        return (
            f"Firecrawl ({keyed}): refused this IP. Keyless access is IP-reputation "
            f"gated; set FIRECRAWL_API_KEY to bypass. {body[:200]}"
        )
    if status == 429:
        return (
            f"Firecrawl ({keyed}): rate limited. Keyless is capped per IP per day and "
            f"every agent on this host shares that budget."
        )
    return f"Firecrawl ({keyed}): HTTP {status}. {body[:200]}"


async def _post(path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """POST to Firecrawl and unwrap the envelope, raising FirecrawlError on failure."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{_base_url()}{path}", json=payload, headers=_headers(), timeout=timeout
            )
    except Exception as e:  # network, DNS, timeout
        raise FirecrawlError(f"Firecrawl: {e.__class__.__name__}: {e}") from e

    if r.status_code >= 400:
        raise FirecrawlError(_explain_status(r.status_code, r.text))

    try:
        body = r.json()
    except Exception as e:
        raise FirecrawlError(f"Firecrawl: response was not JSON ({e})") from e

    if not body.get("success"):
        raise FirecrawlError(f"Firecrawl: {body.get('error') or 'request failed'}")
    return body


async def _get(path: str, timeout: float) -> dict[str, Any]:
    """GET a Firecrawl endpoint and return the parsed body.

    Mirrors ``_post``'s transport and error handling, but does **not** require
    ``success`` — a crawl still running is a legitimate answer to a status poll, and
    treating "not finished yet" as a failure would throw away the pages already done.
    """
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{_base_url()}{path}", headers=_headers(), timeout=timeout)
    except Exception as e:  # network, DNS, timeout
        raise FirecrawlError(f"Firecrawl: {e.__class__.__name__}: {e}") from e

    if r.status_code >= 400:
        raise FirecrawlError(_explain_status(r.status_code, r.text))

    try:
        return r.json()
    except Exception as e:
        raise FirecrawlError(f"Firecrawl: response was not JSON ({e})") from e


def build_search_payload(
    query: str,
    limit: int,
    *,
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
    recency: str | None = None,
    mode: str = "web",
    with_content: bool = False,
) -> dict[str, Any]:
    """Translate our tool-level parameters into a Firecrawl /v2/search body.

    Kept pure and separate from the HTTP call so the mapping is unit-testable without
    touching the network — the mapping is where the bugs live, not the transport.
    """
    if include_domains and exclude_domains:
        raise FirecrawlError(
            "Firecrawl: include_domains and exclude_domains are mutually exclusive."
        )
    if mode not in _SOURCE_MODES | _CATEGORY_MODES:
        raise FirecrawlError(f"Firecrawl: unknown mode {mode!r}.")
    if recency and recency not in RECENCY_TBS:
        raise FirecrawlError(
            f"Firecrawl: unknown recency {recency!r}; expected one of {sorted(RECENCY_TBS)}."
        )

    payload: dict[str, Any] = {
        "query": query,
        "limit": limit,
        # Highlights are query-relevant excerpts generated per result and are NOT length
        # bounded — one measured result carried a 222 417-character description. We want
        # predictable, DDG-shaped snippets here; real page text is what with_content is for.
        "highlights": False,
    }

    payload["sources"] = ["news"] if mode == "news" else ["web"]
    if mode in _CATEGORY_MODES:
        payload["categories"] = [mode]

    if recency:
        # `news` results already carry a publisher date; tbs is a web-source filter.
        payload["tbs"] = RECENCY_TBS[recency]
    if include_domains:
        payload["includeDomains"] = include_domains
    if exclude_domains:
        payload["excludeDomains"] = exclude_domains
    if with_content:
        payload["scrapeOptions"] = {"formats": [{"type": "markdown"}]}

    return payload


async def search(
    query: str,
    limit: int,
    *,
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
    recency: str | None = None,
    mode: str = "web",
    with_content: bool = False,
    timeout: float = 90.0,
) -> list[dict[str, Any]]:
    """Run a Firecrawl search and return a flat list of normalised result dicts.

    Each dict carries ``title``, ``url``, ``snippet``, and optionally ``date`` (news)
    and ``content`` (when ``with_content``). Values are unbounded here on purpose —
    the caller truncates, because only the caller knows its context budget.
    """
    payload = build_search_payload(
        query, limit,
        include_domains=include_domains, exclude_domains=exclude_domains,
        recency=recency, mode=mode, with_content=with_content,
    )
    body = await _post("/search", payload, timeout)
    data = body.get("data") or {}

    # Response arrays are keyed by source. `news` results live under "news", everything
    # else under "web"; take both so a mode change can never silently return nothing.
    raw: list[dict[str, Any]] = []
    for bucket in ("web", "news"):
        items = data.get(bucket)
        if isinstance(items, list):
            raw.extend(items)

    results: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        # A result can arrive with metadata.statusCode 500 and "all scraping engines
        # failed" while still carrying a perfectly good title/snippet/date. Partial
        # failure is in-band, so never drop a result for having a broken metadata block.
        results.append({
            "title": item.get("title") or "",
            "url": item.get("url") or "",
            "snippet": item.get("description") or item.get("snippet") or "",
            "date": item.get("date") or "",
            "content": (item.get("markdown") or "") if with_content else "",
        })
    return results


async def scrape(url: str, timeout: float = 90.0) -> dict[str, Any]:
    """Scrape one URL to markdown via Firecrawl's stealth engines.

    Used only after our own httpx and Playwright paths have both failed — Firecrawl
    gets past anti-bot defences they cannot, but it costs credits and they do not.
    """
    body = await _post(
        "/scrape", {"url": url, "formats": ["markdown"], "onlyMainContent": True}, timeout
    )
    data = body.get("data") or {}
    meta = data.get("metadata") or {}
    return {
        "markdown": data.get("markdown") or "",
        "title": meta.get("title") or "",
        "finalUrl": meta.get("sourceURL") or url,
        "status": meta.get("statusCode") or 200,
    }


def build_map_payload(
    url: str,
    limit: int,
    *,
    search: str | None = None,
    include_subdomains: bool = True,
) -> dict[str, Any]:
    """Translate our map parameters into a Firecrawl /v2/map body.

    Pure and separately testable for the same reason ``build_search_payload`` is: the
    mapping is where the bugs live, not the transport.
    """
    if not url:
        raise FirecrawlError("Firecrawl: map needs a url.")
    if limit < 1:
        raise FirecrawlError(f"Firecrawl: map limit must be at least 1, got {limit}.")

    payload: dict[str, Any] = {
        "url": url,
        # Clamped rather than rejected: an agent asking for everything should get a big
        # useful answer, not an error it has to guess its way out of.
        "limit": min(limit, MAX_MAP_LIMIT),
        "includeSubdomains": include_subdomains,
    }
    if search:
        payload["search"] = search
    return payload


async def map_site(
    url: str,
    *,
    limit: int = 100,
    search: str | None = None,
    include_subdomains: bool = True,
    timeout: float = 90.0,
) -> list[dict[str, Any]]:
    """Enumerate the URLs Firecrawl can find on a site. **One credit, whatever the size.**

    This is the cheap half of site-wide work: map discovers addresses, crawl reads pages.
    Because discovery is flat-rate and reading is per-page, mapping first and then
    fetching only the handful of pages that matter is both cheaper and better targeted
    than crawling — which is why the tool layer leads with this.

    ``search`` is a server-side relevance filter over the discovered URLs. It is what
    makes "find this company's team page" one call instead of a crawl.

    Requires a key: the keyless tier answers /map with 401 (measured 2026-08-29).
    """
    payload = build_map_payload(
        url, limit, search=search, include_subdomains=include_subdomains
    )
    body = await _post("/map", payload, timeout)

    links = body.get("links")
    if not isinstance(links, list):
        return []

    out: list[dict[str, Any]] = []
    for item in links:
        if isinstance(item, dict) and item.get("url"):
            out.append({
                "url": item.get("url") or "",
                "title": item.get("title") or "",
                "description": item.get("description") or "",
            })
        elif isinstance(item, str) and item:
            # v2 returns objects. Older shapes returned bare strings, and a response that
            # moves under us should degrade to URLs-only rather than to nothing.
            out.append({"url": item, "title": "", "description": ""})
    return out


def build_crawl_payload(
    url: str,
    limit: int,
    *,
    include_paths: list[str] | None = None,
    exclude_paths: list[str] | None = None,
    max_discovery_depth: int | None = None,
) -> dict[str, Any]:
    """Translate our crawl parameters into a Firecrawl /v2/crawl body."""
    if not url:
        raise FirecrawlError("Firecrawl: crawl needs a url.")
    if limit < 1:
        raise FirecrawlError(f"Firecrawl: crawl limit must be at least 1, got {limit}.")

    payload: dict[str, Any] = {
        "url": url,
        # The clamp that matters. Firecrawl defaults this to 10 000; at one credit per
        # page that is ten months of the plan in a single call.
        "limit": min(limit, MAX_CRAWL_LIMIT),
        "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
    }
    if include_paths:
        payload["includePaths"] = include_paths
    if exclude_paths:
        payload["excludePaths"] = exclude_paths
    if max_discovery_depth is not None:
        payload["maxDiscoveryDepth"] = max_discovery_depth
    return payload


async def crawl(
    url: str,
    *,
    limit: int = 20,
    include_paths: list[str] | None = None,
    exclude_paths: list[str] | None = None,
    max_discovery_depth: int | None = None,
    poll_timeout: float = _CRAWL_POLL_TIMEOUT,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Crawl a site and return its pages' markdown. **Bills one credit per page.**

    Returns ``{"pages", "credits_used", "status", "completed", "total"}``.

    A crawl still running when ``poll_timeout`` expires returns whatever finished, with
    ``status`` saying so, rather than raising. Partial pages are worth more than an
    error — and the credits are spent either way, so throwing them away would be the
    strictly worse outcome. The caller is told the status so it can say so too.
    """
    payload = build_crawl_payload(
        url, limit,
        include_paths=include_paths, exclude_paths=exclude_paths,
        max_discovery_depth=max_discovery_depth,
    )
    started = await _post("/crawl", payload, timeout)
    job_id = started.get("id")
    if not job_id:
        raise FirecrawlError("Firecrawl: crawl did not return a job id.")

    deadline = time.monotonic() + poll_timeout
    body: dict[str, Any] = {}
    status = "unknown"
    while True:
        body = await _get(f"/crawl/{job_id}", timeout)
        status = str(body.get("status") or "unknown")
        if status in _CRAWL_TERMINAL or time.monotonic() >= deadline:
            break
        await asyncio.sleep(_CRAWL_POLL_INTERVAL)

    if status == "failed":
        raise FirecrawlError(f"Firecrawl: crawl failed. {str(body.get('error') or '')[:200]}")

    pages: list[dict[str, Any]] = []
    for item in body.get("data") or []:
        if not isinstance(item, dict):
            continue
        meta = item.get("metadata") or {}
        pages.append({
            "url": meta.get("sourceURL") or meta.get("url") or "",
            "title": meta.get("title") or "",
            "markdown": item.get("markdown") or "",
        })

    return {
        "pages": pages,
        # Firecrawl reports what it actually billed. Report it rather than counting pages
        # ourselves — a page that failed mid-crawl is still a page we may have paid for.
        "credits_used": body.get("creditsUsed") or 0,
        "status": "timed_out" if status not in _CRAWL_TERMINAL else status,
        "completed": body.get("completed") or len(pages),
        "total": body.get("total") or len(pages),
    }
