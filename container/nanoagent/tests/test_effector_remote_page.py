"""RemotePage — the container's half of the real-browser lane (stage45 doc 05 phase 3).

The browser half is covered by the spikes, which need a real Chrome and a real extension.
This covers what those cannot: that a DOMSnapshot assembled from broker responses is
identical in shape to a local one, that frames are placed or dropped rather than misplaced,
and that the members this lane refuses fail loudly instead of quietly doing nothing.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.remote_page import (
    NotSupportedOnRemoteLane,
    RemoteConfig,
    RemoteLaneUnavailable,
    RemotePage,
)

CFG = RemoteConfig(host="http://orchestrator", agent_id="agent-1", cycle_token="tok", controller_id="ctl-1")


def _el(name, tag="button", x=10, y=20, **over):
    return {
        "tag": tag, "role": tag, "name": name, "selector": f"#{name.lower().replace(' ', '-')}",
        "bounds": {"x": x, "y": y, "width": 100, "height": 30},
        "center": {"x": x + 50, "y": y + 15}, "isEnabled": True, **over,
    }


class FakeRemotePage(RemotePage):
    """A RemotePage whose transport is a script instead of a broker."""

    def __init__(self, responses: dict, cfg: RemoteConfig = CFG):
        super().__init__(cfg)
        self._responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def _dispatch(self, capability, payload=None):  # type: ignore[override]
        self.calls.append((capability, payload or {}))
        key = (payload or {}).get("probe") or capability
        value = self._responses.get(key)
        if isinstance(value, Exception):
            raise value
        return value


def _page(top_elements, frames=None, origins=None):
    frames = frames or []
    origins = origins if origins is not None else [{"frameId": 0, "result": {"x": 0, "y": 0}}]
    return FakeRemotePage({
        "page.info": {"url": "https://app.example/dash", "title": "Dash", "viewport": {"width": 1280, "height": 720}},
        "installFrameBridge": [{"frameId": 0, "result": True}],
        "seedFrames": [{"frameId": 0, "result": True}],
        "frameOrigin": origins,
        "snapshot": [{"frameId": 0, "result": top_elements}, *frames],
    })


# ─── the snapshot ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_capture_dom_snapshot_routes_to_the_remote_lane():
    """One branch in capture_dom_snapshot is what lets the loop, the resolver, self-heal
    and escalation all keep working without knowing which lane they are on."""
    page = _page([_el("Save")])
    snap = await capture_dom_snapshot(page)

    assert snap.url == "https://app.example/dash"
    assert [e.name for e in snap.elements] == ["Save"]
    assert "page.probe" in [c[0] for c in page.calls]


@pytest.mark.asyncio
async def test_every_element_is_coordinate_only():
    """There is no Locator engine on the other side, so a selector has nothing to resolve
    through. This flag is what sends the resolver down the coordinate path it already has."""
    snap = await capture_dom_snapshot(_page([_el("Save")]))
    assert all(e.coordinate_only for e in snap.elements)


@pytest.mark.asyncio
async def test_in_frame_elements_are_shifted_into_page_space():
    page = _page(
        [_el("Save")],
        frames=[{"frameId": 7, "result": [_el("Card number", tag="input", x=16, y=44)]}],
        origins=[{"frameId": 0, "result": {"x": 0, "y": 0}}, {"frameId": 7, "result": {"x": 240, "y": 180}}],
    )
    snap = await capture_dom_snapshot(page)
    card = next(e for e in snap.elements if e.name == "Card number")

    assert (card.center.x, card.center.y) == (16 + 50 + 240, 44 + 15 + 180)
    assert (card.bounds.x, card.bounds.y) == (256, 224)
    assert card.frame_bounds is not None


@pytest.mark.asyncio
async def test_a_frame_that_could_not_be_placed_is_dropped_not_placed_at_zero():
    """The same rule as the local lane. A wrong coordinate clicks something real, so an
    unplaceable frame loses its elements for this turn rather than getting bad ones."""
    page = _page(
        [_el("Save")],
        frames=[{"frameId": 9, "result": [_el("Ghost", tag="input")]}],
        origins=[{"frameId": 0, "result": {"x": 0, "y": 0}}, {"frameId": 9, "result": None}],
    )
    snap = await capture_dom_snapshot(page)
    assert [e.name for e in snap.elements] == ["Save"]


@pytest.mark.asyncio
async def test_shadow_and_occlusion_survive_the_bridge():
    page = _page([
        _el("Pay", shadowHost="#widget"),
        _el("Hidden", isOccluded=True),
    ])
    snap = await capture_dom_snapshot(page)
    assert next(e for e in snap.elements if e.name == "Pay").shadow_host == "#widget"
    assert next(e for e in snap.elements if e.name == "Hidden").is_occluded is True


@pytest.mark.asyncio
async def test_the_frame_bridge_is_re_seeded_before_every_snapshot_of_a_framed_page():
    """Origins are viewport-relative and go stale on any scroll — phase 0 measured a child
    900px wrong when the tree was seeded once. Seeding must happen per snapshot.

    Narrowed 2026-09-21 to say "of a framed page". The rule was written for child frames
    and asserted for every page, which is what it should keep doing HERE — a stage 63
    change that skipped seeding while still reading origins would have read stale ones
    and clicked in the wrong place, and this test is what caught it.
    """
    page = _page(
        [_el("Save")],
        frames=[{"frameId": 7, "result": [_el("Card number", tag="input")]}],
        origins=[{"frameId": 0, "result": {"x": 0, "y": 0}},
                 {"frameId": 7, "result": {"x": 240, "y": 180}}],
    )
    await capture_dom_snapshot(page)
    await capture_dom_snapshot(page)
    probes = [c[1].get("probe") for c in page.calls if c[0] == "page.probe"]
    assert probes.count("seedFrames") == 2


@pytest.mark.asyncio
async def test_a_page_with_no_frames_is_not_re_seeded_every_time():
    """Nothing to place, so placing it is a round trip for nothing.

    On the user's own machine each probe is roughly 600 ms, and looking at the page cost
    six of them every turn. A page with no child frames needs none of the frame work
    after the first look proves there are no frames.
    """
    page = _page([_el("Save")])
    await capture_dom_snapshot(page)
    await capture_dom_snapshot(page)
    probes = [c[1].get("probe") for c in page.calls if c[0] == "page.probe"]
    assert probes.count("seedFrames") == 1
    assert probes.count("frameOrigin") == 1


# ─── input ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mouse_and_keyboard_map_onto_the_wire_primitives():
    page = _page([_el("Save")])
    await page.mouse.click(120, 240)
    await page.keyboard.type("hello@example.com")
    await page.keyboard.press("Enter")

    assert ("input.mouse", {"type": "click", "x": 120, "y": 240, "button": "left", "clickCount": 1}) in page.calls
    assert ("input.key", {"text": "hello@example.com"}) in page.calls
    assert ("input.key", {"key": "Enter"}) in page.calls


# ─── what it refuses ────────────────────────────────────────────────────────

@pytest.mark.parametrize("member", ["locator", "frame_locator", "get_by_role", "get_by_text", "get_by_label"])
def test_locator_members_refuse_loudly(member):
    """Silence here would be the bad outcome: a resolver layer that quietly returns nothing
    looks like "element not found" and sends the loop to the vision fallback for a reason
    that has nothing to do with the page."""
    page = RemotePage(CFG)
    with pytest.raises(NotSupportedOnRemoteLane, match="Locator is an engine|does not exist"):
        getattr(page, member)("#anything")


@pytest.mark.asyncio
async def test_evaluate_refuses_and_says_why():
    page = RemotePage(CFG)
    with pytest.raises(NotSupportedOnRemoteLane, match="CSP"):
        await page.evaluate("() => 1")


# ─── configuration ──────────────────────────────────────────────────────────

def test_the_lane_is_off_unless_fully_configured(monkeypatch):
    """"No remote browser" is the ordinary case, not an error — from_env returns None so
    the caller falls back to the container's own Chromium rather than raising."""
    for var in ("NC_BROWSER_CONTROLLER_ID", "NANOCREW_CYCLE_TOKEN", "AGENT_ID", "NanoCrew_HOST", "NANOCREW_HOST"):
        monkeypatch.delenv(var, raising=False)
    assert RemoteConfig.from_env() is None

    monkeypatch.setenv("NC_BROWSER_CONTROLLER_ID", "ctl")
    monkeypatch.setenv("AGENT_ID", "a")
    monkeypatch.setenv("NanoCrew_HOST", "http://host:3002/")
    assert RemoteConfig.from_env() is None, "a partial configuration must not half-enable the lane"

    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    cfg = RemoteConfig.from_env()
    assert cfg is not None and cfg.host == "http://host:3002"


@pytest.mark.asyncio
async def test_no_connected_browser_is_reported_as_unavailable_not_a_crash():
    page = FakeRemotePage({"page.info": RemoteLaneUnavailable("no browser is connected for this owner")})
    with pytest.raises(RemoteLaneUnavailable, match="no browser is connected"):
        await page.refresh_info()
