"""ToolResultCache — in-memory per-run cache for deterministic tool calls."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Optional

# Tools that must NEVER be cached — side-effectful, stateful, or time-sensitive
NEVER_CACHE: frozenset[str] = frozenset({
    "write_file",
    "append_file",
    "edit_file",
    "exec",
    "browser",
    "sleep",
    "gmail_send",
    "notify",
    "register_webhook",
    "emit_artifact",
    "git",
    "sql_query",
    "python_repl",
    "delegate_task",
    "delegate",
    "run_status",
    "steer_run",
    "report_result",
    "spawn",
    "message",
    "cron",
    # Found live, 2026-08-24: `effector` was never added here, so calling it twice
    # with identical args (goal/url/max_turns) — a completely normal retry
    # pattern, e.g. "try the same goal again after fixing an environment issue" —
    # silently replayed the FIRST call's cached result instead of launching a new
    # browser. Traced to a byte-identical error (same PID, same microsecond
    # timestamp) across two separate tool_call entries in cycle_steps: an
    # Xvfb-crash failure got "stuck" and replayed for the cache's 120s TTL even
    # after the underlying environment issue was already fixed. Same logic
    # applies to every Effector entry point — none of them are read-only/
    # deterministic, all of them drive a real, stateful browser session.
    "effector",
    "effector_workflow",
    "effector_swarm",
    "learn_from_recording",
})

# Per-tool TTL overrides in seconds (default used for anything not listed)
TOOL_TTL: dict[str, int] = {
    "web_search":    300,   # 5 min — search results stable within a cycle
    "web_fetch":     600,   # 10 min — fetched pages don't change mid-cycle
    "web_map":       900,   # 15 min — a site's URL list is the slowest-moving thing here,
                            # and each miss costs a Firecrawl credit
    "hn_search":     300,
    "search_memory": 60,
    "search_knowledge": 120,
    "read_image":    600,   # image content doesn't change mid-cycle
    "read_pdf":      600,
}

DEFAULT_TTL = 120  # 2 minutes


def _is_error_result(result: object) -> bool:
    """A tool result that reports a failure: an `Error…` string or a JSON object with `error`."""
    if not isinstance(result, str):
        return False
    head = result.lstrip()[:200]
    if head.startswith("Error") or head.startswith("[SKIPPED]"):
        return True
    if head.startswith("{"):
        try:
            data = json.loads(result)
        except ValueError:
            return False
        return isinstance(data, dict) and bool(data.get("error"))
    return False


class ToolResultCache:
    """
    In-memory cache keyed by (tool_name, stable_args_hash).
    Lifetime: one agent loop run — cleared after `_run_agent_loop` returns.
    """

    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}
        self.hits   = 0
        self.misses = 0

    def _key(self, tool_name: str, args: dict) -> str:
        stable = json.dumps(args, sort_keys=True, default=str)
        return hashlib.sha256(f"{tool_name}:{stable}".encode()).hexdigest()

    def get(self, tool_name: str, args: dict) -> Optional[str]:
        if tool_name in NEVER_CACHE:
            return None
        key = self._key(tool_name, args)
        entry = self._cache.get(key)
        if entry is None:
            self.misses += 1
            return None
        if time.monotonic() > entry["expires"]:
            del self._cache[key]
            self.misses += 1
            return None
        self.hits += 1
        return entry["result"]

    def set(self, tool_name: str, args: dict, result: str) -> None:
        if tool_name in NEVER_CACHE:
            return
        # Never cache a failure. Found live 2026-09-29: an agent called web_fetch without a
        # url four times; three of the four got the first call's error back from here in 0 ms,
        # and the agent concluded "the url parameter keeps getting stripped" and gave up on
        # the tool. A failure is either transient (worth a real retry) or the caller's
        # mistake (worth a fresh, specific answer) — a replay is right for neither.
        if _is_error_result(result):
            return
        ttl = TOOL_TTL.get(tool_name, DEFAULT_TTL)
        key = self._key(tool_name, args)
        self._cache[key] = {
            "result":  result,
            "expires": time.monotonic() + ttl,
        }

    def clear(self) -> None:
        self._cache.clear()
        self.hits   = 0
        self.misses = 0

    @property
    def size(self) -> int:
        return len(self._cache)
