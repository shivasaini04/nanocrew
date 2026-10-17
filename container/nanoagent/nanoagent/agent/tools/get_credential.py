"""get_credential — fetch a service credential on-demand from nanocrew vault."""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class GetCredentialTool(Tool):
    """Fetch a stored credential for a service on-demand from the nanocrew vault."""

    @property
    def name(self) -> str:
        return "get_credential"

    @property
    def description(self) -> str:
        return (
            "Check which credential fields are stored for a service (API key, token, etc.) "
            "in the nanocrew vault. Values are never shown to you — the tools that need "
            "them get them directly. Use this to confirm a service is connected before "
            "calling a tool that depends on it."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "service": {
                    "type": "string",
                    "description": "Service name e.g. 'apollo', 'gmail', 'database', 'twitter', 'linkedin'.",
                },
            },
            "required": ["service"],
        }

    async def execute(self, service: str, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"error": "httpx not installed"})

        agent_id  = os.environ.get("AGENT_ID", "")
        cycle_id  = os.environ.get("CYCLE_ID", "")
        host      = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token     = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return json.dumps({"error": "AGENT_ID not set"})
        if not token:
            # The vault route requires the per-cycle token; without it the request is
            # refused. Say so here rather than surfacing a bare 401 the model would
            # likely retry.
            return json.dumps({
                "error": "No cycle token available — credentials can only be fetched from "
                         "inside a NanoCrew cycle on a current orchestrator build."
            })

        try:
            resp = await httpx.AsyncClient().get(
                f"{host}/api/agents/{agent_id}/credentials/{service}",
                headers={"Authorization": f"Bearer {token}", "X-Cycle-Id": cycle_id},
                timeout=10,
            )
            if resp.status_code == 404:
                return json.dumps({"error": f"No credential stored for service '{service}'"})
            if resp.status_code >= 400:
                return json.dumps({"error": f"HTTP {resp.status_code}"})
            data = resp.json()
            # Stage 64 phase 2: the model never holds a secret. This used to return the raw
            # fields as the tool result, which put the key in the model's context (and in
            # cycle_steps). The route still serves real values to code that fills them in
            # without the model seeing them (effector credential_ref).
            fields = data if isinstance(data, dict) else {}
            return json.dumps({
                "service": service,
                "connected": bool(fields),
                "fields": {k: ("stored (hidden)" if v else "empty") for k, v in fields.items()},
                "note": "Values are not shown to agents. Tools that need this credential receive it directly.",
            })
        except Exception as exc:
            return json.dumps({"error": str(exc)})
