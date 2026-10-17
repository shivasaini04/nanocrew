"""Phase 1 (resilience) reachability tests for Effector — stage43 doc 03.

Same discipline as test_effector_phase0.py: these drive the real code paths
(executor._resolve_with_healing, execute_step's idempotency check, and two separate
run_react_loop calls sharing a checkpoint file to prove resume actually works, not
just that the save/load functions round-trip in isolation).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, _resolve_with_healing, execute_step, resolve_target
from nanoagent.agent.effector.resilience.adaptive_throttle import DomainRateLimiter
from nanoagent.agent.effector.resilience.checkpoint import (
    RunCheckpoint,
    compute_idempotency_key,
    get_checkpoint,
    record_executed_action,
)
from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point, Step
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse, FakeSession, ScriptedProvider


# ─── Self-healing ───────────────────────────────────────────────────────────────

class RerenderingPage:
    """A page whose live DOM has moved on from what an older snapshot recorded —
    same button, different selector (as a real SPA re-render would produce), same
    visible name. Exercises the actual failure resolve_target hits (the ref index
    the LLM used no longer exists in a fresh capture) and the actual recovery path
    (anchor-matched by content, not position)."""

    def __init__(self):
        self.url = "https://example.test/checkout"
        self.viewport_size = {"width": 1280, "height": 720}
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        self.actions: list[tuple] = []

    async def title(self):
        return "Checkout"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if "querySelectorAll" in script:
            return [{
                "tag": "button", "role": "button", "name": "Submit Order", "type": None,
                "selector": "#new-submit-btn",
                "bounds": {"x": 10, "y": 10, "width": 120, "height": 30},
                "center": {"x": 70, "y": 25}, "isEnabled": True,
            }]
        return None

    def locator(self, selector):
        return FakeLocator(self, selector, matched=(selector == "#new-submit-btn"))

    def get_by_text(self, text, exact=False):
        return FakeLocator(self, text, matched=False)

    def get_by_role(self, role, name=None):
        return FakeLocator(self, role, matched=False)

    def get_by_label(self, text, exact=False):
        return FakeLocator(self, text, matched=False)

    def get_by_placeholder(self, text, exact=False):
        return FakeLocator(self, text, matched=False)

    async def screenshot(self, **kw):
        return b"\xff\xd8fake"


@pytest.mark.asyncio
async def test_resolve_target_alone_fails_on_a_stale_ref():
    """Sanity check on the premise: without self-healing, a ref the current live DOM
    doesn't have at that index genuinely fails — this is the failure self-healing
    exists to recover from, not a strawman."""
    page = RerenderingPage()
    with pytest.raises(RuntimeError):
        await resolve_target(page, "@e5")


@pytest.mark.asyncio
async def test_self_healing_recovers_a_stale_ref_by_content_not_position():
    page = RerenderingPage()

    stale_snapshot = DOMSnapshot(
        url="https://example.test/checkout", title="Checkout",
        elements=[DOMElementNode(
            ref="@e5", tag="button", role="button", name="Submit Order", type=None,
            selector="#stale-selector-doesnt-exist-anymore",
            bounds=Bounds(x=10, y=400, width=120, height=30), center=Point(x=70, y=415),
            is_visible=True, is_enabled=True,
        )],
        summary="stale",
    )
    options = ExecutorOptions(self_heal_snapshot=stale_snapshot)

    resolved = await _resolve_with_healing(page, "@e5", options)

    assert resolved._selector == "#new-submit-btn"
    assert options._last_self_heal_confidence is not None
    assert options._last_self_heal_confidence >= 0.55


@pytest.mark.asyncio
async def test_execute_step_records_self_healed_in_its_result():
    page = RerenderingPage()
    stale_snapshot = DOMSnapshot(
        url=page.url, title="Checkout",
        elements=[DOMElementNode(
            ref="@e5", tag="button", role="button", name="Submit Order", type=None,
            selector="#stale-selector-doesnt-exist-anymore",
            bounds=Bounds(x=10, y=400, width=120, height=30), center=Point(x=70, y=415),
            is_visible=True, is_enabled=True,
        )],
        summary="stale",
    )
    step = Step(step=1, action="click", target="@e5")
    options = ExecutorOptions(self_heal_snapshot=stale_snapshot, require_approval=False)

    result = await execute_step(step, page, options)

    assert result.status == "success", result
    assert result.data.get("self_healed") is True
    assert ("click", "#new-submit-btn") in page.actions


# ─── Idempotency / resume-safety ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_step_already_recorded_in_the_checkpoint_is_skipped_not_repeated():
    """The core resume-safety guarantee: replanning the same step on a resumed run
    must not fire the mutating action twice."""
    page = RerenderingPage()  # only used for its .actions log here
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="test")
    step = Step(step=1, action="click", target="#new-submit-btn")
    record_executed_action(checkpoint, step, page.url)

    options = ExecutorOptions(checkpoint=checkpoint, require_approval=False)
    result = await execute_step(step, page, options)

    assert result.status == "skipped"
    assert page.actions == []  # never actually dispatched


def test_idempotency_key_is_stable_for_the_same_step_and_differs_for_a_different_one():
    a = Step(step=1, action="click", target="#submit")
    b = Step(step=2, action="click", target="#submit")  # same effect, different step number
    c = Step(step=1, action="click", target="#cancel")

    key_a1 = compute_idempotency_key(a, run_id="run-1")
    key_a2 = compute_idempotency_key(a, run_id="run-1")
    key_b = compute_idempotency_key(b, run_id="run-1")
    key_c = compute_idempotency_key(c, run_id="run-1")

    assert key_a1 == key_a2  # deterministic
    assert key_a1 == key_b   # step number doesn't affect the side-effect identity
    assert key_a1 != key_c   # different target does


# ─── Adaptive throttle ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_rate_limiter_does_not_wait_within_capacity():
    limiter = DomainRateLimiter()
    for _ in range(4):  # linkedin.com's capacity is 4
        waited = await limiter.acquire("www.linkedin.com")
        assert waited == 0


def test_rate_limiter_matches_by_domain_substring():
    limiter = DomainRateLimiter()
    assert limiter._get_quota("www.linkedin.com").capacity == 4
    assert limiter._get_quota("some-unlisted-site.example").capacity == 25  # default


# ─── Real crash-and-resume across two separate run_react_loop calls ────────────

@pytest.mark.asyncio
async def test_a_second_run_with_the_same_run_id_resumes_instead_of_replaying(tmp_path: Path, monkeypatch):
    """Simulates the actual scenario checkpointing exists for: the process dies mid-
    task, and a second, independent call with the same run_id picks up where it left
    off — without re-clicking the already-recorded submit."""
    import uuid
    fixed_run_id = str(uuid.uuid4())
    monkeypatch.setattr(uuid, "uuid4", lambda: fixed_run_id)

    script_first_attempt = [
        {"thought": "fill", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit", "action": "click", "target": "@e2"},
        # Simulate a crash: no "done" ever arrives in this attempt.
    ]

    class CrashAfterTwoTurns(ScriptedProvider):
        async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
            if self.calls >= 2:
                raise RuntimeError("simulated process crash mid-task")
            return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)

    provider1 = CrashAfterTwoTurns(script_first_attempt)
    tool1 = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider1, model="fake/primary",
                          decision_provider=provider1, decision_model="fake/decision")

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw1 = await tool1.execute(goal="Fill in the name field and submit the form")
    result1 = json.loads(raw1)
    assert result1["success"] is False  # crashed, as scripted

    checkpoint = get_checkpoint(tmp_path, fixed_run_id)
    assert checkpoint is not None
    assert checkpoint.status == "failed"
    # Gap-closing pass, 2026-08-23: a decision failure now retries up to
    # _MAX_CONSECUTIVE_FAILURES (3) before giving up, rather than ending on the
    # very first crash — so current_turn lands 2 turn_nums further out (turns 3,
    # 4, 5 all attempted and failed) than the 2 real, successfully-logged turns.
    # Resume is still correct: it's gated on `checkpoint.turns` (still exactly the
    # 2 real turns below), not on this number.
    assert checkpoint.current_turn == 4
    assert len(checkpoint.executed_idempotency_keys) == 2  # type + click both recorded

    # Second attempt, same run_id (via the monkeypatched uuid4): the LLM re-plans the
    # SAME two steps out of habit (a real model re-shown the same page might well do
    # this) before finishing — the ledger must stop them from firing twice.
    script_second_attempt = [
        {"thought": "fill (again)", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit (again)", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done", "extractedData": {"submitted": True}},
    ]
    provider2 = ScriptedProvider(script_second_attempt)
    tool2 = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider2, model="fake/primary",
                          decision_provider=provider2, decision_model="fake/decision")

    fake_session2 = FakeSession()
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=fake_session2):
        raw2 = await tool2.execute(goal="Fill in the name field and submit the form")
    result2 = json.loads(raw2)

    assert result2["success"] is True, result2
    assert result2["run_id"] == fixed_run_id
    # The replanned type/click were skipped, not re-dispatched — the FakePage's action
    # log for this second session has neither, only "done" produced no page action.
    assert fake_session2.page.actions == []
