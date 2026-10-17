"""Tests for the anti-loop guard, 2026-08-23 — the fix for the persistent
scroll/re-verification loop found across multiple live runs against demoqa.com's
practice form, which survived retry-cap, dropdown-detection, and prompt-wording
fixes.

Unlike _MAX_CONSECUTIVE_FAILURES (which only fires on an actual error), this
catches a run that's technically succeeding at every step but never making real
progress — a distinct failure mode with its own counter, soft nudge, and hard cap.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.react_loop import (
    _MAX_CONSECUTIVE_NONPROGRESS_ACTIONS,
    _NONPROGRESS_NUDGE_THRESHOLD,
    _build_turn_prompt,
)
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


# ─── _build_turn_prompt: the nudge note ─────────────────────────────────────────

def test_no_nudge_below_the_threshold():
    prompt = _build_turn_prompt("goal", "summary", [], consecutive_nonprogress=_NONPROGRESS_NUDGE_THRESHOLD - 1)
    assert "without making real" not in prompt


def test_nudge_appears_at_the_threshold():
    prompt = _build_turn_prompt("goal", "summary", [], consecutive_nonprogress=_NONPROGRESS_NUDGE_THRESHOLD)
    assert "without making real" in prompt
    assert str(_NONPROGRESS_NUDGE_THRESHOLD) in prompt


def test_nudge_keeps_reappearing_while_still_stuck():
    """Unlike the decision-error note (shown once, then cleared), this one
    re-fires every turn while the count stays at or above threshold — a single
    flash of guidance wasn't enough to break the pattern live."""
    prompt_at_4 = _build_turn_prompt("goal", "summary", [], consecutive_nonprogress=_NONPROGRESS_NUDGE_THRESHOLD + 1)
    prompt_at_5 = _build_turn_prompt("goal", "summary", [], consecutive_nonprogress=_NONPROGRESS_NUDGE_THRESHOLD + 2)
    assert "without making real" in prompt_at_4
    assert "without making real" in prompt_at_5


# ─── react_loop.py: progress resets the counter, non-progress increments it ────

@pytest.mark.asyncio
async def test_a_scroll_between_two_real_actions_does_not_trip_the_guard(tmp_path: Path):
    """The common, legitimate case: scroll once to reveal a field, then act on
    it. Must not be treated as the start of a loop."""
    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "scroll to reveal submit", "action": "scroll", "direction": "down"},
        {"thought": "submit", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="fill and submit")

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 4


@pytest.mark.asyncio
async def test_repeated_scrolling_gives_up_before_burning_the_whole_max_turns_budget(tmp_path: Path):
    """The exact scenario found live: the model just keeps scrolling and never
    acts on anything. Must give up well short of max_turns, not exhaust it."""
    script = [{"thought": "", "action": "scroll", "direction": "up"}]  # repeats forever
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert "stuck in a loop" in result["error"]
    assert str(_MAX_CONSECUTIVE_NONPROGRESS_ACTIONS) in result["error"]
    # Gave up well short of the 20-turn budget — the guard fired, not max_turns.
    assert result["turns_executed"] == _MAX_CONSECUTIVE_NONPROGRESS_ACTIONS


@pytest.mark.asyncio
async def test_acting_on_something_after_the_nudge_recovers(tmp_path: Path):
    """The guard's whole purpose: the model sees the nudge and actually acts —
    the run must recover, not be doomed once it's been stuck once."""
    script = [
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
        {"thought": "", "action": "scroll", "direction": "up"},
        # By here consecutive_nonprogress == 3 == threshold — nudge is showing.
        {"thought": "ok, act on something specific", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 5


@pytest.mark.asyncio
async def test_a_repeated_mutating_action_also_counts_as_nonprogress(tmp_path: Path):
    """A click repeated on the exact same target accomplished nothing new either
    time — it must count toward the guard just like scroll/hover/wait do, not be
    treated as "a real action happened" just because execute_step reported
    success again. (Before the 2026-08-27 idempotency-scoping fix, a same-run
    repeat like this came back "skipped" by the idempotency ledger, which is
    what made the old "click succeeded == progress" shortcut work by accident;
    now it genuinely re-dispatches, so the guard has to recognize the repeat
    itself — see react_loop.py's last_progress_signature.)"""
    script = [
        {"thought": "click something", "action": "click", "target": "@e2"},   # succeeds, resets counter
        {"thought": "click it again", "action": "click", "target": "@e2"},    # repeat, no navigation: non-progress
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
        {"thought": "", "action": "scroll", "direction": "up"},
        {"thought": "", "action": "scroll", "direction": "down"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is False
    assert "stuck in a loop" in result["error"]
    # 1 real click + 5 non-progressing turns (skip + 4 scrolls) == the cap.
    assert result["turns_executed"] == 1 + _MAX_CONSECUTIVE_NONPROGRESS_ACTIONS


@pytest.mark.asyncio
async def test_an_action_that_actually_navigates_always_counts_as_progress_even_if_repeated(tmp_path: Path):
    """The flip side of the fix above, and the actual point of the underlying
    idempotency-scoping fix: a repeated action isn't doomed to be permanently
    classified as non-progress — if THIS attempt genuinely changes the page
    (the URL actually moves), that's real progress no matter how many times the
    same action was tried before. Otherwise a retry that finally works (e.g.
    after an overlay clears) would still get counted against the run."""
    script = [
        {"thought": "go", "action": "navigate", "url": "https://example.test/step-1"},
        {"thought": "go again", "action": "navigate", "url": "https://example.test/step-1"},  # repeat, same URL — non-progress
        {"thought": "retry, different target this time", "action": "navigate", "url": "https://example.test/step-2"},  # genuinely new — progress
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False,
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="x", max_turns=20)

    result = json.loads(raw)
    assert result["success"] is True, result
    assert result["turns_executed"] == 4  # completed normally, the guard never fired
