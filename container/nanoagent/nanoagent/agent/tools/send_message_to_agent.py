"""send_message_to_agent — send a direct message to another agent with confirmation."""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class SendMessageToAgentTool(Tool):
    """Send a direct message to another agent and get confirmation immediately."""

    @property
    def name(self) -> str:
        return "send_message_to_agent"

    @property
    def description(self) -> str:
        return (
            "Send a direct message to another agent. Returns confirmation with a message ID. "
            "Use instead of writing messages_out.json — this gives immediate feedback if the "
            "target agent doesn't exist or the message failed to deliver."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "to_agent_id": {
                    "type": "string",
                    "description": "ID of the target agent.",
                },
                "subject": {
                    "type": "string",
                    "description": "Short subject line (under 120 chars).",
                },
                "body": {
                    "type": "string",
                    "description": "Message body. Can be multi-line.",
                },
            },
            "required": ["to_agent_id", "subject", "body"],
        }

    async def execute(self, to_agent_id: str, subject: str, body: str, **kwargs: Any) -> str:
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
                f"{host}/api/agents/{agent_id}/messages/send",
                json={"toAgentId": to_agent_id, "subject": subject[:120], "body": body},
                timeout=15,
            )
            data = resp.json()
            if resp.status_code >= 400:
                return json.dumps({"error": data.get("error", f"HTTP {resp.status_code}")})
            return json.dumps({"delivered": True, "messageId": data.get("id")})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
