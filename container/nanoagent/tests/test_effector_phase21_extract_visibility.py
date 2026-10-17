"""God-level gap fix, 2026-08-24: a successful `extract` action's actual data was
never shown back to the model in `_recent_actions_text` — only "extract -> success",
identical to a no-op. Found live against demoqa.com's practice form (Tier 0 test 0.2
of the manual capability suite): the model called `extract` four turns running (two
with no thought text at all) and never once called `done`, timing out at max_turns
despite every extract genuinely succeeding — it had no way to tell from its own
history that it already had the data.

These tests drive `_recent_actions_text` directly with real `EffectorTurnLog`/
`StepResult` objects — the exact function react_loop.py calls to build both the
decision prompt and (pillar 05) the goal-verification prompt.
"""

from __future__ import annotations

from nanoagent.agent.effector.react_loop import _recent_actions_text
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult


def _extract_turn(turn: int, data: dict | None, target: str | None = None) -> EffectorTurnLog:
    return EffectorTurnLog(
        turn=turn,
        thought="extracting",
        action=Step(step=turn, action="extract", target=target),
        result=StepResult(step=turn, status="success", data=data),
    )


def test_a_successful_extract_shows_the_actual_data_not_just_success():
    turns = [_extract_turn(1, {"name": "Ada Lovelace", "email": "ada@example.com"})]

    text = _recent_actions_text(turns)

    assert "Turn 1: extract" in text
    assert "-> success" in text
    assert "Ada Lovelace" in text
    assert "ada@example.com" in text


def test_an_empty_extract_gets_an_explicit_nothing_extracted_callout():
    """The exact bug shape: extract called with no target/extract_schema returns {}
    (executor.py's extract handler, not an exception) — a bare truthiness check on
    t.result.data would silently skip this case entirely, reproducing the same
    invisible-failure shape one level down. This must not happen."""
    turns = [_extract_turn(1, {})]

    text = _recent_actions_text(turns)

    assert "Turn 1: extract" in text
    assert "-> success" in text
    assert "extracted NOTHING" in text
    assert "target" in text and "extract_schema" in text


def test_repeated_empty_extracts_each_get_the_callout_not_just_the_latest():
    """Reproduces the exact live sequence: several extract turns in a row. Every one
    needs the callout, not just the most recent — the model reading its last 5 turns
    should see the pattern (repeated empty extracts), not just one flagged instance."""
    turns = [_extract_turn(t, {}) for t in range(1, 4)]

    text = _recent_actions_text(turns)

    assert text.count("extracted NOTHING") == 3


def test_multi_turn_extraction_shows_every_piece_not_just_the_latest():
    """Unlike the dropdown_open note (deliberately last-turn-only, since it's a live
    snapshot that can go stale), extracted text never goes stale — a goal that needs
    several fields pulled across several turns must see ALL of them to stitch into one
    final done() call's extractedData."""
    turns = [
        _extract_turn(1, {"first_name": "Ada"}),
        _extract_turn(2, {"last_name": "Lovelace"}),
        _extract_turn(3, {"email": "ada@example.com"}),
    ]

    text = _recent_actions_text(turns)

    assert "Ada" in text
    assert "Lovelace" in text
    assert "ada@example.com" in text


def test_extract_data_preview_is_truncated_for_a_very_large_result():
    turns = [_extract_turn(1, {"blob": "x" * 6000})]

    text = _recent_actions_text(turns)

    assert "…" in text
    # bounded, not the full value inflating every subsequent prompt
    assert len(text) < 2400


def test_the_newest_extract_gets_room_the_older_ones_do_not():
    """Widened 2026-08-31, from a live run. A whole-page extract came back with 426
    characters and the answer at offset 360; the flat 300-char cap cut it off, so the
    model decided the page did not say what it was asked for and extracted again. Two
    models, same loop. The newest extract is the one being reasoned about now, so it gets
    the room; the older ones keep the small cap, which is the growth the cap was for."""
    answer = "the status is PAUSED"
    filler = "y" * 380
    turns = [
        _extract_turn(1, {"text": filler + " first turn " + answer}),
        _extract_turn(2, {"text": filler + " newest turn " + answer}),
    ]

    text = _recent_actions_text(turns)

    assert "newest turn " + answer in text        # readable, so the model can act on it
    assert "first turn " + answer not in text     # still capped, so five of them cannot
    assert "…" in text                            # and the older one says it was cut


def test_a_failed_step_still_shows_its_error_not_the_extract_branch():
    """Regression guard: the new extract branch must not shadow the existing
    failed-status error surfacing for OTHER action types."""
    turns = [EffectorTurnLog(
        turn=1, thought="clicking",
        action=Step(step=1, action="click", target="@e1"),
        result=StepResult(step=1, status="failed", error="Element not found: @e1"),
    )]

    text = _recent_actions_text(turns)

    assert "Element not found" in text
    assert "extracted" not in text


def test_a_failed_extract_does_not_get_the_success_data_callout():
    turns = [EffectorTurnLog(
        turn=1, thought="extracting",
        action=Step(step=1, action="extract", target="@e1"),
        result=StepResult(step=1, status="failed", error="timeout"),
    )]

    text = _recent_actions_text(turns)

    assert "timeout" in text
    assert "extracted NOTHING" not in text
    assert "extracted:" not in text
