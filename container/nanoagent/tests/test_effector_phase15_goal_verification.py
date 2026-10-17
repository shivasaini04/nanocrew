"""Tests for God-Level Pillar 05, 2026-08-23.

Direct response to the exact live failure that started this whole gap-closing
chain: turn 11 called "done" against demoqa.com with the City field still an
open, unconfirmed dropdown, and nothing checked that claim against the real
page before accepting it. Opt-in via verify_goal — decomposes the goal into a
checklist once, then runs a real verification pass every time the model calls
"done" instead of trusting it, up to _MAX_VERIFICATION_REJECTIONS attempts
before conceding with an honest "N of M items verified" instead of either a
false success or an endless loop.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.react_loop import (
    _MAX_VERIFICATION_REJECTIONS,
    _build_turn_prompt,
    _decompose_goal,
    _verify_goal_completion,
)
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


@dataclass
class _FakeLLMResponse:
    content: str | None
    usage: dict | None = None
    finish_reason: str = "stop"
    tool_calls: list = field(default_factory=list)


class ScriptedJsonProvider:
    """Returns one fixed JSON-ish string for every call — used for the small,
    single-purpose decomposition/verification calls, distinct from
    ScriptedProvider's per-turn action script."""

    def __init__(self, content: str):
        self.content = content
        self.calls = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.calls += 1
        return _FakeLLMResponse(content=self.content)


# ─── _decompose_goal ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_decompose_goal_parses_a_valid_json_array():
    provider = ScriptedJsonProvider('["First Name filled", "City selected"]')
    items = await _decompose_goal("fill the form", provider, "fake/model", {})
    assert items == ["First Name filled", "City selected"]
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_decompose_goal_falls_back_to_the_whole_goal_on_malformed_json():
    provider = ScriptedJsonProvider("not json at all")
    items = await _decompose_goal("fill the form", provider, "fake/model", {})
    assert items == ["fill the form"]


@pytest.mark.asyncio
async def test_decompose_goal_falls_back_when_the_provider_raises():
    class RaisingProvider:
        async def chat(self, *a, **kw):
            raise RuntimeError("boom")

    items = await _decompose_goal("fill the form", RaisingProvider(), "fake/model", {})
    assert items == ["fill the form"]


@pytest.mark.asyncio
async def test_decompose_goal_ignores_a_non_list_or_non_string_response():
    provider = ScriptedJsonProvider('{"not": "a list"}')
    items = await _decompose_goal("fill the form", provider, "fake/model", {})
    assert items == ["fill the form"]


# ─── _verify_goal_completion ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_goal_completion_reports_unmet_items():
    provider = ScriptedJsonProvider('{"unmet": ["City selected"]}')
    unmet = await _verify_goal_completion(
        "fill the form", ["First Name filled", "City selected"], "page summary", [],
        provider, "fake/model", {},
    )
    assert unmet == ["City selected"]


@pytest.mark.asyncio
async def test_verify_goal_completion_reports_empty_when_all_satisfied():
    provider = ScriptedJsonProvider('{"unmet": []}')
    unmet = await _verify_goal_completion(
        "fill the form", ["First Name filled"], "page summary", [], provider, "fake/model", {},
    )
    assert unmet == []


@pytest.mark.asyncio
async def test_verify_goal_completion_fails_open_on_a_broken_verifier():
    """A verifier that can't be parsed must not trap an otherwise-fine run —
    None signals "couldn't check," and the caller treats that as accepting
    the model's own "done", not as a rejection."""
    provider = ScriptedJsonProvider("garbage, not json")
    unmet = await _verify_goal_completion(
        "fill the form", ["City selected"], "page summary", [], provider, "fake/model", {},
    )
    assert unmet is None


# ─── _build_turn_prompt: the unmet-items note ───────────────────────────────

def test_build_turn_prompt_surfaces_unmet_checklist_items():
    prompt = _build_turn_prompt("goal", "summary", [], unmet_checklist_items=["City selected"])
    assert "was rejected" in prompt
    assert "City selected" in prompt


def test_build_turn_prompt_says_nothing_extra_without_unmet_items():
    prompt = _build_turn_prompt("goal", "summary", [], unmet_checklist_items=None)
    assert "was rejected" not in prompt
    prompt2 = _build_turn_prompt("goal", "summary", [], unmet_checklist_items=[])
    assert "was rejected" not in prompt2


# ─── End-to-end through EffectorTool ────────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_goal_off_by_default_matches_pre_pillar_behavior(tmp_path: Path):
    """The core backward-compatibility guarantee: not passing verify_goal must
    behave exactly as before this pillar — no decomposition call, no
    verification call, "done" accepted immediately."""
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")  # verify_goal defaults False

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 1
    assert result["goal_checklist"] is None


