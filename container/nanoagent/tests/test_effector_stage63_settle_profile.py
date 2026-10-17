"""Stage 63 — how long the loop waits for a page to hold still.

The cautious profile restarts a 150 ms quiet period on EVERY mutation and additionally
waits for every running CSS animation, capped at 3 s. browser-use's `jev-ultrafast`
names that as the bug it fixed and waits two animation frames instead.

These tests pin the switch, not the timing: the default must stay cautious until the
fast profile is measured to hold 20/20 verified, and an explicit argument must always
win over the profile so the challenge solver keeps its own timeout.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.dom_settler import settle_profile, wait_for_dom_settled


def test_fast_is_the_default(monkeypatch):
    """Measured 2026-09-21 in an isolated A/B, same turn count both arms: settle
    172 ms -> 80 ms, loop -11%, 19/20 verified either way."""
    monkeypatch.delenv("EFFECTOR_SETTLE", raising=False)
    assert settle_profile() == (60, 800, False)


def test_cautious_is_still_reachable(monkeypatch):
    """The rollback. Waiting for every running CSS animation costs up to 3 s a turn on
    an animated page, which is why it is no longer the default — but a page acted on
    mid-render is a worse failure than a slow one, so the old behaviour stays one env
    var away."""
    monkeypatch.setenv("EFFECTOR_SETTLE", "cautious")
    assert settle_profile() == (150, 3000, True)


def test_fast_drops_the_animation_wait(monkeypatch):
    monkeypatch.setenv("EFFECTOR_SETTLE", "fast")
    quiet, timeout, animations = settle_profile()
    assert quiet == 60
    assert timeout == 800
    assert animations is False, (
        "a spinner or looping banner would hold the loop for the whole timeout while "
        "the page was usable throughout"
    )


@pytest.mark.parametrize("value", ["", "fast", "FAST ", "anything-else"])
def test_only_the_exact_word_returns_to_cautious(monkeypatch, value):
    """An unset or unrecognised value means fast, so `-e EFFECTOR_SETTLE=` cannot
    silently restore the slow profile — the same empty-string trap that would have made
    an engine A/B measure one engine twice."""
    monkeypatch.setenv("EFFECTOR_SETTLE", value)
    cautious = settle_profile() == (150, 3000, True)
    assert cautious is (value.strip().lower() == "cautious")


class FakePage:
    """A page whose evaluate records what it was asked to wait for."""

    def __init__(self):
        self.args = None

    async def evaluate(self, _script, arg):
        self.args = arg
        return True


@pytest.mark.asyncio
async def test_the_profile_reaches_the_page(monkeypatch):
    monkeypatch.setenv("EFFECTOR_SETTLE", "fast")
    page = FakePage()
    await wait_for_dom_settled(page)
    assert page.args == {"quietPeriod": 60, "timeout": 800, "checkAnim": False}


@pytest.mark.asyncio
async def test_an_explicit_argument_beats_the_profile(monkeypatch):
    """The challenge solver passes timeout_ms=1500 and must keep getting it."""
    monkeypatch.setenv("EFFECTOR_SETTLE", "fast")
    page = FakePage()
    await wait_for_dom_settled(page, timeout_ms=1500)
    assert page.args["timeout"] == 1500
    assert page.args["quietPeriod"] == 60  # unspecified parts still come from the profile


@pytest.mark.asyncio
async def test_a_page_that_cannot_evaluate_still_waits_rather_than_raising(monkeypatch):
    """The remote lane has no page.evaluate; it must degrade, not explode."""
    monkeypatch.setenv("EFFECTOR_SETTLE", "fast")

    class RemotePage:
        def nc_remote_snapshot(self):
            return None

    assert await wait_for_dom_settled(RemotePage()) is False
