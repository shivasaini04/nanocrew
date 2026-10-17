"""An extract whose selectors all miss must read the page, not return nothing.

The target path already worked this way, and its comment in executor.py records why: an
empty answer sends the model round the loop asking for the same text, four identical turns
measured. The schema path never got that fix — and it is the one a model reaches for
first. Asked for "the first post" it invents field->selector guesses, and on a site that
renames its classes every guess misses.

Seen live 2026-09-06 on a LinkedIn feed: the session was valid, the page was loaded, the
page text held 5,220 characters INCLUDING the post — and the agent concluded the tool could
not read dynamic content, because every selector it guessed matched nothing and it got {}.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.executor import execute_step
from nanoagent.agent.effector.types import Step


class _RemotePageStub:
    """Just enough of the remote lane for the extract branch."""

    def __init__(self, selector_hits=None, page_text="the whole page, including a post"):
        self._hits = selector_hits or {}
        self._page_text = page_text
        self.text_calls = 0

    async def nc_extract_selectors(self, selectors):
        return {s: self._hits[s] for s in selectors if s in self._hits}

    async def nc_text(self, point=None):
        self.text_calls += 1
        return self._page_text

    url = "https://example.com/"


async def _extract(page, schema):
    """Run one extract step and hand back its data.

    execute_step never raises — failures arrive as a StepResult — so the assertions below
    read `.data`, and a step that failed shows up as empty rather than as an exception.
    """
    res = await execute_step(
        Step(step=1, action="extract", description="read it", extract_schema=schema),
        page,
    )
    return getattr(res, "data", None) or {}


@pytest.mark.asyncio
async def test_matching_selectors_still_win():
    """The fallback must not paper over a schema that worked."""
    page = _RemotePageStub(selector_hits={"h1.title": "Real Heading"})
    out = await _extract(page, {"heading": "h1.title"})

    assert out == {"heading": "Real Heading"}
    assert page.text_calls == 0, "the page should not be read when the schema matched"


@pytest.mark.asyncio
async def test_a_schema_that_matches_nothing_reads_the_page():
    """The bug. Every guess missed, and the model got {} back."""
    page = _RemotePageStub(selector_hits={})
    out = await _extract(page, {"post": "div.feed-shared-update-v2"})

    assert out.get("text"), "an all-miss schema must fall back to the page text"
    assert "including a post" in out["text"]
    assert page.text_calls == 1


@pytest.mark.asyncio
async def test_a_partial_match_is_kept_as_is():
    """One field found is a real answer. Falling back would throw away what DID match and
    replace two named fields with one blob of page text."""
    page = _RemotePageStub(selector_hits={"h1": "Found"})
    out = await _extract(page, {"a": "h1", "b": "div.missing"})

    assert out == {"a": "Found"}
    assert page.text_calls == 0
