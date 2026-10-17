"""The curator retires what nobody uses — and nothing else, ever.

Stage 42 item #4, deterministic half. Skills accumulated monotonically before this:
nothing ever retired one, so a skill written once and never used again kept costing
retrieval and context forever.

Autonomy is only safe here because of what the curator *cannot* do, and that is what
these tests pin down: it may not touch a skill the user wrote, may not touch a pinned
one, and may not delete anything — archive is a move, and moves come back.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nanoagent.agent import curator, skill_ledger, skill_origins
from nanoagent.agent.skills import SkillsLoader
from nanoagent.agent.tool_origin import BACKGROUND_REVIEW, USER

NOW = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)


def ago(days: int) -> str:
    return (NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


def make_skill(workspace: Path, name: str, *, origin: str, used_days_ago: int) -> None:
    d = workspace / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"# {name}\nbody", encoding="utf-8")
    skill_origins.record_write(workspace, name, origin, now=ago(used_days_ago))
    skill_origins.record_use(workspace, name, now=ago(used_days_ago))


def exists(workspace: Path, name: str) -> bool:
    return (workspace / "skills" / name / "SKILL.md").exists()


# ─── what it retires ────────────────────────────────────────────────────────


def test_a_dead_agent_written_skill_is_archived(workspace):
    make_skill(workspace, "yc-sweep", origin=BACKGROUND_REVIEW, used_days_ago=200)

    result = curator.sweep(workspace, now=NOW)

    assert result.archived == ["yc-sweep"]
    assert not exists(workspace, "yc-sweep")
    assert curator.list_archived(workspace) == ["yc-sweep"]


def test_a_recently_used_skill_is_left_alone(workspace):
    make_skill(workspace, "busy", origin=BACKGROUND_REVIEW, used_days_ago=2)

    result = curator.sweep(workspace, now=NOW)

    assert result.archived == []
    assert exists(workspace, "busy")


def test_a_stale_skill_is_reported_but_not_touched(workspace):
    """Stale is a warning shelf, not an action."""
    make_skill(workspace, "drifting", origin=BACKGROUND_REVIEW, used_days_ago=40)

    result = curator.sweep(workspace, now=NOW)

    assert result.stale == ["drifting"]
    assert result.archived == []
    assert exists(workspace, "drifting")


# ─── what it must never touch ───────────────────────────────────────────────


def test_a_dead_user_skill_is_never_archived(workspace):
    """The invariant. Unused is not permission."""
    make_skill(workspace, "precious", origin=USER, used_days_ago=9999)

    result = curator.sweep(workspace, now=NOW)

    assert result.archived == []
    assert exists(workspace, "precious")


def test_an_unattributed_skill_is_never_archived(workspace):
    """Skills predating provenance belong to nobody, so they belong to the user."""
    d = workspace / "skills" / "legacy"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# legacy", encoding="utf-8")

    curator.sweep(workspace, now=NOW)

    assert exists(workspace, "legacy")


def test_a_pinned_skill_is_never_archived(workspace):
    make_skill(workspace, "keepme", origin=BACKGROUND_REVIEW, used_days_ago=9999)
    skill_origins.set_pinned(workspace, "keepme", True)

    result = curator.sweep(workspace, now=NOW)

    assert result.archived == []
    assert exists(workspace, "keepme")


# ─── archive is recoverable ─────────────────────────────────────────────────


def test_archiving_never_deletes(workspace):
    make_skill(workspace, "gone", origin=BACKGROUND_REVIEW, used_days_ago=200)
    original = (workspace / "skills" / "gone" / "SKILL.md").read_text(encoding="utf-8")

    curator.sweep(workspace, now=NOW)

    archived = curator.archive_dir(workspace) / "gone" / "SKILL.md"
    assert archived.read_text(encoding="utf-8") == original


def test_an_archived_skill_can_be_restored(workspace):
    make_skill(workspace, "oops", origin=BACKGROUND_REVIEW, used_days_ago=200)
    curator.sweep(workspace, now=NOW)

    ok, msg = curator.restore(workspace, "oops")

    assert ok, msg
    assert exists(workspace, "oops")
    assert curator.list_archived(workspace) == []


def test_restore_refuses_to_clobber_a_live_skill(workspace):
    make_skill(workspace, "dup", origin=BACKGROUND_REVIEW, used_days_ago=200)
    curator.sweep(workspace, now=NOW)
    make_skill(workspace, "dup", origin=USER, used_days_ago=0)

    ok, msg = curator.restore(workspace, "dup")

    assert not ok
    assert "already exists" in msg


def test_every_archive_is_ledgered_as_the_curator(workspace):
    make_skill(workspace, "tracked", origin=BACKGROUND_REVIEW, used_days_ago=200)

    curator.sweep(workspace, now=NOW)

    entry = skill_ledger.read_entries(workspace, name="tracked")[-1]
    assert entry["action"] == "delete"
    assert entry["actor"] == "curator"
    assert skill_ledger.read_blob(workspace, entry["before"]).startswith("# tracked")


# ─── effect on the agent ────────────────────────────────────────────────────


def test_an_archived_skill_stops_being_loadable(workspace):
    make_skill(workspace, "retired", origin=BACKGROUND_REVIEW, used_days_ago=200)
    make_skill(workspace, "current", origin=BACKGROUND_REVIEW, used_days_ago=1)
    curator.sweep(workspace, now=NOW)

    names = [s["name"] for s in SkillsLoader(workspace).list_skills(filter_unavailable=False)]

    assert "current" in names
    assert "retired" not in names
    assert curator.ARCHIVE_DIR_NAME not in names, "the archive dir is not a skill"


# ─── operability ────────────────────────────────────────────────────────────


def test_dry_run_changes_nothing(workspace):
    make_skill(workspace, "candidate", origin=BACKGROUND_REVIEW, used_days_ago=200)

    result = curator.sweep(workspace, now=NOW, dry_run=True)

    assert result.archived == ["candidate"]
    assert exists(workspace, "candidate"), "dry run must not move anything"


def test_a_sweep_is_idempotent(workspace):
    make_skill(workspace, "once", origin=BACKGROUND_REVIEW, used_days_ago=200)

    first = curator.sweep(workspace, now=NOW)
    second = curator.sweep(workspace, now=NOW)

    assert first.archived == ["once"]
    assert second.archived == [], "nothing left to do the second time"


def test_a_sweep_of_an_empty_workspace_is_harmless(workspace):
    result = curator.sweep(workspace, now=NOW)

    assert result.archived == [] and result.stale == []
    assert "Curator:" in result.summary()
