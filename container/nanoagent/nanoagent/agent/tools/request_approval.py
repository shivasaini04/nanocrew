"""request_approval — pause the cycle and surface a draft for human review.

The draft appears in the Check-in Inbox with Approve / Edit / Reject buttons.
On Approve the action fires automatically (e.g. email sends). On Reject nothing happens.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool


class RequestApprovalTool(Tool):
    """Surface an agent-produced draft for human approval before firing a real-world action."""

    @property
    def name(self) -> str:
        return "request_approval"

    @property
    def description(self) -> str:
        return (
            "Submit a draft for human review before taking an irreversible action "
            "(sending an email, publishing a post, etc.). "
            "The draft appears in the dashboard Check-in Inbox with Approve / Edit / Reject buttons. "
            "On Approve the action fires automatically. "
            "Call this at the END of your work, after writing the draft. "
            "The cycle ends here — you have done your job."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "report_md": {
                    "type": "string",
                    "description": (
                        "Markdown summary of what you did and what you are asking to approve. "
                        "Include the full draft content so the human can read it inline. "
                        "Format: ## Draft: <title>\\n\\n**To:** ...\\n**Subject:** ...\\n\\n**Body:**\\n..."
                    ),
                },
                "action_type": {
                    "type": "string",
                    "enum": ["send_email", "create_agent", "none"],
                    "description": (
                        "'send_email' — on Approve, the email in action_payload is sent automatically. "
                        "'create_agent' — on Approve, a new agent is created from the spec in action_payload. "
                        "'none' — plain checkin, no automatic action on Approve. "
                        "An interactive HTML page does NOT go through approval: write the file and "
                        "register it with emit_artifact (type 'page')."
                    ),
                },
                "action_payload": {
                    "type": "object",
                    "description": (
                        "The data needed to execute the action. "
                        "For send_email: { to, subject, body, lead_key, business, thread_id? }. "
                        "`lead_key` and `business` identify which lead this email is for — they are "
                        "recorded with the send so that a reply arriving weeks later can be matched "
                        "back to the lead it answers. Without them the reply is still captured but "
                        "cannot be joined to the lead's score, source or role, which is the whole "
                        "point of recording it. Use the tracker's item key (the lead's `handle`) as "
                        "`lead_key`. "
                        "For create_agent: { name, emoji, mission, tools (list of tool names), "
                        "trigger_mode ('scheduled'|'on_demand'), schedule_interval (e.g. '24h'), system_prompt? }."
                    ),
                    "additionalProperties": True,
                },
            },
            "required": ["report_md", "action_type"],
        }

    async def execute(
        self,
        report_md: str,
        action_type: str,
        action_payload: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str:
        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")

        if not agent_id:
            return json.dumps({"queued": False, "error": "AGENT_ID not set"})

        # An outreach email whose payload does not name its lead is a reply we will never be
        # able to attribute. On 2026-08-13 the first lead under the new ICP went out with
        # lead_key null — not because the agent erred, but because this tool's own schema
        # listed the payload as { to, subject, body } and the agent complied exactly. Asking
        # for the field in prose is what already failed, so refuse instead: the send is one
        # retry away, whereas the attribution cannot be reconstructed after the fact.
        if action_type == "send_email":
            missing = [k for k in ("lead_key", "business") if not (action_payload or {}).get(k)]
            if missing:
                return json.dumps({
                    "queued": False,
                    "error": f"action_payload for send_email is missing: {', '.join(missing)}",
                    "fix": (
                        "Re-call request_approval with these keys in action_payload. "
                        "`lead_key` is the lead's tracker handle (e.g. the `handle` field of the "
                        "row in tracked/Leads.json); `business` is its company name. They are "
                        "recorded with the send so a later reply can be matched back to this lead."
                    ),
                })

        payload: dict[str, Any] = {
            "status":     "pending",
            "report_md":  report_md,
            "action_type": action_type if action_type != "none" else None,
        }
        if action_payload and action_type != "none":
            payload["action_payload"] = json.dumps(action_payload)

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{host}/api/agents/{agent_id}/checkins",
                    json=payload,
                )
            if res.is_success:
                data = res.json()
                if data.get("autoApproved"):
                    return json.dumps({
                        "queued": False,
                        "approved": True,
                        "executed": bool(data.get("executed")),
                        "checkin_id": data.get("id"),
                        "rule": data.get("rule"),
                        "message": data.get("actionResult"),
                    })
                return json.dumps({
                    "queued": True,
                    "checkin_id": data.get("id"),
                    "message": "Draft is pending human approval in the Check-in Inbox.",
                })
            else:
                return json.dumps({"queued": False, "error": f"API {res.status_code}: {res.text[:200]}"})
        except Exception as e:
            return json.dumps({"queued": False, "error": str(e)})
