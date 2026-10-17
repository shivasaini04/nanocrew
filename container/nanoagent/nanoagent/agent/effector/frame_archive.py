"""One frame per step, kept — so a finished run can be looked at again.

Stage 44 shipped a live view and deliberately persisted nothing:

> Frames are never persisted. `cycle_steps` records what the agent *did*; 2fps of
> ~40KB JPEGs is the same unbounded growth that already caused a V8 heap exhaustion.

That reasoning is right about **streaming** and wrong as a reason to keep nothing. The
arithmetic is the whole argument:

    2fps for a 3-minute run   ~360 frames   ~14 MB     <- what stage 44 refused
    one frame per step        ~15 frames    ~600 KB    <- what this writes

Same run, 24x less. And the per-step version is the more useful of the two anyway: 2fps
of a page nobody is watching is noise, while "what did the page look like when it
clicked that" is the question every post-mortem actually asks.

So the live stream stays unpersisted, and this writes exactly one frame at each step
boundary, beside the step it belongs to.

## Where it goes, and why there

`<workspace>/.effector/frames/<run_id>/` — inside the agent workspace, which the
orchestrator can already serve: `GET /api/agents/:id/workspace/file?path=…&raw=1`
resolves against the workspace with a path-traversal check and sets an image MIME type
(`routes/agents.ts`). No new route, no new transport, no new storage system. The
dashboard reads `index.json` and then the JPEGs by path.

## Growth, bounded twice

An agent that runs the browser hourly forever is the case that matters, so pruning is
not optional and not deferred:

- **per run**: `_MAX_FRAMES_PER_RUN` — a run cannot outgrow its own turn budget
- **across runs**: `_MAX_RUNS` most recent archives survive; older directories are
  deleted whole

Both are enforced on write, so nothing depends on a sweeper that might not run.
"""

from __future__ import annotations

import base64
import json
import shutil
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

# A run is capped at max_turns anyway; this is the backstop for a caller that raises it.
_MAX_FRAMES_PER_RUN = 60

# ~600KB per archived run, so twenty runs is ~12MB per agent. Small enough to keep
# without thinking about it, long enough to cover "what happened this morning".
_MAX_RUNS = 20

_DATA_URL_PREFIX = "data:image/jpeg;base64,"

# Relative to the workspace root, which is what the dashboard needs to build a
# `workspace/file?path=` URL — so this is the string the index stores, not an absolute
# path that means nothing outside the container.
ARCHIVE_SUBDIR = ".effector/frames"


@dataclass
class FrameRecord:
    """One step, and what the page looked like at the end of it."""

    turn: int
    action: str
    file: str                 # workspace-relative — what the dashboard fetches
    url: str = ""
    title: str = ""
    status: str = ""
    at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class FrameArchive:
    """Per-step frames for one run. Every method is best-effort by contract.

    Nothing here may fail a run. A replay is a nice-to-have view of work that already
    happened; if the disk is full or the frame is malformed, the right outcome is a
    debug line and a run that finishes normally. Same error contract as the live push
    in `react_loop._post_live_frame`.
    """

    def __init__(self, workspace: Path, run_id: str) -> None:
        self._workspace = Path(workspace)
        self._run_id = run_id or "unknown"
        self._records: list[FrameRecord] = []
        self._failed = False

    @property
    def directory(self) -> Path:
        return self._workspace / ARCHIVE_SUBDIR / self._run_id

    @property
    def index_path(self) -> Path:
        return self.directory / "index.json"

    def record(
        self,
        *,
        turn: int,
        action: str,
        data_url: str | None,
        url: str = "",
        title: str = "",
        status: str = "",
    ) -> FrameRecord | None:
        """Write one frame and update the index. Returns the record, or None if there
        was nothing to write (no frame yet, cap reached, or a previous write failed)."""
        if self._failed or not data_url or not data_url.startswith(_DATA_URL_PREFIX):
            return None
        if len(self._records) >= _MAX_FRAMES_PER_RUN:
            return None

        try:
            raw = base64.b64decode(data_url[len(_DATA_URL_PREFIX):], validate=False)
        except Exception as err:
            logger.debug(f"effector: frame archive could not decode a frame — {err}")
            return None

        try:
            directory = self.directory
            directory.mkdir(parents=True, exist_ok=True)
            name = f"{len(self._records):03d}.jpg"
            (directory / name).write_bytes(raw)

            record = FrameRecord(
                turn=turn,
                action=action,
                file=f"{ARCHIVE_SUBDIR}/{self._run_id}/{name}",
                url=url or "",
                title=title or "",
                status=status or "",
            )
            self._records.append(record)
            self._write_index()
            return record
        except Exception as err:
            # One failure disables the archive for the rest of the run rather than
            # retrying every step: whatever went wrong (read-only mount, full disk) is
            # not going to be different in four seconds, and a debug line per step for
            # fifteen steps is how a log becomes unreadable.
            self._failed = True
            logger.debug(f"effector: frame archive disabled for this run — {err}")
            return None

    def _write_index(self) -> None:
        """Rewritten in full on every frame, not appended.

        A partially-written JSON array is unparseable, and the dashboard fetches this
        file *while the run is still going*. Writing to a temp file and replacing it
        means a reader either sees the previous complete index or the new one, never
        half of either.
        """
        payload = {
            "run_id": self._run_id,
            "frames": [r.to_dict() for r in self._records],
            "updated_at": time.time(),
        }
        tmp = self.index_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.index_path)

    def frames(self) -> list[FrameRecord]:
        return list(self._records)

    def prune(self, max_runs: int = _MAX_RUNS) -> int:
        """Delete all but the `max_runs` most recent run directories. Returns how many
        went. Called at the end of a run, so an agent that browses hourly forever does
        not accumulate forever."""
        root = self._workspace / ARCHIVE_SUBDIR
        try:
            if not root.is_dir():
                return 0
            runs = [d for d in root.iterdir() if d.is_dir()]
            if len(runs) <= max_runs:
                return 0
            # By mtime rather than by name: run ids are UUIDs, so their sort order has
            # nothing to do with time and sorting by name would delete arbitrary runs.
            runs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
            removed = 0
            for old in runs[max_runs:]:
                shutil.rmtree(old, ignore_errors=True)
                removed += 1
            if removed:
                logger.debug(f"effector: pruned {removed} old frame archive(s)")
            return removed
        except Exception as err:
            logger.debug(f"effector: frame archive prune failed — {err}")
            return 0


def list_runs(workspace: Path, limit: int = _MAX_RUNS) -> list[dict[str, Any]]:
    """Every archived run in this workspace, newest first.

    Used by anything that wants to offer "look at a past run" without knowing a run id
    up front. Reads only the index files, never the JPEGs.
    """
    root = Path(workspace) / ARCHIVE_SUBDIR
    out: list[dict[str, Any]] = []
    try:
        if not root.is_dir():
            return []
        runs = [d for d in root.iterdir() if d.is_dir()]
        runs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        for d in runs[:limit]:
            index = d / "index.json"
            if not index.is_file():
                continue
            try:
                data = json.loads(index.read_text(encoding="utf-8"))
            except Exception:
                continue
            frames = data.get("frames") or []
            out.append({
                "run_id": data.get("run_id") or d.name,
                "frames": len(frames),
                "updated_at": data.get("updated_at"),
                "first_url": (frames[0].get("url") if frames else "") or "",
                "last_url": (frames[-1].get("url") if frames else "") or "",
                "index": f"{ARCHIVE_SUBDIR}/{d.name}/index.json",
            })
    except Exception as err:
        logger.debug(f"effector: could not list frame archives — {err}")
    return out
