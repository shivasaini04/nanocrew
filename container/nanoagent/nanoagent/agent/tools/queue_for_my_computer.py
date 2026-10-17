"""queue_for_my_computer — hand the local part of a job to when the user's computer is back.

Stage 60 phase 6. A run in the cloud reaches a step that only the user's own machine can
do (their signed-in browser, their files, their terminal) while it is not connected. It
queues exactly that step here, finishes everything else it can, and says what is waiting.
The orchestrator starts the queued step as a new run on "This computer" the moment their
NanoCrew desktop app connects.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool


class QueueForMyComputerTool(Tool):
    @property
    def name(self) -> str:
        return "queue_for_my_computer"

    @property
    def description(self) -> str:
        return (
            "When part of the job can ONLY be done on the user's own computer — sending from "
            "their signed-in LinkedIn, saving into their Documents, running something installed "
            "on their machine — and their computer is not connected, queue that part here. It "
            "runs as a new run on their computer the moment the NanoCrew desktop app connects "
            "(within 24 hours). Write `task` so it stands alone: exactly what to do, with every "
            "name, file path and text it needs, because the later run will not see this "
            "conversation. Then finish everything that does not need their computer."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The self-contained instruction for the later run."},
                "reason": {"type": "string", "description": "Why it must wait for their computer."},
            },
            "required": ["task"],
        }

    async def execute(self, task: str, reason: str | None = None, **_: Any) -> str:
        agent_id = os.environ.get("AGENT_ID", "")
        token = os.environ.get("NANOCREW_CYCLE_TOKEN", "")
        host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        if not agent_id or not token:
            return json.dumps({"queued": False, "error": "not inside a NanoCrew run (no agent id or cycle token)"})
        if not (task or "").strip():
            return json.dumps({"queued": False, "error": "task is required"})
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.post(
                    f"{host}/api/agents/{agent_id}/self/local-followups",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"task": task, "reason": reason},
                )
            body = res.json() if res.content else {}
            if res.status_code >= 400:
                return json.dumps({"queued": False, "error": body.get("error") or f"HTTP {res.status_code}"})
            return json.dumps(body)
        except Exception as err:  # noqa: BLE001
            return json.dumps({"queued": False, "error": str(err)})
