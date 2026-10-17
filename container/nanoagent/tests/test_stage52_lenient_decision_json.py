"""The decision parser must not lose a turn to a trailing sentence.

`json.loads` on the whole reply requires the model to emit JSON and NOTHING else — a
promise no model keeps reliably. A closing line of reasoning, the most natural thing in
the world to add, produced "Extra data: line 1 column 495" and cost the entire turn.

Observed live 2026-09-06: eight turns on a LinkedIn feed, several lost to exactly this,
after which the agent reported that the TOOL was broken. From inside the loop a parse
failure looks identical to a page failure, so the agent's wrong conclusion was a
reasonable one from what it could see — which is what makes being generous here worth it.
"""

from __future__ import annotations

import json

import pytest

from nanoagent.agent.effector.react_loop import _parse_action_json


def test_plain_json_still_works():
    """The common case, and it must stay the cheap path."""
    out = _parse_action_json('{"action": "click", "ref": "@e3"}')
    assert out == {"action": "click", "ref": "@e3"}


def test_fenced_json_still_works():
    out = _parse_action_json('```json\n{"action": "extract"}\n```')
    assert out["action"] == "extract"


def test_trailing_prose_no_longer_costs_the_turn():
    """The actual failure. The decision is there; something follows it."""
    reply = '{"action": "navigate", "url": "https://example.com"}\n\nI will then read the page.'
    out = _parse_action_json(reply)
    assert out["action"] == "navigate"
    assert out["url"] == "https://example.com"


def test_leading_prose_too():
    """Models narrate before the JSON as often as after it."""
    reply = 'Here is my decision:\n{"action": "scroll", "direction": "down"}'
    out = _parse_action_json(reply)
    assert out["action"] == "scroll"


def test_a_second_object_is_ignored_not_merged():
    """raw_decode stops at the end of the FIRST value. Merging two decisions would be
    worse than failing — the agent would act on something it never chose."""
    reply = '{"action": "click", "ref": "@e1"} {"action": "extract"}'
    out = _parse_action_json(reply)
    assert out == {"action": "click", "ref": "@e1"}


def test_genuinely_broken_json_still_raises():
    """Leniency must not become silence. A reply with no decision in it is a real
    failure, and the loop needs to hear about it."""
    with pytest.raises(json.JSONDecodeError):
        _parse_action_json("I could not decide what to do next.")


def test_the_original_error_is_what_surfaces():
    """When both attempts fail, the message should name the first problem rather than
    the more confusing second one."""
    with pytest.raises(json.JSONDecodeError) as e:
        _parse_action_json('{"action": "click"')     # truncated, never closed
    assert "Expecting" in str(e.value) or "delimiter" in str(e.value)
