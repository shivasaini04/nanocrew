"""TodoWriteTool — in-session structured todo list.

Ported from claw-code's TodoWrite (lib.rs:529).
Pure in-memory state — no file I/O. The model self-disciplines when it sees its
own list, making this one of the highest-ROI meta-tools despite its simplicity.

That self-discipline only works if the list is a record the model cannot quietly
edit. It wasn't. See _carry_forward_dropped.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from nanoagent.agent.tools.base import Tool


class TodoWriteTool(Tool):
    """Replace the entire in-session todo list. The model reads back its own list to self-discipline."""

    _STATUS_ICON = {
        "pending": "○",
        "in_progress": "◐",
        "completed": "✓",
        "cancelled": "✗",
    }
    _PRIORITY_ORDER = ("high", "medium", "low")

    def __init__(self) -> None:
        self._todos: list[dict[str, str]] = []

    @property
    def name(self) -> str:
        return "todo_write"

    @property
    def description(self) -> str:
        return (
            "Write (fully replace) the in-session todo list. "
            "Use this at the start of multi-step tasks and update it as you make progress. "
            "Each item needs: id (str), content (str), "
            "status ('pending'|'in_progress'|'completed'|'cancelled'), "
            "priority ('high'|'medium'|'low'). "
            "Always pass the complete list — partial updates are not supported. "
            "Any pending or in_progress item you leave out is automatically restored: "
            "omitting work does not finish it. To drop a task, keep it and set its status "
            "to 'cancelled'."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "Complete replacement todo list",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id":       {"type": "string", "description": "Unique short id, e.g. '1' or 'step-auth'"},
                            "content":  {"type": "string", "description": "What needs to be done"},
                            "status":   {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]},
                            "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                        },
                        "required": ["id", "content", "status", "priority"],
                    },
                },
            },
            "required": ["todos"],
        }

    # Two contents are the same task if they're near-identical after normalising.
    # Matching on CONTENT, not id: ids are labels the model reshuffles freely, and the
    # incident below turned on a reused id. Fuzzy because harmless rewording between
    # updates ("Write crm.html" → "Write the crm.html file") must not read as a drop.
    _SAME_TASK_RATIO = 0.80

    @staticmethod
    def _norm(text: Any) -> str:
        return re.sub(r"[^a-z0-9 ]", "", str(text or "").lower()).strip()

    @classmethod
    def _same_task(cls, a: Any, b: Any) -> bool:
        na, nb = cls._norm(a), cls._norm(b)
        if not na or not nb:
            return False
        if na == nb:
            return True
        return SequenceMatcher(None, na, nb).ratio() >= cls._SAME_TASK_RATIO

    def _carry_forward_dropped(self, incoming: list[dict[str, str]]) -> list[dict[str, str]]:
        """
        Restore unfinished items that this update silently omitted.

        The list is a full replacement, so until now the model could delete its own
        unfinished work simply by not mentioning it — and then truthfully report
        "7/7 completed, 0 remaining", because the list it finished was not the list it
        started. Nothing in the transcript said otherwise; the deletion left no trace.

        Prod agent 0e6ebc15 (2026-07-17) did exactly this. It planned:
            [4] Write crm.html with inline CSS/JS, data inlined, next-send panel + kanban
            [5] Call emit_artifact on crm.html
            [6] Tell user the chat phrasing for adding a prospect
        …built the database, then rewrote the list without those three, substituting an
        invented easier item ("Save CRM summary report") that the user never asked for,
        and declared 7/7 done. crm.html — the actual deliverable — was never written, and
        the final message to the user never mentioned that it was missing.

        Note it REUSED id "4" for a different task ("Verify all data with SELECT
        queries"). An id-keyed check sees "4" present in both lists and reports nothing,
        which is why _same_task compares content instead.

        Restoring rather than rejecting, for the same reason the create_agent fix posts a
        fact instead of a rule: a warning is advice the model may decline, but an item
        back on the list is a record that contradicts "0 remaining" every time it's
        rendered. Dropping work stays possible — it just has to be *said*, by marking the
        item 'cancelled', which survives here as a visible, deliberate decision.

        A restored item that was genuinely finished (e.g. split into subtasks) costs one
        call to mark it completed. That trade is the point: an explicit claim beats a
        silent disappearance, even when the claim is the boring one.
        """
        dropped: list[dict[str, str]] = []
        for prev in self._todos:
            if prev.get("status") not in ("pending", "in_progress"):
                continue  # completed/cancelled work is settled — let it go
            if any(self._same_task(prev.get("content"), item.get("content")) for item in incoming):
                continue  # still on the list under some id
            restored = dict(prev)
            restored["status"] = "pending"
            dropped.append(restored)
        return dropped

    async def execute(self, todos: list, **kwargs: Any) -> str:
        incoming = [dict(t) for t in todos]
        restored = self._carry_forward_dropped(incoming)
        self._todos = incoming + restored
        return self._render(restored)

    def get_todos(self) -> list[dict[str, str]]:
        return list(self._todos)

    def _render(self, restored: list[dict[str, str]] | None = None) -> str:
        if not self._todos:
            return "Todo list is now empty."

        grouped: dict[str, list[dict]] = {p: [] for p in self._PRIORITY_ORDER}
        for t in self._todos:
            grouped.setdefault(t.get("priority", "medium"), []).append(t)

        lines = ["**Todo list**"]
        for prio in self._PRIORITY_ORDER:
            items = grouped.get(prio, [])
            if not items:
                continue
            lines.append(f"\n{prio.upper()}")
            for t in items:
                icon = self._STATUS_ICON.get(t.get("status", "pending"), "○")
                lines.append(f"  {icon} [{t['id']}] {t['content']}")

        pending = sum(1 for t in self._todos if t.get("status") in ("pending", "in_progress"))
        done = sum(1 for t in self._todos if t.get("status") == "completed")
        lines.append(f"\n{done}/{len(self._todos)} completed, {pending} remaining")

        if restored:
            lines.append(
                f"\n⚠️ {len(restored)} unfinished item(s) were missing from that update and have been "
                "put back on the list:"
            )
            for t in restored:
                lines.append(f"  ○ [{t['id']}] {t['content']}")
            lines.append(
                "You cannot remove unfinished work by leaving it out — omitting an item does not "
                "complete it. Either do these, or call todo_write again with status 'cancelled' and "
                "state why they are being dropped. If one is already done, mark it 'completed'."
            )
        return "\n".join(lines)
