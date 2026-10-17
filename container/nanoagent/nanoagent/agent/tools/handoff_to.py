"""handoff_to — deliver work to another agent with real-time confirmation."""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class HandoffToTool(Tool):
    """Hand off data or a task to another agent and get confirmation immediately."""

    @property
    def name(self) -> str:
        return "handoff_to"

    @property
    def description(self) -> str:
        return (
            "Hand off data or a task to another agent. Returns confirmation that the "
            "handoff was received. Use instead of writing handoffs_out.json — this gives "
            "you immediate feedback if the target agent doesn't exist or the request failed.\n"
            "The recipient does NOT run immediately: it sees your message at the start of "
            "its next cycle and answers with `reply_to_handoff`. That answer reaches you "
            "the same way, in your own Messages block — so do not sit waiting inside this "
            "cycle, and do not assume the work was done because delivery succeeded.\n"
            "Set `performative='request'` (the default) when you need an answer, or "
            "'inform' when you are just passing something along and nothing is owed back. "
            "Requests you never get answered are reported to you; informs are not.\n"
            "FILES: the recipient cannot read your workspace. To send a file, put its path in "
            "`payload.file` (or a list in `payload.files`) — e.g. {\"file\": \"tracked/report.md\"}. "
            "It is copied into their inbox and the path rewritten to `inbox/<name>`. The result "
            "lists `files_delivered`; anything in `files_not_found` did NOT reach them."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "to_agent_id": {
                    "type": "string",
                    "description": "Target agent — accepts either an exact agent UUID OR exact agent name (case-insensitive). Names are NOT matched fuzzily; pass the exact name shown in the crew roster.",
                },
                "type": {
                    "type": "string",
                    "description": "Handoff type label e.g. 'task', 'review', 'data', 'approval', 'request' (or any custom string).",
                },
                "payload": {
                    "type": "object",
                    "description": (
                        "Structured data to hand off. Common shape: {summary, tasks, priority}. "
                        "Attach a file with `file` (path in your workspace, e.g. 'tracked/list.md') "
                        "or `files` (a list of paths)."
                    ),
                },
                "note": {
                    "type": "string",
                    "description": "Optional human-readable note shown to the receiving agent.",
                },
                "performative": {
                    "type": "string",
                    "enum": ["request", "inform"],
                    "description": "'request' (default) — you need an answer, and you will be shown if none comes. 'inform' — FYI, nothing owed back.",
                },
                "in_reply_to": {
                    "type": "string",
                    "description": "The message id you are following up on. Use it to continue a conversation rather than starting a new one — the recipient is then shown what was said earlier.",
                },
                "deadline_hours": {
                    "type": "number",
                    "description": "How long you are willing to wait for an answer. Default 48. When it passes you are TOLD the request expired rather than waiting forever.",
                },
            },
            "required": ["to_agent_id", "type", "payload"],
        }

    async def execute(self, to_agent_id: str, type: str, payload: dict[str, Any], note: str = "", performative: str = "request", in_reply_to: str = "", deadline_hours: float = 0, **kwargs: Any) -> str:  # noqa: A002
        try:
            import httpx
        except ImportError:
            return json.dumps({"error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")

        if not agent_id:
            return json.dumps({"error": "AGENT_ID not set"})

        try:
            resp = await httpx.AsyncClient().post(
                f"{host}/api/agents/{agent_id}/handoffs",
                json={
                    "toAgentId": to_agent_id, "type": type, "payload": payload, "note": note,
                    "performative": "inform" if str(performative).strip().lower() == "inform" else "request",
                    "cycleId": os.environ.get("CYCLE_ID") or None,
                    "inReplyTo": in_reply_to or None,
                    "deadlineHours": deadline_hours or None,
                },
                timeout=15,
            )
            data = resp.json()
            if resp.status_code >= 400:
                return json.dumps({"error": data.get("error", f"HTTP {resp.status_code}")})
            # What actually reached their inbox. A path the orchestrator could not find in
            # your workspace is listed, so "delivered" can never hide a missing file again
            # (2026-09-13: a 21-company list was handed over as a path Finder could not open).
            try:
                sent = json.loads(data.get("payload") or "{}") if isinstance(data.get("payload"), str) else (data.get("payload") or {})
            except Exception:
                sent = {}
            files_delivered = sent.get("_deliveredFiles") or []
            files_missing = sent.get("_undeliveredFiles") or []
            return json.dumps({
                "delivered": True,
                "files_delivered": [f"inbox/{f}" for f in files_delivered],
                **({"files_not_found": files_missing,
                    "files_warning": ("These paths were not found in your workspace, so the "
                                      "recipient did NOT get them. Check the path and send the "
                                      "file again in a new handoff.")} if files_missing else {}),
                "handoffId": data.get("id"),
                "status": data.get("status", "pending"),
                "note": (
                    "Delivered to their inbox — NOT yet read or acted on. They will see it on "
                    "their next cycle and can answer it. 'delivered' is not 'done'. Do not wait "
                    "for the answer inside this cycle; it will be in your Messages block on a "
                    "later one, and you are told if the deadline passes with no answer."
                ),
                "deadline": data.get("deadline_at") or data.get("deadlineAt"),
            })
        except Exception as exc:
            return json.dumps({"error": str(exc)})
