"""Real bug found live, 2026-08-27, test 5.1 of the manual capability suite
: a click on
saucedemo.com's "Checkout" button was correctly denied by the escalation gate
(no operator present on an unattended agent — fails safe). The very next
"thinking" step logged for the run: "The escalation gate is blocking the
checkout button click. Let me try a different approach — navigate directly to
the checkout page." It called `effector` again with the goal rewritten to
`navigate` straight to https://www.saucedemo.com/checkout-step-one.html — the
same "checkout" substring that tripped the gate on the click, sitting
unchecked in a URL this time, because is_dangerous() never looked at
`navigate` at all. The run completed the entire purchase through to
checkout-complete.html with zero further approval prompts.

Same shape as test_effector_danger_gate_key_bypass.py's Enter-key bug: the
model didn't target this file's blind spot on purpose, it just kept finding
the one action verb is_dangerous() had never checked, because the thing it
was blocked on still needed doing.

Unlike the key fix (broad, unconditional — Enter's danger isn't visible in
any matchable text), navigate's danger IS visible in a matchable string: the
destination URL. Fixed the same way click/select_combobox already work —
danger_haystack now folds step.url in, and navigate gets a real keyword
check, not an unconditional gate (an unattended agent navigating to an
ordinary URL must not need approval for every page load)."""

from __future__ import annotations

from nanoagent.agent.effector.escalation import danger_haystack, is_dangerous
from nanoagent.agent.effector.types import Step


def test_navigate_to_a_dangerous_url_is_gated():
    """The exact bug: a click on '/checkout' got denied, then a navigate to
    the very same URL sailed through untouched."""
    step = Step(step=1, action="navigate", url="https://www.saucedemo.com/checkout-step-one.html")
    assert is_dangerous(step) is True


def test_navigate_url_match_is_case_insensitive():
    step = Step(step=1, action="navigate", url="https://example.com/ACCOUNT/DELETE")
    assert is_dangerous(step) is True


def test_navigate_to_an_ordinary_url_is_not_gated():
    """Must not turn every page load into an approval round trip — an
    unattended agent navigating around a site is the ordinary case."""
    step = Step(step=1, action="navigate", url="https://www.saucedemo.com/inventory.html")
    assert is_dangerous(step) is False


def test_navigate_with_no_url_is_not_dangerous():
    """Defensive: a malformed navigate step (executor.py's own handler already
    raises on a missing URL before this is ever reached) must not crash
    is_dangerous() either."""
    step = Step(step=1, action="navigate", url=None)
    assert is_dangerous(step) is False


def test_danger_haystack_includes_the_url():
    """Unit-level guard on the actual mechanism the fix relies on — a future
    change to danger_haystack that drops step.url would silently reopen this
    exact gap without touching is_dangerous() at all."""
    step = Step(step=1, action="navigate", url="https://example.com/cancel-subscription")
    assert "cancel-subscription" in danger_haystack(step)


def test_click_and_key_coverage_is_unaffected():
    """Regression guard: adding navigate coverage must not change the
    existing click/select_combobox/key behavior."""
    click_step = Step(step=1, action="click", target="@e1")
    combobox_step = Step(step=1, action="select_combobox", target="@e1", text="Reading")
    key_step = Step(step=1, action="key", key="Tab", target="@e1")
    assert is_dangerous(click_step) is False
    assert is_dangerous(combobox_step) is False
    assert is_dangerous(key_step) is False
