"""A web_fetch call with no url is answered with the call as it arrived, and never replayed.

Found live 2026-09-29 (Assistant, wake turn after run-mumoie3223d802): the model sent
`{"maxChars": 4000}` four times — 14 output tokens each, so the URL was never in the call —
got a bare "needs `url`" back, three times from the tool cache in 0 ms, and concluded the
platform was stripping its url.
"""
from __future__ import annotations

import json

from nanoagent.agent.tool_cache import ToolResultCache, _is_error_result
from nanoagent.agent.tools.registry import ToolRegistry
from nanoagent.agent.tools.web import WebFetchTool


async def test_a_call_without_url_is_a_schema_error_that_shows_what_arrived():
    reg = ToolRegistry()
    reg.register(WebFetchTool())
    out = await reg.execute("web_fetch", {"maxChars": 4000})
    assert out.startswith("Error: Invalid parameters for tool 'web_fetch'")
    assert '{"maxChars": 4000}' in out                  # what was actually sent
    assert '"url": "https://example.com/page"' in out   # the shape to send instead
    assert "Call the SAME tool again" in out


def test_url_or_urls_passes_validation():
    t = WebFetchTool()
    assert t.validate_params({"url": "https://example.com", "maxChars": 4000}) == []
    assert t.validate_params({"urls": ["https://a.example", "https://b.example"]}) == []
    assert t.validate_params({"url": "   "}) != []
    assert t.validate_params({"urls": []}) != []


def test_failures_are_never_cached():
    cache = ToolResultCache()
    args = {"maxChars": 4000}
    cache.set("web_fetch", args, json.dumps({"error": "web_fetch needs `url`"}))
    assert cache.get("web_fetch", args) is None
    cache.set("web_fetch", args, "Error: Invalid parameters for tool 'web_fetch'")
    assert cache.get("web_fetch", args) is None
    ok = json.dumps({"url": "https://example.com", "text": "hello"})
    cache.set("web_fetch", {"url": "https://example.com"}, ok)
    assert cache.get("web_fetch", {"url": "https://example.com"}) == ok


def test_error_detection_is_narrow():
    assert _is_error_result('{"error": "boom"}')
    assert _is_error_result("Error: nope")
    assert not _is_error_result('{"error": null, "text": "fine"}')
    assert not _is_error_result('{"text": "the word Error appears later"}')
    assert not _is_error_result("A page about errors")
