"""Stage 61 phase 5 — where site knowledge lives: shared by an owner's agents, or private.

The orchestrator mounts one directory per OWNER into every agent container of that owner
(`store/site-map/<ownerId>` → `EFFECTOR_SITE_MAP_DIR`). What one agent learns about a site
— compiled reads, per-site notes — is then there for its siblings: the second agent to
ask a question a first agent already answered skips the browser.

Never across owners (founder decision 2026-09-19): the mount is per owner, so an agent
cannot see another account's map. Without the mount (tests, a dev run, an older
orchestrator) everything stays in the agent's own `workspace/.effector`, exactly as
before.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def site_map_base(workspace: Path) -> Path:
    shared = os.environ.get("EFFECTOR_SITE_MAP_DIR", "").strip()
    if shared:
        p = Path(shared)
        if p.is_dir() and os.access(p, os.W_OK):
            return p
    return Path(workspace) / ".effector"


def write_atomic(path: Path, text: str) -> None:
    """Replace `path` in one step. Several agents of one owner can write the same
    site's file; a reader must see the old version or the new one, never half of one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
