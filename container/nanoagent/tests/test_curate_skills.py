"""The agent tidies its own skill library — and cannot touch anyone else's.

Stage 42 item #4, the half that needs judgment. The deterministic sweep archives by
date; deciding that two skills say the same thing does not reduce to arithmetic.

Hermes runs that as a forked auxiliary agent with its own orchestration. We don't
need one, for the same reason /learn needed no distillation engine: the agent
already has the tools and the judgment. This tool just shows it what is eligible and
gives it a safe way to act.

The property under test throughout is provenance. A merge writes as the CURATOR, not
as the caller -- otherwise a consolidated skill becomes user-owned, permanently
off-limits, and the library ossifies into a pile nothing may ever touch again.
"""
import json
from pathlib import Path

import pytest

from nanoagent.agent import curator, skill_ledger, skill_origins
from nanoagent.agent.tool_origin import BACKGROUND_REVIEW, CURATOR, USER
from nanoagent.agent.tools.curate_skills import CurateSkillsTool


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


@pytest.fixture
def tool(workspace: Path) -> CurateSkillsTool:
    return CurateSkillsTool(workspace)


def make_skill(workspace: Path, name: str, *, origin: str, description: str = "d" * 30) -> None:
    d = workspace / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\nbody",
        encoding="utf-8",
    )
    skill_origins.record_write(workspace, name, origin)


def exists(workspace: Path, name: str) -> bool:
    return (workspace / "skills" / name / "SKILL.md").exists()


# ─── review shows only what is ours ─────────────────────────────────────────


async def test_review_lists_agent_written_skills(tool, workspace):
    make_skill(workspace, "yc-sweep", origin=BACKGROUND_REVIEW, description="sweeping YC boards")

    result = json.loads(await tool.execute(action="review"))

    assert [s["name"] for s in result["eligible"]] == ["yc-sweep"]
    assert "sweeping YC" in result["eligible"][0]["description"]


async def test_review_hides_the_managers_skills(tool, workspace):
    make_skill(workspace, "mine", origin=BACKGROUND_REVIEW)
    make_skill(workspace, "dictated", origin=USER)

    result = json.loads(await tool.execute(action="review"))

    assert [s["name"] for s in result["eligible"]] == ["mine"]


async def test_review_carries_the_usage_the_judgment_needs(tool, workspace):
    make_skill(workspace, "s", origin=BACKGROUND_REVIEW)
    skill_origins.record_use(workspace, "s")
    skill_origins.record_use(workspace, "s")

    result = json.loads(await tool.execute(action="review"))

    assert result["eligible"][0]["used"] == 2
    assert result["eligible"][0]["state"] == "active"


# ─── merging ────────────────────────────────────────────────────────────────


async def test_merging_combines_and_archives_the_sources(tool, workspace):
    make_skill(workspace, "yc-a", origin=BACKGROUND_REVIEW)
    make_skill(workspace, "yc-b", origin=BACKGROUND_REVIEW)

    result = json.loads(await tool.execute(
        action="merge", name="yc-sweep", content="# YC sweep\nboth halves",
        sources=["yc-a", "yc-b"],
    ))

    assert result["merged_into"] == "yc-sweep"
    assert sorted(result["archived"]) == ["yc-a", "yc-b"]
    assert not exists(workspace, "yc-a") and not exists(workspace, "yc-b")
    assert "both halves" in (workspace / "skills" / "yc-sweep" / "SKILL.md").read_text(encoding="utf-8")


async def test_a_merged_skill_stays_curatable(tool, workspace):
    """Written as the curator, so the library cannot ossify."""
    make_skill(workspace, "a", origin=BACKGROUND_REVIEW)
    make_skill(workspace, "b", origin=BACKGROUND_REVIEW)

    await tool.execute(action="merge", name="merged", content="# m", sources=["a", "b"])

    assert skill_origins.get_origin(workspace, "merged") == CURATOR


async def test_merging_the_managers_skill_is_refused(tool, workspace):
    """The invariant, checked BEFORE any write."""
    make_skill(workspace, "mine", origin=BACKGROUND_REVIEW)
    make_skill(workspace, "precious", origin=USER)

    result = json.loads(await tool.execute(
        action="merge", name="combined", content="# c", sources=["mine", "precious"],
    ))

    assert "not yours to merge" in result["error"]
    assert exists(workspace, "mine"), "nothing partially archived"
    assert exists(workspace, "precious")


async def test_a_merge_is_undoable(tool, workspace):
    make_skill(workspace, "a", origin=BACKGROUND_REVIEW)
    make_skill(workspace, "keeper", origin=BACKGROUND_REVIEW)
    original = (workspace / "skills" / "keeper" / "SKILL.md").read_text(encoding="utf-8")

    result = json.loads(await tool.execute(
        action="merge", name="keeper", content="# rewritten", sources=["a", "keeper"],
    ))
    ok, _msg = skill_ledger.rollback(workspace, result["ledger_entry"])

    assert ok
    assert (workspace / "skills" / "keeper" / "SKILL.md").read_text(encoding="utf-8") == original


async def test_merge_needs_both_a_name_and_content(tool, workspace):
    for kwargs in ({"name": "x"}, {"content": "y"}, {}):
        result = json.loads(await tool.execute(action="merge", **kwargs))
        assert "error" in result


# ─── archive and restore ────────────────────────────────────────────────────


async def test_archive_runs_the_deterministic_sweep(tool, workspace, monkeypatch):
    make_skill(workspace, "old", origin=BACKGROUND_REVIEW)
    skill_origins.record_use(workspace, "old", now="2020-01-01T00:00:00Z")

    result = json.loads(await tool.execute(action="archive"))

    assert result["archived"] == ["old"]
    assert not exists(workspace, "old")


async def test_an_archived_skill_can_be_restored(tool, workspace):
    make_skill(workspace, "oops", origin=BACKGROUND_REVIEW)
    curator.archive(workspace, "oops")

    result = json.loads(await tool.execute(action="restore", name="oops"))

    assert result["ok"], result["message"]
    assert exists(workspace, "oops")


async def test_an_unknown_action_is_reported_not_guessed(tool):
    assert "error" in json.loads(await tool.execute(action="delete_everything"))
