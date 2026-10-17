"""python_repl — stateful in-process Python REPL for data analysis and computation."""

from __future__ import annotations

import asyncio
import code
import os
import sys
import threading
import traceback
from typing import Any

from nanoagent.agent.tool_bridge import ToolBridge
from nanoagent.agent.tools.base import Tool

# python_repl can run subprocess/os calls same as `exec` (import subprocess; ...),
# so it must not be a lower-tier bypass of the `exec` tool's DangerFullAccess gate.
# See docs/research/stage17/03-code-repl.md: "No new security surface beyond
# what `exec` already allows" — the required tier was always meant to match.
DEFAULT_TIMEOUT_SECONDS = 120

# Per-cycle kernel store: CYCLE_ID → local namespace dict
# Destroyed when the process exits (i.e. between cycles — each cycle is a fresh container)
_kernels: dict[str, dict[str, Any]] = {}

# Per-cycle lock, held by the *worker thread* for the full lifetime of an
# execute() call — including past a client-side timeout (Python threads can't
# be force-killed, so a timed-out call keeps running in the background until
# it naturally finishes). Without this, a second call for the same cycle_id
# could start while the first is still running and both would mutate the
# shared per-cycle namespace `ns` (including the temporary print-capture
# shim installed below) concurrently.
_locks: dict[str, threading.Lock] = {}


def _get_namespace(cycle_id: str) -> dict[str, Any]:
    """Return (or create) the persistent namespace for this cycle."""
    if cycle_id not in _kernels:
        # Pre-populate with common imports so agents don't have to repeat them
        ns: dict[str, Any] = {"__builtins__": __builtins__}
        # Attempt to pre-import popular libs silently — agent can also import manually
        for mod_name, alias in [("os", "os"), ("sys", "sys"), ("json", "json"),
                                  ("math", "math"), ("re", "re"), ("datetime", "datetime")]:
            try:
                ns[alias] = __import__(mod_name)
            except ImportError:
                pass
        _kernels[cycle_id] = ns
    return _kernels[cycle_id]


def _get_lock(cycle_id: str) -> threading.Lock:
    if cycle_id not in _locks:
        _locks[cycle_id] = threading.Lock()
    return _locks[cycle_id]


class PythonReplTool(Tool):
    """Execute Python in a stateful REPL — variables persist across calls within a cycle."""

    def __init__(self, timeout: int = DEFAULT_TIMEOUT_SECONDS, registry: Any = None):
        self.timeout = timeout
        # Stage 42 #11 — the tool registry, so scripts can call the agent's own
        # tools via `tools.<name>(...)`. Optional: without it the REPL behaves
        # exactly as before.
        self._registry = registry

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def name(self) -> str:
        return "python_repl"

    @property
    def description(self) -> str:
        return (
            "Execute Python code in a stateful REPL. Variables, imports, and data "
            "persist across multiple calls within this cycle — load data once, query "
            "it many times. Use for data analysis, computation, visualisation, and "
            "any multi-step Python work. Always save output files to "
            "/workspace/group/workspace/ so they persist after the cycle. "
            "Save output files there — not packages: if an import is missing, declare it "
            "in a tool manifest (generate_tool's pythonPackages) so it installs to the "
            "managed package volume, rather than pip-installing into the workspace."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "Python code to execute. Can be multi-line. "
                        "Use print() to see values. The last expression's repr "
                        "is returned automatically if it is not None."
                    ),
                },
            },
            "required": ["code"],
        }

    async def execute(self, code: str, **kwargs: Any) -> str:  # noqa: A002
        cycle_id = os.environ.get("CYCLE_ID", "default")
        ns = _get_namespace(cycle_id)
        lock = _get_lock(cycle_id)

        if not lock.acquire(blocking=False):
            # A previous call for this cycle timed out and is still running
            # in the background (can't be force-killed) — refuse instead of
            # racing it for the process-global sys.stdout/sys.stderr redirect.
            return (
                "Error: a previous python_repl call in this cycle is still "
                "running in the background after timing out and has not "
                "released the REPL. Wait, or avoid python_repl for the rest "
                "of this cycle and use the exec tool instead."
            )

        loop = asyncio.get_event_loop()
        # Rebuilt per call: the bridge binds to the loop that is actually running
        # now, and a registry gains tools mid-cycle (dynamic tools, MCP).
        if self._registry is not None:
            ns["tools"] = ToolBridge(self._registry, loop)
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, self._run_blocking, code, ns, lock),
                timeout=self.timeout,
            )
        except asyncio.TimeoutError:
            # exec()'d code can't be forcibly killed from here (no thread.kill()
            # in Python) — the worker thread keeps running in the background and
            # releases `lock` itself when it eventually finishes. The agent loop
            # is freed now instead of blocking indefinitely (this is what caused
            # a stuck pip-install to eat the full 30-minute container timeout
            # instead of failing fast).
            return (
                f"Error: python_repl code timed out after {self.timeout}s. "
                "The call was abandoned — do not assume any side effects "
                "(files written, variables set) completed. Avoid long-running "
                "subprocess/network calls in python_repl; use the exec tool "
                "instead, which has its own timeout and can be killed."
            )

    @staticmethod
    def _run_blocking(code: str, ns: dict[str, Any], lock: threading.Lock) -> str:  # noqa: A002
        try:
            captured: list[str] = []

            def _shim_print(*args: Any, sep: str = " ", end: str = "\n", **_ignored: Any) -> None:
                # Deliberately does NOT touch sys.stdout — this call may run
                # past its timeout on a background thread, and sys.stdout is
                # a process-wide global shared with every other thread.
                captured.append(sep.join(str(a) for a in args) + end)

            # Shadow the builtin `print` for this namespace only. Direct
            # sys.stdout/sys.stderr writes (rare — e.g. from C-extension
            # libraries) are intentionally NOT captured here; they fall
            # through to the real process stdout/stderr (visible in
            # container logs) rather than risk a global redirect.
            ns["print"] = _shim_print

            last_expr_repr: str | None = None
            error: str | None = None

            src = code.strip()

            try:
                # Try to compile as expression first (to capture repr of result)
                try:
                    expr_code = compile(src, "<repl>", "eval")
                    result = eval(expr_code, ns)  # noqa: S307
                    if result is not None:
                        last_expr_repr = repr(result)
                except SyntaxError:
                    # Not a single expression — compile as statements
                    stmt_code = compile(src, "<repl>", "exec")
                    exec(stmt_code, ns)  # noqa: S102
            except SystemExit:
                error = "[SystemExit intercepted — ignored]"
            except KeyboardInterrupt:
                error = "[KeyboardInterrupt intercepted — ignored]"
            except Exception:
                error = traceback.format_exc(limit=6)

            parts: list[str] = []
            out = "".join(captured)

            if out:
                parts.append(out.rstrip())
            if last_expr_repr is not None:
                parts.append(last_expr_repr)
            if error:
                parts.append(f"[error]\n{error.rstrip()}")
            if not parts:
                parts.append("(no output)")

            return "\n".join(parts)[:4000]  # cap output to avoid flooding context
        finally:
            lock.release()
