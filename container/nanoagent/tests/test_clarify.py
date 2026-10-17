"""Asking a good question beats guessing — but only if it is cheap to answer.

Stage 42 item #12. request_approval gates an *action* ("here is a draft, may I
send it"). There was no way to ask a *question*, so an agent at a genuine fork had
two bad options: guess, or stop and report. Both waste the cycle.

The rendering is what makes it usable. A specific question with three concrete
choices gets answered in a moment; a paragraph asking for a decision tends to sit
unanswered. So these tests are mostly about the markdown a human actually sees.
"""
import json

from nanoagent.agent.tools.clarify import ClarifyTool, render

OPTIONS = [
    {"label": "Email the YC leads first", "detail": "9 named contacts, higher reply rate"},
    {"label": "Email the LinkedIn leads first", "detail": "34 leads but mostly role addresses"},
]


def test_the_question_leads():
    out = render("Which batch should I send first?", OPTIONS)

    assert out.startswith("## Question")
    assert "Which batch should I send first?" in out


def test_options_are_numbered_so_a_reply_can_be_one_character():
    out = render("Which first?", OPTIONS)

    assert "1. **Email the YC leads first**" in out
    assert "2. **Email the LinkedIn leads first**" in out
    assert "Reply with a number" in out


def test_details_explain_the_consequence_of_each_choice():
    out = render("Which first?", OPTIONS)

    assert "9 named contacts" in out


def test_multi_select_says_so():
    out = render("Which sources should I keep?", OPTIONS, multi_select=True)

    assert "1, 3" in out, "shows the reply format for several"


def test_an_open_question_needs_no_options():
    out = render("What tone should the follow-up take?", [])

    assert "Reply in your own words" in out
    assert "1." not in out


def test_context_is_included_so_the_answer_needs_no_archaeology():
    out = render("Which first?", OPTIONS, context="Found 43 leads, 9 with named contacts.")

    assert "Where I got to" in out
    assert "43 leads" in out


def test_the_human_can_always_answer_off_menu():
    """Options are a shortcut, never a cage."""
    assert "or just tell me what you'd rather do" in render("Which?", OPTIONS)


async def test_a_question_is_required():
    out = await ClarifyTool().execute(question="   ")

    assert json.loads(out)["error"] == "question is required"


async def test_it_reports_missing_configuration_rather_than_throwing(monkeypatch):
    monkeypatch.delenv("AGENT_ID", raising=False)

    out = await ClarifyTool().execute(question="Which first?", options=OPTIONS)

    assert json.loads(out)["queued"] is False


async def test_too_many_options_are_trimmed_not_refused(monkeypatch):
    """A refusal sends the agent back to guessing, which is the thing this prevents."""
    monkeypatch.delenv("AGENT_ID", raising=False)
    many = [{"label": f"option {i}"} for i in range(20)]

    out = await ClarifyTool().execute(question="Which?", options=many)

    assert json.loads(out)["queued"] is False  # no AGENT_ID, but it got that far


def test_malformed_options_are_dropped_not_rendered():
    out = render("Which?", [{"label": "real"}, {"detail": "no label"}])

    assert "1. **real**" in out
    assert "2." not in out
