"""Phase 28: the escalation gate must see the ELEMENT, not the @ref that names it.

Found 2026-08-24 while wiring the macro fast path. `is_dangerous()` matched its
patterns against `step.target`, and react_loop plans almost entirely in "@e7"-style
refs — its own system prompt tells the model to prefer them over CSS selectors. So the
string being checked for "submit"/"pay"/"delete" was literally "@e7", which contains
none of those words, and every ref-targeted click walked through the gate untouched.
Only a raw CSS or text target ever tripped it.

The hole was visible in the old test suite and codified rather than fixed: phase 8's
approval test carried the comment `{"target": "@e2"},  # #submit, safe target text` and
patched `is_dangerous` to return True so the gate would fire at all.

These tests pin the fixed behavior at both levels — the pure predicate, and the real
tool -> react_loop path where it actually has to hold.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.effector.types import Step
from nanoagent.agent.tools.effector import EffectorTool
from test_effector_phase0 import FakePage, FakeSession, ScriptedProvider


@pytest.mark.asyncio
async def test_a_ref_pointing_at_a_dangerous_element_is_dangerous(tmp_path: Path):
    """@e2 is the fake page's Submit button. Judging it by the ref string says "safe";
    judging it by the element says otherwise, and the element is what gets clicked."""
    snapshot = await capture_dom_snapshot(FakePage())
    step = Step(step=1, action="click", target="@e2")

    assert is_dangerous(step, snapshot) is True
    # Without the snapshot there is nothing to expand the ref against — the old,
    # blind answer. Kept explicit so the difference is impossible to misread as noise.
    assert is_dangerous(step) is False


@pytest.mark.asyncio
async def test_a_ref_pointing_at_an_ordinary_element_is_not_dangerous(tmp_path: Path):
    """The fix must not turn every click into an approval round trip — @e1 is a plain
    text input and has to stay through-traffic."""
    snapshot = await capture_dom_snapshot(FakePage())
    step = Step(step=1, action="click", target="@e1")

    assert is_dangerous(step, snapshot) is False


@pytest.mark.asyncio
async def test_the_gate_actually_fires_on_a_ref_click_through_the_real_loop(tmp_path: Path):
    """The property that matters: not that the predicate is right in isolation, but
    that a run driving a ref-targeted Submit click reaches a human decision. This is
    the exact path that was unguarded in production."""
    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession), \
         patch("nanoagent.agent.effector.react_loop.request_approval", return_value="denied") as approval:
        result = json.loads(await tool.execute(goal="Fill in the name field and submit the form"))

    approval.assert_called_once()
    assert approval.call_args.args[0].target == "@e2"
    assert result["success"] is False
    assert "Denied by operator" in (result["error"] or "")


@pytest.mark.asyncio
async def test_an_approved_ref_click_still_goes_through(tmp_path: Path):
    """The gate is a decision point, not a wall — approval must let the click land."""
    script = [
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    session = FakeSession()
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.react_loop.request_approval", return_value="approved") as approval:
        result = json.loads(await tool.execute(goal="Submit the form"))

    approval.assert_called_once()
    assert result["success"] is True, result
    assert ("click", "#submit") in session.page.actions
