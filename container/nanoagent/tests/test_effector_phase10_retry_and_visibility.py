"""Tests for the two real bugs found and fixed after a live run against a harder
site (demoqa.com's practice form), 2026-08-23:

1. dom_snapshot.py's in-page visibility check only excluded elements above/left
   of the viewport (`rect.bottom >= 0 && rect.right >= 0`), never checked the
   right/bottom bounds — so an always-present sidebar nav link (off to the side,
   but still "visible" by that check) leaked into the interactive-element list
   and got clicked instead of the intended form field.

2. A single failed step used to end the entire run immediately, with no chance
   for the model to see what went wrong and pick something else. Now it retries
   (the failure shows up in the next turn's prompt history) up to
   _MAX_CONSECUTIVE_FAILURES before actually giving up.

3. Found in the SAME live run, one fix later: a decision call returning
   malformed JSON (turn 10 against demoqa.com — the model's own output wasn't
   valid JSON) hit a SEPARATE code path that still weren't retried by fix #2 —
   any exception from the decision call/parse step ended the run immediately.
   Same fix, same shared failure-counter, applied to that path too.

4. Found on a THIRD live run, after fixes 1-3 got it further: 5 of 20 decision
   calls got cut off mid-string by the old 512-token cap ("Unterminated string"
   JSON errors — a truncation, not a formatting mistake). Doubled the cap and
   added explicit finish_reason=="length" detection (the same signal loop.py's
   own truncation handling already uses) so a cut-off response gets a specific,
   actionable retry message instead of a generic JSON parse error.

5. Found on the same run: name-extraction gap in dom_snapshot.py — see the
   dedicated section below.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.react_loop import _MAX_CONSECUTIVE_FAILURES, _build_turn_prompt
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


# ─── dom_snapshot.py: off-screen-right/below elements are excluded ─────────────
#
# The actual filtering runs as in-page JS inside a real browser (window.innerWidth/
# innerHeight, getBoundingClientRect) — not reproducible against a Python fake page
# without re-implementing a layout engine, so this is a direct source assertion on
# the shipped JS rather than a behavioral test. capture_dom_snapshot's Python side
# is a pure pass-through of whatever evaluate() returns (see the function itself),
# so there is nothing further to test on the Python side for this bug.

def test_dom_snapshot_js_checks_all_four_viewport_edges():
    """Direct source assertion: the in-page visibility check must bound BOTH
    top/left (already did) AND bottom/right (the actual bug) against the
    viewport — not just check they're not negative."""
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    assert "rect.top <= window.innerHeight" in _SNAPSHOT_JS
    assert "rect.left <= window.innerWidth" in _SNAPSHOT_JS
    assert "rect.bottom >= 0" in _SNAPSHOT_JS
    assert "rect.right >= 0" in _SNAPSHOT_JS


# ─── dom_snapshot.py: name-extraction fallbacks for label-less custom widgets ───
#
# Found live, one live-run later, against the SAME demoqa.com form: after the
# viewport fix above let the model reach the State dropdown, it got stuck right
# after — a diagnostic script (capturing a real snapshot mid-form) showed why:
# react-select's real <input> has no aria-label/title/placeholder/value/text of
# its own; "Select City..." is a SIBLING <div>, invisible to the old extraction.
# The model was shown two indistinguishable "input role=combobox" entries and
# correctly refused to guess which one was City. Same JS-can't-run-headless
# constraint as the viewport-bounds test above — source assertions, not behavior.

def test_dom_snapshot_js_resolves_aria_labelledby():
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS
    assert "aria-labelledby" in _SNAPSHOT_JS
    assert "getElementById" in _SNAPSHOT_JS


def test_dom_snapshot_js_falls_back_to_nearby_sibling_text():
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS
    assert "el.parentElement" in _SNAPSHOT_JS
    assert "nodeText !== ownText" in _SNAPSHOT_JS


def test_dom_snapshot_js_falls_back_to_an_ancestor_id_as_a_last_resort():
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS
    assert "react-select-" in _SNAPSHOT_JS  # excluded as a generated, non-semantic id
    assert "node.id" in _SNAPSHOT_JS


# ─── react_loop.py: failure feedback + retry cap ────────────────────────────────

def test_build_turn_prompt_surfaces_the_failure_reason():
    # A real Playwright timeout error is a multi-line "Call log:" dump — modeled
    # here as a long, repetitive message so the 200-char cap actually has
    # something to cut, proving it bounds prompt growth rather than just being
    # a no-op on short messages.
    long_error = "Locator.click: Timeout 30000ms exceeded.\n" + ("waiting for element to be visible... " * 20)
    failed_turn = EffectorTurnLog(
        turn=1, thought="click it", action=Step(step=1, action="click", target="@e2"),
        result=StepResult(step=1, status="failed", error=long_error),
    )
    prompt = _build_turn_prompt("do the thing", "some page summary", [failed_turn])

    assert "-> failed" in prompt
    assert "Timeout 30000ms exceeded" in prompt  # the useful part, near the start, survives
    assert long_error not in prompt  # but the full multi-line dump does not


