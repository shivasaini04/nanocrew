"""HTTP server exposing a single nanoagent AgentLoop over HTTP.

Used by nanocrew's runtime pool to lazy-launch a per-agent nanoagent process and
route chat messages to it via localhost HTTP.

Phase 1 Task 1.6 Step 1 — minimal viable server.
- GET  /health     → liveness probe
- GET  /info       → workspace path + model in use
- POST /chat       → { message, session_key? } → { response, metadata }

Future steps:
- POST /chat/stream (SSE) for live progress
- Per-agent-dir config loading (today uses nanoagent's default config + workspace override)
- Graceful shutdown on SIGTERM
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel


class ChatRequest(BaseModel):
    message: str
    session_key: str = "http:default"
    channel: str = "http"
    chat_id: str = "direct"


class ChatResponse(BaseModel):
    response: str
    metadata: dict[str, Any] = {}


def build_app(workspace: Path, port: int):
    """Construct the FastAPI app + AgentLoop. Returns (app, agent)."""
    from fastapi import FastAPI

    from nanoagent.config.loader import load_config
    from nanoagent.bus.queue import MessageBus
    from nanoagent.agent.loop import AgentLoop
    from nanoagent.session.manager import SessionManager
    from nanoagent.cron.service import CronService
    from nanoagent.config.loader import get_data_dir

    # Load nanoagent's standard config; override workspace path with the one passed in.
    # workspace_path is a derived property from agents.defaults.workspace — set the source field.
    config = load_config()
    config.agents.defaults.workspace = str(workspace)

    from nanoagent.cli.commands import _make_provider  # reuse provider construction

    bus = MessageBus()
    provider = _make_provider(config)
    session_manager = SessionManager(workspace)
    cron = CronService(get_data_dir() / "cron" / "jobs.json")

    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=workspace,
        model=config.agents.defaults.model,
        temperature=config.agents.defaults.temperature,
        max_tokens=config.agents.defaults.max_tokens,
        max_iterations=config.agents.defaults.max_tool_iterations,
        memory_window=config.agents.defaults.memory_window,
        brave_api_key=config.tools.web.search.api_key or None,
        exec_config=config.tools.exec,
        cron_service=cron,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        session_manager=session_manager,
        mcp_servers=config.tools.mcp_servers,
        channels_config=config.channels,
    )

    app = FastAPI(title="nanoagent serve", version="0.1")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "workspace": str(workspace), "port": port}

    @app.get("/info")
    async def info() -> dict[str, Any]:
        return {
            "workspace": str(workspace),
            "model": config.agents.defaults.model,
            "max_iterations": config.agents.defaults.max_tool_iterations,
            "memory_window": config.agents.defaults.memory_window,
            "tool_count": len(agent.tools.tool_names),
        }

    @app.post("/chat", response_model=ChatResponse)
    async def chat(req: ChatRequest) -> ChatResponse:
        response_text, metadata = await agent.process_direct(
            req.message,
            session_key=req.session_key,
            channel=req.channel,
            chat_id=req.chat_id,
        )
        return ChatResponse(response=response_text or "", metadata=metadata or {})

    return app, agent


def run_serve(workspace: Path, host: str, port: int) -> None:
    """Entry point invoked by the `nanoagent serve` CLI command."""
    import uvicorn

    if not workspace.exists():
        raise SystemExit(f"Workspace path does not exist: {workspace}")
    if not workspace.is_dir():
        raise SystemExit(f"Workspace path is not a directory: {workspace}")

    app, _agent = build_app(workspace.resolve(), port)
    uvicorn.run(app, host=host, port=port, log_level="info")
