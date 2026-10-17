"""Stage 60 live test — the `browser` tool on the user's own browser.

Every action used Playwright calls the remote lane refuses, so on "This computer" the tool
failed on its first navigate (prod a live cycle, 2026-09-17). These pin the remote
branches against a stand-in RemotePage.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from nanoagent.agent.tools.browser import BrowserTool


class _Loc:
    def __init__(self, page, spec):
        self.page, self.spec = page, spec

    async def count(self):
        return 1 if self.spec.get("css") == "#real" or "text" in self.spec or "placeholder" in self.spec else 0

    def first(self):
        return self

    async def click(self, timeout=None):
        self.page.calls.append(("click", self.spec))

    async def fill(self, value, timeout=None):
        self.page.calls.append(("fill", self.spec, value))


class _Remote:
    has_locators = True
    url = "https://example.com/"

    def __init__(self):
        self.calls = []

    async def goto(self, url):
        self.calls.append(("goto", url))
        self.url = url

    async def title(self):
        return "Example"

    async def nc_text(self):
        return "  Hello world  "

    async def refresh_info(self):
        pass

    async def locator(self, selector):
        return _Loc(self, {"css": selector})

    def locate(self, spec):
        return _Loc(self, spec)

    async def screenshot(self):
        return b"\xff\xd8jpeg"

    async def _dispatch(self, cap, payload):
        self.calls.append((cap, payload))
        return [{"frameId": 0, "result": {"ok": True}}]


def _tool(tmp_path: Path, remote: _Remote) -> BrowserTool:
    t = BrowserTool(workspace=tmp_path)
    t._page = remote
    t._remote = lambda: remote  # type: ignore[method-assign]
    return t


def test_navigate_and_get_text_use_the_text_probe(tmp_path):
    r = _Remote()
    t = _tool(tmp_path, r)
    out = json.loads(asyncio.run(t._navigate("https://httpbin.org/forms/post")))
    assert out == {"url": "https://httpbin.org/forms/post", "title": "Example", "text": "Hello world"}
    assert json.loads(asyncio.run(t._get_text()))["text"] == "Hello world"


def test_click_falls_back_from_css_to_text(tmp_path):
    r = _Remote()
    t = _tool(tmp_path, r)
    asyncio.run(t._click("#real"))
    asyncio.run(t._click("Submit order"))
    assert r.calls == [("click", {"css": "#real"}), ("click", {"text": "Submit order", "exact": False})]


def test_type_falls_back_to_placeholder(tmp_path):
    r = _Remote()
    t = _tool(tmp_path, r)
    asyncio.run(t._type("Customer name", "Test A"))
    assert r.calls == [("fill", {"placeholder": "Customer name", "exact": False}, "Test A")]


def test_screenshot_writes_the_lane_bytes(tmp_path):
    t = _tool(tmp_path, _Remote())
    msg = asyncio.run(t._screenshot("shot.jpg"))
    assert (tmp_path / "shot.jpg").read_bytes() == b"\xff\xd8jpeg" and "saved" in msg


def test_evaluate_wraps_an_expression_and_refuses_on_the_extension(tmp_path):
    r = _Remote()
    t = _tool(tmp_path, r)
    out = asyncio.run(t._evaluate("document.title"))
    assert json.loads(out) == {"ok": True}
    assert r.calls[-1] == ("page.probe", {"script": "() => (document.title)"})
    r.has_locators = False
    assert "extension" in asyncio.run(t._evaluate("document.title"))


def test_get_text_reads_a_selector_when_given(tmp_path):
    r = _Remote()

    async def extract(selectors):
        return {selectors[0]: " About me text "}

    r.nc_extract_selectors = extract
    t = _tool(tmp_path, r)
    out = json.loads(asyncio.run(t._get_text("section.about")))
    assert out["text"] == "About me text"
