"""Real bug found live, 2026-08-27, test 1.3 of the manual capability suite
: a click on demoqa.com's
Submit button correctly got denied by the escalation gate (no operator present
on an unattended agent — fails safe). The model adapted on its next attempt:
"press Enter on the Permanent Address field to submit" — same real-world
effect (the form submitted), zero gate coverage, because is_dangerous() only
ever checked click/double_click/select_combobox. Not a targeted exploit — the
model just found the one action verb this file never looked at, because the
click kept failing and it needed the task done.

The narrow fix (check a "key" step's target text the same way click's is
checked) was considered and rejected: the Enter in the live run was pressed on
the address FIELD, not the Submit button — the danger comes from the
surrounding <form>'s implicit submit-on-Enter behavior, not from anything in
the target's own accessible name. Fixed broadly instead: Enter/Return is
unconditionally gated, no haystack match required, since it can activate a
form's submit handler regardless of which field currently has focus. Accepted
tradeoff, deliberately: some benign Enter presses (confirming a search box)
now also need approval on an unattended agent — same as the Submit click
itself did here — traded against a missed true positive being exactly the
unreviewed irreversible action this gate exists to prevent.
"""

from __future__ import annotations

from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.effector.types import Step


def test_enter_key_is_dangerous_regardless_of_target():
    """The exact bug: Enter pressed on an innocuous field (not the dangerous
    element itself) must still be gated — this is why the fix can't be a
    haystack/text match like click's."""
    step = Step(step=1, action="key", key="Enter", target="@e13")  # an address field, not Submit
    assert is_dangerous(step) is True


def test_return_key_is_also_dangerous():
    """Playwright/browsers use "Enter" and "Return" somewhat interchangeably
    depending on platform/keyboard layout conventions — both must be caught."""
    step = Step(step=1, action="key", key="Return", target="@e1")
    assert is_dangerous(step) is True


def test_enter_key_match_is_case_insensitive():
    step = Step(step=1, action="key", key="ENTER", target="@e1")
    assert is_dangerous(step) is True


def test_other_keys_are_not_gated():
    """Must not turn every keypress into an approval round trip — Tab, Escape,
    arrow keys etc. don't activate a form's default submit behavior."""
    for key in ("Tab", "Escape", "ArrowDown", "Backspace", "a"):
        step = Step(step=1, action="key", key=key, target="@e1")
        assert is_dangerous(step) is False, f"key={key!r} should not be gated"


def test_a_key_action_with_no_key_set_is_not_dangerous():
    """Defensive: executor.py's own key handler already raises on a missing
    key before this is ever reached, but is_dangerous() must not crash on it
    either (e.g. a future caller checking is_dangerous before execute_step
    validates the step)."""
    step = Step(step=1, action="key", key=None, target="@e1")
    assert is_dangerous(step) is False


def test_click_and_select_combobox_coverage_is_unaffected():
    """Regression guard: adding key-action coverage must not change the
    existing click/select_combobox behavior — plain, undangerous actions on
    ordinary targets stay through-traffic."""
    click_step = Step(step=1, action="click", target="@e1")
    combobox_step = Step(step=1, action="select_combobox", target="@e1", text="Reading")
    assert is_dangerous(click_step) is False
    assert is_dangerous(combobox_step) is False
