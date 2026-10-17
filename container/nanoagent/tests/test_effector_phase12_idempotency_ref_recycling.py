"""Tests for the idempotency-ledger ref-recycling bug, found live against
demoqa.com's practice form, 2026-08-23.

Root cause: @ref tags (e.g. "@e15") are reassigned fresh every DOM snapshot by
document-order index. Turn 9's "click @e15" selected a State dropdown option
(NCR); turn 14's "click @e15" selected a DIFFERENT, later-rendered City dropdown
option (Delhi) — two genuinely different real-world actions that happened to
share a recycled label. The idempotency ledger keyed on the raw target string,
so it silently skipped turn 14's click, believing it was a duplicate of turn 9's.

Fix: resolve a @ref target to its element's own selector (id/name/class-derived,
stable across snapshots) before it becomes part of the idempotency identity —
see resilience/checkpoint.py's _stable_target_identity.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.resilience.checkpoint import (
    RunCheckpoint,
    _stable_target_identity,
    compute_idempotency_key,
    is_action_already_executed,
    record_executed_action,
)
from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point, Step
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeKeyboard, FakeMouse, FakeSession, ScriptedProvider


def _snapshot_with(ref: str, selector: str, name: str = "") -> DOMSnapshot:
    return DOMSnapshot(
        url="https://example.test/form", title="Form",
        elements=[DOMElementNode(
            ref=ref, tag="div", role="option", name=name, selector=selector,
            bounds=Bounds(x=0, y=0, width=100, height=20), center=Point(x=50, y=10),
            is_visible=True, is_enabled=True,
        )],
        summary="",
    )


# ─── _stable_target_identity ────────────────────────────────────────────────────

def test_a_ref_resolves_to_its_elements_own_selector():
    snapshot = _snapshot_with("@e15", "#ncr-option", name="NCR")
    assert _stable_target_identity("@e15", snapshot) == "#ncr-option"


def test_the_same_label_resolves_differently_across_two_snapshots():
    """The exact bug: label "@e15" pointing at two different real elements on
    two different turns must produce two different identities."""
    snapshot_turn9 = _snapshot_with("@e15", "#ncr-option", name="NCR")
    snapshot_turn14 = _snapshot_with("@e15", "#delhi-option", name="Delhi")

    identity1 = _stable_target_identity("@e15", snapshot_turn9)
    identity2 = _stable_target_identity("@e15", snapshot_turn14)

    assert identity1 != identity2


def test_a_ref_with_no_matching_element_falls_back_to_the_raw_label():
    snapshot = _snapshot_with("@e15", "#ncr-option")
    assert _stable_target_identity("@e99", snapshot) == "@e99"


def test_a_non_ref_target_is_unaffected():
    """A real CSS selector or literal text isn't recycled between snapshots —
    nothing to resolve, use it as-is."""
    snapshot = _snapshot_with("@e15", "#ncr-option")
    assert _stable_target_identity("#submit-button", snapshot) == "#submit-button"
    assert _stable_target_identity("Login", snapshot) == "Login"


def test_no_snapshot_available_falls_back_to_the_raw_target():
    """Callers with no snapshot (execute_steps, form_filler, direct execute_step
    calls with a bare ExecutorOptions()) keep the pre-fix behavior exactly —
    this fix is additive, not a requirement on every caller."""
    assert _stable_target_identity("@e15", None) == "@e15"


def test_empty_target_is_handled():
    assert _stable_target_identity(None, None) == ""
    assert _stable_target_identity("", None) == ""


# ─── compute_idempotency_key / is_action_already_executed / record ─────────────

def test_two_different_elements_sharing_a_recycled_ref_get_different_keys():
    step_turn9 = Step(step=9, action="click", target="@e15")
    step_turn14 = Step(step=14, action="click", target="@e15")

    key1 = compute_idempotency_key(step_turn9, "run-1", snapshot=_snapshot_with("@e15", "#ncr-option"))
    key2 = compute_idempotency_key(step_turn14, "run-1", snapshot=_snapshot_with("@e15", "#delhi-option"))

    assert key1 != key2


def test_the_same_real_element_produces_the_same_key_across_snapshots():
    """The flip side — a genuine repeat (same real element, re-planned after a
    resume) must still be caught. Two DIFFERENT snapshots, but the SAME element
    (by its stable selector) must still collide."""
    step_first_attempt = Step(step=2, action="click", target="@e3")
    step_resumed_attempt = Step(step=2, action="click", target="@e9")  # different label, same element

    key1 = compute_idempotency_key(step_first_attempt, "run-1", snapshot=_snapshot_with("@e3", "#submit-btn"))
    key2 = compute_idempotency_key(step_resumed_attempt, "run-1", snapshot=_snapshot_with("@e9", "#submit-btn"))

    assert key1 == key2  # same real target, genuinely a duplicate


def test_end_to_end_the_bug_scenario_no_longer_false_skips():
    """Reproduces the exact live scenario: within ONE run (no resume at all —
    the bug fired mid-run, not just on resume), turn 9 clicks @e15 (NCR),
    turn 14 clicks @e15 (Delhi, a different element after State re-rendered
    the page). Before the fix, turn 14 was wrongly reported as already-executed."""
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="fill the form")

    step_turn9 = Step(step=9, action="click", target="@e15")
    snapshot_turn9 = _snapshot_with("@e15", "#ncr-option", name="NCR")
    assert is_action_already_executed(checkpoint, step_turn9, "https://x", snapshot_turn9) is False
    record_executed_action(checkpoint, step_turn9, "https://x", snapshot_turn9)

    step_turn14 = Step(step=14, action="click", target="@e15")  # same label, different element
    snapshot_turn14 = _snapshot_with("@e15", "#delhi-option", name="Delhi")
    assert is_action_already_executed(checkpoint, step_turn14, "https://x", snapshot_turn14) is False

    # And a genuine repeat of turn 9 (same element, re-planned) is still caught.
    assert is_action_already_executed(checkpoint, step_turn9, "https://x", snapshot_turn9) is True


# ─── Full react_loop: the second click of a recycled label actually fires ──────

class RecycledRefPage:
    """Every snapshot has exactly ONE element, so it's always labeled "@e1" —
    but a different real element (different selector) each turn, matching what
    a re-rendering SPA does (an old option list unmounts, a new one mounts in
    its place). Proves the bug end-to-end, not just at the checkpoint-function
    level: react_loop -> execute_step -> the real checkpoint wiring."""

    def __init__(self, selectors_by_turn: list[str]):
        self.url = "https://example.test/form"
        self.viewport_size = {"width": 1280, "height": 720}
        self.actions: list[tuple] = []
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        self._selectors_by_turn = selectors_by_turn

    async def title(self):
        return "Form"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if 'role="listbox"' in script:
            return False
        if "querySelectorAll" in script:
            # Keyed on how many real actions have fired, not on how many times
            # evaluate() has been called — resolve_target does its OWN snapshot
            # re-fetch on top of react_loop's perception snapshot every turn, so
            # this gets called TWICE per turn. The underlying "page" must only
            # actually change once a real action executes, exactly like a real
            # browser (nothing changes between two evaluate() calls with no
            # interaction between them).
            idx = min(len(self.actions), len(self._selectors_by_turn) - 1)
            selector = self._selectors_by_turn[idx]
            return [{
                "tag": "div", "role": "option", "name": "", "selector": selector,
                "bounds": {"x": 0, "y": 0, "width": 100, "height": 20},
                "center": {"x": 50, "y": 10}, "isEnabled": True,
            }]
        return None

    def locator(self, selector):
        from test_effector_phase0 import FakeLocator
        return FakeLocator(self, selector, matched=(selector in self._selectors_by_turn))


@pytest.mark.asyncio
async def test_a_recycled_ref_label_does_not_falsely_skip_the_second_click(tmp_path: Path):
    page = RecycledRefPage(["#ncr-option", "#delhi-option"])

    class RecycledRefSession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    provider = ScriptedProvider([
        {"thought": "select NCR", "action": "click", "target": "@e1"},
        {"thought": "select Delhi", "action": "click", "target": "@e1"},  # same label, different element
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", RecycledRefSession):
        raw = await tool.execute(goal="select NCR then Delhi")

    result = json.loads(raw)
    assert result["success"] is True, result
    # Before the fix: turn 2 would report status "skipped" (falsely believed
    # already-executed). Both clicks must have genuinely fired.
    assert result["turns"][0]["status"] == "success"
    assert result["turns"][1]["status"] == "success"
    assert ("click", "#ncr-option") in page.actions
    assert ("click", "#delhi-option") in page.actions
