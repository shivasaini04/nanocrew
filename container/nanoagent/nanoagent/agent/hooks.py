"""Hook runner: PreToolUse / PostToolUse / PostToolUseFailure subprocess hooks.

Hooks are shell commands invoked at specific agent events.  They receive a
JSON payload on stdin and return a JSON result on stdout.

Configuration in ``.nanocrew/settings.json``::

    {
      "hooks": [
        {
          "event": "PreToolUse",
          "matcher": "exec",
          "command": "./hooks/bash_audit.sh",
          "timeout_ms": 5000,
          "on_error": "continue"
        },
        {
          "event": "PostToolUse",
          "matcher": "write_file",
          "command": "npx prettier --write"
        }
      ]
    }

Hook stdin payload::

    {
      "event": "PreToolUse",
      "tool": "exec",
      "args": {"command": "git status"},
      "session_id": "cli:direct"
    }

Hook stdout result::

    {
      "denied": false,
      "messages": ["audited"],
      "permission_override": null,
      "updated_input": null
    }
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from loguru import logger


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

class HookEvent(str, Enum):
    # Tool lifecycle (original 3)
    PreToolUse          = "PreToolUse"
    PostToolUse         = "PostToolUse"
    PostToolUseFailure  = "PostToolUseFailure"

    # Session lifecycle
    SessionStart        = "SessionStart"
    SessionEnd          = "SessionEnd"

    # LLM call lifecycle
    PreLLMCall          = "PreLLMCall"
    PostLLMCall         = "PostLLMCall"

    # Context management
    PreCompaction       = "PreCompaction"
    PostCompaction      = "PostCompaction"

    # Flow control
    GraceCall           = "GraceCall"
    MaxIterationsReached = "MaxIterationsReached"

    # Budget
    BudgetAlert         = "BudgetAlert"

    # Tool system
    ToolNotFound        = "ToolNotFound"
    ToolSkipped         = "ToolSkipped"


@dataclass
class HookConfig:
    """Configuration for one hook entry."""

    event: HookEvent
    command: str
    matcher: str = "*"        # glob over tool name
    timeout_ms: int = 5000
    on_error: str = "continue"  # "continue" | "deny"


@dataclass
class HookRunResult:
    """Merged result from all matching hooks for one event."""

    denied: bool = False
    failed: bool = False
    messages: list[str] = field(default_factory=list)

    # Permission override returned by a PreToolUse hook.
    # Values: "allow" | "deny" | "ask" | None
    permission_override: str | None = None
    permission_reason: str = ""

    # If set, the loop should use these args instead of the originals.
    updated_input: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Abort signal
# ---------------------------------------------------------------------------

class HookAbortSignal:
    """Shared cancellation token for in-flight hooks.

    Call ``abort()`` (e.g. from a Ctrl-C handler) to interrupt all hooks
    that are currently waiting.  Uses an ``asyncio.Event`` so it integrates
    cleanly with the agent's async loop.
    """

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def abort(self) -> None:
        self._event.set()

    def is_aborted(self) -> bool:
        return self._event.is_set()

    def clear(self) -> None:
        self._event.clear()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

class HookRunner:
    """Executes configured hooks as subprocesses.

    Multiple hooks can match the same event/tool pair.  They run sequentially;
    the results are merged (any ``denied=True`` wins; last ``permission_override``
    and ``updated_input`` win).
    """

    def __init__(
        self,
        configs: list[HookConfig] | None = None,
        abort_signal: HookAbortSignal | None = None,
        workspace: Path | None = None,
    ) -> None:
        self._configs = configs or []
        self._abort = abort_signal or HookAbortSignal()
        self._workspace = workspace or Path.cwd()

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_settings(
        cls,
        settings_path: Path,
        workspace: Path | None = None,
        abort_signal: HookAbortSignal | None = None,
    ) -> "HookRunner":
        """Load hook configs from ``.nanocrew/settings.json``."""
        configs: list[HookConfig] = []
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                for h in data.get("hooks", []):
                    configs.append(HookConfig(
                        event=HookEvent(h["event"]),
                        command=h["command"],
                        matcher=h.get("matcher", "*"),
                        timeout_ms=h.get("timeout_ms", 5000),
                        on_error=h.get("on_error", "continue"),
                    ))
            except Exception as exc:
                logger.warning("Failed to load hooks from {}: {}", settings_path, exc)
        return cls(configs=configs, abort_signal=abort_signal, workspace=workspace)

    @classmethod
    def from_workspace(
        cls,
        workspace: Path,
        abort_signal: HookAbortSignal | None = None,
    ) -> "HookRunner":
        """4-source hook discovery: project → user → system → config file."""
        configs: list[HookConfig] = []
        search_dirs = [
            workspace / "hooks",                                         # 1. project
            Path.home() / ".config" / "nanocrew" / "hooks",             # 2. user
            Path("/etc/nanocrew/hooks"),                                 # 3. system
        ]
        for d in search_dirs:
            if d.is_dir():
                for f in sorted(d.glob("*.json")):
                    try:
                        data = json.loads(f.read_text(encoding="utf-8"))
                        hook_list = data if isinstance(data, list) else data.get("hooks", [])
                        for h in hook_list:
                            try:
                                configs.append(HookConfig(
                                    event=HookEvent(h["event"]),
                                    command=h["command"],
                                    matcher=h.get("matcher", "*"),
                                    timeout_ms=h.get("timeout_ms", 5000),
                                    on_error=h.get("on_error", "continue"),
                                ))
                            except (KeyError, ValueError):
                                pass
                    except Exception as exc:
                        logger.warning("Failed to load hooks from {}: {}", f, exc)

        # 4. .nanocrew/settings.json (existing config-file behaviour)
        settings_path = workspace / ".nanocrew" / "settings.json"
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                for h in data.get("hooks", []):
                    try:
                        configs.append(HookConfig(
                            event=HookEvent(h["event"]),
                            command=h["command"],
                            matcher=h.get("matcher", "*"),
                            timeout_ms=h.get("timeout_ms", 5000),
                            on_error=h.get("on_error", "continue"),
                        ))
                    except (KeyError, ValueError):
                        pass
            except Exception as exc:
                logger.warning("Failed to load hooks from {}: {}", settings_path, exc)

        return cls(configs=configs, abort_signal=abort_signal, workspace=workspace)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def run(
        self,
        event: HookEvent,
        tool_name: str,
        args: dict[str, Any],
        session_id: str = "",
        tool_result: str | None = None,
    ) -> HookRunResult:
        """Run all matching hooks for ``event`` / ``tool_name``.

        Returns a merged ``HookRunResult``.  Returns an empty (all-false)
        result when no hooks are configured.
        """
        matching = self._matching_hooks(event, tool_name)
        if not matching:
            return HookRunResult()

        payload = json.dumps(
            {
                "event": event.value,
                "tool": tool_name,
                "args": args,
                "session_id": session_id,
                **({"tool_result": tool_result} if tool_result is not None else {}),
            },
            ensure_ascii=False,
        )

        merged = HookRunResult()
        for hook in matching:
            if self._abort.is_aborted():
                break
            result = await self._run_one(hook, payload)
            self._merge(merged, result)

        return merged

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _matching_hooks(self, event: HookEvent, tool_name: str) -> list[HookConfig]:
        return [
            c for c in self._configs
            if c.event == event and fnmatch.fnmatch(tool_name, c.matcher)
        ]

    @staticmethod
    def _merge(target: HookRunResult, source: HookRunResult) -> None:
        """Fold ``source`` into ``target`` in-place."""
        if source.denied:
            target.denied = True
        if source.failed:
            target.failed = True
        target.messages.extend(source.messages)
        if source.permission_override:
            target.permission_override = source.permission_override
            target.permission_reason = source.permission_reason
        if source.updated_input is not None:
            target.updated_input = source.updated_input

    async def _run_one(self, hook: HookConfig, payload: str) -> HookRunResult:
        """Spawn one hook process, feed it the payload, parse stdout."""
        timeout_secs = hook.timeout_ms / 1000
        try:
            proc = await asyncio.create_subprocess_shell(
                hook.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._workspace),
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(payload.encode()),
                    timeout=timeout_secs,
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except Exception:
                    pass
                logger.warning("Hook timed out after {}ms: {}", hook.timeout_ms, hook.command)
                if hook.on_error == "deny":
                    return HookRunResult(denied=True, failed=True, messages=["Hook timed out"])
                return HookRunResult(failed=True, messages=["Hook timed out"])

            if proc.returncode != 0:
                msg = f"Hook exited {proc.returncode}"
                if stderr:
                    msg += f": {stderr.decode(errors='replace')[:200]}"
                logger.warning("{}: {}", msg, hook.command)
                if hook.on_error == "deny":
                    return HookRunResult(denied=True, failed=True, messages=[msg])
                return HookRunResult(failed=True, messages=[msg])

            raw = stdout.strip()
            if not raw:
                return HookRunResult()  # Hook ran successfully but returned nothing

            data = json.loads(raw.decode(errors="replace"))
            return HookRunResult(
                denied=bool(data.get("denied", False)),
                failed=bool(data.get("failed", False)),
                messages=list(data.get("messages", [])),
                permission_override=data.get("permission_override"),
                permission_reason=data.get("permission_reason", ""),
                updated_input=data.get("updated_input"),
            )

        except json.JSONDecodeError as exc:
            logger.warning("Hook returned invalid JSON ({}): {}", hook.command, exc)
            if hook.on_error == "deny":
                return HookRunResult(denied=True, failed=True, messages=["Hook returned invalid JSON"])
            return HookRunResult(failed=True, messages=["Hook returned invalid JSON"])

        except Exception as exc:
            logger.warning("Hook error ({}): {}", hook.command, exc)
            if hook.on_error == "deny":
                return HookRunResult(denied=True, failed=True, messages=[f"Hook error: {exc}"])
            return HookRunResult(failed=True, messages=[f"Hook error: {exc}"])
