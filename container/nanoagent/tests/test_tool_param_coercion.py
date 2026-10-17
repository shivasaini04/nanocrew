"""Numeric/boolean parameters arriving as JSON strings.

Found live 2026-08-29 running tier test 3.4 through Mechanic a live cycle: the model
called effector with `max_turns: "15"`. The registry rejected the whole call with
"max_turns should be integer", the model recovered by dropping the argument, and the run
continued on the default — a wasted turn and a silently different request, over two quote
characters.

Digits-as-strings is the single most common shape of malformed tool arguments from an LLM,
and the repair is unambiguous. What must NOT happen is the repair widening into guesswork,
so most of this file is about what stays rejected.
"""

from __future__ import annotations

import asyncio

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


class _Probe(Tool):
    """Records exactly what execute() was handed, after validation."""

    def __init__(self):
        self.seen: dict | None = None

    @property
    def name(self) -> str:
        return "probe"

    @property
    def description(self) -> str:
        return "test double"

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "max_turns": {"type": "integer", "minimum": 1, "maximum": 90},
                "ratio": {"type": "number"},
                "verify": {"type": "boolean"},
                "tags": {"type": "array", "items": {"type": "integer"}},
                "nested": {"type": "object", "properties": {"depth": {"type": "integer"}}},
            },
            "required": ["goal"],
        }

    async def execute(self, **kwargs):
        self.seen = kwargs
        return "ok"


def _run(params: dict) -> tuple[str, dict | None]:
    tool = _Probe()
    reg = ToolRegistry()
    reg.register(tool)
    out = asyncio.run(reg.execute("probe", params))
    return out, tool.seen


# ─── the repair ─────────────────────────────────────────────────────────────

def test_a_digits_string_is_accepted_for_an_integer_parameter():
    """The exact call that failed in a live cycle."""
    out, seen = _run({"goal": "g", "max_turns": "15"})
    assert not out.startswith("Error"), out
    assert seen["max_turns"] == 15
    assert isinstance(seen["max_turns"], int)


def test_the_coerced_value_reaches_execute_not_just_the_validator():
    """The half that would be easy to get wrong: validating a repaired copy and then
    passing the original string through to the tool would fix the error message and
    leave the bug."""
    _, seen = _run({"goal": "g", "ratio": "1.5", "verify": "true"})
    assert seen["ratio"] == 1.5 and isinstance(seen["ratio"], float)
    assert seen["verify"] is True


def test_boolean_strings_both_ways():
    _, seen = _run({"goal": "g", "verify": "false"})
    assert seen["verify"] is False


def test_coercion_reaches_inside_arrays_and_nested_objects():
    _, seen = _run({"goal": "g", "tags": ["1", "2"], "nested": {"depth": "3"}})
    assert seen["tags"] == [1, 2]
    assert seen["nested"]["depth"] == 3


def test_bounds_are_still_enforced_after_coercion():
    """A repaired value is a real value — it gets checked like any other, or the repair
    becomes a way to smuggle out-of-range arguments past the schema."""
    out, _ = _run({"goal": "g", "max_turns": "500"})
    assert out.startswith("Error") and "<= 90" in out


# ─── what must stay rejected ────────────────────────────────────────────────

def test_a_non_numeric_string_still_fails():
    out, _ = _run({"goal": "g", "max_turns": "fifteen"})
    assert out.startswith("Error") and "max_turns should be integer" in out


def test_a_string_with_trailing_text_still_fails():
    """"15 turns" is a guess about intent, not a formatting slip."""
    out, _ = _run({"goal": "g", "max_turns": "15 turns"})
    assert out.startswith("Error")


def test_a_float_string_is_not_silently_truncated_into_an_integer():
    """int("15.7") raises, and that is the behaviour we want — rounding here would
    change the request without telling anyone."""
    out, _ = _run({"goal": "g", "max_turns": "15.7"})
    assert out.startswith("Error")


def test_a_number_is_not_coerced_into_a_string_parameter():
    """Coercion runs toward the declared type only. Widening it to repair every
    mismatch is how a validator stops being one."""
    out, _ = _run({"goal": 42})
    assert out.startswith("Error") and "goal should be string" in out


def test_an_already_correct_value_is_untouched():
    _, seen = _run({"goal": "g", "max_turns": 15, "verify": False})
    assert seen["max_turns"] == 15 and seen["verify"] is False


def test_a_missing_required_parameter_is_still_missing():
    out, _ = _run({"max_turns": "15"})
    assert out.startswith("Error") and "missing required goal" in out
