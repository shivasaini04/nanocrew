"""ToolSearchTool — deferred tool schema discovery.

Ported from claw-code's ToolSearch (lib.rs:588).

With 30+ tools registered, including dynamic ones and MCP tools, advertising
every full JSON schema in the system prompt is expensive.  The pattern:
  1. System prompt lists tool NAMES only (or a short description).
  2. When the model wants to use a tool it doesn't know the schema for,
     it calls tool_search("select:ToolName") to fetch the schema on demand.
  3. Schema is injected into the next turn's context.

This keeps the static system prompt small and cache-warm while still giving
the model access to the full catalog.
"""

from __future__ import annotations

import json
from typing import Any

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


class ToolSearchTool(Tool):
    """Look up full parameter schemas for tools by name or keyword."""

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "tool_search"

    @property
    def description(self) -> str:
        base = (
            "Fetch full JSON schemas for additional tools AND activate them so you can "
            "call them. Use 'select:Name1,Name2' to load exact tools, or pass a keyword "
            "to search names/descriptions. After loading, the tools are callable on your "
            "next turn."
        )
        # In deferred mode, advertise the loadable catalog (names only — cheap) so the
        # model knows what exists without us sending every full schema.
        deferred = self._registry.deferred_names()
        if deferred:
            base += (
                "\n\nThese tools are available but NOT yet loaded — call tool_search to "
                "use any of them:\n" + ", ".join(sorted(deferred))
            )
        return base

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Tool lookup query. "
                        "Format 'select:Name1,Name2' for exact lookup, "
                        "or a keyword string for search."
                    ),
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return (default 5, max 20)",
                    "minimum": 1,
                    "maximum": 20,
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str, max_results: int = 5, **kwargs: Any) -> str:
        all_names = self._registry.tool_names
        all_tools = [self._registry.get(n) for n in all_names if self._registry.get(n)]

        if query.startswith("select:"):
            names = {n.strip() for n in query[7:].split(",")}
            matched = [t for t in all_tools if t.name in names]
            not_found = names - {t.name for t in matched}
        else:
            q = query.lower()
            matched = [
                t for t in all_tools
                if q in t.name.lower() or q in t.description.lower()
            ][:max_results]
            not_found = set()

        if not matched:
            available = ", ".join(sorted(all_names))
            return f"No tools matched '{query}'.\n\nAll available tools:\n{available}"

        # Activate the matched tools so they're advertised (callable) next turn.
        activated, _ = self._registry.activate([t.name for t in matched[:max_results]])

        parts: list[str] = []
        for t in matched[:max_results]:
            schema_str = json.dumps(t.parameters, indent=2)
            parts.append(
                f"**{t.name}**\n"
                f"{t.description}\n\n"
                f"Parameters:\n```json\n{schema_str}\n```"
            )

        result = "\n\n---\n\n".join(parts)
        if activated:
            result += f"\n\n✓ Loaded and now callable: {', '.join(activated)}"
        if not_found:
            result += f"\n\nNot found: {', '.join(sorted(not_found))}"
            result += f"\nAvailable: {', '.join(sorted(all_names))}"
        return result
