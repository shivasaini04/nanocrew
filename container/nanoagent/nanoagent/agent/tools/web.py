"""Web tools: web_search and web_fetch."""

import asyncio
import html
import json
import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

import httpx

from nanoagent.agent.tools import firecrawl_client, tinyfish_client
from nanoagent.agent.tools.base import Tool

logger = logging.getLogger("nanoagent.tools.web")

# Shared constants
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36"
MAX_REDIRECTS = 5  # Limit redirects to prevent DoS attacks

# Search-payload caps. `context.add_tool_result` appends a tool's return string to the
# model messages verbatim — nothing upstream bounds it (agent/context.py:325). A provider
# that hands back a 222 417-character description (measured on Firecrawl, 2026-08-29) would
# put every one of those characters into the context window and onto the cycle budget.
# Every provider's output goes through _format_results, so the cap lives there.
MAX_SNIPPET_CHARS = 1200
MAX_CONTENT_CHARS = 5000
MAX_SEARCH_RESULT_CHARS = 30000

# Batch fetch caps. A single-URL web_fetch may return 50 000 chars, but ten of those
# would be half a million — so a batch gets a tighter per-URL budget and its own ceiling.
MAX_BATCH_URLS = 20
MAX_BATCH_CHARS_PER_URL = 15000

# Below this many characters of extracted BODY text (title excluded), an HTML 200 is
# treated as a failed read and escalated to the browser. A client-rendered page returns a
# good <title> and an empty body, which is why the title cannot be counted here.
#
# 200 is deliberately low. The cost of being wrong in one direction is a wasted Playwright
# render; in the other it is an agent concluding a company has no team page. Real "this
# page is nearly empty" cases — a bare redirect stub, a one-line status page — sit well
# under it, and genuine content clears it in a sentence or two.
MIN_USEFUL_EXTRACTION_CHARS = 200

# Site-map caps. A map of a large site is thousands of URLs; the whole point of the tool
# is that discovery is one flat-rate call, so the cost to guard here is context, not
# credits. MAX_MAP_CONTENT_URLS bounds the optional read-along: TinyFish takes ten URLs
# per request, so ten is one batch and any more would be several.
MAX_MAP_URLS = 100
MAX_MAP_RESULT_CHARS = 20000
MAX_MAP_CONTENT_URLS = 10
MAX_MAP_CONTENT_CHARS = 6000
MAX_BATCH_TOTAL_CHARS = 60000


