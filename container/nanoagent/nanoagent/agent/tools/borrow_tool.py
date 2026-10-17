"""borrow_tool — use a teammate's tool yourself, now, without waking them.

Stage 56 phase 3, and the cheap answer to the case that motivated this whole stage: *"if a
problem needs a tool one agent has and another does not, that agent can call it, wait for
the response, and once confirmed continue its job."*

Most of the time what is wanted is a TOOL RESULT, not a colleague's judgement. Waking
Mailer to verify one email costs a container, a model call, a cycle of context, and a wait
measured in hours. Running `verify_email` inside your own cycle costs one HTTP request and
returns before the turn ends. It is genuinely synchronous, which nothing else in this stage
is — a handoff is answered on the recipient's next cycle, whenever that is.

What the orchestrator authorises, and this tool then applies locally:

  1. the tool is restored into this cycle's registry (enforcement withheld it, it was never
     deleted — see ToolRegistry.withdraw)
  2. exactly the credentials that tool needs are set in the environment, and nothing else

Both are undone when the container exits, because both live only in this process. There is
no lasting grant: a borrow cannot quietly become a permanent escalation.
"""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class BorrowToolTool(Tool):
    """Borrow a teammate's tool for this cycle instead of handing them the work."""

    def __init__(self, registry: Any = None) -> None:
        # The live registry, so a granted borrow can put the tool back in front of the
        # model on this very turn. Without it the borrow would succeed on the server and
        # do nothing observable here, which reads to a model as a broken tool.
        self._registry = registry

    @property
    def name(self) -> str:
        return "borrow_tool"

    @property
    def description(self) -> str:
        return (
            "Use a tool one of your teammates has and you do not — right now, in this "
            "cycle, without waking them. After it succeeds, CALL THE TOOL NORMALLY: it "
            "will be available to you for the rest of this cycle.\n"
            "Prefer this over handing the work off whenever what you need is a tool RESULT "
            "rather than a colleague's judgement. A handoff is answered on their next "
            "cycle, which may be hours away or never; a borrow returns before your turn "
            "ends.\n"
            "Use `find_agent` first if you do not know who holds it. Same owner only, one "
            "cycle only, and both you and the lender get an audit row — so give a real "
            "`reason`.\n"
            "The lender is NOT told the result. If what you learn matters to them, send it "
            "with `handoff_to` afterwards."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "description": "Exact tool name you want to use, e.g. 'verify_email'. Use find_agent first if you only know the capability.",
                },
                "from_agent": {
                    "type": "string",
                    "description": "Optional teammate name to borrow from. Omit and the best qualified holder is chosen for you.",
                },
                "reason": {
                    "type": "string",
                    "description": "Why you need it — one line. Required: it is what the audit row on both sides says.",
                },
            },
            "required": ["tool", "reason"],
        }

    async def execute(self, tool: str = "", from_agent: str = "", reason: str = "", **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return "borrow_tool unavailable: httpx is not installed."

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return "borrow_tool needs NanoCrew context: AGENT_ID is not set."
        if not token:
            return (
                "borrow_tool needs a per-cycle token, which only a NanoCrew cycle provides. "
                "Outside one you cannot borrow anything — say so rather than assuming the tool is available."
            )

        want = str(tool or "").strip()
        if not want:
            return "Name the tool you want, e.g. tool='verify_email'. Use find_agent if you only know the capability."

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{host}/api/agents/{agent_id}/self/borrow",
                    json={"tool": want, "from": from_agent or None, "reason": reason},
                    headers={"Authorization": f"Bearer {token}"}, timeout=20,
                )
        except Exception as exc:
            return f"Could not reach the orchestrator to borrow that tool: {exc}"

        if resp.status_code >= 400:
            # Pass the orchestrator's refusal through whole. Each one names the next move —
            # who does hold it, or that you already have it — and a model given "that
            # failed" invents a new wrong shape instead of reading the answer.
            try:
                body = resp.json()
                detail = body.get("error", resp.text[:400])
                if body.get("holders"):
                    detail += f"\nAgents that DO hold it: {', '.join(body['holders'])}"
                return f"borrow_tool refused (HTTP {resp.status_code}): {detail}"
            except Exception:
                return f"borrow_tool refused (HTTP {resp.status_code}): {resp.text[:400]}"

        try:
            body = resp.json()
        except Exception:
            return f"borrow_tool returned an unreadable body: {resp.text[:300]}"

        # Credentials for this process only. They vanish with the container, which is what
        # makes "one cycle" true rather than merely stated.
        env = body.get("env") or {}
        for key, value in env.items():
            if isinstance(key, str) and isinstance(value, str):
                os.environ[key] = value

        restored = False
        if self._registry is not None:
            try:
                restored = bool(self._registry.restore(want))
            except Exception:
                restored = False

        if not restored and self._registry is not None and not self._registry.has(want):
            # Authorised but not present: the tool is not in this build at all. Say exactly
            # that — a model told only "ok" will call a tool that does not exist and then
            # conclude the capability is broken.
            return json.dumps({
                "borrowed": False,
                "tool": want,
                "error": (
                    f"The orchestrator authorised borrowing `{want}` from "
                    f"{body.get('holder', {}).get('name', 'a teammate')}, but that tool is not present "
                    f"in this agent runtime, so it cannot be called here. Hand the work to them with "
                    f"handoff_to instead, or reply `cannot` naming this tool."
                ),
            }, indent=2)

        return json.dumps({
            "borrowed": True,
            "tool": want,
            "from": body.get("holder", {}).get("name"),
            "credentials": body.get("credentialNote"),
            "next": f"Call `{want}` now, normally, with its own parameters. {body.get('note', '')}",
        }, indent=2)
