"""A 200 that extracts to nothing must escalate, not be reported as a successful read.

Found 2026-09-07 on Finder's a live cycle, immediately after `web_map` shipped. web_map
did its job — it found infinit.com's /about, /careers and /contact — and `web_fetch` then
returned **15 characters** for all three: `# INFINIT.com`, status 200, `truncated: false`.

The cause was that the fallback ladder could only see two kinds of failure, a >=400 status
and a thrown exception. A client-rendered page is neither. httpx got the HTML shell, the
shell has a perfectly good `<title>` and an empty `<body>`, readability extracted the
title, and the tool reported success. Playwright — which renders those pages fine — was
never reached, and neither was Firecrawl.

That made the ladder's most important rung unreachable for the most common shape of
modern marketing site, which is exactly what the seed-to-Series-A companies in Finder's ICP
build. The lead's `contact_person` then comes back "unverified" and the row is closed as
`none-findable` — a wrong answer that looks like a diligent one.

The fix measures the BODY, title excluded. Counting the title is what made an empty page
look full.
"""

from __future__ import annotations

import json
import sys
import types

import pytest

if "nanoagent.agent.tools" not in sys.modules:
    import pathlib

    import nanoagent

    _tools = types.ModuleType("nanoagent.agent.tools")
    _tools.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "agent" / "tools")]
    sys.modules["nanoagent.agent.tools"] = _tools

from nanoagent.agent.tools import web  # noqa: E402

# The real shape: a good title, an empty root div, and a script bundle. This is what
# infinit.com served, reduced.
SPA_SHELL = (
    "<!doctype html><html><head><title>INFINIT.com</title></head>"
    "<body><div id='root'></div>"
    "<script>window.__DATA__=" + ("x" * 5000) + "</script>"
    "</body></html>"
)

REAL_PAGE = (
    "<!doctype html><html><head><title>About INFINIT</title></head><body><article>"
    "<h1>Our team</h1>"
    "<p>INFINIT was founded in 2021 by Alex Moreau, who leads the company as CEO. "
    "Before INFINIT he spent eight years building payment infrastructure at a large "
    "European bank, where he ran the team responsible for SME lending products. "
    "He is joined by Priya Raman, the chief technology officer, who previously led "
    "platform engineering at a logistics scale-up.</p>"
    "</article></body></html>"
)


# ---------------------------------------------------------------- the measurement

def test_a_title_only_page_scores_as_empty():
    got = web.WebFetchTool()._extract(SPA_SHELL, None, "text/html", "markdown", 50_000)

    assert got["extractor"] == "readability"
    assert "INFINIT.com" in got["text"]          # the title is still returned
    assert got["body_len"] < web.MIN_USEFUL_EXTRACTION_CHARS  # but it is not content


def test_a_long_title_cannot_carry_an_empty_page_over_the_threshold():
    # THE assertion, and the one the short-titled fixture above does NOT make: with a
    # 15-character title, counting it or not lands under 200 either way, so that test
    # passes even against the original bug. SEO titles run long, and a page whose only
    # text is its own <title> is precisely the case being guarded.
    long_title = (
        "About Us | INFINIT | AI-Powered Operating System and Payment Account for "
        "Independent Businesses Across the UK and Europe | Financing up to GBP 500k "
        "| Trusted by Thousands of Growing Companies Since 2021"
    )
    assert len(long_title) > web.MIN_USEFUL_EXTRACTION_CHARS

    shell = (
        f"<!doctype html><html><head><title>{long_title}</title></head>"
        "<body><div id='root'></div></body></html>"
    )
    got = web.WebFetchTool()._extract(shell, None, "text/html", "markdown", 50_000)

    assert long_title in got["text"]        # returned to the caller
    assert got["body_len"] < web.MIN_USEFUL_EXTRACTION_CHARS  # and still scored as empty


def test_a_real_page_clears_the_threshold():
    got = web.WebFetchTool()._extract(REAL_PAGE, None, "text/html", "markdown", 50_000)
    assert got["body_len"] >= web.MIN_USEFUL_EXTRACTION_CHARS
    assert "Alex Moreau" in got["text"]


def test_the_script_bundle_is_not_mistaken_for_content():
    # The shell carries 5 000 characters of inline JS. A probe that stripped tags off the
    # raw HTML without dropping <script> would read that as a full page.
    got = web.WebFetchTool()._extract(SPA_SHELL, None, "text/html", "markdown", 50_000)
    assert "window.__DATA__" not in got["text"]
    assert got["body_len"] < 200


def test_short_json_is_measured_whole():
    # No title trick here: for JSON the body IS the text, so a small object is small.
    got = web.WebFetchTool()._extract("", {"ok": True}, "application/json", "markdown", 50_000)
    assert got["extractor"] == "json"
    assert got["body_len"] == len(got["text"])


# ---------------------------------------------------------------- the escalation

class _Resp:
    def __init__(self, text: str, ctype: str = "text/html", status: int = 200):
        self.text = text
        self.status_code = status
        self.headers = {"content-type": ctype}
        self.url = "https://e.com/about"

    def raise_for_status(self):
        pass

    def json(self):
        return json.loads(self.text)


