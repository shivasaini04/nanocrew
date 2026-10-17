"""A skill nobody uses should be visible as such — and still not the curator's to take.

Stage 42 item #3. Before this, ``get_relevant_skills`` scored purely on text
similarity, so a skill that had never once produced a good outcome kept being loaded
into context at full token cost, forever, with nothing recording that it was dead
weight.

The states are derived from timestamps rather than stored, and the curator's
allowlist is the *intersection* of "unused" and "agent-created" — being unused is
never permission to touch something the user wrote.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nanoagent.agent import skill_origins
from nanoagent.agent.skill_origins import ACTIVE, ARCHIVED, STALE
from nanoagent.agent.skills import SkillsLoader
from nanoagent.agent.tool_origin import BACKGROUND_REVIEW, USER

NOW = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)


def ago(days: int) -> str:
    return (NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


def write_skill(workspace: Path, name: str, body: str = "# skill\nbody") -> None:
    d = workspace / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(body, encoding="utf-8")


# ─── counting real use ──────────────────────────────────────────────────────


def test_loading_a_skill_into_context_counts_as_use(workspace):
    write_skill(workspace, "outbound-tone")
    loader = SkillsLoader(workspace)

    loader.load_skills_for_context(["outbound-tone"])
    loader.load_skills_for_context(["outbound-tone"])

    entry = skill_origins.get_entry(workspace, "outbound-tone")
    assert entry["usage_count"] == 2
    assert entry["last_used_at"]


def test_a_skill_that_does_not_exist_is_not_counted(workspace):
    SkillsLoader(workspace).load_skills_for_context(["ghost"])

    assert skill_origins.get_entry(workspace, "ghost") is None


def test_a_batch_is_recorded_in_one_pass(workspace):
    for name in ("a", "b", "c"):
        write_skill(workspace, name)

    SkillsLoader(workspace).load_skills_for_context(["a", "b", "c"])

    assert [skill_origins.get_entry(workspace, n)["usage_count"] for n in "abc"] == [1, 1, 1]


def test_use_does_not_overwrite_provenance(workspace):
    """Counting a use must not launder who wrote the skill."""
    write_skill(workspace, "s")
    skill_origins.record_write(workspace, "s", USER)

    SkillsLoader(workspace).load_skills_for_context(["s"])

    assert skill_origins.get_origin(workspace, "s") == USER
    assert skill_origins.get_entry(workspace, "s")["usage_count"] == 1


def test_telemetry_failure_never_breaks_the_context_build(workspace):
    """A sidecar it cannot write must cost the turn nothing but the counter."""
    write_skill(workspace, "s", "# real content")
    # A directory where the file belongs: every write path fails, none may propagate.
    skill_origins.sidecar_path(workspace).mkdir()

    out = SkillsLoader(workspace).load_skills_for_context(["s"])

    assert "real content" in out
    assert skill_origins.read_all(workspace) == {}


# ─── derived lifecycle states ───────────────────────────────────────────────


def test_a_recently_used_skill_is_active():
    assert skill_origins.lifecycle_state({"last_used_at": ago(3)}, now=NOW) == ACTIVE


def test_a_skill_unused_for_a_month_goes_stale():
    assert skill_origins.lifecycle_state({"last_used_at": ago(31)}, now=NOW) == STALE


def test_a_skill_unused_for_a_quarter_is_archivable():
    assert skill_origins.lifecycle_state({"last_used_at": ago(91)}, now=NOW) == ARCHIVED


def test_a_pinned_skill_never_transitions():
    entry = {"last_used_at": ago(400), "pinned": True}

    assert skill_origins.lifecycle_state(entry, now=NOW) == ACTIVE


def test_a_never_used_skill_ages_from_when_it_was_written():
    assert skill_origins.lifecycle_state({"created_at": ago(45)}, now=NOW) == STALE


def test_unknown_or_unparsable_entries_read_as_active():
    """The state that causes no action is the safe default."""
    for entry in (None, {}, {"last_used_at": "yesterday"}, {"last_used_at": 12345}):
        assert skill_origins.lifecycle_state(entry, now=NOW) == ACTIVE


def test_pinning_survives_a_later_write(workspace):
    skill_origins.set_pinned(workspace, "s", True)
    skill_origins.record_write(workspace, "s", BACKGROUND_REVIEW)

    assert skill_origins.get_entry(workspace, "s")["pinned"] is True


# ─── the curator's allowlist ────────────────────────────────────────────────


def test_curatable_requires_both_unused_and_agent_created(workspace):
    skill_origins.record_write(workspace, "fork-made-and-dead", BACKGROUND_REVIEW, now=ago(200))
    skill_origins.record_write(workspace, "fork-made-but-live", BACKGROUND_REVIEW, now=ago(1))
    skill_origins.record_write(workspace, "user-made-and-dead", USER, now=ago(200))

    assert skill_origins.curatable(workspace, now=NOW) == ["fork-made-and-dead"]


def test_a_dead_user_skill_is_never_curatable(workspace):
    """The invariant. Unused is not permission."""
    skill_origins.record_write(workspace, "precious", USER, now=ago(9999))

    assert "precious" not in skill_origins.curatable(workspace, now=NOW)
    assert skill_origins.states(workspace, now=NOW)["precious"] == ARCHIVED


def test_states_reports_every_recorded_skill(workspace):
    skill_origins.record_write(workspace, "fresh", USER, now=ago(0))
    skill_origins.record_write(workspace, "old", USER, now=ago(200))

    assert skill_origins.states(workspace, now=NOW) == {"fresh": ACTIVE, "old": ARCHIVED}
