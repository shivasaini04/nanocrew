"""Tests for two things found and fixed together while closing the last two gaps
from the evaluation, 2026-08-23:

1. A real correctness bug: react_loop.py's per-turn loop calls execute_step
   (singular) directly, never execute_steps (the batch helper) — so the
   is_dangerous/request_approval gate, which only lived inside execute_steps, was
   never actually reached from the live loop. A "click Delete account" step would
   have executed with zero human-approval check despite escalation.py's own
   docstring claiming the property held from day one.

2. Screenshot-grounded reasoning as a first-class DECIDE-step input (not just
   resolver's layer-5 fallback) — conditional on a weak text signal: empty DOM
   perception, or a self-heal having just fired.

Both live in react_loop.py's turn loop, so one test file covers them together.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeContext, FakePage, FakeSession, ScriptedProvider


# ─── Danger gate is actually reached from the live loop ────────────────────────

@pytest.mark.asyncio
async def test_dangerous_step_is_blocked_when_the_operator_denies(tmp_path: Path):
    """The exact failure mode found: a dangerous-looking click must not execute
    silently. Patches request_approval (not the HTTP layer) since this test is
    about react_loop's wiring, not the escalation round trip itself (see
    test_effector_phase6_gaps.py for that)."""
    script = [
        {"thought": "delete the account", "action": "click", "target": "Delete my account"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession), \
         patch("nanoagent.agent.effector.react_loop.request_approval", return_value="denied") as mock_approval:
        raw = await tool.execute(goal="Delete my account")

    result = json.loads(raw)
    assert result["success"] is False
    assert "Denied by operator" in result["error"]
    mock_approval.assert_called_once()
    # A denied step is recorded as "skipped", never "success" — the click itself
    # (executor.execute_step) is never reached once the gate denies it.
    assert result["turns"][-1]["status"] == "skipped"


@pytest.mark.asyncio
async def test_dangerous_step_executes_when_the_operator_approves(tmp_path: Path):
    """The flip side: approval must let the same step actually run — the gate
    can't be a one-way valve that just blocks everything by accident."""
    script = [
        {"thought": "delete something", "action": "click", "target": "@e2"},  # #submit, safe target text
        {"thought": "done", "action": "done"},
    ]
    # is_dangerous() also fires when Step.is_dangerous is explicitly set — simulate
    # the LLM flagging its own action as dangerous even with an innocuous target.
    provider = ScriptedProvider(script)

    async def _approve(*a, **kw):
        return "approved"

    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession), \
         patch("nanoagent.agent.effector.react_loop.is_dangerous", return_value=True), \
         patch("nanoagent.agent.effector.react_loop.request_approval", side_effect=_approve) as mock_approval:
        raw = await tool.execute(goal="Click submit")

    result = json.loads(raw)
    assert result["success"] is True
    mock_approval.assert_called_once()


@pytest.mark.asyncio
async def test_a_non_dangerous_step_never_calls_the_approval_gate_at_all(tmp_path: Path):
    """Cheapest possible regression guard for the common path: an ordinary type/
    click/done task must not pay for an approval round trip it doesn't need."""
    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession), \
         patch("nanoagent.agent.effector.react_loop.request_approval") as mock_approval:
        raw = await tool.execute(goal="Fill in the name field")

    result = json.loads(raw)
    assert result["success"] is True
    mock_approval.assert_not_called()


# ─── Screenshot-grounded reasoning ──────────────────────────────────────────────

class RecordingScriptedProvider(ScriptedProvider):
    """Same scripted behavior as ScriptedProvider, but remembers the last messages
    it was called with so a test can inspect whether a screenshot was attached."""

    def __init__(self, script):
        super().__init__(script)
        self.last_messages = None

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.last_messages = messages
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


