"""session_search — search the agent's OWN past session transcripts.

nanoagent stores each session as a JSONL file in workspace/sessions/ (a metadata line
followed by message lines). This tool searches those raw transcripts so the agent can
recall earlier discussions/decisions that may not have made it into distilled memory.

Two modes:
  • query given  → search message content across sessions, return matching snippets.
  • no query     → browse: list recent sessions with their first user message as a title.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


def _text_of(content: Any) -> str:
    """Flatten a message's content (str or multimodal list) to searchable text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
            else:
                parts.append(str(p))
        return " ".join(parts)
    return str(content or "")


class SessionSearchTool(Tool):
    """Search the agent's past conversation/work sessions (full transcripts)."""

    def __init__(self, sessions_dir: Path) -> None:
        # The exact dir the SessionManager writes to (state_dir/sessions) — this differs
        # from the file-tool workspace in project mode, so we take it explicitly.
        self._sessions_dir = Path(sessions_dir)

    @property
    def name(self) -> str:
        return "session_search"

    @property
    def description(self) -> str:
        return (
            "Search your OWN past conversation/work sessions (full transcripts) for what was "
            "said or done before. Pass `query` to find messages matching keywords; omit it to "
            "list your recent sessions. Use this to recall earlier discussions, decisions, or "
            "context that distilled memory may not capture."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords to find in past transcripts. Omit to list recent sessions."},
                "limit": {"type": "integer", "description": "Max results (default 8, max 20).", "default": 8},
            },
            "required": [],
        }

    def _iter_session_files(self) -> list[Path]:
        if not self._sessions_dir.exists():
            return []
        return sorted(self._sessions_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)

    async def execute(self, query: str = "", limit: int = 8, **kwargs: Any) -> str:
        limit = max(1, min(int(limit or 8), 20))
        files = self._iter_session_files()
        if not files:
            return "No past sessions found yet."

        ql = (query or "").strip().lower()

        # ── Browse mode ──────────────────────────────────────────────────────
        if not ql:
            lines = ["Recent sessions:", ""]
            for f in files[:limit]:
                title, updated = "", ""
                try:
                    for raw in f.read_text(encoding="utf-8").splitlines():
                        if not raw.strip():
                            continue
                        obj = json.loads(raw)
                        if obj.get("_type") == "metadata":
                            updated = str(obj.get("updated_at", ""))[:19]
                            continue
                        if obj.get("role") == "user" and not title:
                            title = _text_of(obj.get("content"))[:80]
                except Exception:
                    continue
                lines.append(f"• [{f.stem}] {updated}  {title}".rstrip())
            return "\n".join(lines)

        # ── Discovery mode ───────────────────────────────────────────────────
        hits: list[str] = []
        for f in files:
            try:
                raws = f.read_text(encoding="utf-8").splitlines()
            except Exception:
                continue
            for raw in raws:
                if not raw.strip():
                    continue
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("_type") == "metadata":
                    continue
                txt = _text_of(m.get("content"))
                idx = txt.lower().find(ql)
                if idx == -1:
                    continue
                start = max(0, idx - 80)
                snippet = txt[start:idx + len(ql) + 120].replace("\n", " ").strip()
                hits.append(f"• [{f.stem}] ({m.get('role', '?')}) …{snippet}…")
                if len(hits) >= limit:
                    break
            if len(hits) >= limit:
                break

        if not hits:
            return f"No past session messages matched '{query}'."
        return f"Found {len(hits)} match(es) for '{query}':\n\n" + "\n".join(hits)
