"""notify — send an urgent mid-cycle notification to the user via nanocrew."""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool

_RATE_LIMIT = 5  # max notifications per cycle
_sent_this_cycle: dict[str, int] = {}  # cycle_id → count


class NotifyTool(Tool):
    """Send an urgent notification to the user without waiting for the cycle to finish."""

    @property
    def name(self) -> str:
        return "notify"

    @property
    def description(self) -> str:
        return (
            "Send an urgent notification to the user right now, without waiting for "
            "the cycle to end. Use ONLY for time-sensitive alerts: price thresholds "
            "crossed, server down, critical errors, security events. "
            "Do NOT use for normal status updates — those belong in the cycle summary. "
            f"Max {_RATE_LIMIT} notifications per cycle."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The notification message. Keep it short and actionable (under 500 chars).",
                },
                "urgency": {
                    "type": "string",
                    "enum": ["normal", "high", "critical"],
                    "description": "Urgency level. 'critical' shows as a red alert. Default: normal.",
                },
            },
            "required": ["message"],
        }

    async def execute(self, message: str, urgency: str = "normal", **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"sent": False, "error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        cycle_id = os.environ.get("CYCLE_ID", "default")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")

        if not agent_id:
            return json.dumps({"sent": False, "error": "AGENT_ID not set — notify requires nanocrew context"})

        # Enforce per-cycle rate limit
        count = _sent_this_cycle.get(cycle_id, 0)
        if count >= _RATE_LIMIT:
            return json.dumps({"sent": False, "reason": "rate_limit", "limit": _RATE_LIMIT})

        message = message[:500]

        try:
            resp = await httpx.AsyncClient().post(
                f"{host}/api/agents/{agent_id}/notify",
                json={"message": message, "urgency": urgency, "cycleId": cycle_id},
                timeout=10,
            )
            data = resp.json()
            _sent_this_cycle[cycle_id] = count + 1
            return json.dumps({"sent": True, "channel": data.get("channel", "dashboard"), "urgency": urgency})
        except Exception as exc:
            return json.dumps({"sent": False, "error": str(exc)})