class FirstTurnEmptyPage(FakePage):
    """Elements list is empty on the very first querySelectorAll call (simulating
    a page that hasn't finished rendering, or a genuinely sparse layout), real
    elements from the second call onward — proves the trigger fires exactly once,
    not on every turn."""

    def __init__(self):
        super().__init__()
        self._query_calls = 0

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if "querySelectorAll" in script:
            self._query_calls += 1
            if self._query_calls == 1:
                return []
            from test_effector_phase0 import _FAKE_ELEMENTS
            return _FAKE_ELEMENTS
        return None


@pytest.mark.asyncio
async def test_vision_grounding_fires_once_on_empty_perception_then_falls_back_to_text(tmp_path: Path):
    page = FirstTurnEmptyPage()

    class EmptyFirstSession:
        def __init__(self, *a, **kw):
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    vision_provider = RecordingScriptedProvider([
        {"thought": "nothing rendered yet, wait a moment", "action": "wait", "duration": 100},
    ])
    decision_provider = RecordingScriptedProvider([
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ])

    tool = EffectorTool(
        workspace=tmp_path, provider=decision_provider, model="fake/primary",
        decision_provider=decision_provider, decision_model="fake/decision",
        vision_provider=vision_provider, vision_model="fake/vision",
        # This test is about WHICH provider handles which turn, not the approval gate —
        # and @e2 is the fake page's Submit button, which (correctly, since the
        # 2026-08-24 ref-expansion fix) now trips that gate. The gate itself is covered
        # by the two tests above and by test_effector_phase28_danger_gate_refs.py.
        require_approval=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", EmptyFirstSession):
        raw = await tool.execute(goal="Submit the form")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 3

    # Vision provider handled exactly turn 1 (the empty-perception turn); the
    # ordinary decision provider handled the remaining two turns once real
    # elements appeared.
    assert vision_provider.calls == 1
    assert decision_provider.calls == 2

    # The vision call actually carried an image, not just text.
    vision_user_content = vision_provider.last_messages[1]["content"]
    assert isinstance(vision_user_content, list)
    assert any(part.get("type") == "image_url" for part in vision_user_content)

    # The fallback text-only calls stayed plain strings — no wasted screenshots
    # once the DOM had real content to describe.
    assert isinstance(decision_provider.last_messages[1]["content"], str)


@pytest.mark.asyncio
async def test_vision_grounding_fires_after_a_self_heal(tmp_path: Path):
    """The second reachable trigger: a self-heal succeeded last turn (plan and
    live page had already diverged once), so the next decision is grounded too."""
    from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult
    from nanoagent.agent.effector.react_loop import _should_ground_with_vision

    self_healed_turn = EffectorTurnLog(
        turn=1, thought="clicked", action=Step(step=1, action="click", target="@e1"),
        result=StepResult(step=1, status="success"), self_healed=True,
    )
    assert _should_ground_with_vision(False, [self_healed_turn]) is True
    assert _should_ground_with_vision(False, []) is False


@pytest.mark.asyncio
async def test_vision_grounding_is_skipped_entirely_when_no_vision_provider_is_configured(tmp_path: Path):
    """Same empty-perception trigger, but no vision_provider/model configured —
    must fall back to the ordinary decision provider, not crash or hang."""
    page = FirstTurnEmptyPage()

    class EmptyFirstSession:
        def __init__(self, *a, **kw):
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    decision_provider = RecordingScriptedProvider([
        {"thought": "nothing rendered yet, wait a moment", "action": "wait", "duration": 100},
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ])

    tool = EffectorTool(
        workspace=tmp_path, provider=decision_provider, model="fake/primary",
        decision_provider=decision_provider, decision_model="fake/decision",
        # No vision_provider/vision_model — the wanted-but-unavailable path.
        require_approval=False,  # same reason as the test above: @e2 is Submit
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", EmptyFirstSession):
        raw = await tool.execute(goal="Submit the form")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert decision_provider.calls == 3
    assert isinstance(decision_provider.last_messages[1]["content"], str)
