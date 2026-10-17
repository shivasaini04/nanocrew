"""Skill conventions are advice, not a gate — but a vague description is a real cost.

Stage 42 item #6. ``SkillsLoader.get_relevant_skills`` scores on the description, so
a missing or vague one directly degrades retrieval: the skill stops being found,
stops being used, and is eventually archived by the curator for an avoidable reason.

The linter must never refuse a write. The agent has just finished a piece of work and
is trying to record what it learned; losing that lesson over a house-style nit is far
worse than a scruffy skill. Every test here is either "it noticed" or "it stayed out
of the way".
"""
from pathlib import Path

from nanoagent.agent import skill_linter
from nanoagent.agent.skill_linter import lint, summarize
from nanoagent.agent.tools.save_skill import SaveSkillTool

GOOD = """---
name: yc-sweep
description: Sweeping YC's job board for companies hiring, and extracting named contacts. Use when refreshing the lead bank or when LinkedIn keywords are exhausted.
---

# YC sweep

## 1. Pick the role categories
YC exposes five fixed role categories and each sweep consumes all of them, so the
bank refills on a 12h cooldown rather than continuously.

## 2. Extract the contact
Prefer a named founder over a role address; role addresses bounce far more often.
"""


def codes(findings):
    return {f.code for f in findings}


# ─── what it notices ────────────────────────────────────────────────────────


def test_a_missing_description_is_flagged():
    findings = lint("---\nname: x\n---\n\n# body\n" + "text " * 40)

    assert "no-description" in codes(findings)


def test_a_name_that_disagrees_with_its_directory_is_flagged():
    findings = lint(GOOD, name="something-else")

    assert "name-mismatch" in codes(findings)


def test_marketing_language_is_flagged():
    content = GOOD.replace(
        "Sweeping YC's job board", "A powerful, comprehensive tool for sweeping YC"
    )

    assert "marketing-language" in codes(lint(content))


def test_an_empty_body_is_flagged():
    assert "empty-body" in codes(lint("---\nname: x\ndescription: " + "d" * 40 + "\n---\n"))


def test_a_dangling_reference_link_is_flagged(tmp_path: Path):
    content = GOOD + "\nSee [the details](references/detail.md).\n"

    assert "dangling-reference" in codes(lint(content, skill_dir=tmp_path))


def test_a_reference_that_exists_is_not_flagged(tmp_path: Path):
    (tmp_path / "references").mkdir()
    (tmp_path / "references" / "detail.md").write_text("x", encoding="utf-8")
    content = GOOD + "\nSee [the details](references/detail.md).\n"

    assert "dangling-reference" not in codes(lint(content, skill_dir=tmp_path))


# ─── when it stays quiet ────────────────────────────────────────────────────


def test_a_well_formed_skill_produces_nothing():
    assert lint(GOOD, name="yc-sweep") == []
    assert summarize(lint(GOOD, name="yc-sweep")) == ""


def test_it_never_raises_on_junk():
    for content in ("", "---", "---\nnot: [valid", "no frontmatter at all", "\x00\x01"):
        assert isinstance(lint(content, name="x"), list)


def test_warnings_sort_before_info():
    content = "---\nname: mismatch\ndescription: A powerful thing for doing things well here.\n---\n\n# b\n" + "x " * 60
    findings = lint(content, name="actual")

    assert findings[0].severity == "warn"


# ─── it advises, it never blocks ────────────────────────────────────────────


async def test_a_scruffy_skill_still_saves(tmp_path: Path):
    (tmp_path / "skills").mkdir()
    save = SaveSkillTool(tmp_path)

    out = await save.execute(name="rough", content="# rough\nno frontmatter, short.")

    assert out.startswith("Created skill")
    assert (tmp_path / "skills" / "rough" / "SKILL.md").exists(), "the lesson is kept"
    assert "Note:" in out, "but the agent is told what to improve"


async def test_a_clean_skill_gets_no_lecture(tmp_path: Path):
    (tmp_path / "skills").mkdir()

    out = await SaveSkillTool(tmp_path).execute(name="yc-sweep", content=GOOD)

    assert "Note:" not in out


def test_the_summary_caps_how_much_it_says():
    many = [skill_linter.LintFinding("warn", f"c{i}", f"issue {i}") for i in range(6)]

    assert "+3 more" in summarize(many, limit=3)
