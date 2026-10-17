"""Tests for the combobox-confirmation gap, 2026-08-23 — the "why didn't it just
select City" follow-up to phase10's fixes.

Root cause (confirmed with a live diagnostic against demoqa.com): typing into a
react-select-style combobox only FILTERS its option list; it never confirms a
selection. The `type` action reported a bare {"typed": True} regardless, so the
model had no signal that a dropdown was left open, and moved on believing the
field was fully handled.

Two-part fix:
1. `type`'s executor now checks for a visible role="listbox" (the generic
   WAI-ARIA signal an option list is open) after typing and reports it.
2. react_loop's prompt-builder surfaces that as an explicit note on the turn
   history, and the system prompt teaches the two-step convention directly.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, _listbox_is_open, execute_step
from nanoagent.agent.effector.react_loop import _SYSTEM_PROMPT, _build_turn_prompt
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeContext, FakeKeyboard, FakeMouse, FakePage, ScriptedProvider, _FAKE_ELEMENTS


# ─── executor.py: type reports whether a listbox is left open ──────────────────

class DropdownPage:
    def __init__(self, listbox_open_after_type: bool):
        self.url = "https://example.test/form"
        self.viewport_size = {"width": 1280, "height": 720}
        self.actions: list[tuple] = []
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        self._listbox_open = listbox_open_after_type

    async def title(self):
        return "Form"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return self._listbox_open
        if "querySelectorAll" in script:
            return [{
                "tag": "input", "role": "combobox", "name": "", "type": "text",
                "selector": "#city", "bounds": {"x": 0, "y": 0, "width": 200, "height": 30},
                "center": {"x": 100, "y": 15}, "isEnabled": True,
            }]
        return None

    def locator(self, selector):
        from test_effector_phase0 import FakeLocator
        return FakeLocator(self, selector, matched=(selector == "#city"))


@pytest.mark.asyncio
async def test_type_action_reports_dropdown_open_when_a_listbox_is_visible():
    page = DropdownPage(listbox_open_after_type=True)
    step = Step(step=1, action="type", target="#city", text="Delhi")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "success", result
    assert result.data["dropdown_open"] is True


@pytest.mark.asyncio
async def test_type_action_reports_no_dropdown_for_an_ordinary_text_field():
    page = DropdownPage(listbox_open_after_type=False)
    step = Step(step=1, action="type", target="#city", text="Ada")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "success", result
    assert result.data["dropdown_open"] is False


@pytest.mark.asyncio
async def test_listbox_check_fails_safe_if_evaluate_raises():
    class BrokenPage:
        async def evaluate(self, script, arg=None):
            raise RuntimeError("boom")

    assert await _listbox_is_open(BrokenPage()) is False


# ─── react_loop.py: the prompt surfaces an open dropdown, and only then ────────

def test_build_turn_prompt_surfaces_an_open_dropdown():
    turn = EffectorTurnLog(
        turn=1, thought="typed delhi",
        action=Step(step=1, action="type", target="#city", text="Delhi"),
        result=StepResult(step=1, status="success", data={"typed": True, "dropdown_open": True}),
    )
    prompt = _build_turn_prompt("select city", "summary", [turn])
    assert "dropdown is still open" in prompt
    assert "click the matching option" in prompt


def test_build_turn_prompt_says_nothing_extra_for_a_normal_successful_type():
    turn = EffectorTurnLog(
        turn=1, thought="typed name",
        action=Step(step=1, action="type", target="@e1", text="Ada"),
        result=StepResult(step=1, status="success", data={"typed": True, "dropdown_open": False}),
    )
    prompt = _build_turn_prompt("fill form", "summary", [turn])
    assert "dropdown is still open" not in prompt


def test_build_turn_prompt_handles_a_type_result_with_no_data_at_all():
    """Every other action's StepResult.data isn't a dict shaped like type's (e.g.
    click's is {"clicked": True} too, but scroll/hover have different shapes) —
    must not crash reading .get("dropdown_open") off something unexpected."""
    turn = EffectorTurnLog(
        turn=1, thought="scrolled", action=Step(step=1, action="scroll"),
        result=StepResult(step=1, status="success", data={"delta_x": 0, "delta_y": 300}),
    )
    prompt = _build_turn_prompt("goal", "summary", [turn])
    assert "dropdown is still open" not in prompt


# ─── react_loop.py: the system prompt teaches the convention directly ──────────

def test_system_prompt_teaches_the_combobox_confirmation_convention():
    # Reworded, 2026-08-23, when god-level pillar 06 added the atomic
    # select_combobox action — the prompt now points at that action first,
    # with the manual type-then-click sequence as the documented reason NOT
    # to use plain "type" alone, rather than as the primary recommended path.
    assert "select_combobox" in _SYSTEM_PROMPT.lower()
    assert "typing alone only filters" in _SYSTEM_PROMPT.lower()


def test_system_prompt_asks_for_one_final_check_not_ongoing_reverification():
    """Reworded live, 2026-08-23: an earlier phrasing ("before calling done,
    re-check... don't assume an earlier action completed something") triggered a
    real regression — the model started scrolling back to re-verify already-
    successful fields mid-task instead of moving forward, and a run that had
    reached the hard part (State/City dropdowns) on the previous live attempt
    got stuck in a 10-turn scroll loop and never got there again. The fix must
    say to TRUST a prior success and do the check exactly once, right at the end."""
    prompt = _SYSTEM_PROMPT.lower()
    assert "do not scroll back" in prompt
    assert "trust a" in prompt
    assert "one final read" in prompt


# ─── End-to-end: the note actually reaches a real run's prompt ─────────────────

class RecordingScriptedProvider(ScriptedProvider):
    """Records EVERY call's messages (not just the last) — the dropdown-open note
    only appears on the turn right after the type action, not on later turns."""

    def __init__(self, script):
        super().__init__(script)
        self.all_messages: list = []

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.all_messages.append(messages)
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


class DropdownOpensAfterTypePage(FakePage):
    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return True
        if "querySelectorAll" in script:
            return _FAKE_ELEMENTS
        return None


@pytest.mark.asyncio
async def test_a_dropdown_left_open_after_typing_is_visible_in_the_next_prompt(tmp_path: Path):
    page = DropdownOpensAfterTypePage()

    class DropdownSession:
        def __init__(self, *a, **kw):
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    provider = RecordingScriptedProvider([
        {"thought": "type into the field", "action": "type", "target": "@e1", "text": "Delhi"},
        {"thought": "confirm the option", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", DropdownSession):
        raw = await tool.execute(goal="select Delhi from the city dropdown")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns"][0]["action"] == "type"

    # Turn 2's prompt (call index 1 — the decision right after the type) must
    # carry the note; turn 1's (before anything happened) and turn 3's (after
    # the confirming click) must not.
    assert "dropdown is still open" not in provider.all_messages[0][1]["content"]
    assert "dropdown is still open" in provider.all_messages[1][1]["content"]
    assert "dropdown is still open" not in provider.all_messages[2][1]["content"]
