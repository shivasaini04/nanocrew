"""Stage 46 Phase 2: TinyFish leading web_search, and batched web_fetch.

TinyFish leads on measurement, not preference (prod, 2026-08-29):

- plain search returned dates on 6 of 10 results; DuckDuckGo and Firecrawl dated none
- `recency_minutes=10080` returned 5/5 dated results inside the window, and caught a
  one-day-old HN item that Firecrawl's `tbs=qdr:w` missed
- 5 URLs fetched in ONE 2.15 s request, ~55 k chars of clean markdown, against 5
  requests and 1 456 982 chars of raw HTML for the same URLs over plain httpx

What must not regress: TinyFish is skipped entirely when no key is set (that is Phase 1's
behaviour and it has to keep working), the `pdf`/`developer` modes still reach Firecrawl
because TinyFish has no equivalent, and a batch fetch never blows the context budget.
"""

from __future__ import annotations

import json
import pathlib
import sys
import types

import pytest

if "nanoagent.agent.tools" not in sys.modules:
    import nanoagent

    _tools = types.ModuleType("nanoagent.agent.tools")
    _tools.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "agent" / "tools")]
    sys.modules["nanoagent.agent.tools"] = _tools

from nanoagent.agent.tools import firecrawl_client, tinyfish_client, web  # noqa: E402
from nanoagent.agent.tools.firecrawl_client import FirecrawlError  # noqa: E402
from nanoagent.agent.tools.tinyfish_client import TinyFishError  # noqa: E402


# ---------------------------------------------------------------- param mapping

def test_recency_enum_maps_to_minutes():
    p = tinyfish_client.build_search_params("q", recency="week")
    assert p["recency_minutes"] == 7 * 24 * 60


def test_modes_map_to_domain_type():
    assert "domain_type" not in tinyfish_client.build_search_params("q", mode="web")
    assert tinyfish_client.build_search_params("q", mode="news")["domain_type"] == "news"
    assert tinyfish_client.build_search_params("q", mode="research")["domain_type"] == "research_paper"


def test_domains_are_comma_joined():
    p = tinyfish_client.build_search_params("q", include_domains=["a.com", "b.com"])
    assert p["include_domains"] == "a.com,b.com"


def test_recency_with_research_is_rejected_locally():
    """The live API answers this combination with a 400 — don't spend the round trip."""
    with pytest.raises(TinyFishError, match="not supported"):
        tinyfish_client.build_search_params("q", mode="research", recency="week")


@pytest.mark.parametrize("mode", ["pdf", "developer"])
def test_firecrawl_only_modes_are_refused(mode):
    assert not tinyfish_client.supports_mode(mode)
    with pytest.raises(TinyFishError, match="no equivalent"):
        tinyfish_client.build_search_params("q", mode=mode)


def test_include_and_exclude_are_mutually_exclusive():
    with pytest.raises(TinyFishError, match="mutually exclusive"):
        tinyfish_client.build_search_params("q", include_domains=["a.com"], exclude_domains=["b.com"])


def test_url_chunking_respects_the_server_cap():
    chunks = tinyfish_client.chunk_urls([f"https://e.com/{i}" for i in range(23)])
    assert [len(c) for c in chunks] == [10, 10, 3]


@pytest.mark.asyncio
async def test_fetch_refuses_an_over_long_batch_without_calling_out():
    with pytest.raises(TinyFishError, match="at most 10"):
        await tinyfish_client.fetch([f"https://e.com/{i}" for i in range(11)])


# ---------------------------------------------------------------- routing

class _Spy:
    def __init__(self, results=None, error=None):
        self.results, self.error, self.calls = results or [], error, []

    async def __call__(self, query, limit, **kw):
        self.calls.append({"query": query, "limit": limit, **kw})
        if self.error:
            raise self.error
        return self.results


@pytest.fixture
def tool():
    return web.WebSearchTool(api_key="")


@pytest.fixture
def keyed(monkeypatch):
    monkeypatch.setenv("TINYFISH_API_KEY", "sk-test")


async def _good_ddg(*a, **k):
    return "Results for: q\n\n1. ddg hit\n   https://ddg.example"


