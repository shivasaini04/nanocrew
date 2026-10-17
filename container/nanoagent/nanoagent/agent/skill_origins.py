"""Skill provenance sidecar — who wrote each skill, and when.

Stage 42, item #2 (the persisted half; the live signal is
:mod:`nanoagent.agent.tool_origin`). Stage 42 item #3 grows usage counters and
lifecycle states into this same file.

Why a sidecar and not ``SKILL.md`` frontmatter
----------------------------------------------
``SkillsLoader`` parses that frontmatter on every turn (``agent/skills.py``
``_read_skill_metadata``, memoised in ``_SKILL_META_CACHE``) and ``always: true``
is read from it. Operational telemetry does not belong in a file the user
authors and the loader parses: it would churn user-owned content on every write,
invalidate the metadata cache, and put bookkeeping into the prompt budget.
Keeping it beside the skills instead means the file stays greppable, survives a
DB reset, and is readable by the orchestrator straight off the host — agent
workspaces are host directories (``src/agents/agent-workspace.ts``
``getAgentRoot``), which is what lets the curator's cheap half run outside a
container at all.

Layout — ``<workspace>/skills/.origins.json``::

    {
      "version": 1,
      "skills": {
        "python-typing": {
          "origin": "assistant_tool",
          "created_at": "2026-08-22T09:14:03Z",
          "updated_at": "2026-08-22T11:02:55Z",
          "write_count": 2,
          "usage_count": 17,
          "last_used_at": "2026-08-24T06:40:11Z",
          "pinned": false
        }
      }
    }

Field names follow ``src/services/tool-lifecycle-manager.ts``'s ``ToolSummary``
(``usageCount`` / ``lastUsed`` / ``createdAt``, and its 30-day
``unusedDaysThreshold``) so skills and dynamic tools describe themselves the same
way rather than growing two vocabularies for one idea. The lifecycle states are
Hermes' — a skill cannot fail at runtime the way a generated tool can, so *health*
is the wrong axis for it; *whether anyone still uses it* is the right one.

Every write here is **best-effort**: a broken or unwritable sidecar logs at debug
and returns, and must never break the ``save_skill`` call it describes. The
sidecar is telemetry, not a gate. The one thing it must not do is *lie* — an
entry it cannot attribute is left absent, and a missing entry reads as
user-owned (see :func:`nanoagent.agent.tool_origin.is_agent_created`), so the
failure mode is a skill the curator refuses to touch, never one it wrongly eats.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nanoagent.agent.tool_origin import (
    DEFAULT_ORIGIN,
    get_current_write_origin,
    is_agent_created,
)

# stdlib logging, not loguru: this module is imported by leaf tools and by the
# test suite's package shim, neither of which can assume the provider stack is
# installed. Same precedent as ``agent/tools/web.py``.
logger = logging.getLogger(__name__)

SIDECAR_NAME = ".origins.json"
SCHEMA_VERSION = 1

# Lifecycle states (stage 42 #3). ``pinned`` is a separate boolean flag, orthogonal
# to these — a pinned skill bypasses every automatic transition.
ACTIVE = "active"
STALE = "stale"
ARCHIVED = "archived"

# Unused for this long and the skill is stale. Mirrors ToolLifecycleManager's
# DEFAULT_CLEANUP_POLICY.unusedDaysThreshold so a skill and a generated tool go
# quiet on the same clock.
STALE_AFTER_DAYS = 30

# Unused for this long and the curator may archive it. Archive is a move, never a
# delete — the same "archiveOnJobEnd" posture the tool manager already takes.
ARCHIVE_AFTER_DAYS = 90


def sidecar_path(workspace: Path) -> Path:
    """Location of the provenance sidecar for a workspace."""
    return Path(workspace) / "skills" / SIDECAR_NAME


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_all(workspace: Path) -> dict[str, dict[str, Any]]:
    """Every recorded entry, keyed by skill name. ``{}`` when absent or corrupt."""
    path = sidecar_path(workspace)
    try:
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.debug("skill origins sidecar unreadable at %s: %s", path, e)
        return {}
    if not isinstance(data, dict):
        return {}
    skills = data.get("skills")
    return skills if isinstance(skills, dict) else {}


def get_entry(workspace: Path, name: str) -> dict[str, Any] | None:
    """The recorded entry for one skill, or ``None`` if it was never recorded."""
    entry = read_all(workspace).get(name)
    return entry if isinstance(entry, dict) else None


def get_origin(workspace: Path, name: str) -> str | None:
    """Recorded origin for a skill, or ``None`` when unattributed."""
    entry = get_entry(workspace, name)
    if not entry:
        return None
    origin = entry.get("origin")
    return origin if isinstance(origin, str) else None


def is_agent_created_skill(workspace: Path, name: str) -> bool:
    """True only for skills the agent wrote autonomously — the curator's allowlist.

    An unrecorded skill is user-owned by construction: predating the sidecar, or
    written by a path that never stamped one. Either way it is not ours to curate.
    """
    return is_agent_created(get_origin(workspace, name))


def record_write(
    workspace: Path,
    name: str,
    origin: str | None = None,
    *,
    now: str | None = None,
) -> dict[str, Any] | None:
    """Record one skill write. Returns the stored entry, or ``None`` if it couldn't be.

    ``origin`` defaults to the live :mod:`~nanoagent.agent.tool_origin` ContextVar,
    which is what makes this a no-argument call from inside a tool.

    ``created_at`` is preserved across rewrites — only the first write establishes
    it. ``origin`` is *not* re-stamped once set: a skill the user authored stays
    user-owned even if the background review fork later patches it, which is the
    invariant that keeps the curator off user content.
    """
    resolved = origin or get_current_write_origin() or DEFAULT_ORIGIN
    stamp = now or _utcnow()

    def mutate(skills: dict[str, Any]) -> dict[str, Any]:
        existing = skills.get(name) if isinstance(skills.get(name), dict) else {}
        entry = dict(existing)
        entry.update(
            {
                "origin": existing.get("origin", resolved),
                "created_at": existing.get("created_at", stamp),
                "updated_at": stamp,
                "write_count": int(existing.get("write_count", 0)) + 1,
            }
        )
        skills[name] = entry
        return entry

    return _mutate(workspace, mutate, what=f"origin for {name!r}")


def record_use(
    workspace: Path,
    names: str | list[str],
    *,
    now: str | None = None,
) -> bool:
    """Count one use of each named skill. Returns True if the sidecar was updated.

    "Use" means the skill was actually loaded into the model's context, not that it
    surfaced in a search — a search hit the agent ignored is not evidence the skill
    earns its tokens, and inflating the count on discovery would keep dead skills
    looking alive forever.

    Batched deliberately: a turn injects the always-skills and the task-relevant ones
    together, and one atomic write for the set beats one per skill.
    """
    wanted = [names] if isinstance(names, str) else [n for n in names if n]
    if not wanted:
        return False
    stamp = now or _utcnow()

    def mutate(skills: dict[str, Any]) -> None:
        for name in wanted:
            existing = skills.get(name) if isinstance(skills.get(name), dict) else {}
            entry = dict(existing)
            entry["usage_count"] = int(existing.get("usage_count", 0)) + 1
            entry["last_used_at"] = stamp
            # A skill can be used without ever having been written by us (anything
            # shipped as a builtin), so establish created_at on first sighting too.
            entry.setdefault("created_at", stamp)
            skills[name] = entry

    return _mutate(workspace, mutate, what=f"usage for {wanted!r}") is not None


def set_pinned(workspace: Path, name: str, pinned: bool = True) -> bool:
    """Pin (or unpin) a skill. A pinned skill bypasses every automatic transition."""

    def mutate(skills: dict[str, Any]) -> None:
        entry = dict(skills.get(name) or {})
        entry["pinned"] = bool(pinned)
        entry.setdefault("created_at", _utcnow())
        skills[name] = entry

    return _mutate(workspace, mutate, what=f"pin for {name!r}") is not None


def lifecycle_state(
    entry: dict[str, Any] | None,
    *,
    now: datetime | None = None,
    stale_after_days: int = STALE_AFTER_DAYS,
    archive_after_days: int = ARCHIVE_AFTER_DAYS,
) -> str:
    """Derive a skill's lifecycle state from its timestamps.

    Pure and derived, never stored: a stored state would need a daemon to keep it
    honest and would go wrong the moment one didn't run. Anything unrecorded, unparsable
    or pinned reads as :data:`ACTIVE` — the state that causes no action.
    """
    if not isinstance(entry, dict) or entry.get("pinned"):
        return ACTIVE
    last = _parse_ts(entry.get("last_used_at")) or _parse_ts(entry.get("created_at"))
    if last is None:
        return ACTIVE
    idle_days = ((now or datetime.now(timezone.utc)) - last).total_seconds() / 86400
    if idle_days >= archive_after_days:
        return ARCHIVED
    if idle_days >= stale_after_days:
        return STALE
    return ACTIVE


def states(workspace: Path, **kwargs: Any) -> dict[str, str]:
    """Lifecycle state for every recorded skill — what the curator's cheap half reads."""
    return {n: lifecycle_state(e, **kwargs) for n, e in read_all(workspace).items()}


