"""register_webhook — let agents register named webhook URLs on nanocrew."""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class RegisterWebhookTool(Tool):
    """Register a webhook URL that triggers this agent when called by an external service."""

    @property
    def name(self) -> str:
        return "register_webhook"

    @property
    def description(self) -> str:
        return (
            "Register a named webhook URL that will trigger this agent as a new cycle "
            "whenever it receives a POST request. Returns the full URL to share with "
            "GitHub, Zapier, Stripe, or any HTTP service. When the webhook fires, "
            "the payload is delivered to your workspace inbox and you run a custom cycle."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short label for this webhook, used in the URL path. Examples: 'github-pr', 'form-submission', 'stripe-payment'.",
                },
            },
            "required": ["name"],
        }

    async def execute(self, name: str, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token_hdr = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return json.dumps({"error": "AGENT_ID not set — webhook registration requires nanocrew context"})
        if not token_hdr:
            return json.dumps({
                "error": "No cycle token available — webhooks can only be registered from "
                         "inside a NanoCrew cycle on a current orchestrator build."
            })

        # The owner-facing /api/webhooks/{id} endpoints are session-authenticated, so this
        # tool used to 401 on every call. Use the agent-facing route instead, which mints a
        # token on first use and never rotates an existing one.
        try:
            async with httpx.AsyncClient() as client:
                info_resp = await client.get(
                    f"{host}/api/agents/{agent_id}/self/webhook",
                    headers={"Authorization": f"Bearer {token_hdr}"},
                    timeout=10,
                )
            if info_resp.status_code >= 400:
                return json.dumps({"error": f"HTTP {info_resp.status_code}", "body": info_resp.text[:200]})
            info = info_resp.json()
            token = info.get("token", "")
        except Exception as exc:
            return json.dumps({"error": f"Failed to get webhook token: {exc}"})

        if not token:
            return json.dumps({"error": "Could not obtain webhook token"})

        if not info.get("externalBaseUrlConfigured"):
            # Without WEBHOOK_BASE_URL the only URL we could build points at the
            # in-container callback host, which resolves nowhere outside Docker. Say so
            # rather than handing back a link that looks valid and silently never fires.
            return json.dumps({
                "error": "This deployment has no external webhook base URL configured "
                         "(WEBHOOK_BASE_URL). Ask the owner to set it before sharing a webhook.",
            })

        # Build the webhook URL
        base_url = info["baseUrl"]
        webhook_url = f"{base_url}/{name}?token={token}"

        return json.dumps({
            "webhook_url": webhook_url,
            "name": name,
            "agent_id": agent_id,
            "instructions": (
                f"Send POST requests to: {webhook_url}\n"
                f"GitHub: set as webhook URL with Content-Type application/json — use the token as the HMAC secret in X-Hub-Signature-256.\n"
                f"Stripe: set as webhook endpoint — use the token as the signing secret.\n"
                f"Generic: add ?token={token} as a query param.\n"
                f"When fired, the payload is written to your workspace/inbox/ and you run a custom cycle."
            ),
        }, indent=2)
