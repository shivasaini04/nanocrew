"""Real bug found live, 2026-08-27, test 3.1 of the manual capability suite
: a `select_combobox`'s
actual selected value was never shown back to the model in
`_recent_actions_text` — only "select_combobox -> success", the exact same
invisible-success shape the extract-visibility fix
(test_effector_phase21_extract_visibility.py) closed for `extract`, just for a
different action.

Compounds with a real, separate DOM fact confirmed via a live before/after
snapshot diff on demoqa.com's practice form: once a react-select-style
combobox has a value picked, its own `<input>` commonly becomes invisible in
the NEXT snapshot entirely (display:none — the selected value renders as a
sibling "chip", not the input itself). Live trace: State and City both got
genuinely selected (turns 2-3, real successes, reproduced directly against
the live site), then the model spent turns 4-9 scrolling for fields it could
no longer see — because they were never shown to have succeeded in its own
history, and they can never reappear as an interactive element once filled —
and gave up without ever calling done, despite the task actually being done.

Same test pattern as test_effector_phase21_extract_visibility.py: drives
`_recent_actions_text` directly with real EffectorTurnLog/StepResult objects.
"""

from __future__ import annotations

from nanoagent.agent.effector.react_loop import _recent_actions_text
from nanoagent.agent.effector.types import EffectorTurnLog, Step, StepResult


def _combobox_turn(turn: int, data: dict | None, target: str = "@e14") -> EffectorTurnLog:
    return EffectorTurnLog(
        turn=turn, thought="selecting",
        action=Step(step=turn, action="select_combobox", target=target, text="NCR"),
        result=StepResult(step=turn, status="success", data=data),
    )


def test_a_successful_select_shows_the_actual_selected_value():
    turns = [_combobox_turn(1, {"selected": "NCR", "dropdown_open": False})]

    text = _recent_actions_text(turns)

    assert "Turn 1: select_combobox" in text
    assert "-> success" in text
    assert "'NCR'" in text or '"NCR"' in text


def test_the_disappearing_input_note_is_included():
    """The whole point of this fix: the model needs to know NOT to go looking
    for this field again, because it structurally can't be found the normal
    way once filled — not just that it succeeded."""
    turns = [_combobox_turn(1, {"selected": "NCR", "dropdown_open": False})]

    text = _recent_actions_text(turns)

    assert "disappears from later element lists" in text
    assert "not a sign anything went wrong" in text


def test_multi_turn_selections_each_show_their_own_value_not_just_the_latest():
    """Reproduces the exact live sequence: State then City, both selected in
    consecutive turns — the model needs to see BOTH confirmed, not just the
    most recent one, to correctly conclude the whole task is done."""
    turns = [
        _combobox_turn(1, {"selected": "NCR", "dropdown_open": False}, target="@e14"),
        _combobox_turn(2, {"selected": "Delhi", "dropdown_open": False}, target="@e14"),
    ]

    text = _recent_actions_text(turns)

    assert "'NCR'" in text or '"NCR"' in text
    assert "'Delhi'" in text or '"Delhi"' in text


def test_a_still_open_dropdown_is_still_flagged_on_the_last_turn():
    """Regression guard: select_combobox's own dropdown_open signal (the
    pillar-05 gap-closing note) must still work through the new branch, not
    get silently dropped now that select_combobox has its own elif."""
    turns = [_combobox_turn(1, {"selected": "NCR", "dropdown_open": True})]

    text = _recent_actions_text(turns)

    assert "a dropdown is still open" in text


def test_a_stale_dropdown_open_note_is_not_shown_for_an_earlier_turn():
    """Same staleness scoping as the generic dropdown_open branch: only the
    MOST RECENT turn's dropdown_open is a live fact — an earlier turn's
    dropdown state may already have been resolved by a later action."""
    turns = [
        _combobox_turn(1, {"selected": "NCR", "dropdown_open": True}),
        _combobox_turn(2, {"selected": "Delhi", "dropdown_open": False}),
    ]

    text = _recent_actions_text(turns)

    assert "a dropdown is still open" not in text


def test_a_failed_select_combobox_does_not_get_the_success_annotation():
    turns = [EffectorTurnLog(
        turn=1, thought="selecting",
        action=Step(step=1, action="select_combobox", target="@e14", text="NCR"),
        result=StepResult(step=1, status="failed", error="no option matching \"NCR\""),
    )]

    text = _recent_actions_text(turns)

    assert "no option matching" in text
    assert "selected:" not in text
    assert "disappears from later element lists" not in text


def test_extract_and_select_combobox_annotations_do_not_interfere():
    """Regression guard: the new select_combobox branch and the existing
    extract branch are genuinely separate action types — mixing them in one
    history must annotate each correctly, not cross-contaminate."""
    turns = [
        _combobox_turn(1, {"selected": "NCR", "dropdown_open": False}),
        EffectorTurnLog(
            turn=2, thought="reading it back",
            action=Step(step=2, action="extract", target=None),
            result=StepResult(step=2, status="success", data={"state": "NCR"}),
        ),
    ]

    text = _recent_actions_text(turns)

    assert "disappears from later element lists" in text  # from turn 1
    assert "extracted:" in text  # from turn 2