@pytest.mark.asyncio
async def test_no_key_means_tinyfish_is_never_called(tool, monkeypatch):
    """Phase 1 behaviour has to survive Phase 2 for anyone without a key."""
    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)
    tf = _Spy(results=[{"title": "tf", "url": "https://tf.example"}])
    monkeypatch.setattr(tinyfish_client, "search", tf)
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    assert "ddg hit" in await tool.execute(query="q")
    assert tf.calls == []


@pytest.mark.asyncio
async def test_tinyfish_leads_the_plain_path_when_keyed(tool, monkeypatch, keyed):
    tf = _Spy(results=[{"title": "tf", "url": "https://tf.example", "date": "2 days ago"}])
    monkeypatch.setattr(tinyfish_client, "search", tf)
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    out = await tool.execute(query="q")

    assert len(tf.calls) == 1
    assert "via TinyFish" in out
    assert "published: 2 days ago" in out, "dates are the reason it leads — surface them"


@pytest.mark.asyncio
async def test_duckduckgo_catches_a_tinyfish_failure(tool, monkeypatch, keyed):
    monkeypatch.setattr(tinyfish_client, "search", _Spy(error=TinyFishError("rate limited")))
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    assert "ddg hit" in await tool.execute(query="q")


@pytest.mark.asyncio
async def test_a_filtered_query_prefers_tinyfish_over_firecrawl(tool, monkeypatch, keyed):
    tf = _Spy(results=[{"title": "tf", "url": "https://tf.example", "date": "1 day ago"}])
    fc = _Spy(results=[{"title": "fc", "url": "https://fc.example"}])
    monkeypatch.setattr(tinyfish_client, "search", tf)
    monkeypatch.setattr(firecrawl_client, "search", fc)

    out = await tool.execute(query="q", recency="week")

    assert tf.calls and tf.calls[0]["recency"] == "week"
    assert fc.calls == [], "Firecrawl should not be called when TinyFish served the query"
    assert "via TinyFish" in out


@pytest.mark.parametrize("mode", ["pdf", "developer"])
@pytest.mark.asyncio
async def test_firecrawl_only_modes_skip_tinyfish(tool, monkeypatch, keyed, mode):
    tf = _Spy(results=[{"title": "tf", "url": "https://tf.example"}])
    fc = _Spy(results=[{"title": "fc", "url": "https://fc.example"}])
    monkeypatch.setattr(tinyfish_client, "search", tf)
    monkeypatch.setattr(firecrawl_client, "search", fc)

    out = await tool.execute(query="q", mode=mode)

    assert tf.calls == [], "TinyFish has no equivalent of this mode"
    assert fc.calls and fc.calls[0]["mode"] == mode
    assert "via Firecrawl" in out


@pytest.mark.asyncio
async def test_firecrawl_leads_with_content_and_tinyfish_backs_it_up(tool, monkeypatch, keyed):
    """with_content is one Firecrawl request; TinyFish needs search+fetch, so it is second."""
    fc = _Spy(error=FirecrawlError("out of credits"))
    tf = _Spy(results=[{"title": "tf", "url": "https://tf.example", "date": ""}])
    monkeypatch.setattr(firecrawl_client, "search", fc)
    monkeypatch.setattr(tinyfish_client, "search", tf)

    async def _fetch(urls, **kw):
        return [{"url": u, "finalUrl": u, "title": "t", "publishedDate": "2026-08-01",
                 "text": "PAGE BODY"} for u in urls], []

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    out = await tool.execute(query="q", with_content=True)

    assert fc.calls, "Firecrawl gets first refusal on with_content"
    assert "TinyFish search + fetch" in out
    assert "PAGE BODY" in out
    assert "published: 2026-08-01" in out, "a fetched page can date a result the search could not"


@pytest.mark.asyncio
async def test_every_filtered_provider_failing_still_states_the_loss(tool, monkeypatch, keyed):
    monkeypatch.setattr(tinyfish_client, "search", _Spy(error=TinyFishError("key rejected")))
    monkeypatch.setattr(firecrawl_client, "search", _Spy(error=FirecrawlError("rate limited")))
    monkeypatch.setattr(tool, "_ddgs_search", _good_ddg)

    out = await tool.execute(query="q", recency="day")

    assert "Filters not applied" in out
    assert "key rejected" in out and "rate limited" in out
    assert "ddg hit" in out


