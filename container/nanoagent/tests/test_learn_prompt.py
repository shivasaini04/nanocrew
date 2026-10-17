"""`/learn` is how a human says "that — remember that".

Stage 42 item #7, the user-facing half of the learning loop. The post-turn review
fork (#1) decides for itself what was worth keeping; this is the deliberate version.

The design point, taken from Hermes: there is no separate distillation engine. This
builds ONE prompt and the normal agent loop does the work with the tools it already
has, so it behaves identically in a chat turn and a background cycle, and there is
no second code path to keep in sync.
"""
from nanoagent.agent.learn_prompt import build_learn_prompt, parse_learn_command

# ─── parsing the command ────────────────────────────────────────────────────


def test_a_subject_is_extracted():
    assert parse_learn_command("/learn the YC scraping flow") == "the YC scraping flow"


def test_a_bare_learn_means_this_conversation():
    assert parse_learn_command("/learn") == ""
    assert parse_learn_command("  /learn  ") == ""


def test_an_ordinary_message_is_not_a_command():
    assert parse_learn_command("what did you learn today?") is None
    assert parse_learn_command("") is None


def test_a_word_starting_with_learn_is_not_the_command():
    """'/learned something' is a sentence, not an invocation."""
    assert parse_learn_command("/learned something new") is None


def test_the_command_is_case_insensitive():
    assert parse_learn_command("/LEARN the flow") == "the flow"


# ─── the prompt it builds ───────────────────────────────────────────────────


def test_the_subject_is_carried_through_verbatim():
    prompt = build_learn_prompt("https://docs.example.com/api")

    assert "https://docs.example.com/api" in prompt


def test_it_points_at_the_tools_the_agent_already_has():
    """No separate engine: the agent gathers sources itself."""
    prompt = build_learn_prompt("./scripts")

    assert "read_file" in prompt
    assert "save_skill" in prompt or "skill" in prompt


def test_a_bare_learn_looks_at_the_conversation():
    prompt = build_learn_prompt("")

    assert "THIS conversation" in prompt


def test_it_permits_writing_nothing():
    """A skill written to look productive costs context on every future turn."""
    prompt = build_learn_prompt("")

    assert "write nothing" in prompt


def test_it_asks_for_an_update_over_a_near_duplicate():
    prompt = build_learn_prompt("outbound tone")

    assert "skill_search" in prompt
    assert "UPDATE" in prompt


def test_it_warns_against_inventing_details():
    prompt = build_learn_prompt("the API")

    assert "Do not invent" in prompt


def test_it_asks_for_the_failures_too():
    """The part nobody writes down and everybody rediscovers."""
    assert "did NOT work" in build_learn_prompt("x")


def test_large_sources_get_an_index_not_one_huge_file():
    assert "references/" in build_learn_prompt("this book")


def test_the_description_rule_matches_what_the_linter_checks():
    """Standards live in one place so prompt and linter cannot drift apart."""
    prompt = build_learn_prompt("x")

    assert "WHEN to reach for this skill" in prompt
    assert "No marketing words" in prompt


def test_ambiguity_is_a_question_not_a_guess():
    assert "clarify" in build_learn_prompt("that thing we did")
