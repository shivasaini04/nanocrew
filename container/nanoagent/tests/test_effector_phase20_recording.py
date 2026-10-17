"""God-level pillar 03 tests, 2026-08-24.

Covers effector/recording.py's AST parser directly, then the `learn_from_recording`
tool end to end — including a real read-back through domain_memory.load_domain_notes
(pillar 07's real storage, not mocked), proving the notes are actually usable by a
future react_loop run, not just written and forgotten.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.agent.effector.domain_memory import load_domain_notes
from nanoagent.agent.effector.recording import parse_codegen_script, summarize_for_domain_memory
from nanoagent.agent.tools.learn_from_recording import LearnFromRecordingTool

_REALISTIC_CODEGEN_SCRIPT = '''
from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=False)
    context = browser.new_context()
    page = context.new_page()
    page.goto("https://demoqa.com/automation-practice-form")
    page.click("#firstName")
    page.fill("#firstName", "Ada")
    page.fill("#lastName", "Lovelace")
    page.locator("#state").click()
    page.get_by_text("NCR").click()
    page.select_option("#city-select", "Delhi")
    page.click("#submit")
    context.close()
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
'''


# ─── parse_codegen_script ────────────────────────────────────────────────────

def test_parse_codegen_script_extracts_flat_calls_in_order():
    steps = parse_codegen_script(_REALISTIC_CODEGEN_SCRIPT)

    assert "goto 'https://demoqa.com/automation-practice-form'" in steps
    assert "click '#firstName'" in steps
    assert "fill '#firstName' -> 'Ada'" in steps
    assert "fill '#lastName' -> 'Lovelace'" in steps
    assert "click '#submit'" in steps
    # order preserved
    assert steps.index("goto 'https://demoqa.com/automation-practice-form'") < steps.index("click '#firstName'")
    assert steps.index("fill '#lastName' -> 'Lovelace'") < steps.index("click '#submit'")


def test_parse_codegen_script_handles_the_chained_locator_form():
    steps = parse_codegen_script(_REALISTIC_CODEGEN_SCRIPT)

    assert "click '#state'" in steps


def test_parse_codegen_script_ignores_dynamic_non_literal_arguments():
    script = '''
selector = get_dynamic_selector()
page.click(selector)
page.goto(f"https://{host}/path")
page.click("#real-one")
'''
    steps = parse_codegen_script(script)

    assert steps == ["click '#real-one'"]


def test_parse_codegen_script_ignores_unrecognized_methods():
    script = '''
page.goto("https://example.test")
page.wait_for_selector("#x")
page.screenshot(path="out.png")
expect(page.locator("#x")).to_be_visible()
'''
    steps = parse_codegen_script(script)

    assert steps == ["goto 'https://example.test'"]


def test_parse_codegen_script_degrades_to_empty_list_on_syntax_error():
    assert parse_codegen_script("this is not ( python at all !!!") == []


def test_parse_codegen_script_handles_empty_input():
    assert parse_codegen_script("") == []


# ─── summarize_for_domain_memory ─────────────────────────────────────────────

def test_summarize_for_domain_memory_prefixes_and_caps():
    steps = [f"click '#e{i}'" for i in range(20)]
    notes = summarize_for_domain_memory(steps, max_notes=8)

    assert len(notes) == 8
    assert all(n.startswith("Human recording showed this working step: ") for n in notes)
    assert notes[0].endswith("click '#e0'")


# ─── LearnFromRecordingTool: end to end, real domain_memory read-back ──────────

@pytest.mark.asyncio
async def test_learn_from_recording_writes_notes_a_future_run_can_actually_read_back(tmp_path: Path):
    script_path = tmp_path / "recording.py"
    script_path.write_text(_REALISTIC_CODEGEN_SCRIPT, encoding="utf-8")

    tool = LearnFromRecordingTool(workspace=tmp_path)
    raw = await tool.execute(file_path="recording.py", domain="demoqa.com")
    result = json.loads(raw)

    assert result["success"] is True
    assert result["steps_parsed"] > 0
    assert result["notes_saved"] == result["steps_parsed"]

    # The real read path react_loop.py uses on its next run against this domain —
    # not re-parsing the JSON file, the actual pillar 07 function.
    notes = load_domain_notes(tmp_path, "demoqa.com")
    assert len(notes) == result["notes_saved"]
    assert any("firstName" in n for n in notes)
    assert all(n.startswith("Human recording showed this working step: ") for n in notes)


@pytest.mark.asyncio
async def test_learn_from_recording_accepts_an_absolute_path(tmp_path: Path):
    script_path = tmp_path / "elsewhere" / "recording.py"
    script_path.parent.mkdir()
    script_path.write_text('page.goto("https://example.test")\npage.click("#go")\n', encoding="utf-8")

    tool = LearnFromRecordingTool(workspace=tmp_path)
    raw = await tool.execute(file_path=str(script_path), domain="example.test")
    result = json.loads(raw)

    assert result["success"] is True
    assert result["steps_parsed"] == 2


@pytest.mark.asyncio
async def test_learn_from_recording_reports_a_missing_file_cleanly(tmp_path: Path):
    tool = LearnFromRecordingTool(workspace=tmp_path)
    raw = await tool.execute(file_path="nope.py", domain="example.test")
    result = json.loads(raw)

    assert result["success"] is False
    assert "error" in result


@pytest.mark.asyncio
async def test_learn_from_recording_reports_a_script_with_no_recognizable_actions(tmp_path: Path):
    script_path = tmp_path / "empty.py"
    script_path.write_text("x = 1 + 1\nprint(x)\n", encoding="utf-8")

    tool = LearnFromRecordingTool(workspace=tmp_path)
    raw = await tool.execute(file_path="empty.py", domain="example.test")
    result = json.loads(raw)

    assert result["success"] is False
    assert load_domain_notes(tmp_path, "example.test") == []


@pytest.mark.asyncio
async def test_learn_from_recording_dedups_against_existing_domain_notes(tmp_path: Path):
    """Running the SAME recording twice (e.g. re-uploaded, or two agents on the
    same workspace) must not duplicate notes — domain_memory.append_domain_note's
    own dedup, exercised through the real tool path."""
    script_path = tmp_path / "recording.py"
    script_path.write_text('page.goto("https://example.test")\npage.click("#go")\n', encoding="utf-8")

    tool = LearnFromRecordingTool(workspace=tmp_path)
    await tool.execute(file_path="recording.py", domain="example.test")
    await tool.execute(file_path="recording.py", domain="example.test")

    notes = load_domain_notes(tmp_path, "example.test")
    assert len(notes) == 2  # not 4
