"""stage45 doc 04, phase 3 — the shadow-DOM walker, against a real Chromium.

Every other effector test in this suite drives a fake page: a hand-written object
whose evaluate() returns canned element dicts. That works for the Python around the
snapshot, and it is worthless for THIS phase, because the whole of phase 3 is the
JavaScript blob a fake never executes. A fake here would only prove that the Python
copies two dict keys onto a dataclass.

So these run a real browser over real shadow roots. Skipped, not failed, when
Chromium is not installed — the rest of the suite must stay runnable without it.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.resolver import Coordinate, resolve_target


from conftest import requires_chromium

pytestmark = requires_chromium


async def _load(pg, body: str):
    await pg.set_content(f"<!doctype html><html><body style='margin:0'>{body}</body></html>")
    return await capture_dom_snapshot(pg)


# ─── seeing into shadow roots at all ────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_element_in_an_open_shadow_root_is_found(page):
    snap = await _load(page, """
      <button id="light">Light</button>
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'open'})
          .innerHTML = '<button id="inner">Inner</button>';
      </script>
    """)
    names = {e.name for e in snap.elements}
    assert "Inner" in names, "querySelectorAll cannot cross a shadow boundary; the walker must"
    assert "Light" in names, "light DOM must keep working exactly as before"

    inner = next(e for e in snap.elements if e.name == "Inner")
    assert inner.shadow_host == "#host"


@pytest.mark.asyncio
async def test_a_nested_shadow_root_reports_the_outermost_host(page):
    """The host a human would name is the component, not whatever re-shadowed inside."""
    snap = await _load(page, """
      <div id="outer"></div>
      <script>
        const o = document.getElementById('outer').attachShadow({mode:'open'});
        o.innerHTML = '<div id="mid"></div>';
        o.getElementById('mid').attachShadow({mode:'open'})
          .innerHTML = '<button id="deep">Deep</button>';
      </script>
    """)
    deep = next(e for e in snap.elements if e.name == "Deep")
    assert deep.shadow_host == "#outer"


@pytest.mark.asyncio
async def test_a_closed_shadow_root_stays_invisible(page):
    """Not a bug — the documented boundary of this phase. el.shadowRoot is null for
    mode:'closed' and no amount of JavaScript changes that; reaching in needs CDP's
    DOM.getDocument({pierce:true}), which is phase 5 and deliberately unbuilt."""
    snap = await _load(page, """
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'closed'})
          .innerHTML = '<button id="hidden">Hidden</button>';
      </script>
    """)
    assert "Hidden" not in {e.name for e in snap.elements}


# ─── the reason coordinate_only exists ──────────────────────────────────────

@pytest.mark.asyncio
async def test_an_id_shared_by_light_and_shadow_makes_the_shadow_one_coordinate_only(page):
    """Playwright's CSS engine pierces open shadow roots, so an id present in BOTH
    matches two elements and .first silently takes the light one. Counting across
    every root we searched is what makes "unique" mean at capture time what it will
    mean at click time."""
    snap = await _load(page, """
      <button id="dupe">Light Dupe</button>
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'open'})
          .innerHTML = '<button id="dupe">Shadow Dupe</button>';
      </script>
    """)
    shadow = next(e for e in snap.elements if e.name == "Shadow Dupe")
    assert shadow.coordinate_only is True


@pytest.mark.asyncio
async def test_the_coordinate_click_lands_on_the_shadow_element_not_its_light_twin(page):
    """The payoff, end to end. Without the guard this click reports success and hits
    the wrong button — the exact failure the flag exists to prevent."""
    await page.set_content("""
      <!doctype html><html><body style='margin:0'>
      <button id="dupe" onclick="document.getElementById('log').textContent='LIGHT'">Light Dupe</button>
      <div id="host"></div>
      <p id="log">none</p>
      <script>
        const r = document.getElementById('host').attachShadow({mode:'open'});
        r.innerHTML = '<button id="dupe" style="margin:40px">Shadow Dupe</button>';
        r.querySelector('#dupe').onclick = () => document.getElementById('log').textContent = 'SHADOW';
      </script></body></html>
    """)
    snap = await capture_dom_snapshot(page)
    shadow = next(e for e in snap.elements if e.name == "Shadow Dupe")

    resolved = await resolve_target(page, shadow.ref)
    assert isinstance(resolved, Coordinate), "an ambiguous shadow element must not resolve to a Locator"

    await page.mouse.click(resolved.x, resolved.y)
    await page.wait_for_timeout(100)
    assert await page.locator("#log").inner_text() == "SHADOW"


@pytest.mark.asyncio
async def test_a_uniquely_named_shadow_element_keeps_its_locator(page):
    """The flag has to stay narrow. Where a selector IS unambiguous, Playwright's
    auto-wait and actionability checks are worth more than a raw coordinate click,
    and piercing means the locator reaches into the shadow root on its own."""
    snap = await _load(page, """
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'open'})
          .innerHTML = '<button id="only-one">Only One</button>';
      </script>
    """)
    el = next(e for e in snap.elements if e.name == "Only One")
    assert el.coordinate_only is False

    resolved = await resolve_target(page, el.ref)
    assert not isinstance(resolved, Coordinate)
    assert await resolved.count() == 1


# ─── the name ladder inside a shadow root ───────────────────────────────────

@pytest.mark.asyncio
async def test_aria_labelledby_resolves_within_the_elements_own_root(page):
    """ids are scoped to their root: document.getElementById cannot see a label that
    lives inside the same shadow root as the input it labels."""
    snap = await _load(page, """
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({mode:'open'}).innerHTML =
          '<span id="lbl">Card Number</span><input aria-labelledby="lbl">';
      </script>
    """)
    field = next(e for e in snap.elements if e.tag == "input")
    assert field.name == "Card Number"


@pytest.mark.asyncio
async def test_shadow_elements_are_annotated_in_the_model_facing_summary(page):
    snap = await _load(page, """
      <div id="widget"></div>
      <script>
        document.getElementById('widget').attachShadow({mode:'open'})
          .innerHTML = '<button>Pay</button>';
      </script>
    """)
    assert 'in shadow DOM of "#widget"' in snap.summary
