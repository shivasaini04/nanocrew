"""Stage 63 — Enter in a search box is a search, not a submission.

Found live 2026-09-21 in the founder's own browser. Effector typed a song name, pressed
Enter, and was blocked:

    "Effector got blocked this time — its Enter-keypress hit an operator escalation
     gate (turns 1-2 succeeded: search box clicked and query typed)."

The run failed and the agent fell back to driving the page one slow action at a time.
Gating every Enter made searching — the commonest thing anyone does on a page — require
an operator.

The rule it came from is good and stays: Enter can fire a form's submit handler whatever
has focus, so it is gated by default. What changes is the one case where we can SEE what
it is going into.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point, Step


def _element(ref, name, selector="input", value=""):
    return DOMElementNode(
        ref=ref, tag="input", role="searchbox" if "search" in selector else "textbox",
        name=name, value=value, placeholder=None, type=None, selector=selector,
        bounds=Bounds(x=0, y=0, width=10, height=10), center=Point(x=5, y=5),
        is_visible=True, is_enabled=True, frame_selector=None, frame_bounds=None,
    )


def _snapshot(*elements):
    return DOMSnapshot(url="https://music.youtube.com/", title="t",
                       elements=list(elements), content=None, summary="")


def enter(target=None):
    return Step(step=1, action="key", key="Enter", target=target)


# ───────────────────────────────────────────────── the case that was blocking

def test_enter_in_a_named_search_box_is_allowed():
    snap = _snapshot(_element("@e4", "Search", selector="input#search"))
    assert is_dangerous(enter("@e4"), snap) is False


@pytest.mark.parametrize("name,selector", [
    ("Search", "input"),
    ("Search YouTube Music", "input"),
    ("Find a song", "input"),
    ("", "input[type=search]"),
    ("", "#searchbox"),
    ("Query", "input"),
])
def test_the_shapes_a_search_field_comes_in(name, selector):
    snap = _snapshot(_element("@e4", name, selector=selector))
    assert is_dangerous(enter("@e4"), snap) is False


# ───────────────────────────────────────────── everything else stays gated

def test_enter_with_no_target_is_still_dangerous():
    """Nothing names what has focus, so a submit handler could be behind it."""
    assert is_dangerous(enter()) is True


def test_enter_into_an_ordinary_field_is_still_dangerous():
    snap = _snapshot(_element("@e4", "Card number", selector="input#cc"))
    assert is_dangerous(enter("@e4"), snap) is True


def test_enter_into_an_unknown_ref_is_still_dangerous():
    """The ref names nothing in this snapshot, so we cannot see what it is."""
    snap = _snapshot(_element("@e1", "Search", selector="input#search"))
    assert is_dangerous(enter("@e99"), snap) is True


def test_a_field_that_merely_mentions_research_is_not_a_search_box():
    """Word boundaries matter: 'research' contains 'search'."""
    snap = _snapshot(_element("@e4", "Research notes", selector="textarea"))
    assert is_dangerous(enter("@e4"), snap) is True


def test_a_dangerous_click_is_untouched():
    snap = _snapshot(_element("@e7", "Delete account", selector="button"))
    assert is_dangerous(Step(step=1, action="click", target="@e7"), snap) is True


def test_an_explicitly_flagged_step_is_still_dangerous():
    """A search box does not launder a step someone already marked."""
    step = Step(step=1, action="key", key="Enter", target="@e4", is_dangerous=True)
    snap = _snapshot(_element("@e4", "Search", selector="input#search"))
    assert is_dangerous(step, snap) is True
