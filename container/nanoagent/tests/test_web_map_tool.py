"""`web_map` — site-wide URL discovery through Firecrawl's map, plus the crawl client.

Three things are worth locking down, and they are not the same kind of thing.

**Spending.** Map bills flat-rate — one credit whether the site has ten pages or ten
thousand — and crawl bills *per page*, against a 1 000/month plan. Firecrawl's own crawl
default is 10 000 pages, which is ten months of the plan in a single call. The clamp in
`build_crawl_payload` is the only thing between an agent's `limit` and that bill, so it
is asserted directly rather than trusted to a comment.

**Context.** Same guard `_format_results` has, for the same reason: `add_tool_result`
appends a tool's return string to the model messages verbatim with no cap upstream. A map
of a large site is thousands of URLs.

**Degradation.** Content is an add-on here, not the answer. When TinyFish is absent or
fails, the URLs must still come back — the failure mode to avoid is an agent concluding a
company has no team page because the *content* leg broke.
"""

from __future__ import annotations

import json
import sys
import types

import pytest

# Same stand-in-package trick the sibling Firecrawl test uses: ``tools/__init__.py``
# eagerly re-exports ResearchTool, dragging in loguru and the whole provider stack.
# Everything under test here is pure httpx + stdlib.
if "nanoagent.agent.tools" not in sys.modules:
    import pathlib

    import nanoagent

    _tools = types.ModuleType("nanoagent.agent.tools")
    _tools.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "agent" / "tools")]
    sys.modules["nanoagent.agent.tools"] = _tools

from nanoagent.agent.tools import firecrawl_client, tinyfish_client, web  # noqa: E402
from nanoagent.agent.tools.firecrawl_client import FirecrawlError  # noqa: E402


# ---------------------------------------------------------------- map payload

def test_map_payload_carries_url_limit_and_subdomains():
    p = firecrawl_client.build_map_payload("https://example.com", 30)
    assert p["url"] == "https://example.com"
    assert p["limit"] == 30
    assert p["includeSubdomains"] is True
    # No search key at all rather than an empty one — Firecrawl treats "" as a filter.
    assert "search" not in p


def test_map_search_is_passed_through_when_given():
    p = firecrawl_client.build_map_payload("https://example.com", 10, search="team")
    assert p["search"] == "team"


def test_map_limit_is_clamped_not_rejected():
    # An agent asking for everything should get a big useful answer, not an error it has
    # to guess its way out of.
    p = firecrawl_client.build_map_payload("https://example.com", 999_999)
    assert p["limit"] == firecrawl_client.MAX_MAP_LIMIT


def test_map_rejects_nonsense_before_the_network_call():
    with pytest.raises(FirecrawlError, match="needs a url"):
        firecrawl_client.build_map_payload("", 10)
    with pytest.raises(FirecrawlError, match="at least 1"):
        firecrawl_client.build_map_payload("https://example.com", 0)


# ---------------------------------------------------------------- crawl payload

def test_crawl_limit_clamp_is_the_spending_guard():
    # THE test on this file. Firecrawl defaults crawl to 10 000 pages at one credit each;
    # the plan is 1 000/month. Without this clamp one tool call spends ten months.
    p = firecrawl_client.build_crawl_payload("https://example.com", 10_000)
    assert p["limit"] == firecrawl_client.MAX_CRAWL_LIMIT
    assert firecrawl_client.MAX_CRAWL_LIMIT <= 50


def test_crawl_payload_asks_for_main_content_markdown():
    p = firecrawl_client.build_crawl_payload("https://example.com", 5)
    assert p["scrapeOptions"] == {"formats": ["markdown"], "onlyMainContent": True}


def test_crawl_path_filters_are_omitted_unless_given():
    p = firecrawl_client.build_crawl_payload("https://example.com", 5)
    assert "includePaths" not in p and "excludePaths" not in p and "maxDiscoveryDepth" not in p

    p = firecrawl_client.build_crawl_payload(
        "https://example.com", 5,
        include_paths=["/blog/.*"], exclude_paths=["/tag/.*"], max_discovery_depth=2,
    )
    assert p["includePaths"] == ["/blog/.*"]
    assert p["excludePaths"] == ["/tag/.*"]
    assert p["maxDiscoveryDepth"] == 2


# ---------------------------------------------------------------- map parsing

async def test_map_site_normalises_object_links(monkeypatch):
    async def fake_post(path, payload, timeout):
        assert path == "/map"
        return {"success": True, "links": [
            {"url": "https://e.com/team", "title": "Team", "description": "Who we are"},
        ]}

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    out = await firecrawl_client.map_site("https://e.com")
    assert out == [{"url": "https://e.com/team", "title": "Team", "description": "Who we are"}]


async def test_map_site_still_works_if_the_response_degrades_to_bare_strings(monkeypatch):
    # v2 returns objects. If the shape moves under us, URLs-only beats nothing —
    # the URL is the part the caller actually needs.
    async def fake_post(path, payload, timeout):
        return {"success": True, "links": ["https://e.com/a", "https://e.com/b"]}

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    out = await firecrawl_client.map_site("https://e.com")
    assert [o["url"] for o in out] == ["https://e.com/a", "https://e.com/b"]