# ---------------------------------------------------------------- batch fetch

@pytest.fixture
def fetcher():
    return web.WebFetchTool()


@pytest.mark.asyncio
async def test_many_urls_become_one_batched_request(fetcher, monkeypatch, keyed):
    seen = []

    async def _fetch(urls, **kw):
        seen.append(list(urls))
        return [{"url": u, "finalUrl": u, "title": "t", "publishedDate": "", "text": "body " + u}
                for u in urls], []

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    urls = [f"https://e.com/{i}" for i in range(5)]
    out = json.loads(await fetcher.execute(urls=urls))

    assert seen == [urls], "5 URLs must be ONE request, not five"
    assert out["count"] == 5


@pytest.mark.asyncio
async def test_a_long_batch_is_split_into_server_legal_chunks(fetcher, monkeypatch, keyed):
    seen = []

    async def _fetch(urls, **kw):
        seen.append(len(urls))
        return [{"url": u, "finalUrl": u, "title": "", "publishedDate": "", "text": "x"}
                for u in urls], []

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    await fetcher.execute(urls=[f"https://e.com/{i}" for i in range(14)])
    assert seen == [10, 4]


@pytest.mark.asyncio
async def test_batch_output_is_bounded(fetcher, monkeypatch, keyed):
    async def _fetch(urls, **kw):
        return [{"url": u, "finalUrl": u, "title": "", "publishedDate": "",
                 "text": "z" * 500_000} for u in urls], []

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    raw = await fetcher.execute(urls=[f"https://e.com/{i}" for i in range(10)])
    out = json.loads(raw)

    assert len(raw) < web.MAX_BATCH_TOTAL_CHARS * 2
    assert all(r["length"] <= web.MAX_BATCH_CHARS_PER_URL for r in out["results"])
    assert out["results"][0]["truncated"] is True


@pytest.mark.asyncio
async def test_a_per_url_failure_does_not_sink_the_batch(fetcher, monkeypatch, keyed):
    async def _fetch(urls, **kw):
        ok = [{"url": u, "finalUrl": u, "title": "", "publishedDate": "", "text": "fine"}
              for u in urls[:-1]]
        return ok, [{"url": urls[-1], "code": "timeout"}]

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    out = json.loads(await fetcher.execute(urls=[f"https://e.com/{i}" for i in range(4)]))
    assert out["count"] == 3
    assert len(out["errors"]) == 1


@pytest.mark.asyncio
async def test_invalid_urls_are_reported_not_silently_dropped(fetcher, monkeypatch, keyed):
    async def _fetch(urls, **kw):
        return [{"url": u, "finalUrl": u, "title": "", "publishedDate": "", "text": "ok"}
                for u in urls], []

    monkeypatch.setattr(tinyfish_client, "fetch", _fetch)

    out = json.loads(await fetcher.execute(urls=["https://good.example", "ftp://bad.example"]))
    assert out["count"] == 1
    assert any("ftp" in (e.get("url") or "") for e in out["errors"])


@pytest.mark.asyncio
async def test_without_a_key_a_batch_still_works_one_url_at_a_time(fetcher, monkeypatch):
    monkeypatch.delenv("TINYFISH_API_KEY", raising=False)
    calls = []
    real_execute = web.WebFetchTool.execute  # captured before patching, or this recurses

    async def _single(self, url="", extractMode="markdown", maxChars=None, urls=None, **kw):
        if urls and len(urls) > 1:
            return await real_execute(self, url=url, extractMode=extractMode,
                                      maxChars=maxChars, urls=urls, **kw)
        calls.append(url)
        return json.dumps({"url": url, "finalUrl": url, "text": "solo"})

    monkeypatch.setattr(web.WebFetchTool, "execute", _single)

    out = json.loads(await fetcher.execute(urls=["https://a.example", "https://b.example"]))
    assert out["count"] == 2
    assert calls == ["https://a.example", "https://b.example"]


@pytest.mark.asyncio
async def test_neither_url_nor_urls_is_a_clear_error(fetcher):
    out = json.loads(await fetcher.execute())
    assert "url" in out["error"]
