"""search_crew_memory — FTS5 search across all agents on the current project crew."""

from __future__ import annotations

import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class SearchCrewMemoryTool(Tool):
    """Search the combined memory of every agent assigned to your project."""

    @property
    def name(self) -> str:
        return "search_crew_memory"

    @property
    def description(self) -> str:
        return (
            "Search the memory of all agents on your project crew. "
            "Useful for finding what other agents have already learned about a topic, "
            "avoiding duplicate research, and building on teammates' work."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for across all crew agents' memories.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results to return (default 10, max 50).",
                    "default": 10,
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str, limit: int = 10, **kwargs: Any) -> str:
        limit = min(int(limit), 50)
        project_id = os.environ.get("PROJECT_ID")
        nanocrew_host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")

        if not project_id:
            return "Error: not running in a project context (PROJECT_ID not set)"

        try:
            import httpx
            resp = await httpx.AsyncClient().get(
                f"{nanocrew_host}/api/projects/{project_id}/memory/search",
                params={"q": query, "limit": limit},
                timeout=5.0,
            )
            if resp.status_code != 200:
                return f"Error: NanyClaw returned {resp.status_code}"
            rows = resp.json()
        except Exception as exc:
            return f"Error contacting NanyClaw: {exc}"

        if not rows:
            return f"No crew memory found for: {query}"

        lines: list[str] = [f"Crew memory search — {len(rows)} results:\n"]
        for r in rows:
            emoji = r.get("agent_emoji", "🤖")
            name = r.get("agent_name", "unknown")
            mtype = r.get("type", "?")
            content = r.get("content", "")
            lines.append(f"{emoji} {name} [{mtype}]: {content[:300]}{'…' if len(content) > 300 else ''}")
        return "\n".join(lines)
