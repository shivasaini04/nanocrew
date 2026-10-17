"""stage45 item 1: one frame per step, kept — `effector/frame_archive.py`.

Stage 44 refused to persist frames, and its reason was sound about *streaming*:

    2fps for a 3-minute run   ~360 frames   ~14 MB
    one frame per step        ~15 frames    ~600 KB

Same run, 24x less, and the per-step version is the one a post-mortem wants. So the
tests here are mostly about the two things that make "keep it" safe rather than a slow
leak: the growth bounds, and never failing a run.

Not tested here: that the JPEGs are of the right page. That needs a real browser and is
in the live harness.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from nanoagent.agent.effector.frame_archive import (
    ARCHIVE_SUBDIR,
    _MAX_FRAMES_PER_RUN,
    FrameArchive,
    list_runs,
)

_JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0-not-really-a-jpeg").decode()


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    return tmp_path


# ── writing ──────────────────────────────────────────────────────────────────


def test_a_frame_is_written_and_indexed(ws: Path):
    a = FrameArchive(ws, "run-1")
    rec = a.record(turn=1, action="click", data_url=_JPEG, url="https://x.test/a", title="A")

    assert rec is not None
    assert rec.file == f"{ARCHIVE_SUBDIR}/run-1/000.jpg"
    # The path in the record is workspace-relative because that is what the dashboard
    # feeds to workspace/file?path=… — an absolute container path means nothing there.
    assert not rec.file.startswith("/")
    assert (ws / rec.file).read_bytes().startswith(b"\xff\xd8\xff")

    index = json.loads((ws / ARCHIVE_SUBDIR / "run-1" / "index.json").read_text())
    assert index["run_id"] == "run-1"
    assert index["frames"][0]["url"] == "https://x.test/a"
    assert index["frames"][0]["action"] == "click"


def test_frames_are_numbered_in_order(ws: Path):
    a = FrameArchive(ws, "run-1")
    for i in range(3):
        a.record(turn=i + 1, action="click", data_url=_JPEG)
    assert [f.file.rsplit("/", 1)[-1] for f in a.frames()] == ["000.jpg", "001.jpg", "002.jpg"]


def test_the_index_is_replaced_atomically_never_left_half_written(ws: Path):
    """The dashboard fetches this file WHILE the run is still going. A partially
    written JSON array is unparseable, so the write goes to a temp file and is
    replaced — a reader sees the previous complete index or the new one, never half."""
    a = FrameArchive(ws, "run-1")
    a.record(turn=1, action="click", data_url=_JPEG)
    a.record(turn=2, action="type", data_url=_JPEG)

    directory = ws / ARCHIVE_SUBDIR / "run-1"
    assert list(directory.glob("*.tmp")) == []          # nothing left behind
    assert len(json.loads((directory / "index.json").read_text())["frames"]) == 2


# ── the growth bounds, which are the reason this is safe to keep ─────────────


def test_a_run_cannot_outgrow_its_frame_cap(ws: Path):
    a = FrameArchive(ws, "run-1")
    for i in range(_MAX_FRAMES_PER_RUN + 25):
        a.record(turn=i, action="scroll", data_url=_JPEG)
    assert len(a.frames()) == _MAX_FRAMES_PER_RUN
    assert len(list((ws / ARCHIVE_SUBDIR / "run-1").glob("*.jpg"))) == _MAX_FRAMES_PER_RUN


def test_only_the_most_recent_runs_survive(ws: Path):
    """An agent that browses hourly forever is the case that matters."""
    for i in range(8):
        FrameArchive(ws, f"run-{i}").record(turn=1, action="click", data_url=_JPEG)

    removed = FrameArchive(ws, "run-new").prune(max_runs=3)
    assert removed == 5
    assert len(list((ws / ARCHIVE_SUBDIR).iterdir())) == 3


def test_pruning_keeps_the_NEWEST_runs_not_an_arbitrary_three(ws: Path):
    """Run ids are UUIDs, so sorting by name would delete arbitrary runs. Sorting is by
    mtime, and this pins that — the three touched last are the three that survive."""
    import os
    import time

    for i in range(5):
        FrameArchive(ws, f"run-{i}").record(turn=1, action="click", data_url=_JPEG)

    # Stamp explicit, well-separated mtimes rather than relying on write order: a
    # coarse filesystem clock can give five directories the same timestamp.
    now = time.time()
    for i in range(5):
        os.utime(ws / ARCHIVE_SUBDIR / f"run-{i}", (now + i, now + i))

    FrameArchive(ws, "x").prune(max_runs=3)
    survivors = {d.name for d in (ws / ARCHIVE_SUBDIR).iterdir()}
    assert survivors == {"run-2", "run-3", "run-4"}


def test_pruning_a_workspace_with_no_archive_is_a_no_op(ws: Path):
    assert FrameArchive(ws, "run-1").prune() == 0


# ── never fail a run ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [None, "", "data:text/html,<script>", "not-a-data-url"])
def test_anything_that_is_not_our_own_jpeg_is_ignored(ws: Path, bad):
    """The archive only ever sees frames our own screencast produced. Anything else is
    a bug or an attack, and either way it is not going on disk."""
    a = FrameArchive(ws, "run-1")
    assert a.record(turn=1, action="click", data_url=bad) is None
    assert a.frames() == []


def test_an_unwritable_workspace_disables_the_archive_instead_of_raising(ws: Path, monkeypatch):
    """A replay is a nice-to-have view of work that already happened. Same error
    contract as the live frame push: swallow, log at debug, let the run finish."""
    a = FrameArchive(ws, "run-1")

    def boom(*_a, **_kw):
        raise OSError("read-only file system")

    monkeypatch.setattr(Path, "mkdir", boom)
    assert a.record(turn=1, action="click", data_url=_JPEG) is None

    # And it stays off rather than retrying every step for the rest of the run — a
    # read-only mount will not be different in four seconds, and fifteen identical
    # debug lines is how a log becomes unreadable.
    monkeypatch.undo()
    assert a.record(turn=2, action="click", data_url=_JPEG) is None


# ── listing ──────────────────────────────────────────────────────────────────


def test_list_runs_reports_newest_first_with_the_last_url(ws: Path):
    import os
    import time

    a1 = FrameArchive(ws, "run-old")
    a1.record(turn=1, action="navigate", data_url=_JPEG, url="https://old.test/")
    a2 = FrameArchive(ws, "run-new")
    a2.record(turn=1, action="navigate", data_url=_JPEG, url="https://new.test/one")
    a2.record(turn=2, action="click", data_url=_JPEG, url="https://new.test/two")

    now = time.time()
    os.utime(ws / ARCHIVE_SUBDIR / "run-old", (now, now))
    os.utime(ws / ARCHIVE_SUBDIR / "run-new", (now + 10, now + 10))

    runs = list_runs(ws)
    assert [r["run_id"] for r in runs] == ["run-new", "run-old"]
    assert runs[0]["frames"] == 2
    assert runs[0]["last_url"] == "https://new.test/two"


def test_listing_an_empty_workspace_is_empty_not_an_error(ws: Path):
    assert list_runs(ws) == []


def test_a_run_with_a_corrupt_index_is_skipped_not_fatal(ws: Path):
    """The only way to see broken JSON is a directory pruned underneath the reader.
    An entry the UI cannot open is worse than no entry."""
    FrameArchive(ws, "good").record(turn=1, action="click", data_url=_JPEG)
    bad = ws / ARCHIVE_SUBDIR / "bad"
    bad.mkdir(parents=True)
    (bad / "index.json").write_text("{not json")

    runs = list_runs(ws)
    assert [r["run_id"] for r in runs] == ["good"]