@pytest.fixture
def stub_http(monkeypatch):
    """Serve one canned response to the httpx leg, and record fallback attempts."""
    calls: dict[str, object] = {"playwright": 0, "firecrawl": 0, "detail": ""}

    def install(resp: _Resp):
        async def fake_request(client, method, url, **kw):
            return resp

        monkeypatch.setattr(web, "_request_with_retry", fake_request)

        class _Client:
            def __init__(self, **kw): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False

        monkeypatch.setattr(web.httpx, "AsyncClient", _Client)

        async def fake_playwright(self, url, mode, max_chars):
            calls["playwright"] += 1
            body = calls.get("pw_body", "rendered body text " * 20)
            if isinstance(body, Exception):
                raise body
            return {
                "url": url, "extractor": "playwright_readability", "text": body,
                "status": 200, "truncated": False, "length": len(body),
                "body_len": len(body),
            }

        async def fake_firecrawl(self, url, max_chars, http_err, pw_err):
            calls["firecrawl"] += 1
            calls["fc_reason"] = pw_err
            body = calls.get("fc_body", "firecrawl body text " * 20)
            if isinstance(body, Exception):
                raise body
            return {
                "url": url, "extractor": "firecrawl", "text": body,
                "status": 200, "truncated": False, "length": len(body),
                "body_len": len(body),
            }

        monkeypatch.setattr(web.WebFetchTool, "_playwright_fetch", fake_playwright)
        monkeypatch.setattr(web.WebFetchTool, "_firecrawl_fetch", fake_firecrawl)
        return calls

    return install


async def test_an_empty_200_escalates_to_the_browser(stub_http):
    calls = stub_http(_Resp(SPA_SHELL))

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert calls["playwright"] == 1, "a title-only page must reach the browser"
    assert out["extractor"] == "playwright_readability"


async def test_a_page_with_real_content_does_not_escalate(stub_http):
    # The other half of the guard. Escalating on every page would turn a free, fast fetch
    # into a browser render for the whole web.
    calls = stub_http(_Resp(REAL_PAGE))

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert calls["playwright"] == 0
    assert out["extractor"] == "readability"
    assert "Alex Moreau" in out["text"]


async def test_a_small_json_response_does_not_escalate(stub_http):
    # `{"ok": true}` is a complete answer. Re-fetching it in a browser would spend a page
    # load to receive the same nine bytes.
    calls = stub_http(_Resp('{"ok": true}', ctype="application/json"))

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/api/health"))

    assert calls["playwright"] == 0
    assert out["extractor"] == "json"


# ------------------------------------------------- the Playwright leg escalates too

async def test_a_thin_playwright_render_escalates_to_firecrawl(stub_http):
    # The half the first fix missed. infinit.com/careers rendered fine and produced 176
    # chars of body; Firecrawl was never consulted because nothing had thrown.
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = "x" * 176

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/careers"))

    assert calls["playwright"] == 1
    assert calls["firecrawl"] == 1, "a rendered-but-empty page must reach Firecrawl"
    assert out["extractor"] == "firecrawl"


async def test_a_good_playwright_render_never_reaches_firecrawl(stub_http):
    # Firecrawl bills a credit and Playwright does not, so a page Playwright can read
    # must never escalate. Without this the fix would put every fetch on the meter.
    calls = stub_http(_Resp(SPA_SHELL))

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert calls["playwright"] == 1
    assert calls["firecrawl"] == 0
    assert out["extractor"] == "playwright_readability"


async def test_escalating_can_never_be_a_downgrade(stub_http):
    # Firecrawl is the more capable engine, not automatically the better answer. If it
    # comes back with less than Playwright had, keeping Firecrawl's would mean the extra
    # credit actively cost us content.
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = "p" * 150
    calls["fc_body"] = "f" * 10

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert calls["firecrawl"] == 1
    assert out["extractor"] == "playwright_readability"
    assert out["length"] == 150


async def test_a_thin_render_survives_a_firecrawl_error(stub_http):
    # 150 real characters beat an error message. Returning the failure would discard
    # content we already have in hand.
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = "p" * 150
    calls["fc_body"] = web.firecrawl_client.FirecrawlError("Firecrawl: out of credits.")

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert "error" not in out
    assert out["extractor"] == "playwright_readability"
    assert out["length"] == 150


async def test_only_a_total_failure_returns_an_error(stub_http):
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = RuntimeError("chromium crashed")
    calls["fc_body"] = web.firecrawl_client.FirecrawlError("Firecrawl: out of credits.")

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/about"))

    assert "chromium crashed" in out["error"]
    assert "out of credits" in out["error"]


async def test_firecrawl_is_told_why_it_was_called(stub_http):
    # "Playwright failed" on a page that rendered perfectly well sent someone hunting a
    # crash that never happened. The reason has to distinguish the two cases.
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = "x" * 176

    await web.WebFetchTool().execute(url="https://e.com/careers")

    assert "176 chars" in str(calls["fc_reason"])
    assert "rendered" in str(calls["fc_reason"])


async def test_body_len_is_never_shown_to_the_model(stub_http):
    # Bookkeeping about our fallback ladder, not content about the page.
    calls = stub_http(_Resp(SPA_SHELL))
    calls["pw_body"] = "x" * 176

    out = json.loads(await web.WebFetchTool().execute(url="https://e.com/careers"))
    assert "body_len" not in out

    out2 = json.loads(await web.WebFetchTool().execute(url="https://e.com/ok"))
    assert "body_len" not in out2


async def test_the_escalation_reason_names_the_cause(stub_http, monkeypatch):
    # The log line is how this gets diagnosed next time. "HTTP fetch failed" with no
    # number would send someone hunting for a network error that never happened.
    seen: list[str] = []
    monkeypatch.setattr(web.logger, "warning", lambda m, *a, **k: seen.append(str(m)))
    stub_http(_Resp(SPA_SHELL))

    await web.WebFetchTool().execute(url="https://e.com/about")

    assert any("client-rendered" in m for m in seen), seen
    assert any("chars of text extracted" in m for m in seen), seen
