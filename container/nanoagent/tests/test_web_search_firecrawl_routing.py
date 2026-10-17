"""Stage 46 Phase 1: Firecrawl behind web_search / web_fetch.

Two things are worth locking down here.

**Routing.** Firecrawl's keyless budget is capped per IP per day, and every agent
container on this host egresses through one IP, so they all share it. A plain query
therefore must NOT reach Firecrawl — it stays on DuckDuckGo, which is free, unmetered,
and measured competitive (2026-08-29: DDG beat Firecrawl outright on a recency-sensitive
query). Firecrawl is reached only for filters DDG cannot express, or after DDG has failed.

**Payload size.** `context.add_tool_result` appends a tool's return string to the model
messages verbatim, with no cap anywhere upstream. A single measured Firecrawl result
carried a 222 417-character description. If `_format_results` stops truncating, that lands
in the context window and on the cycle budget.
"""

from __future__ import annotations

import json
import sys
import types

import httpx
import pytest

# ``nanoagent/agent/tools/__init__.py`` eagerly re-exports ResearchTool, which drags in
# loguru and the provider stack. Same trick conftest.py uses for ``nanoagent.agent`` and
# test_litellm_streaming_retry.py uses for ``nanoagent.providers``: register a stand-in
# package with the same __path__ so the leaf modules resolve on their own. Both modules
# under test are pure httpx + stdlib, so nothing real is being mocked away here.
if "nanoagent.agent.tools" not in sys.modules:
    import pathlib

    import nanoagent

    _tools = types.ModuleType("nanoagent.agent.tools")
    _tools.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "agent" / "tools")]
    sys.modules["nanoagent.agent.tools"] = _tools

from nanoagent.agent.tools import firecrawl_client, web  # noqa: E402
from nanoagent.agent.tools.firecrawl_client import FirecrawlError  # noqa: E402


# ---------------------------------------------------------------- payload mapping

def test_plain_payload_asks_for_web_and_disables_highlights():
    p = firecrawl_client.build_search_payload("agents", 5)
    assert p["query"] == "agents"
    assert p["limit"] == 5
    assert p["sources"] == ["web"]
    # Highlights are unbounded per-result excerpts — this False is the 222k-char guard.
    assert p["highlights"] is False
    assert "scrapeOptions" not in p
    assert "tbs" not in p


@pytest.mark.parametrize(
    "recency,tbs",
    [("hour", "qdr:h"), ("day", "qdr:d"), ("week", "qdr:w"), ("month", "qdr:m"), ("year", "qdr:y")],
)
def test_recency_maps_to_firecrawl_tbs_grammar(recency, tbs):
    assert firecrawl_client.build_search_payload("q", 3, recency=recency)["tbs"] == tbs


def test_news_mode_selects_the_news_source_not_a_category():
    p = firecrawl_client.build_search_payload("q", 3, mode="news")
    assert p["sources"] == ["news"]
    assert "categories" not in p


@pytest.mark.parametrize("mode", ["research", "pdf", "developer"])
def test_category_modes_stay_on_the_web_source(mode):
    p = firecrawl_client.build_search_payload("q", 3, mode=mode)
    assert p["sources"] == ["web"]
    assert p["categories"] == [mode]


def test_domain_filters_are_passed_through():
    p = firecrawl_client.build_search_payload("q", 3, include_domains=["news.ycombinator.com"])
    assert p["includeDomains"] == ["news.ycombinator.com"]
    p = firecrawl_client.build_search_payload("q", 3, exclude_domains=["pinterest.com"])
    assert p["excludeDomains"] == ["pinterest.com"]


def test_include_and_exclude_domains_are_mutually_exclusive():
    with pytest.raises(FirecrawlError, match="mutually exclusive"):
        firecrawl_client.build_search_payload("q", 3, include_domains=["a.com"], exclude_domains=["b.com"])


def test_with_content_requests_markdown_inline():
    p = firecrawl_client.build_search_payload("q", 3, with_content=True)
    assert p["scrapeOptions"] == {"formats": [{"type": "markdown"}]}


@pytest.mark.parametrize("bad", [{"mode": "sideways"}, {"recency": "fortnight"}])
def test_unknown_enum_values_are_rejected_before_the_network_call(bad):
    with pytest.raises(FirecrawlError):
        firecrawl_client.build_search_payload("q", 3, **bad)


# ---------------------------------------------------------------- payload size

