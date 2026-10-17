"""Stage 61 phase 0: every Effector decision and executed step leaves a timed record,
with enough of what the model saw to replay the decision against another decider.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.decision_log import action_fields, read_records
from nanoagent.agent.effector.metrics import aggregate_step_timings, format_report
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


async def _run(tmp_path: Path, script: list, goal: str = "fill the city field") -> dict:
    provider = ScriptedProvider(script)
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        return json.loads(await tool.execute(goal=goal, session_domain="example.test"))


@pytest.mark.asyncio
async def test_each_turn_leaves_a_decision_and_its_outcome(tmp_path: Path):
    result = await _run(tmp_path, [
        {"thought": "type the city", "action": "type", "target": "@e1", "text": "Delhi"},
        {"thought": "finished", "action": "done"},
    ])
    assert result["success"] is True, result

    records = read_records(tmp_path)
    decisions = [r for r in records if r["type"] == "decision"]
    outcomes = [r for r in records if r["type"] == "outcome"]

    assert [d["action"]["action"] for d in decisions] == ["type", "done"]
    first = decisions[0]
    assert first["action"] == {"action": "type", "target": "@e1", "text": "Delhi"}
    assert first["goal"] == "fill the city field"
    assert first["model"] == "fake/decision"
    # What a replay needs: the element table and the exact prompt the model saw.
    assert "@e1" in first["elements"]
    assert "fill the city field" in first["prompt"]
    for key in ("throttle_ms", "snapshot_ms", "settle_ms", "capture_ms", "prep_ms", "decision_ms"):
        assert isinstance(first[key], int) and first[key] >= 0, key
    assert first["snapshot_ms"] >= first["settle_ms"]

    # `done` ends the run without executing anything, so only the type step has one.
    assert len(outcomes) == 1
    assert outcomes[0]["turn"] == first["turn"]
    assert outcomes[0]["status"] == "success"
    assert isinstance(outcomes[0]["execute_ms"], int)
    assert outcomes[0]["turn_ms"] >= outcomes[0]["execute_ms"]


class _GarbledFirstReply(ScriptedProvider):
    async def chat(self, messages, **kw):
        response = await super().chat(messages, **kw)
        if self.calls == 1:
            response.content = "sorry, I cannot {"
        return response


@pytest.mark.asyncio
async def test_an_unusable_reply_is_recorded_as_a_failed_decision(tmp_path: Path):
    provider = _GarbledFirstReply([
        {"thought": "unused", "action": "wait"},
        {"thought": "finished", "action": "done"},
    ])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await tool.execute(goal="fill the city field", session_domain="example.test")
    decisions = [r for r in read_records(tmp_path) if r["type"] == "decision"]
    assert decisions[0]["error"]
    assert decisions[0]["action"] is None
    assert decisions[1]["action"]["action"] == "done"


def test_a_credential_step_never_records_text():
    fields = action_fields({
        "action": "type", "target": "@e2", "text": "hunter2", "credential_ref": "site:password",
    })
    assert "text" not in fields
    assert fields["credential_ref"] == "site:password"


@pytest.mark.asyncio
async def test_report_summarises_timings_across_runs(tmp_path: Path):
    await _run(tmp_path, [
        {"thought": "type", "action": "type", "target": "@e1", "text": "Delhi"},
        {"thought": "finished", "action": "done"},
    ])
    await _run(tmp_path, [{"thought": "finished", "action": "done"}], goal="another goal")

    timings = aggregate_step_timings(tmp_path)
    assert timings.decisions == 3
    assert timings.actions == {"type": 1, "done": 2}
    assert timings.outcomes == {"success": 1}
    assert timings.timings["decision_ms"]["n"] == 3
    assert timings.timings["execute_ms"]["n"] == 1

    report = format_report(tmp_path)
    assert "decision_ms" in report
    assert "Decisions: 3" in report


def test_no_records_reads_as_empty(tmp_path: Path):
    assert read_records(tmp_path) == []
    assert aggregate_step_timings(tmp_path).decisions == 0


@pytest.mark.asyncio
async def test_the_run_itself_is_timed_phase_by_phase(tmp_path: Path):
    result = await _run(tmp_path, [{"thought": "finished", "action": "done"}])
    runs = [r for r in read_records(tmp_path) if r["type"] == "run"]
    assert len(runs) == 1
    run = runs[0]
    for key in ("session_ms", "loop_ms", "post_loop_ms", "teardown_ms", "total_ms"):
        assert isinstance(run[key], int) and run[key] >= 0, key
    # No starting URL in this run, so there is no page load to time.
    assert run["first_page_ms"] is None
    assert run["total_ms"] >= run["loop_ms"]
    # The caller gets the same numbers in the result.
    assert result["timings"]["total_ms"] == run["total_ms"]


def test_run_timings_measure_each_span_between_marks():
    from nanoagent.agent.effector.decision_log import run_timings
    t = run_timings({
        "start": 0.0, "session": 5.0, "navigated": 7.0, "challenge": 7.5,
        "loop_start": 8.0, "loop_end": 18.0, "post_loop": 19.0, "end": 21.0,
    })
    assert t == {
        "session_ms": 5000, "first_page_ms": 2000, "challenge_ms": 500, "loop_ms": 10000,
        "post_loop_ms": 1000, "teardown_ms": 2000, "total_ms": 21000, "pre_loop_other_ms": 500,
    }
