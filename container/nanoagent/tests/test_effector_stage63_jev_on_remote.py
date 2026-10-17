"""Stage 63 — Jev decides on the lane where a decision is expensive.

The container verdict stands: the LLM decides in ~1.4 s there, Jev covered a third of
steps, cost turns when wrong, and a four-arm A/B found no task-level gain.

The user's own browser is a different calculation, and assuming the container answer
carried over was a mistake. Measured live 2026-09-21: a decision there cost 2.0–6.4 s —
bigger pages, every look crossing the network — and thinking was 17.7 s of a 55.8 s run.
Jev answers in ~0.35 s. Replacing 1.4 s barely pays; replacing 4 s does.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector import react_loop


def remote_page():
    from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage

    return RemotePage(RemoteConfig(host="http://x", agent_id="a",
                                   cycle_token="t", controller_id="c"))


class LocalPage:
    pass


def test_the_users_own_browser_asks_jev(monkeypatch):
    monkeypatch.delenv("EFFECTOR_DECIDER", raising=False)
    assert react_loop._jev_wanted(remote_page()) is True


def test_the_container_still_does_not(monkeypatch):
    monkeypatch.delenv("EFFECTOR_DECIDER", raising=False)
    assert react_loop._jev_wanted(LocalPage()) is False


def test_it_can_be_forced_on_anywhere(monkeypatch):
    monkeypatch.setenv("EFFECTOR_DECIDER", "jev")
    assert react_loop._jev_wanted(LocalPage()) is True


@pytest.mark.parametrize("value", ["off", "none", "llm"])
def test_it_can_be_forced_off_anywhere(monkeypatch, value):
    """The rollback, and it has to beat the lane default or there is no way back."""
    monkeypatch.setenv("EFFECTOR_DECIDER", value)
    assert react_loop._jev_wanted(remote_page()) is False


def test_an_empty_setting_falls_back_to_the_lane(monkeypatch):
    """`-e EFFECTOR_DECIDER=` sets it to "" — the trap that has appeared three times in
    this codebase. Empty must mean "decide by lane", not "off"."""
    monkeypatch.setenv("EFFECTOR_DECIDER", "")
    assert react_loop._jev_wanted(remote_page()) is True
    assert react_loop._jev_wanted(LocalPage()) is False


def test_browser_and_effector_are_advertised_not_deferred():
    """Their trigger is a task ("play this song"), never a tool name, so nothing prompts
    a tool_search for them. Two model calls at 12-18 s each were spent finding them."""
    from pathlib import Path

    # Read the file rather than import it: agent/loop.py pulls in every provider, and
    # this assertion is about a literal set in the source, not about runtime behaviour.
    source = (Path(react_loop.__file__).parent.parent / "loop.py").read_text(encoding="utf-8")
    start = source.index("_CORE_TOOLS")
    core = source[start:source.index("enable_deferral", start)]
    assert '"effector"' in core, "effector is deferred; reaching it costs two model calls"
    assert '"browser"' in core