def test_a_huge_snippet_is_clipped():
    out = web._format_results("q", [{"title": "t", "url": "u", "snippet": "x" * 222_417}], "Firecrawl")
    assert len(out) < web.MAX_SEARCH_RESULT_CHARS
    assert "[clipped]" in out


def test_total_output_is_capped_and_the_omission_is_stated():
    results = [
        {"title": f"t{i}", "url": f"https://e.com/{i}", "snippet": "y" * web.MAX_SNIPPET_CHARS}
        for i in range(200)
    ]
    out = web._format_results("q", results, "Firecrawl")
    assert len(out) <= web.MAX_SEARCH_RESULT_CHARS + web.MAX_SNIPPET_CHARS + 200
    assert "omitted to stay within the context budget" in out


def test_at_least_one_result_survives_even_when_it_alone_busts_the_cap():
    out = web._format_results("q", [{"title": "t", "url": "u", "content": "z" * 10_000_000}], "Firecrawl")
    assert "https" in out or "t" in out
    assert "omitted" not in out


def test_news_dates_are_surfaced():
    out = web._format_results("q", [{"title": "t", "url": "u", "date": "Jun 10, 2026"}], "Firecrawl")
    assert "published: Jun 10, 2026" in out


# ---------------------------------------------------------------- degradation

def test_domain_filters_degrade_to_site_operators():
    assert _has_all(web._degrade_query("hiring", ["yc.com"], []), ["hiring", "site:yc.com"])
    assert _has_all(web._degrade_query("hiring", [], ["a.com", "b.com"]), ["-site:a.com", "-site:b.com"])


def test_junk_domain_lists_do_not_crash_the_router():
    assert web._clean_domains(None) == []
    assert web._clean_domains("not-a-list") == []
    assert web._clean_domains([" a.com ", "", 7, None]) == ["a.com"]


def _has_all(text: str, parts: list[str]) -> bool:
    return all(p in text for p in parts)


# ---------------------------------------------------------------- routing

class _Spy:
    """Records whether Firecrawl was reached, and with what."""

    def __init__(self, results=None, error=None):
        self.results, self.error, self.calls = results or [], error, []

    async def __call__(self, query, limit, **kw):
        self.calls.append({"query": query, "limit": limit, **kw})
        if self.error:
            raise self.error
        return self.results


@pytest.fixture(autouse=True)
def _no_tinyfish(monkeypatch):
    """These cases describe the Firecrawl/DDG cascade specifically.

    TinyFish leads both paths when a key is present, so on a machine that has one set
    these tests would route somewhere else — and would reach the real network doing it.
    """
    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)


@pytest.fixture
def tool():
    return web.WebSearchTool(api_key="")


async def _no_ddg(*a, **k):
    return "Error (DuckDuckGo): blocked"


async def _good_ddg(*a, **k):
    return "Results for: q\n\n1. ddg hit\n   https://ddg.example"


@pytest.mark.asyncio
async def test_a_plain_query_never_spends_firecrawl_budget(tool, monkeypatch):
    spy = _Spy(results=[{"title": "fc", "url": "https://fc.example"}])
    monkeypatch.setattr(firecrawl_client, "search", spy)
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    out = await tool.execute(query="q")

    assert spy.calls == [], "a plain query must stay on the free unmetered provider"
    assert "ddg hit" in out


@pytest.mark.asyncio
async def test_a_filtered_query_goes_straight_to_firecrawl(tool, monkeypatch):
    spy = _Spy(results=[{"title": "fc", "url": "https://fc.example", "snippet": "s"}])
    monkeypatch.setattr(firecrawl_client, "search", spy)

    out = await tool.execute(query="q", recency="week", mode="news", count=3)

    assert len(spy.calls) == 1
    assert spy.calls[0]["recency"] == "week"
    assert spy.calls[0]["mode"] == "news"
    assert spy.calls[0]["limit"] == 3
    assert "via Firecrawl" in out


@pytest.mark.asyncio
async def test_firecrawl_failure_on_a_filtered_query_says_the_filters_were_lost(tool, monkeypatch):
    monkeypatch.setattr(firecrawl_client, "search", _Spy(error=FirecrawlError("rate limited")))
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    out = await tool.execute(query="hiring", recency="day", include_domains=["yc.com"])

    # Silently returning unfiltered results would let an agent believe it applied a
    # recency window it never got — the loss has to be visible in the result text.
    assert "Filters not applied" in out
    assert "rate limited" in out
    assert "ddg hit" in out


