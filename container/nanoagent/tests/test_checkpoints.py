"""A bad turn must be undoable — the workspace had no undo at all.

Stage 42 item #10. This is not hypothetical: a bare rejection once got summarised
into invented instructions and written into IDENTITY.md at relevance 0.9, with
nothing to revert.

The shadow repo lives OUTSIDE the working tree (--git-dir/--work-tree), so a
workspace that already contains a real git repo is untouched and nothing here can
be committed into the agent's own work by accident. That separation is the property
most worth testing.
"""
import shutil
from pathlib import Path

import pytest

from nanoagent.agent.checkpoints import MUTATING_TOOLS, CheckpointStore

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "IDENTITY.md").write_text("# Finder\nFinds leads.", encoding="utf-8")
    return tmp_path


@pytest.fixture
def store(workspace: Path) -> CheckpointStore:
    return CheckpointStore(workspace)


def identity(workspace: Path) -> str:
    return (workspace / "IDENTITY.md").read_text(encoding="utf-8")


# ─── snapshot and restore ───────────────────────────────────────────────────


def test_a_clobbered_file_can_be_recovered(store, workspace):
    store.snapshot("before the turn")
    (workspace / "IDENTITY.md").write_text("garbage the agent invented", encoding="utf-8")

    ok, msg = store.restore(store.list()[-1].ref)

    assert ok, msg
    assert identity(workspace) == "# Finder\nFinds leads."


def test_restoring_over_uncommitted_work_captures_it_first(store, workspace):
    """The at-risk case: a restore must not be the thing that loses work.

    (When the workspace is already clean there is nothing to capture and the safety
    snapshot correctly records nothing — the prior state is a checkpoint already.)
    """
    store.snapshot("original")
    original = store.list()[0].ref
    (workspace / "IDENTITY.md").write_text("unsaved work in progress", encoding="utf-8")

    ok, msg = store.restore(original)

    assert ok, msg
    assert identity(workspace) == "# Finder\nFinds leads."
    rescued = next(c for c in store.list() if "before restore" in c.label)
    assert "unsaved work in progress" not in identity(workspace)
    assert store.diff(rescued.ref), "the overwritten state is reachable as a checkpoint"


def test_snapshots_are_labelled_and_ordered(store, workspace):
    store.snapshot("first")
    (workspace / "notes.md").write_text("x", encoding="utf-8")
    store.snapshot("second")

    labels = [c.label for c in store.list()]

    assert "second" in labels[0] and "first" in labels[1], "newest first"


def test_an_unchanged_workspace_records_nothing(store):
    assert store.snapshot("first") is not None
    assert store.snapshot("again") is None, "no empty checkpoints cluttering the log"


def test_diff_reports_what_the_turn_touched(store, workspace):
    store.snapshot("before")
    ref = store.list()[0].ref
    (workspace / "IDENTITY.md").write_text("changed", encoding="utf-8")

    assert "IDENTITY.md" in store.diff(ref)


# ─── it must not disturb the workspace ──────────────────────────────────────


def test_the_workspace_never_gains_a_git_directory(store, workspace):
    store.snapshot("x")

    assert not (workspace / ".git").exists(), "an agent's own repo must be unaffected"
    assert (workspace / ".checkpoints" / "HEAD").exists()


def test_a_real_repo_inside_the_workspace_is_untouched(store, workspace):
    import subprocess

    project = workspace / "project"
    project.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=project, check=True)
    head_before = (project / ".git" / "HEAD").read_text(encoding="utf-8")

    store.snapshot("x")

    assert (project / ".git" / "HEAD").read_text(encoding="utf-8") == head_before


def test_telemetry_is_excluded_so_snapshots_stay_meaningful(workspace, store):
    """It grows every turn, so including it makes every snapshot a non-empty diff.

    Regression cover for what the first prod cycle produced: one checkpoint carrying
    ~1,800 lines of JSONL and nothing else.
    """
    tele = workspace / ".nanocrew" / "telemetry"
    tele.mkdir(parents=True)
    (tele / "session-default.jsonl").write_text("{}\n", encoding="utf-8")
    store.snapshot("first")

    (tele / "session-default.jsonl").write_text("{}\n" * 500, encoding="utf-8")

    assert store.snapshot("after more logging") is None, "log growth alone is not a change"


def test_caches_are_excluded_from_snapshots(store, workspace):
    (workspace / "node_modules").mkdir()
    (workspace / "node_modules" / "big.js").write_text("x" * 1000, encoding="utf-8")
    (workspace / "__pycache__").mkdir()
    (workspace / "__pycache__" / "m.pyc").write_text("y", encoding="utf-8")

    store.snapshot("x")
    ref = store.list()[0].ref
    (workspace / "IDENTITY.md").write_text("changed", encoding="utf-8")

    assert "node_modules" not in store.diff(ref)
    assert "__pycache__" not in store.diff(ref)


# ─── it never gets in the way ───────────────────────────────────────────────


def test_an_unusable_store_degrades_quietly(tmp_path: Path):
    """Losing the undo history is bad; refusing to let the agent work is worse."""
    workspace = tmp_path / "nope"
    store = CheckpointStore(workspace)  # workspace does not exist

    assert store.snapshot("x") is None
    assert store.list() == []
    assert store.restore("deadbeef")[0] is False


def test_restoring_without_a_store_is_refused_not_crashed(tmp_path: Path):
    ok, msg = CheckpointStore(tmp_path).restore("deadbeef")

    assert not ok and "No checkpoint store" in msg


def test_the_tools_that_trigger_a_snapshot_cover_the_destructive_ones():
    for name in ("write_file", "edit_file", "append_file", "exec", "python_repl"):
        assert name in MUTATING_TOOLS
    assert "read_file" not in MUTATING_TOOLS
    assert "search" not in MUTATING_TOOLS
