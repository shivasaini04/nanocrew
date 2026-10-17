"""Let Python written by the model call the agent's own tools.

Stage 42 #11 — programmatic tool calling. Hermes ships this as
``tools/code_execution_tool.py``: it generates a ``hermes_tools.py`` stub and
carries every call back to the parent over a Unix socket (locally) or request
files (on a remote backend), because their script runs in a different process,
often on a different machine.

We have a much easier job. Our agent already runs *inside* the cycle container with
the tool registry in the same process, and ``python_repl`` executes on a thread of
that process — so a call only has to cross a thread boundary, not a machine. No
socket, no stub file, no polling.

Why it matters: without it a ten-step pipeline costs ten inference turns, and since
every iteration resends the whole history (see ``_last_prompt_tokens`` in
``loop.py``) those resends are the dominant cost of a long cycle. With it, the model
writes the pipeline once and the whole thing collapses into a single turn.

    # inside python_repl
    leads = json.loads(tools.read_file(path="leads.json"))
    for lead in leads:
        if tools.verify_email(email=lead["email"]).startswith("valid"):
            tools.append_file(path="verified.txt", content=lead["email"] + "\\n")

Constraints:

* **No privilege escalation.** ``python_repl`` already requires
  ``DangerFullAccess`` — the same tier as ``exec``, and for the same reason: code
  in the REPL can already shell out. Bridging the registry hands it nothing it
  could not reach by importing ``subprocess``.
* **``python_repl`` cannot call itself.** It holds a per-cycle lock for the whole
  call, so re-entering would deadlock against that lock rather than fail. Excluded
  by name.
* **Every call is bounded.** A tool that hangs would otherwise pin the REPL thread
  until the cycle timeout.
"""

from __future__ import annotations

import asyncio
from typing import Any

# python_repl holds a per-cycle lock for the duration of its call; re-entering it
# from inside its own namespace deadlocks rather than erroring, so it is blocked by
# name rather than left to fail confusingly at runtime.
BLOCKED = frozenset({"python_repl"})

# Per-call ceiling. Long enough for a real tool (a search, a fetch), short enough
# that a wedged one does not consume the cycle.
DEFAULT_CALL_TIMEOUT = 120


class ToolBridge:
    """Synchronous facade over the async tool registry, for use from a worker thread.

    Attribute access returns a callable, so ``tools.read_file(path=...)`` reads like
    an ordinary function call in the model's script.
    """

    def __init__(self, registry: Any, loop: asyncio.AbstractEventLoop,
                 timeout: int = DEFAULT_CALL_TIMEOUT) -> None:
        self._registry = registry
        self._loop = loop
        self._timeout = timeout

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in BLOCKED:
            raise AttributeError(
                f"{name!r} cannot be called from inside python_repl — it would "
                "deadlock against its own per-cycle lock."
            )
        if not self._registry.has(name):
            raise AttributeError(
                f"No tool named {name!r}. Available: {', '.join(self.names())}"
            )

        def call(**kwargs: Any) -> str:
            return self.call(name, **kwargs)

        call.__name__ = name
        return call

    def names(self) -> list[str]:
        """Every tool reachable from here."""
        return sorted(n for n in self._registry.tool_names if n not in BLOCKED)

    # `list` reads better in a script than `names`, and mirrors how the model
    # already thinks about the toolset.
    list = names

    def call(self, name: str, **kwargs: Any) -> str:
        """Run one tool and return its result as a string.

        Blocks the calling (worker) thread while the coroutine runs on the agent's
        event loop. Raises TimeoutError rather than hanging.
        """
        if name in BLOCKED:
            raise ValueError(f"{name!r} is not callable from python_repl.")
        future = asyncio.run_coroutine_threadsafe(
            self._registry.execute(name, dict(kwargs)), self._loop
        )
        try:
            return future.result(timeout=self._timeout)
        except TimeoutError:
            future.cancel()
            raise TimeoutError(
                f"Tool {name!r} did not finish within {self._timeout}s and was abandoned."
            ) from None

    def __repr__(self) -> str:  # pragma: no cover — convenience in the REPL
        return f"<tools: {len(self.names())} available>"
