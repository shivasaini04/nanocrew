"""Per-mutation skill audit ledger with content-addressed rollback.

Stage 42 #5, ported in shape from Hermes Agent's ``tools/skill_ledger.py``
(NousResearch/hermes-agent @ a7cd15e).

``save_skill`` advertises that it "overwrites any existing skill with the same
name" and, until stage 42, did so with nothing kept. An agent could silently
destroy a skill the founder dictated. The first fix kept the last five copies per
skill under ``skills/<name>/.backups/``; this replaces that, because a ledger is
strictly more capable for the same bytes — it also answers *who* changed a skill and
*when*, and it deduplicates identical content instead of storing five near-copies.

Layout::

    <workspace>/skills/
        .ledger.jsonl          one JSON object per mutation, append-only
        .blobs/<sha256>        file contents, deduplicated by hash

Design decisions, following Hermes:

* **JSONL, not the session DB.** A durable, human-greppable audit trail that
  survives a DB reset and is trivially copyable. ``grep outbound-tone .ledger.jsonl``
  is the whole debugging story.
* **Every actor is ledgered**, tagged from :mod:`~nanoagent.agent.tool_origin` —
  ``user`` deletes included. The curator invariant (never hard-delete autonomously)
  constrains what the *curator* may do; it is not a reason to leave a foreground
  delete unrecoverable.
* **Per-file content-addressed blobs, not tarballs.** A mutation usually touches one
  file, so a whole-tree archive per mutation would be waste, and identical content
  across entries collapses to a single blob.

**The ledger is telemetry, not a gate**: every write path here is wrapped so a ledger
failure is logged and swallowed — it must never block the mutation it describes. The
one deliberate exception is :func:`rollback`, which fails *closed*: if it cannot first
capture what it is about to overwrite, it refuses to proceed. A rollback that cannot
itself be undone is not a safety feature.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nanoagent.agent.tool_origin import get_current_write_origin

logger = logging.getLogger(__name__)

LEDGER_NAME = ".ledger.jsonl"
BLOB_DIR_NAME = ".blobs"

CREATE = "create"
UPDATE = "update"
DELETE = "delete"
ROLLBACK = "rollback"


def ledger_path(workspace: Path) -> Path:
    return Path(workspace) / "skills" / LEDGER_NAME


def blob_dir(workspace: Path) -> Path:
    return Path(workspace) / "skills" / BLOB_DIR_NAME


def record(
    workspace: Path,
    name: str,
    *,
    action: str,
    before: str | None,
    after: str | None,
    actor: str | None = None,
    path: str = "SKILL.md",
    now: str | None = None,
) -> str | None:
    """Append one mutation to the ledger. Returns its entry id, or ``None`` on failure.

    ``before`` / ``after`` are the file's full contents (``None`` for "did not exist").
    Both are stored as blobs; identical content across entries costs one blob.
    """
    try:
        entry = {
            "id": uuid.uuid4().hex[:12],
            "ts": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "actor": actor or get_current_write_origin(),
            "skill": name,
            "path": path,
            "action": action,
            "before": _put_blob(workspace, before),
            "after": _put_blob(workspace, after),
        }
        _append(ledger_path(workspace), entry)
        return entry["id"]
    except Exception as e:  # noqa: BLE001 — telemetry must never block the mutation
        logger.debug("could not ledger %s of skill %r: %s", action, name, e)
        return None


def read_entries(
    workspace: Path,
    *,
    name: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Ledger entries, newest last. Unparsable lines are skipped, never fatal."""
    path = ledger_path(workspace)
    out: list[dict[str, Any]] = []
    try:
        if not path.exists():
            return []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and (name is None or entry.get("skill") == name):
                out.append(entry)
    except OSError as e:
        logger.debug("could not read skill ledger: %s", e)
        return []
    return out[-limit:] if limit else out


def get_entry(workspace: Path, entry_id: str) -> dict[str, Any] | None:
    for entry in read_entries(workspace):
        if entry.get("id") == entry_id:
            return entry
    return None


def read_blob(workspace: Path, digest: str | None) -> str | None:
    """Contents behind a blob hash, or ``None`` for a missing/absent blob."""
    if not digest:
        return None
    try:
        return (blob_dir(workspace) / digest).read_text(encoding="utf-8")
    except OSError:
        return None


def rollback(workspace: Path, entry_id: str) -> tuple[bool, str]:
    """Restore a skill to the state recorded *before* ``entry_id``.

    Returns ``(ok, message)``. **Fails closed**: the current content is captured to a
    new ledger entry first, and if that capture fails nothing is written — a rollback
    you cannot yourself undo is not a safety feature.
    """
    entry = get_entry(workspace, entry_id)
    if not entry:
        return False, f"No ledger entry {entry_id!r}."

    skill = entry.get("skill")
    rel = entry.get("path", "SKILL.md")
    target = Path(workspace) / "skills" / str(skill) / str(rel)
    restore_to = read_blob(workspace, entry.get("before"))

    current = None
    try:
        if target.exists():
            current = target.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"Could not read the current {skill}/{rel}: {e}"

    # Fail closed: no safety capture, no rollback.
    safety = record(
        workspace, str(skill), action=ROLLBACK, before=current, after=restore_to, path=str(rel)
    )
    if safety is None:
        return False, "Refusing to roll back — could not record the state being replaced."

    try:
        if restore_to is None:
            target.unlink(missing_ok=True)
            return True, f"Rolled back {skill}: the skill did not exist at that point, removed."
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(restore_to, encoding="utf-8")
        return True, f"Rolled back {skill}/{rel} to its state before {entry_id} (undo: {safety})."
    except OSError as e:
        return False, f"Rollback of {skill} failed: {e}"


def _put_blob(workspace: Path, content: str | None) -> str | None:
    """Store content by sha256, returning the digest. Existing blobs are reused."""
    if content is None:
        return None
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    target = blob_dir(workspace) / digest
    if target.exists():
        return digest
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return digest


def _append(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")