@pytest.mark.asyncio
async def test_firecrawl_backs_up_a_failed_plain_search(tool, monkeypatch):
    spy = _Spy(results=[{"title": "fc", "url": "https://fc.example"}])
    monkeypatch.setattr(firecrawl_client, "search", spy)
    monkeypatch.setattr(tool, "_ddgs_search", _no_ddg)

    out = await tool.execute(query="q")

    assert len(spy.calls) == 1, "Firecrawl is the leg after DDG fails, before the HTML scrape"
    assert "via Firecrawl" in out


# ---------------------------------------------------------------- web_fetch success path

def _response(monkeypatch, *, ctype: str, body: str):
    async def _fake(client, method, url, **kw):
        return httpx.Response(200, headers={"content-type": ctype}, text=body,
                              request=httpx.Request(method, url))

    monkeypatch.setattr(web, "_request_with_retry", _fake)


@pytest.mark.asyncio
async def test_single_url_fetch_returns_the_extracted_page(monkeypatch):
    """Regression. Adding the Firecrawl fallback orphaned this whole branch inside the
    new helper, past its `return`, so every successful fetch fell off the end of
    execute() and returned None. Nothing caught it: the type is `-> str`, the tests
    only drove the failure paths, and the smoke test only covered web_search."""
    pytest.importorskip("readability", reason="HTML extraction needs the container image")
    _response(monkeypatch, ctype="text/html",
              body="<html><head><title>Hello</title></head><body>"
                   "<article>" + "Body text. " * 40 + "</article></body></html>")

    raw = await web.WebFetchTool().execute(url="https://example.com")
    assert isinstance(raw, str), "execute must return a string, never None"
    out = json.loads(raw)
    assert out.get("error") is None
    assert out["extractor"] == "readability"
    assert out["status"] == 200
    assert "Body text" in out["text"]


@pytest.mark.asyncio
async def test_single_url_fetch_handles_json_bodies(monkeypatch):
    """Same regression, on the branch that needs no third-party extractor — so this one
    runs on a laptop too, and would have caught the orphaned `return` on its own."""
    _response(monkeypatch, ctype="application/json", body='{"ok": true, "n": 3}')

    raw = await web.WebFetchTool().execute(url="https://api.example/x")
    assert isinstance(raw, str), "execute must return a string, never None"
    out = json.loads(raw)
    assert out["extractor"] == "json"
    assert '"ok": true' in out["text"]


@pytest.mark.asyncio
async def test_a_blocked_html_scrape_is_not_reported_as_an_empty_web(tool, monkeypatch):
    """DuckDuckGo answers datacenter IPs with HTTP 202 and an anomaly page that parses
    to zero results. Calling that "no results" tells an agent the web has nothing on a
    subject when in fact no provider ever ran the query — which is how a cycle ends up
    confidently reporting an empty market."""
    monkeypatch.setattr(firecrawl_client, "search", _Spy(error=FirecrawlError("403")))
    monkeypatch.setattr(tool, "_ddgs_search", _no_ddg)

    async def _blocked(*a, **k):
        return [], 202

    monkeypatch.setattr(tool, "_ddg_html_search", _blocked)

    out = await tool.execute(query="q")
    assert "NOT an empty result set" in out
    assert not out.startswith("No results")


@pytest.mark.asyncio
async def test_a_genuinely_empty_result_set_still_says_no_results(tool, monkeypatch):
    monkeypatch.setattr(firecrawl_client, "search", _Spy(error=FirecrawlError("403")))
    monkeypatch.setattr(tool, "_ddgs_search", _no_ddg)

    async def _empty(*a, **k):
        return [], 200

    monkeypatch.setattr(tool, "_ddg_html_search", _empty)

    assert (await tool.execute(query="q")).startswith("No results")


@pytest.mark.asyncio
async def test_every_provider_failing_still_returns_a_string_not_an_exception(tool, monkeypatch):
    monkeypatch.setattr(firecrawl_client, "search", _Spy(error=FirecrawlError("403 suspicious IP")))
    monkeypatch.setattr(tool, "_ddgs_search", _no_ddg)

    async def _dead_html(*a, **k):
        raise RuntimeError("202 anomaly page")

    monkeypatch.setattr(tool, "_ddg_html_search", _dead_html)

    out = await tool.execute(query="q")
    assert "all search providers failed" in out
