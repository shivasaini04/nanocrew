"""Shared memory-retrieval client (Phase 2 of the memory consolidation).

There used to be two near-identical copies of "GET NanoCrew's FTS5 /memory/search" — one in
the search_memory tool, one in MemoryStore.get_relevant_memory_context. This is the single
retrieval path both now call. It returns the ranked rows (or None when unavailable); each
caller keeps its own fallback (BM25 grep / full MEMORY.md) and formatting.
"""

from __future__ import annotations

import os
from typing import Any, Optional


async def query_memory(
    query: str,
    top_k: int = 10,
    type_filter: Optional[str] = None,
    timeout: float = 5.0,
    track: bool = False,
) -> Optional[list[dict[str, Any]]]:
    """Query the orchestrator's FTS5-ranked memory search.

    Returns a list of memory rows (dicts) on success, or None if the agent isn't reachable /
    the query is empty / anything fails — callers fall back to local search in that case.

    Set ``track=True`` for an EXPLICIT retrieval (the search_memory tool) so the matched
    memories' used_count is bumped (decay then keeps used memories longer). Passive per-turn
    injection leaves it False to avoid runaway counting.
    """
    agent_id = os.environ.get("AGENT_ID")
    if not agent_id or not (query or "").strip():
        return None
    nanocrew_host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
    params: dict[str, Any] = {"q": query[:200], "limit": int(top_k)}
    if type_filter:
        params["type"] = type_filter
    if track:
        params["track"] = 1
    try:
        import httpx
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                f"{nanocrew_host}/api/agents/{agent_id}/memory/search",
                params=params,
            )
        if resp.status_code == 200:
            rows = resp.json()
            return rows if isinstance(rows, list) else None
    except Exception:
        return None
    return None
