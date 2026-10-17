"""request_batch_approval — approve a list of sends once (stage 60 phase 3).

See `effector/batch_approval.py` for why. This is the asking half: it posts the list as a
check-in, waits in the same run (like `clarify`) for the person to approve it in the chat,
and on approval records a grant the browser tools honour for the rest of the run.

The orchestrator owns the daily per-site limit. It refuses a batch that would exceed it
and says how many are left, so the agent trims the list rather than guessing.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any

import httpx
from loguru import logger

from nanoagent.agent.effector import batch_approval
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.clarify import STOPPED, stop_requested

MAX_ITEMS = 50
BATCH_TIMEOUT_S = int(os.environ.get("BATCH_APPROVAL_TIMEOUT_S", 600))
_POLL_INTERVAL_S = 3


def render(site: str, action: str, items: list[dict], note: str = "") -> str:
    """Markdown the person reads before approving. Pure, so it is testable."""
    lines = [f"## Send {len(items)} × {action} on {site}", ""]
    if note.strip():
        lines += [note.strip(), ""]
    lines += ["| # | To | Exact text |", "|---|---|---|"]
    for i, it in enumerate(items, start=1):
        to = str(it.get("to", "")).replace("|", "/").strip()
        text = str(it.get("text", "")).replace("|", "/").replace("\n", " ").strip()
        lines.append(f"| {i} | {to} | {text or '_(no text)_'} |")
    lines += ["", "_Approve to send exactly these from your own browser. Reject, with a note, to change anything._"]
    return "\n".join(lines)


class RequestBatchApprovalTool(Tool):
    @property
    def name(self) -> str:
        return "request_batch_approval"

    @property
    def description(self) -> str:
        return (
            "Before sending several things from the USER'S OWN browser (connection requests, "
            "DMs, replies, posts), show the whole list once and get it approved in the chat. "
            "Give every recipient and the EXACT text. This waits for the answer in the same "
            "run. On approval you may send exactly those, on that site, without asking again "
            "per message; anything not on the list still needs asking. If the site's daily "
            "limit would be exceeded you are told how many are left — trim the list and ask "
            "again. Use it for 2 or more sends; for a single one, just ask."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "site": {"type": "string", "description": "The site the sends happen on, e.g. 'linkedin.com'."},
                "action": {"type": "string", "description": "What each item is, e.g. 'connection request with note'."},
                "items": {
                    "type": "array",
                    "description": f"1 to {MAX_ITEMS} sends. Each: to (who, with a profile URL if you have one) and text (exact words).",
                    "items": {
                        "type": "object",
                        "properties": {"to": {"type": "string"}, "text": {"type": "string"}},
                        "required": ["to"],
                    },
                },
                "note": {"type": "string", "description": "One or two lines on why these people."},
            },
            "required": ["site", "action", "items"],
        }

    async def execute(self, site: str, action: str, items: list[dict] | None = None, note: str = "", **_: Any) -> str:
        site_key = batch_approval.site_of(site)
        items = [i for i in (items or []) if isinstance(i, dict) and str(i.get("to", "")).strip()]
        if not site_key:
            return json.dumps({"approved": False, "error": "site is required, e.g. 'linkedin.com'"})
        if not items:
            return json.dumps({"approved": False, "error": "items must list at least one recipient"})
        if len(items) > MAX_ITEMS:
            return json.dumps({"approved": False, "error": f"at most {MAX_ITEMS} items per batch — split it"})

        agent_id = os.environ.get("AGENT_ID", "")
        host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        if not agent_id:
            return json.dumps({"approved": False, "error": "AGENT_ID not set"})

        batch_id = str(uuid.uuid4())
        clean = [{"to": str(i.get("to", "")).strip(), "text": str(i.get("text", "") or "").strip()} for i in items]
        body = {
            "status": "pending",
            "report_md": render(site_key, action, clean, note),
            "action_type": "batch_send_live",
            "action_payload": json.dumps({
                "awaitUntil": int((time.time() + BATCH_TIMEOUT_S) * 1000),
                "batchId": batch_id,
                "site": site_key,
                "action": action,
                "items": clean,
            }),
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(f"{host}/api/agents/{agent_id}/checkins", json=body)
            if res.status_code == 422:
                # The daily limit. Pass the orchestrator's own words through: it knows the
                # number, the agent must not guess one.
                data = res.json()
                return json.dumps({"approved": False, "limit_reached": True, **data})
            if not res.is_success:
                return json.dumps({"approved": False, "error": f"API {res.status_code}: {res.text[:200]}"})
            checkin_id = res.json().get("id")
        except Exception as e:  # noqa: BLE001
            return json.dumps({"approved": False, "error": str(e)})

        reply = await self._await_reply(host, agent_id, checkin_id)
        if reply is STOPPED:
            return json.dumps({
                "approved": False, "stopped": True, "checkin_id": checkin_id,
                "message": "The user pressed Stop. Send nothing and end the run now.",
            })
        if reply is None:
            return json.dumps({
                "approved": False, "timed_out": True, "checkin_id": checkin_id,
                "message": f"No answer within {BATCH_TIMEOUT_S}s. Send nothing from this list; say it is waiting for approval.",
            })

        if not reply.lower().startswith("approve"):
            return json.dumps({
                "approved": False, "checkin_id": checkin_id, "reply": reply,
                "message": "Not approved. Send nothing from this list. Read the reply: if it asks for changes, make them and ask again.",
            })

        g = batch_approval.grant(site_key, batch_id, len(clean), clean)
        logger.info(f"batch approval: {len(clean)} sends granted on {site_key} (batch {batch_id[:8]})")
        return json.dumps({
            "approved": True, "checkin_id": checkin_id, "batch_id": batch_id,
            "site": g.site, "approved_count": g.approved, "reply": reply,
            "message": (
                f"Approved: send exactly these {g.approved} on {g.site} from the user's browser "
                "(identity 'me'). No further asking is needed for them."
            ),
        })

    async def _await_reply(self, host: str, agent_id: str, checkin_id: str) -> str | None:
        # The cycle-token route, not /api/agents/:id/checkins/:id: that one needs a browser
        # session, so every poll was a 401 and no answer ever arrived (stage 60 live test).
        url = f"{host}/api/agents/{agent_id}/self/checkins/{checkin_id}"
        headers = {"Authorization": f"Bearer {os.environ.get('NANOCREW_CYCLE_TOKEN', '')}"}
        waited = 0
        while waited < BATCH_TIMEOUT_S:
            await asyncio.sleep(_POLL_INTERVAL_S)
            waited += _POLL_INTERVAL_S
            if await stop_requested(host, agent_id):
                return STOPPED
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    res = await client.get(url, headers=headers)
                if not res.is_success:
                    continue
                row = res.json()
            except Exception:  # noqa: BLE001
                continue
            reply = (row.get("user_reply") or "").strip()
            if reply or row.get("status") == "responded":
                return reply
        return None
