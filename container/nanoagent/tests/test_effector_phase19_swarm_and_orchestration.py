"""God-level pillar 02 tests, 2026-08-24.

Two independent additions:
1. `run_multi_stage_workflow` (blueprints/runner.py) — wires the previously-dead
   orchestration/hierarchical_orchestrator.py into a path an LLM tool call can
   actually reach (stages as plain JSON -> TaskStage wrapping _run_goal).
2. `EffectorSwarmTool` (tools/effector_swarm.py) — genuine parallel execution of N
   independent goals via asyncio.gather across isolated FakeSession instances, with
   a hard concurrency cap.

Both drive the REAL orchestrator / real Tool.execute() path, per this project's
established discipline (test_effector_phase0.py's module docstring) — only the
Playwright surface and LLM provider are faked.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.blueprints.runner import BlueprintContext, run_multi_stage_workflow
from nanoagent.agent.tools.effector_swarm import EffectorSwarmTool
from nanoagent.agent.tools.effector_workflow import EffectorWorkflowTool

from test_effector_phase0 import FakeContext, FakePage, FakeSession


@dataclass
class FakeLLMResponse:
    content: str | None
    usage: dict | None = None


_USAGE = {
    "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
}


class ConstantActionProvider:
    """Always returns the SAME decision regardless of call count — deliberately
    order-independent, since multiple concurrent jobs sharing one provider instance
    would otherwise race on an index-based script (see module docstring's design
    note: a per-call-count script isn't safe when several coroutines call chat()
    interleaved on one event loop)."""

    def __init__(self, action: dict):
        self._action = action
        self.calls = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw) -> FakeLLMResponse:
        self.calls += 1
        return FakeLLMResponse(content=json.dumps(self._action), usage=dict(_USAGE))

    def get_default_model(self) -> str:
        return "fake/decision-model"


_DONE_ACTION = {"thought": "immediately done", "action": "done", "extractedData": {"ok": True}}
_STUCK_ACTION = {"thought": "targeting something that doesn't exist", "action": "click", "target": "@e99"}


# ─── run_multi_stage_workflow: direct unit tests against the real orchestrator ──

@pytest.mark.asyncio
async def test_multi_stage_runs_every_stage_in_order_through_the_real_orchestrator(tmp_path: Path):
    provider = ConstantActionProvider(_DONE_ACTION)
    ctx = BlueprintContext(page=FakePage(), provider=provider, model="fake/model", workspace=tmp_path)

    stages = [
        {"id": "s1", "name": "Log into Stripe", "app": "Stripe", "goal": "log in"},
        {"id": "s2", "name": "Export invoices", "app": "Stripe", "goal": "export invoices"},
        {"id": "s3", "name": "Upload to portal", "app": "Portal", "goal": "upload the file"},
    ]

    result = await run_multi_stage_workflow(ctx, stages)

    assert result.type == "multi-stage"
    assert result.success is True
    assert result.data["completed_stages"] == 3
    assert [s["status"] for s in result.data["stages"]] == ["passed", "passed", "passed"]
    assert result.data["failed_stage"] is None
    assert "s1_result" in result.data["context"]


@pytest.mark.asyncio
async def test_multi_stage_stops_on_a_failing_stage_and_never_runs_the_rest(tmp_path: Path):
    provider = ConstantActionProvider(_STUCK_ACTION)  # every turn fails to resolve -> stage gives up
    ctx = BlueprintContext(page=FakePage(), provider=provider, model="fake/model", workspace=tmp_path)

    stages = [
        {"id": "s1", "name": "Doomed stage", "app": "Stripe", "goal": "do something impossible", "max_turns": 3},
        {"id": "s2", "name": "Never reached", "app": "Slack", "goal": "should not run"},
    ]

    result = await run_multi_stage_workflow(ctx, stages, max_stage_retries=1)

    assert result.success is False
    assert result.data["failed_stage"] == "s1"
    assert result.data["completed_stages"] == 0
    statuses = {s["id"]: s["status"] for s in result.data["stages"]}
    assert statuses["s1"] == "failed"
    assert "s2" not in statuses  # orchestrator stopped before reaching it


@pytest.mark.asyncio
async def test_multi_stage_rejects_an_empty_stage_list(tmp_path: Path):
    provider = ConstantActionProvider(_DONE_ACTION)
    ctx = BlueprintContext(page=FakePage(), provider=provider, model="fake/model", workspace=tmp_path)

    result = await run_multi_stage_workflow(ctx, [])

    assert result.success is False
    assert "stages" in result.data["error"]


@pytest.mark.asyncio
async def test_effector_workflow_tool_reaches_the_real_orchestrator_for_multi_stage(tmp_path: Path):
    """End-to-end through the actual Tool.execute() -> run_digital_employee_workflow
    -> run_multi_stage_workflow -> run_hierarchical_workflow chain — proves the JSON
    schema wiring (stages as a list-of-dicts tool argument), not just the function."""
    provider = ConstantActionProvider(_DONE_ACTION)

    tool = EffectorWorkflowTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    stages = [
        {"id": "s1", "goal": "step one"},
        {"id": "s2", "goal": "step two"},
    ]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(workflow_type="multi-stage", stages=stages)

    result = json.loads(raw)

    assert result["workflow_type"] == "multi-stage"
    assert result["success"] is True
    assert result["data"]["completed_stages"] == 2


# ─── EffectorSwarmTool: genuine parallel execution ─────────────────────────────

@pytest.mark.asyncio
async def test_swarm_runs_every_job_concurrently_and_aggregates_results(tmp_path: Path):
    provider = ConstantActionProvider(_DONE_ACTION)

    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    jobs = [{"goal": f"job {i}"} for i in range(4)]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(jobs=jobs)

    result = json.loads(raw)

    assert result["total_jobs"] == 4
    assert result["succeeded"] == 4
    assert result["failed"] == 0
    assert len(result["results"]) == 4
    assert all(r["success"] for r in result["results"])
    assert {r["goal"] for r in result["results"]} == {f"job {i}" for i in range(4)}


@pytest.mark.asyncio
async def test_swarm_tolerates_one_jobs_session_failing_without_stopping_the_rest(tmp_path: Path):
    provider = ConstantActionProvider(_DONE_ACTION)

    class PartiallyBrokenSession:
        """FakeSession that raises on construction for one specific session_domain
        — isolates the failure to a single job deterministically, independent of
        scheduling order (unlike an index-based script shared across coroutines)."""

        def __init__(self, workspace, session_domain=None, **kw):
            self._session_domain = session_domain
            self.page = FakePage()
            self.context = FakeContext(pages=[self.page])

        async def __aenter__(self):
            if self._session_domain == "broken.test":
                raise RuntimeError("simulated session failure")
            return self

        async def __aexit__(self, *a):
            pass

    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    jobs = [
        {"goal": "good job A", "session_domain": "fine.test"},
        {"goal": "bad job", "session_domain": "broken.test"},
        {"goal": "good job B", "session_domain": "also-fine.test"},
    ]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", PartiallyBrokenSession):
        raw = await tool.execute(jobs=jobs)

    result = json.loads(raw)

    assert result["total_jobs"] == 3
    assert result["succeeded"] == 2
    assert result["failed"] == 1
    failed = [r for r in result["results"] if not r["success"]]
    assert len(failed) == 1
    assert failed[0]["goal"] == "bad job"
    assert "simulated session failure" in failed[0]["error"]


@pytest.mark.asyncio
async def test_swarm_requires_a_nonempty_jobs_list(tmp_path: Path):
    provider = ConstantActionProvider(_DONE_ACTION)
    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    raw = await tool.execute(jobs=[])
    result = json.loads(raw)

    assert "error" in result


@pytest.mark.asyncio
async def test_swarm_actually_runs_concurrently_and_respects_the_hard_concurrency_cap(tmp_path: Path):
    """Proves two things at once: jobs genuinely overlap in time (not accidentally
    serialized), AND the requested max_concurrency (20) is clamped to the hard cap
    (6) rather than trusted — a single container can't host 20 Chromium processes."""
    provider = ConstantActionProvider(_DONE_ACTION)

    class ConcurrencyTrackingSession:
        active = 0
        peak = 0

        def __init__(self, workspace, session_domain=None, **kw):
            self.page = FakePage()
            self.context = FakeContext(pages=[self.page])

        async def __aenter__(self):
            ConcurrencyTrackingSession.active += 1
            ConcurrencyTrackingSession.peak = max(ConcurrencyTrackingSession.peak, ConcurrencyTrackingSession.active)
            await asyncio.sleep(0.05)  # hold the "slot" long enough for overlap to be observable
            return self

        async def __aexit__(self, *a):
            ConcurrencyTrackingSession.active -= 1

    tool = EffectorSwarmTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    jobs = [{"goal": f"job {i}"} for i in range(10)]

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", ConcurrencyTrackingSession):
        raw = await tool.execute(jobs=jobs, max_concurrency=20)  # deliberately over the hard cap

    result = json.loads(raw)

    assert result["succeeded"] == 10
    assert ConcurrencyTrackingSession.peak > 1  # actually overlapped, not serialized
    assert ConcurrencyTrackingSession.peak <= 6  # never exceeded the hard cap
