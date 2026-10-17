"""Phase 27: the macro fast path, driven through the REAL tool -> react_loop chain.

Phase 22 shipped a distiller and a runner with unit tests that called both directly,
and nothing else ever called either — the engine was never wired into the loop, so a
hundredth run of a daily task still paid for twenty decision calls exactly like the
first. Worse, the shape those unit tests exercised (CSS selectors like "#email") is not
the shape a real run produces: react_loop targets are "@e14" refs, which are ordinals
into a single turn's snapshot and identify nothing in a later run. A macro distilled
from a real run would have replayed refs against a page that had renumbered them.

These tests drive the same path loop.py does, so they fail if the wiring comes out —
which is the property the phase-22 unit tests could not check.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions
from nanoagent.agent.effector.react_loop import _try_macro_fast_path
from nanoagent.agent.effector.synthesis.macro_distiller import MacroAction, MacroWorkflow, save_macro
from nanoagent.agent.tools.effector import EffectorTool
from test_effector_phase0 import FakeContext, FakePage, FakeSession, ScriptedProvider

# The two-action task every test here replays: fill the name field, click submit.
_SCRIPT = [
    {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
    {"thought": "submit the form", "action": "click", "target": "@e2"},
    {"thought": "form submitted", "action": "done", "extractedData": {"submitted": True}},
]

# Stage 49: the name is now IN the goal, and that is the point of the change rather than
# a detail of the fixture. This goal previously said only "fill in the name field", the
# model invented "Ada Lovelace" to satisfy it, and distillation froze the invention into
# a macro that replayed it forever at zero decision calls — the same defect found live on
# example.com (`John Doe`, `Paper Sorting Inc`). A value the caller named is safe to
# freeze, because a macro only replays for the identical goal; a value the model invented
# is not. See test_an_invented_value_is_not_replayed below for the other half.
_GOAL = "Fill in the name field with Ada Lovelace and submit the form"


def _tool(workspace: Path, provider) -> EffectorTool:
    return EffectorTool(
        workspace=workspace,
        provider=provider,
        model="fake/primary-model",
        decision_provider=provider,
        decision_model="fake/decision-model",
        use_human_cadence=False,
        # @e2 is the fake page's Submit button, which trips the approval gate. These
        # tests are about the macro engine; the gate has its own coverage in
        # test_effector_phase28_danger_gate_refs.py.
        require_approval=False,
    )


def _saved_macros(workspace: Path) -> list[dict]:
    macro_dir = workspace / ".effector" / "macros"
    return [json.loads(p.read_text(encoding="utf-8")) for p in macro_dir.rglob("*.json")]


@pytest.mark.asyncio
async def test_successful_run_distills_a_macro_with_durable_selectors_not_refs(tmp_path: Path):
    """The bug that made phase 22 unusable in production: a macro is only replayable if
    it records what the target RESOLVED to, not the @ref the model named."""
    provider = ScriptedProvider(_SCRIPT)
    session = FakeSession()

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session):
        result = json.loads(await _tool(tmp_path, provider).execute(goal=_GOAL))

    assert result["success"] is True, result
    assert result["macro_distilled"], "a successful run should compile into a macro"

    macros = _saved_macros(tmp_path)
    assert len(macros) == 1, macros
    targets = [a["target"] for a in macros[0]["actions"]]

    assert targets == ["#name", "#submit"], targets
    assert not any(str(t).startswith("@e") for t in targets), (
        f"a @ref is an ordinal into one snapshot — it cannot be replayed: {targets}"
    )
    # The accessible name is recorded alongside, so replay survives a changed class name.
    assert [a["target_name"] for a in macros[0]["actions"]] == ["Name", "Submit"]


@pytest.mark.asyncio
async def test_second_identical_run_replays_the_macro_with_zero_decision_calls(tmp_path: Path):
    """The whole point of the engine: work the agent has already figured out gets
    cheaper, not the same price forever."""
    first_provider = ScriptedProvider(_SCRIPT)
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=FakeSession()):
        first = json.loads(await _tool(tmp_path, first_provider).execute(goal=_GOAL))
    assert first["success"] is True and first_provider.calls == 3

    second_provider = ScriptedProvider(_SCRIPT)
    second_session = FakeSession()
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=second_session):
        second = json.loads(await _tool(tmp_path, second_provider).execute(goal=_GOAL))

    assert second["success"] is True, second
    assert second_provider.calls == 0, "the fast path must not call the decision model at all"
    assert second["macro_used"] == first["macro_distilled"]
    assert second["turns_executed"] == 0

    # Per this repo's own discipline (an agent's own record is not evidence): check the
    # page actually received the actions rather than trusting the success flag.
    assert ("fill", "#name", "Ada Lovelace") in second_session.page.actions
    assert ("click", "#submit") in second_session.page.actions


class _MovedSubmitPage(FakePage):
    """The same form after a redesign that removed #submit — the ordinary reason a
    recorded macro stops being valid."""

    def locator(self, selector: str):
        return super().locator(selector if selector != "#submit" else "#gone")


@pytest.mark.asyncio
async def test_a_stale_macro_falls_back_to_the_react_loop_instead_of_acting_blind(tmp_path: Path):
    """A macro is a bet that the page hasn't changed. Losing it has to be cheap and
    safe: the assertion catches the missing element BEFORE the click, the speculative
    scope puts the page back, and the normal loop re-plans from there."""
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=FakeSession()):
        first = json.loads(await _tool(tmp_path, ScriptedProvider(_SCRIPT)).execute(goal=_GOAL))
    assert first["macro_distilled"]

    # The fallback re-plans without the element that disappeared.
    fallback_script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "no submit button on this page any more", "action": "done"},
    ]
    provider = ScriptedProvider(fallback_script)
    session = FakeSession()
    session.page = _MovedSubmitPage()
    session.context.pages = [session.page]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session):
        second = json.loads(await _tool(tmp_path, provider).execute(goal=_GOAL))

    assert second["success"] is True, second
    assert second["macro_used"] is None, "a macro that missed its assertion must not be reported as used"
    assert provider.calls > 0, "the loop must take over when the fast path can't complete the task"
    assert not any(a[0] == "click" and a[1] == "#submit" for a in session.page.actions), (
        "the macro must not have clicked a stale target"
    )


@pytest.mark.asyncio
async def test_a_failed_run_is_not_compiled_into_a_macro(tmp_path: Path):
    """Only a genuine "done" is worth recording — a run that gave up may have left the
    page half-finished, and compiling that teaches the fast path a broken procedure."""
    provider = ScriptedProvider([
        {"thought": "click something that isn't there", "action": "click", "target": "#does-not-exist"},
    ])

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        result = json.loads(await _tool(tmp_path, provider).execute(goal="Click a button that isn't on the page"))

    assert result["success"] is False
    assert result["macro_distilled"] is None
    assert _saved_macros(tmp_path) == []


@pytest.mark.asyncio
async def test_verify_goal_after_a_macro_replay_sees_the_macros_own_turns_not_nothing(tmp_path: Path):
    """Real bug, 2026-08-27 (test 4.2 of the manual capability suite): post-replay
    goal verification used to be called with an empty turns list — no matter how
    real the macro's success was, the verifier had nothing but a bare page snapshot
    to judge it against, and a filled-then-hidden field (test 3.1's shape) reads as
    "never happened" with nothing else to go on. A macro that had just succeeded got
    reported "unmet", rolled back, and handed to a ReAct loop that inherited an
    already-mutated page with no explanation — a confirmed live 9-minute failure on
    what should have been a zero-decision-call replay.

    This proves the wiring, not the model's judgment: `_verify_goal_completion` must
    receive the macro's own real turns, not `[]`."""
    workspace = tmp_path
    macro = MacroWorkflow(
        workflow_id="macro_verify_test",
        domain="example.test",
        goal="Fill in the name field",
        goal_hash="abc123",
        parameters=[],
        actions=[MacroAction(step_index=1, action="type", target="#name", literal_value="Ada")],
        end_state_recorded=True,
    )
    save_macro(macro, workspace)

    page = FakePage()
    context = FakeContext(pages=[page])
    exec_opts = ExecutorOptions(use_human_cadence=False, require_approval=False)

    with patch(
        "nanoagent.agent.effector.react_loop._verify_goal_completion",
        new=AsyncMock(return_value=[]),  # "all satisfied" — isolates the wiring, not the judgment
    ) as verify_mock:
        result = await _try_macro_fast_path(
            page, context, workspace, "example.test", "Fill in the name field", None,
            exec_opts, True, ["Name filled"], ScriptedProvider([]), "fake/model", {},
        )

    assert result is not None and result.macro_used == "macro_verify_test", result
    verify_mock.assert_awaited_once()
    turns_arg = verify_mock.await_args.args[3]
    assert len(turns_arg) == 1, (
        "the macro's own executed step must reach the verifier — an empty list here "
        "is exactly the regression this test exists to catch"
    )
    assert turns_arg[0].action.action == "type"
    assert turns_arg[0].result.status == "success"


@pytest.mark.asyncio
async def test_an_invented_value_is_not_replayed(tmp_path: Path):
    """The other half of the fast path's bargain, added in stage 49.

    When the goal does not name the value, the model makes one up to satisfy the field.
    Freezing that turns one run's guess into what the agent does every time, at zero
    decision calls, with no model in the loop to notice — found live on example.com,
    where `John Doe` and `Paper Sorting Inc` were replayed as though they were facts.

    So the second run must NOT take the fast path: the macro records the procedure, the
    ReAct loop decides the value again (and can now ask for it).
    """
    goal_without_a_name = "Fill in the name field and submit the form"

    first_provider = ScriptedProvider(_SCRIPT)
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=FakeSession()):
        first = json.loads(await _tool(tmp_path, first_provider).execute(goal=goal_without_a_name))
    assert first["success"] is True

    second_provider = ScriptedProvider(_SCRIPT)
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=FakeSession()):
        second = json.loads(await _tool(tmp_path, second_provider).execute(goal=goal_without_a_name))

    assert second["success"] is True, second
    assert second.get("macro_used") is None, "an invented value must not replay"
    assert second_provider.calls > 0, "the model has to decide the value again"
