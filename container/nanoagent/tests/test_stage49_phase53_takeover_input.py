"""Phase 5.3 — human input into the agent's browser.

Three properties carry the safety of this feature, and each has a test that fails
loudly if it is ever relaxed:

1. Input is refused unless takeover is armed. A human clicking while the agent is
   mid-action is two drivers on one browser, and the page state that results belongs to
   neither of them.
2. Coordinates are normalised, never pixels. The human clicks a downscaled screenshot
   scaled again to the panel width; a pixel measured there means nothing to the page.
3. The far end is a real browser that may be signed into things, so what arrives from
   outside is checked rather than passed through.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.takeover import TakeoverSession, router


class _Mouse:
    def __init__(self):
        self.calls: list[tuple] = []

    async def move(self, x, y, **kw):
        self.calls.append(("move", x, y))

    async def click(self, x, y, button="left", **kw):
        self.calls.append(("click", x, y, button))

    async def dblclick(self, x, y, **kw):
        self.calls.append(("dblclick", x, y))

    async def wheel(self, dx, dy):
        self.calls.append(("wheel", dx, dy))


class _Keyboard:
    def __init__(self):
        self.calls: list[tuple] = []

    async def insert_text(self, text):
        self.calls.append(("insert_text", text))

    async def press(self, key):
        self.calls.append(("press", key))


class _Page:
    """The surface both lanes share — Playwright's, and remote_page's mirror of it."""

    def __init__(self, width=1280, height=720, mouse=None):
        self.viewport_size = {"width": width, "height": height}
        self.mouse = mouse or _Mouse()
        self.keyboard = _Keyboard()


def _armed(page=None) -> TakeoverSession:
    session = TakeoverSession(page or _Page())
    session.arm("test")
    return session


# ─── 1. the gate ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_input_is_ignored_until_takeover_is_armed():
    """The property that stops a human and an agent driving the same browser at once."""
    page = _Page()
    session = TakeoverSession(page)  # not armed

    await session.handle({"kind": "mouse", "type": "click", "nx": 0.5, "ny": 0.5})
    await session.handle({"kind": "key", "text": "hello"})

    assert page.mouse.calls == []
    assert page.keyboard.calls == []


@pytest.mark.asyncio
async def test_disarming_stops_input_again():
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})
    assert len(page.mouse.calls) == 1

    session.disarm()
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})
    assert len(page.mouse.calls) == 1, "input after disarm must not reach the page"


@pytest.mark.asyncio
async def test_release_ends_the_takeover_and_records_it():
    """5.4 reads `released` to know the human is finished and the agent may resume."""
    session = _armed()
    await router(session)({"t": "release"})

    assert session.released is True
    assert session.armed is False


# ─── 2. coordinates ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_normalised_coordinates_scale_to_the_real_viewport():
    """The human clicked a frame downscaled to 800px wide; the page is 1280."""
    page = _Page(width=1280, height=720)
    session = _armed(page)

    await session.handle({"kind": "mouse", "type": "click", "nx": 0.5, "ny": 0.25})

    assert page.mouse.calls == [("click", 640.0, 180.0, "left")]


@pytest.mark.asyncio
async def test_a_different_viewport_scales_differently():
    page = _Page(width=800, height=600)
    session = _armed(page)
    await session.handle({"kind": "mouse", "nx": 1.0, "ny": 1.0})
    assert page.mouse.calls == [("click", 800.0, 600.0, "left")]


@pytest.mark.asyncio
@pytest.mark.parametrize("nx,ny", [(1.5, 0.5), (-0.1, 0.5), (0.5, 2.0), ("a", 0.5), (None, 0.5)])
async def test_coordinates_outside_the_frame_are_refused_not_clamped(nx, ny):
    """Clamping would land the click somewhere plausible that the human did not choose.
    Out of range means the sender measured against something other than the frame."""
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "mouse", "nx": nx, "ny": ny})
    assert page.mouse.calls == []


# ─── 3. what arrives from outside is checked ──────────────────────────────────

@pytest.mark.asyncio
async def test_an_unknown_mouse_button_is_refused():
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5, "button": "back"})
    assert page.mouse.calls == []


@pytest.mark.asyncio
async def test_typing_goes_through_insert_text():
    """Not per-character key events: insert_text handles IME, emoji and pasted input in
    one call, and is what the extension lane does too."""
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "key", "text": "hunter2"})
    assert page.keyboard.calls == [("insert_text", "hunter2")]


@pytest.mark.asyncio
async def test_only_allowlisted_keys_may_be_pressed():
    """A socket must not be able to drive arbitrary shortcuts in a browser that may be
    signed into things."""
    page = _Page()
    session = _armed(page)

    await session.handle({"kind": "key", "key": "Enter"})
    await session.handle({"kind": "key", "key": "F12"})
    await session.handle({"kind": "key", "key": "Meta"})

    assert page.keyboard.calls == [("press", "Enter")]


@pytest.mark.asyncio
async def test_an_unknown_input_kind_is_ignored():
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "teleport", "nx": 0.5, "ny": 0.5})
    assert page.mouse.calls == [] and page.keyboard.calls == []


# ─── it must never take the run down ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_failing_click_does_not_raise():
    """A human clicking something awkward must not end the run they are rescuing."""
    class Exploding(_Mouse):
        async def click(self, *a, **kw):
            raise RuntimeError("element detached")

    session = _armed(_Page(mouse=Exploding()))
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})  # must not raise


@pytest.mark.asyncio
async def test_a_lane_without_a_wheel_ignores_scroll():
    """The extension exposes no scroll capability; that is a missing feature on that
    lane, not a failed takeover."""
    class NoWheel:
        def __init__(self):
            self.calls = []

        async def click(self, *a, **kw):
            self.calls.append(("click",))

    page = _Page(mouse=NoWheel())
    session = _armed(page)
    await session.handle({"kind": "scroll", "dx": 0, "dy": 100})  # must not raise
    assert page.mouse.calls == []


@pytest.mark.asyncio
async def test_scroll_works_where_the_lane_supports_it():
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "scroll", "dx": 0, "dy": 120})
    assert page.mouse.calls == [("wheel", 0.0, 120.0)]


@pytest.mark.asyncio
async def test_a_page_with_no_viewport_falls_back_rather_than_failing():
    page = _Page()
    page.viewport_size = None
    session = _armed(page)
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})
    assert page.mouse.calls == [("click", 640.0, 360.0, "left")]


# ─── scroll ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scroll_moves_the_pointer_first_so_inner_containers_receive_it():
    """A wheel event goes to whatever is under the pointer. Without the move it always
    hits the document, so a modal body or a long dropdown could never be scrolled."""
    page = _Page(width=1280, height=720)
    session = _armed(page)

    await session.handle({"kind": "scroll", "nx": 0.5, "ny": 0.5, "dx": 0, "dy": 120})

    assert page.mouse.calls == [("move", 640.0, 360.0), ("wheel", 0.0, 120.0)]


@pytest.mark.asyncio
async def test_scroll_without_a_position_still_scrolls():
    """The position is optional — a scroll with none behaves as it did before, moving
    the document rather than refusing."""
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "scroll", "dy": 120})
    assert page.mouse.calls == [("wheel", 0.0, 120.0)]


@pytest.mark.asyncio
async def test_horizontal_scroll_is_carried_too():
    page = _Page()
    session = _armed(page)
    await session.handle({"kind": "scroll", "dx": -40, "dy": 0})
    assert page.mouse.calls == [("wheel", -40.0, 0.0)]


def test_the_scroll_keys_remain_allowed_for_lanes_with_no_wheel():
    """The fallback that makes an out-of-date extension usable rather than stuck: these
    go through input.key, which this lane has always had."""
    from nanoagent.agent.effector.takeover import _ALLOWED_KEYS
    assert {"PageUp", "PageDown", "Home", "End"} <= _ALLOWED_KEYS


# ─── a popup must not leave input stuck on the tab it replaced ────────────────
#
# Found live 2026-09-03: "Continue with Google" opens a new tab, TabManager already
# focuses it, and the human driving kept clicking the ORIGINAL sign-in page — now
# backgrounded and invisible — because TakeoverSession captured `page` once at
# construction and never looked again. Nothing raised; the click just landed nowhere
# the human could see, which is indistinguishable from "clicking does nothing".

@pytest.mark.asyncio
async def test_input_follows_a_popup_when_a_resolver_is_given():
    original = _Page()
    popup = _Page()
    session = TakeoverSession(original, page_resolver=lambda: popup)
    session.arm("test")

    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})

    assert popup.mouse.calls == [("click", 640.0, 360.0, "left")]
    assert original.mouse.calls == [], "the backgrounded tab must not receive the click"


@pytest.mark.asyncio
async def test_typing_and_scrolling_also_follow_the_resolved_page():
    original = _Page()
    popup = _Page()
    session = TakeoverSession(original, page_resolver=lambda: popup)
    session.arm("test")

    await session.handle({"kind": "key", "text": "someone@gmail.com"})
    await session.handle({"kind": "scroll", "dx": 0, "dy": 100})

    assert popup.keyboard.calls == [("insert_text", "someone@gmail.com")]
    assert popup.mouse.calls == [("wheel", 0.0, 100.0)]
    assert original.keyboard.calls == [] and original.mouse.calls == []


@pytest.mark.asyncio
async def test_a_resolver_returning_none_falls_back_to_the_original_page():
    """Between a popup opening and TabManager's `page` event actually firing, the
    resolver may briefly have nothing new to offer — that gap must degrade to the
    known-good page, not to silence."""
    original = _Page()
    session = TakeoverSession(original, page_resolver=lambda: None)
    session.arm("test")

    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})

    assert original.mouse.calls == [("click", 640.0, 360.0, "left")]


@pytest.mark.asyncio
async def test_a_broken_resolver_falls_back_rather_than_dropping_the_input():
    original = _Page()

    def exploding():
        raise RuntimeError("context has no pages")

    session = TakeoverSession(original, page_resolver=exploding)
    session.arm("test")

    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})  # must not raise

    assert original.mouse.calls == [("click", 640.0, 360.0, "left")]


@pytest.mark.asyncio
async def test_no_resolver_at_all_behaves_exactly_as_before():
    """The remote/extension lane has no TabManager and passes no resolver — this must
    stay byte-for-byte the original single-page behaviour."""
    page = _Page()
    session = TakeoverSession(page)  # no page_resolver, same as every earlier test here
    session.arm("test")
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})
    assert page.mouse.calls == [("click", 640.0, 360.0, "left")]


@pytest.mark.asyncio
async def test_a_later_click_follows_the_resolver_across_the_run():
    """The resolver is called fresh on every input, not cached at arm-time — a second
    popup after the first is handed off to just as cleanly as the first was."""
    original = _Page()
    popup_one = _Page()
    popup_two = _Page()
    current = [popup_one]
    session = TakeoverSession(original, page_resolver=lambda: current[0])
    session.arm("test")

    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})
    current[0] = popup_two
    await session.handle({"kind": "mouse", "nx": 0.5, "ny": 0.5})

    assert len(popup_one.mouse.calls) == 1
    assert len(popup_two.mouse.calls) == 1
