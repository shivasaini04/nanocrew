"""A response that ran its output budget out repeating itself is not an answer.

Stage 42 item #9. The guard exists because ``AgentLoop`` never read
``LLMResponse.finish_reason`` — every provider sets it, nothing consumed it — so a
response truncated at ``max_tokens`` was returned as though the model had finished.
When the truncation is a repetition loop, that garbage also entered ``turn_record``
and the session, to be resent on every later iteration of a turn that already
resends the whole history each time.

These cover the detector itself. The bar it has to clear is asymmetric: missing a
degenerate response costs tokens, but flagging a legitimate one destroys an answer
the user needed — so every "ordinary text" case here matters more than the
degenerate ones.
"""
from nanoagent.agent.repetition_guard import MIN_FRAGMENT_LENGTH, is_repetition_dominated


def test_a_repeated_line_is_caught():
    text = "Checking the database connection now.\n" * 40

    assert is_repetition_dominated(text)


def test_a_repeated_fragment_off_line_boundaries_is_caught():
    """The general path — repetition that does not align to newlines."""
    text = "I will now proceed to check the configuration file for you. " * 30

    assert is_repetition_dominated(text)


def test_ordinary_prose_is_not_flagged():
    text = (
        "The scheduler reads the cron entry, resolves it against the agent's timezone, "
        "and enqueues a cycle when the slot is due. Budget is checked before the "
        "container is spawned, not after, so an exhausted agent never starts work it "
        "cannot finish. The reply poller runs on its own interval and is unaffected by "
        "any of this. If the daily cap is hit mid-cycle the run completes; only the "
        "next one is refused, which keeps a half-written tracker from being left behind. "
        "None of these paths share state beyond the database row they update."
    )
    assert len(text) > MIN_FRAGMENT_LENGTH
    assert not is_repetition_dominated(text)


def test_code_with_similar_looking_lines_is_not_flagged():
    """Structurally repetitive but legitimate — the classic false positive."""
    text = "\n".join(
        f'    parser.add_argument("--flag-{i}", type=str, default=None, help="sets flag {i}")'
        for i in range(40)
    )
    assert len(text) > MIN_FRAGMENT_LENGTH
    assert not is_repetition_dominated(text)


def test_a_repeated_markdown_heading_is_not_enough():
    """A heading recurring through a report is structure, not a repetition loop.

    Only the heading repeats — the section under each one differs, which is what
    separates a normal document from a model echoing itself.
    """
    sections = [
        "the source returned 43 rows and 9 carried a named contact",
        "two of the LinkedIn keywords are now exhausted and need rotating",
        "the YC bank is on cooldown until tomorrow morning",
        "one tracker row failed to sync because its first field was renamed",
        "the reply poller saw a bounce from a guessed role address",
        "budget is at roughly a third of the daily cap for this agent",
    ]
    text = "\n\n".join(f"### Findings\nThis week {s}, which is worth noting." for s in sections)

    assert len(text) > MIN_FRAGMENT_LENGTH
    assert not is_repetition_dominated(text)


def test_a_short_truncation_is_left_alone():
    """A sentence cut mid-word is legitimately incomplete, not degenerate."""
    text = "I checked the tracker and found that the last three rows were nev"

    assert not is_repetition_dominated(text)


def test_a_short_but_repetitive_fragment_is_left_alone():
    """Below the length floor the guard stays out of the way entirely."""
    text = "wait. " * 20
    assert len(text) < MIN_FRAGMENT_LENGTH

    assert not is_repetition_dominated(text)


def test_it_fails_open_on_junk_input():
    for value in (None, 42, b"bytes", [], {}):
        assert not is_repetition_dominated(value)


def test_empty_string_is_not_flagged():
    assert not is_repetition_dominated("")


def test_a_long_answer_ending_in_a_repetition_loop_is_caught():
    """The real incident shape: useful content, then the model gets stuck."""
    preamble = (
        "Here is what I found in the outbound tracker. Nine of the forty-three rows "
        "carry a named contact, and the rest fall back to a role address.\n\n"
    )
    text = preamble + "Let me verify that once more to be sure.\n" * 60

    assert is_repetition_dominated(text)
