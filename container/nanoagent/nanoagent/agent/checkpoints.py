"""Transparent workspace snapshots, so a bad turn is recoverable.

Stage 42 #10, following Hermes Agent's ``tools/checkpoint_manager.py``
(NousResearch/hermes-agent @ a7cd15e). Their framing, which is the important part::

    This is NOT a tool — the LLM never sees it. It's transparent infrastructure.

Agent workspaces had no undo. A single bad turn could overwrite ``IDENTITY.md``,
``MEMORY.md`` or a tracker with no way back — and that is not hypothetical: a bare
rejection once got summarised into invented instructions and written into
``IDENTITY.md`` at relevance 0.9, with nothing to revert.

Design
------
A **shadow git repository**, kept outside the working tree at
``<workspace>/.checkpoints`` and driven with ``--git-dir`` / ``--work-tree``. The
workspace itself never gains a ``.git``, so an agent working on a real repo inside
its workspace is unaffected and nothing here can be committed by accident.

Git rather than file copies because a workspace is mostly unchanged between turns:
git stores one blob per distinct content and the snapshot costs almost nothing. It
is also already in the image (``container/nanoagent/Dockerfile``) for ``git_tool``.

Snapshots are taken **once per turn, before the first mutating tool runs** — the
same trigger Hermes uses. Taking one per mutation would multiply the cost for no
extra recoverability, since a turn is the unit anyone actually wants to undo.

Everything here is best-effort. A workspace that cannot be snapshotted still gets
worked in: losing the undo history is bad, refusing to let the agent work is worse.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

STORE_DIR_NAME = ".checkpoints"

# Snapshotting is bounded so a huge workspace cannot stall a turn. git is fast, but
# an agent that downloaded a dataset should not be able to hang the loop on commit.
GIT_TIMEOUT_SECONDS = 60

# Never snapshot these: caches and virtualenvs are large, regenerable, and would
# dominate the store. Written into the shadow repo's own excludes file, so the
# workspace stays free of agent-visible config.
EXCLUDES = (
    ".checkpoints/",
    "__pycache__/",
    "*.pyc",
    "node_modules/",
    ".venv/",
    "venv/",
    ".git/",
    "*.tmp",
    # Telemetry is append-only and grows on every single turn, so including it would
    # make every snapshot a non-empty diff — defeating "an unchanged workspace records
    # nothing", bloating the store, and burying the real changes in log noise. Seen in
    # prod on the first cycle after deploy: one checkpoint carrying ~1,800 lines of
    # JSONL and nothing else. It is also a record, not work product: rewinding the
    # workspace should never rewind the log of what happened to it.
    ".nanocrew/telemetry/",
)


# Tools whose use can destroy work in the workspace. The trigger set is deliberately
# broad -- a snapshot nobody needed costs a git commit of an unchanged tree (which is
# a no-op), while a missing one costs the work itself.
MUTATING_TOOLS = frozenset({
    "write_file", "edit_file", "append_file", "save_skill",
    "exec", "shell", "python_repl", "git",
})


@dataclass(frozen=True)
class Checkpoint:
    """One snapshot of the workspace."""

    ref: str
    label: str
    when: str


class CheckpointStore:
    """Shadow-git snapshots of one workspace. Invisible to the model."""

    def __init__(self, workspace: Path, timeout: int = GIT_TIMEOUT_SECONDS) -> None:
        self.workspace = Path(workspace)
        self.git_dir = self.workspace / STORE_DIR_NAME
        self._timeout = timeout
        self._ready: bool | None = None

    # ── public API ──────────────────────────────────────────────────────────

    def snapshot(self, label: str = "") -> str | None:
        """Commit the current workspace. Returns the commit hash, or None.

        None means "no snapshot" — nothing changed, or the store is unavailable.
        Callers must treat it as normal, never as an error worth surfacing.
        """
        if not self._ensure_ready():
            return None
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        message = f"{stamp} {label}".strip()
        try:
            self._git("add", "-A")
            # --allow-empty would record a checkpoint per turn even when nothing
            # changed, filling the log with noise that hides the real ones.
            result = self._git("commit", "-m", message, check=False)
            if result.returncode != 0:
                if "nothing to commit" in (result.stdout + result.stderr):
                    return None
                logger.debug("checkpoint commit failed: %s", result.stderr[:200])
                return None
            return self._git("rev-parse", "HEAD").stdout.strip()
        except Exception as e:  # noqa: BLE001 — never block the turn
            logger.debug("could not snapshot workspace: %s", e)
            return None

    def list(self, limit: int = 20) -> list[Checkpoint]:
        """Recent checkpoints, newest first."""
        if not self._is_initialised():
            return []
        try:
            out = self._git(
                "log", f"-{limit}", "--format=%H%x1f%s%x1f%cI", check=False
            ).stdout
        except Exception:  # noqa: BLE001
            return []
        checkpoints = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) == 3:
                checkpoints.append(Checkpoint(ref=parts[0], label=parts[1], when=parts[2]))
        return checkpoints

    def restore(self, ref: str) -> tuple[bool, str]:
        """Restore the workspace to a checkpoint.

        Snapshots the current state first, so a restore is itself undoable — the same
        fail-closed posture as the skill ledger's rollback.
        """
        if not self._is_initialised():
            return False, "No checkpoint store for this workspace."
        safety = self.snapshot("before restore")
        try:
            self._git("checkout", "--force", ref, "--", ".")
            undo = f" (undo: {safety[:8]})" if safety else ""
            return True, f"Workspace restored to {ref[:8]}{undo}."
        except Exception as e:  # noqa: BLE001
            return False, f"Restore failed: {e}"

    def diff(self, ref: str) -> str:
        """What changed since a checkpoint — names only, so it stays readable."""
        if not self._is_initialised():
            return ""
        try:
            return self._git("diff", "--name-status", ref, check=False).stdout.strip()
        except Exception:  # noqa: BLE001
            return ""

    # ── internals ───────────────────────────────────────────────────────────

    def _is_initialised(self) -> bool:
        return (self.git_dir / "HEAD").exists()

    def _ensure_ready(self) -> bool:
        """Create the shadow repo on first use. Cached: this runs on every turn."""
        if self._ready is not None:
            return self._ready
        try:
            if not self._is_initialised():
                self.git_dir.mkdir(parents=True, exist_ok=True)
                self._git("init", "--quiet")
                # Identity is set locally so a snapshot works on a box with no global
                # git config — the common case inside a fresh container.
                self._git("config", "user.email", "agent@nanocrew.local")
                self._git("config", "user.name", "NanoCrew checkpoint")
            (self.git_dir / "info").mkdir(parents=True, exist_ok=True)
            (self.git_dir / "info" / "exclude").write_text(
                "\n".join(EXCLUDES) + "\n", encoding="utf-8"
            )
            self._ready = True
        except Exception as e:  # noqa: BLE001
            logger.debug("checkpoint store unavailable for %s: %s", self.workspace, e)
            self._ready = False
        return self._ready

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                "git",
                f"--git-dir={self.git_dir}",
                f"--work-tree={self.workspace}",
                *args,
            ],
            capture_output=True,
            text=True,
            timeout=self._timeout,
            check=check,
        )
