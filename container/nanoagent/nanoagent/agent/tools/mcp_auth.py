"""McpAuthTool — credential management for MCP servers.

Ported from claw-code-main/rust/crates/runtime/src/mcp.rs (McpAuth section).

Agents use this tool when an MCP server requires authentication (OAuth tokens,
API keys, etc.).  Credentials are stored at workspace/.mcp_credentials/{server}.json
so they survive across sessions without being committed to version control.

Actions:
  list        — Show all configured MCP servers and their credential status.
  set_token   — Store a token (or any key→value pairs) for a server.
  clear       — Remove stored credentials for a server.
  show_config — Print the full credential file for a server (for debugging).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.tools.base import Tool


# Credentials dir inside the agent workspace (gitignored by convention)
_CREDS_SUBDIR = ".mcp_credentials"


class McpAuthTool(Tool):
    """Manage OAuth tokens and API keys for MCP servers."""

    def __init__(self, workspace: Path, mcp_server_names: list[str] | None = None):
        self._workspace = workspace
        self._known_servers = list(mcp_server_names or [])

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "mcp_auth"

    @property
    def description(self) -> str:
        return (
            "Manage credentials for MCP servers. "
            "Actions: list (show status), set_token (store credential), "
            "clear (remove credentials), show_config (read stored file)."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "set_token", "clear", "show_config"],
                    "description": "What to do.",
                },
                "server": {
                    "type": "string",
                    "description": "MCP server name (required for set_token, clear, show_config).",
                },
                "credentials": {
                    "type": "object",
                    "description": (
                        "Key→value pairs to store. For set_token, typically "
                        '{"token": "..."} or {"api_key": "..."}.'
                    ),
                    "additionalProperties": {"type": "string"},
                },
            },
        }

    async def execute(self, **kwargs: Any) -> str:
        action: str = kwargs.get("action", "")
        server: str = kwargs.get("server", "")
        credentials: dict[str, str] = kwargs.get("credentials") or {}

        if action == "list":
            return self._list()
        elif action == "set_token":
            return self._set_token(server, credentials)
        elif action == "clear":
            return self._clear(server)
        elif action == "show_config":
            return self._show_config(server)
        else:
            return f"Error: unknown action '{action}'. Use list | set_token | clear | show_config."

    # ── Actions ───────────────────────────────────────────────────────────────

    def _list(self) -> str:
        creds_dir = self._workspace / _CREDS_SUBDIR
        lines = ["## MCP Server Credentials"]

        all_names = set(self._known_servers)
        if creds_dir.exists():
            for f in creds_dir.glob("*.json"):
                all_names.add(f.stem)

        if not all_names:
            return "No MCP servers configured."

        for name in sorted(all_names):
            path = creds_dir / f"{name}.json"
            if path.exists():
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    keys = ", ".join(data.keys())
                    lines.append(f"  ✓ {name}  [{keys}]")
                except Exception:
                    lines.append(f"  ! {name}  (corrupt credential file)")
            else:
                lines.append(f"  – {name}  (no credentials stored)")

        return "\n".join(lines)

    def _set_token(self, server: str, credentials: dict[str, str]) -> str:
        if not server:
            return "Error: 'server' is required for set_token."
        if not credentials:
            return "Error: 'credentials' dict is required for set_token."

        creds_dir = self._workspace / _CREDS_SUBDIR
        creds_dir.mkdir(parents=True, exist_ok=True)

        path = creds_dir / f"{server}.json"
        existing: dict[str, str] = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                pass  # overwrite corrupt file

        merged = {**existing, **{k: str(v) for k, v in credentials.items()}}
        path.write_text(json.dumps(merged, indent=2), encoding="utf-8")

        keys = ", ".join(merged.keys())
        logger.info("McpAuth: stored credentials for '{}' [{}]", server, keys)
        return f"Credentials stored for MCP server '{server}'. Keys: {keys}"

    def _clear(self, server: str) -> str:
        if not server:
            return "Error: 'server' is required for clear."

        path = self._workspace / _CREDS_SUBDIR / f"{server}.json"
        if not path.exists():
            return f"No credentials found for '{server}'."

        path.unlink()
        logger.info("McpAuth: cleared credentials for '{}'", server)
        return f"Credentials cleared for '{server}'."

    def _show_config(self, server: str) -> str:
        if not server:
            return "Error: 'server' is required for show_config."

        path = self._workspace / _CREDS_SUBDIR / f"{server}.json"
        if not path.exists():
            return f"No credentials file found for '{server}'."

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            # Redact values — show keys only (credentials are sensitive)
            redacted = {k: "***" for k in data.keys()}
            return (
                f"Credentials for '{server}':\n"
                + json.dumps(redacted, indent=2)
                + "\n(values redacted — use set_token to update)"
            )
        except Exception as e:
            return f"Error reading credential file for '{server}': {e}"
