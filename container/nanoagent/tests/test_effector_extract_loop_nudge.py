"""Real bug found live, 2026-08-27, test 2.1 of the manual capability suite
: the extract-
visibility fix in test_effector_phase21_extract_visibility.py's own bug
(_recent_actions_text showing a successful extract's actual data) was
necessary but proved NOT sufficient on its own. Live trace: the model typed
"42" into a field (turn 1), then called `extract` FIVE turns running (2-6),
each one genuinely succeeding and returning `{"...": "42"}` — clearly visible
in "Recent actions" every single time — and never once called "done",
burning its entire self-chosen max_turns=6 budget.

The existing generic non-progress nudge (_NONPROGRESS_NUDGE_THRESHOLD=3) does
technically cover repeated extracts (extract isn't in _PROGRESS_ACTIONS), but
it's generic ("scrolling, hovering, waiting, re-checking") and never names the
specific pattern, and its threshold (3) reacted too late against a max_turns
as low as 6 chosen by the caller itself.

Fixed with a new, earlier, more specific nudge (_EXTRACT_LOOP_NUDGE_THRESHOLD=2)
that names exactly what's stuck and what to do about it: "you already have
this data, call done." Takes priority over the generic nudge when both would
apply (they're not mutually exclusive conditions, but showing both would be
redundant noise in the same prompt).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from nanoagent.agent.effector.react_loop import (
    _EXTRACT_LOOP_NUDGE_THRESHOLD,
    _NONPROGRESS_NUDGE_THRESHOLD,
    _build_turn_prompt,
)
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


# ─── _build_turn_prompt: the nudge itself ───────────────────────────────────────

def test_no_extract_nudge_below_the_threshold():
    prompt = _build_turn_prompt(
        "goal", "summary", [], consecutive_successful_extracts=_EXTRACT_LOOP_NUDGE_THRESHOLD - 1,
    )
    assert "already have what" not in prompt


def test_extract_nudge_appears_at_the_threshold_and_names_the_count():
    prompt = _build_turn_prompt(
        "goal", "summary", [], consecutive_successful_extracts=_EXTRACT_LOOP_NUDGE_THRESHOLD,
    )
    assert "already have what" in prompt
    assert "\"done\"" in prompt
    assert str(_EXTRACT_LOOP_NUDGE_THRESHOLD) in prompt


def test_extract_nudge_threshold_is_lower_than_the_generic_nonprogress_one():
    """The whole point of this fix: react sooner to a narrower, more specific
    pattern than the generic guard would on its own."""
    assert _EXTRACT_LOOP_NUDGE_THRESHOLD < _NONPROGRESS_NUDGE_THRESHOLD


def test_extract_nudge_takes_priority_over_the_generic_nonprogress_nudge():
    """When both conditions are true (a real scenario — extract isn't a
    _PROGRESS_ACTIONS entry, so consecutive_nonprogress climbs in lockstep with
    consecutive_successful_extracts when nothing else happens in between), the
    specific nudge wins — showing both would just be redundant noise in the
    same prompt."""
    prompt = _build_turn_prompt(
        "goal", "summary", [],
        consecutive_nonprogress=_NONPROGRESS_NUDGE_THRESHOLD,
        consecutive_successful_extracts=_EXTRACT_LOOP_NUDGE_THRESHOLD,
    )
    assert "already have what" in prompt
    assert "scrolling, hovering, waiting" not in prompt


# ─── Full loop: the counter tracks real extract turns, resets on anything else ──

class _RecordingProvider(ScriptedProvider):
    """Same scripted playback as the base class, but keeps every prompt it was
    asked to decide from — so a test can assert on what the model actually saw
    at a specific turn, not just the final outcome."""

    def __init__(self, script: list[dict]):
        super().__init__(script)
        self.prompts: list[str] = []

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.prompts.append(messages[-1]["content"] if messages else "")
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature, **kw)


@pytest.mark.asyncio
async def test_the_nudge_actually_reaches_the_model_by_the_right_turn(tmp_path):
    """Reproduces the live scenario: type once, then extract repeatedly. By the
    turn immediately after the 2nd consecutive successful extract, the specific
    nudge must be visible in what the model is shown next."""
    script = [
        {"thought": "fill it", "action": "type", "target": "@e1", "text": "42"},
        {"thought": "read it back", "action": "extract", "target": "@e1"},
        {"thought": "read it back again", "action": "extract", "target": "@e1"},
        {"thought": "finished", "action": "done", "extractedData": {"value": "42"}},
    ]
    provider = _RecordingProvider(script)
    tool = EffectorTool(require_approval=False,
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await tool.execute(goal="type and read back")

    # Turn 4's prompt (decided AFTER 2 consecutive successful extracts landed)
    # is the 4th recorded prompt (index 3) — the nudge must be in it.
    assert "already have what" in provider.prompts[3]


@pytest.mark.asyncio
async def test_the_counter_resets_when_something_else_happens_in_between(tmp_path):
    """A single extract in the middle of otherwise-normal progress (a
    legitimate mid-task check) must not trigger the nudge — only genuine
    BACK-TO-BACK repeated extracts should."""
    script = [
        {"thought": "fill name", "action": "type", "target": "@e1", "text": "Ada"},
        {"thought": "check it", "action": "extract", "target": "@e1"},
        {"thought": "fill email", "action": "type", "target": "@e1", "text": "ada@example.com"},
        {"thought": "check it", "action": "extract", "target": "@e1"},
        {"thought": "finished", "action": "done", "extractedData": {"done": True}},
    ]
    provider = _RecordingProvider(script)
    tool = EffectorTool(require_approval=False,
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await tool.execute(goal="fill two fields, checking each")

    assert all("already have what" not in p for p in provider.prompts)
