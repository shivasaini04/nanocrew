"""TinyFish client — keyed Search and Fetch.

TinyFish requires an API key but never charges for Search or Fetch: both are free at any
wallet balance including $0. That makes it the opposite trade to Firecrawl's keyless
endpoints, which need no account but draw on a per-IP daily budget shared by every agent
on this host. So when a key is configured TinyFish leads, and the unmetered providers sit
underneath it.

Measured from the prod host, 2026-08-29:

- Search returns a ``date`` on 2–5 of 5 plain web results. DuckDuckGo and Firecrawl
  return none. That is the single reason it leads the plain path — freshness you can see
  beats freshness you have to guess.
- ``recency_minutes=10080`` returned 5/5 dated results inside the window; Firecrawl's
  ``tbs=qdr:w`` on the same query returned 5 results with no dates and missed a
  one-day-old item TinyFish found.
- Fetch took 5 URLs in **one** request in 2.15 s and returned ~55 k chars of clean
  markdown. The same 5 URLs over plain httpx were 5 requests and 1 456 982 chars of raw
  HTML before any extraction.
- 20 sequential searches: all 200, no 429, and no rate-limit headers advertised. The
  published limit is "generous" and unquantified, so 429 is still handled.

See docs/research/stage46/06-tinyfish-measured.md.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("nanoagent.tools.tinyfish")

SEARCH_URL = "https://api.search.tinyfish.ai"
FETCH_URL = "https://api.fetch.tinyfish.ai"


def _search_url() -> str:
    """Through the orchestrator's key relay when it set one (stage 64 phase 2)."""
    return os.environ.get("TINYFISH_SEARCH_BASE", "").rstrip("/") or SEARCH_URL


def _fetch_url() -> str:
    return os.environ.get("TINYFISH_FETCH_BASE", "").rstrip("/") or FETCH_URL

#: Our shared `recency` enum, in the minutes TinyFish wants. The enum is the common
#: denominator across providers (Firecrawl only speaks in these buckets); TinyFish would
#: accept any integer, but a second, provider-specific recency parameter would be a knob
#: only one leg honours.
RECENCY_MINUTES = {
    "hour": 60,
    "day": 24 * 60,
    "week": 7 * 24 * 60,
    "month": 30 * 24 * 60,
    "year": 365 * 24 * 60,
}

#: Our `mode` enum mapped onto TinyFish's `domain_type`. `web` is the API default and is
#: sent as nothing at all.
_DOMAIN_TYPE = {
    "web": None,
    "news": "news",
    "research": "research_paper",
}

#: Modes TinyFish has no equivalent for — Firecrawl categories only.
UNSUPPORTED_MODES = frozenset({"pdf", "developer"})

#: Hard server-side cap; a longer list is rejected with a 400, not truncated.
MAX_FETCH_URLS = 10


class TinyFishError(RuntimeError):
    """TinyFish refused or failed the request. Carries a caller-safe message."""


def api_key() -> str:
    """Resolve the key at call time so env changes are picked up without a restart."""
    return os.environ.get("TINYFISH_API_KEY", "").strip()


def is_configured() -> bool:
    """Whether TinyFish can be used at all. Unlike Firecrawl there is no keyless mode."""
    return bool(api_key())


def supports_mode(mode: str) -> bool:
    return mode not in UNSUPPORTED_MODES


def _headers() -> dict[str, str]:
    return {"X-API-Key": api_key()}


def _explain(status: int, body: str) -> str:
    """Turn an HTTP failure into something an agent can act on."""
    if status == 401:
        return "TinyFish: key rejected. Check TINYFISH_API_KEY."
    if status == 429:
        return "TinyFish: rate limited."
    # Errors arrive as {"error": {"code", "message"}, "request_id"} — surface the message.
    return f"TinyFish: HTTP {status}. {body[:250]}"


def _unwrap(r: httpx.Response) -> dict[str, Any]:
    if r.status_code >= 400:
        raise TinyFishError(_explain(r.status_code, r.text))
    try:
        return r.json()
    except Exception as e:
        raise TinyFishError(f"TinyFish: response was not JSON ({e})") from e


