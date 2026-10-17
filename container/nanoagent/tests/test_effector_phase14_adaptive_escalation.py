"""Tests for God-Level Pillar 04, 2026-08-23.

Direct response to the load-bearing finding in evaluation.md: DemoQA's practice
form was run six times across six real infrastructure fixes and never
completed once — every fix helped the mechanics, none touched the actual
bottleneck (the cheap decision-tier model's own judgment). This escalates to
the reasoning tier (synthesis_provider/synthesis_model — the same one JIT
synthesis already resolves) exactly when the anti-loop guard's own signals
(consecutive_failures, consecutive_nonprogress) show the cheap model is stuck,
then drops back once real progress resumes.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.react_loop import (
    _ESCALATION_DURATION_TURNS,
    _ESCALATION_FAILURE_TRIGGER,
    _MAX_CONSECUTIVE_FAILURES,
    _NONPROGRESS_NUDGE_THRESHOLD,
)
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


@pytest.mark.asyncio
async def test_repeated_nonprogress_escalates_to_the_reasoning_tier(tmp_path: Path):
    """The exact scenario found live: several non-progressing turns in a row.
    Once the nudge threshold hits, the NEXT decision call must go to
    synthesis_provider, not the cheap decision_provider."""
    call_log: list[str] = []

    class TrackedCheapProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("cheap")
            return await super().chat(*a, **kw)

    class TrackedReasoningProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("reasoning")
            return await super().chat(*a, **kw)

    # 3 scrolls (hits the nonprogress nudge threshold) — turn 4 must escalate.
    # "done" lives in the CHEAP script, not the reasoning one: escalation drops
    # back to cheap the instant turn 4's click succeeds (see the companion
    # drop-back test below), so turn 5 ("done") is answered by cheap again.
    cheap_script = [
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "done", "action": "done"},
    ]
    reasoning_script = [
        {"thought": "act on something specific now", "action": "click", "target": "@e2"},
    ]

    cheap_provider = TrackedCheapProvider(cheap_script)
    reasoning_provider = TrackedReasoningProvider(reasoning_script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=cheap_provider, model="fake/primary",
        decision_provider=cheap_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is True, result
    # First _NONPROGRESS_NUDGE_THRESHOLD turns used the cheap provider, then it
    # switched to the reasoning provider for the recovery.
    assert call_log[:_NONPROGRESS_NUDGE_THRESHOLD] == ["cheap"] * _NONPROGRESS_NUDGE_THRESHOLD
    assert call_log[_NONPROGRESS_NUDGE_THRESHOLD] == "reasoning"


@pytest.mark.asyncio
async def test_escalation_drops_back_to_cheap_once_progress_resumes(tmp_path: Path):
    """Recovering must not keep spending reasoning-tier tokens for the rest of
    the escalated window — drop back the moment a real action lands."""
    call_log: list[str] = []

    class TrackedCheapProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("cheap")
            return await super().chat(*a, **kw)

    class TrackedReasoningProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("reasoning")
            return await super().chat(*a, **kw)

    cheap_script = [
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
        {"thought": "", "action": "scroll", "direction": "up"},
    ]
    # Recovers on the FIRST escalated turn, then a follow-up "done" — if
    # escalation didn't drop back immediately, this "done" would also go to
    # the reasoning provider instead of the cheap one.
    reasoning_script = [
        {"thought": "act specifically", "action": "click", "target": "@e2"},
    ]
    cheap_followup_script = cheap_script + [{"thought": "done", "action": "done"}]

    cheap_provider = TrackedCheapProvider(cheap_followup_script)
    reasoning_provider = TrackedReasoningProvider(reasoning_script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=cheap_provider, model="fake/primary",
        decision_provider=cheap_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is True, result
    # Turn 4 (index 3) is the one escalated, recovering, call. Turn 5 ("done")
    # must be back on the cheap provider, not still riding the escalated window.
    assert call_log == ["cheap", "cheap", "cheap", "reasoning", "cheap"]


@pytest.mark.asyncio
async def test_escalation_fires_before_the_failure_cap_gives_up(tmp_path: Path):
    """A step that keeps failing gets exactly one escalated attempt before the
    hard cap ends the run — not zero (immediate give-up) and not unbounded."""
    call_log: list[str] = []

    class TrackedCheapProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("cheap")
            return await super().chat(*a, **kw)

    class TrackedReasoningProvider(ScriptedProvider):
        async def chat(self, *a, **kw):
            call_log.append("reasoning")
            return await super().chat(*a, **kw)

    # Always the same failing click — both providers script it identically,
    # since the point is to prove escalation fires at all, not that a smarter
    # model would pick something different (this is a fake, it can't reason).
    failing_script = [{"thought": "", "action": "click", "target": "#does-not-exist"}]

    cheap_provider = TrackedCheapProvider(failing_script)
    reasoning_provider = TrackedReasoningProvider(failing_script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=cheap_provider, model="fake/primary",
        decision_provider=cheap_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert "Gave up after" in result["error"]
    # _ESCALATION_FAILURE_TRIGGER (2) cheap attempts fail -> escalate -> the
    # reasoning tier gets exactly ONE shot on turn 3, which also fails,
    # hitting _MAX_CONSECUTIVE_FAILURES (3) and ending the run right there.
    assert call_log == ["cheap"] * _ESCALATION_FAILURE_TRIGGER + ["reasoning"]


@pytest.mark.asyncio
async def test_no_escalation_when_no_reasoning_tier_is_configured(tmp_path: Path):
    """The common case today for callers that don't wire a separate reasoning
    key — must behave exactly as before this pillar, not silently break."""
    provider = ScriptedProvider([
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
        {"thought": "", "action": "scroll", "direction": "up"},
    ])  # repeats forever, no synthesis_provider configured
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        # No synthesis_provider/synthesis_model passed.
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert "stuck in a loop" in result["error"]  # the anti-loop guard still fires on its own
