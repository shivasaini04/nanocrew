"""Skill curator — retire what nobody uses, and never touch what isn't ours.

Stage 42 #4, following Hermes Agent's ``agent/curator.py``
(NousResearch/hermes-agent @ a7cd15e) in posture, not in size.

Hermes triggers its curator on *inactivity*: it has a long-lived agent process that
notices it has gone idle. We have no such moment — a cycle spawns a container, works,
and the container dies. So the stage 42 decision was to split the curator in two:

* **the deterministic half — this module.** Lifecycle transitions are date
  arithmetic over the sidecar, needing no model at all. Cheap enough to run on
  every ``self_improve`` cycle, or straight from the orchestrator, which already
  reads and writes agent workspaces from the host.
* **the LLM half — not built.** Consolidating near-duplicate skills and patching
  stale ones needs a model and its own judgment. It belongs in a ``self_improve``
  sub-mode. :func:`consolidation_candidates` marks where it would attach.

Invariants, inherited from Hermes and non-negotiable:

* **Only agent-created skills.** Enforced via :func:`skill_origins.curatable`,
  which is the intersection of "unused" and "written by the review fork". Being
  unused is never permission to touch something the user wrote.
* **Never delete — only archive.** Archived skills move to ``skills/.archive/``
  and can be restored. ``SkillsLoader`` skips the directory (it holds no
  ``SKILL.md`` of its own), so an archived skill simply stops being loaded.
* **Pinned skills bypass everything**, handled inside ``lifecycle_state``.
* **Every move is ledgered**, so an archive is undoable like any other mutation.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from nanoagent.agent import skill_ledger, skill_origins
from nanoagent.agent.tool_origin import CURATOR

logger = logging.getLogger(__name__)

ARCHIVE_DIR_NAME = ".archive"

# Curator writes are tagged as their own actor in the ledger rather than borrowing
# the review fork's tag: "the curator archived this" and "the fork wrote this" are
# different facts, and conflating them would make the audit trail lie.
CURATOR_ACTOR = CURATOR


@dataclass
class SweepResult:
    """What a sweep did, or would have done under ``dry_run``."""

    archived: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    dry_run: bool = False

    def summary(self) -> str:
        verb = "would archive" if self.dry_run else "archived"
        parts = [f"{verb} {len(self.archived)}"]
        if self.stale:
            parts.append(f"{len(self.stale)} going stale")
        if self.skipped:
            parts.append(f"{len(self.skipped)} skipped")
        return "Curator: " + ", ".join(parts) + "."


def archive_dir(workspace: Path) -> Path:
    return Path(workspace) / "skills" / ARCHIVE_DIR_NAME


def sweep(
    workspace: Path,
    *,
    now: datetime | None = None,
    dry_run: bool = False,
) -> SweepResult:
    """Archive agent-created skills that have gone unused past the threshold.

    Deterministic and idempotent: it reads timestamps, moves directories, and writes
    ledger entries. No model, no network, no judgment. Safe to run on a schedule.
    """
    result = SweepResult(dry_run=dry_run)
    states = skill_origins.states(workspace, now=now)
    eligible = set(skill_origins.curatable(workspace, now=now))

    for name, state in sorted(states.items()):
        if state == skill_origins.STALE and name in eligible:
            # Stale is a warning shelf, not an action: it is reported so a human can
            # see what is drifting, and left alone until it reaches archive age.
            result.stale.append(name)
            continue
        if state != skill_origins.ARCHIVED or name not in eligible:
            continue
        if dry_run:
            result.archived.append(name)
            continue
        if _archive_one(workspace, name):
            result.archived.append(name)
        else:
            result.skipped.append(name)

    logger.info(result.summary())
    return result


def _archive_one(workspace: Path, name: str) -> bool:
    """Move one skill into the archive, ledgering it first. Best-effort per skill."""
    source = Path(workspace) / "skills" / name
    skill_file = source / "SKILL.md"
    if not skill_file.exists():
        return False

    target = archive_dir(workspace) / name
    try:
        content = skill_file.read_text(encoding="utf-8")
        # Ledger BEFORE the move: if the move then fails the ledger holds a harmless
        # extra entry, whereas the reverse order could move a skill with no record of
        # where it went.
        skill_ledger.record(
            workspace, name, action=skill_ledger.DELETE,
            before=content, after=None, actor=CURATOR_ACTOR,
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(source), str(target))
        return True
    except OSError as e:
        logger.debug("could not archive skill %r: %s", name, e)
        return False


def archive(workspace: Path, name: str) -> bool:
    """Retire one named skill. The caller is responsible for checking eligibility.

    Public counterpart to the sweep, for callers that have already decided WHICH
    skill to retire — e.g. the agent consolidating duplicates via `curate_skills`.
    """
    return _archive_one(workspace, name)


def restore(workspace: Path, name: str) -> tuple[bool, str]:
    """Bring an archived skill back. Archive is recoverable, which is the point."""
    source = archive_dir(workspace) / name
    target = Path(workspace) / "skills" / name
    if not (source / "SKILL.md").exists():
        return False, f"No archived skill {name!r}."
    if target.exists():
        return False, f"{name!r} already exists — remove or rename it first."
    try:
        content = (source / "SKILL.md").read_text(encoding="utf-8")
        shutil.move(str(source), str(target))
        skill_ledger.record(
            workspace, name, action=skill_ledger.CREATE,
            before=None, after=content, actor=CURATOR_ACTOR,
        )
        return True, f"Restored {name!r} from the archive."
    except OSError as e:
        return False, f"Could not restore {name!r}: {e}"


def list_archived(workspace: Path) -> list[str]:
    """Names of archived skills, so nothing disappears without a way to find it."""
    root = archive_dir(workspace)
    if not root.exists():
        return []
    return sorted(d.name for d in root.iterdir() if d.is_dir() and (d / "SKILL.md").exists())


def consolidation_candidates(workspace: Path, *, now: datetime | None = None) -> list[str]:
    """Agent-created skills a model *could* usefully merge or rewrite.

    The deterministic half stops here on purpose. Deciding that two skills say the
    same thing, or that one is stale rather than simply unfashionable, is a judgment
    call — it belongs to the LLM half of the curator, which is not built. This
    function is the seam it will attach to.
    """
    return [
        name
        for name, entry in skill_origins.read_all(workspace).items()
        if skill_origins.is_agent_created_skill(workspace, name)
        and skill_origins.lifecycle_state(entry, now=now) != skill_origins.ACTIVE
    ]
