"""Real bug found live, 2026-08-27, test 5.1 of the manual capability suite
 — the third bypass
found in that single test run, deeper than the other two.

A click on saucedemo.com's "Checkout" button was correctly denied by the
escalation gate. The model then tried `navigate` to the same URL mid-run —
closed by test_effector_danger_gate_navigate_bypass.py. Denied again, its
NEXT attempt passed the identical dangerous URL as the `effector` tool's own
`url` KWARG instead of a mid-run action, and that succeeded completely: the
tool's initial `page.goto(url, ...)` runs before `run_react_loop` (and its
is_dangerous/request_approval gate) is ever entered, so it was never checked
at all — not a text-matching gap, a structural one. The full purchase
completed via this path in the live trace.

The exact same shape exists in every other caller that does its own initial
navigation ahead of run_react_loop: EffectorWorkflowTool's per-stage `url`
(blueprints/runner.py's `_run_goal`) and EffectorSwarmTool's per-job `url`
(effector_swarm.py's `_run_one_job`) — both fixed the same way, both covered
here.

effector.py and effector_swarm.py import `request_approval` inside the
function body (matching how these tools already import their other effector
dependencies) — tests patch the ORIGINAL location
(`nanoagent.agent.effector.escalation.request_approval`) for those, since a
module-level patch target would silently not apply to a name resolved fresh
inside the function at call time. blueprints/runner.py imports it at module
level instead (matching that file's existing style), so its test patches the
runner module's own bound name.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.blueprints.runner import BlueprintContext, run_multi_stage_workflow
from nanoagent.agent.tools.effector import EffectorTool
from nanoagent.agent.tools.effector_swarm import EffectorSwarmTool

from test_effector_phase0 import FakePage, FakeSession, ScriptedProvider

_ORIGINAL_URL = "https://example.test/form"  # FakePage's default page.url


# ─── EffectorTool.execute()'s own initial url ──────────────────────────────

@pytest.mark.asyncio
async def test_a_dangerous_starting_url_is_denied_before_any_navigation(tmp_path: Path):
    provider = ScriptedProvider([])  # must never be reached — denied before the loop starts
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    session = FakeSession()

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.escalation.request_approval", new=AsyncMock(return_value="denied")) as approval:
        result = json.loads(await tool.execute(goal="describe the page", url="https://www.saucedemo.com/checkout-step-one.html"))

    approval.assert_called_once()
    assert approval.await_args.args[0].action == "navigate"
    assert approval.await_args.args[0].url == "https://www.saucedemo.com/checkout-step-one.html"
    assert "Escalation gate blocked the starting URL" in result["error"]
    assert session.page.url == _ORIGINAL_URL, "goto must not have run at all — denied before navigation"


@pytest.mark.asyncio
async def test_an_ordinary_starting_url_is_never_even_checked(tmp_path: Path):
    """Must not turn every starting URL into an approval round trip."""
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    session = FakeSession()

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.escalation.request_approval", new=AsyncMock()) as approval:
        result = json.loads(await tool.execute(goal="describe the page", url="https://www.saucedemo.com/inventory.html"))

    approval.assert_not_called()
    assert result["success"] is True, result
    assert session.page.url == "https://www.saucedemo.com/inventory.html"


@pytest.mark.asyncio
async def test_an_approved_dangerous_starting_url_still_navigates(tmp_path: Path):
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    session = FakeSession()

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.escalation.request_approval", new=AsyncMock(return_value="approved")):
        result = json.loads(await tool.execute(goal="describe the page", url="https://www.saucedemo.com/checkout-step-one.html"))

    assert result["success"] is True, result
    assert session.page.url == "https://www.saucedemo.com/checkout-step-one.html"


# ─── blueprints/runner.py's per-stage url (multi-stage workflow) ───────────

@pytest.mark.asyncio
async def test_a_dangerous_stage_url_is_denied_before_any_navigation(tmp_path: Path):
    page = FakePage()
    ctx = BlueprintContext(page=page, provider=ScriptedProvider([]), model="fake/model", workspace=tmp_path)
    stages = [{"id": "s1", "name": "Go straight to checkout", "goal": "describe the page",
               "url": "https://www.saucedemo.com/checkout-step-one.html"}]

    # blueprints/runner.py imports request_approval at module level (unlike
    # effector.py/effector_swarm.py's function-body imports), so the patch target
    # is the runner module's own bound name, not escalation's.
    with patch("nanoagent.agent.effector.blueprints.runner.request_approval", new=AsyncMock(return_value="denied")) as approval:
        result = await run_multi_stage_workflow(ctx, stages, max_stage_retries=1)  # isolate to one attempt

    approval.assert_called_once()
    assert result.success is False
    assert result.data["failed_stage"] == "s1"
    assert "Escalation gate blocked the starting URL" in result.data["stages"][0]["error"]
    assert page.url == _ORIGINAL_URL, "goto must not have run at all — denied before navigation"


@pytest.mark.asyncio
async def test_an_ordinary_stage_url_is_never_even_checked(tmp_path: Path):
    page = FakePage()
    ctx = BlueprintContext(
        page=page, provider=ScriptedProvider([{"thought": "done", "action": "done"}]),
        model="fake/model", workspace=tmp_path,
    )
    stages = [{"id": "s1", "name": "Go to inventory", "goal": "describe the page",
               "url": "https://www.saucedemo.com/inventory.html"}]

    with patch("nanoagent.agent.effector.blueprints.runner.request_approval", new=AsyncMock()) as approval:
        result = await run_multi_stage_workflow(ctx, stages)

    approval.assert_not_called()
    assert result.success is True, result.data


# ─── effector_swarm.py's per-job url ────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_dangerous_job_url_is_denied_before_any_navigation(tmp_path: Path):
    session = FakeSession()
    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=ScriptedProvider([]), model="fake/primary",
        decision_provider=ScriptedProvider([]), decision_model="fake/decision",
    )
    jobs = [{"goal": "describe the page", "url": "https://www.saucedemo.com/checkout-step-one.html"}]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.escalation.request_approval", new=AsyncMock(return_value="denied")) as approval:
        raw = await tool.execute(jobs=jobs)

    result = json.loads(raw)
    approval.assert_called_once()
    assert result["succeeded"] == 0
    assert result["failed"] == 1
    assert "Escalation gate blocked the starting URL" in result["results"][0]["error"]
    assert session.page.url == _ORIGINAL_URL, "goto must not have run at all — denied before navigation"


@pytest.mark.asyncio
async def test_an_ordinary_job_url_is_never_even_checked(tmp_path: Path):
    session = FakeSession()
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    jobs = [{"goal": "describe the page", "url": "https://www.saucedemo.com/inventory.html"}]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=session), \
         patch("nanoagent.agent.effector.escalation.request_approval", new=AsyncMock()) as approval:
        raw = await tool.execute(jobs=jobs)

    result = json.loads(raw)
    approval.assert_not_called()
    assert result["succeeded"] == 1
