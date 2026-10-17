"""Shell execution tool."""

import asyncio
import os
import re
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool



# An attached git repository, mounted read-write by the cycle runner and the whole point of
# attaching a repo. The file tools allow it (see filesystem.py `_repo_roots`); exec refusing
# it left the boundary inconsistent, which is worse than either answer — an agent that finds
# one route open will use it, as one did, via python_repl and an attempted symlink.
_REPO_MOUNT = Path("/workspace/repo")


_HARMLESS_DEVICES = frozenset({"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"})


def _looks_like_outside_path(token: str) -> bool:
    """Whether an absolute-looking token in a command is a path the workspace guard
    should judge at all.

    Three false positives, all from one Mechanic cycle (2026-09-14) that lost 6 of 12
    exec calls to "path outside working dir" and never learned which token was the
    problem, so each retry was a new shape of the same command:

    - `/dev/null;` — a redirect target (with the shell's `;` stuck to it), not a file.
    - `/);` and `/);try{new` — fragments of a JS regex literal inside `node -e "…"`.
      A real path segment starts with a name character; these start with `)`.
    - `/tmp/check.js` — the container's own scratch space, discarded with the container.
    """
    t = token.strip().rstrip(";&|)")
    if t in _HARMLESS_DEVICES or t == "/tmp" or t.startswith("/tmp/"):
        return False
    return bool(re.match(r"/[A-Za-z0-9._~-]", t))


def _in_repo_mount(p: Path) -> bool:
    try:
        if not _REPO_MOUNT.exists():
            return False
        p.relative_to(_REPO_MOUNT.resolve())
        return True
    except Exception:
        return False


class ExecTool(Tool):
    """Tool to execute shell commands."""
    
    def __init__(
        self,
        timeout: int = 60,
        working_dir: str | None = None,
        deny_patterns: list[str] | None = None,
        allow_patterns: list[str] | None = None,
        restrict_to_workspace: bool = False,
        path_append: str = "",
    ):
        self.timeout = timeout
        self.working_dir = working_dir
        # No default block list (removed 2026-09-14 at the owner's request). It refused ANY
        # `rm -r` — clearing a folder inside the agent's own workspace included — plus
        # `del /f` and `format`. What is genuinely destructive is refused for every tool,
        # in every posture, by the floor in agent/security.py (HARD_DENY_RULES): wiping /
        # or /workspace, disk formats, raw disk writes, shutdown, fork bombs, force-push,
        # and piping secrets off the box.
        self.deny_patterns = deny_patterns or []
        self.allow_patterns = allow_patterns or []
        self.restrict_to_workspace = restrict_to_workspace
        self.path_append = path_append
    
    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def name(self) -> str:
        return "exec"

    @property
    def description(self) -> str:
        return (
            "Execute a shell command and return its output. Use with caution. "
            "If a Python package you need is missing, declare it in a tool manifest "
            "(generate_tool's pythonPackages) — those install once to a managed package "
            "volume that is shared and persists. Avoid `pip install --target` into the "
            "workspace: it works, but nothing manages or cleans it, it duplicates packages "
            "the sidecar already has, and it buries your real files."
        )
    
    # Ceiling on the per-call override below — long enough for a real research sweep
    # (many simulation runs in one process), short enough that a runaway command still
    # can't hold the container hostage for the full 30-min/6-hour cycle timeout.
    MAX_TIMEOUT_SECONDS = 900

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute"
                },
                "working_dir": {
                    "type": "string",
                    "description": "Optional working directory for the command"
                },
                "timeout_seconds": {
                    "type": "integer",
                    "description": (
                        f"Override the default {self.timeout}s timeout for commands you "
                        f"know will run long (e.g. a multi-run simulation sweep) — up to "
                        f"{self.MAX_TIMEOUT_SECONDS}s. Only raise this when you actually "
                        f"expect the command to need it; it does not make short commands run faster."
                    ),
                    "minimum": 1,
                }
            },
            "required": ["command"]
        }

    async def execute(self, command: str, working_dir: str | None = None, timeout_seconds: int | None = None, **kwargs: Any) -> str:
        cwd = working_dir or self.working_dir or os.getcwd()
        guard_error = self._guard_command(command, cwd)
        if guard_error:
            return guard_error

        effective_timeout = self.timeout
        if timeout_seconds is not None:
            effective_timeout = max(1, min(int(timeout_seconds), self.MAX_TIMEOUT_SECONDS))

        env = os.environ.copy()
        if self.path_append:
            env["PATH"] = env.get("PATH", "") + os.pathsep + self.path_append

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=effective_timeout
                )
            except asyncio.TimeoutError:
                process.kill()
                # Wait for the process to fully terminate so pipes are
                # drained and file descriptors are released.
                try:
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    pass
                hint = "" if timeout_seconds is not None else " Pass timeout_seconds to raise it for a known-long command."
                return f"Error: Command timed out after {effective_timeout} seconds.{hint}"
            
            output_parts = []
            
            if stdout:
                output_parts.append(stdout.decode("utf-8", errors="replace"))
            
            if stderr:
                stderr_text = stderr.decode("utf-8", errors="replace")
                if stderr_text.strip():
                    output_parts.append(f"STDERR:\n{stderr_text}")
            
            if process.returncode != 0:
                output_parts.append(f"\nExit code: {process.returncode}")
            
            result = "\n".join(output_parts) if output_parts else "(no output)"
            
            # Truncate very long output
            max_len = 10000
            if len(result) > max_len:
                result = result[:max_len] + f"\n... (truncated, {len(result) - max_len} more chars)"
            
            return result
            
        except Exception as e:
            return f"Error executing command: {str(e)}"

    def _guard_command(self, command: str, cwd: str) -> str | None:
        """Best-effort safety guard for potentially destructive commands."""
        cmd = command.strip()
        lower = cmd.lower()

        for pattern in self.deny_patterns:
            if re.search(pattern, lower):
                return "Error: Command blocked by safety guard (dangerous pattern detected)"

        if self.allow_patterns:
            if not any(re.search(p, lower) for p in self.allow_patterns):
                return "Error: Command blocked by safety guard (not in allowlist)"

        if self.restrict_to_workspace:
            if "..\\" in cmd or "../" in cmd:
                return "Error: Command blocked by safety guard (path traversal detected)"

            cwd_path = Path(cwd).resolve()

            win_paths = re.findall(r"[A-Za-z]:\\[^\\\"']+", cmd)
            # Only match absolute paths — avoid false positives on relative
            # paths like ".venv/bin/python" where "/bin/python" would be
            # incorrectly extracted by the old pattern.
            posix_paths = re.findall(r"(?:^|[\s|>])(/[^\s\"'>]+)", cmd)

            for raw in win_paths + [p for p in posix_paths if _looks_like_outside_path(p)]:
                try:
                    p = Path(raw.strip()).resolve()
                except Exception:
                    continue
                if p.is_absolute() and cwd_path not in p.parents and p != cwd_path and not _in_repo_mount(p):
                    return "Error: Command blocked by safety guard (path outside working dir)"

        return None
