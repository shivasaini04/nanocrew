"""search_memory — FTS5-ranked search via NanoCrew API, with BM25 grep fallback."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool
from nanoagent.session.vector_memory import VectorMemoryStore


class SearchMemoryTool(Tool):
    """Search persistent memory using NanoCrew FTS5 (ranked), falling back to BM25 grep."""

    @property
    def name(self) -> str:
        return "search_memory"

    @property
    def description(self) -> str:
        return (
            "Search your persistent memory for past work, findings, and cycle summaries. "
            "Returns the most relevant past memories ranked by similarity to your query. "
            "Use this at the start of a cycle to recall what you did before, or mid-cycle "
            "to avoid re-doing research you have already completed."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for — keywords, phrases, or a description of what you need to recall.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default 10, max 20).",
                    "default": 10,
                },
                "type_filter": {
                    "type": "string",
                    "description": "Optional: filter by memory type (e.g. 'lesson', 'pattern', 'failure').",
                },
            },
            "required": ["query"],
        }

    async def execute(
        self, query: str, top_k: int = 10, type_filter: str | None = None, **kwargs: Any
    ) -> str:
        top_k = min(int(top_k), 20)

        # ── Primary: FTS5 ranked search via the shared retrieval client ──────
        # track=True: this is a deliberate recall by the agent → bump used_count (feeds decay).
        from nanoagent.agent.memory_client import query_memory
        rows = await query_memory(query, top_k=top_k, type_filter=type_filter, track=True)
        if rows:
            lines: list[str] = [f"Found {len(rows)} relevant memories (FTS5 ranked):\n"]
            for i, r in enumerate(rows, 1):
                lines.append(f"[{i}] [{r.get('type', '?')}] {r.get('created_at', '')[:10]}")
                content = r.get("content", "")
                lines.append(f"    {content[:300]}{'…' if len(content) > 300 else ''}")
                lines.append("")
            return "\n".join(lines).strip()

        # ── Fallback: BM25 grep over local memory files ───────────────────────
        memory_dir = Path(os.environ.get("AGENT_MEMORY_DIR", "/workspace/group/memory"))
        store = VectorMemoryStore(memory_dir)

        if store.entry_count == 0:
            return "No memories stored yet — this is your first cycle or memory has not been indexed."

        results = store.search(query, top_k=top_k)
        if not results:
            return f"No memories found matching '{query}'."

        lines = [f"Found {len(results)} relevant memories (local BM25):\n"]
        for i, entry in enumerate(results, 1):
            score = entry.get("score", 0)
            date = entry.get("date", "unknown date")
            cycle = entry.get("cycle_id", "")
            text = entry.get("text", "")
            lines.append(f"[{i}] {date} (score: {score:.2f}){' | cycle: ' + cycle[:8] if cycle else ''}")
            lines.append(f"    {text[:300]}{'…' if len(text) > 300 else ''}")
            lines.append("")

        return "\n".join(lines).strip()
