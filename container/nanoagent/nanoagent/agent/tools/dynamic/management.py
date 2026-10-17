"""Tools for managing the dynamic tool registry."""

from typing import Any
from nanoagent.agent.tools.base import Tool


class ListToolsTool(Tool):
    """Lists all available tools, identifying built-in vs dynamic."""

    def __init__(self, registry: Any):
        self._registry = registry

    @property
    def name(self) -> str:
        return "list_tools"

    @property
    def description(self) -> str:
        return "Lists all currently registered tools, distinguishing between built-in and dynamically generated ones."

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> str:
        lines = ["## Available Tools"]
        
        # Hardcoded Tools
        hardcoded = [t for t in self._registry._tools.values() if not getattr(t, "is_dynamic", False)]
        if hardcoded:
            lines.append("\n### [Built-in]")
            for t in sorted(hardcoded, key=lambda x: str(x.name)):
                lines.append(f"- **{t.name}**: {t.description}")
        
        # Dynamic Tools
        dynamic = self._registry.get_dynamic_tools()
        if dynamic:
            lines.append("\n### [Dynamic]")
            for t in sorted(dynamic, key=lambda x: str(x.name)):
                version = getattr(t, "version", "unknown")
                lines.append(f"- **{t.name}** (v{version}): {t.description}")
        else:
            lines.append("\nNo dynamic tools currently registered.")

        return "\n".join(lines)


class RemoveToolTool(Tool):
    """Safely removes a dynamic tool from the registry."""

    def __init__(self, registry: Any):
        self._registry = registry

    @property
    def name(self) -> str:
        return "remove_tool"

    @property
    def description(self) -> str:
        return "Safely removes a dynamically generated tool from the registry. You cannot remove built-in tools."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The name of the dynamic tool to remove."
                }
            },
            "required": ["name"]
        }

    async def execute(self, **kwargs: Any) -> str:
        name = kwargs["name"]
        if self._registry.unregister_dynamic(name):
            return f"Successfully removed dynamic tool: '{name}'"
        
        if self._registry.has(name):
            return f"Error: '{name}' is a built-in tool and cannot be removed."
        
        return f"Error: Tool '{name}' not found."


class RollbackTool(Tool):
    """Allows the agent to manually rollback a dynamic tool to a previous version."""

    def __init__(self, manager: Any):
        self._manager = manager

    @property
    def name(self) -> str:
        return "rollback_tool"

    @property
    def description(self) -> str:
        return (
            "Rolls back a dynamically generated tool to its previous version or a specific version. "
            "Use this if a tool passes automated tests but behaves incorrectly in practice."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The name of the dynamic tool to rollback."
                },
                "version": {
                    "type": "string",
                    "description": "Optional: Specific version to rollback to (e.g. '0.1.0'). If omitted, reverts to the immediate previous version."
                }
            },
            "required": ["name"]
        }

    async def execute(self, **kwargs: Any) -> str:
        name = kwargs["name"]
        version = kwargs.get("version")
        
        success, message = self._manager.rollback_tool(name, version=version)
        return message
