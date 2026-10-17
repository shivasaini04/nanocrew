"""Stage 61 phase 4 — three macro defects the phase 0 baseline found live (2026-09-19):
an ambiguous stored selector, a slow failed replay, and a password frozen as a literal."""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions
from nanoagent.agent.effector.synthesis.macro_distiller import (
    MacroAction,
    _looks_like_secret_field,
    distill_macro_from_action_log,
)
from nanoagent.agent.effector.synthesis.macro_runner import _find_live_target


class _Loc:
    def __init__(self, n: int):
        self.n = n

    async def count(self) -> int:
        return self.n


class _Page:
    """Answers every lookup with a fixed number of matches per selector/name."""

    def __init__(self, counts: dict[str, int]):
        self.counts = counts

    def locator(self, sel):
        return _Loc(self.counts.get(sel, 0))

    def get_by_role(self, role, name=None):
        return _Loc(self.counts.get(f"role:{role}:{name}", 0))

    def get_by_label(self, name, exact=False):
        return _Loc(self.counts.get(f"label:{name}", 0))

    def get_by_placeholder(self, name, exact=False):
        return _Loc(0)

    def get_by_text(self, name, exact=False):
        return _Loc(self.counts.get(f"text:{name}", 0))


@pytest.mark.asyncio
async def test_a_selector_matching_two_elements_is_not_a_target():
    # The live checkboxes macro: both steps stored as this selector, two matches.
    action = MacroAction(step_index=1, action="click", target='input:has-text("on")',
                         target_name="on", target_role="input")
    page = _Page({'input:has-text("on")': 2, "text:on": 2})
    assert await _find_live_target(page, action) is None


@pytest.mark.asyncio
async def test_a_unique_selector_still_resolves():
    action = MacroAction(step_index=1, action="click", target="#login", target_name="Login", target_role="button")
    assert await _find_live_target(_Page({"#login": 1}), action) == "#login"


@pytest.mark.asyncio
async def test_an_ambiguous_selector_falls_back_to_a_unique_accessible_name():
    action = MacroAction(step_index=1, action="click", target="button.radius", target_name="Login", target_role="button")
    page = _Page({"button.radius": 3, "role:button:Login": 1})
    assert await _find_live_target(page, action) == "button: Login"


def test_replays_click_with_a_short_timeout_and_normal_runs_do_not():
    from nanoagent.agent.effector.react_loop import _MACRO_CLICK_TIMEOUT_MS
    assert ExecutorOptions().click_timeout_ms == 10000
    assert _MACRO_CLICK_TIMEOUT_MS <= 3000


@pytest.mark.parametrize("target,name,secret", [
    ("#password", "Password", True),
    ("input[name=pwd]", None, True),
    ("#otp-code", "One-time code", True),
    ("#username", "Username", False),
    ("#search", "Search books", False),
])
def test_secret_fields_are_recognised(target, name, secret):
    assert _looks_like_secret_field(target, name) is secret


def test_a_password_named_in_the_goal_is_never_frozen():
    goal = "Log in with username 'tomsmith' and password 'SuperSecretPassword!'"
    entries = [
        {"action": {"type": "type", "target": "@e1", "text": "tomsmith"},
         "result": {"status": "success", "resolved_target": {"selector": "#username", "name": "Username"}}},
        {"action": {"type": "type", "target": "@e2", "text": "SuperSecretPassword!"},
         "result": {"status": "success", "resolved_target": {"selector": "#password", "name": "Password"}}},
    ]
    macro = distill_macro_from_action_log(goal=goal, domain="example.test", action_entries=entries)
    user, pw = macro.actions
    assert user.literal_value == "tomsmith"  # a goal-supplied non-secret stays frozen
    assert pw.literal_value is None
    assert pw.param_key and pw.param_key in macro.parameters
    assert "SuperSecretPassword!" not in str(macro.to_dict()["actions"])
