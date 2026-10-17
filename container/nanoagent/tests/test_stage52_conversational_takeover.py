"""On the user's own browser, the agent asks instead of parking.

## Why the behaviour differs by lane

Parking exists because a CONTAINER's browser dies with its cycle: hold the run open or the
half-filled form is gone. The user-browser lane has the opposite property — the pane is a
tab in the desktop app, owned by the app rather than by the cycle, so it outlives every
cycle. A page left half-done is still there next turn, scroll position and typed text
included.

So the reason to block disappears, while the costs of blocking do not: a container held
for up to thirty minutes (escalation._MAX_WAIT_S), a cycle stuck in `running`, and a
release signal the user can only send from one button in one app. On 2026-09-06 an agent
parked on a LinkedIn login wall, the user signed in, and the cycle stayed stuck because
that button was not reachable from the desktop app at all.

Ending the turn instead makes it a conversation — which is what this codebase already does
for approvals (agent-service.ts `processFeedback` kicks a follow-up cycle rather than
blocking). The takeover was the outlier.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from nanoagent.agent.effector.react_loop import _is_remote_lane
from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage


def _remote_page() -> RemotePage:
    return RemotePage(RemoteConfig(
        host="http://orchestrator:3002",
        agent_id="agent-1",
        cycle_token="tok-1",
        controller_id="ctl-1",
    ))


def test_the_users_own_browser_is_recognised():
    """The whole decision hangs on this, so it is worth pinning on its own."""
    assert _is_remote_lane(_remote_page()) is True


def test_a_container_page_is_not_the_users_browser():
    """A Playwright Page — anything that is not a RemotePage — keeps the old behaviour,
    because a container browser really does die with the cycle."""
    assert _is_remote_lane(MagicMock()) is False


def test_it_answers_by_TYPE_not_by_configuration():
    """Checked against the page in hand rather than an env var.

    A run can be opted into the lane and still end up on the container's Chromium — the
    controller went offline, the broker had nobody attached. Reading the environment would
    say "remote" while the agent held a local page, and the agent would then end its turn
    expecting a browser that persists, on a browser about to be destroyed.
    """
    import os

    os.environ["NC_BROWSER_CONTROLLER_ID"] = "controller-abc"
    try:
        # Opted in by configuration, but holding a local page: not the remote lane.
        assert _is_remote_lane(MagicMock()) is False
    finally:
        os.environ.pop("NC_BROWSER_CONTROLLER_ID", None)


def test_a_missing_remote_module_does_not_break_the_check():
    """Never raise from this. It decides whether to park, and a run that cannot answer the
    question should carry on with the old behaviour rather than fail."""
    assert _is_remote_lane(None) is False
    assert _is_remote_lane("not a page") is False