@pytest.mark.asyncio
async def test_verify_goal_accepts_done_when_verification_says_satisfied(tmp_path: Path):
    class DecomposeThenVerifyProvider:
        def __init__(self):
            self.calls = 0

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            self.calls += 1
            if self.calls == 1:
                return _FakeLLMResponse(content='["Name filled"]')  # decomposition
            return _FakeLLMResponse(content='{"unmet": []}')  # verification — satisfied

    action_provider = ScriptedProvider([
        {"thought": "fill name", "action": "type", "target": "@e1", "text": "Ada"},
        {"thought": "done", "action": "done"},
    ])
    reasoning_provider = DecomposeThenVerifyProvider()

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=action_provider, model="fake/primary",
        decision_provider=action_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="fill in the name field", verify_goal=True)

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["goal_checklist"] == ["Name filled"]
    assert reasoning_provider.calls == 2  # 1 decompose + 1 verify


@pytest.mark.asyncio
async def test_verify_goal_rejects_done_then_recovers(tmp_path: Path):
    """The exact DemoQA shape: "done" is called with something unmet, gets
    rejected, the model tries again and the follow-up "done" is accepted."""

    class DecomposeThenVerifyProvider:
        def __init__(self):
            self.calls = 0
            self.verify_calls_seen: list[str] = []

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            self.calls += 1
            if self.calls == 1:
                return _FakeLLMResponse(content='["City selected"]')  # decomposition
            # First verification: unmet. Second verification: satisfied.
            if self.calls == 2:
                return _FakeLLMResponse(content='{"unmet": ["City selected"]}')
            return _FakeLLMResponse(content='{"unmet": []}')

    action_provider = ScriptedProvider([
        {"thought": "done (premature)", "action": "done"},
        {"thought": "actually confirm it", "action": "click", "target": "@e2"},
        {"thought": "done (for real)", "action": "done"},
    ])
    reasoning_provider = DecomposeThenVerifyProvider()

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=action_provider, model="fake/primary",
        decision_provider=action_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="select City", verify_goal=True, max_turns=10)

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 3  # rejected done, click, accepted done
    assert reasoning_provider.calls == 3  # decompose + 2 verifications


@pytest.mark.asyncio
async def test_verify_goal_gives_up_with_an_honest_partial_message(tmp_path: Path):
    """A checklist item that's never actually satisfied must not loop forever
    — after _MAX_VERIFICATION_REJECTIONS, the run concedes with a specific,
    honest error instead of a generic timeout."""

    class AlwaysUnmetProvider:
        def __init__(self):
            self.calls = 0

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            self.calls += 1
            if self.calls == 1:
                return _FakeLLMResponse(content='["Name filled", "City selected"]')
            return _FakeLLMResponse(content='{"unmet": ["City selected"]}')

    action_provider = ScriptedProvider([{"thought": "done", "action": "done"}])  # repeats
    reasoning_provider = AlwaysUnmetProvider()

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=action_provider, model="fake/primary",
        decision_provider=action_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="fill name and select city", verify_goal=True, max_turns=10)

    result = json.loads(raw)
    assert result["success"] is False
    assert "1 of 2 checklist items verified" in result["error"]
    assert "City selected" in result["error"]
    assert result["goal_checklist"] == ["Name filled", "City selected"]


@pytest.mark.asyncio
async def test_verify_goal_survives_a_broken_verifier_by_accepting_done(tmp_path: Path):
    """If verification itself can't run/parse, it must fail OPEN — the run
    still succeeds rather than getting stuck behind a broken check."""

    class DecomposeThenBreakProvider:
        def __init__(self):
            self.calls = 0

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            self.calls += 1
            if self.calls == 1:
                return _FakeLLMResponse(content='["Name filled"]')
            return _FakeLLMResponse(content="not valid json")  # verification breaks

    action_provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    reasoning_provider = DecomposeThenBreakProvider()

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=action_provider, model="fake/primary",
        decision_provider=action_provider, decision_model="fake/decision",
        synthesis_provider=reasoning_provider, synthesis_model="fake/reasoning",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="fill the name field", verify_goal=True)

    result = json.loads(raw)
    assert result["success"] is True, result


@pytest.mark.asyncio
async def test_verify_goal_without_a_reasoning_tier_uses_the_decision_provider(tmp_path: Path):
    """No synthesis_provider configured — decomposition/verification must fall
    back to the ordinary decision provider, not silently disable verification."""

    class DecomposeThenVerifyProvider(ScriptedProvider):
        def __init__(self, script):
            super().__init__(script)
            self.extra_calls = 0

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            # The decomposition/verification prompts are single user-message,
            # non-list content — the per-turn action prompt always has this
            # module's _SYSTEM_PROMPT as a system message. Use that shape
            # difference to tell them apart without a separate provider.
            if len(messages) == 1:
                self.extra_calls += 1
                if self.extra_calls == 1:
                    return _FakeLLMResponse(content='["Name filled"]')
                return _FakeLLMResponse(content='{"unmet": []}')
            return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)

    provider = DecomposeThenVerifyProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        # No synthesis_provider/synthesis_model.
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="fill in the name field", verify_goal=True)

    result = json.loads(raw)
    assert result["success"] is True, result
    assert provider.extra_calls == 2  # decompose + verify both ran, on the fallback provider
