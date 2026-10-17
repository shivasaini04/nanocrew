"""Every skill mutation is recoverable, and a rollback that can't be undone doesn't run.

Stage 42 item #5. ``save_skill`` advertises that it overwrites any skill with the
same name, and until stage 42 it did so with nothing kept — an agent could silently
destroy a skill the founder dictated.

The two properties worth defending here:

  * the ledger is **telemetry, not a gate** — a broken ledger must never stop the
    mutation it describes, or the audit trail becomes an outage;
  * :func:`rollback` **fails closed** — it captures what it is about to overwrite
    first, and refuses to proceed if it cannot. A rollback you cannot yourself undo
    is not a safety feature.
"""
import json
from pathlib import Path

import pytest

from nanoagent.agent import skill_ledger
from nanoagent.agent.tool_origin import BACKGROUND_REVIEW, USER, write_origin
from nanoagent.agent.tools.save_skill import SaveSkillTool


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


@pytest.fixture
def save(workspace: Path) -> SaveSkillTool:
    return SaveSkillTool(workspace)


def skill_file(workspace: Path, name: str) -> Path:
    return workspace / "skills" / name / "SKILL.md"


# ─── recording ──────────────────────────────────────────────────────────────


async def test_every_write_is_ledgered_with_its_actor(save, workspace):
    with write_origin(USER):
        await save.execute(name="s", content="v1")
    with write_origin(BACKGROUND_REVIEW):
        await save.execute(name="s", content="v2")

    entries = skill_ledger.read_entries(workspace, name="s")
    assert [e["actor"] for e in entries] == [USER, BACKGROUND_REVIEW]
    assert [e["action"] for e in entries] == ["create", "update"]


async def test_content_is_deduplicated_by_hash(save, workspace):
    await save.execute(name="a", content="identical body")
    await save.execute(name="b", content="identical body")
    await save.execute(name="a", content="identical body")

    blobs = list(skill_ledger.blob_dir(workspace).glob("*"))
    assert len(blobs) == 1, "one distinct content, one blob"


async def test_the_ledger_is_greppable_jsonl(save, workspace):
    await save.execute(name="outbound-tone", content="body")

    lines = skill_ledger.ledger_path(workspace).read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["skill"] == "outbound-tone"


def test_a_corrupt_line_is_skipped_not_fatal(workspace):
    path = skill_ledger.ledger_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"id": "good", "skill": "s"}\nnot json at all\n', encoding="utf-8")

    assert [e["id"] for e in skill_ledger.read_entries(workspace)] == ["good"]


async def test_a_broken_ledger_never_blocks_the_write(save, workspace):
    """Telemetry, not a gate."""
    skill_ledger.ledger_path(workspace).mkdir(parents=True)  # a dir where the file goes

    out = await save.execute(name="s", content="body")

    assert "Created skill" in out
    assert skill_file(workspace, "s").read_text(encoding="utf-8") == "body"


# ─── rollback ───────────────────────────────────────────────────────────────


async def test_rollback_restores_the_replaced_version(save, workspace):
    await save.execute(name="precious", content="the version the user dictated")
    await save.execute(name="precious", content="what the fork replaced it with")
    update = skill_ledger.read_entries(workspace, name="precious")[-1]

    ok, msg = skill_ledger.rollback(workspace, update["id"])

    assert ok, msg
    assert skill_file(workspace, "precious").read_text(encoding="utf-8") == (
        "the version the user dictated"
    )


async def test_rolling_back_a_create_removes_the_skill(save, workspace):
    await save.execute(name="invented", content="body")
    create = skill_ledger.read_entries(workspace, name="invented")[-1]

    ok, msg = skill_ledger.rollback(workspace, create["id"])

    assert ok, msg
    assert not skill_file(workspace, "invented").exists()


async def test_a_rollback_is_itself_ledgered_and_undoable(save, workspace):
    await save.execute(name="s", content="v1")
    await save.execute(name="s", content="v2")
    update = skill_ledger.read_entries(workspace, name="s")[-1]

    skill_ledger.rollback(workspace, update["id"])
    undo = skill_ledger.read_entries(workspace, name="s")[-1]
    assert undo["action"] == "rollback"

    ok, _msg = skill_ledger.rollback(workspace, undo["id"])

    assert ok
    assert skill_file(workspace, "s").read_text(encoding="utf-8") == "v2", "back to v2"


def test_rollback_of_an_unknown_entry_is_refused(workspace):
    ok, msg = skill_ledger.rollback(workspace, "nosuchentry")

    assert not ok
    assert "No ledger entry" in msg


async def test_rollback_fails_closed_when_it_cannot_record(save, workspace, monkeypatch):
    """If the safety capture fails, nothing is touched."""
    await save.execute(name="s", content="v1")
    await save.execute(name="s", content="v2")
    update = skill_ledger.read_entries(workspace, name="s")[-1]

    monkeypatch.setattr(skill_ledger, "record", lambda *a, **k: None)

    ok, msg = skill_ledger.rollback(workspace, update["id"])

    assert not ok
    assert "Refusing to roll back" in msg
    assert skill_file(workspace, "s").read_text(encoding="utf-8") == "v2", "left untouched"