async def test_map_site_returns_empty_when_links_is_missing(monkeypatch):
    async def fake_post(path, payload, timeout):
        return {"success": True}

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    assert await firecrawl_client.map_site("https://e.com") == []


# ---------------------------------------------------------------- crawl lifecycle

async def test_crawl_polls_until_terminal_and_reports_what_it_billed(monkeypatch):
    polls = {"n": 0}

    async def fake_post(path, payload, timeout):
        return {"success": True, "id": "job-1"}

    async def fake_get(path, timeout):
        assert path == "/crawl/job-1"
        polls["n"] += 1
        if polls["n"] < 2:
            return {"status": "scraping", "completed": 1, "total": 3}
        return {
            "status": "completed", "completed": 3, "total": 3, "creditsUsed": 3,
            "data": [{"markdown": "# hi", "metadata": {"sourceURL": "https://e.com/a", "title": "A"}}],
        }

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    monkeypatch.setattr(firecrawl_client, "_get", fake_get)
    monkeypatch.setattr(firecrawl_client, "_CRAWL_POLL_INTERVAL", 0)

    out = await firecrawl_client.crawl("https://e.com", limit=3)
    assert polls["n"] == 2
    assert out["status"] == "completed"
    # Reported by Firecrawl, not counted from pages — a page that failed mid-crawl may
    # still have been billed.
    assert out["credits_used"] == 3
    assert out["pages"] == [{"url": "https://e.com/a", "title": "A", "markdown": "# hi"}]


async def test_crawl_that_outruns_its_deadline_returns_partial_pages(monkeypatch):
    # The credits are spent either way. Raising would throw away pages already paid for.
    async def fake_post(path, payload, timeout):
        return {"success": True, "id": "job-2"}

    async def fake_get(path, timeout):
        return {
            "status": "scraping", "completed": 1, "total": 9, "creditsUsed": 1,
            "data": [{"markdown": "partial", "metadata": {"sourceURL": "https://e.com/a"}}],
        }

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    monkeypatch.setattr(firecrawl_client, "_get", fake_get)
    monkeypatch.setattr(firecrawl_client, "_CRAWL_POLL_INTERVAL", 0)

    out = await firecrawl_client.crawl("https://e.com", limit=9, poll_timeout=0)
    assert out["status"] == "timed_out"
    assert len(out["pages"]) == 1
    assert out["credits_used"] == 1


async def test_crawl_failure_is_raised_not_returned_as_zero_pages(monkeypatch):
    # An empty page list and a failed job look identical to a caller that only reads
    # `pages`, and the difference decides whether retrying is sane.
    async def fake_post(path, payload, timeout):
        return {"success": True, "id": "job-3"}

    async def fake_get(path, timeout):
        return {"status": "failed", "error": "site unreachable"}

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    monkeypatch.setattr(firecrawl_client, "_get", fake_get)

    with pytest.raises(FirecrawlError, match="crawl failed"):
        await firecrawl_client.crawl("https://e.com")


async def test_crawl_without_a_job_id_fails_loudly(monkeypatch):
    async def fake_post(path, payload, timeout):
        return {"success": True}

    monkeypatch.setattr(firecrawl_client, "_post", fake_post)
    with pytest.raises(FirecrawlError, match="job id"):
        await firecrawl_client.crawl("https://e.com")


# ---------------------------------------------------------------- the tool

async def test_missing_key_names_the_fix_and_the_alternative(monkeypatch):
    # Keyless Firecrawl answers /map with 401. An agent told only "401" retries it, or
    # decides the site has no team page.
    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "")
    out = json.loads(await web.WebMapTool().execute(url="https://e.com"))
    assert "FIRECRAWL_API_KEY" in out["error"]
    assert "web_search" in out["error"]


async def test_bad_url_is_rejected_before_spending_a_credit(monkeypatch):
    called = {"n": 0}

    async def fake_map(*a, **k):
        called["n"] += 1
        return []

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)

    out = json.loads(await web.WebMapTool().execute(url="ftp://e.com"))
    assert "Invalid url" in out["error"]
    assert called["n"] == 0


async def test_empty_map_says_the_site_was_reached(monkeypatch):
    # "No URLs found" and "the request failed" are different facts and lead to different
    # next moves, so the tool must not render them identically.
    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")

    async def fake_map(*a, **k):
        return []

    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)
    out = await web.WebMapTool().execute(url="https://e.com", search="team")
    assert "No URLs found" in out and "reached the site" in out


async def test_tool_clamps_limit_to_its_own_ceiling(monkeypatch):
    seen = {}

    async def fake_map(url, *, limit, search, include_subdomains):
        seen["limit"] = limit
        return [{"url": "https://e.com/a", "title": "", "description": ""}]

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)

    await web.WebMapTool().execute(url="https://e.com", limit=10_000)
    assert seen["limit"] == web.MAX_MAP_URLS


