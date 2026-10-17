"""Stage 63 — the decider is told to reach for a URL before the interface."""
from nanoagent.agent.effector.react_loop import _SYSTEM_PROMPT


def test_the_prompt_offers_navigate_as_an_action():
    assert '"navigate"' in _SYSTEM_PROMPT or "navigate" in _SYSTEM_PROMPT


def test_the_prompt_tells_it_to_prefer_a_url_over_the_interface():
    """Measured live: 'play a song on YouTube Music' took six turns because the loop
    used the search box. On the user's own computer every turn is a round trip to their
    machine, so three saved turns is seconds, not milliseconds."""
    assert "PREFER A URL OVER CLICKING THROUGH THE INTERFACE" in _SYSTEM_PROMPT
    assert "search?q=" in _SYSTEM_PROMPT


def test_it_is_told_not_to_invent_addresses():
    """A guessed path is a wasted navigation and possibly a wrong page. The rule is
    deliberately narrow: only a URL shape it already knows."""
    low = _SYSTEM_PROMPT.lower()
    assert "never a guessed path" in low
    assert "carry on with the interface" in low
