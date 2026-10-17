"""Tests for God-Level Pillar 06, 2026-08-23.

`select_combobox` composes type + wait-for-listbox + match + click + verify-
closed as ONE action, so there's no intermediate "typed but not yet confirmed"
turn for the model to stop at — closing the exact DemoQA failure mode at the
source instead of only detecting it after the fact (which is what the
dropdown_open signal on plain `type` already does, and still does, as the
fallback for callers/models that don't use this action).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.resilience.checkpoint import RunCheckpoint, is_action_already_executed
from nanoagent.agent.effector.types import Step
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse, FakeSession, ScriptedProvider


class FakeSingleOption:
    def __init__(self, page, text: str):
        self._page = page
        self._text = text

    async def inner_text(self) -> str:
        return self._text

    async def click(self, **kw):
        self._page.actions.append(("click_option", self._text))
        self._page.option_clicked = True


class FakeOptionsLocator:
    def __init__(self, page, options: list[str]):
        self._page = page
        self._options = options

    async def count(self) -> int:
        return len(self._options)

    def nth(self, i: int) -> FakeSingleOption:
        return FakeSingleOption(self._page, self._options[i])


class ComboboxPage:
    """A page whose combobox opens a real option list after typing, and closes
    it (the way a real react-select does) once an option is actually clicked."""

    def __init__(self, options: list[str], listbox_opens: bool = True):
        self.url = "https://example.test/form"
        self.viewport_size = {"width": 1280, "height": 720}
        self.actions: list[tuple] = []
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        self._options = options
        self._listbox_opens = listbox_opens
        self.option_clicked = False

    async def title(self) -> str:
        return "Form"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return self._listbox_opens and not self.option_clicked
        if "querySelectorAll" in script:
            return [{
                "tag": "input", "role": "combobox", "name": "", "type": "text",
                "selector": "#city", "bounds": {"x": 0, "y": 0, "width": 200, "height": 30},
                "center": {"x": 100, "y": 15}, "isEnabled": True,
            }]
        return None

    async def wait_for_timeout(self, ms):
        pass

    def locator(self, selector):
        if selector == '[role="listbox"] [role="option"]':
            return FakeOptionsLocator(self, self._options)
        return FakeLocator(self, selector, matched=(selector == "#city"))


# ─── executor.py: select_combobox mechanics ────────────────────────────────────

@pytest.mark.asyncio
async def test_select_combobox_matches_the_exact_option_and_confirms():
    page = ComboboxPage(["NCR", "Other State"])
    step = Step(step=1, action="select_combobox", target="#city", text="NCR")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "success", result
    assert result.data["selected"] == "NCR"
    assert result.data["dropdown_open"] is False  # confirmed — the listbox closed
    assert ("click_option", "NCR") in page.actions


@pytest.mark.asyncio
async def test_select_combobox_falls_back_to_a_single_substring_match():
    page = ComboboxPage(["New York", "Chicago"])
    step = Step(step=1, action="select_combobox", target="#city", text="New")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "success", result
    assert result.data["selected"] == "New York"


@pytest.mark.asyncio
async def test_select_combobox_fails_honestly_on_an_ambiguous_match():
    page = ComboboxPage(["New Delhi", "New York"])
    step = Step(step=1, action="select_combobox", target="#city", text="New")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "failed"
    assert "ambiguously" in result.error
    assert "New Delhi" in result.error
    assert "New York" in result.error
    assert page.option_clicked is False  # never guessed — no click happened


@pytest.mark.asyncio
async def test_select_combobox_fails_honestly_when_nothing_matches():
    page = ComboboxPage(["Mumbai", "Pune"])
    step = Step(step=1, action="select_combobox", target="#city", text="Delhi")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "failed"
    assert "no option matching" in result.error
    assert "Mumbai" in result.error and "Pune" in result.error


@pytest.mark.asyncio
async def test_select_combobox_fails_honestly_when_no_listbox_ever_opens():
    """Typed into something that turned out not to be a real combobox at all —
    must fail clearly, not silently do nothing or crash."""
    page = ComboboxPage([], listbox_opens=False)
    step = Step(step=1, action="select_combobox", target="#city", text="NCR")
    opts = ExecutorOptions(use_human_cadence=False)

    result = await execute_step(step, page, opts)

    assert result.status == "failed"
    assert "no option list" in result.error


@pytest.mark.asyncio
async def test_select_combobox_requires_target_and_text():
    page = ComboboxPage(["NCR"])
    opts = ExecutorOptions(use_human_cadence=False)

    no_target = await execute_step(Step(step=1, action="select_combobox", text="NCR"), page, opts)
    assert no_target.status == "failed"

    no_text = await execute_step(Step(step=1, action="select_combobox", target="#city"), page, opts)
    assert no_text.status == "failed"


# ─── Safety + resume plumbing ────────────────────────────────────────────────

def test_select_combobox_is_covered_by_the_danger_gate():
    dangerous = Step(step=1, action="select_combobox", target="#account-action", text="Delete my account")
    safe = Step(step=1, action="select_combobox", target="#city", text="Delhi")
    assert is_dangerous(dangerous) is True
    assert is_dangerous(safe) is False


def test_select_combobox_is_treated_as_a_mutating_action_for_idempotency():
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="select a city")
    step = Step(step=1, action="select_combobox", target="#city", text="Delhi")
    # Never executed yet — not falsely flagged as a duplicate.
    assert is_action_already_executed(checkpoint, step, "https://x") is False


# ─── End-to-end through EffectorTool: one turn instead of two ─────────────────

@pytest.mark.asyncio
async def test_effector_tool_confirms_a_combobox_in_a_single_turn(tmp_path: Path):
    page = ComboboxPage(["Delhi", "Mumbai"])

    class ComboboxSession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    provider = ScriptedProvider([
        {"thought": "select Delhi from the city combobox", "action": "select_combobox", "target": "#city", "text": "Delhi"},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", ComboboxSession):
        raw = await tool.execute(goal="select Delhi from the city dropdown")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 2  # ONE turn to confirm, not two
    assert result["turns"][0]["action"] == "select_combobox"
    assert result["turns"][0]["status"] == "success"
    assert ("click_option", "Delhi") in page.actions
