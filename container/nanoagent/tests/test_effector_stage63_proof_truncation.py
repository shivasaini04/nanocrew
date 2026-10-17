"""Stage 63 — proof could not see a cut-short answer.

Found live 2026-09-21 in a control run: the agent reported

    Grim Fandango Puzzle Document (1996)

and the page said

    Grim Fandango Puzzle Document (1996) [pdf]

Proof returned VERIFIED and the independent check failed. Containment is structurally
blind to this — a truncated answer is ALWAYS a substring of the full text — so no amount
of care in the model would have been caught by that test.

These tests pin the narrow fix and, just as importantly, the cases that must keep
passing: a value in the middle or at the end of a line is an ordinary extraction, not a
truncation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.agent.effector.proof import UNKNOWN, VERIFIED, build_proof

PAGE = "\n".join([
    "Hacker News",
    "Grim Fandango Puzzle Document (1996) [pdf]",
    "Price: £51.77",
    "A Light in the Attic",
    "1. comments",
])


def proof_for(value: str, page: str = PAGE, **kw):
    return build_proof(
        success=True, extracted={"answer": value}, page_text=page, downloads=[],
        workspace=Path("/tmp"), final_url="https://example.test/", **kw,
    )


def test_a_cut_short_answer_is_no_longer_verified():
    out = proof_for("Grim Fandango Puzzle Document (1996)")
    assert out["status"] == UNKNOWN, "a truncated answer was called verified"
    detail = " ".join(c["detail"] for c in out["checks"])
    assert "cut short" in detail


def test_the_complete_answer_is_verified():
    out = proof_for("Grim Fandango Puzzle Document (1996) [pdf]")
    assert out["status"] == VERIFIED


def test_a_value_at_the_end_of_a_line_is_an_ordinary_extraction():
    # "£51.77" out of "Price: £51.77" is exactly what extraction looks like.
    assert proof_for("£51.77")["status"] == VERIFIED


def test_a_value_in_the_middle_of_a_line_is_not_flagged():
    assert proof_for("Fandango Puzzle")["status"] == VERIFIED


def test_a_whole_line_that_also_starts_a_longer_one_is_still_verified():
    """"A Light in the Attic" is a complete line here AND the start of another. A real,
    complete reading must not be punished for what else the page contains."""
    page = PAGE + "\nA Light in the Attic — £51.77"
    assert proof_for("A Light in the Attic", page=page)["status"] == VERIFIED


def test_a_value_absent_from_the_page_is_still_unknown():
    assert proof_for("Something Else Entirely")["status"] == UNKNOWN


@pytest.mark.parametrize("value", ["", "   "])
def test_an_empty_value_proves_nothing(value):
    """No checks ran, so there is nothing to call verified. Unknown is the honest
    answer, and is what proof already did before this change."""
    assert proof_for(value)["status"] == UNKNOWN


def test_a_short_value_at_the_start_of_a_line_is_an_ordinary_reading():
    """"11" out of "11 results" is a count, not a truncation — and it is a prefix with
    a trailing remainder exactly like the cut-short title is. Length is what separates
    them: a truncation loses a small tail, this leaves more behind than it took."""
    assert proof_for("11", page="11 results")["status"] == VERIFIED
