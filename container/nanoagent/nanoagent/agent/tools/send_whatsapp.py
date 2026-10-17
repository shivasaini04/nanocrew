"""send_whatsapp — send a WhatsApp message to the chat this agent is bound to.

Not to be confused with the `message` tool, which publishes to an in-process MessageBus
that nothing consumes on the NanoCrew path — messages sent that way are silently
discarded when the cycle ends. This one goes through the orchestrator to a real channel.

There is deliberately no destination parameter. The message goes to the WhatsApp chat the
owner linked to this agent in the dashboard, and nowhere else: a tool that accepts an
arbitrary JID is a tool that can message arbitrary phone numbers.
"""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool

_RATE_LIMIT = 10  # max sends per cycle
_sent_this_cycle: dict[str, int] = {}  # cycle_id → count


class SendWhatsAppTool(Tool):
    """Send a WhatsApp message to the owner's linked chat."""

    @property
    def name(self) -> str:
        return "send_whatsapp"

    @property
    def description(self) -> str:
        return (
            "Send a WhatsApp message to the chat your owner linked to you. Use this when you "
            "have something the owner should see on their phone: a finished result, a question "
            "that blocks you, a scheduled reminder you were asked to send. "
            "The message is delivered immediately and cannot be recalled — so send one clear "
            "message rather than several fragments. "
            f"Max {_RATE_LIMIT} per cycle. To send at a specific future time, use "
            "self_manage(action='run_once') to wake yourself then, and send it in that cycle."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": (
                        "The message text. Write it as the owner will read it on a phone: short, "
                        "plain, no markdown headers. Max 4000 characters."
                    ),
                },
            },
            "required": ["message"],
        }

    async def execute(self, message: str, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"sent": False, "error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        cycle_id = os.environ.get("CYCLE_ID", "default")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return json.dumps({"sent": False, "error": "AGENT_ID not set — send_whatsapp requires nanocrew context"})
        if not token:
            return json.dumps({"sent": False, "error": "No cycle token available — cannot authenticate the send."})
        if not message or not message.strip():
            return json.dumps({"sent": False, "error": "message is empty"})

        count = _sent_this_cycle.get(cycle_id, 0)
        if count >= _RATE_LIMIT:
            return json.dumps({"sent": False, "reason": "rate_limit", "limit": _RATE_LIMIT})

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{host}/api/agents/{agent_id}/self/whatsapp",
                    json={"message": message[:4000]},
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=20,
                )
        except Exception as exc:
            return json.dumps({"sent": False, "error": f"Could not reach the orchestrator: {exc}"})

        try:
            data = resp.json()
        except Exception:
            return json.dumps({"sent": False, "error": f"HTTP {resp.status_code}", "body": resp.text[:300]})

        if resp.status_code >= 400:
            # 409 = no chat linked, 503 = channel down. Both are the owner's to fix, so say
            # so plainly instead of letting the agent retry a send that cannot succeed.
            return json.dumps({"sent": False, "status": resp.status_code, **data})

        _sent_this_cycle[cycle_id] = count + 1
        return json.dumps(data)
