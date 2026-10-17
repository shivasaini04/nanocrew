"""Tests for God-Level Pillar 08, 2026-08-23.

Two independent pieces:
1. Iframe traversal — capture_dom_snapshot now queries single-level iframe
   content too (a payment widget, an embedded chat), tagging each element with
   which frame it came from so resolve_target can route through
   page.frame_locator(...).locator(...) instead of the plain page.locator(...)
   that could never see into an iframe at all.
2. Native dialog handling — a real page.on("dialog", ...) listener replaces
   Playwright's previous silent auto-dismiss with a logged, explicit default
   (accept for alert, dismiss for confirm/prompt/beforeunload).

Neither was driven by a live failure this session — both are real gaps found
by reading the code, verified here rather than live.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.browser_session import _handle_dialog
from nanoagent.agent.effector.dom_snapshot import (
    _MAX_EXTRA_FRAMES,
    _frame_origin,
    _frame_selector,
    build_summary,
    capture_dom_snapshot,
)
from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.resolver import resolve_target
from nanoagent.agent.effector.types import Step
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse, FakeSession, ScriptedProvider


# ─── Fakes: a page with one child frame ─────────────────────────────────────

class FakeFrameElement:
    """stage45 doc 04 phase 1: also answers evaluate(_FRAME_OFFSET_JS), which is how
    _frame_origin reads the iframe's content-box origin in its parent's space.
    Pass `offset=False` to model an element whose offset can't be read (detached,
    odd layout) — _frame_origin must return None for that, not a zero origin."""

    def __init__(self, attrs: dict, offset: dict | None = None):
        self._attrs = attrs
        self._offset = offset if offset is not None else {"x": 0, "y": 0, "width": 0, "height": 0}
        self._offset_readable = offset is not False

    async def get_attribute(self, name):
        return self._attrs.get(name)

    async def evaluate(self, script, arg=None):
        if not self._offset_readable:
            raise RuntimeError("offset unreadable")
        return self._offset


class FakeFrame:
    def __init__(
        self, elements: list[dict], frame_attrs: dict | None = None,
        frame_element_raises: bool = False, offset: dict | None = None,
        parent_frame=None,
    ):
        self._elements = elements
        self._frame_attrs = frame_attrs or {}
        self._frame_element_raises = frame_element_raises
        self._offset = offset
        # A real Playwright Frame always exposes parent_frame; only the main frame's
        # is None. _frame_origin walks this chain and sums a hop per level.
        self.parent_frame = parent_frame

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return False
        if "querySelectorAll" in script:
            return self._elements
        return None

    async def frame_element(self):
        if self._frame_element_raises:
            raise RuntimeError("cross-origin frame — frame_element() not available")
        return FakeFrameElement(self._frame_attrs, self._offset)


class FakeFrameLocator:
    def __init__(self, page, frame_selector: str):
        self._page = page
        self._frame_selector = frame_selector

    def locator(self, target_selector):
        matched = target_selector in self._page.frame_content_selectors
        return FakeLocator(self._page, target_selector, matched=matched)


class IframePage:
    """A checkout-style page: a name field on the top page, a card-number
    field inside a single child iframe identified by id="payment-frame"."""

    def __init__(
        self, top_elements: list[dict], frame_elements: list[dict],
        frame_attrs: dict | None = None, extra_frames: int = 0,
        frame_offset: dict | None = None,
    ):
        self.url = "https://example.test/checkout"
        self.viewport_size = {"width": 1280, "height": 720}
        self.actions: list[tuple] = []
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        # The main frame needs parent_frame = None: that is _frame_origin's stop
        # condition, and a bare object() would make getattr fall back to None by
        # accident rather than by contract.
        self.main_frame = FakeFrame([], parent_frame=None)
        self._top_elements = top_elements
        # stage45 doc 04 phase 1: the iframe sits at (240, 180) on the page, so every
        # element inside it must come back shifted by exactly that.
        self._frame_offset = frame_offset if frame_offset is not None else _FRAME_OFFSET
        self._child_frame = FakeFrame(
            frame_elements, {"id": "payment-frame"} if frame_attrs is None else frame_attrs,
            offset=self._frame_offset, parent_frame=self.main_frame,
        )
        self._extra_unidentifiable_frames = [
            FakeFrame([], frame_attrs=None, parent_frame=self.main_frame) for _ in range(extra_frames)
        ]  # frame_element() returns attrs={} -> no id/name/src -> skipped
        self.frame_content_selectors = [e["selector"] for e in frame_elements]

    async def title(self):
        return "Checkout"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return False
        if "querySelectorAll" in script:
            return self._top_elements
        return None

    # A PROPERTY, not a method — because Playwright's Page.frames is a property.
    # This fake had it as a method, and dom_snapshot.py was written to match the fake:
    # `page.frames()` raised TypeError on every real page, a bare except swallowed it,
    # and no iframe content was ever captured in production while this whole file
    # passed. Found 2026-08-29 by running the deployed image against real sites.
    # If this ever goes back to being a method, the bug comes back with it.
    @property
    def frames(self):
        return [self.main_frame, self._child_frame, *self._extra_unidentifiable_frames]

    def frame_locator(self, selector):
        return FakeFrameLocator(self, selector)

    def locator(self, selector):
        return FakeLocator(self, selector, matched=False)  # top-level never sees iframe content

    # Enough of a page for a miss to fall through resolver layers 4-6 and raise
    # cleanly, which is what the self-heal path needs in order to be reached at all.
    def get_by_text(self, text, exact=False):
        return FakeLocator(self, text, matched=False)

    def get_by_role(self, role, name=None):
        return FakeLocator(self, role, matched=False)

    def get_by_label(self, text, exact=False):
        return FakeLocator(self, text, matched=False)

    async def screenshot(self, **kw):
        return b""


class TopPageAlsoHasACardField(IframePage):
    """A checkout the way real ones are built: the top document has its own
    "#card-number" (the saved-card display, say) AND an unnamed payment iframe with a
    field of the same name inside it. Resolving the in-frame element's selector
    against the top page therefore succeeds — on the wrong element."""

    def locator(self, selector):
        return FakeLocator(self, selector, matched=(selector == "#card-number"))


# stage45 doc 04 phase 1: the child iframe's content-box origin on the page.
_FRAME_OFFSET = {"x": 240, "y": 180, "width": 400, "height": 300}

_NAME_FIELD = {
    "tag": "input", "role": "textbox", "name": "Name", "type": "text",
    "selector": "#name", "bounds": {"x": 10, "y": 10, "width": 200, "height": 30},
    "center": {"x": 110, "y": 25}, "isEnabled": True,
}
_CARD_FIELD = {
    "tag": "input", "role": "textbox", "name": "Card Number", "type": "text",
    "selector": "#card-number", "bounds": {"x": 20, "y": 20, "width": 200, "height": 30},
    "center": {"x": 120, "y": 35}, "isEnabled": True,
}


# ─── _frame_selector: best-effort identity for an iframe ────────────────────

@pytest.mark.asyncio
async def test_frame_selector_prefers_id():
    frame = FakeFrame([], {"id": "payment-frame", "name": "payment", "src": "https://stripe.example/x"})
    assert await _frame_selector(frame) == "#payment-frame"


@pytest.mark.asyncio
async def test_frame_selector_falls_back_to_name():
    frame = FakeFrame([], {"name": "payment", "src": "https://stripe.example/x"})
    assert await _frame_selector(frame) == 'iframe[name="payment"]'


@pytest.mark.asyncio
async def test_frame_selector_falls_back_to_src():
    frame = FakeFrame([], {"src": "https://stripe.example/x"})
    assert await _frame_selector(frame) == 'iframe[src="https://stripe.example/x"]'


@pytest.mark.asyncio
async def test_frame_selector_is_none_when_nothing_identifies_it():
    frame = FakeFrame([], {})
    assert await _frame_selector(frame) is None


@pytest.mark.asyncio
async def test_frame_selector_is_none_when_frame_element_raises():
    frame = FakeFrame([], frame_element_raises=True)
    assert await _frame_selector(frame) is None


# ─── capture_dom_snapshot: top + child frame combined ───────────────────────

@pytest.mark.asyncio
async def test_snapshot_includes_elements_from_both_top_page_and_the_iframe():
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    snapshot = await capture_dom_snapshot(page)

    assert len(snapshot.elements) == 2
    name_el = next(e for e in snapshot.elements if e.selector == "#name")
    card_el = next(e for e in snapshot.elements if e.selector == "#card-number")
    assert name_el.frame_selector is None
    assert card_el.frame_selector == "#payment-frame"
    # Continuous ref numbering across top + frame — the model never needs to
    # know which ref came from where.
    assert {name_el.ref, card_el.ref} == {"@e1", "@e2"}


@pytest.mark.asyncio
async def test_a_frame_with_no_identifiable_selector_is_kept_and_marked_coordinate_only():
    """stage45 doc 04 phase 2. This test used to assert the opposite — that a frame
    with no id/name/src has its entire contents dropped. That was the right call
    while an in-frame coordinate was unusable, because keeping the elements would
    have meant offering refs nothing could act on. Phase 1 made the coordinate
    usable, so the contents are kept and flagged instead of discarded."""
    page = IframePage([_NAME_FIELD], [_CARD_FIELD], frame_attrs={})  # no id/name/src
    snapshot = await capture_dom_snapshot(page)

    assert len(snapshot.elements) == 2
    card = next(e for e in snapshot.elements if e.selector == "#card-number")
    assert card.frame_selector is None       # nothing names the frame
    assert card.coordinate_only is True      # ...so the selector must not be tried
    assert (card.center.x, card.center.y) == (360, 215)   # still placed correctly


@pytest.mark.asyncio
async def test_a_named_frame_is_not_marked_coordinate_only():
    """The flag has to be narrow. A frame we CAN name keeps full locator routing —
    Playwright's auto-wait and actionability checks are worth more than a raw click
    wherever they are still available."""
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    snapshot = await capture_dom_snapshot(page)
    card = next(e for e in snapshot.elements if e.selector == "#card-number")
    assert card.frame_selector == "#payment-frame"
    assert card.coordinate_only is False


@pytest.mark.asyncio
async def test_an_unnamed_frame_element_never_resolves_through_the_top_page():
    """The reason coordinate_only is an instruction and not a hint.

    frame_selector=None already means "top-level element" to the resolver, so an
    unnamed frame's element would otherwise be looked up with page.locator(selector)
    against the TOP document. This page is rigged the way a real checkout is: the top
    document also has something matching "#card-number". Without the guard the
    resolver returns that Locator, the executor clicks it, and a card number is typed
    into the wrong field with no error anywhere."""
    from nanoagent.agent.effector.resolver import Coordinate

    page = TopPageAlsoHasACardField([_NAME_FIELD], [_CARD_FIELD], frame_attrs={})
    snapshot = await capture_dom_snapshot(page)
    card_ref = next(e.ref for e in snapshot.elements if e.selector == "#card-number")

    resolved = await resolve_target(page, card_ref)
    assert isinstance(resolved, Coordinate)
    assert (resolved.x, resolved.y) == (360, 215)


@pytest.mark.asyncio
async def test_a_tracking_pixel_frame_is_dropped_before_it_is_queried():
    """Analytics beacons and consent pings are conventionally 0x0 or 1x1. Now that
    unnamed frames are kept, their contents would otherwise compete for dom_pruner's
    element budget against real page content."""
    page = IframePage(
        [_NAME_FIELD], [_CARD_FIELD], frame_attrs={},
        frame_offset={"x": 0, "y": 0, "width": 1, "height": 1},
    )
    snapshot = await capture_dom_snapshot(page)
    assert [e.selector for e in snapshot.elements] == ["#name"]


@pytest.mark.asyncio
async def test_self_healing_onto_an_unnamed_frame_element_also_refuses_the_top_page():
    """The executor carries its own copy of the guard, and this is the path that
    matters more: a self-heal only runs after a selector has ALREADY failed once, so
    a wrong match here is a recovery attempt that confidently does the wrong thing."""
    from nanoagent.agent.effector.executor import ExecutorOptions, _resolve_with_healing
    from nanoagent.agent.effector.resolver import Coordinate
    from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point

    page = TopPageAlsoHasACardField([_NAME_FIELD], [_CARD_FIELD], frame_attrs={})

    # A ref from an older snapshot that a fresh capture no longer has at that index —
    # the real trigger for self-healing. Its content matches the card field, so the
    # anchor heals onto it.
    stale = DOMSnapshot(
        url=page.url, title="Checkout",
        elements=[DOMElementNode(
            ref="@e9", tag="input", role="textbox", name="Card Number", type="text",
            selector="#card-number-old",
            bounds=Bounds(x=0, y=0, width=200, height=30), center=Point(x=100, y=15),
            is_visible=True, is_enabled=True,
        )],
        summary="stale",
    )
    options = ExecutorOptions(self_heal_snapshot=stale)

    resolved = await _resolve_with_healing(page, "@e9", options)

    assert isinstance(resolved, Coordinate)
    assert (resolved.x, resolved.y) == (360, 215)


def test_build_summary_annotates_an_unnamed_iframe_element():
    from nanoagent.agent.effector.types import Bounds, DOMElementNode, Point

    el = DOMElementNode(
        ref="@e2", tag="input", selector="#card-number",
        bounds=Bounds(x=0, y=0, width=1, height=1), center=Point(x=0, y=0),
        is_visible=True, is_enabled=True, frame_selector=None, coordinate_only=True,
    )
    assert "in an unnamed iframe" in build_summary("https://x", "Title", [el])


@pytest.mark.asyncio
async def test_the_shared_fake_element_dicts_are_never_mutated_in_place():
    """Regression guard for the exact bug caught while building this: tagging
    elements with frame_selector must not mutate the raw dicts evaluate()
    returned — a fake (or a real reused list) must survive multiple snapshots."""
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    await capture_dom_snapshot(page)
    await capture_dom_snapshot(page)
    assert "_frame_selector" not in _NAME_FIELD
    assert "_frame_selector" not in _CARD_FIELD


@pytest.mark.asyncio
async def test_extra_frames_beyond_the_cap_are_not_queried():
    page = IframePage([_NAME_FIELD], [_CARD_FIELD], extra_frames=_MAX_EXTRA_FRAMES + 3)
    # Must not raise / hang regardless of how many extra frames exist — the
    # cap bounds cost, doesn't need exact-count verification beyond "it ran".
    snapshot = await capture_dom_snapshot(page)
    assert len(snapshot.elements) == 2  # name + card — extras contributed nothing


@pytest.mark.asyncio
async def test_capture_dom_snapshot_degrades_gracefully_on_a_page_with_no_frame_support():
    """A page object with no .frames()/.main_frame at all (every existing fake
    in this test suite) must still work exactly as before this pillar."""
    class BarePage:
        url = "https://example.test/x"
        viewport_size = {"width": 1280, "height": 720}

        async def title(self):
            return "Bare"

        async def evaluate(self, script, arg=None):
            if "MutationObserver" in script:
                return True
            if 'role="listbox"' in script:
                return False
            if "querySelectorAll" in script:
                return [_NAME_FIELD]
            return None

    snapshot = await capture_dom_snapshot(BarePage())
    assert len(snapshot.elements) == 1
    assert snapshot.elements[0].frame_selector is None


def test_build_summary_annotates_an_iframe_element():
    from nanoagent.agent.effector.types import Bounds, DOMElementNode, Point

    el = DOMElementNode(
        ref="@e2", tag="input", selector="#card-number",
        bounds=Bounds(x=0, y=0, width=1, height=1), center=Point(x=0, y=0),
        is_visible=True, is_enabled=True, frame_selector="#payment-frame",
    )
    summary = build_summary("https://x", "Title", [el])
    assert 'in iframe "#payment-frame"' in summary


# ─── resolve_target: routes through the right frame ─────────────────────────

@pytest.mark.asyncio
async def test_resolve_target_routes_a_frame_scoped_ref_through_frame_locator():
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    # Which literal ref (@e1 vs @e2) lands on the card field depends on element
    # order, not something to hardcode — find it via a real snapshot first.
    snapshot = await capture_dom_snapshot(page)
    card_ref = next(e.ref for e in snapshot.elements if e.selector == "#card-number")

    resolved = await resolve_target(page, card_ref)
    assert resolved._selector == "#card-number"


@pytest.mark.asyncio
async def test_resolve_target_falls_back_to_a_page_absolute_coordinate_inside_a_frame():
    """stage45 doc 04 phase 1. This test used to assert the opposite: that an
    in-frame ref whose selector no longer resolves must RAISE, because its
    coordinates were measured in the frame's own viewport and clicking them at page
    level would land somewhere real and wrong. That reasoning was correct for as
    long as it was true. capture_dom_snapshot now shifts in-frame coordinates into
    page space before they ever reach the resolver, so the honest answer flipped
    from "refuse" to "click it"."""
    from nanoagent.agent.effector.resolver import Coordinate

    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    page.frame_content_selectors = []  # nothing actually resolves inside the frame

    snapshot = await capture_dom_snapshot(page)
    card_ref = next(e.ref for e in snapshot.elements if e.selector == "#card-number")

    resolved = await resolve_target(page, card_ref)
    assert isinstance(resolved, Coordinate)
    # frame-local centre (120, 35) + frame origin (240, 180)
    assert (resolved.x, resolved.y) == (360, 215)


@pytest.mark.asyncio
async def test_the_fake_page_exposes_frames_the_way_playwright_does():
    """The regression guard for the bug this file did not catch for six days.

    Playwright's Page.frames is a property. This fake had it as a method, and the
    production code was written against the fake, so `page.frames()` raised TypeError on
    every real page, a bare except turned that into "no frames", and every iframe on
    every page was silently dropped — while all nineteen tests here passed.

    Asserting the shape here is what stops the double drifting from the real API again."""
    from playwright.async_api import Page

    assert isinstance(Page.frames, property), "Playwright changed its API — check the fake"
    assert isinstance(type(IframePage([], [])).frames, property), (
        "the fake must expose .frames as a property, exactly as Playwright does"
    )


@pytest.mark.asyncio
async def test_frame_enumeration_failing_does_not_take_the_whole_snapshot_down():
    """The other half: when frames genuinely cannot be enumerated, the top document must
    still come back. This is the degrade the bare except was written for — it was right
    about that and wrong to also swallow a TypeError in silence."""
    class ExplodingFrames(IframePage):
        @property
        def frames(self):
            raise RuntimeError("frame tree unavailable")

    snap = await capture_dom_snapshot(ExplodingFrames([_NAME_FIELD], [_CARD_FIELD]))
    assert [e.selector for e in snap.elements] == ["#name"]


# ─── stage45 doc 04, phase 1: page-absolute geometry ────────────────────────

@pytest.mark.asyncio
async def test_in_frame_coordinates_are_shifted_into_page_space():
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    snapshot = await capture_dom_snapshot(page)
    card = next(e for e in snapshot.elements if e.selector == "#card-number")

    assert (card.center.x, card.center.y) == (120 + 240, 35 + 180)
    assert (card.bounds.x, card.bounds.y) == (20 + 240, 20 + 180)
    # width/height describe the element, not its position — never shifted.
    assert (card.bounds.width, card.bounds.height) == (200, 30)
    # the frame's own rect survives, so the shift is reversible
    assert card.frame_bounds is not None
    assert (card.frame_bounds.x, card.frame_bounds.y) == (240, 180)
    assert (card.frame_bounds.width, card.frame_bounds.height) == (400, 300)


@pytest.mark.asyncio
async def test_top_level_elements_are_untouched_and_carry_no_frame_bounds():
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])
    snapshot = await capture_dom_snapshot(page)
    name = next(e for e in snapshot.elements if e.selector == "#name")

    assert (name.center.x, name.center.y) == (110, 25)
    assert (name.bounds.x, name.bounds.y) == (10, 10)
    assert name.frame_bounds is None


@pytest.mark.asyncio
async def test_a_frame_whose_offset_cannot_be_read_is_dropped_not_placed_at_zero():
    """A frame we can name but cannot place is worse than one we skip: its elements
    would get refs, reach the model, and resolve to coordinates measured from the
    wrong origin — a click that lands somewhere real and wrong, with no error."""
    page = IframePage([_NAME_FIELD], [_CARD_FIELD], frame_offset=False)
    snapshot = await capture_dom_snapshot(page)

    assert [e.selector for e in snapshot.elements] == ["#name"]


@pytest.mark.asyncio
async def test_nested_frame_offsets_are_summed_up_the_whole_chain():
    """Depth is handled by construction, not by a special case — which is why the
    'single-level only' limit disappears rather than being raised to two."""
    main = FakeFrame([], parent_frame=None)
    outer = FakeFrame([], {"id": "outer"}, offset={"x": 100, "y": 50, "width": 500, "height": 400}, parent_frame=main)
    inner = FakeFrame([], {"id": "inner"}, offset={"x": 16, "y": 8, "width": 200, "height": 120}, parent_frame=outer)

    origin = await _frame_origin(inner)
    assert (origin.x, origin.y) == (116, 58)
    # the reported size is the INNER frame's own box, not the outer one's
    assert (origin.width, origin.height) == (200, 120)


@pytest.mark.asyncio
async def test_frame_origin_is_zero_for_the_main_frame():
    main = FakeFrame([], parent_frame=None)
    origin = await _frame_origin(main)
    assert (origin.x, origin.y) == (0, 0)


@pytest.mark.asyncio
async def test_frame_origin_gives_up_on_a_cyclic_parent_chain():
    a = FakeFrame([], {"id": "a"}, offset={"x": 1, "y": 1, "width": 10, "height": 10})
    b = FakeFrame([], {"id": "b"}, offset={"x": 1, "y": 1, "width": 10, "height": 10})
    a.parent_frame = b
    b.parent_frame = a

    assert await _frame_origin(a) is None


@pytest.mark.asyncio
async def test_frame_origin_is_none_when_frame_element_raises():
    main = FakeFrame([], parent_frame=None)
    frame = FakeFrame([], {"id": "x"}, frame_element_raises=True, parent_frame=main)
    assert await _frame_origin(frame) is None


# ─── End-to-end through EffectorTool: fill a field inside an iframe ─────────

@pytest.mark.asyncio
async def test_effector_tool_types_into_a_field_inside_an_iframe(tmp_path: Path):
    page = IframePage([_NAME_FIELD], [_CARD_FIELD])

    class IframeSession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    snapshot = await capture_dom_snapshot(page)
    card_ref = next(e.ref for e in snapshot.elements if e.selector == "#card-number")

    provider = ScriptedProvider([
        {"thought": "fill card number", "action": "type", "target": card_ref, "text": "4242424242424242"},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision", use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", IframeSession):
        raw = await tool.execute(goal="fill the card number field")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns"][0]["status"] == "success"
    assert ("fill", "#card-number", "4242424242424242") in page.actions


# ─── Native dialog handling ──────────────────────────────────────────────────

class FakeDialog:
    def __init__(self, dialog_type: str, message: str):
        self.type = dialog_type
        self.message = message
        self.accept = AsyncMock()
        self.dismiss = AsyncMock()


@pytest.mark.asyncio
async def test_handle_dialog_accepts_a_plain_alert():
    dialog = FakeDialog("alert", "Saved successfully")
    await _handle_dialog(dialog)
    dialog.accept.assert_awaited_once()
    dialog.dismiss.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_dialog_dismisses_a_confirm():
    dialog = FakeDialog("confirm", "Delete this item?")
    await _handle_dialog(dialog)
    dialog.dismiss.assert_awaited_once()
    dialog.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_dialog_dismisses_a_prompt():
    dialog = FakeDialog("prompt", "Enter your name")
    await _handle_dialog(dialog)
    dialog.dismiss.assert_awaited_once()


@pytest.mark.asyncio
async def test_handle_dialog_dismisses_beforeunload():
    dialog = FakeDialog("beforeunload", "")
    await _handle_dialog(dialog)
    dialog.dismiss.assert_awaited_once()


@pytest.mark.asyncio
async def test_handle_dialog_never_raises_even_if_the_dialog_object_is_broken():
    class BrokenDialog:
        type = "confirm"
        message = "x"

        async def dismiss(self):
            raise RuntimeError("already handled")

    await _handle_dialog(BrokenDialog())  # must not raise