async def test_with_content_uses_one_batched_tinyfish_request(monkeypatch):
    # The economics of the whole tool: map is one credit, TinyFish batch fetch is free.
    # N+1 single fetches would be the expensive way to get the same answer.
    calls = {"n": 0}

    async def fake_map(*a, **k):
        return [{"url": f"https://e.com/{i}", "title": "", "description": ""} for i in range(3)]

    async def fake_fetch(urls, **k):
        calls["n"] += 1
        calls["urls"] = urls
        return [{"url": u, "text": f"body of {u}"} for u in urls], []

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)
    monkeypatch.setattr(tinyfish_client, "is_configured", lambda: True)
    monkeypatch.setattr(tinyfish_client, "fetch", fake_fetch)

    out = await web.WebMapTool().execute(url="https://e.com", with_content=True)
    assert calls["n"] == 1
    assert len(calls["urls"]) == 3
    assert "body of https://e.com/0" in out


async def test_content_read_never_exceeds_one_tinyfish_batch(monkeypatch):
    # TinyFish rejects more than MAX_FETCH_URLS with a 400 rather than truncating, so
    # this cap is what keeps a big map from failing the content leg outright.
    async def fake_map(*a, **k):
        return [{"url": f"https://e.com/{i}", "title": "", "description": ""} for i in range(60)]

    seen = {}

    async def fake_fetch(urls, **k):
        seen["count"] = len(urls)
        return [], []

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)
    monkeypatch.setattr(tinyfish_client, "is_configured", lambda: True)
    monkeypatch.setattr(tinyfish_client, "fetch", fake_fetch)

    await web.WebMapTool().execute(url="https://e.com", with_content=True)
    assert seen["count"] <= web.MAX_MAP_CONTENT_URLS
    assert web.MAX_MAP_CONTENT_URLS <= tinyfish_client.MAX_FETCH_URLS


async def test_a_broken_content_leg_still_returns_the_urls(monkeypatch):
    # The failure to avoid: an agent concluding a company has no team page because the
    # optional content fetch fell over.
    async def fake_map(*a, **k):
        return [{"url": "https://e.com/team", "title": "Team", "description": ""}]

    async def boom(urls, **k):
        raise tinyfish_client.TinyFishError("TinyFish: rate limited")

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)
    monkeypatch.setattr(tinyfish_client, "is_configured", lambda: True)
    monkeypatch.setattr(tinyfish_client, "fetch", boom)

    out = await web.WebMapTool().execute(url="https://e.com", with_content=True)
    assert "https://e.com/team" in out
    assert "content unavailable" in out
    assert "web_fetch" in out  # names the tool that has the full fallback ladder


async def test_no_tinyfish_configured_is_a_note_not_a_crash(monkeypatch):
    async def fake_map(*a, **k):
        return [{"url": "https://e.com/team", "title": "Team", "description": ""}]

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", fake_map)
    monkeypatch.setattr(tinyfish_client, "is_configured", lambda: False)

    out = await web.WebMapTool().execute(url="https://e.com", with_content=True)
    assert "https://e.com/team" in out
    assert "TinyFish not configured" in out


async def test_firecrawl_error_is_surfaced_verbatim(monkeypatch):
    async def boom(*a, **k):
        raise FirecrawlError("Firecrawl (with an API key): out of credits.")

    monkeypatch.setattr(firecrawl_client, "api_key", lambda: "fc-test")
    monkeypatch.setattr(firecrawl_client, "map_site", boom)

    out = json.loads(await web.WebMapTool().execute(url="https://e.com"))
    assert "out of credits" in out["error"]


# ---------------------------------------------------------------- payload size

def test_map_output_is_capped_and_the_omission_is_stated():
    links = [
        {"url": f"https://e.com/{i}", "title": "t" * 300, "description": "d" * 2000}
        for i in range(200)
    ]
    out = web.WebMapTool()._format("https://e.com", "", links)
    assert len(out) < web.MAX_MAP_RESULT_CHARS + 5000
    assert "omitted to stay within the context budget" in out
    # The omission has to be actionable, not just honest.
    assert "search" in out and "limit" in out


def test_a_huge_page_body_is_clipped():
    links = [{"url": "https://e.com/a", "title": "A", "content": "x" * 500_000}]
    out = web.WebMapTool()._format("https://e.com", "", links)
    assert len(out) < web.MAX_MAP_RESULT_CHARS + 5000


# ---------------------------------------------------------------- wiring

def test_web_map_results_are_fenced_as_untrusted():
    # Titles and descriptions are written by whoever owns the mapped site. If web_map is
    # missing here, a page title is prompt-injection with a direct line to the model.
    from nanoagent.agent import security

    assert "web_map" in security.UNTRUSTED_RESULT_TOOLS
    assert "web_map" in security._ALL_KNOWN_BUILTIN_TOOLS


def test_web_map_is_registered_and_reachable_without_tool_search():
    # DEFERRED_TOOLS is on in prod, so a tool outside the core set exists but is only
    # reachable via tool_search — which is indistinguishable from not shipping it.
    import pathlib

    import nanoagent

    src = (pathlib.Path(nanoagent.__file__).parent / "agent" / "loop.py").read_text(encoding="utf-8")
    assert "self.tools.register(WebMapTool())" in src
    assert '"web_search", "web_fetch", "web_map", "url_check",' in src
