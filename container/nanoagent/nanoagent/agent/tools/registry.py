"""Tool registry for dynamic tool management."""

from collections.abc import Awaitable, Callable
from typing import Any

from nanoagent.agent.tool_origin import (
    DEFAULT_ORIGIN,
    normalize_origin,
    reset_current_write_origin,
    set_current_write_origin,
)
from nanoagent.agent.tools.base import Tool


class ToolRegistry:
    """
    Registry for agent tools.
    
    Allows dynamic registration and execution of tools.
    """
    
    # Phase 4c (stage25): the binding limit is how many tools sit IN CONTEXT, not how
    # many an agent OWNS — deferred mode (below) advertises only active tools and loads
    # the rest on demand via tool_search, so owned-but-inactive tools don't bloat the
    # prompt. Raised 20 → 100 accordingly; lower per-registry only where context is tight.
    def __init__(self, max_dynamic_tools: int = 100, write_origin: str = DEFAULT_ORIGIN):
        self._tools: dict[str, Tool] = {}
        self._max_dynamic_tools = max_dynamic_tools
        # Stage 42 #2 — who is driving this registry's tool calls. Stamped onto the
        # ContextVar around every dispatch so durable writes (save_skill today,
        # memory writes next) can record provenance without every layer in between
        # having to pass it down. The post-turn review fork constructs its restricted
        # registry with write_origin=BACKGROUND_REVIEW; a foreground agent leaves the
        # default, which is user-owned and therefore off-limits to the curator.
        self._write_origin = normalize_origin(write_origin)
        # Deferred-tools mode (claw-code style). None → off: every tool is advertised.
        # A set → only those names are advertised in get_definitions(); the rest are
        # discoverable/loadable on demand via tool_search (registry.activate).
        self._active: set[str] | None = None
        # Tools withheld by the per-agent grant policy. Kept rather than destroyed so a
        # borrow can hand one back for a single cycle. See withdraw()/restore().
        self._withdrawn: dict[str, Tool] = {}

    def enable_deferral(self, core_names: set[str]) -> None:
        """Advertise only `core_names` (+ any later activated); defer the rest.

        Deferred tools stay fully registered and executable — they're just not in
        the schema payload sent to the LLM until tool_search activates them. This
        cuts the per-call tool-schema tokens (~57% of the prompt) without losing
        any capability.
        """
        self._active = {n for n in core_names if n in self._tools}

    def activate(self, names: list[str]) -> tuple[list[str], list[str]]:
        """Add tools to the advertised set (called by tool_search). Returns
        (newly_activated, unknown). No-op when deferral is off."""
        if self._active is None:
            return ([], [])
        activated: list[str] = []
        unknown: list[str] = []
        for n in names:
            if n in self._tools:
                if n not in self._active:
                    self._active.add(n)
                    activated.append(n)
            else:
                unknown.append(n)
        return (activated, unknown)

    def deferred_names(self) -> list[str]:
        """Names of registered tools NOT currently advertised (loadable on demand)."""
        if self._active is None:
            return []
        return [n for n in self._tools if n not in self._active]

    def deferred_catalog(self) -> dict[str, str]:
        """Deferred tools as name -> one short line, for choosing between them.

        The full descriptions run to paragraphs; forty-five of those would cost more
        than the tool_search round trip this is meant to avoid. See tool_preselect.
        """
        from nanoagent.agent.tool_preselect import short_description

        catalog: dict[str, str] = {}
        for name in self.deferred_names():
            tool = self._tools.get(name)
            if tool is None:
                continue
            try:
                catalog[name] = short_description(tool.description)
            except Exception:  # noqa: BLE001 - a tool whose description raises is skipped
                continue
        return catalog
    
    def register(self, tool: Tool) -> None:
        """Register a hardcoded tool."""
        self._tools[tool.name] = tool
    
    def register_dynamic(self, tool: Tool) -> None:
        """
        Register a dynamic tool with safety checks.
        
        Args:
            tool: The DynamicTool instance to register.
            
        Raises:
            ValueError: If name collides with a hardcoded tool or limit is reached.
        """
        if self.has(tool.name) and not getattr(self._tools[tool.name], "is_dynamic", False):
            raise ValueError(f"Cannot overwrite hardcoded tool: '{tool.name}'")
        
        dynamic_count = len(self.get_dynamic_tools())
        if dynamic_count >= self._max_dynamic_tools and not self.has_dynamic(tool.name):
            raise ValueError(f"Dynamic tool limit reached ({self._max_dynamic_tools})")
            
        self._tools[tool.name] = tool
    
    def unregister(self, name: str) -> None:
        """Unregister a tool by name."""
        self._tools.pop(name, None)

    def withdraw(self, name: str) -> None:
        """Remove a tool the agent is not granted, but KEEP it so it can be lent back.

        Stage 56 phase 3. Enforcement used to be a plain `unregister`, which deletes the
        tool object outright — and a deleted tool cannot be borrowed, because there is
        nothing left in the container to restore. Withdrawing stashes it instead.

        The model sees no difference: a withdrawn tool is absent from `get_definitions`
        and cannot be executed. What changes is that `restore` becomes possible, which is
        the whole of tool borrowing on this side.
        """
        tool = self._tools.pop(name, None)
        if tool is not None:
            self._withdrawn[name] = tool

    def restore(self, name: str) -> bool:
        """Put a withdrawn tool back for the rest of this cycle. Returns False if unknown.

        Only ever called after the orchestrator has authorised a borrow — same owner, the
        lender actually holds the tool, audited on both sides. This function is the effect,
        not the decision.
        """
        tool = self._withdrawn.pop(name, None)
        if tool is None:
            return False
        self._tools[name] = tool
        if self._active is not None:
            # Advertise it immediately. An agent that just borrowed a tool and cannot see
            # it in its schema will conclude the borrow failed and try something else.
            self._active.add(name)
        return True

    def withdrawn_names(self) -> list[str]:
        """Tools present in this build but withheld by policy — the borrowable set."""
        return sorted(self._withdrawn)

    def unregister_dynamic(self, name: str) -> bool:
        """
        Safely remove a dynamic tool.
        
        Args:
            name: The name of the tool to remove.
            
        Returns:
            bool: True if a dynamic tool was removed, False otherwise.
        """
        if self.has_dynamic(name):
            self._tools.pop(name)
            return True
        return False
    
    def get(self, name: str) -> Tool | None:
        """Get a tool by name."""
        return self._tools.get(name)
    
    def get_dynamic_tools(self) -> list[Tool]:
        """Get all registered dynamic tools."""
        return [t for t in self._tools.values() if getattr(t, "is_dynamic", False)]

    def has(self, name: str) -> bool:
        """Check if a tool is registered."""
        return name in self._tools

    def has_dynamic(self, name: str) -> bool:
        """Check if a registered tool is dynamic."""
        tool = self._tools.get(name)
        return tool is not None and getattr(tool, "is_dynamic", False)
    
    def get_definitions(self) -> list[dict[str, Any]]:
        """Get advertised tool definitions in OpenAI format.

        In deferred mode only the active set is returned (the rest are loadable
        via tool_search); otherwise all tools are returned."""
        if self._active is None:
            return [tool.to_schema() for tool in self._tools.values()]
        return [t.to_schema() for n, t in self._tools.items() if n in self._active]
    
    @property
    def write_origin(self) -> str:
        """Provenance tag stamped around this registry's tool calls."""
        return self._write_origin

    def set_write_origin(self, origin: str) -> None:
        """Retag this registry (an unknown tag falls back to the user-owned default)."""
        self._write_origin = normalize_origin(origin)

    def _schema_help(self, tool: Any, params: dict[str, Any]) -> str:
        """Tell the model the exact call to make, rather than to think of another one.

        A schema error is the one failure where "try a different approach" is precisely
        the wrong advice: the approach was right and the argument names were not. Mailer
        was told that 174 times in eight days and did as instructed — invented a new shape
        each time, never the documented one. 90 failures in a single day, whole cycles
        spent retrying a call it was one field away from getting right.

        So a parameter error now answers with the schema: what is required, what was sent,
        and which names do not exist. That is recoverable on the next turn. "Think of
        something else" is not.
        """
        try:
            schema = tool.parameters or {}
            props: dict = schema.get("properties", {}) or {}
            required = schema.get("required", []) or []
            sent = sorted(params.keys())
            unknown = [k for k in sent if k not in props]

            lines = ["", f"The parameters for '{tool.name}' are:"]
            for key, spec in props.items():
                mark = "REQUIRED" if key in required else "optional"
                lines.append(f"  {key} ({spec.get('type', 'any')}, {mark})")
            lines.append(f"You sent: {sent or 'nothing'}")
            if unknown:
                lines.append(f"Not parameters of this tool, ignored: {unknown}")
            lines.append(
                "Call the SAME tool again using exactly these names. Do not rename them, "
                "do not switch to a different tool, and do not abandon the task."
            )
            return "\n".join(lines)
        except Exception:
            return ""

    async def execute(self, name: str, params: dict[str, Any]) -> str:
        """Execute a tool by name with given parameters."""
        _HINT = "\n\n[Analyze the error above and try a different approach.]"

        tool = self._tools.get(name)
        if not tool:
            return f"Error: Tool '{name}' not found. Available: {', '.join(self.tool_names)}"

        origin_token = set_current_write_origin(self._write_origin)
        try:
            errors = tool.validate_params(params)
            if errors:
                return (
                    f"Error: Invalid parameters for tool '{name}': " + "; ".join(errors)
                    + self._schema_help(tool, params)
                )
            result = await tool.execute(**params)
            if isinstance(result, str) and result.startswith("Error"):
                return result + _HINT
            return result
        except Exception as e:
            return f"Error executing {name}: {str(e)}" + _HINT
        finally:
            reset_current_write_origin(origin_token)

    async def execute_streaming(
        self,
        name: str,
        params: dict[str, Any],
        on_chunk: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        """Execute a tool, streaming partial output via on_chunk if the tool supports it.

        Falls back to regular execute() and emits the full result as a single chunk.
        """
        tool = self._tools.get(name)
        if not tool:
            return f"Error: Tool '{name}' not found. Available: {', '.join(self.tool_names)}"

        if on_chunk and hasattr(tool, "execute_streaming"):
            # Stamped here too: this branch bypasses execute() entirely, and it is the
            # path loop.py actually takes (loop.py:1444). Missing it would leave every
            # streaming write unattributed.
            origin_token = set_current_write_origin(self._write_origin)
            try:
                return await tool.execute_streaming(on_chunk=on_chunk, **params)
            except Exception:
                pass  # fall through to regular execute
            finally:
                reset_current_write_origin(origin_token)

        result = await self.execute(name, params)
        if on_chunk:
            await on_chunk(result[:500])
        return result
    
    @property
    def tool_names(self) -> list[str]:
        """Get list of registered tool names."""
        return list(self._tools.keys())
    
    def __len__(self) -> int:
        return len(self._tools)
    
    def __contains__(self, name: str) -> bool:
        return name in self._tools
