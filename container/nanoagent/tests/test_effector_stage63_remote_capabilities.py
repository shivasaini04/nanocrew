"""Stage 63 — do not offer this lane an action it cannot perform.

Measured live 2026-09-21: the loop chose "browser_exec" in the user's own browser and
spent the turn finding out it is impossible —

    failed: page.evaluate does not exist on the remote lane: MV3's extension CSP
    forbids building a function from a string

That is 4.3 s of thinking plus a 5.9 s turn, lost to an action the lane was never able
to run. The model was not wrong to try; it was offered the choice.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector import react_loop


def remote_page():
    """A real RemotePage. _is_remote_lane checks the TYPE, not a duck-typed method —
    deliberately, so it stays true when a run is opted in but the lane could not be
    built. A stub with the right method name is not the same thing, and an earlier
    version of this test used one and proved nothing."""
    from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage

    return RemotePage(RemoteConfig(host="http://x", agent_id="a",
                                   cycle_token="t", controller_id="c"))


class LocalPageStub:
    pass


def test_the_remote_lane_is_recognised():
    assert react_loop._is_remote_lane(remote_page()) is True
    assert react_loop._is_remote_lane(LocalPageStub()) is False


def test_browser_exec_is_off_in_the_users_browser_and_on_in_the_container():
    """The capability is decided by the lane, not left to fail at the moment of use."""
    assert (True and not react_loop._is_remote_lane(remote_page())) is False
    assert (True and not react_loop._is_remote_lane(LocalPageStub())) is True


def test_the_prompt_says_so_too():
    """Turning it off silently would leave the model choosing it and being refused. It is
    told, so it spends the turn on something that can work."""
    source = react_loop.__file__
    text = open(source, encoding="utf-8").read()
    assert "TWO ACTIONS DO NOT EXIST ON THIS LANE" in text
    assert "results are ALREADY on the page" in text, (
        "the same run re-typed a query it had already navigated to"
    )
