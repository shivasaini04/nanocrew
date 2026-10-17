"""find_agent — who on your crew can help with this.

Stage 56 phase 2. Before this, an agent's entire knowledge of its colleagues was the crew
roster injected at cycle start: name, type, and a goal string cut to 100 characters. Enough
to address a message and nothing else. It could not ask "who here can verify an email
address?", so routing was whatever its own prompt happened to name — which is why the live
network was exactly the three-node chain its three prompts describe.

The ranking is built on what agents have actually DONE, not what they are permitted to do.
A granted tool nobody has ever called is not evidence of capability, and both figures come
back so the caller can see the difference rather than trust a score.

A miss is recorded as a capability gap. That is the most valuable output here: an agent
saying, unprompted, that the crew wanted something it does not have.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import quote

from nanoagent.agent.tools.base import Tool


class FindAgentTool(Tool):
    """Find which teammate can help with a capability you do not have."""

    @property
    def name(self) -> str:
        return "find_agent"

    @property
    def description(self) -> str:
        return (
            "Find which of your teammates can do something you cannot. Ask in your own "
            "words — 'verify an email address', 'read a PDF', 'search LinkedIn' — not by "
            "tool name and not by agent name.\n"
            "Use it BEFORE concluding that something is impossible, and before guessing "
            "which teammate to hand work to. Your crew roster gives you names and one-line "
            "goals; this tells you who actually holds the capability, whether they have "
            "ever used it, whether they are awake, and whether they answer when asked.\n"
            "If it finds nobody, that is recorded as a capability gap for your owner and "
            "you do NOT need to raise it again — but do not invent a teammate or assume one "
            "exists.\n"
            "Once you know who holds a tool you need, you usually want `borrow_tool` "
            "(use it yourself, now) rather than `handoff_to` (ask them, get an answer on "
            "their next cycle)."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "capability": {
                    "type": "string",
                    "description": "What you need done, in plain words. E.g. 'verify an email address', 'scrape a job board', 'send an email'.",
                },
                "context": {
                    "type": "string",
                    "description": "Optional: what you are trying to achieve. Stored with the gap if nobody matches, so your owner can see why it was wanted.",
                },
            },
            "required": ["capability"],
        }

    async def execute(self, capability: str = "", context: str = "", **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return "find_agent unavailable: httpx is not installed."

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return "find_agent needs NanoCrew context: AGENT_ID is not set."
        if not token:
            return (
                "find_agent needs a per-cycle token, which only a NanoCrew cycle provides. "
                "Outside one you cannot see your crew — say so rather than guessing who exists."
            )

        want = str(capability or "").strip()
        if not want:
            return "Say what you need, in your own words — e.g. capability='verify an email address'."

        params = f"?q={quote(want, safe='')}"
        if context:
            params += f"&context={quote(str(context)[:500], safe='')}"

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{host}/api/agents/{agent_id}/self/find-agent{params}",
                    headers={"Authorization": f"Bearer {token}"}, timeout=20,
                )
        except Exception as exc:
            return f"Could not reach the orchestrator to search your crew: {exc}"

        if resp.status_code >= 400:
            try:
                return f"find_agent failed (HTTP {resp.status_code}): {resp.json().get('error', resp.text[:300])}"
            except Exception:
                return f"find_agent failed (HTTP {resp.status_code}): {resp.text[:300]}"

        try:
            body = resp.json()
        except Exception:
            return f"find_agent returned an unreadable body: {resp.text[:300]}"

        # The rendered text is the product. The structured matches are deliberately not
        # returned: handing a model raw fields to interpret is how a zero-usage tool gets
        # reported as a working capability.
        return str(body.get("report", json.dumps(body)))
