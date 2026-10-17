"""Tests for God-Level Pillar 07, 2026-08-23.

Lessons from past runs against the same session_domain persist to
workspace/.effector/domain-memory/<domain>.json and get folded into the FIRST
turn of a later run — so a lesson learned once (e.g. "City is a combobox, not
a plain field") doesn't need rediscovering on every future visit to the same
site. Every note is derived directly from a signal react_loop already computes
for pillars 05/06 — no extra LLM call to "summarize" a lesson.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.domain_memory import append_domain_note, load_domain_notes
from nanoagent.agent.effector.react_loop import _build_turn_prompt
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeSession, ScriptedProvider


# ─── domain_memory.py: the storage primitives ───────────────────────────────

def test_load_domain_notes_on_a_domain_never_seen_is_empty(tmp_path: Path):
    assert load_domain_notes(tmp_path, "example.test") == []


def test_append_then_load_round_trips(tmp_path: Path):
    append_domain_note(tmp_path, "example.test", "City is a combobox.")
    assert load_domain_notes(tmp_path, "example.test") == ["City is a combobox."]


def test_append_deduplicates_the_exact_same_note(tmp_path: Path):
    append_domain_note(tmp_path, "example.test", "City is a combobox.")
    append_domain_note(tmp_path, "example.test", "City is a combobox.")
    assert load_domain_notes(tmp_path, "example.test") == ["City is a combobox."]


def test_append_caps_at_the_most_recent_notes(tmp_path: Path):
    for i in range(12):
        append_domain_note(tmp_path, "example.test", f"note {i}")
    notes = load_domain_notes(tmp_path, "example.test")
    assert len(notes) == 8  # _MAX_NOTES_PER_DOMAIN
    assert notes[-1] == "note 11"  # most recent kept
    assert "note 0" not in notes  # oldest dropped


def test_notes_are_isolated_per_domain(tmp_path: Path):
    append_domain_note(tmp_path, "a.test", "note for a")
    append_domain_note(tmp_path, "b.test", "note for b")
    assert load_domain_notes(tmp_path, "a.test") == ["note for a"]
    assert load_domain_notes(tmp_path, "b.test") == ["note for b"]


def test_load_domain_notes_survives_a_corrupt_file(tmp_path: Path):
    memory_dir = tmp_path / ".effector" / "domain-memory"
    memory_dir.mkdir(parents=True)
    (memory_dir / "example.test.json").write_text("not valid json", encoding="utf-8")
    assert load_domain_notes(tmp_path, "example.test") == []


# ─── _build_turn_prompt: the domain-notes block ─────────────────────────────

def test_build_turn_prompt_surfaces_domain_notes():
    prompt = _build_turn_prompt("goal", "summary", [], domain_notes=["City is a combobox."])
    assert "previous runs on this site" in prompt
    assert "City is a combobox." in prompt


def test_build_turn_prompt_says_nothing_extra_without_domain_notes():
    prompt = _build_turn_prompt("goal", "summary", [], domain_notes=None)
    assert "previous runs on this site" not in prompt
    prompt2 = _build_turn_prompt("goal", "summary", [], domain_notes=[])
    assert "previous runs on this site" not in prompt2


# ─── End-to-end through EffectorTool ────────────────────────────────────────

class RecordingScriptedProvider(ScriptedProvider):
    def __init__(self, script):
        super().__init__(script)
        self.all_messages: list = []

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.all_messages.append(messages)
        return await super().chat(messages, model=model, max_tokens=max_tokens, temperature=temperature)


@pytest.mark.asyncio
async def test_a_dropdown_confirmation_lesson_is_written_and_read_back_next_run(tmp_path: Path):
    """The core promise: run 1 hits the dropdown_open signal on plain "type",
    which writes a lesson. Run 2, same domain, sees that lesson on its very
    first turn — without needing to rediscover it."""

    # Run 1: type into a combobox, leaving it unconfirmed (dropdown_open=True).
    from test_effector_phase0 import FakeContext, _FAKE_ELEMENTS
    from test_effector_phase0 import FakePage as BaseFakePage

    class DropdownOpensAfterTypePage(BaseFakePage):
        async def evaluate(self, script, arg=None):
            if "MutationObserver" in script:
                return True
            if 'role="listbox"' in script:
                return True
            if "querySelectorAll" in script:
                return _FAKE_ELEMENTS
            return None

    page1 = DropdownOpensAfterTypePage()

    class Session1:
        def __init__(self, *a, **kw):
            self.page = page1
            self.context = FakeContext(pages=[page1])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    provider1 = ScriptedProvider([
        {"thought": "type into the field", "action": "type", "target": "@e1", "text": "Delhi"},
        {"thought": "done", "action": "done"},
    ])
    tool1 = EffectorTool(
        workspace=tmp_path, provider=provider1, model="fake/primary",
        decision_provider=provider1, decision_model="fake/decision",
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", Session1):
        await tool1.execute(goal="fill the city field", session_domain="example.test")

    notes = load_domain_notes(tmp_path, "example.test")
    assert len(notes) == 1
    assert "select_combobox" in notes[0]
    assert "@e1" in notes[0]

    # Run 2, same domain: the lesson must appear in the very first prompt.
    provider2 = RecordingScriptedProvider([{"thought": "done", "action": "done"}])
    tool2 = EffectorTool(
        workspace=tmp_path, provider=provider2, model="fake/primary",
        decision_provider=provider2, decision_model="fake/decision",
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw2 = await tool2.execute(goal="fill the city field again", session_domain="example.test")

    result2 = json.loads(raw2)
    assert result2["success"] is True, result2
    first_turn_content = provider2.all_messages[0][1]["content"]
    assert "select_combobox" in first_turn_content
    assert "@e1" in first_turn_content


@pytest.mark.asyncio
async def test_a_successful_select_combobox_also_gets_remembered(tmp_path: Path):
    from test_effector_phase0 import FakeContext, FakeLocator, FakeMouse, FakeKeyboard

    class ComboboxPage:
        def __init__(self):
            self.url = "https://example.test/form"
            self.viewport_size = {"width": 1280, "height": 720}
            self.actions: list = []
            self.mouse = FakeMouse(self)
            self.keyboard = FakeKeyboard(self)
            self.option_clicked = False

        async def title(self):
            return "Form"

        async def evaluate(self, script, arg=None):
            if "MutationObserver" in script:
                return True
            if 'role="listbox"' in script:
                return not self.option_clicked
            if "querySelectorAll" in script:
                return [{
                    "tag": "input", "role": "combobox", "name": "", "type": "text",
                    "selector": "#city", "bounds": {"x": 0, "y": 0, "width": 200, "height": 30},
                    "center": {"x": 100, "y": 15}, "isEnabled": True,
                }]
            return None

        async def wait_for_timeout(self, ms):
            pass

        def locator(self, selector):
            if selector == '[role="listbox"] [role="option"]':
                class Opt:
                    def __init__(self, page):
                        self._page = page

                    async def count(self):
                        return 1

                    def nth(self, i):
                        return self

                    async def inner_text(self):
                        return "Delhi"

                    async def click(self, **kw):
                        self._page.option_clicked = True

                return Opt(self)
            return FakeLocator(self, selector, matched=(selector == "#city"))

    page = ComboboxPage()

    class Session:
        def __init__(self, *a, **kw):
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    provider = ScriptedProvider([
        {"thought": "select Delhi", "action": "select_combobox", "target": "#city", "text": "Delhi"},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision", use_human_cadence=False,
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", Session):
        await tool.execute(goal="select Delhi", session_domain="example.test")

    notes = load_domain_notes(tmp_path, "example.test")
    assert len(notes) == 1
    assert "select_combobox" in notes[0]
    assert "works well" in notes[0]


@pytest.mark.asyncio
async def test_no_domain_memory_without_session_domain(tmp_path: Path):
    """The common case: no session_domain at all — must not write or read
    anything, and must not crash trying."""
    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
    )
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="report done")  # no session_domain

    result = json.loads(raw)
    assert result["success"] is True, result
    assert not (tmp_path / ".effector" / "domain-memory").exists()
