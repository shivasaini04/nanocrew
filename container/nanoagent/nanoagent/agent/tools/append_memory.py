"""append_memory — persist a durable fact/lesson to NanoCrew's canonical memory store.

The cycle runtime can *read* memory (search_memory) but historically had no way to
*write* it, even though the per-cycle learning directive tells the agent to "record it
with append_memory". This tool closes that gap: it POSTs to the same orchestrator
endpoint the dashboard chat uses, so chat and background cycles share one memory.
"""

from __future__ import annotations

import os
from typing import Any

from nanoagent.agent.tools.base import Tool

# Mirror of the orchestrator's MemoryType union (db.ts / memory-distiller.ts).
# 'user_profile' = durable facts about the MANAGER/user → surfaced in USER.md.
_ALLOWED_TYPES = {"lesson", "pattern", "failure", "win", "icp_update", "user_profile"}


class AppendMemoryTool(Tool):
    """Write a durable fact/lesson to persistent memory (shared with chat + future cycles)."""

    @property
    def name(self) -> str:
        return "append_memory"

    @property
    def description(self) -> str:
        return (
            "Save a durable fact, lesson, or decision to your persistent memory so future "
            "cycles recall it. Use for things worth remembering long-term — a pattern that "
            "works, a verified fact, a decision made. Use type='user_profile' to remember a "
            "durable fact about your MANAGER (a preference, communication style, or standing "
            "decision) — those are kept in a dedicated USER.md and never decay. Do NOT store "
            "transient status, running totals, or unverified numbers. Visible to both the "
            "dashboard chat and background cycles."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The fact/lesson to remember — concise, specific, and durable.",
                },
                "type": {
                    "type": "string",
                    "enum": sorted(_ALLOWED_TYPES),
                    "description": "Memory category (default: lesson).",
                    "default": "lesson",
                },
            },
            "required": ["content"],
        }

    async def execute(self, content: str = "", **kwargs: Any) -> str:
        content = (content or "").strip()
        if not content:
            return "Error: 'content' is required."
        mem_type = kwargs.get("type") or "lesson"
        if mem_type not in _ALLOWED_TYPES:
            mem_type = "lesson"

        agent_id = os.environ.get("AGENT_ID")
        if not agent_id:
            return "Error: AGENT_ID not set — cannot persist memory from this cycle."
        nanocrew_host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        url = f"{nanocrew_host}/api/agents/{agent_id}/memory"
        payload = {"type": mem_type, "content": content}
        preview = content[:120] + ("…" if len(content) > 120 else "")

        import httpx
        # Generous timeouts: under heavy cycle load the single-threaded orchestrator can be
        # slow to respond. A tight timeout caused false failures (the write landed but the
        # client timed out) → the agent retried → risk of duplicates.
        timeout = httpx.Timeout(20.0, connect=10.0)

        async def _post() -> "httpx.Response":
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(url, json=payload)

        try:
            resp = await _post()
            if resp.status_code in (200, 201):
                return f"Saved to memory [{mem_type}]: {preview}"
            return f"Error: memory save failed (HTTP {resp.status_code}): {resp.text[:200]}"
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            # No connection was established → nothing was written → safe to retry once.
            try:
                resp = await _post()
                if resp.status_code in (200, 201):
                    return f"Saved to memory [{mem_type}] (after retry): {preview}"
                return f"Error: memory save failed (HTTP {resp.status_code}): {resp.text[:200]}"
            except Exception as e2:
                return (f"Error: could not reach the memory store at {nanocrew_host} ({e2 or type(e).__name__}). "
                        f"It was NOT saved — you can retry later.")
        except Exception as e:
            # Likely a read timeout AFTER the server may have committed the write.
            # Do NOT blindly retry (that would duplicate the memory).
            return (f"Note: the save to {nanocrew_host} did not return in time ({type(e).__name__}). "
                    f"The memory MAY already be recorded — verify with search_memory before retrying to avoid duplicates.")
