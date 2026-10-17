"""MCP client: connects to MCP servers and wraps their tools as native NanoAgent tools.

Ported from claw-code-main/rust/crates/runtime/src/mcp.rs and mcp_stdio.rs.

Key design decisions (matching claw-code):
  - Tool names prefixed `mcp__{server}__{tool}` (double underscore) for clear
    namespacing and zero bespoke dispatch — the tool registry handles them
    identically to built-in tools.
  - Degraded startup: a server that fails or times out during startup does NOT
    abort the agent. The agent starts with whatever tools it got.
  - Per-server startup_timeout_ms enforced on initialize() + list_tools().
  - McpStartupReport returned so the caller can log / emit lane events.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

import httpx
from loguru import logger

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Startup report
# ---------------------------------------------------------------------------

@dataclass
class McpStartupReport:
    """Structured result of the MCP startup phase.

    Mirrors claw-code's ``McpStartupReport``. Returned by
    ``connect_mcp_servers()`` so callers can log, surface in the dashboard,
    or emit lane events without parsing log output.
    """
    started: list[str] = field(default_factory=list)
    """Server names that connected and passed the initialize handshake."""

    failed: list[tuple[str, str]] = field(default_factory=list)
    """(server_name, error_message) pairs for servers that could not start."""

    disabled: list[str] = field(default_factory=list)
    """Server names that were present in config but had enabled=False."""

    def render(self) -> str:
        """Human-readable summary for logging / REPL display."""
        total = len(self.started) + len(self.failed) + len(self.disabled)
        lines = [
            f"MCP servers: {len(self.started)} started"
            + (f", {len(self.failed)} failed" if self.failed else "")
            + (f", {len(self.disabled)} disabled" if self.disabled else "")
        ]
        for name in self.started:
            lines.append(f"  ✓ {name}")
        for name, err in self.failed:
            lines.append(f"  ✗ {name}: {err}")
        for name in self.disabled:
            lines.append(f"  – {name} (disabled)")
        return "\n".join(lines)

    @property
    def all_ok(self) -> bool:
        return len(self.failed) == 0


# ---------------------------------------------------------------------------
# MCPToolWrapper
# ---------------------------------------------------------------------------

class MCPToolWrapper(Tool):
    """Wraps a single MCP server tool as a NanoAgent Tool.

    Tool names follow the ``mcp__{server}__{tool}`` convention (double
    underscore) so they are unambiguous in the tool registry and can be
    filtered by prefix without regex.
    """

    def __init__(
        self,
        session,
        server_name: str,
        tool_def,
        tool_timeout: int = 30,
    ):
        self._session = session
        self._original_name = tool_def.name
        self._name = f"mcp__{server_name}__{tool_def.name}"
        self._description = getattr(tool_def, "description", None) or tool_def.name
        self._parameters = getattr(tool_def, "inputSchema", None) or {
            "type": "object",
            "properties": {},
        }
        self._tool_timeout = tool_timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types as mcp_types
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(self._original_name, arguments=kwargs),
                timeout=self._tool_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "MCP tool '{}' timed out after {}s", self._name, self._tool_timeout
            )
            return f"(MCP tool call timed out after {self._tool_timeout}s)"
        except Exception as e:
            return f"(MCP tool error: {e})"

        parts: list[str] = []
        for block in result.content:
            if isinstance(block, mcp_types.TextContent):
                parts.append(block.text)
            else:
                parts.append(str(block))
        return "\n".join(parts) or "(no output)"


# ---------------------------------------------------------------------------
# connect_mcp_servers
# ---------------------------------------------------------------------------

async def connect_mcp_servers(
    mcp_servers: dict,
    registry: ToolRegistry,
    stack: AsyncExitStack,
) -> McpStartupReport:
    """Connect to every configured MCP server and register their tools.

    Args:
        mcp_servers: Mapping of server_name → config object. Config objects
            must expose: command (str), args (list[str]), env (dict),
            enabled (bool), startup_timeout_ms (int). Optional: url (str),
            headers (dict), tool_timeout (int).
        registry:    ToolRegistry to register MCPToolWrappers into.
        stack:       AsyncExitStack used for lifetime management of sessions.

    Returns:
        McpStartupReport with started/failed/disabled lists. Failures are
        non-fatal — the agent continues with whatever tools were obtained.
    """
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    report = McpStartupReport()

    for name, cfg in mcp_servers.items():
        # Disabled servers
        enabled = getattr(cfg, "enabled", True)
        if not enabled:
            report.disabled.append(name)
            continue

        startup_timeout_s = getattr(cfg, "startup_timeout_ms", 10_000) / 1000
        tool_timeout_s    = getattr(cfg, "tool_timeout", 30)
        command           = getattr(cfg, "command", "")
        url               = getattr(cfg, "url", "")

        try:
            if command:
                params = StdioServerParameters(
                    command=command,
                    args=list(getattr(cfg, "args", []) or []),
                    env=dict(getattr(cfg, "env", {}) or {}) or None,
                )
                read, write = await stack.enter_async_context(stdio_client(params))

            elif url:
                from mcp.client.streamable_http import streamable_http_client
                http_client = await stack.enter_async_context(
                    httpx.AsyncClient(
                        headers=dict(getattr(cfg, "headers", {}) or {}),
                        follow_redirects=True,
                        timeout=None,
                    )
                )
                read, write, _ = await stack.enter_async_context(
                    streamable_http_client(url, http_client=http_client)
                )

            else:
                report.failed.append((name, "no command or url configured"))
                logger.warning("MCP server '{}': no command or url — skipped", name)
                continue

            # Handshake within startup_timeout_ms
            session = await stack.enter_async_context(ClientSession(read, write))

            try:
                await asyncio.wait_for(session.initialize(), timeout=startup_timeout_s)
            except asyncio.TimeoutError:
                msg = f"initialize() timed out after {startup_timeout_s:.0f}s"
                report.failed.append((name, msg))
                logger.error("MCP server '{}': {}", name, msg)
                continue

            try:
                tools_response = await asyncio.wait_for(
                    session.list_tools(), timeout=startup_timeout_s
                )
            except asyncio.TimeoutError:
                msg = f"list_tools() timed out after {startup_timeout_s:.0f}s"
                report.failed.append((name, msg))
                logger.error("MCP server '{}': {}", name, msg)
                continue

            for tool_def in tools_response.tools:
                wrapper = MCPToolWrapper(session, name, tool_def, tool_timeout=tool_timeout_s)
                registry.register(wrapper)
                logger.debug(
                    "MCP: registered tool '{}' from server '{}'", wrapper.name, name
                )

            report.started.append(name)
            logger.info(
                "MCP server '{}': connected, {} tool(s) registered",
                name,
                len(tools_response.tools),
            )

        except Exception as e:
            msg = str(e)
            report.failed.append((name, msg))
            logger.error("MCP server '{}': failed to connect — {}", name, msg)

    return report


# ---------------------------------------------------------------------------
# MCP resource browsing tools
# ---------------------------------------------------------------------------

class ListMcpResourcesTool(Tool):
    """Enumerate resources exposed by connected MCP servers.

    Ported from claw-code's ListMcpResources (lib.rs:1058).
    Resources are server-side data objects (files, DB rows, API results)
    addressable by URI. Not all servers expose resources.
    """

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "list_mcp_resources"

    @property
    def description(self) -> str:
        return (
            "List resources exposed by connected MCP servers. "
            "Optionally filter to a single server with the 'server' parameter. "
            "Returns resource URIs, names, and MIME types. "
            "Use read_mcp_resource to fetch a specific resource's content."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "MCP server name to query (omit for all connected servers)",
                },
            },
            "required": [],
        }

    async def execute(self, server: str = "", **kwargs: Any) -> str:
        sessions = self._get_sessions()
        if not sessions:
            return "No MCP servers are connected."

        if server:
            if server not in sessions:
                return (
                    f"Server '{server}' not found. "
                    f"Connected servers: {', '.join(sorted(sessions))}"
                )
            targets = {server: sessions[server]}
        else:
            targets = sessions

        results: list[str] = []
        for srv_name, session in targets.items():
            try:
                resp = await asyncio.wait_for(session.list_resources(), timeout=10)
                resources = getattr(resp, "resources", [])
                if not resources:
                    results.append(f"{srv_name}: (no resources exposed)")
                else:
                    lines = [f"{srv_name} ({len(resources)} resource(s)):"]
                    for r in resources:
                        mime = getattr(r, "mimeType", "") or ""
                        rname = getattr(r, "name", "") or ""
                        lines.append(f"  {r.uri}  {rname}  [{mime}]")
                    results.append("\n".join(lines))
            except asyncio.TimeoutError:
                results.append(f"{srv_name}: timed out listing resources")
            except Exception as e:
                results.append(f"{srv_name}: error — {e}")

        return "\n\n".join(results) if results else "No resources found."

    def _get_sessions(self) -> dict[str, Any]:
        sessions: dict[str, Any] = {}
        for name in self._registry.tool_names:
            tool = self._registry.get(name)
            if isinstance(tool, MCPToolWrapper):
                srv = tool._name.split("__")[1]
                if srv not in sessions:
                    sessions[srv] = tool._session
        return sessions


class ReadMcpResourceTool(Tool):
    """Fetch the content of a specific MCP resource by URI.

    Ported from claw-code's ReadMcpResource (lib.rs:1070).
    """

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "read_mcp_resource"

    @property
    def description(self) -> str:
        return (
            "Read the content of a specific MCP resource by its URI. "
            "Use list_mcp_resources first to discover available URIs."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "MCP server name that owns the resource",
                },
                "uri": {
                    "type": "string",
                    "description": "Resource URI as returned by list_mcp_resources",
                },
            },
            "required": ["server", "uri"],
        }

    async def execute(self, server: str, uri: str, **kwargs: Any) -> str:
        session = None
        for name in self._registry.tool_names:
            tool = self._registry.get(name)
            if isinstance(tool, MCPToolWrapper):
                srv = tool._name.split("__")[1]
                if srv == server:
                    session = tool._session
                    break

        if session is None:
            return f"MCP server '{server}' is not connected."

        try:
            resp = await asyncio.wait_for(session.read_resource(uri), timeout=15)
            parts: list[str] = []
            for content in getattr(resp, "contents", []):
                if hasattr(content, "text"):
                    parts.append(content.text)
                else:
                    parts.append(str(content))
            return "\n".join(parts) or "(empty resource)"
        except asyncio.TimeoutError:
            return f"Timed out reading resource '{uri}'"
        except Exception as e:
            return f"Error reading resource '{uri}': {e}"