async def _request_with_retry(client: httpx.AsyncClient, method: str, url: str, max_retries: int = 3, **kwargs: Any) -> httpx.Response:
    """Execute httpx request with exponential backoff retries for transient errors."""
    delay = 1.0
    for attempt in range(max_retries):
        try:
            resp = await client.request(method, url, **kwargs)
            # If rate limited or server error, retry
            if resp.status_code in (429, 502, 503, 504) and attempt < max_retries - 1:
                logger.warning(
                    f"Transient HTTP {resp.status_code} for {method} {url}, retrying in {delay}s (attempt {attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(delay)
                delay *= 2.0
                continue
            return resp
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            if attempt < max_retries - 1:
                logger.warning(
                    f"Network error/timeout ({e.__class__.__name__}) for {method} {url}, retrying in {delay}s (attempt {attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(delay)
                delay *= 2.0
                continue
            raise
    # Final fallback attempt
    return await client.request(method, url, **kwargs)


def _strip_tags(text: str) -> str:
    """Remove HTML tags and decode entities."""
    text = re.sub(r'<script[\s\S]*?</script>', '', text, flags=re.I)
    text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    return html.unescape(text).strip()


def _normalize(text: str) -> str:
    """Normalize whitespace."""
    text = re.sub(r'[ \t]+', ' ', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def _as_payload(result: dict[str, Any]) -> str:
    """Serialise a fetch result, dropping the internal fields the model has no use for.

    `body_len` exists so the rungs can be compared against each other; it is bookkeeping
    about the fetch, not content, and putting it in front of the model would invite it to
    reason about our fallback ladder instead of about the page.
    """
    return json.dumps({k: v for k, v in result.items() if k != "body_len"}, ensure_ascii=False)


def _clip(text: str, limit: int) -> str:
    """Normalise whitespace and cut to `limit`, marking the cut so it is never silent."""
    text = _normalize(text or "")
    return text if len(text) <= limit else text[:limit] + " …[clipped]"


def _clean_domains(domains: list[str] | None) -> list[str]:
    """Keep only non-empty hostname strings; tolerate a model passing junk or None."""
    if not isinstance(domains, list):
        return []
    return [d.strip() for d in domains if isinstance(d, str) and d.strip()]


def _degrade_query(query: str, include_domains: list[str], exclude_domains: list[str]) -> str:
    """Fold domain filters into `site:` operators so a DDG fallback keeps that much intent.

    Recency and mode have no DuckDuckGo equivalent and are simply lost — the caller
    states that loss in the returned text rather than hiding it.
    """
    parts = [query]
    if include_domains:
        # DDG has no OR-of-sites operator, so only the first can be honoured.
        parts.append(f"site:{include_domains[0]}")
    parts.extend(f"-site:{d}" for d in exclude_domains)
    return " ".join(parts)


def _format_results(query: str, results: list[dict[str, Any]], provider: str) -> str:
    """Render provider results into the flat text shape every caller already expects.

    This is the single choke point where payload size is bounded — see the cap constants.
    """
    lines = [f"Results for: {query} (via {provider})\n"]
    total = len(lines[0])
    shown = 0

    for i, item in enumerate(results, 1):
        block = [f"{i}. {item.get('title') or '(untitled)'}\n   {item.get('url') or ''}"]
        if date := item.get("date"):
            block.append(f"   published: {date}")
        if snippet := _clip(item.get("snippet") or "", MAX_SNIPPET_CHARS):
            block.append(f"   {snippet}")
        if content := _clip(item.get("content") or "", MAX_CONTENT_CHARS):
            block.append(f"   --- content ---\n{content}")

        chunk = "\n".join(block)
        if total + len(chunk) > MAX_SEARCH_RESULT_CHARS and shown:
            lines.append(f"\n[{len(results) - shown} further result(s) omitted to stay within the context budget.]")
            break
        lines.append(chunk)
        total += len(chunk)
        shown += 1

    return "\n".join(lines)


def _validate_url(url: str) -> tuple[bool, str]:
    """Validate URL: must be http(s) with valid domain."""
    try:
        p = urlparse(url)
        if p.scheme not in ('http', 'https'):
            return False, f"Only http/https allowed, got '{p.scheme or 'none'}'"
        if not p.netloc:
            return False, "Missing domain"
        return True, ""
    except Exception as e:
        return False, str(e)


class WebSearchTool(Tool):
    """Search the web, routing across providers by which filters the caller asked for.

    Routing is on *requested capability*, not on a quality ranking.

    Corrected 2026-08-29 against live prod behaviour: this said "a plain query stays on
    DuckDuckGo", which was true of phase 1 and stopped being true in phase 2. TinyFish
    leads BOTH paths, plain queries included — not on preference but because it dates its
    results where DuckDuckGo and Firecrawl date none (stage46/06-tinyfish-measured.md).
    Verified in prod on the deployed image: a bare `web_search("what is retrieval
    augmented generation")` reports "via TinyFish". DuckDuckGo sits directly beneath as
    the no-account, no-quota safety net; Firecrawl keeps the pdf/developer categories and
    one-request search-with-content, which TinyFish has no equivalent for, and is reached
    sparingly because its keyless budget is capped per IP per day and shared by every
    agent on this host.

    See docs/research/stage46/04-decision.md.
    """

    name = "web_search"
    description = (
        "Search the web. Returns titles, URLs, snippets and, where the provider knows it, "
        "a publication date. Optional filters: recency, include_domains/exclude_domains, "
        "mode (news/research/pdf/developer), with_content. "
        "Prefer a plain query unless you actually need a filter."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "count": {"type": "integer", "description": "Results (1-10)", "minimum": 1, "maximum": 10},
            "recency": {
                "type": "string",
                "enum": ["hour", "day", "week", "month", "year"],
                "description": "Only return results published within this window.",
            },
            "include_domains": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Restrict results to these hostnames, e.g. ['news.ycombinator.com']. Cannot combine with exclude_domains.",
            },
            "exclude_domains": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Drop results from these hostnames. Cannot combine with include_domains.",
            },
            "mode": {
                "type": "string",
                "enum": ["web", "news", "research", "pdf", "developer"],
                "description": (
                    "web (default); news adds publisher dates; research restricts to academic "
                    "sites; pdf finds PDFs; developer searches issues, merged PRs and READMEs."
                ),
            },
            "with_content": {
                "type": "boolean",
                "description": (
                    "Also return each result's page content as markdown, in the same call. "
                    "Replaces a follow-up web_fetch per result. Costs more, so ask for it "
                    "only when you will actually read the pages."
                ),
            },
        },
        "required": ["query"]
    }

    def __init__(self, api_key: str | None = None, max_results: int = 5):
        self._init_api_key = api_key
        self.max_results = max_results

    @property
    def api_key(self) -> str:
        """Resolve API key at call time so env/config changes are picked up."""
        return self._init_api_key or os.environ.get("BRAVE_API_KEY", "")

    async def execute(
        self,
        query: str,
        count: int | None = None,
        recency: str | None = None,
        include_domains: list[str] | None = None,
        exclude_domains: list[str] | None = None,
        mode: str = "web",
        with_content: bool = False,
        **kwargs: Any,
    ) -> str:
        n = min(max(count or self.max_results, 1), 10)
        include_domains = _clean_domains(include_domains)
        exclude_domains = _clean_domains(exclude_domains)
        mode = (mode or "web").lower()

        filtered = bool(
            recency or include_domains or exclude_domains or with_content or mode != "web"
        )

        if filtered:
            return await self._filtered_search(
                query, n, recency, include_domains, exclude_domains, mode, with_content
            )
        return await self._plain_search(query, n)

    async def _filtered_search(
        self,
        query: str,
        n: int,
        recency: str | None,
        include_domains: list[str],
        exclude_domains: list[str],
        mode: str,
        with_content: bool,
    ) -> str:
        """Serve filters DuckDuckGo cannot express, and say so loudly if nothing can.

        TinyFish leads on measurement, not preference: on the same 7-day query it
        returned 5/5 results carrying dates and caught a one-day-old item that
        Firecrawl's `tbs=qdr:w` missed entirely (prod, 2026-08-29). It also costs
        nothing at any wallet balance, where keyless Firecrawl draws on a per-IP daily
        budget every agent on this host shares.

        Firecrawl still owns two things TinyFish has no equivalent for: the `pdf` and
        `developer` categories, and search-with-content in a single request.
        """
        failures: list[str] = []
        tinyfish_usable = tinyfish_client.is_configured() and tinyfish_client.supports_mode(mode)

        if tinyfish_usable and not with_content:
            try:
                results = await tinyfish_client.search(
                    query, n,
                    include_domains=include_domains, exclude_domains=exclude_domains,
                    recency=recency, mode=mode,
                )
                if results:
                    return _format_results(query, results, "TinyFish")
                failures.append("TinyFish returned no results")
            except tinyfish_client.TinyFishError as e:
                logger.warning(f"TinyFish filtered search failed: {e}")
                failures.append(str(e).rstrip("."))

        try:
            results = await firecrawl_client.search(
                query, n,
                include_domains=include_domains, exclude_domains=exclude_domains,
                recency=recency, mode=mode, with_content=with_content,
            )
            if results:
                return _format_results(query, results, "Firecrawl")
            failures.append("Firecrawl returned no results")
        except firecrawl_client.FirecrawlError as e:
            logger.warning(f"Firecrawl filtered search failed: {e}")
            failures.append(str(e).rstrip("."))  # already prefixed "Firecrawl: ..."

        # with_content asked for page text, and Firecrawl was the one-request way to get
        # it. TinyFish can still serve it in two — search, then batch-fetch the hits —
        # which beats dropping the caller back to snippet-only results.
        if with_content and tinyfish_usable:
            try:
                results = await self._tinyfish_search_with_content(
                    query, n, include_domains, exclude_domains, recency, mode
                )
                if results:
                    return _format_results(query, results, "TinyFish search + fetch")
            except tinyfish_client.TinyFishError as e:
                logger.warning(f"TinyFish search+fetch failed: {e}")
                failures.append(str(e).rstrip("."))

        note = (
            f"[Filters not applied — {'; '.join(failures) or 'no provider available'}. "
            f"Fell back to DuckDuckGo, which cannot filter by recency or mode. "
            f"Treat these results as unfiltered.]\n"
        )
        return note + await self._plain_search(
            _degrade_query(query, include_domains, exclude_domains), n
        )

    async def _tinyfish_search_with_content(
        self,
        query: str,
        n: int,
        include_domains: list[str],
        exclude_domains: list[str],
        recency: str | None,
        mode: str,
    ) -> list[dict[str, Any]]:
        """Search, then pull every hit's text in one batched fetch — two calls, not N+1."""
        limit = min(n, tinyfish_client.MAX_FETCH_URLS)
        results = await tinyfish_client.search(
            query, limit,
            include_domains=include_domains, exclude_domains=exclude_domains,
            recency=recency, mode=mode,
        )
        urls = [r["url"] for r in results if r.get("url")]
        if not urls:
            return results

        pages, errors = await tinyfish_client.fetch(urls)
        if errors:
            logger.warning(f"TinyFish batch fetch: {len(errors)} of {len(urls)} URLs failed")

        by_url = {p["url"]: p for p in pages}
        for r in results:
            if page := by_url.get(r["url"]):
                r["content"] = page.get("text") or ""
                # A fetched page often knows its publish date when the search row did not.
                r["date"] = r.get("date") or page.get("publishedDate") or ""
        return results

    async def _plain_search(self, query: str, n: int) -> str:
        """Unfiltered: Brave (keyed) -> TinyFish (keyed) -> DDG -> Firecrawl -> DDG HTML."""
        if self.api_key:
            res = await self._brave_search(query, n)
            if not res.startswith("Error"):
                return res
            logger.warning(f"Brave Search failed: {res}. Falling back to DuckDuckGo.")

        # TinyFish ahead of DuckDuckGo because it dates its results — 6 of 10 on a plain
        # measured query, where DDG and Firecrawl date none — and costs nothing to call.
        # DuckDuckGo stays directly underneath as the no-account, no-quota safety net.
        if tinyfish_client.is_configured():
            try:
                results = await tinyfish_client.search(query, n)
                if results:
                    return _format_results(query, results, "TinyFish")
            except tinyfish_client.TinyFishError as e:
                logger.warning(f"TinyFish search failed: {e}. Falling back to DuckDuckGo.")

        res = await self._ddgs_search(query, n)
        if not res.startswith("Error"):
            return res
        logger.warning(f"DuckDuckGo API search failed: {res}. Falling back to Firecrawl.")

        # Firecrawl sits ahead of the HTML scrape because the scrape is already dead from
        # this host: html.duckduckgo.com answers the prod IP with HTTP 202 and an anomaly
        # page that parses to zero results (measured 2026-08-29).
        try:
            results = await firecrawl_client.search(query, n)
            if results:
                return _format_results(query, results, "Firecrawl")
        except firecrawl_client.FirecrawlError as e:
            logger.warning(f"Firecrawl search failed: {e}. Falling back to DDG HTML scrape.")

        return await self._ddg_html_formatted(query, n)

    async def _brave_search(self, query: str, n: int) -> str:
        """Search using Brave Search API (paid, higher quality)."""
        try:
            async with httpx.AsyncClient() as client:
                r = await _request_with_retry(
                    client,
                    "GET",
                    # Through the orchestrator's key relay when it set one (stage 64 phase 2).
                    (os.environ.get("BRAVE_API_BASE", "").rstrip("/") or "https://api.search.brave.com/res/v1") + "/web/search",
                    params={"q": query, "count": n},
                    headers={"Accept": "application/json", "X-Subscription-Token": self.api_key},
                    timeout=10.0
                )
                r.raise_for_status()

            results = r.json().get("web", {}).get("results", [])
            if not results:
                return f"No results for: {query}"

            lines = [f"Results for: {query}\n"]
            for i, item in enumerate(results[:n], 1):
                lines.append(f"{i}. {item.get('title', '')}\n   {item.get('url', '')}")
                if desc := item.get("description"):
                    lines.append(f"   {desc}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error (Brave Search): {e}"

    async def _ddg_html_formatted(self, query: str, n: int) -> str:
        """Last resort: scrape the DuckDuckGo HTML endpoint directly.

        Whether this leg works depends entirely on where the request comes from.
        Measured 2026-08-29 with the identical request: HTTP 200 and 10 parsed results
        from a residential connection, HTTP 202 and an anomaly page — zero parseable
        results — from the prod datacenter IP. So it is a real fallback for a
        self-hosted NanoCrew and dead weight on a cloud host, and which one you have
        cannot be known from the code.

        That asymmetry is why a blocked scrape must not report "no results": on prod it
        would tell an agent the web has nothing on a subject when in fact every provider
        was unavailable.
        """
        try:
            html_results, status = await self._ddg_html_search(query, n)
            if not html_results:
                if status == 202:
                    return (
                        "Error (all search providers failed): DuckDuckGo's HTML endpoint "
                        "answered with an anomaly page (HTTP 202), which is what it returns "
                        "to datacenter IPs. This is NOT an empty result set — the query was "
                        "never run. Configure TINYFISH_API_KEY or FIRECRAWL_API_KEY."
                    )
                return f"No results for: {query}"

            lines = [f"Results for: {query} (HTML fallback)\n"]
            for i, item in enumerate(html_results[:n], 1):
                title = item.get("title", "")
                url = item.get("href", "")
                body = item.get("body", "")
                lines.append(f"{i}. {title}\n   {url}")
                if body:
                    lines.append(f"   {body}")
            return "\n".join(lines)
        except Exception as e:
            return (
                f"Error (all search providers failed): Brave key absent/failed, DDG API "
                f"failed, Firecrawl failed, DDG HTML failed ({e})"
            )

    async def _ddgs_search(self, query: str, n: int) -> str:
        """Search using DuckDuckGo (free, no API key needed)."""
        import asyncio
        try:
            # ddgs is synchronous, run in executor to avoid blocking
            def _search():
                from ddgs import DDGS
                with DDGS() as ddgs:
                    return list(ddgs.text(query, max_results=n))

            results = await asyncio.get_event_loop().run_in_executor(None, _search)

            if not results:
                return f"No results for: {query}"

            lines = [f"Results for: {query}\n"]
            for i, item in enumerate(results[:n], 1):
                title = item.get("title", "")
                url = item.get("href", item.get("link", ""))
                body = item.get("body", item.get("snippet", ""))
                lines.append(f"{i}. {title}\n   {url}")
                if body:
                    lines.append(f"   {body}")
            return "\n".join(lines)
        except ImportError:
            return (
                "Error: DuckDuckGo search library not installed. "
                "Install it with: pip install ddgs"
            )
        except Exception as e:
            return f"Error (DuckDuckGo): {e}"

    async def _ddg_html_search(self, query: str, n: int) -> tuple[list[dict[str, str]], int]:
        """Scrape the DuckDuckGo HTML site directly. Returns (results, http_status).

        The status comes back with the results because 202-with-no-results and
        200-with-no-results mean opposite things to the caller.
        """
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            r = await _request_with_retry(
                client,
                "GET",
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers=headers
            )
            r.raise_for_status()
            html_text = r.text
            status = r.status_code

        results = []
        result_blocks = re.findall(
            r'<div class="result results_links results_links_deep web-result\s*">([\s\S]*?)</div>\s*</div>',
            html_text
        )
        if not result_blocks:
            result_blocks = re.findall(
                r'<div class="result results_links[^"]*">([\s\S]*?)</div>\s*</div>',
                html_text
            )

        for block in result_blocks:
            title_match = re.search(r'<a class="result__a"[^>]*>([\s\S]*?)</a>', block)
            url_match = re.search(r'<a class="result__url"[^>]*href="([^"]*)"', block)
            snippet_match = re.search(r'<a class="result__snippet"[^>]*>([\s\S]*?)</a>', block)

            if title_match and url_match:
                title = _strip_tags(title_match.group(1))
                url = url_match.group(1)
                if url.startswith("//"):
                    url = "https:" + url
                snippet = _strip_tags(snippet_match.group(1)) if snippet_match else ""
                results.append({
                    "title": title,
                    "href": url,
                    "body": snippet
                })
                if len(results) >= n:
                    break
        return results, status


class WebFetchTool(Tool):
    """Fetch and extract content from a URL using Readability."""

    name = "web_fetch"
    description = (
        "Fetch a URL and extract readable content (HTML → markdown/text). "
        "Pass `urls` to fetch several in one call — much cheaper than one call per page. "
        "Falls back to a headless browser, then to Firecrawl, for pages that block scraping."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "The page to fetch, e.g. \"https://example.com/pricing\". Required unless you give `urls`."},
            "urls": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Fetch several URLs at once instead of calling this tool per URL. "
                    "Far cheaper: 5 URLs came back in a single 2.15s request. Use this "
                    "whenever you have more than one page to read."
                ),
            },
            "extractMode": {"type": "string", "enum": ["markdown", "text"], "default": "markdown"},
            "maxChars": {"type": "integer", "minimum": 100}
        },
        # Neither is individually required — exactly one of url/urls must be given, which
        # a JSON-Schema `required` list cannot express. execute() enforces it.
        "required": []
    }

    def __init__(self, max_chars: int = 50000):
        self.max_chars = max_chars

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        """Neither `url` nor `urls` is a schema error, answered with the call as it arrived.

        JSON Schema's `required` cannot say "one of these two", so this used to pass
        validation and fail inside execute() with a bare "needs `url`". Found live
        2026-09-29: an agent sent `{"maxChars": 4000}` four times in a row (14 output tokens
        each — the URL was never in the call), read the bare error as the platform
        "stripping" its url, and abandoned the tool for curl. Answered here instead, the
        registry adds what was sent and the parameter list, and this adds the exact shape.
        """
        errors = super().validate_params(params)
        url = params.get("url")
        urls = params.get("urls")
        has_url = isinstance(url, str) and url.strip() != ""
        has_urls = isinstance(urls, list) and any(isinstance(u, str) and u.strip() for u in urls)
        if not has_url and not has_urls:
            sent = json.dumps({k: v for k, v in params.items()}, ensure_ascii=False)[:200]
            errors.append(
                f"your call had no `url` — it arrived as {sent}. Put the address in the call "
                'itself, e.g. {"url": "https://example.com/page", "maxChars": 4000}, or '
                '{"urls": ["https://a.example", "https://b.example"]} for several pages'
            )
        return errors

    async def execute(
        self,
        url: str = "",
        extractMode: str = "markdown",
        maxChars: int | None = None,
        urls: list[str] | None = None,
        **kwargs: Any,
    ) -> str:
        max_chars = maxChars or self.max_chars

        batch = [u.strip() for u in (urls or []) if isinstance(u, str) and u.strip()]
        if url and url not in batch:
            batch.insert(0, url)
        if len(batch) > 1:
            return await self._batch_fetch(batch, extractMode, max_chars)
        if not url:
            if not batch:
                return json.dumps(
                    {"error": "web_fetch needs `url`, or `urls` for more than one page."},
                    ensure_ascii=False,
                )
            url = batch[0]

        # Validate URL before fetching
        is_valid, error_msg = _validate_url(url)
        if not is_valid:
            return json.dumps({"error": f"URL validation failed: {error_msg}", "url": url}, ensure_ascii=False)

        use_playwright_fallback = False
        error_details = ""
        status_code = 0
        r_json = None
        r_text = ""
        final_url = url
        ctype = ""

        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                max_redirects=MAX_REDIRECTS,
                timeout=30.0
            ) as client:
                r = await _request_with_retry(client, "GET", url, headers={"User-Agent": USER_AGENT})
                status_code = r.status_code
                final_url = str(r.url)
                ctype = r.headers.get("content-type", "")

                if r.status_code in (403, 429, 503) or r.status_code >= 400:
                    use_playwright_fallback = True
                    error_details = f"HTTP status {r.status_code}"
                else:
                    r.raise_for_status()
                    r_text = r.text
                    if "application/json" in ctype:
                        r_json = r.json()
        except Exception as e:
            use_playwright_fallback = True
            error_details = str(e)

        # Extract BEFORE deciding whether to escalate, so the decision can be made on what
        # we would actually hand back rather than on the status code alone.
        #
        # A 200 that extracts to nothing is a failure that looks like a success, and until
        # 2026-09-07 it was the one failure this ladder could not see: escalation fired
        # only on a >=400 status or an exception, so a client-rendered page came back as
        # its title and nothing else, status 200, no fallback attempted.
        #
        # Measured that day on Finder's a live cycle — web_map found infinit.com's
        # /about, /careers and /contact, and web_fetch returned 15 characters,
        # "# INFINIT.com", for all three. Playwright renders those pages; it was simply
        # never reached. Client-rendered marketing sites are most of the seed-to-Series-A
        # ICP Finder works, so this was the common case, not the edge one.
        extracted: dict[str, Any] | None = None
        if not use_playwright_fallback:
            try:
                extracted = self._extract(r_text, r_json, ctype, extractMode, max_chars)
            except Exception as e:
                use_playwright_fallback = True
                error_details = f"extraction failed: {e}"

        if extracted is not None and extracted["body_len"] < MIN_USEFUL_EXTRACTION_CHARS:
            # Only HTML escalates. JSON and plain text are legitimately short all the
            # time — an API returning `{"ok":true}` is a complete answer, and re-fetching
            # it in a browser would waste a page load to receive the same nine bytes.
            if "text/html" in ctype or extracted["extractor"] == "readability":
                use_playwright_fallback = True
                error_details = (
                    f"HTTP 200 but only {extracted['body_len']} chars of text extracted "
                    f"(likely client-rendered)"
                )

        if use_playwright_fallback:
            logger.warning(f"HTTP fetch failed for {url} ({error_details}). Falling back to Playwright browser fetch.")

            best: dict[str, Any] | None = None
            pw_err = ""
            try:
                best = await self._playwright_fetch(url, extractMode, max_chars)
            except Exception as e:
                pw_err = str(e)
                logger.error(f"Playwright fallback failed: {pw_err}")

            # Firecrawl runs when Playwright threw OR when it came back with nothing to
            # show for the render. A page Chromium *loads* but cannot extract is the same
            # failure as one it cannot load — it just costs more to discover, and until
            # this was added only the throwing half escalated. infinit.com/careers was
            # the case: rendered fine, 176 chars of body, and Firecrawl never consulted.
            #
            # Firecrawl stays last because it bills a credit and the two rungs above do
            # not, so a page either of them can read must never reach it.
            if best is None or best["body_len"] < MIN_USEFUL_EXTRACTION_CHARS:
                reason = pw_err or f"rendered but only {best['body_len']} chars of body text"
                try:
                    fc = await self._firecrawl_fetch(url, max_chars, error_details, reason)
                    # Keep whichever engine actually said more. Firecrawl is the more
                    # capable one but not automatically the better answer here, and
                    # discarding a real Playwright body because the next rung returned
                    # less would make escalating a downgrade.
                    if best is None or fc["body_len"] >= best["body_len"]:
                        best = fc
                except firecrawl_client.FirecrawlError as f_err:
                    logger.warning(f"Firecrawl scrape fallback failed: {f_err}")
                    # A thin Playwright result still beats an error. Only when there is
                    # nothing at all in hand is this a failed fetch.
                    if best is None:
                        return json.dumps(
                            {
                                "error": (
                                    f"HTTP fetch failed ({error_details}), Playwright fallback failed "
                                    f"({pw_err}), Firecrawl fallback failed ({f_err})"
                                ),
                                "url": url,
                            },
                            ensure_ascii=False
                        )

            return _as_payload(best)

        # The HTTP fetch succeeded and the extraction is already done — return it.
        if extracted is None:  # pragma: no cover — both branches above set it or escalate
            return json.dumps({"error": "nothing extracted", "url": url}, ensure_ascii=False)

        return _as_payload({
            "url": url,
            "finalUrl": final_url,
            "status": status_code,
            "extractor": extracted["extractor"],
            "truncated": extracted["truncated"],
            "length": len(extracted["text"]),
            "text": extracted["text"],
        })

    def _extract(
        self,
        r_text: str,
        r_json: Any,
        ctype: str,
        extract_mode: str,
        max_chars: int,
    ) -> dict[str, Any]:
        """Turn a fetched response into text, and report how much of it was real content.

        `body_len` measures the extracted body **without the title**, which is the whole
        point: a client-rendered page yields a perfectly good `<title>` and nothing else,
        so counting the title would score that page as a success. See the escalation
        check in `execute` for the cycle this was found on.
        """
        if "application/json" in ctype and r_json is not None:
            text = json.dumps(r_json, indent=2, ensure_ascii=False)
            body_len, extractor = len(text), "json"
        elif "text/html" in ctype or r_text[:256].lower().startswith(("<!doctype", "<html")):
            from readability import Document
            doc = Document(r_text)
            content = self._to_markdown(doc.summary()) if extract_mode == "markdown" else _strip_tags(doc.summary())
            title = doc.title()
            text = f"# {title}\n\n{content}" if title else content
            body_len, extractor = len(_normalize(content)), "readability"
        else:
            text = r_text
            body_len, extractor = len(text.strip()), "raw"

        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars]

        return {"text": text, "extractor": extractor, "truncated": truncated, "body_len": body_len}

    async def _batch_fetch(self, urls: list[str], extract_mode: str, max_chars: int) -> str:
        """Fetch many URLs at once — one TinyFish request per 10, or one-by-one without it.

        Measured 2026-08-29: 5 URLs through TinyFish were a single 2.15 s request
        returning ~55 k chars of clean markdown. The same 5 over plain httpx were 5
        separate requests and 1 456 982 chars of raw HTML before any extraction ran.
        """
        urls = urls[:MAX_BATCH_URLS]
        invalid = [(u, err) for u in urls for ok, err in [_validate_url(u)] if not ok]
        urls = [u for u in urls if u not in {bad for bad, _ in invalid}]

        pages: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = [{"url": u, "error": e} for u, e in invalid]

        if tinyfish_client.is_configured() and urls:
            try:
                for chunk in tinyfish_client.chunk_urls(urls):
                    got, errs = await tinyfish_client.fetch(chunk, fmt=extract_mode)
                    pages.extend(got)
                    errors.extend(errs)
                urls = []
            except tinyfish_client.TinyFishError as e:
                # Fall through to the per-URL path rather than failing the whole batch.
                logger.warning(f"TinyFish batch fetch failed: {e}. Fetching one at a time.")
                errors.append({"error": str(e)})

        # No TinyFish key, or it failed: the local path, one request per URL.
        for u in urls:
            single = await self.execute(url=u, extractMode=extract_mode, maxChars=max_chars)
            try:
                data = json.loads(single)
            except Exception:
                errors.append({"url": u, "error": "unparseable fetch result"})
                continue
            if data.get("error"):
                errors.append({"url": u, "error": data["error"]})
            else:
                pages.append({
                    "url": u,
                    "finalUrl": data.get("finalUrl") or u,
                    "title": "",
                    "publishedDate": "",
                    "text": data.get("text") or "",
                })

        per_url = min(max_chars, MAX_BATCH_CHARS_PER_URL)
        out: list[dict[str, Any]] = []
        total = 0
        for p in pages:
            text = p.get("text") or ""
            clipped = len(text) > per_url
            text = text[:per_url]
            if total + len(text) > MAX_BATCH_TOTAL_CHARS and out:
                errors.append({
                    "url": p.get("url"),
                    "error": "omitted: batch output would exceed the context budget",
                })
                continue
            total += len(text)
            out.append({
                "url": p.get("url"),
                "finalUrl": p.get("finalUrl"),
                "title": p.get("title"),
                "publishedDate": p.get("publishedDate"),
                "truncated": clipped,
                "length": len(text),
                "text": text,
            })

        return json.dumps({"count": len(out), "results": out, "errors": errors}, ensure_ascii=False)

    async def _firecrawl_fetch(self, url: str, max_chars: int, http_err: str, pw_err: str) -> dict[str, Any]:
        """Scrape one URL through Firecrawl once both local paths have come up short.

        `pw_err` is the reason Playwright did not settle it — a thrown error, or the body
        it managed to extract. Both are worth logging: "Playwright failed" alone sent
        someone hunting for a crash on a page that had rendered perfectly well.
        """
        logger.warning(f"Escalating {url} to Firecrawl scrape ({pw_err}).")
        data = await firecrawl_client.scrape(url)
        title, body = data["title"], data["markdown"]
        text = f"# {title}\n\n{body}" if title else body

        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars]

        return {
            "url": url,
            "finalUrl": data["finalUrl"],
            "status": data["status"],
            "extractor": "firecrawl",
            "truncated": truncated,
            "length": len(text),
            "text": text,
            "note": f"local fetch failed ({http_err}); Playwright: {pw_err}",
            # Title excluded, same rule as every other rung — see _extract.
            "body_len": len(_normalize(body)),
        }

    async def _playwright_fetch(self, url: str, extractMode: str, max_chars: int) -> dict[str, Any]:
        """Fetch URL using Playwright headless Chromium as a fallback to bypass anti-scraping.

        Returns the same shape as the other two rungs, `body_len` included, so the caller
        can compare what each engine actually produced instead of taking the first one
        that did not raise.
        """
        from playwright.async_api import async_playwright

        chromium_path = os.environ.get(
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
            os.environ.get("CHROME_PATH", "/usr/bin/chromium"),
        )

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                executable_path=chromium_path,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            try:
                page = await browser.new_page(
                    viewport={"width": 1280, "height": 720},
                    user_agent=USER_AGENT,
                )

                response = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                status_code = response.status if response else 200
                final_url = page.url
                html_content = await page.content()

                # Same extractor as the httpx leg, so "how much body did this produce"
                # means the same number on both and the two are actually comparable.
                got = self._extract(html_content, None, "text/html", extractMode, max_chars)

                return {
                    "url": url,
                    "finalUrl": final_url,
                    "status": status_code,
                    "extractor": "playwright_readability",
                    "truncated": got["truncated"],
                    "length": len(got["text"]),
                    "text": got["text"],
                    "body_len": got["body_len"],
                }
            finally:
                await browser.close()

    def _to_markdown(self, html: str) -> str:
        """Convert HTML to markdown."""
        # Convert links, headings, lists before stripping tags
        text = re.sub(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
                      lambda m: f'[{_strip_tags(m[2])}]({m[1]})', html, flags=re.I)
        text = re.sub(r'<h([1-6])[^>]*>([\s\S]*?)</h\1>',
                      lambda m: f'\n{"#" * int(m[1])} {_strip_tags(m[2])}\n', text, flags=re.I)
        text = re.sub(r'<li[^>]*>([\s\S]*?)</li>', lambda m: f'\n- {_strip_tags(m[1])}', text, flags=re.I)
        text = re.sub(r'</(p|div|section|article)>', '\n\n', text, flags=re.I)
        text = re.sub(r'<(br|hr)\s*/?>', '\n', text, flags=re.I)
        return _normalize(_strip_tags(text))


