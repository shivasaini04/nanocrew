"""Stage 61 (found live by the phase 0 baseline, 2026-09-19): a login macro replayed
all three steps, stayed on /login, and reported success — a false success, because
nothing compared where the replay ended with where the recorded run ended. A macro
now records its verified run's end state and a replay must reach it."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions
from nanoagent.agent.effector.react_loop import _distill_and_save_macro, _try_macro_fast_path
from nanoagent.agent.effector.synthesis import macro_runner
from nanoagent.agent.effector.synthesis.macro_distiller import (
    MacroAction,
    MacroWorkflow,
    find_matching_macro,
    save_macro,
)
from nanoagent.agent.effector.synthesis.macro_runner import execute_macro

from test_effector_phase0 import FakeContext, FakePage, ScriptedProvider

GOAL = "Fill in the name field"


def _macro(**kw) -> MacroWorkflow:
    return MacroWorkflow(
        workflow_id="macro_end_state", domain="example.test", goal=GOAL, goal_hash="abc",
        parameters=[],
        actions=[MacroAction(step_index=1, action="type", target="#name", literal_value="Ada")],
        **kw,
    )


_OPTS = ExecutorOptions(use_human_cadence=False, require_approval=False)


@pytest.mark.asyncio
async def test_a_replay_that_does_not_reach_the_recorded_end_is_not_a_success():
    page = FakePage()  # stays on https://example.test/form
    with patch.object(macro_runner, "_END_STATE_WAIT_S", 0.3):
        result = await execute_macro(_macro(end_url="example.test/done", end_state_recorded=True), page, None, _OPTS)
    assert result.status != "success"
    assert "example.test/done" in result.message
    assert "example.test/form" in result.message


@pytest.mark.asyncio
async def test_a_replay_that_reaches_the_recorded_end_succeeds():
    page = FakePage()
    result = await execute_macro(_macro(end_url="example.test/form", end_state_recorded=True), page, None, _OPTS)
    assert result.status == "success", result.message


@pytest.mark.asyncio
async def test_a_navigation_that_lands_a_moment_later_still_counts():
    """A submit click returns before the page it causes has loaded."""
    import asyncio

    page = FakePage()

    async def _land_later():
        await asyncio.sleep(0.3)
        page.url = "https://example.test/secure"

    task = asyncio.create_task(_land_later())
    result = await execute_macro(_macro(end_url="example.test/secure", end_state_recorded=True), page, None, _OPTS)
    await task
    assert result.status == "success", result.message


@pytest.mark.asyncio
async def test_a_macro_saved_before_end_states_existed_is_not_replayed(tmp_path: Path):
    save_macro(_macro(), tmp_path)  # end_state_recorded defaults to False
    page = FakePage()
    result = await _try_macro_fast_path(
        page, FakeContext(pages=[page]), tmp_path, "example.test", GOAL, None,
        _OPTS, False, None, ScriptedProvider([]), "fake/model", {},
    )
    assert result is None  # falls through to the ReAct loop


def test_distilling_a_run_records_where_it_ended(tmp_path: Path):
    from nanoagent.agent.effector.action_log import append_action_log, build_log_entry
    from nanoagent.agent.effector.types import Step, StepResult

    for i, (action, target, text) in enumerate(
        [("type", "#user", "Ada"), ("type", "#pass", "x1"), ("click", "#go", None)], start=1,
    ):
        step = Step(step=i, action=action, target=target, text=text)
        result = StepResult(step=i, status="success", resolved_target={"selector": target, "name": target})
        append_action_log(tmp_path, "run-1", build_log_entry(step, result, "run-1", "agent"))

    saved = _distill_and_save_macro(
        tmp_path, "run-1", "example.test", "Log in as Ada with password x1",
        final_url="https://example.test/secure?session=123",
    )
    assert saved is not None
    macro = find_matching_macro("example.test", "Log in as Ada with password x1", tmp_path)
    assert macro.end_state_recorded is True
    assert macro.end_url == "example.test/secure"  # query string dropped
