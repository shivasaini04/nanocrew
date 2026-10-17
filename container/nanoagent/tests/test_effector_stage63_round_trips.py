"""Stage 63 — on the user's own browser, the cost is ROUND TRIPS, not thinking.

In the container a mouse move is about a millisecond, so an "organic" 16-point path is
free and typing a character at a time is free. Over the bridge to the user's machine each
of those is a network hop of roughly 600 ms.

Measured live 2026-09-21 on music.youtube.com:

    click   17 hops (16 moves + click)   10.1 s
    type    25 hops (one per character)  19.4 s

So these tests count CALLS, not seconds. Wall time depends on the founder's network and
cannot be asserted here; the number of hops is the thing the code controls, and it is
what makes the difference.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, _move_and_click, _type_text
from nanoagent.agent.effector.resolver import Coordinate


class CountingMouse:
    def __init__(self, log):
        self.log = log

    async def move(self, x, y, **kw):
        self.log.append("move")

    async def click(self, x, y, **kw):
        self.log.append("click")

    async def dblclick(self, x, y, **kw):
        self.log.append("dblclick")


class CountingKeyboard:
    def __init__(self, log):
        self.log = log

    async def type(self, text, delay=None):
        # One entry per call, so a per-character loop is visible as many entries.
        self.log.append(f"type:{text}")


class CountingPage:
    """A page that records every call that would cross the bridge."""

    def __init__(self):
        self.log: list[str] = []
        self.mouse = CountingMouse(self.log)
        self.keyboard = CountingKeyboard(self.log)

    async def wait_for_timeout(self, ms):
        self.log.append("wait")


@pytest.mark.asyncio
async def test_a_click_is_one_hop_when_the_site_does_not_fingerprint():
    page = CountingPage()
    await _move_and_click(page, ExecutorOptions(use_human_cadence=False), Coordinate(x=100, y=200))

    hops = [c for c in page.log if c in ("move", "click", "dblclick")]
    assert hops == ["click"], f"a plain click should be one hop, got {hops}"


@pytest.mark.asyncio
async def test_human_cadence_really_does_cost_seventeen_hops():
    """Not a complaint about the feature — a measurement of what it costs, so the choice
    to use it is made with the price in view. 16 path points plus the click."""
    page = CountingPage()
    await _move_and_click(page, ExecutorOptions(use_human_cadence=True), Coordinate(x=100, y=200))

    moves = page.log.count("move")
    assert moves >= 10, f"expected an organic path of many moves, got {moves}"
    assert page.log.count("click") == 1
    # At ~600 ms a hop on the remote lane this is the 10.1 s that was measured.
    assert moves + 1 >= 15


@pytest.mark.asyncio
async def test_typing_at_machine_speed_is_one_hop_for_the_whole_string():
    page = CountingPage()
    await _type_text(page, ExecutorOptions(use_human_cadence=False), "Udariyan Satinder Sartaaj")

    types = [c for c in page.log if c.startswith("type:")]
    assert types == ["type:Udariyan Satinder Sartaaj"], (
        f"the whole string should go in one call, got {len(types)}"
    )


@pytest.mark.asyncio
async def test_human_typing_is_one_hop_per_character():
    page = CountingPage()
    text = "Udariyan Satinder Sartaaj"
    await _type_text(page, ExecutorOptions(use_human_cadence=True), text)

    types = [c for c in page.log if c.startswith("type:")]
    assert len(types) == len(text), (
        f"human typing sends a call per character: expected {len(text)}, got {len(types)}"
    )
    # 25 hops at ~600 ms is the 19.4 s measured on the founder's browser.


@pytest.mark.asyncio
async def test_the_saving_is_the_whole_point():
    """Side by side, for the record: the same two actions, both cadences."""
    text = "Udariyan Satinder Sartaaj"

    fast = CountingPage()
    await _move_and_click(fast, ExecutorOptions(use_human_cadence=False), Coordinate(x=1, y=1))
    await _type_text(fast, ExecutorOptions(use_human_cadence=False), text)
    fast_hops = len([c for c in fast.log if c != "wait"])

    slow = CountingPage()
    await _move_and_click(slow, ExecutorOptions(use_human_cadence=True), Coordinate(x=1, y=1))
    await _type_text(slow, ExecutorOptions(use_human_cadence=True), text)
    slow_hops = len([c for c in slow.log if c != "wait"])

    assert fast_hops == 2, f"a click and a typed string should be two hops, got {fast_hops}"
    assert slow_hops >= 40, f"human cadence should be dozens of hops, got {slow_hops}"
    # ~40 hops saved, at roughly 600 ms each on the bridge.
