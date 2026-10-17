"""Stage 63 — fewer hops to look at the page in the user's own browser.

Every probe on this lane is a network hop to the founder's machine, measured at roughly
600 ms. Looking at the page cost five of them EVERY turn, so a six-turn run spent 12–18 s
just looking.

Six, in fact — refresh, installFrameBridge, seedFrames, frameOrigin, snapshot,
pageContent. Two are avoidable: the frame bridge is per DOCUMENT rather than per look,
and frame origins only mean anything on a page that HAS child frames. The remaining
three each read something that genuinely changes every turn.

These count probes, not seconds — the hop count is what the code controls.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage


class Recording(RemotePage):
    """A RemotePage whose dispatches are recorded instead of sent."""

    def __init__(self, frames):
        super().__init__(RemoteConfig(host="http://x", agent_id="a", cycle_token="t", controller_id="c"))
        self.probes: list[str] = []
        self._frames = frames
        self._url = "https://music.youtube.com/"

    async def refresh_info(self):
        self.probes.append("refresh")

    async def _dispatch(self, capability, payload=None):
        probe = (payload or {}).get("probe", capability)
        self.probes.append(probe)
        if probe == "snapshot":
            return self._frames
        if probe == "frameOrigin":
            return [{"frameId": 1, "result": {"x": 10, "y": 20}}]
        if probe == "pageContent":
            return {"text": "", "html": ""}
        return []


def main_frame_only():
    return [{"frameId": 0, "result": [
        {"tag": "input", "name": "Search", "bounds": {"x": 1, "y": 2, "width": 3, "height": 4},
         "center": {"x": 2, "y": 3}, "selector": "input"},
    ]}]


def with_child_frame():
    return main_frame_only() + [{"frameId": 1, "result": [
        {"tag": "button", "name": "Play", "bounds": {"x": 5, "y": 6, "width": 7, "height": 8},
         "center": {"x": 6, "y": 7}, "selector": "button"},
    ]}]


@pytest.mark.asyncio
async def test_the_first_look_still_sets_the_frame_bridge_up():
    page = Recording(main_frame_only())
    await page.nc_remote_snapshot()
    assert page.probes == ["refresh", "installFrameBridge", "seedFrames",
                           "frameOrigin", "snapshot", "pageContent"]


@pytest.mark.asyncio
async def test_looking_again_at_the_same_page_costs_two_hops_not_five():
    page = Recording(main_frame_only())
    await page.nc_remote_snapshot()
    page.probes.clear()

    await page.nc_remote_snapshot()

    assert page.probes == ["refresh", "snapshot", "pageContent"], (
        f"a second look should not rebuild the bridge or ask for origins, got {page.probes}"
    )


@pytest.mark.asyncio
async def test_a_page_with_frames_re_places_them_on_every_look():
    """The whole frame dance runs every time on a framed page.

    A first version of this optimisation kept only installFrameBridge per document and
    still read the origins. The suite caught it: seedFrames is the RE-PLACE step, and
    phase 0 measured a child frame 900 px wrong when the tree was seeded once. Stale
    origins click in the wrong place, which is worse than being slow."""
    page = Recording(with_child_frame())
    await page.nc_remote_snapshot()
    page.probes.clear()

    await page.nc_remote_snapshot()

    assert page.probes == ["refresh", "installFrameBridge", "seedFrames",
                           "frameOrigin", "snapshot", "pageContent"]


@pytest.mark.asyncio
async def test_navigating_rebuilds_the_bridge():
    page = Recording(main_frame_only())
    await page.nc_remote_snapshot()
    page._url = "https://music.youtube.com/search?q=x"
    page.probes.clear()

    await page.nc_remote_snapshot()

    assert "installFrameBridge" in page.probes, "a new document needs its bridge placed"
    assert "seedFrames" in page.probes
    assert "frameOrigin" in page.probes, "a new document is unknown until a look proves otherwise"


@pytest.mark.asyncio
async def test_elements_are_still_placed_correctly_with_frames():
    page = Recording(with_child_frame())
    snap = await page.nc_remote_snapshot()

    by_name = {e.name: e for e in snap.elements}
    assert by_name["Search"].center.x == 2      # main frame, no offset
    assert by_name["Play"].center.x == 6 + 10   # child frame, origin applied
    assert by_name["Play"].center.y == 7 + 20


@pytest.mark.asyncio
async def test_a_frame_that_appears_later_is_dropped_not_misplaced():
    """One look after a frame appears we have no origin for it. Dropping is the
    existing rule and the safe one: a wrong coordinate clicks something real."""
    page = Recording(main_frame_only())
    await page.nc_remote_snapshot()          # learns: no child frames
    page._frames = with_child_frame()
    page.probes.clear()

    snap = await page.nc_remote_snapshot()   # origins not fetched this time

    assert "frameOrigin" not in page.probes
    assert [e.name for e in snap.elements] == ["Search"], "the unplaceable frame leaked in"

    # ...and the look after that asks for origins again, so it recovers.
    page.probes.clear()
    snap = await page.nc_remote_snapshot()
    assert "frameOrigin" in page.probes
    assert sorted(e.name for e in snap.elements) == ["Play", "Search"]