def curatable(workspace: Path, **kwargs: Any) -> list[str]:
    """Skills the curator may act on: agent-created, not pinned, and past active.

    The intersection is the whole point. Being unused is not permission to touch
    something the user wrote.
    """
    out = []
    for name, entry in read_all(workspace).items():
        if not is_agent_created(entry.get("origin")):
            continue
        if lifecycle_state(entry, **kwargs) != ACTIVE:
            out.append(name)
    return out


def _mutate(workspace: Path, fn: Any, *, what: str) -> dict[str, Any] | None:
    """Read-modify-write the sidecar atomically. Best-effort; never raises.

    ``fn`` receives the skills mapping and mutates it in place; whatever it returns
    is passed back to the caller.
    """
    try:
        skills = read_all(workspace)
        result = fn(skills)
        path = sidecar_path(workspace)
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(path, {"version": SCHEMA_VERSION, "skills": skills})
        return result if isinstance(result, dict) else {}
    except Exception as e:  # noqa: BLE001 — telemetry must never break the write
        logger.debug("could not record skill %s: %s", what, e)
        return None


def _parse_ts(value: Any) -> datetime | None:
    """Parse a sidecar timestamp, tolerating anything a hand-edit might leave."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def forget(workspace: Path, name: str) -> bool:
    """Drop a skill's entry (for when the skill itself is gone). Best-effort."""
    try:
        skills = read_all(workspace)
        if name not in skills:
            return False
        del skills[name]
        _atomic_write_json(
            sidecar_path(workspace), {"version": SCHEMA_VERSION, "skills": skills}
        )
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("could not forget skill origin for %r: %s", name, e)
        return False


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON via tempfile + ``os.replace`` so a crash can't leave a half file.

    The temp file is created in the destination directory because ``os.replace``
    is only atomic within a filesystem, and the workspace may be a mount.
    """
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
