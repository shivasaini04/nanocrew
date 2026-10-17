"""Stage 61 phase 4 — compiled reads (synthesis/compiled_read.py): a verified read of a
public page replays as one HTTP GET, and only reads a plain GET can prove get compiled."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.synthesis import compiled_read as cr

PAGE = """<html><body>
  <div id="main"><h1>A Light in the Attic</h1><p class="price_color">£51.77</p>
  <p>In stock (22 available)</p><strong>11</strong> results</div>
</body></html>"""


class _Page:
    def __init__(self, url: str, selectors: dict[str, str | None]):
        self.url = url
        self.selectors = selectors

    async def evaluate(self, script, value):
        return self.selectors.get(value)


def test_read_fields_returns_each_fields_text():
    got = cr.read_fields(PAGE, {"price": "#main > p:nth-of-type(1)", "count": "#main > strong:nth-of-type(1)"})
    assert got == {"price": "£51.77", "count": "11"}


def test_read_fields_misses_when_a_selector_finds_nothing_or_more_than_one():
    assert cr.read_fields(PAGE, {"x": "#nope"}) is None
    assert cr.read_fields(PAGE, {"x": "#main > p"}) is None  # two <p> — ambiguous


@pytest.mark.asyncio
async def test_a_read_a_plain_get_proves_is_compiled_and_replays_without_a_browser(tmp_path: Path):
    page = _Page("https://books.example/attic", {"£51.77": "#main > p:nth-of-type(1)"})
    with patch.object(cr, "_fetch", return_value=PAGE):
        saved = await cr.compile_read(page, tmp_path, "books.example", "Find the price", {"answer": "£51.77"},
                                       [{"action": "click", "url_after": "https://books.example/attic"}], "https://books.example/")
        assert saved is not None
        hit = cr.replay_read(tmp_path, "books.example", "Find the price")
    assert hit == {"url": "https://books.example/attic", "extracted_data": {"answer": "£51.77"}}


@pytest.mark.asyncio
async def test_values_a_plain_get_does_not_show_are_never_compiled(tmp_path: Path):
    # e.g. a form's confirmation, or a page behind a login: the browser saw it, a GET does not.
    page = _Page("https://demo.example/form", {"Name:Ada": "#output > p:nth-of-type(1)"})
    with patch.object(cr, "_fetch", return_value="<html><body><form></form></body></html>"):
        assert await cr.compile_read(page, tmp_path, "demo.example", "fill and submit", {"answer": "Name:Ada"},
                                    [{"action": "type", "url_after": "https://demo.example/form"}, {"action": "click", "url_after": "https://demo.example/done"}], "https://demo.example/form") is None
    assert cr.load_compiled_read(tmp_path, "demo.example", "fill and submit") is None


@pytest.mark.asyncio
async def test_a_redirect_or_error_is_a_miss_not_a_proof(tmp_path: Path):
    page = _Page("https://site.example/secure", {"Welcome": "#flash"})
    with patch.object(cr, "_fetch", return_value=None):  # _fetch returns None for any non-200
        assert await cr.compile_read(page, tmp_path, "site.example", "log in", {"answer": "Welcome"}, [], None) is None


@pytest.mark.asyncio
async def test_a_value_with_no_unique_place_on_the_page_is_not_compiled(tmp_path: Path):
    page = _Page("https://books.example/", {})  # locator found no single exact match
    with patch.object(cr, "_fetch", return_value=PAGE):
        assert await cr.compile_read(page, tmp_path, "books.example", "g", {"answer": "1889"}, [], None) is None


@pytest.mark.asyncio
async def test_bot_sensitive_sites_and_mutating_runs_are_not_eligible(tmp_path: Path):
    li = _Page("https://www.linkedin.com/in/x", {"Ada": "#name"})
    with patch.object(cr, "_fetch", return_value="<div id='name'>Ada</div>"):
        assert await cr.compile_read(li, tmp_path, "linkedin.com", "g", {"answer": "Ada"}, [], None) is None
    dl = _Page("https://files.example/", {"a.txt": "#f"})
    with patch.object(cr, "_fetch", return_value="<div id='f'>a.txt</div>"):
        assert await cr.compile_read(dl, tmp_path, "files.example", "g", {"answer": "a.txt"},
                                    [{"action": "download", "url_after": "https://files.example/"}], None) is None


def test_a_replay_that_stops_matching_falls_back(tmp_path: Path):
    cr.save_compiled_read(tmp_path, cr.CompiledRead(
        domain="books.example", goal="g", goal_hash=cr._goal_hash("books.example", "g"),
        url="https://books.example/attic", fields={"answer": "#price"},
    ))
    with patch.object(cr, "_fetch", return_value="<html><body><p>layout changed</p></body></html>"):
        assert cr.replay_read(tmp_path, "books.example", "g") is None


@pytest.mark.asyncio
async def test_the_effector_tool_answers_a_compiled_read_without_opening_a_browser(tmp_path: Path):
    from nanoagent.agent.tools.effector import EffectorTool

    cr.save_compiled_read(tmp_path, cr.CompiledRead(
        domain="books.example", goal="Find the price", goal_hash=cr._goal_hash("books.example", "Find the price"),
        url="https://books.example/attic", fields={"answer": "#main > p:nth-of-type(1)"},
    ))

    class _NoBrowser:
        def __init__(self, *a, **kw):
            raise AssertionError("a compiled read must not start a browser")

    tool = EffectorTool(workspace=tmp_path, provider=None, model="fake/model")
    with patch.object(cr, "_fetch", return_value=PAGE), \
         patch("nanoagent.agent.effector.browser_session.EffectorSession", _NoBrowser):
        out = json.loads(await tool.execute(goal="Find the price", url="https://books.example/"))
    assert out["success"] is True and out["route"] == "compiled_read"
    assert out["extracted_data"] == {"answer": "£51.77"}
    assert out["turns_executed"] == 0


# Found live 2026-09-20 — both passed the GET proof under v1 and must not compile.
@pytest.mark.parametrize("steps,start", [
    ([{"action": "select", "url_after": "https://h.example/dropdown"}], "https://h.example/dropdown"),
    ([{"action": "click", "url_after": "https://h.example/dynamic"}, {"action": "wait", "url_after": "https://h.example/dynamic"}],
     "https://h.example/dynamic"),
    ([{"action": "click", "url_after": "https://h.example/checkboxes"}], "https://h.example/checkboxes"),
])
def test_runs_that_changed_the_page_in_place_are_not_reads(steps, start):
    assert cr.only_navigation(steps, start) is False


@pytest.mark.parametrize("steps,start", [
    # open a category link
    ([{"action": "click", "url_after": "https://b.example/cat/travel"}], "https://b.example/"),
    # type a search, submit it with a click that navigates
    ([{"action": "type", "url_after": "https://w.example/"}, {"action": "click", "url_after": "https://w.example/search?q=x"}],
     "https://w.example/"),
    # type a search, press Enter
    ([{"action": "type", "url_after": "https://w.example/"}, {"action": "key", "url_after": "https://w.example/wiki/X"}],
     "https://w.example/"),
    # just read the landing page
    ([{"action": "browser_exec", "url_after": "https://n.example/"}], "https://n.example/"),
    ([], "https://n.example/"),
])
def test_runs_that_only_got_somewhere_are_reads(steps, start):
    assert cr.only_navigation(steps, start) is True


def test_a_fragment_change_is_not_navigation():
    assert cr.only_navigation([{"action": "click", "url_after": "https://x.example/p#tab2"}], "https://x.example/p") is False
