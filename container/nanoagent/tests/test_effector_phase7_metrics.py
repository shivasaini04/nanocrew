"""Tests for the cost/success instrumentation gap-closing pass, 2026-08-23:
EffectorExecutionResult.usage actually gets filled in (decision + vision + synthesis
calls, not just a zeroed default), it survives a checkpoint/resume round trip, and
metrics.py can aggregate it across runs. Same discipline as every other phase — real
react_loop runs through the real Tool, not hand-built result objects.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.metrics import aggregate_run_metrics
from nanoagent.agent.effector.resilience.checkpoint import get_checkpoint
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


@contextmanager
def patch_effector_session(tmp_path: Path):
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        yield

_PER_CALL_USAGE = {
    "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
}


# ─── Usage accumulates across turns ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_effector_tool_reports_usage_accumulated_across_every_turn(tmp_path: Path, monkeypatch):
    import uuid
    fixed_run_id = "run-usage-1"
    monkeypatch.setattr(uuid, "uuid4", lambda: fixed_run_id)

    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch_effector_session(tmp_path):
        raw = await tool.execute(goal="Fill in the name field and submit the form")

    result = json.loads(raw)
    assert result["success"] is True
    assert provider.calls == 3

    # 3 decision calls, each contributing the fixed per-call usage — nothing lost,
    # nothing double-counted.
    assert result["usage"]["prompt_tokens"] == 3 * _PER_CALL_USAGE["prompt_tokens"]
    assert result["usage"]["completion_tokens"] == 3 * _PER_CALL_USAGE["completion_tokens"]
    assert result["usage"]["total_tokens"] == 3 * _PER_CALL_USAGE["total_tokens"]


@pytest.mark.asyncio
async def test_usage_is_zero_not_missing_when_the_provider_returns_none(tmp_path: Path):
    """A provider that doesn't report usage (some LiteLLM routes don't) must not
    crash accumulation — the field stays present and zeroed, never absent."""
    from dataclasses import dataclass, field

    @dataclass
    class NoUsageResponse:
        content: str
        tool_calls: list = field(default_factory=list)
        usage: dict | None = None

    class NoUsageProvider:
        def __init__(self, script):
            self._script = script
            self.calls = 0

        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            action = self._script[min(self.calls, len(self._script) - 1)]
            self.calls += 1
            return NoUsageResponse(content=json.dumps(action))

    provider = NoUsageProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch_effector_session(tmp_path):
        raw = await tool.execute(goal="do nothing")

    result = json.loads(raw)
    assert result["success"] is True
    assert result["usage"] == {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
    }


# ─── Usage survives checkpoint/resume ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_usage_from_a_crashed_attempt_is_included_after_resume(tmp_path: Path, monkeypatch):
    """The exact scenario checkpointing exists for (see test_effector_phase1.py):
    process dies mid-task, a second call with the same run_id resumes. Tokens spent
    in the first attempt must not vanish just because the process did.

    Note (gap-closing pass, 2026-08-23): a decision call that keeps raising now
    retries up to _MAX_CONSECUTIVE_FAILURES before the run gives up, rather than
    ending on the very first raise — but a raise means the provider never actually
    returned a response, so no usage was ever accumulated for those failed calls.
    The totals below are therefore unchanged from before that fix: 1 real
    successful call in the crashed attempt, 2 more after resuming."""
    import uuid
    fixed_run_id = str(uuid.uuid4())
    monkeypatch.setattr(uuid, "uuid4", lambda: fixed_run_id)

    class CrashAfterOneTurn(ScriptedProvider):
        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            if self.calls >= 1:
                raise RuntimeError("simulated crash")
            return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)

    provider1 = CrashAfterOneTurn([
        {"thought": "fill", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
    ])
    tool1 = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider1, model="fake/primary",
                          decision_provider=provider1, decision_model="fake/decision")

    with patch_effector_session(tmp_path):
        raw1 = await tool1.execute(goal="Fill in the name field and submit the form")
    assert json.loads(raw1)["success"] is False

    checkpoint = get_checkpoint(tmp_path, fixed_run_id)
    assert checkpoint is not None
    assert checkpoint.usage["total_tokens"] == _PER_CALL_USAGE["total_tokens"]  # 1 real call before it started crashing

    provider2 = ScriptedProvider([
        {"thought": "submit", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ])
    tool2 = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider2, model="fake/primary",
                          decision_provider=provider2, decision_model="fake/decision")

    with patch_effector_session(tmp_path):
        raw2 = await tool2.execute(goal="Fill in the name field and submit the form")
    result2 = json.loads(raw2)

    assert result2["success"] is True
    # 1 call from the crashed attempt + 2 calls from the resumed attempt.
    assert result2["usage"]["total_tokens"] == 3 * _PER_CALL_USAGE["total_tokens"]


# ─── metrics.py aggregation ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_aggregate_run_metrics_across_completed_and_failed_runs(tmp_path: Path, monkeypatch):
    import uuid
    run_ids = iter(["run-a", "run-b", "run-c"])
    monkeypatch.setattr(uuid, "uuid4", lambda: next(run_ids))

    # run-a: succeeds in 2 turns, domain "example.test"
    provider_a = ScriptedProvider([
        {"thought": "fill", "action": "type", "target": "@e1", "text": "x"},
        {"thought": "done", "action": "done"},
    ])
    tool_a = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider_a, model="fake/primary",
                           decision_provider=provider_a, decision_model="fake/decision")
    with patch_effector_session(tmp_path):
        await tool_a.execute(goal="a", session_domain="example.test")

    # run-b: fails (target never resolves) — react_loop now retries a failed step
    # up to _MAX_CONSECUTIVE_FAILURES (3) times before giving up, so this is 3
    # decision calls, not 1. Domain "example.test".
    provider_b = ScriptedProvider([
        {"thought": "click nothing", "action": "click", "target": "#does-not-exist"},
    ])
    tool_b = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider_b, model="fake/primary",
                           decision_provider=provider_b, decision_model="fake/decision")
    with patch_effector_session(tmp_path):
        await tool_b.execute(goal="b", session_domain="example.test")

    # run-c: succeeds in 1 turn, domain "other.test"
    provider_c = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool_c = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider_c, model="fake/primary",
                           decision_provider=provider_c, decision_model="fake/decision")
    with patch_effector_session(tmp_path):
        await tool_c.execute(goal="c", session_domain="other.test")

    metrics = aggregate_run_metrics(tmp_path)

    assert metrics.total_runs == 3
    assert metrics.completed == 2
    assert metrics.failed == 1
    assert metrics.success_rate == pytest.approx(2 / 3)
    assert metrics.total_usage["total_tokens"] == (2 + 3 + 1) * _PER_CALL_USAGE["total_tokens"]

    assert set(metrics.by_domain.keys()) == {"example.test", "other.test"}
    assert metrics.by_domain["example.test"].total_runs == 2
    assert metrics.by_domain["example.test"].completed == 1
    assert metrics.by_domain["example.test"].failed == 1
    assert metrics.by_domain["other.test"].total_runs == 1
    assert metrics.by_domain["other.test"].completed == 1


def test_aggregate_run_metrics_on_an_empty_workspace_is_not_an_error(tmp_path: Path):
    metrics = aggregate_run_metrics(tmp_path)
    assert metrics.total_runs == 0
    assert metrics.success_rate is None
    assert metrics.avg_turns is None
