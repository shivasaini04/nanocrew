"""God-level pillar 07, 2026-08-23: per-domain lessons that
survive across separate runs, so Effector doesn't rediscover the same thing
(e.g. "City on demoqa.com is a combobox, not a plain text field") every single
time it visits a domain it's already seen.

Lives next to the checkpoint store, same durability story: under
workspace/.effector/domain-memory/<domain>.json, riding the same per-turn
shadow-git snapshot the checkpoint store already gets for free (see
resilience/checkpoint.py's own docstring) — no new persistence mechanism.

Deliberately cheap to write: every note here is derived directly from a signal
react_loop.py already computed (dropdown_open, a successful select_combobox,
the anti-loop guard firing, a verification rejection) — no extra LLM call to
"summarize a lesson." Bounded on read and write: a memory file that grows
unbounded and drowns the model in stale notes is worse than no memory at all.
"""

from __future__ import annotations

import json
from pathlib import Path

from loguru import logger

_MAX_NOTES_PER_DOMAIN = 8


def _safe_domain_filename(domain: str) -> str:
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
    return f"{safe}.json"


def _memory_path(workspace: Path, domain: str) -> Path:
    # Stage 61 phase 5: in the owner's shared site map when one is mounted.
    from nanoagent.agent.effector.site_map import site_map_base

    d = site_map_base(workspace) / "domain-memory"
    d.mkdir(parents=True, exist_ok=True)
    return d / _safe_domain_filename(domain)


def _legacy_memory_path(workspace: Path, domain: str) -> Path:
    # Where an agent's notes lived before the shared map — still read, so moving to the
    # map does not make an agent forget what it already knew about a site.
    return Path(workspace) / ".effector" / "domain-memory" / _safe_domain_filename(domain)


def load_domain_notes(workspace: Path, domain: str) -> list[str]:
    """Best-effort — a missing or corrupt memory file is not a reason to fail
    a run; it just means starting without notes, same as a domain never seen
    before."""
    try:
        path = _memory_path(workspace, domain)
        if not path.exists():
            path = _legacy_memory_path(workspace, domain)
        if not path.exists():
            return []
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [n for n in data if isinstance(n, str)][-_MAX_NOTES_PER_DOMAIN:]
    except Exception as err:
        logger.debug(f"effector domain-memory: failed to load notes for {domain} — {err}")
    return []


def append_domain_note(workspace: Path, domain: str, note: str) -> None:
    """Adds `note` if it isn't already present (exact-match dedup — the same
    lesson learned again on a later run shouldn't grow the file), then trims
    to the most recent _MAX_NOTES_PER_DOMAIN. Never raises — a failed memory
    write degrades to "this run's lesson wasn't remembered," not a broken run."""
    try:
        notes = load_domain_notes(workspace, domain)
        if note not in notes:
            notes.append(note)
        notes = notes[-_MAX_NOTES_PER_DOMAIN:]
        from nanoagent.agent.effector.site_map import write_atomic

        write_atomic(_memory_path(workspace, domain), json.dumps(notes, indent=2, ensure_ascii=False))
    except Exception as err:
        logger.debug(f"effector domain-memory: failed to save a note for {domain} — {err}")