def test_build_turn_prompt_handles_a_failure_with_no_error_text():
    failed_turn = EffectorTurnLog(
        turn=1, thought="x", action=Step(step=1, action="click", target="@e2"),
        result=StepResult(step=1, status="failed", error=None),
    )
    prompt = _build_turn_prompt("goal", "summary", [failed_turn])
    assert "-> failed" in prompt  # doesn't crash on a missing error string


@pytest.mark.asyncio
async def test_a_failed_step_retries_instead_of_ending_the_run_immediately(tmp_path: Path):
    """The exact scenario found live: turn 1 fails, but the model gets another
    shot — this time picking something that actually works."""
    script = [
        {"thought": "click the wrong thing", "action": "click", "target": "#does-not-exist"},
        {"thought": "that failed, try the real button instead", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="click submit")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 3
    assert result["turns"][0]["status"] == "failed"
    assert result["turns"][1]["status"] == "success"
    # The recovery turn's prompt must have seen the first failure — proven
    # indirectly: the script only produces the "click @e2" action on call 2,
    # and the run did reach and use it.
    assert provider.calls == 3


@pytest.mark.asyncio
async def test_repeated_failures_still_give_up_after_the_cap(tmp_path: Path):
    """A page that's genuinely broken must not burn the entire max_turns budget
    on the same failing action forever."""
    script = [
        {"thought": "click something that never resolves", "action": "click", "target": "#does-not-exist"},
    ]
    provider = ScriptedProvider(script)  # repeats forever once exhausted
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="click a button that isn't on the page", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert f"Gave up after {_MAX_CONSECUTIVE_FAILURES} consecutive" in result["error"]
    # Gave up well short of the 20-turn budget — proves the cap fired, not max_turns.
    assert result["turns_executed"] == _MAX_CONSECUTIVE_FAILURES
    assert provider.calls == _MAX_CONSECUTIVE_FAILURES


@pytest.mark.asyncio
async def test_a_success_resets_the_consecutive_failure_count(tmp_path: Path):
    """Two isolated failures separated by a success must not add up toward the
    cap — only genuinely CONSECUTIVE failures should end the run."""
    script = [
        {"thought": "fail 1", "action": "click", "target": "#does-not-exist"},
        {"thought": "recover", "action": "click", "target": "@e2"},  # success — resets the counter
        {"thought": "fail 2", "action": "click", "target": "#does-not-exist"},
        {"thought": "fail 3", "action": "click", "target": "#does-not-exist"},
        {"thought": "done anyway", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=10)

    result = json.loads(raw)
    # 2 consecutive failures (fail 2, fail 3) never reached the cap of 3, so the
    # run continues to "done" rather than giving up.
    assert result["success"] is True, result
    assert result["turns_executed"] == 5


# ─── react_loop.py: decision-call failures (bad JSON, transient errors) retry too ──

class _FakeLLMResponse:
    def __init__(self, content, usage=None):
        self.content = content
        self.tool_calls = []
        self.usage = usage


_MALFORMED_USAGE = {
    "prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
}


class MalformedOnceProvider(ScriptedProvider):
    """The exact live failure mode: the API call succeeds (real usage comes back)
    but the content isn't valid JSON — then behaves normally afterward."""

    def __init__(self, script):
        super().__init__(script)
        self._malformed_sent = False
        self.last_messages = None

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.last_messages = messages
        if not self._malformed_sent:
            self._malformed_sent = True
            return _FakeLLMResponse(content="{not valid json", usage=dict(_MALFORMED_USAGE))
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


class AlwaysMalformedProvider:
    def __init__(self):
        self.calls = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.calls += 1
        return _FakeLLMResponse(content="not json at all", usage=None)

    def get_default_model(self):
        return "fake/malformed"


@pytest.mark.asyncio
async def test_a_malformed_decision_response_retries_and_recovers(tmp_path: Path):
    """Turn 1's response isn't valid JSON (the real usage still counts — the API
    call itself succeeded); turn 2 is a normal, valid response and the run
    completes rather than dying on the first bad response."""
    provider = MalformedOnceProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")

    result = json.loads(raw)
    assert result["success"] is True, result
    # Turn 1 (malformed, no logged turn) + turn 2 (done) — turn_num still
    # advanced on the failed attempt even though nothing was appended to `turns`.
    assert result["turns_executed"] == 2
    assert len(result["turns"]) == 1
    # The malformed call's real usage is NOT lost just because parsing failed.
    assert result["usage"]["total_tokens"] == _MALFORMED_USAGE["total_tokens"] + 120

    # Turn 2's prompt actually told the model what went wrong with turn 1.
    retry_content = provider.last_messages[1]["content"]
    assert "could not be used" in retry_content
    assert "not valid json" not in retry_content  # the raw bad response itself isn't echoed, just the parse error


@pytest.mark.asyncio
async def test_decision_failures_also_give_up_after_the_cap(tmp_path: Path):
    """A decision call that NEVER produces valid JSON must not hang the run
    forever — same cap as step-execution failures, shared counter."""
    provider = AlwaysMalformedProvider()
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert f"Gave up after {_MAX_CONSECUTIVE_FAILURES} consecutive" in result["error"]
    assert provider.calls == _MAX_CONSECUTIVE_FAILURES
    # Gave up well short of the 20-turn budget — the cap fired, not max_turns.
    assert result["turns_executed"] == _MAX_CONSECUTIVE_FAILURES - 1


@pytest.mark.asyncio
async def test_the_decision_error_note_is_shown_once_then_cleared(tmp_path: Path):
    """The retry note must appear on the turn right after the failure, and must
    NOT linger into later turns once it's already been shown."""
    provider = MalformedOnceProvider([
        {"thought": "wait a moment", "action": "wait", "duration": 10},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x")

    result = json.loads(raw)
    assert result["success"] is True, result
    # Last real call captured was turn 3's ("done") — by then the note is gone.
    final_content = provider.last_messages[1]["content"]
    assert "could not be used" not in final_content


# ─── react_loop.py: max_tokens raised, truncation detected via finish_reason ───

class _RecordingMaxTokensProvider(ScriptedProvider):
    def __init__(self, script):
        super().__init__(script)
        self.last_max_tokens = None

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.last_max_tokens = max_tokens
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


@pytest.mark.asyncio
async def test_decision_calls_use_the_raised_token_cap(tmp_path: Path):
    from nanoagent.agent.effector.react_loop import _DECISION_MAX_TOKENS
    assert _DECISION_MAX_TOKENS > 512  # the old cap that was proven too tight live

    provider = _RecordingMaxTokensProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await tool.execute(goal="x")

    assert provider.last_max_tokens == _DECISION_MAX_TOKENS


class TruncatedOnceProvider(ScriptedProvider):
    """The real live failure mode: a response that hit the token limit — real
    usage comes back, finish_reason says "length", content is cut off mid-JSON."""

    def __init__(self, script):
        super().__init__(script)
        self._truncated_sent = False
        self.last_messages = None

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.last_messages = messages
        if not self._truncated_sent:
            self._truncated_sent = True
            resp = _FakeLLMResponse(content='{"thought": "this got cut off mid-sen', usage=dict(_MALFORMED_USAGE))
            resp.finish_reason = "length"
            return resp
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


@pytest.mark.asyncio
async def test_a_truncated_decision_response_retries_with_a_specific_message(tmp_path: Path):
    """A cut-off decision is retried IN THE SAME TURN with a larger budget (stage 60 live
    fix, Mechanic a live cycle: reasoning models filled the 1024-token budget and two
    runs died after three cut-offs). Only if the retry is ALSO cut off does the turn
    fail with the specific "cut off / token limit" message — see the next test."""
    budgets: list[int] = []

    class Recording(TruncatedOnceProvider):
        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            budgets.append(max_tokens)
            return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature, **kw)

    provider = Recording([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 1  # recovered inside the turn, no wasted turn
    assert budgets[1] == budgets[0] * 4


class AlwaysTruncatedOnceThenDone(TruncatedOnceProvider):
    """Cut off on the first two calls (the attempt and its in-turn retry), then fine."""

    def __init__(self, script):
        super().__init__(script)
        self._cuts = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.last_messages = messages
        if self._cuts < 2:
            self._cuts += 1
            resp = _FakeLLMResponse(content='{"thought": "this got cut off mid-sen', usage=dict(_MALFORMED_USAGE))
            resp.finish_reason = "length"
            return resp
        return await ScriptedProvider.chat(self, messages, model=model, max_tokens=max_tokens, temperature=temperature)


@pytest.mark.asyncio
async def test_a_decision_cut_off_twice_fails_the_turn_with_a_specific_message(tmp_path: Path):
    provider = AlwaysTruncatedOnceThenDone([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 2  # turn 1 cut off twice (not logged), turn 2 done

    retry_content = provider.last_messages[1]["content"]
    assert "cut off" in retry_content
    assert "token limit" in retry_content
    # Detected via finish_reason directly, not by waiting for a generic JSON
    # parse error — the raw truncated fragment itself isn't what's echoed back.
    assert "got cut off mid-sen" not in retry_content


@pytest.mark.asyncio
async def test_a_response_without_finish_reason_is_not_treated_as_truncated(tmp_path: Path):
    """A fake/older provider that doesn't set finish_reason at all (defaults to
    the LLMResponse dataclass default, "stop") must not be misdiagnosed."""
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 1  # no phantom retry turn
