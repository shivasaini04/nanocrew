"""stage45 doc 04, phase 4 — occlusion, against a real Chromium.

The failure this exists to catch: a cookie banner or an open modal sits over a form.
The fields underneath do not vanish from querySelectorAll — they stay visible,
enabled and correctly positioned — and the click lands on the overlay. No exception,
no navigation, nothing in the log. It reads as "the model clicked the wrong thing"
and it is a perception bug.

Like the shadow-DOM phase, this is JavaScript, so a fake page cannot test it: the
hit-test is the browser's own, and the whole point is that our own idea of "visible"
disagreed with it. Skipped, not failed, without Chromium.
"""

from __future__ import annotations

import pytest

from conftest import requires_chromium
from nanoagent.agent.effector.dom_pruner import prune_dom_snapshot
from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot

pytestmark = requires_chromium


async def _load(pg, body: str):
    await pg.set_content(f"<!doctype html><html><body style='margin:0'>{body}</body></html>")
    return await capture_dom_snapshot(pg)


_FORM = """
  <form>
    <input id="email" placeholder="Email">
    <input id="card" placeholder="Card">
    <button id="submit">Submit</button>
  </form>
"""

_BANNER = """
  <div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9">
    <button id="accept" style="margin:200px">Accept cookies</button>
  </div>
"""


# ─── the core case ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fields_under_a_cookie_banner_are_marked_covered(page):
    snap = await _load(page, _FORM + _BANNER)
    covered = {e.selector for e in snap.elements if e.is_occluded}
    assert covered == {"#email", "#card", "#submit"}


@pytest.mark.asyncio
async def test_the_overlays_own_control_is_not_marked_covered(page):
    """The half that makes the feature useful rather than merely correct: whatever is
    on top has to stay clickable, or the agent has no way out of the state."""
    snap = await _load(page, _FORM + _BANNER)
    accept = next(e for e in snap.elements if e.selector == "#accept")
    assert accept.is_occluded is False


@pytest.mark.asyncio
async def test_the_model_is_shown_only_the_way_out(page):
    """What the agent actually sees. Dropping the covered fields leaves the banner's
    own button as the visible affordance — dismiss it, and the form is back next
    turn. Showing all four would offer three clicks that silently do nothing."""
    snap = await _load(page, _FORM + _BANNER)
    assert [e.selector for e in prune_dom_snapshot(snap).elements] == ["#accept"]


@pytest.mark.asyncio
async def test_dismissing_the_overlay_clears_the_flag(page):
    await _load(page, _FORM + _BANNER)
    await page.evaluate("document.getElementById('banner').remove()")

    snap = await capture_dom_snapshot(page)
    assert not any(e.is_occluded for e in snap.elements)
    assert {e.selector for e in snap.elements} == {"#email", "#card", "#submit"}


# ─── the false positives that would matter most ─────────────────────────────

@pytest.mark.asyncio
async def test_an_element_whose_centre_is_below_the_fold_is_not_marked_covered(page):
    """elementFromPoint returns null outside the viewport. Reading that as "covered"
    would prune away everything the agent is meant to scroll down to — a far worse
    bug than the one this phase fixes, and an invisible one."""
    await page.set_viewport_size({"width": 800, "height": 600})
    snap = await _load(page, """
      <div style="height:560px"></div>
      <button id="tall" style="height:400px;width:200px">Centre is past the fold</button>
    """)
    tall = next(e for e in snap.elements if e.selector == "#tall")
    assert tall.is_occluded is False


@pytest.mark.asyncio
async def test_an_element_covered_by_its_own_child_is_not_marked_covered(page):
    """A button's centre almost always hits an inner span, not the button. Without
    the contains() checks every wrapping element on every page would be 'covered'."""
    snap = await _load(page, '<button id="wrap"><span>Inner span</span></button>')
    assert next(e for e in snap.elements if e.selector == "#wrap").is_occluded is False


@pytest.mark.asyncio
async def test_an_input_inside_a_padded_label_is_not_marked_covered(page):
    """The hit can also be an ANCESTOR — a label wrapping its input. Also not covered."""
    snap = await _load(page, '<label style="display:block;padding:20px">Email <input id="in"></label>')
    assert next(e for e in snap.elements if e.selector == "#in").is_occluded is False


@pytest.mark.asyncio
async def test_a_shadow_element_is_hit_tested_through_its_own_root(page):
    """document.elementFromPoint retargets to the outermost host, and a host never
    contains() its own shadow children, so hit-testing a component's contents against
    the document would mark every single one of them covered."""
    snap = await _load(page, """
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'open'})
          .innerHTML = '<button id="sb">Shadow</button>';
      </script>
    """)
    sb = next(e for e in snap.elements if e.selector == "#sb")
    assert sb.shadow_host == "#host"
    assert sb.is_occluded is False


# ─── the safety valve ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_pruner_keeps_covered_elements_when_everything_is_covered(page):
    """A full-viewport scrim with no controls of its own covers the whole page. An
    agent shown an empty element list is worse off than one shown a covered element
    it can at least try, so the filter only applies while something survives it."""
    snap = await _load(page, _FORM + """
      <div id="scrim" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9"></div>
    """)
    assert all(e.is_occluded for e in snap.elements), "premise: the scrim covers everything"

    kept = {e.selector for e in prune_dom_snapshot(snap).elements}
    assert kept == {"#email", "#card", "#submit"}


@pytest.mark.asyncio
async def test_covered_elements_are_annotated_in_the_full_summary(page):
    """The pruner drops these before the prompt, so this shows up in the full snapshot
    the escalation and self-heal paths read — where the reason something is
    unclickable should be stated rather than inferred."""
    snap = await _load(page, _FORM + _BANNER)
    assert "[covered]" in snap.summary
