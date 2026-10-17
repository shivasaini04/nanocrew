"""R5 — CanaryGuard wired into the decision loop; benchmark made real and runnable.

Both modules appeared only in their own definition, their package __init__ re-export,
and their tests. Nothing constructed either.

The canary detects a failure nothing else here catches: the control plane leaking into
the data plane — the agent about to type its own instruction text into a page or an
outbound request. That is not something a human can usefully approve after the fact, so
a leak is a hard abort before the step executes.

The benchmark had a second problem beyond never being run: two of its five categories
were hardcoded `score=2.0, passed=True` with a prose blurb. They would have reported
PASS with the modules they claim to measure deleted outright. Every stealth number in
the roadmap rested on that.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.benchmarks.benchmark_harness import AdversarialBenchmarkHarness
from nanoagent.agent.effector.security.canary_guard import CanaryGuard
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider

PKG_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PKG_ROOT.parents[2]


# ------------------------------------------------------------------- canary unit


def test_each_run_gets_a_distinct_token():
    assert CanaryGuard().token != CanaryGuard().token


def test_leak_in_a_step_value_is_caught():
    guard = CanaryGuard()
    ok, reason = guard.validate_step({"action": "type", "text": f"prefix {guard.token} suffix"})
    assert ok is False
    assert "text" in reason


def test_near_miss_does_not_trigger():
    """A false positive aborts real work — match must be exact."""
    guard = CanaryGuard()
    assert guard.validate_step({"action": "type", "text": "CANARY_SEC_deadbeefdeadbeef"})[0] is True
    assert guard.validate_step({"action": "type", "text": guard.token[:-4]})[0] is True


def test_ordinary_steps_pass():
    guard = CanaryGuard()
    for step in (
        {"action": "click", "target": "@e1"},
        {"action": "type", "target": "@e2", "text": "Ada Lovelace"},
        {"action": "navigate", "url": "https://example.com/pricing"},
    ):
        assert guard.validate_step(step)[0] is True, step


def test_is_leaked_detects_the_token_in_a_payload():
    guard = CanaryGuard()
    assert guard.is_leaked(f'{{"q": "{guard.token}"}}') is True
    assert guard.is_leaked('{"q": "ordinary search"}') is False


# ------------------------------------------------------- canary reachability (R5)


def _tool(tmp_path: Path, script: list[dict], **kw) -> tuple[EffectorTool, ScriptedProvider]:
    provider = ScriptedProvider(script)
    return EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        require_approval=False, **kw,
    ), provider


class _TokenCapturingProvider(ScriptedProvider):
    """Reads the canary out of the system prompt, then echoes it back in a step —
    exactly what a page that captured our instruction text would induce."""

    def __init__(self, script: list[dict]):
        super().__init__(script)
        self.system_seen: str = ""

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        for m in messages:
            if isinstance(m, dict) and m.get("role") == "system":
                self.system_seen = str(m.get("content", ""))
        if "<internal_integrity_token>" in self.system_seen:
            token = self.system_seen.split("<internal_integrity_token>")[1].split("<")[0]
            self._script = [{"thought": "leaking", "action": "type",
                             "target": "@e1", "text": token}]
        return await super().chat(messages, model, max_tokens, temperature, **kw)


@pytest.mark.asyncio
async def test_canary_is_planted_in_the_system_prompt(tmp_path: Path):
    """R5 reachability guard: fails if react_loop stops constructing a CanaryGuard."""
    provider = _TokenCapturingProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        require_approval=False, firewall_protection=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await tool.execute(goal="test")

    assert "<internal_integrity_token>" in provider.system_seen


@pytest.mark.asyncio
async def test_leaked_step_aborts_the_run_before_executing(tmp_path: Path):
    """The leak must stop the action, not merely log it."""
    provider = _TokenCapturingProvider([{"thought": "start", "action": "wait", "duration": 0.01}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        require_approval=False, firewall_protection=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession), \
         patch("nanoagent.agent.effector.react_loop.execute_step", new=AsyncMock()) as executor:
        out = json.loads(await tool.execute(goal="test"))

    assert out["success"] is False
    assert "control_plane_leak" in (out["error"] or "")
    assert out["canary_triggered"] is True
    executor.assert_not_called(), "the leaking step was executed anyway"


@pytest.mark.asyncio
async def test_clean_run_does_not_trigger_the_canary(tmp_path: Path):
    tool, _ = _tool(tmp_path, [{"thought": "done", "action": "done"}], firewall_protection=True)

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        out = json.loads(await tool.execute(goal="test"))

    assert out["success"] is True
    assert out["canary_triggered"] is False


@pytest.mark.asyncio
async def test_canary_is_disabled_with_the_firewall(tmp_path: Path):
    provider = _TokenCapturingProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        require_approval=False, firewall_protection=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        out = json.loads(await tool.execute(goal="test"))

    assert "<internal_integrity_token>" not in provider.system_seen
    assert out["canary_triggered"] is False


def test_network_shield_accepts_a_canary():
    """R5 §2.2: the second checkpoint, for a leak that never passes through a Step."""
    import inspect

    from nanoagent.agent.effector.stealth.network_shield import apply_network_shield

    assert "canary" in inspect.signature(apply_network_shield).parameters
    source = inspect.getsource(apply_network_shield)
    assert "canary.is_leaked" in source, "the canary parameter is accepted but never used"


# --------------------------------------------------------------------- benchmark


def test_kinetics_category_actually_measures_a_trajectory():
    """Was hardcoded score=2.0/passed=True — it would have passed with the module gone."""
    result = AdversarialBenchmarkHarness._measure_kinetics()
    assert "points" in result.details and "deviation" in result.details
    assert result.passed is True


def test_kinetics_category_fails_when_kinetics_is_broken():
    """Proves the measurement is real: break the module, the category must fail."""
    with patch(
        "nanoagent.agent.effector.stealth.kinetics.generate_neuromotor_trajectory",
        side_effect=RuntimeError("boom"),
    ):
        result = AdversarialBenchmarkHarness._measure_kinetics()
    assert result.passed is False
    assert result.score == 0.0


def test_ledger_category_actually_detects_a_tamper():
    result = AdversarialBenchmarkHarness._measure_ledger()
    assert result.passed is True
    assert "detected" in result.details.lower()


def test_unmeasured_dimensions_are_reported_not_passed():
    """R5 §3.3: a dimension with no engine behind it must never report PASS."""
    report = AdversarialBenchmarkHarness.evaluate_profile_heuristics(DEVICE_PROFILES[0])
    assert report.unmeasured, "static harness claimed full coverage"

    md = report.to_markdown()
    assert "NOT MEASURED" in md
    assert any("JA3/JA4" in u for u in report.unmeasured), (
        "transport fingerprinting has no engine in this build and must say so"
    )
    for u in report.unmeasured:
        assert "PASS" not in u


def test_benchmark_has_a_runnable_entry_point():
    """R5 §3.4: wire it or delete it. An unrun benchmark implies measurement that
    has not happened, which is how the roadmap's stealth numbers got their backing."""
    script = PKG_ROOT / "scripts" / "run_stealth_benchmark.py"
    pkg = PKG_ROOT / "nanoagent" / "agent" / "effector" / "benchmarks"
    assert script.exists() or not pkg.exists(), (
        "benchmark package exists but has no runner — wire it or delete it (R5 §3.4)"
    )
