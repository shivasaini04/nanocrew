"""A skill must record who wrote it, and an overwrite must be recoverable.

Stage 42 item #2 — the gate on autonomous skill curation. Two failure modes this
locks down, both of which were live before it:

  1. ``save_skill`` recorded nothing about origin, so nothing downstream could tell
     a skill the agent invented from one the founder dictated. A curator built on
     top of that would eventually archive user content.
  2. ``save_skill`` overwrote blind — its own parameter description advertises
     "overwrites any existing skill with the same name" — with no copy kept.

Plus the reporting bug they were found next to: ``action`` was computed from
``skill_file.exists()`` *after* the write, so every brand-new skill was announced
as "Updated".
"""
from pathlib import Path

import pytest

from nanoagent.agent import skill_ledger, skill_origins
from nanoagent.agent.tool_origin import (
    BACKGROUND_REVIEW,
    DEFAULT_ORIGIN,
    USER,
    get_current_write_origin,
    is_agent_created,
    write_origin,
)
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry
from nanoagent.agent.tools.save_skill import SaveSkillTool


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "skills").mkdir()
    return tmp_path


@pytest.fixture
def save(workspace: Path) -> SaveSkillTool:
    return SaveSkillTool(workspace)


class OriginProbe(Tool):
    """Records the origin visible to a tool at the moment it executes."""

    def __init__(self):
        self.seen: list[str] = []

    @property
    def name(self) -> str:
        return "origin_probe"

    @property
    def description(self) -> str:
        return "test probe"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, **kwargs) -> str:
        self.seen.append(get_current_write_origin())
        return "ok"

    async def execute_streaming(self, on_chunk=None, **kwargs) -> str:
        self.seen.append(get_current_write_origin())
        return "ok"


# ─── the live signal ────────────────────────────────────────────────────────


async def test_registry_stamps_its_origin_for_the_duration_of_the_call():
    probe = OriginProbe()
    registry = ToolRegistry(write_origin=BACKGROUND_REVIEW)
    registry.register(probe)

    await registry.execute("origin_probe", {})

    assert probe.seen == [BACKGROUND_REVIEW]
    assert get_current_write_origin() == DEFAULT_ORIGIN, "origin must not leak past dispatch"


async def test_streaming_path_is_stamped_too():
    """loop.py:1444 only ever calls execute_streaming — missing it would leave
    every real write unattributed."""
    probe = OriginProbe()
    registry = ToolRegistry(write_origin=BACKGROUND_REVIEW)
    registry.register(probe)

    async def sink(_chunk):
        return None

    await registry.execute_streaming("origin_probe", {}, on_chunk=sink)

    assert probe.seen == [BACKGROUND_REVIEW]
    assert get_current_write_origin() == DEFAULT_ORIGIN


async def test_origin_is_restored_even_when_the_tool_raises():
    class Boom(OriginProbe):
        async def execute(self, **kwargs) -> str:
            raise RuntimeError("boom")

    registry = ToolRegistry(write_origin=BACKGROUND_REVIEW)
    registry.register(Boom())

    result = await registry.execute("origin_probe", {})

    assert "Error executing" in result
    assert get_current_write_origin() == DEFAULT_ORIGIN


def test_an_unknown_origin_fails_closed_to_user_owned():
    """A typo'd or future tag must not silently widen what the curator may eat."""
    with write_origin("something_new"):
        assert get_current_write_origin() == DEFAULT_ORIGIN
        assert not is_agent_created(get_current_write_origin())


# ─── what gets persisted ────────────────────────────────────────────────────


async def test_foreground_save_is_recorded_as_user_owned(save, workspace):
    await save.execute(name="lead-research", content="# Lead research\nSteps.")

    assert skill_origins.get_origin(workspace, "lead-research") == DEFAULT_ORIGIN
    assert not skill_origins.is_agent_created_skill(workspace, "lead-research")


async def test_review_fork_save_is_recorded_as_agent_created(save, workspace):
    with write_origin(BACKGROUND_REVIEW):
        await save.execute(name="lead-research", content="# Lead research\nSteps.")

    assert skill_origins.is_agent_created_skill(workspace, "lead-research")


async def test_a_user_skill_stays_user_owned_after_the_fork_patches_it(save, workspace):
    """The invariant that keeps the curator off user content."""
    with write_origin(USER):
        await save.execute(name="outbound", content="v1")
    with write_origin(BACKGROUND_REVIEW):
        await save.execute(name="outbound", content="v2")

    assert skill_origins.get_origin(workspace, "outbound") == USER
    assert not skill_origins.is_agent_created_skill(workspace, "outbound")


async def test_created_at_survives_rewrites_and_writes_are_counted(save, workspace):
    await save.execute(name="s", content="v1")
    first = skill_origins.get_entry(workspace, "s")
    await save.execute(name="s", content="v2")
    second = skill_origins.get_entry(workspace, "s")

    assert second["created_at"] == first["created_at"]
    assert second["write_count"] == 2


async def test_an_unrecorded_skill_reads_as_user_owned(workspace):
    """Skills predating the sidecar are not the curator's to touch."""
    (workspace / "skills" / "legacy").mkdir()
    (workspace / "skills" / "legacy" / "SKILL.md").write_text("# legacy", encoding="utf-8")

    assert skill_origins.get_origin(workspace, "legacy") is None
    assert not skill_origins.is_agent_created_skill(workspace, "legacy")


async def test_a_corrupt_sidecar_never_breaks_the_save(save, workspace):
    skill_origins.sidecar_path(workspace).write_text("{not json", encoding="utf-8")

    out = await save.execute(name="s", content="body")

    assert "Created skill" in out
    assert (workspace / "skills" / "s" / "SKILL.md").read_text(encoding="utf-8") == "body"


def test_the_sidecar_is_not_mistaken_for_a_skill(workspace):
    """It sits in skills/ next to skill directories; the loader must skip it."""
    skill_origins.record_write(workspace, "s", DEFAULT_ORIGIN)

    assert skill_origins.sidecar_path(workspace).exists()
    assert not skill_origins.sidecar_path(workspace).is_dir()


# ─── overwrite safety + the reporting bug ───────────────────────────────────


async def test_a_new_skill_is_announced_as_created(save):
    out = await save.execute(name="fresh", content="body")

    assert out.startswith("Created skill"), "exists() was checked after the write"


async def test_an_existing_skill_is_announced_as_updated(save):
    await save.execute(name="again", content="v1")
    out = await save.execute(name="again", content="v2")

    assert out.startswith("Updated skill")


async def test_overwriting_keeps_the_previous_version(save, workspace):
    """Recoverability now lives in the ledger (see test_skill_ledger.py)."""
    await save.execute(name="precious", content="the version the user dictated")
    out = await save.execute(name="precious", content="what the agent replaced it with")

    assert "recoverable" in out
    entries = skill_ledger.read_entries(workspace, name="precious")
    assert [e["action"] for e in entries] == ["create", "update"]
    assert skill_ledger.read_blob(workspace, entries[-1]["before"]) == (
        "the version the user dictated"
    )


async def test_a_first_write_records_a_create_with_no_before(save, workspace):
    await save.execute(name="solo", content="v1")

    entry = skill_ledger.read_entries(workspace, name="solo")[-1]
    assert entry["action"] == "create"
    assert entry["before"] is None
