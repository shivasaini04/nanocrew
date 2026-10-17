"""Tool wrapper for dynamically generated agent tools."""

from typing import Any, Optional
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.dynamic.manifest import ToolManifest
from nanoagent.agent.tools.dynamic.sandbox import SandboxExecutor, SandboxResult


class DynamicTool(Tool):
    """
    A tool that wraps a dynamically generated implementation.
    
    This class allows agent-generated code to be used as a first-class tool
    in the agent's tool registry.
    """

    def __init__(self, manifest: ToolManifest, health_monitor: Any = None):
        """
        Initialize the dynamic tool from a manifest.
        
        Args:
            manifest: The manifest containing tool name, schema, and code.
            health_monitor: ToolHealthMonitor instance to record metrics.
        """
        self._manifest = manifest
        self._executor = SandboxExecutor()
        self._health_monitor = health_monitor

    @property
    def name(self) -> str:
        """The name of the dynamic tool."""
        return self._manifest.name

    @property
    def description(self) -> str:
        """The description of what the dynamic tool does."""
        return self._manifest.description

    @property
    def parameters(self) -> dict[str, Any]:
        """The JSON schema for the dynamic tool's parameters."""
        return self._manifest.parameters

    @property
    def manifest(self) -> ToolManifest:
        """Reference to the underlying tool manifest."""
        return self._manifest

    @property
    def is_dynamic(self) -> bool:
        """Whether this tool is dynamically generated."""
        return True

    @property
    def version(self) -> str:
        """The version of the dynamic tool."""
        return self._manifest.version

    @property
    def job_scope(self) -> Optional[str]:
        """The job scope if this is a job-specific tool."""
        return self._manifest.job_scope

    async def execute(self, **kwargs: Any) -> str:
        """
        Execute the dynamic tool implementation in a sandbox.
        
        Args:
            **kwargs: Arguments to pass to the tool.
            
        Returns:
            The execution result as a string, or an error message.
        """
        import time
        start_time = time.time()

        # Route by tier (set automatically at creation by classify_tier):
        #   sidecar → run in the agent's isolated Docker sidecar (real isolation, deps,
        #             subprocess allowed) via the orchestrator.
        #   sandbox → run in-process subprocess sandbox with real RLIMITs (Step 1).
        if self._manifest.tier == "sidecar":
            result = await self._run_in_sidecar(kwargs)
        else:
            # Memory cap for the sandbox tier. Floor at 512MB so tools that previously ran
            # under the (unlimited) sandbox aren't suddenly squeezed; a memory bomb still
            # gets killed. Heavier tools are the sidecar tier (Docker --memory), not this.
            mem_mb = max(getattr(self._manifest.sandbox_config, "memory_limit_mb", 0) or 0, 512)
            result = await self._executor.run(
                code=self._manifest.implementation,
                args=kwargs,
                language=self._manifest.language,
                timeout=self._manifest.timeout,
                files=self._manifest.files,
                entrypoint=self._manifest.entrypoint,
                memory_limit_mb=mem_mb,
            )

        success = result.success
        latency_ms = (time.time() - start_time) * 1000
        
        if self._health_monitor:
            self._health_monitor.record_execution(
                tool_name=self.name,
                success=success,
                latency_ms=latency_ms,
                error=result.error if not success else None
            )

        if success:
            return result.output
        else:
            return f"Error: {result.error}"

    async def _run_in_sidecar(self, kwargs: dict) -> SandboxResult:
        """Execute a sidecar-tier tool in the agent's isolated Docker sidecar.

        The cycle container already exposes AGENT_ID + NanoCrew_HOST (set by the
        orchestrator's container runner), and the orchestrator owns the sidecar
        lifecycle, so we just POST the call by name and let it route. This is what
        lets a generated tool use subprocess / heavy deps safely — the blast radius
        is the disposable 2GB container, not the agent process.
        """
        import os

        host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002").rstrip("/")
        agent_id = os.environ.get("AGENT_ID", "").strip()
        if not agent_id:
            return SandboxResult(
                success=False, output="",
                error="Sidecar routing unavailable: AGENT_ID is not set in this container.",
            )

        url = f"{host}/api/agents/{agent_id}/sidecar/call"
        # Sidecar work can be slow (first call may install deps); give it room.
        timeout = max(self._manifest.timeout, 120) + 60
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json={"tool": self.name, "args": kwargs})
                data = resp.json()
        except Exception as e:
            return SandboxResult(success=False, output="", error=f"Sidecar call failed: {e}")

        if isinstance(data, dict) and data.get("status") == "ok":
            return SandboxResult(success=True, output=data.get("result", "") or "")
        err = data.get("error") if isinstance(data, dict) else str(data)
        return SandboxResult(success=False, output="", error=err or "Sidecar returned an error")
