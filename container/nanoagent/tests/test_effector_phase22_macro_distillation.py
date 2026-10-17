"""Unit and integration tests for Phase 22: Neural Macro Distillation Engine."""

import pytest
from pathlib import Path

from nanoagent.agent.effector.synthesis.macro_distiller import (
    MacroAction,
    MacroAssertion,
    MacroWorkflow,
    distill_macro_from_action_log,
    find_matching_macro,
    load_macro,
    save_macro,
)
from nanoagent.agent.effector.synthesis.macro_runner import execute_macro
from test_effector_phase0 import FakePage


def test_distill_macro_parameterizes_inputs(tmp_path: Path):
    entries = [
        {"action": {"type": "navigate", "url": "https://portal.example.com/login"}, "result": {"status": "success"}},
        {"action": {"type": "type", "target": "#email", "text": "user@example.com"}, "result": {"status": "success"}},
        {"action": {"type": "type", "target": "#password", "text": "SecretPass123"}, "result": {"status": "success"}},
        {"action": {"type": "click", "target": "button[type='submit']"}, "result": {"status": "success"}},
    ]

    params = {
        "email": "user@example.com",
        "password": "SecretPass123",
    }

    macro = distill_macro_from_action_log(
        goal="Log in to example portal",
        domain="portal.example.com",
        action_entries=entries,
        parameter_values=params,
    )

    assert macro.domain == "portal.example.com"
    assert len(macro.actions) == 4
    assert macro.actions[1].action == "type"
    assert macro.actions[1].param_key == "email"
    assert macro.actions[1].literal_value is None
    assert macro.actions[2].param_key == "password"
    assert macro.actions[3].action == "click"
    assert len(macro.actions[3].assertions) > 0


def test_macro_save_and_load_round_trip(tmp_path: Path):
    macro = MacroWorkflow(
        workflow_id="macro_test_123",
        domain="test.domain",
        goal="Perform automated test checkout",
        goal_hash="abc12345",
        parameters=["user", "item"],
        actions=[
            MacroAction(
                step_index=1,
                action="navigate",
                target=None,
                literal_value="https://test.domain",
            ),
            MacroAction(
                step_index=2,
                action="click",
                target="#submit",
                assertions=[MacroAssertion(assertion_type="element_visible", expected="true", target="#submit")],
            ),
        ],
    )

    saved_path = save_macro(macro, tmp_path)
    assert saved_path.exists()

    loaded = load_macro("test.domain", "macro_test_123", tmp_path)
    assert loaded is not None
    assert loaded.workflow_id == macro.workflow_id
    assert loaded.domain == macro.domain
    assert len(loaded.actions) == 2
    assert loaded.actions[1].target == "#submit"

    matched = find_matching_macro("test.domain", "Perform automated test checkout", tmp_path)
    assert matched is not None
    assert matched.workflow_id == macro.workflow_id


@pytest.mark.asyncio
async def test_execute_macro_success_on_valid_page():
    page = FakePage()  # matches #name and #submit
    macro = MacroWorkflow(
        workflow_id="macro_exec_test",
        domain="example.test",
        goal="Test fast-path",
        goal_hash="123456",
        parameters=["name"],
        actions=[
            MacroAction(step_index=1, action="type", target="#name", param_key="name"),
            MacroAction(step_index=2, action="click", target="#submit"),
        ],
    )

    result = await execute_macro(macro, page, parameters={"name": "Alice"})
    assert result.status == "success"
    assert result.steps_completed == 2
    assert ("click", "#name") in page.actions
    typed_chars = [a[1] for a in page.actions if a[0] == "kb_type"]
    assert "".join(typed_chars) == "Alice"
    assert ("click", "#submit") in page.actions

    # Real bug, 2026-08-27 (test 4.2): a successful macro replay used to hand its
    # caller only a status string — no record of what each step actually did or
    # resolved to. Post-replay goal verification (react_loop._try_macro_fast_path)
    # was then judging a genuinely successful run against a bare page snapshot with
    # zero action history, exactly the shape that made a filled-then-invisible
    # react-select field look like nothing happened. `turns` is what closes that —
    # the same Step/StepResult shape _recent_actions_text already knows how to
    # annotate for a live run.
    assert len(result.turns) == 2
    assert [t.action.action for t in result.turns] == ["type", "click"]
    assert all(t.result.status == "success" for t in result.turns)


@pytest.mark.asyncio
async def test_execute_macro_fails_cleanly_on_assertion():
    page = FakePage()
    macro = MacroWorkflow(
        workflow_id="macro_fail_test",
        domain="example.test",
        goal="Test assertion failure",
        goal_hash="123456",
        parameters=[],
        actions=[
            MacroAction(
                step_index=1,
                action="click",
                target="#missing-button",
                assertions=[MacroAssertion(assertion_type="element_visible", expected="true", target="#missing-button")],
            ),
        ],
    )

    result = await execute_macro(macro, page)
    assert result.status == "assertion_failed"
    assert result.steps_completed == 0
    assert result.failed_step_index == 1