class WebMapTool(Tool):
    """Discover a site's URLs in one call, instead of guessing them or crawling to find them.

    Why this exists as its own tool rather than a `web_fetch` flag: "give me every address
    on this domain" is a different *shape* of answer from "give me this page", and folding
    it into a fetch would have made one tool return two unrelated things.

    Why map and not crawl. Firecrawl bills map flat-rate — one credit whether the site has
    ten pages or ten thousand — and crawl **per page**, against a 1 000/month plan. So the
    cheap composition is: map to find the few URLs that matter, then read those. This tool
    does the first half and, on request, the second half through TinyFish's batched fetch,
    which is free. `crawl()` exists in the client for the cases that genuinely need
    breadth-first reading; it is deliberately not wired to a tool, because an agent that
    reaches for it on a large site spends a month's credits before anyone can intervene.

    Content is a convenience here, not a ladder. When TinyFish cannot serve it the tool
    returns the URLs and says so, rather than reimplementing `web_fetch`'s httpx →
    Playwright → Firecrawl fallback — the agent already has that tool, and duplicating a
    fallback chain is how the two copies drift apart.
    """

    name = "web_map"
    # This text is the ONLY place the method reaches every agent automatically. A tool is
    # registered unconditionally for every agent of every user (loop.py
    # _register_default_tools), so what is written here ships with the code and needs no
    # per-agent prompt edit — which is the whole reason it carries the procedure and not
    # just a definition. Anything generic learned about this tool belongs here or in a
    # skill; an agent's own prompt is for what differs about THAT agent's job.
    description = (
        "List every URL on a website in one call — including pages the homepage does not "
        "link to and search engines have not indexed. Use it whenever you need a page "
        "whose address you do not know: team, about, pricing, careers, docs. "
        "Method: filter with `search`, ONE word at a time ('team', then 'about', then "
        "'leadership') — stacking words into one call dilutes the ranking and returns "
        "blog posts instead. Then web_fetch the one or two URLs that look right. "
        "Set with_content=true to read the top matches in the same call instead. "
        "Needs a real domain, so it cannot help when the company is unnamed."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Site to map, e.g. 'https://example.com'. Any page on the site works.",
            },
            "search": {
                "type": "string",
                "description": (
                    "ONE keyword to rank discovered URLs by, e.g. 'team', 'pricing', "
                    "'careers'. Strongly recommended — a bare map of a large site is "
                    "mostly noise. Use a single word: measured 2026-09-07, 'about' put "
                    "the real /about-us page first, while 'team leadership about' on the "
                    "same site returned blog posts instead. Run the tool again with a "
                    "different word rather than stacking words into one call."
                ),
            },
            "limit": {
                "type": "integer",
                "description": f"Max URLs to return (1-{MAX_MAP_URLS}). Default 30.",
                "minimum": 1,
                "maximum": MAX_MAP_URLS,
            },
            "with_content": {
                "type": "boolean",
                "description": (
                    f"Also fetch the text of the first {MAX_MAP_CONTENT_URLS} URLs. "
                    "Free (batched). Use when you already know the matches are what you want."
                ),
            },
            "include_subdomains": {
                "type": "boolean",
                "description": "Include subdomains such as careers.example.com. Default true.",
            },
        },
        "required": ["url"],
    }

    async def execute(
        self,
        url: str = "",
        search: str = "",
        limit: int = 30,
        with_content: bool = False,
        include_subdomains: bool = True,
        **kwargs: Any,
    ) -> str:
        if not url or not url.strip():
            return json.dumps({"error": "web_map needs a `url`."}, ensure_ascii=False)

        url = url.strip()
        ok, why = _validate_url(url)
        if not ok:
            return json.dumps({"error": f"Invalid url: {why}"}, ensure_ascii=False)

        # Fail with the fix in hand. Keyless Firecrawl answers /map with 401 (measured
        # 2026-08-29), so without a key this tool cannot work at all — and an agent told
        # only "401" would retry it, or quietly decide the site has no team page.
        if not firecrawl_client.api_key():
            return json.dumps(
                {
                    "error": (
                        "web_map needs FIRECRAWL_API_KEY — Firecrawl's keyless tier "
                        "refuses /map with 401. Ask the operator to set it. Until then, "
                        "use web_search with include_domains=['example.com'] instead, "
                        "which finds linked pages but not unlinked ones."
                    )
                },
                ensure_ascii=False,
            )

        n = max(1, min(int(limit or 30), MAX_MAP_URLS))
        try:
            links = await firecrawl_client.map_site(
                url, limit=n, search=search or None, include_subdomains=include_subdomains,
            )
        except firecrawl_client.FirecrawlError as e:
            logger.warning(f"web_map failed for {url}: {e}")
            return json.dumps({"error": str(e)}, ensure_ascii=False)

        if not links:
            hint = f" matching {search!r}" if search else ""
            return (
                f"No URLs found for {url}{hint}.\n"
                "[Firecrawl reached the site but discovered nothing. Try without `search`, "
                "or check the domain is right.]"
            )

        if with_content:
            links = await self._attach_content(links)

        return self._format(url, search, links)

    async def _attach_content(self, links: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Read the top URLs in one batched TinyFish request. Free, and one round trip.

        Failure here is not failure of the map. The URLs are the answer; content is the
        extra. So a TinyFish error is logged and noted in-band, never raised — the caller
        still gets the list it asked for.
        """
        if not tinyfish_client.is_configured():
            for item in links[:MAX_MAP_CONTENT_URLS]:
                item["content_note"] = "content unavailable (TinyFish not configured) — use web_fetch"
            return links

        head = [item for item in links[:MAX_MAP_CONTENT_URLS] if item.get("url")]
        try:
            pages, errors = await tinyfish_client.fetch([item["url"] for item in head])
        except tinyfish_client.TinyFishError as e:
            logger.warning(f"web_map content fetch failed: {e}")
            for item in head:
                item["content_note"] = f"content unavailable ({e}) — use web_fetch"
            return links

        if errors:
            logger.warning(f"web_map batch fetch: {len(errors)} of {len(head)} URLs failed")

        by_url = {p.get("url"): p for p in pages}
        for item in head:
            if page := by_url.get(item["url"]):
                item["content"] = page.get("text") or ""
        return links

    def _format(self, url: str, search: str, links: list[dict[str, Any]]) -> str:
        """Same shape and the same budget discipline as _format_results."""
        header = f"URLs on {url}"
        if search:
            header += f" matching {search!r}"
        header += f" — {len(links)} found (via Firecrawl map)\n"

        lines = [header]
        total = len(header)
        shown = 0

        for i, item in enumerate(links, 1):
            block = [f"{i}. {item.get('url') or ''}"]
            if title := item.get("title"):
                block.append(f"   {_clip(title, 200)}")
            if desc := item.get("description"):
                block.append(f"   {_clip(desc, MAX_SNIPPET_CHARS)}")
            if note := item.get("content_note"):
                block.append(f"   [{note}]")
            if content := _clip(item.get("content") or "", MAX_MAP_CONTENT_CHARS):
                block.append(f"   --- content ---\n{content}")

            chunk = "\n".join(block)
            if total + len(chunk) > MAX_MAP_RESULT_CHARS and shown:
                lines.append(
                    f"\n[{len(links) - shown} further URL(s) omitted to stay within the "
                    f"context budget. Narrow with `search`, or lower `limit`.]"
                )
                break
            lines.append(chunk)
            total += len(chunk)
            shown += 1

        return "\n".join(lines)