def build_search_params(
    query: str,
    *,
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
    recency: str | None = None,
    mode: str = "web",
) -> dict[str, Any]:
    """Translate our tool-level parameters into a TinyFish search query string.

    Pure and separate from the HTTP call so the mapping is unit-testable without the
    network — the mapping is where the bugs are, not the transport.
    """
    if include_domains and exclude_domains:
        raise TinyFishError(
            "TinyFish: include_domains and exclude_domains are mutually exclusive."
        )
    if mode in UNSUPPORTED_MODES:
        raise TinyFishError(f"TinyFish: mode {mode!r} has no equivalent; use Firecrawl.")
    if mode not in _DOMAIN_TYPE:
        raise TinyFishError(f"TinyFish: unknown mode {mode!r}.")
    if recency and recency not in RECENCY_MINUTES:
        raise TinyFishError(
            f"TinyFish: unknown recency {recency!r}; expected one of {sorted(RECENCY_MINUTES)}."
        )

    params: dict[str, Any] = {"query": query, "location": "US", "language": "en"}

    if domain_type := _DOMAIN_TYPE[mode]:
        params["domain_type"] = domain_type
    if recency:
        # Not valid on research_paper — the API scopes those by publication year instead,
        # and sending both is a 4xx rather than a silently ignored parameter.
        if mode == "research":
            raise TinyFishError(
                "TinyFish: recency is not supported with mode='research'."
            )
        params["recency_minutes"] = RECENCY_MINUTES[recency]
    if include_domains:
        params["include_domains"] = ",".join(include_domains)
    if exclude_domains:
        params["exclude_domains"] = ",".join(exclude_domains)

    return params


async def search(
    query: str,
    limit: int,
    *,
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
    recency: str | None = None,
    mode: str = "web",
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    """Run a TinyFish search, returning normalised result dicts.

    The API has no result-count parameter — it returns a page and you take what you need —
    so `limit` is applied client-side.
    """
    params = build_search_params(
        query,
        include_domains=include_domains, exclude_domains=exclude_domains,
        recency=recency, mode=mode,
    )
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(_search_url(), params=params, headers=_headers(), timeout=timeout)
    except Exception as e:
        raise TinyFishError(f"TinyFish: {e.__class__.__name__}: {e}") from e

    body = _unwrap(r)
    out: list[dict[str, Any]] = []
    for item in (body.get("results") or [])[:limit]:
        if not isinstance(item, dict):
            continue
        out.append({
            "title": item.get("title") or "",
            "url": item.get("url") or "",
            "snippet": item.get("snippet") or "",
            # Undocumented in the API reference but present in practice, often relative
            # ("7 days ago"). It is the reason this provider leads the plain path.
            "date": item.get("date") or "",
            "content": "",
        })
    return out


async def fetch(
    urls: list[str],
    *,
    fmt: str = "markdown",
    timeout: float = 120.0,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Fetch up to MAX_FETCH_URLS URLs in one request. Returns (results, errors).

    Per-URL failures come back in `errors` rather than sinking the batch, so a caller
    gets the four pages that worked instead of nothing.
    """
    if not urls:
        return [], []
    if len(urls) > MAX_FETCH_URLS:
        raise TinyFishError(
            f"TinyFish: at most {MAX_FETCH_URLS} URLs per fetch, got {len(urls)}."
        )

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                _fetch_url(), json={"urls": urls, "format": fmt},
                headers=_headers(), timeout=timeout,
            )
    except Exception as e:
        raise TinyFishError(f"TinyFish: {e.__class__.__name__}: {e}") from e

    body = _unwrap(r)
    results = []
    for item in body.get("results") or []:
        if not isinstance(item, dict):
            continue
        results.append({
            "url": item.get("url") or "",
            "finalUrl": item.get("final_url") or item.get("url") or "",
            "title": item.get("title") or "",
            "publishedDate": item.get("published_date") or "",
            "text": item.get("text") or "",
        })
    return results, list(body.get("errors") or [])


def chunk_urls(urls: list[str]) -> list[list[str]]:
    """Split a URL list into server-legal batches."""
    return [urls[i:i + MAX_FETCH_URLS] for i in range(0, len(urls), MAX_FETCH_URLS)]
