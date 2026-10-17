"""Loader for dynamic tools on session startup."""

from loguru import logger
from nanoagent.agent.tools.dynamic.persistence import ToolPersistence
from nanoagent.agent.tools.dynamic.tool import DynamicTool
from nanoagent.agent.tools.registry import ToolRegistry


class ToolLoader:
    """
    Handles discovery and registration of persisted dynamic tools.
    """

    def __init__(self, persistence: ToolPersistence, registry: ToolRegistry, health_monitor=None):
        self._persistence = persistence
        self._registry = registry
        self._health_monitor = health_monitor  # Phase 5a — track loaded tools' runtime health

    def load_persisted_tools(self, job_id: str | None = None) -> int:
        """
        Scan for persisted tools and register them in the registry.
        
        Args:
            job_id: Optional filter for job-scoped tools.
            
        Returns:
            int: Number of tools successfully loaded and registered.
        """
        count = 0
        try:
            manifests = self._persistence.load_all(job_id=job_id)
            for manifest in manifests:
                try:
                    # Create DynamicTool from manifest
                    dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
                    
                    # Register in the registry
                    # Note: We use register_dynamic which has limit checks
                    try:
                        self._registry.register_dynamic(dynamic_tool)
                        count += 1
                        logger.debug(f"Loaded dynamic tool: {manifest.name} (v{manifest.version})")
                    except ValueError as e:
                        logger.warning(f"Skipping dynamic tool '{manifest.name}': {e}")
                except Exception as e:
                    logger.error(f"Failed to initialize dynamic tool from manifest '{manifest.name}': {e}")
            
            if count > 0:
                logger.info(f"Successfully loaded {count} dynamic tools from disk.")
        except Exception as e:
            logger.error(f"Error during bulk loading of dynamic tools: {e}")
            
        return count

    def build_dynamic_tools_summary(self) -> str:
        """
        Builds an XML-style summary of registered dynamic tools for the system prompt.
        """
        dynamic_tools = self._registry.get_dynamic_tools()
        if not dynamic_tools:
            return ""

        lines = ["<dynamic_tools>"]
        for tool in dynamic_tools:
            # We assume dynamic tools have a manifest or at least name/description
            # Since they are registered via DynamicTool(manifest)
            name = tool.name
            desc = tool.description
            
            # Try to get version from manifest if available
            version = "unknown"
            if hasattr(tool, "manifest"):
                version = getattr(tool.manifest, "version", "unknown")
            
            lines.append(f"  <tool name=\"{name}\" version=\"{version}\">")
            lines.append(f"    <description>{desc}</description>")
            lines.append("  </tool>")
        
        lines.append("</dynamic_tools>")
        return "\n".join(lines)
