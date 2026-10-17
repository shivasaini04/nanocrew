"""stage45 item 5: the agent half of mid-run steering.

Everything else a human could say to a running agent was a *decision* — approve, reject
or comment on one action the agent itself chose to ask about. This is the other
direction: a note to a run that is going wrong and not asking.

Two properties carry the weight, and both are about the boundary between control plane
and data plane:

  * the note is fetched over a CYCLE-TOKEN authenticated route. Page content reaches the
    model as `wrap_untrusted_perception`; a steering note reaches it as operator
    instruction. If page content could reach this channel the distinction would be
    worthless, so the auth is the feature.
  * a failure to reach the orchestrator is silence, never an error. Nobody talking to a
    run is the normal case.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from nanoagent.agent.effector import react_loop


_ENV = {
    "NanoCrew_HOST": "http://host.docker.internal:3002",
    "AGENT_ID": "agent-abc",
    "CYCLE_ID": "cycle-xyz",
    "NANOCREW_CYCLE_TOKEN": "tok-123",
}


class FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def env(monkeypatch):
    for k, v in _ENV.items():
        monkeypatch.setenv(k, v)


# ── fetching ─────────────────────────────────────────────────────────────────


def test_notes_come_back_from_the_cycle_scoped_route(env):
    with patch.object(react_loop.urllib.request, "urlopen",
                      return_value=FakeResponse({"notes": ["try the search box"]})) as fake:
        assert react_loop._fetch_steering_notes() == ["try the search box"]

    req = fake.call_args.args[0]
    assert req.full_url == (
        "http://host.docker.internal:3002/api/agents/agent-abc/self/steer?cycleId=cycle-xyz"
    )
    assert req.get_method() == "GET"


def test_the_cycle_token_is_sent(env):
    """The whole reason a steering note may be framed to the model as operator
    instruction: this channel is one page content cannot reach."""
    with patch.object(react_loop.urllib.request, "urlopen",
                      return_value=FakeResponse({"notes": []})) as fake:
        react_loop._fetch_steering_notes()

    headers = {k.lower(): v for k, v in fake.call_args.args[0].header_items()}
    assert headers["authorization"] == "Bearer tok-123"


@pytest.mark.parametrize("missing", list(_ENV))
def test_no_env_means_no_call_at_all(env, monkeypatch, missing):
    """A local or manual effector run has no orchestrator and no cycle. It must not try,
    not fail, and not log noise — the same contract _post_live_frame has."""
    monkeypatch.delenv(missing)
    with patch.object(react_loop.urllib.request, "urlopen") as fake:
        assert react_loop._fetch_steering_notes() == []
    fake.assert_not_called()


def test_an_unreachable_orchestrator_is_silence_not_an_error(env):
    with patch.object(react_loop.urllib.request, "urlopen", side_effect=OSError("refused")):
        assert react_loop._fetch_steering_notes() == []


def test_a_malformed_reply_is_silence(env):
    for payload in ({"notes": "not a list"}, {}, {"notes": None}):
        with patch.object(react_loop.urllib.request, "urlopen",
                          return_value=FakeResponse(payload)):
            assert react_loop._fetch_steering_notes() == []


def test_a_flood_of_notes_is_capped(env):
    """Bounded on this side too. The orchestrator caps the mailbox, but the prompt is
    what actually pays for a long list."""
    with patch.object(react_loop.urllib.request, "urlopen",
                      return_value=FakeResponse({"notes": [f"n{i}" for i in range(50)]})):
        assert len(react_loop._fetch_steering_notes()) == 5


# ── what the model is shown ──────────────────────────────────────────────────


def test_a_note_is_framed_as_the_operator_speaking():
    prompt = react_loop._build_turn_prompt(
        "book a table", "some page", [], steering_notes=["use the second tab"],
    )
    assert "use the second tab" in prompt
    assert "YOUR OPERATOR" in prompt
    # The contrast with page content is the point: perception is wrapped as untrusted a
    # few lines later, and a model that cannot tell them apart is the reason the prompt
    # firewall exists at all.
    assert "NOT page content" in prompt
    # Position is load-bearing, not cosmetic: measured over four real runs, a note
    # placed under the Goal line was ignored three times out of four. It goes last,
    # immediately before the model is asked to choose.
    assert prompt.index("YOUR OPERATOR") > prompt.index("Current page:")
    assert "THIS WINS" in prompt


def test_the_note_says_it_stays_in_force():
    """Measured over six real runs: a note shown ONCE was never acted on.

    The sequence was always the same — the note landed on turn 2, the model spent that
    turn finishing what it was already doing, and by turn 3, when it actually chose the
    action that mattered, the note was gone and the original Goal line was the only
    instruction left. It then did exactly what the goal said.

    Notes now persist for the rest of the run, and the text says so: a model told "this
    will not be shown again" may reasonably finish its current step first, which is the
    one thing it must not do.
    """
    prompt = react_loop._build_turn_prompt(
        "goal", "page", [], steering_notes=["stop clicking that"],
    )
    assert "stays in force for the rest of this run" in prompt


def test_several_notes_are_all_shown():
    prompt = react_loop._build_turn_prompt(
        "goal", "page", [], steering_notes=["first thing", "second thing"],
    )
    assert "first thing" in prompt and "second thing" in prompt


def test_no_notes_changes_nothing_about_the_prompt():
    """The overwhelmingly common case. A run nobody is watching must not pay a single
    token for the feature."""
    base = react_loop._build_turn_prompt("goal", "page", [])
    for empty in (None, []):
        assert react_loop._build_turn_prompt("goal", "page", [], steering_notes=empty) == base
    assert "OPERATOR" not in base
