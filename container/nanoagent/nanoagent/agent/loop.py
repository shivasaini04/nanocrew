"""Agent loop: the core processing engine."""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import AsyncExitStack
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, cast

from loguru import logger

from nanoagent.agent.background_review import BackgroundReviewer
from nanoagent.agent.checkpoints import MUTATING_TOOLS, CheckpointStore
from nanoagent.agent.context import ContextBuilder
from nanoagent.agent.learn_prompt import build_learn_prompt, parse_learn_command
from nanoagent.agent.model_router import AdaptiveTemperature, ModelRouter
from nanoagent.agent.memory import MemoryStore
from nanoagent.agent.repetition_guard import is_repetition_dominated
from nanoagent.agent.verification import VerificationLedger
from nanoagent.agent.tools.cron import CronTool
from nanoagent.agent.tools.filesystem import AppendFileTool, EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from nanoagent.agent.tools.message import MessageTool
from nanoagent.agent.tools.registry import ToolRegistry
from nanoagent.agent.tools.shell import ExecTool
from nanoagent.agent.tools.browser import BrowserTool
from nanoagent.agent.tools.effector import EffectorTool
from nanoagent.agent.tools.effector_workflow import EffectorWorkflowTool
from nanoagent.agent.tools.effector_swarm import EffectorSwarmTool
from nanoagent.agent.tools.learn_from_recording import LearnFromRecordingTool
from nanoagent.agent.tools.voice_call import VoiceCallResultTool, VoiceCallTool
from nanoagent.agent.tools.clarify import ClarifyTool
from nanoagent.agent.tools.curate_skills import CurateSkillsTool
from nanoagent.agent.tools.usage_report import UsageReportTool
from nanoagent.agent.tools.deploy_check import DeployCheckTool
from nanoagent.agent.tools.web import WebFetchTool, WebMapTool, WebSearchTool
from nanoagent.agent.tools.classify import ClassifyTool
from nanoagent.agent.tools.url_check import UrlCheckTool
from nanoagent.agent.tools.extract_context import ExtractContextTool
from nanoagent.agent.tools.knowledge import SearchKnowledgeTool
from nanoagent.agent.tools.research import ResearchTool
from nanoagent.agent.tools.mcp_auth import McpAuthTool
from nanoagent.agent.tools.dynamic.generate import GenerateToolTool, RegisterToolFromDirTool, UpdateToolTool, RollbackToolTool
from nanoagent.agent.tools.dynamic.management import ListToolsTool, RemoveToolTool
from nanoagent.agent.tools.dynamic.persistence import ToolPersistence
from nanoagent.agent.tools.dynamic.loader import ToolLoader
from nanoagent.agent.tools.dynamic.health import ToolHealthMonitor
from nanoagent.agent.tools.gmail_send import GmailSendTool
from nanoagent.agent.tools.smtp_send import SmtpSendTool
from nanoagent.agent.tools.gmail_replies import GmailRepliesTool
from nanoagent.agent.tools.hn_search import HNSearchTool
from nanoagent.agent.tools.search import GlobSearchTool, GrepSearchTool
from nanoagent.agent.tools.todo import TodoWriteTool
from nanoagent.agent.tools.plan_mode import PlanModeState, EnterPlanModeTool, ExitPlanModeTool
from nanoagent.agent.tools.control import SleepTool
from nanoagent.agent.tools.emit_artifact import EmitArtifactTool
from nanoagent.agent.tools.python_repl import PythonReplTool
from nanoagent.agent.tools.search_memory import SearchMemoryTool
from nanoagent.agent.tools.append_memory import AppendMemoryTool
from nanoagent.agent.tools.search_crew_memory import SearchCrewMemoryTool
from nanoagent.agent.tools.save_skill import SaveSkillTool
from nanoagent.agent.tools.skill_search import SkillSearchTool
from nanoagent.agent.tools.session_search import SessionSearchTool
from nanoagent.agent.tools.http_request import HttpRequestTool
from nanoagent.agent.tools.github_api import GitHubAPITool
from nanoagent.agent.tools.test_runner import TestRunnerTool
from nanoagent.agent.tools.git_tool import GitTool
from nanoagent.agent.tools.sql_query import SqlQueryTool
from nanoagent.agent.tools.read_image import ReadImageTool
from nanoagent.agent.tools.read_pdf import ReadPdfTool
from nanoagent.agent.tools.register_webhook import RegisterWebhookTool
from nanoagent.agent.tools.notify import NotifyTool
from nanoagent.agent.tools.handoff_to import HandoffToTool
from nanoagent.agent.tools.reply_to_handoff import ReplyToHandoffTool
from nanoagent.agent.tools.find_agent import FindAgentTool
from nanoagent.agent.tools.borrow_tool import BorrowToolTool
from nanoagent.agent.tools.ask_agent import AskAgentTool
from nanoagent.agent.tools.send_message_to_agent import SendMessageToAgentTool
from nanoagent.agent.tools.self_manage import SelfManageTool
from nanoagent.agent.tools.delegate import DelegateTool, DelegateTaskTool, RunStatusTool, SteerRunTool
from nanoagent.agent.tools.self_report import SelfReportTool
from nanoagent.agent.tools.send_whatsapp import SendWhatsAppTool
from nanoagent.agent.tools.get_credential import GetCredentialTool
from nanoagent.agent.tools.bulletin import ReadBulletinTool, UpdateBulletinTool
from nanoagent.agent.tool_cache import ToolResultCache
from nanoagent.agent.error_classifier import classify_error, SHOULD_RETRY, RECOVERY_HINTS
from nanoagent.agent.tools.tool_search import ToolSearchTool
from nanoagent.agent.tools.mcp import ListMcpResourcesTool, ReadMcpResourceTool
from nanoagent.bus.events import InboundMessage, OutboundMessage
from nanoagent.bus.queue import MessageBus
from nanoagent.providers.base import LLMProvider, TurnSummary
from nanoagent.session.manager import Session, SessionManager
from nanoagent.config.nanocrew_settings import nanocrewSettings

from nanoagent.config.schema import ChannelsConfig, ExecToolConfig
from nanoagent.telemetry import JsonlSink, SessionTracer
from nanoagent.agent.permissions import (
    PermissionDecision,
    PermissionMode,
    PermissionPolicy,
    WorkspaceEnforcer,
)
from nanoagent.agent.security import fence_tool_result
from nanoagent.agent.hooks import HookAbortSignal, HookEvent, HookRunner
if TYPE_CHECKING:
    from nanoagent.cron.service import CronService


# Emit a structured progress event to stdout so nanocrew can parse and forward
# it to the dashboard in real time. Only active when CYCLE_ID is set (i.e. when
# nanoagent is running as a nanocrew agent container — not as a standalone chatbot).
# Progress streaming is active for any orchestrated cycle. One-shot containers set
# CYCLE_ID in env; the warm daemon doesn't (cycleId rides in the per-request payload),
# so it's identified by NANOBOT_PERSISTENT instead — otherwise progress (iteration +
# token counters) would silently stop in daemon mode.
_PROGRESS_ACTIVE = bool(os.environ.get("CYCLE_ID")) or os.environ.get("NANOBOT_PERSISTENT") == "on"

def _emit_progress(event: dict) -> None:
    if not _PROGRESS_ACTIVE:
        return
    import sys
    line = "NANOBOT_PROGRESS:" + json.dumps(event, separators=(",", ":"))
    print(line, flush=True, file=sys.stdout)


# A reply cut off at max_tokens with no tool call is continued this many times per turn
# before it is handed back marked incomplete.
_LENGTH_CONTINUE_MAX = 4

# The reply budget of a recovery call (see _RECOVERY_EFFORT).
_RECOVERY_MAX_TOKENS = 8192

# How often a long turn is reminded to keep its best result saved. Was 15 minutes, written
# when every cycle died at 50; there is no wall-clock limit now (src/agents/liveness.ts), so it
# only guards against a restart or crash.
_CHECKPOINT_EVERY_S = 30 * 60

# Proof of life while one tool call runs. The orchestrator ends a cycle that writes nothing
# for 30 minutes (src/agents/liveness.ts) — that, not a wall clock, is what has bounded a
# cycle since 2026-09-30. A model call or a step writes a line; a single long tool call
# writes none, and a browser or desktop task reports its steps over HTTP rather than stdout,
# so a legitimately long one would read as wedged. Beats stop after _HEARTBEAT_CAP_S, so a
# tool call that truly hangs still goes silent and is ended half an hour later.
_HEARTBEAT_EVERY_S = 60
_HEARTBEAT_CAP_S = 2 * 60 * 60


class _ToolHeartbeat:
    """``async with _ToolHeartbeat():`` around one tool call."""

    def __init__(self, every_s: float | None = None, cap_s: float | None = None):
        self._every = _HEARTBEAT_EVERY_S if every_s is None else every_s
        self._cap = _HEARTBEAT_CAP_S if cap_s is None else cap_s
        self._task: asyncio.Task | None = None

    async def _beat(self) -> None:
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        while True:
            await asyncio.sleep(self._every)
            elapsed = loop.time() - t0
            if elapsed > self._cap:
                return
            # No "tool" key: the dashboard counts any progress event carrying one as a tool
            # call. The orchestrator drops heartbeats before they reach the dashboard anyway.
            _emit_progress({"type": "heartbeat", "elapsed_s": int(elapsed)})

    async def __aenter__(self) -> "_ToolHeartbeat":
        self._task = asyncio.create_task(self._beat())
        return self

    async def __aexit__(self, *exc) -> None:
        if self._task is not None:
            self._task.cancel()


def _checkpoint_message(minutes: int) -> str:
    """The reminder, worded so it cannot be mistaken for a new task.

    Live 2026-10-01: the first wording — a "[System: …]" user message saying "write your best
    version now … so the work is not lost if this run is cut short" — arrived 28 minutes into a
    paced five-step task. The agent, whose session history was full of earlier cut-off runs,
    took it as a recovery job: it wrote notes about old cycles, then stopped and asked what its
    task had been, with three steps left. So it now says the task is unchanged and to carry on,
    and rides on the latest tool result rather than arriving as a turn of its own.
    """
    return (
        f"[Runtime reminder, not part of the tool output above and not a new instruction: you have "
        f"been working for {minutes} minutes. Your task has not changed — it is still the request "
        "at the start of this turn; carry on with its next step. If it produces a file or a "
        "result, keep your best version saved as you go so an interruption cannot lose it.]"
    )

# An empty reply (no text, no tool call) is answered with "continue" this many times per
# turn before the grace call asks for a summary.
_EMPTY_CONTINUE_MAX = 2
# The call right after a step ran out of room thinking, or came back empty, asks for low
# reasoning effort: the model has just shown it will deliberate instead of act. Measured on
# GLM 5.3 Flash: "low"
# spent 0–5 reasoning tokens where the default spent up to 28,884. OpenRouter models only;
# elsewhere the provider ignores it.
_RECOVERY_EFFORT = "low"


def _cut_tool_call_message(tool_name: str, max_tokens: int) -> str:
    """The result a tool call gets when the reply carrying it was cut off at the output limit."""
    return (
        f"[Not run: this {tool_name} call was cut off at the {max_tokens}-token output limit, "
        "so its arguments are incomplete and nothing was executed. Put less in one call: write "
        "a long file in parts (write_file with the first part, then append_file for the rest), "
        "or write a long script to a file first and run the file. Think briefly.]"
    )
_EMPTY_CONTINUE_MESSAGE = (
    "[System: Your last reply was empty — no text and no tool call — so nothing was done. "
    "Take the next step of your task now with a tool call, and think briefly. If you are "
    "truly finished, give your final answer. If you will not do this task, say so and why.]"
)


def _length_continue_message(max_tokens: int, had_text: bool) -> str:
    """What the model is told after a reply ran out of room before it acted."""
    what = ("Your reply was cut off" if had_text
            else "You used your whole reply thinking and were cut off before writing anything")
    return (
        f"[System: {what} at the {max_tokens}-token output limit, so nothing was done. "
        "Take the next step now with a tool call, and think briefly. Anything long — a "
        "file, a table, a report — goes out in parts: write_file with the first part, then "
        "append_file for the rest, each well under the limit.]"
    )


def _sanitize_tool_pairs(messages: list[dict]) -> list[dict]:
    """Repair tool-call / tool-result pairing so a compacted or reloaded history can
    never trip the provider's strict ordering ("Messages with role 'tool' must be a
    response to a preceding message with 'tool_calls'"). Drops orphan tool messages
    and strips tool_calls that have no matching responses. Well-formed histories pass
    through unchanged."""
    def _tcid(tc):
        return tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)

    result: list[dict] = []
    i, n = 0, len(messages)
    dropped = 0
    while i < n:
        m = messages[i]
        role = m.get("role")
        if role == "tool":
            # A tool message not consumed by a preceding assistant group is an orphan.
            dropped += 1
            i += 1
            continue
        if role == "assistant" and m.get("tool_calls"):
            # Gather the contiguous tool responses that follow this assistant.
            j = i + 1
            resp: dict = {}
            while j < n and messages[j].get("role") == "tool":
                tid = messages[j].get("tool_call_id")
                if tid is not None and tid not in resp:
                    resp[tid] = messages[j]
                j += 1
            kept_calls = [tc for tc in m["tool_calls"] if _tcid(tc) in resp]
            if kept_calls:
                if len(kept_calls) != len(m["tool_calls"]):
                    m = {**m, "tool_calls": kept_calls}
                result.append(m)
                for tc in kept_calls:
                    result.append(resp[_tcid(tc)])
                dropped += (j - i - 1) - len(kept_calls)
            else:
                # No responses present — demote to a plain assistant message,
                # but only if it still carries usable text. A pure tool-call turn
                # has empty content, so stripping tool_calls would leave an
                # assistant message with neither content nor tool_calls — which
                # strict providers reject ("content or tool_calls must be set",
                # DeepSeek). In that case drop the message entirely; nothing of
                # value is lost since its tool_calls had no responses anyway.
                demoted = {k: v for k, v in m.items() if k != "tool_calls"}
                if str(demoted.get("content") or "").strip():
                    result.append(demoted)
                else:
                    dropped += 1
                dropped += (j - i - 1)
            i = j
            continue
        result.append(m)
        i += 1
    # Final guard: a strict provider (DeepSeek) rejects any assistant message
    # with neither content nor tool_calls ("content or tool_calls must be set").
    # These can arise from a reasoning-only turn (empty content + reasoning_content,
    # no tool call) that got persisted, or from the demote path above. Drop them —
    # reasoning_content alone does not satisfy the provider and carries no value
    # for the next turn.
    cleaned: list[dict] = []
    for m in result:
        if (
            m.get("role") == "assistant"
            and not m.get("tool_calls")
            and not str(m.get("content") or "").strip()
        ):
            dropped += 1
            continue
        cleaned.append(m)
    result = cleaned
    if dropped:
        logger.warning("sanitize_tool_pairs: repaired history, dropped {} orphan/empty message(s)", dropped)
    return result


class AgentLoop:
    """
    The agent loop is the core processing engine.

    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """

    _TOOL_RESULT_MAX_CHARS = 500

    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int = 90,
        temperature: float = 0.1,
        max_tokens: int = 4096,
        memory_window: int = 100,
        brave_api_key: str | None = None,
        exec_config: ExecToolConfig | None = None,
        cron_service: CronService | None = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        mcp_servers: dict | None = None,
        channels_config: ChannelsConfig | None = None,
        tracer: SessionTracer | None = None,
        permission_policy: PermissionPolicy | None = None,
        hook_runner: HookRunner | None = None,
        nanocrew_settings: nanocrewSettings | None = None,
        extra_read_dirs: list[Path] | None = None,
    ):
        self.bus = bus
        self.channels_config = channels_config
        self.provider = provider
        self.workspace = workspace
        # Extra read-only roots the file tools may read beyond the workspace (e.g. the
        # agent's private mount while it works inside a project).
        self._extra_read_dirs = list(extra_read_dirs or [])
        self.model = model or provider.get_default_model()
        self.max_iterations = max_iterations
        self.temperature = temperature
        self.max_tokens = max_tokens
        # Set by the caller: returns a message when the model stops before the caller's own
        # condition for "finished" holds, or None. See _run_agent_loop and worker_policy.py.
        self.stop_check: Callable[[], str | None] | None = None
        self.memory_window = memory_window
        self.brave_api_key = brave_api_key
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.restrict_to_workspace = restrict_to_workspace

        self.sessions = session_manager or SessionManager(workspace)
        self.tools = ToolRegistry()
        
        # Initialize Job Context
        self.job_id = os.environ.get("JOB_ID")
        if self.job_id:
            logger.info(f"Initialized AgentLoop with JOB_ID: {self.job_id}")
        
        # Initialize Persistence and Loader for Dynamic Tools
        self.persistence = ToolPersistence(workspace / "tools")
        # Phase 5a — one health monitor, persisted across cycles, threaded into every
        # DynamicTool so runtime success-rate/latency are tracked and a failing tool
        # auto-rolls-back. (Previously the monitor existed but was never instantiated.)
        self.health_monitor = ToolHealthMonitor(persist_path=str(workspace / "tools" / "_health.json"))
        self.loader = ToolLoader(self.persistence, self.tools, health_monitor=self.health_monitor)
        
        self.context = ContextBuilder(
            workspace,
            dynamic_loader=self.loader,
            permission_mode=None,  # set below after policy is resolved
        )
        # Load the four-tier nanocrewSettings (user → project → local → env).
        # Explicit arguments always win over what the settings file says, so
        # callers that construct the loop programmatically keep full control.
        self._nc_settings = nanocrew_settings or nanocrewSettings.load(workspace)

        # Compaction thresholds — driven by settings, can still be overridden
        # by explicit env vars (already handled inside nanocrewSettings.load).
        self._compact_threshold = self._nc_settings.compaction.threshold_tokens
        self._compact_keep_tail = self._nc_settings.compaction.keep_tail
        self._last_compaction_at: int = 0  # Anti-thrash: track last compaction iteration
        self._model_router = ModelRouter()
        self._adaptive_temp = AdaptiveTemperature(base=self.temperature)
        self._available_keys: dict[str, str] = {
            "claude": os.environ.get("ANTHROPIC_API_KEY", ""),
            "gemini": os.environ.get("GEMINI_API_KEY", ""),
            "openai": os.environ.get("OPENAI_API_KEY", ""),
        }

        # Telemetry tracer — settings drive log_dir; explicit tracer arg wins.
        if tracer is not None:
            self.tracer = tracer
        else:
            log_dir = (
                Path(self._nc_settings.telemetry.log_dir)
                if self._nc_settings.telemetry.log_dir
                else None
            )
            self.tracer = SessionTracer(
                session_id="default",
                sink=JsonlSink(
                    session_id="default",
                    workspace=workspace,
                    log_dir=log_dir,
                ),
            )

        # Hook abort signal — shared with the hook runner so Ctrl-C kills hooks.
        self._hook_abort = HookAbortSignal()

        # Permission policy — explicit arg wins; otherwise built from settings.
        if permission_policy is not None:
            self.policy = permission_policy
        else:
            self.policy = self._nc_settings.build_permission_policy()

        # Workspace enforcer — hard filesystem boundary for write ops.
        self.enforcer = WorkspaceEnforcer(workspace=workspace)

        # Hook runner — explicit arg wins; otherwise built from settings.
        if hook_runner is not None:
            self.hooks = hook_runner
        else:
            self.hooks = self._nc_settings.build_hook_runner(
                workspace=workspace,
                abort_signal=self._hook_abort,
            )

        # Item 4: set permission mode banner on context builder now that policy is resolved
        self.context.permission_mode = getattr(self.policy, "_mode", None) and self.policy._mode.name

        # Item 2: session-level activity counters for workspace awareness
        import time as _time_mod
        self._session_start_time: float = _time_mod.time()
        self._session_tool_count: int = 0

        self._running = False
        self._mcp_servers = mcp_servers or {}
        self._mcp_stack: AsyncExitStack | None = None
        self._mcp_connected = False
        self._mcp_connecting = False
        self._consolidating: set[str] = set()  # Session keys with consolidation in progress
        self._consolidation_tasks: set[asyncio.Task] = set()  # Strong refs to in-flight tasks
        self._consolidation_locks: dict[str, asyncio.Lock] = {}
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        self._processing_lock = asyncio.Lock()
        self._register_default_tools()
        # Constructed after the tools exist — the reviewer builds its restricted
        # registry from this one. Inert unless NANOAGENT_BACKGROUND_REVIEW is on.
        self._reviewer = BackgroundReviewer(self)
        # Stage 42 #10 — transparent workspace snapshots. Never registered as a
        # tool: the model must not be able to skip, forge or roll back its own
        # safety net.
        self._checkpoints = CheckpointStore(self.workspace)

    def _register_default_tools(self) -> None:
        """Register the default set of tools."""
        allowed_dir = self.workspace if self.restrict_to_workspace else None
        # Read tools get extra read-only roots (e.g. the private mount in project mode);
        # write tools stay confined to the workspace.
        self.tools.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir, extra_read_dirs=self._extra_read_dirs))
        self.tools.register(ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir, extra_read_dirs=self._extra_read_dirs))
        for cls in (WriteFileTool, AppendFileTool, EditFileTool):
            self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(ExecTool(
            working_dir=str(self.workspace),
            timeout=self.exec_config.timeout,
            restrict_to_workspace=self.restrict_to_workspace,
            path_append=self.exec_config.path_append,
        ))
        self.tools.register(WebSearchTool(api_key=self.brave_api_key))
        self.tools.register(WebFetchTool())
        self.tools.register(WebMapTool())
        self.tools.register(UrlCheckTool())
        self.tools.register(ClassifyTool())
        self.tools.register(BrowserTool(workspace=self.workspace))
        # Stage 60 phases 4-5: the user's own computer, via the desktop app.
        from nanoagent.agent.tools.local_computer import LocalDesktopTool, LocalFilesTool, LocalTerminalTool
        self.tools.register(LocalFilesTool(workspace=self.workspace))
        self.tools.register(LocalTerminalTool())
        self.tools.register(LocalDesktopTool(workspace=self.workspace))
        from nanoagent.agent.tools.queue_for_my_computer import QueueForMyComputerTool
        self.tools.register(QueueForMyComputerTool())
        self.tools.register(DeployCheckTool())
        self.tools.register(MessageTool(send_callback=self.bus.publish_outbound))
        self.tools.register(ExtractContextTool())
        self.tools.register(SearchKnowledgeTool())
        # Merged 2026-08-29 from feat/research-super-tool, which shipped the tool but
        # never registered it — exported from tools/__init__.py and callable by nobody.
        # `provider` is the only constructor arg that does real work: the adversarial
        # audit's JudgeAgent is skipped entirely without one (research.py:326).
        self.tools.register(ResearchTool(
            workspace=self.workspace,
            provider=self.provider,
            primary_model=self.model,
        ))
        self.tools.register(McpAuthTool(
            workspace=self.workspace,
            mcp_server_names=list((self._nc_settings.mcp_servers or {}).keys()),
        ))

        # File-system search (injection-safe alternatives to exec+find/grep)
        self.tools.register(GlobSearchTool(workspace=self.workspace))
        self.tools.register(GrepSearchTool(workspace=self.workspace))

        # Meta-tools: task management, planning, control flow
        self.tools.register(TodoWriteTool())
        self._plan_mode_state = PlanModeState()
        self.tools.register(EnterPlanModeTool(self._plan_mode_state))
        self.tools.register(ExitPlanModeTool(self._plan_mode_state))
        self.tools.register(SleepTool())
        self.tools.register(EmitArtifactTool())
        self.tools.register(PythonReplTool(registry=self.tools))
        self.tools.register(SearchMemoryTool())
        self.tools.register(AppendMemoryTool())
        self.tools.register(SearchCrewMemoryTool())
        self.tools.register(SaveSkillTool(self.workspace))
        self.tools.register(SkillSearchTool(self.workspace))
        self.tools.register(SessionSearchTool(self.sessions.sessions_dir))
        self.tools.register(HttpRequestTool())
        self.tools.register(GitHubAPITool())
        self.tools.register(TestRunnerTool(self.workspace))
        self.tools.register(GitTool())
        self.tools.register(SqlQueryTool())
        # read_image needs a VISION-capable model. The agent's primary model (e.g. deepseek-v4,
        # text-only) can't see images, so route read_image to a multimodal model. Default
        # gemini-2.0-flash; override with VISION_MODEL (e.g. groq/llama-3.2-90b-vision-preview,
        # moonshot/..., or a paid gemini key) to escape free-tier rate limits. The right API key is
        # resolved from the provider registry. Falls back to the primary model if no key is found.
        _vision_provider, _vision_model = self.provider, self.model
        try:
            from nanoagent.providers import LiteLLMProvider
            from nanoagent.providers.registry import find_by_model
            # Default vision model. Override with VISION_MODEL.
            #
            # Was moonshot/moonshot-v1-8k-vision-preview. Measured 2026-09-20 on prod: that
            # model answers NotFound ("Not found the model ... or Permission denied") even
            # with the key set, and warm-daemon cycles never receive VISION_MODEL — so every
            # read_image call and every Effector vision fallback in a normal cycle hit a dead
            # model (found when a stage 61 test run on about:blank fell back to vision and
            # every decision failed). gemini-3.6-flash, already Effector's decider, read a
            # test image correctly in the same check.
            _vm = os.environ.get("VISION_MODEL") or (
                "gemini/gemini-3.6-flash" if os.environ.get("GEMINI_API_KEY")
                else "moonshot/moonshot-v1-8k-vision-preview"
            )
            _spec = find_by_model(_vm)
            _vkey = ""
            if _spec and _spec.env_key:
                _vkey = os.environ.get(_spec.env_key, "")
                if not _vkey:
                    # The operator may store the key under a provider-branded name (e.g.
                    # MOONSHOT_KIMI_API_KEY for the 'moonshot' provider whose env_key is
                    # MOONSHOT_API_KEY). Scan env for a var matching the provider keywords.
                    for _kw in (_spec.keywords or ()):
                        for _en, _ev in os.environ.items():
                            if _ev and _kw.upper() in _en.upper() and "API_KEY" in _en.upper():
                                _vkey = _ev
                                break
                        if _vkey:
                            break
            if _vkey:
                _vision_provider = LiteLLMProvider(api_key=_vkey, default_model=_vm)
                _vision_model = _vm
        except Exception:
            pass  # keep the primary as a best-effort fallback
        self.tools.register(ReadImageTool(provider=_vision_provider, model=_vision_model))

        # effector's per-step decisions default to model_router's "tool_heavy" tier
        # (cheap/fast — a single task can run dozens of turns) rather than the primary
        # model, falling back to the primary provider/model when no separate key is
        # configured for that tier. Reuses _vision_provider/_vision_model computed
        # above for the resolver's vision-fallback layer — same use case (a
        # vision-capable model finding pixel coordinates), no need to resolve twice.
        _effector_decision_provider, _effector_decision_model = self.provider, self.model
        try:
            # Stage 61 phase 2: an agent can opt into a different per-step decider
            # (config.task_models.effector_decision → EFFECTOR_DECISION_MODEL). Measured
            # live 2026-09-20: gemini-3.5-flash-lite passed 17/17 verified tasks, 12%
            # faster than the tool_heavy default. Opt-in per agent, never a default.
            _override = os.environ.get("EFFECTOR_DECISION_MODEL", "").strip()
            _resolved = self._model_router.resolve("tool_heavy", self._available_keys)
            if _override:
                from nanoagent.providers import LiteLLMProvider
                _prefix = _override.split("/")[0]
                _okey = os.environ.get({"openrouter": "OPENROUTER_API_KEY", "gemini": "GEMINI_API_KEY",
                                        "deepseek": "DEEPSEEK_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
                                       .get(_prefix, f"{_prefix.upper()}_API_KEY"), "")
                if _okey:
                    _effector_decision_model = _override
                    _effector_decision_provider = LiteLLMProvider(api_key=_okey, default_model=_override)
                    _resolved = None
            if _resolved:
                _decision_key, _effector_decision_model = _resolved
                from nanoagent.providers import LiteLLMProvider
                _effector_decision_provider = LiteLLMProvider(api_key=_decision_key, default_model=_effector_decision_model)
        except Exception:
            pass  # keep the primary as a best-effort fallback

        # Phase 4 (synthesis): a mid-task-synthesized driver should get the same
        # judgment tier as any other hard replanning decision, not the cheap
        # tool_heavy tier the per-step loop runs on the rest of the time — reuses
        # model_router's "reasoning" tier the same way tool_heavy was resolved above.
        _effector_synthesis_provider, _effector_synthesis_model = self.provider, self.model
        try:
            _resolved = self._model_router.resolve("reasoning", self._available_keys)
            if _resolved:
                _synthesis_key, _effector_synthesis_model = _resolved
                from nanoagent.providers import LiteLLMProvider
                _effector_synthesis_provider = LiteLLMProvider(api_key=_synthesis_key, default_model=_effector_synthesis_model)
        except Exception:
            pass  # keep the primary as a best-effort fallback

        # Stage 61 phase 7: the desktop loop decides with the same per-step decider as
        # Effector (including an agent's opt-in EFFECTOR_DECISION_MODEL).
        from nanoagent.agent.tools.desktop_task import DesktopTaskTool
        self.tools.register(DesktopTaskTool(
            workspace=self.workspace, provider=_effector_decision_provider, model=_effector_decision_model,
        ))

        self.tools.register(EffectorTool(
            workspace=self.workspace,
            provider=self.provider,
            model=self.model,
            decision_provider=_effector_decision_provider,
            decision_model=_effector_decision_model,
            vision_provider=_vision_provider,
            vision_model=_vision_model,
            tool_registry=self.tools,
            tool_persistence=self.persistence,
            job_id=self.job_id,
            health_monitor=self.health_monitor,
            synthesis_provider=_effector_synthesis_provider,
            synthesis_model=_effector_synthesis_model,
        ))
        self.tools.register(EffectorWorkflowTool(
            workspace=self.workspace,
            provider=self.provider,
            model=self.model,
            decision_provider=_effector_decision_provider,
            decision_model=_effector_decision_model,
            vision_provider=_vision_provider,
            vision_model=_vision_model,
            tool_registry=self.tools,
            tool_persistence=self.persistence,
            job_id=self.job_id,
            health_monitor=self.health_monitor,
            synthesis_provider=_effector_synthesis_provider,
            synthesis_model=_effector_synthesis_model,
        ))
        self.tools.register(EffectorSwarmTool(
            workspace=self.workspace,
            provider=self.provider,
            model=self.model,
            decision_provider=_effector_decision_provider,
            decision_model=_effector_decision_model,
            vision_provider=_vision_provider,
            vision_model=_vision_model,
            tool_registry=self.tools,
            tool_persistence=self.persistence,
            job_id=self.job_id,
            health_monitor=self.health_monitor,
            synthesis_provider=_effector_synthesis_provider,
            synthesis_model=_effector_synthesis_model,
        ))
        self.tools.register(LearnFromRecordingTool(workspace=self.workspace))

        # Voice (agent/voice) — outbound calling. OWNER_ID identifies the NanoCrew
        # user; the voice tenant (their carrier account, persona, calling rules) is
        # resolved from it at call time. With no OWNER_ID, or an owner who has not
        # connected a carrier account, both tools register but refuse every call
        # with a "not provisioned" message rather than falling back to another
        # tenant's phone identity. Registering them unprovisioned (instead of
        # hiding them) is deliberate: the model gets an explanation it can relay to
        # the user, instead of silently lacking the capability it was just asked for.
        _voice_owner = os.environ.get("OWNER_ID") or None
        self.tools.register(VoiceCallTool(owner_id=_voice_owner))
        self.tools.register(VoiceCallResultTool(owner_id=_voice_owner))

        self.tools.register(ReadPdfTool())
        self.tools.register(RegisterWebhookTool())
        self.tools.register(NotifyTool())
        self.tools.register(HandoffToTool())
        self.tools.register(ReplyToHandoffTool())
        self.tools.register(FindAgentTool())
        # Handed the live registry: an authorised borrow has to put the tool back in
        # front of the model on this turn, or the borrow succeeds on the server and does
        # nothing observable here — which reads to a model as a broken tool.
        self.tools.register(BorrowToolTool(registry=self.tools))
        self.tools.register(AskAgentTool())
        self.tools.register(SendMessageToAgentTool())
        # Self-management + the real WhatsApp send path. Both authenticate with the
        # per-cycle token the orchestrator puts in the request payload, and both no-op
        # with a clear error outside a NanoCrew cycle (standalone nanoagent has no
        # orchestrator to call).
        self.tools.register(SelfManageTool())
        # Stage 57: hand work to workers. Same cycle-token auth; a worker has no token, and
        # the adapter's allowlist removes these from it anyway.
        self.tools.register(DelegateTool())
        self.tools.register(DelegateTaskTool())
        self.tools.register(RunStatusTool())
        self.tools.register(SteerRunTool())
        self.tools.register(SelfReportTool())
        self.tools.register(SendWhatsAppTool())
        self.tools.register(GetCredentialTool())
        self.tools.register(ReadBulletinTool())
        self.tools.register(UpdateBulletinTool())

        # Tool discovery (deferred schema loading for large catalogs)
        self.tools.register(ToolSearchTool(registry=self.tools))

        # MCP resource browsing
        self.tools.register(ListMcpResourcesTool(registry=self.tools))
        self.tools.register(ReadMcpResourceTool(registry=self.tools))

        # Dynamic Tool Factory
        self.tools.register(GenerateToolTool(registry=self.tools, persistence=self.persistence, job_id=self.job_id, health_monitor=self.health_monitor))
        self.tools.register(RegisterToolFromDirTool(registry=self.tools, persistence=self.persistence, job_id=self.job_id, workspace=self.workspace, health_monitor=self.health_monitor))
        self.tools.register(UpdateToolTool(registry=self.tools, persistence=self.persistence, job_id=self.job_id, health_monitor=self.health_monitor))
        self.tools.register(RollbackToolTool(registry=self.tools, persistence=self.persistence, job_id=self.job_id, health_monitor=self.health_monitor))
        self.tools.register(ListToolsTool(registry=self.tools))
        self.tools.register(RemoveToolTool(registry=self.tools))
        if self.cron_service:
            self.tools.register(CronTool(self.cron_service))

        # HITL approval layer
        from nanoagent.agent.tools.request_approval import RequestApprovalTool
        self.tools.register(RequestApprovalTool())
        self.tools.register(ClarifyTool())
        # Stage 60 phase 3: approve a list of sends from the user's browser once.
        from nanoagent.agent.tools.request_batch_approval import RequestBatchApprovalTool
        self.tools.register(RequestBatchApprovalTool())
        self.tools.register(CurateSkillsTool(self.workspace))
        self.tools.register(UsageReportTool(self.workspace))

        # External service tools — fail gracefully at execute time if credentials not set
        self.tools.register(GmailSendTool(workspace=self.workspace))
        self.tools.register(SmtpSendTool(workspace=self.workspace))
        self.tools.register(GmailRepliesTool(workspace=self.workspace))
        self.tools.register(HNSearchTool())

        # Load persisted dynamic tools
        dynamic_loaded = self.loader.load_persisted_tools(job_id=self.job_id)
        if dynamic_loaded > 0:
            logger.info("Dynamic tools ready.")

        # Deferred-tools mode (claw-code style): advertise only a lean CORE set in the
        # schema payload; every other tool stays registered/executable and is loadable
        # on demand via tool_search. This cuts ~half the per-call tool-schema tokens
        # (~57% of the prompt) with no capability loss. Flag-gated for safe A/B.
        import os as _os_dt
        if _os_dt.environ.get("DEFERRED_TOOLS") == "on":
            _CORE_TOOLS = {
                # discovery / loader (must stay so the model can pull the rest)
                "tool_search", "list_tools",
                # file I/O
                "read_file", "write_file", "edit_file", "append_file", "list_dir",
                "glob_search", "grep_search",
                # execution
                "exec", "python_repl", "run_tests",
                # web
                "web_search", "web_fetch", "web_map", "url_check",
                # sorting many things at once — advertised rather than deferred for the
                # reason effector is. The trigger is "score these leads" or "which of
                # these replies are interested", a job, not a tool name, so nothing
                # prompts a tool_search for "classify". Deferred, the model does what it
                # already knows how to do: reason about each item in turn, one 3 s model
                # call each, which is exactly the cost this tool exists to remove.
                "classify",
                # memory / knowledge / skills
                "search_memory", "append_memory", "search_crew_memory", "search_knowledge", "skill_search", "session_search",
                # planning
                "enter_plan_mode", "exit_plan_mode", "todo_write",
                # comms / vcs (commonly needed). `message` is deliberately absent: it has
                # no outbound consumer on the NanoCrew path (the adapter unregisters it),
                # and this CORE set only applies when DEFERRED_TOOLS is on, which only
                # NanoCrew sets. send_whatsapp is the delivery path that actually works.
                "git", "send_whatsapp",
                # self-management — must be advertised, not deferred: the trigger is the
                # owner saying "change your schedule" in chat, and an agent that has to
                # first guess this tool exists in order to tool_search for it will instead
                # answer that it cannot do that.
                "self_manage",
                # asking the human — advertised for exactly the reason self_manage is,
                # and confirmed live 2026-09-02 (stage 49 phase 3, a live cycle. The
                # trigger for `clarify` is an internal state — "I was not given a value I
                # need" — not a keyword the model would think to tool_search for. Mechanic
                # was asked to fill a form and told to ask rather than guess; it searched
                # only for `effector`, never found `clarify`, and ended the cycle with the
                # question in prose. Deferring the tool whose whole purpose is to stop an
                # agent guessing means it guesses, or stops.
                "clarify",
                # reading your own history — advertised for the same reason again, and for
                # the same reason it exists at all. The trigger is someone asking "what
                # have you done", and the fallback when the tool is not in front of the
                # model is not "no answer" but a confident wrong one: Finder answered that
                # question by counting the sweep-results files in its workspace and
                # reporting 210 cycles, when it had run 458. An agent does not know it is
                # missing a fact about itself, so it will not tool_search for one.
                "self_report",
                # handing work to another agent (manager agents need this immediately)
                "handoff_to",
                # answering a teammate — advertised for the same reason handoff_to is,
                # and for one more: the trigger arrives in the cycle context (a message
                # addressed to you), so a model that has to first guess this tool exists
                # will do the work and say nothing. That silence is what stage 56 exists
                # to end — two agents invented a reply field inside a JSON payload rather
                # than go looking for a channel.
                "reply_to_handoff",
                # discovery and borrowing — advertised for the same reason. The trigger
                # for find_agent is realising you cannot do something, and the fallback
                # when it is not in front of the model is not "search for a tool" but
                # "conclude it is impossible" or "invent a teammate". Measured 2026-09-08:
                # the whole live network was the three-node chain its three prompts named,
                # because nothing could be discovered that a prompt had not already said.
                "find_agent", "borrow_tool", "ask_agent",
                # workers (stage 57) — advertised for the same reason. "Research these five
                # companies" names a job, not a tool; with delegate deferred the agent does
                # the five one after another, which is the slowness it exists to remove.
                "delegate", "run_status",
                # handing the owner a deliverable — advertised for the same reason. Asked
                # to "create the artifact" (2026-09-14), Mechanic could not see this tool,
                # wrote an HTML file, and its owner found an empty Artifacts tab. The request
                # names a thing, not a tool, so nothing prompts a tool_search for it.
                "emit_artifact",
                # the user's own computer (stage 60) — advertised for the same reason
                # again. The trigger is "on my computer" / "save it to my Documents", a
                # place, not a tool name. Live test 2026-09-17: with these deferred, the
                # first move on "read the file on my computer" was a tool_search round
                # trip. The set is fixed for a warm daemon's life while This computer is
                # a per-message choice, so they are always listed; each one explains
                # itself when the computer is not available.
                "local_files", "local_terminal", "local_desktop", "desktop_task",
                "request_batch_approval", "queue_for_my_computer",
                # doing something on a website — advertised for exactly the reason given
                # just above, measured again 2026-09-21. "Play this song on YouTube
                # Music" names a task, not a tool, so nothing prompts a search for
                # "effector". The agent spent TWO model calls on tool_search before it
                # could start: ~28 s of a 133 s cycle, more than half of which was the
                # agent deciding rather than doing.
                #
                # Their schemas are not small, and that is the trade being made
                # deliberately: a few hundred tokens on every call against two extra
                # round trips on every browser task.
                "effector", "browser",
            }
            self.tools.enable_deferral(_CORE_TOOLS)
            logger.info(
                "Deferred-tools mode ON: {} core advertised, {} loadable on demand",
                len(self.tools.get_definitions()), len(self.tools.deferred_names()),
            )

    async def _connect_mcp(self) -> None:
        """Connect to configured MCP servers (one-time, lazy).

        Uses the structured McpStartupReport so failures are logged clearly
        and surfaced in telemetry without aborting the agent.
        """
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        self._mcp_connecting = True
        from nanoagent.agent.tools.mcp import connect_mcp_servers, McpStartupReport
        try:
            self._mcp_stack = AsyncExitStack()
            await self._mcp_stack.__aenter__()
            report: McpStartupReport = await connect_mcp_servers(
                self._mcp_servers, self.tools, self._mcp_stack
            )
            self._mcp_connected = True

            # Log the degraded-startup report (always shown, even if all ok)
            logger.info("MCP startup:\n{}", report.render())

            # Record in telemetry
            self.tracer.record("mcp_startup", {
                "started": report.started,
                "failed": [{"server": s, "error": e} for s, e in report.failed],
                "disabled": report.disabled,
            })

            # Emit lane events for each failed server so the policy engine
            # can classify and route recovery (McpStartup failure class)
            for server_name, error_msg in report.failed:
                self.tracer.record("mcp_startup_failed", {
                    "server": server_name,
                    "error": error_msg,
                })

        except Exception as e:
            logger.error("Failed to connect MCP servers (will retry next message): {}", e)
            if self._mcp_stack:
                try:
                    await self._mcp_stack.aclose()
                except Exception:
                    pass
                self._mcp_stack = None
        finally:
            self._mcp_connecting = False

    def _set_tool_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        """Update context for all tools that need routing info."""
        for name in ("message", "cron"):
            if tool := self.tools.get(name):
                if hasattr(tool, "set_context"):
                    if name == "message":
                        tool.set_context(channel, chat_id, message_id)
                    else:
                        tool.set_context(channel, chat_id)

    @staticmethod
    def _strip_think(text: str | None) -> str | None:
        """Remove <think>…</think> blocks that some models embed in content."""
        if not text:
            return None
        return re.sub(r"<think>[\s\S]*?</think>", "", text).strip() or None

    @staticmethod
    def _tool_hint(tool_calls: list) -> str:
        """Format tool calls as concise hint, e.g. 'web_search("query")'."""
        def _fmt(tc):
            args = tc.arguments
            if isinstance(args, dict):
                val = next(iter(args.values()), None) if args else None
            elif isinstance(args, list):
                val = args[0] if args else None
            else:
                val = None
            if not isinstance(val, str):
                return tc.name
            return f'{tc.name}("{val[:40]}…")' if len(val) > 40 else f'{tc.name}("{val}")'
        return ", ".join(_fmt(tc) for tc in tool_calls)

    async def _check_interrupt(self) -> bool:
        """Poll NanyClaw for a soft interrupt flag. Non-blocking, non-fatal."""
        import asyncio as _asyncio
        agent_id = os.environ.get("AGENT_ID")
        nanocrew_host = os.environ.get("NanoCrew_HOST")
        if not agent_id or not nanocrew_host:
            return False
        try:
            import httpx
            resp = await _asyncio.wait_for(
                httpx.AsyncClient().get(
                    f"{nanocrew_host}/api/agents/{agent_id}/interrupt-flag",
                    timeout=2.0,
                ),
                timeout=3.0,
            )
            return resp.json().get("interrupted", False)
        except Exception:
            return False  # Network error → continue; never self-interrupt

    async def _check_steering(self) -> list[str]:
        """Anything the owner has said to this run since the last iteration.

        stage45 item 5 built this mailbox for effector's own turn loop — a note lands
        there, and effector's react_loop polls it on every turn. Nothing polled it up
        here, in the loop that actually decides WHAT to search for or WHERE to navigate.
        Measured live 2026-09-22: the owner asked for "Sammi Meri Waar srivas" (a typo —
        the song is just "Sammi Meri Waar"), realised it mid-cycle, and had no way to say
        so — by the time effector was running, the bad search was already the page it was
        clicking around on. A note sent then had nowhere to land.

        So this polls the same mailbox at the same boundary _check_interrupt already
        polls, and a note becomes a plain user message in `messages` — no accumulation
        logic needed here the way effector needs it: `messages` is the real, growing
        conversation, so anything appended stays visible on every later iteration for
        free. Effector's per-turn prompt is rebuilt from scratch each turn and has no
        such memory, which is the whole reason IT had to re-show notes by hand.

        Non-blocking, non-fatal: a run must never break, slow down materially, or lose a
        turn because nobody was talking to it or the mailbox was unreachable.
        """
        agent_id = os.environ.get("AGENT_ID")
        cycle_id = os.environ.get("CYCLE_ID")
        nanocrew_host = os.environ.get("NanoCrew_HOST")
        token = os.environ.get("NANOCREW_CYCLE_TOKEN", "")
        if not (agent_id and cycle_id and nanocrew_host and token):
            return []
        try:
            import httpx
            resp = await asyncio.wait_for(
                httpx.AsyncClient().get(
                    f"{nanocrew_host}/api/agents/{agent_id}/self/steer",
                    params={"cycleId": cycle_id},
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=2.0,
                ),
                timeout=3.0,
            )
            notes = resp.json().get("notes")
            return [str(n) for n in notes][:5] if isinstance(notes, list) else []
        except Exception:
            return []  # the mailbox is an optimisation; a run must survive without it

    # Per-message cap when archiving evicted context. The archive exists to be
    # grep-searchable, not to be a verbatim transcript — an uncapped copy of every tool
    # result would grow HISTORY.md faster than anyone (or any agent) could search it.
    _HISTORY_ARCHIVE_CHARS = 2000

    def _archive_to_history(self, segment: list[dict]) -> bool:
        """Write messages that compaction is about to discard into memory/HISTORY.md.

        Phase 4 was previously a pure delete — the only one of the four phases leaving
        no record at all. That made in-turn compaction strictly lossier than the
        cross-turn consolidator, which archives everything it evicts, and the two never
        met: consolidation triggers on session message count, so a long tool-heavy turn
        could compact several times and consolidate zero times, destroying a fifth of
        its own history with nothing written down anywhere.

        HISTORY.md is the grep-searchable half of the memory store, so archiving here
        turns an unrecoverable drop into a retrievable one — the notice left behind in
        the context tells the agent where to look, and it has grep_search to look with.

        Never raises: losing the archive is bad, failing the whole turn over it is worse.
        """
        from datetime import datetime
        try:
            lines: list[str] = []
            for m in segment:
                content = m.get("content")
                if isinstance(content, list):   # provider tool-result block form
                    content = " ".join(
                        str(b.get("text") or b.get("content") or "")
                        for b in content if isinstance(b, dict)
                    )
                text = str(content or "").strip()
                if not text:
                    continue
                if len(text) > self._HISTORY_ARCHIVE_CHARS:
                    text = text[:self._HISTORY_ARCHIVE_CHARS] + "…[truncated]"
                calls = m.get("tool_calls")
                tag = f" [tool_calls: {len(calls)}]" if calls else ""
                lines.append(f"- {str(m.get('role', '?')).upper()}{tag}: {text}")
            if not lines:
                return False
            stamp = datetime.now().isoformat(timespec="minutes")
            MemoryStore(self.workspace).append_history(
                f"[{stamp}] Archived by context compaction — {len(lines)} messages "
                f"evicted from the live context of an in-progress turn.\n" + "\n".join(lines)
            )
            return True
        except Exception as exc:
            logger.warning("Could not archive compacted context to HISTORY.md ({})", exc)
            return False

    async def _compact_messages(self, messages: list[dict]) -> list[dict]:
        """4-phase tiered context compaction — matches and exceeds Hermes's compaction quality.

        Layout after compaction:
          [0] system prompt          — always kept verbatim
          [1] first user message     — always kept (anchors task context)
          [N] phase-4 notice         — oldest block dropped (lossy, logged)
          [N] phase-3 summary        — old block compressed at high ratio (Haiku)
          [N] phase-2 summary        — medium block compressed at moderate ratio (Haiku)
          [-keep_tail:] tail         — recent messages kept verbatim

        Phase boundaries (fraction of compressible span):
          Phase 4 (drop)   : 0%  – 20%   oldest, most stale — discarded
          Phase 3 (heavy)  : 20% – 45%   old — compressed at high ratio, 256 tok
          Phase 2 (medium) : 45% – 70%   medium — compressed at moderate ratio, 512 tok
          Phase 1 (tail)   : 70% – 100%  recent — kept verbatim in tail
        """
        keep_tail = self._compact_keep_tail
        min_len = 2 + keep_tail + 1
        if len(messages) <= min_len:
            return messages

        head = messages[:2]
        tail_start = len(messages) - keep_tail

        # Align tail_start to message boundaries (never split tool-call pairs)
        while tail_start > 2 and messages[tail_start].get("role") == "tool":
            tail_start -= 1
        while (
            tail_start > 2
            and messages[tail_start - 1].get("role") == "assistant"
            and messages[tail_start - 1].get("tool_calls")
        ):
            tail_start -= 1

        tail = messages[tail_start:]
        compressible = messages[2:tail_start]
        span = len(compressible)

        if span == 0:
            return messages

        # ── Phase boundaries ─────────────────────────────────────────────────
        b4 = int(span * 0.20)   # 0  – 20%  → drop
        b3 = int(span * 0.45)   # 20 – 45%  → heavy compress
        b2 = int(span * 0.70)   # 45 – 70%  → medium compress
        # 70 – 100% → phase-1 (verbatim) — already in tail via keep_tail; if
        # keep_tail is shorter than 30% of span we keep it in phase-2 band too.

        # ── Boundary alignment ───────────────────────────────────────────────
        # The tail boundary is already aligned (lines 470-477). Phase boundaries
        # inside `compressible` must be aligned the same way: never split a
        # tool_calls / tool-response group across phases. If we did, the
        # assistant message gets summarised into text-only (losing the tool_calls
        # field) while the tool responses survive verbatim in a later phase —
        # producing orphan tool messages that DeepSeek's strict API rejects with
        # "Messages with role 'tool' must be a response to a preceding message
        # with 'tool_calls'."
        def _align_phase_boundary(b: int) -> int:
            """Walk b backwards until it lands on a group boundary."""
            if b <= 0 or b >= span:
                return b
            while b > 0 and (
                compressible[b].get("role") == "tool"
                or (
                    compressible[b - 1].get("role") == "assistant"
                    and compressible[b - 1].get("tool_calls")
                )
            ):
                b -= 1
            return b

        b4 = _align_phase_boundary(b4)
        b3 = _align_phase_boundary(b3)
        b2 = _align_phase_boundary(b2)
        # Aligning backwards can flatten boundaries; re-enforce monotonicity
        # so phase windows stay in order even if alignment moved them.
        b4 = min(b4, b3, b2)
        b3 = min(b3, b2)

        phase4_msgs = compressible[:b4]          # oldest — drop
        phase3_msgs = compressible[b4:b3]        # old — heavy compress
        phase2_msgs = compressible[b3:b2]        # medium compress
        phase1_msgs = compressible[b2:]          # recent — keep verbatim (prepend to tail)

        _compaction_model = self._model_router.select("compaction", self._available_keys) or self.model

        async def _summarise(segment: list[dict], max_tok: int, label: str) -> dict | None:
            """Summarise one phase segment; return a notice message or None on empty."""
            if not segment:
                return None
            formatted = "\n".join(
                f"[{m.get('role','?').upper()}]: {str(m.get('content',''))[:500]}"
                for m in segment
            )
            try:
                resp = await self.provider.chat(
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are a context compression assistant. "
                                f"Compress the following {label} conversation segment. "
                                "Preserve: concrete outcomes, tool results, files changed, "
                                "key decisions, errors and fixes. "
                                "Discard: exploratory reasoning, repeated attempts, filler. "
                                "Output plain text only. Be maximally dense."
                            ),
                        },
                        {"role": "user", "content": formatted},
                    ],
                    tools=[],
                    model=_compaction_model,
                    temperature=0.1,
                    max_tokens=max_tok,
                )
                text = self._strip_think(resp.content) or f"[{label}: {len(segment)} messages — no summary]"
                return {
                    "role": "assistant",
                    "content": f"[Compacted {label} — {len(segment)} messages]\n{text}",
                }
            except Exception as exc:
                logger.warning("Phase compaction failed for {} ({})", label, exc)
                return {
                    "role": "assistant",
                    "content": f"[Compacted {label} — {len(segment)} messages dropped (summary failed)]",
                }

        # Phase 4: oldest block — archived to HISTORY.md, then a notice. No LLM call
        # (saves tokens); the archive is verbatim-ish rather than summarised precisely
        # so nothing here depends on a model getting the summary right.
        notices: list[dict] = []
        archived = False
        if phase4_msgs:
            archived = self._archive_to_history(phase4_msgs)
            where = (
                " — archived to memory/HISTORY.md; grep it if you need detail from earlier in this session"
                if archived else ""
            )
            notices.append({
                "role": "assistant",
                "content": f"[Oldest context dropped: {len(phase4_msgs)} messages removed (furthest from current task){where}]",
            })

        # Phase 3 and 2: LLM summaries run concurrently
        p3_task = asyncio.create_task(_summarise(phase3_msgs, 256, "old (high-compression)"))
        p2_task = asyncio.create_task(_summarise(phase2_msgs, 512, "medium"))
        p3_notice, p2_notice = await asyncio.gather(p3_task, p2_task)

        if p3_notice:
            notices.append(p3_notice)
        if p2_notice:
            notices.append(p2_notice)

        total_removed = len(phase4_msgs) + len(phase3_msgs) + len(phase2_msgs)
        logger.info(
            "4-phase compaction: dropped={} heavy={} medium={} verbatim={}",
            len(phase4_msgs), len(phase3_msgs), len(phase2_msgs), len(phase1_msgs),
        )
        _emit_progress({
            "type": "compaction_phases",
            "dropped": len(phase4_msgs),
            "heavy": len(phase3_msgs),
            "medium": len(phase2_msgs),
            "verbatim": len(phase1_msgs),
            "total_removed": total_removed,
            # False here means the turn lost history with no record of it — the one
            # outcome worth alerting on rather than counting.
            "archived": archived,
        })

        return head + notices + phase1_msgs + tail

    def _build_workspace_awareness(self) -> str | None:
        """Build a profession-agnostic workspace awareness block for the dynamic system prompt.

        Three components:
          - Active task state (from TodoWriteTool in-memory list)
          - Recently modified workspace files (mtime-based, last 30 min)
          - Session activity counter

        This is the nanocrew equivalent of claw-code's per-turn git status injection.
        Works for any workspace type (code, research, documents, etc.).
        """
        import time as _t
        from collections import Counter

        lines: list[str] = []

        # 1. Active task state
        todo_tool = self.tools.get("todo_write")
        if todo_tool and getattr(todo_tool, "_todos", None):
            counts = Counter(t["status"] for t in todo_tool._todos)
            parts = [f"{v} {k}" for k, v in counts.most_common() if v]
            if parts:
                lines.append("Active tasks: " + ", ".join(parts))

        # 2. Recently modified workspace files (last 30 min, skip infra dirs)
        _SKIP = {".git", "__pycache__", "node_modules", ".venv", "sessions", "tools", ".pytest_cache"}
        cutoff = _t.time() - 1800
        recent: list[tuple[float, str, int]] = []
        try:
            for p in Path(self.workspace).rglob("*"):
                if any(s in p.parts for s in _SKIP):
                    continue
                try:
                    st = p.stat()
                    if p.is_file() and st.st_mtime > cutoff:
                        age_min = int((_t.time() - st.st_mtime) / 60)
                        recent.append((st.st_mtime, p.name, age_min))
                except OSError:
                    continue
        except OSError:
            pass
        if recent:
            recent.sort(reverse=True)
            parts = [f"{name} ({age}m ago)" for _, name, age in recent[:5]]
            lines.append("Recent changes: " + ", ".join(parts))

        # 3. Session activity (only show when non-trivial)
        if self._session_tool_count > 0:
            elapsed = int((_t.time() - self._session_start_time) / 60)
            lines.append(f"Session: {self._session_tool_count} tool calls, {elapsed} min active")

        return "\n".join(lines) if lines else None

    async def _run_agent_loop(
        self,
        initial_messages: list[dict],
        session_key: str = "default",
        on_progress: Callable[..., Awaitable[None]] | None = None,
    ) -> tuple[str | None, list[str], list[dict], dict[str, int]]:
        """Run the agent iteration loop. Returns (final_content, tools_used, messages, aggregated_usage, turn_record)."""
        import time as _time
        # Guard: a reloaded session may carry orphan tool messages (e.g. from a prior
        # compaction) — repair before the first model call so it can't error out.
        messages = _sanitize_tool_pairs(initial_messages)
        iteration = 0
        final_content = None
        tools_used: list[str] = []
        compacted = False
        _streaming = on_progress is not None

        # ── Turn record for session persistence ──────────────────────────────
        # `messages` is the MODEL'S CONTEXT WINDOW: it is mutated in place by
        # compaction (_compact_messages) and tool-pair sanitisation, both of which
        # drop/restructure earlier entries to fit the token budget. Callers used to
        # recover "the new turn" by slicing messages[1 + len(history):] — but once
        # compaction shrank `messages` below that offset (only on long, tool-heavy
        # cycles), the slice went empty and the ENTIRE turn silently never reached
        # the session file: the reply was produced and returned, but the agent kept
        # no memory of it. `turn_record` accumulates the messages GENERATED this turn
        # (current user input + every assistant/tool message) as they are created,
        # and is never touched by compaction — so the persisted history is always the
        # complete, verbatim turn regardless of how the context window was trimmed.
        turn_record: list[dict] = []
        if initial_messages:
            _cur_user = initial_messages[-1]
            if isinstance(_cur_user, dict) and _cur_user.get("role") == "user":
                turn_record.append(_cur_user)
        _cache = ToolResultCache()
        _failure_counts: dict[str, int] = {}  # tool_name → consecutive failures this run
        _MAX_RETRIES = 2
        _MAX_TOOL_FAILURES = 3

        # ── Repeated-identical-tool-call guard ────────────────────────────────
        # A model that calls the exact same tool with the exact same arguments
        # several turns running is stuck, not working. Nothing else in this loop
        # notices — AdaptiveTemperature actually makes it worse, since >3 recent
        # tool results collapses temperature toward-deterministic for "precision
        # execution", which just makes the model more likely to keep sampling the
        # same repeated call once it's already in one. Seen live 2026-08-21:
        # ox-alpha called `exec("echo \"...\"")` 90 times in a row, identical
        # every time, and silently burned the entire max_iterations budget doing
        # nothing before the existing grace-call caught it after the fact.
        _last_tool_sig: int | None = None
        _tool_repeat_streak = 0
        _repeat_nudge_sent = False
        _repeat_loop_detected = False
        _truncated_repetition_detected = False
        _length_continues = 0
        # When this turn last told the agent to save its best result so far (see
        # _CHECKPOINT_EVERY_S). Starts at the turn's start.
        _turn_t0 = _time.monotonic()
        _last_checkpoint = _turn_t0
        _empty_continues = 0
        # The next call only, after a step ran out of room thinking or came back empty:
        # reasoning effort to ask for (see _RECOVERY_EFFORT). None = the model's default.
        _effort_next: str | None = None
        _stop_nudged = False
        _force_high_temp_next = False
        _verification = VerificationLedger()
        _snapshotted = False
        _REPEAT_NUDGE_AT = 3
        _REPEAT_ABORT_AT = 5

        async def _on_token(token: str) -> None:
            if on_progress:
                await on_progress(token, streaming=True)

        # Track aggregated usage over the entire turn.
        # Includes Anthropic-style (cache_creation/read_input_tokens) AND DeepSeek-style
        # (prompt_cache_hit/miss_tokens) cache fields so the JS-side cost calculator can
        # apply the correct cache-discounted pricing regardless of provider.
        aggregated_usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "prompt_cache_hit_tokens": 0,
            "prompt_cache_miss_tokens": 0,
            # What the provider says it actually billed, summed over the turn, plus the
            # tokens that figure covers. Only OpenRouter reports this today (see
            # _reported_cost_fields); everything else leaves these at 0 and is priced
            # from the JS-side table as before. The token counts are what let the JS
            # side handle a turn that changed provider partway — it prices the covered
            # slice from this invoice and the rest from the table.
            "reported_cost_usd": 0.0,
            "reported_cost_prompt_tokens": 0,
            "reported_cost_completion_tokens": 0,
        }
        # Size of the context actually sent on the LAST call — the only usage figure that
        # reflects how full the window is. aggregated_usage sums prompt_tokens across
        # iterations, and since every iteration resends the whole history that sum grows
        # quadratically: with context growing ~3k/iteration it passes 100k around
        # iteration 8, when the real context is ~24k. Compaction keyed off the sum
        # therefore fired at roughly a quarter of the intended size, discarding history
        # (and breaking the prompt-cache prefix) long before the window needed it.
        # `prompt_tokens` is treated as total input including cache hits, matching the
        # convention the JS-side cost calculator already assumes.
        _last_prompt_tokens = 0
        _budget_alerted = False

        await self.hooks.run(
            HookEvent.SessionStart, "_session",
            {
                "session_key": session_key,
                "model": self.model,
                "max_iterations": self.max_iterations,
                "tools_available": self.tools.tool_names,
            },
            session_id=session_key,
        )

        # Ask Jev which of the hidden tools this turn needs, before the model has to go
        # looking for one. Reaching a deferred tool costs TWO model calls at 12-18 s
        # each — measured 2026-09-21, ~28 s of a 133 s cycle spent finding a tool rather
        # than using it. Jev answers the same question in ~0.35 s.
        #
        # ONCE per turn, not per iteration: it is answering "what is this task about",
        # which does not change while the agent works. Best-effort — tool_search is
        # still there, so the worst case is an unused schema in the prompt.
        from nanoagent.agent import tool_preselect

        await tool_preselect.activate_for(self.tools, messages)

        while iteration < self.max_iterations:
            iteration += 1
            _emit_progress({"type": "iteration", "n": iteration, "of": self.max_iterations})

            # ── Soft interrupt check ──────────────────────────────────────────
            if await self._check_interrupt():
                logger.info("Soft interrupt received at iteration {}", iteration)
                await self.hooks.run(
                    HookEvent.SessionEnd, "_session",
                    {"session_key": session_key, "interrupted": True, "iterations": iteration},
                    session_id=session_key,
                )
                interrupt_prefix = f"[Interrupted at iteration {iteration}]\n\nHere is what I had accomplished so far:\n"
                try:
                    _irq_resp = await self.provider.chat(
                        messages=messages + [{
                            "role": "user",
                            "content": "You were interrupted. Briefly summarise what you accomplished before being stopped.",
                        }],
                        tools=[],
                        model=self.model,
                        temperature=self.temperature,
                        max_tokens=512,
                    )
                    final_content = interrupt_prefix + (self._strip_think(_irq_resp.content) or "(no summary)")
                except Exception:
                    final_content = interrupt_prefix + "(summary unavailable)"
                # This interrupt summary is the turn's final answer but was never added
                # to `messages`, so record it for the session directly.
                turn_record.append({"role": "assistant", "content": final_content})
                _emit_progress({"type": "interrupted", "iteration": iteration})
                break

            # ── Mid-run steering ────────────────────────────────────────────────
            # Same mailbox effector's react_loop has polled since stage45; this is the
            # first iteration boundary in the loop that actually decides tool calls
            # that also polls it. See _check_steering's docstring for why it was
            # missing here specifically.
            _steer_notes = await self._check_steering()
            for _note in _steer_notes:
                logger.info("Steering note received at iteration {}: {}", iteration, _note[:200])
                messages.append({
                    "role": "user",
                    "content": (
                        f"[Note from your owner, sent while you were already working — "
                        f"read it before your next action]: {_note}"
                    ),
                })
                _emit_progress({"type": "steering_note", "iteration": iteration, "text": _note[:200]})

            # Item 6: request profile — count segments and cache breakpoints
            _sys_blocks = (
                messages[0]["content"] if messages and isinstance(
                    messages[0].get("content"), list
                ) else []
            )
            _segment_count = len(_sys_blocks)
            _cache_break_count = sum(
                1 for b in _sys_blocks if isinstance(b, dict) and b.get("cache_control")
            )
            _system_prompt_bytes = sum(
                len(b.get("text", "").encode()) for b in _sys_blocks if isinstance(b, dict)
            )
            self.tracer.record("api_request_sent", {
                "iteration": iteration,
                "model": self.model,
                "message_count": len(messages),
                "tool_count": len(self.tools.get_definitions()),
                "segment_count": _segment_count,
                "cache_break_count": _cache_break_count,
                "system_prompt_bytes": _system_prompt_bytes,
            })

            await self.hooks.run(
                HookEvent.PreLLMCall, "_llm",
                {
                    "iteration": iteration,
                    "message_count": len(messages),
                    "prompt_tokens_so_far": aggregated_usage["prompt_tokens"],
                    "tool_count": len(self.tools.get_definitions()),
                },
                session_id=session_key,
            )

            _api_t0 = _time.monotonic()
            _recent_tools = len([tc for m in messages[-4:] if isinstance(m.get("content"), list) for tc in m["content"] if isinstance(tc, dict) and tc.get("type") == "tool_result"])
            if _force_high_temp_next:
                # Override the normal precision-mode collapse for exactly this one
                # call — the repeat guard just flagged the model repeating itself,
                # so the low-temperature "many recent tool calls" heuristic would
                # only reinforce the loop it's supposed to be escaping from.
                _adaptive_temp = min(1.0, max(0.7, self.temperature * 3))
                _force_high_temp_next = False
            else:
                _adaptive_temp = self._adaptive_temp.for_iteration(iteration, _recent_tools)
            _effort_token = None
            # A recovery call (after a runaway, an empty reply or a cut-off tool call) also
            # gets a small reply budget: at long context GLM 5.3 Flash ignored both the
            # reasoning cap and low effort and ran to 32,768 again (docs 21, bench 3) — four
            # minutes a time. Capped, a repeat costs a minute; a real long write is told to
            # go in parts.
            _call_max_tokens = min(self.max_tokens, _RECOVERY_MAX_TOKENS) if _effort_next else self.max_tokens
            if _effort_next:
                from nanoagent.providers.litellm_provider import reasoning_effort_var
                _effort_token = reasoning_effort_var.set(_effort_next)
                _effort_next = None
            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=self.tools.get_definitions(),
                    model=self.model,
                    temperature=_adaptive_temp,
                    max_tokens=_call_max_tokens,
                    on_token=_on_token if _streaming else None,
                )
            finally:
                if _effort_token is not None:
                    from nanoagent.providers.litellm_provider import reasoning_effort_var
                    reasoning_effort_var.reset(_effort_token)
            _api_duration_ms = int((_time.monotonic() - _api_t0) * 1000)

            # Aggregate usage metrics if provided
            if response.usage:
                # Left unchanged when a provider omits usage — a missing figure means
                # "unknown", not "the context shrank to zero", and zeroing it here would
                # silently disable compaction for the rest of the turn.
                _last_prompt_tokens = response.usage.get("prompt_tokens", _last_prompt_tokens)
                aggregated_usage["prompt_tokens"] += response.usage.get("prompt_tokens", 0)
                aggregated_usage["completion_tokens"] += response.usage.get("completion_tokens", 0)
                aggregated_usage["total_tokens"] += response.usage.get("total_tokens", 0)
                aggregated_usage["cache_creation_input_tokens"] += response.usage.get("cache_creation_input_tokens", 0)
                aggregated_usage["cache_read_input_tokens"] += response.usage.get("cache_read_input_tokens", 0)
                # DeepSeek surfaces cache hits/misses under different keys
                aggregated_usage["prompt_cache_hit_tokens"] += response.usage.get("prompt_cache_hit_tokens", 0)
                aggregated_usage["prompt_cache_miss_tokens"] += response.usage.get("prompt_cache_miss_tokens", 0)
                aggregated_usage["reported_cost_usd"] += response.usage.get("reported_cost_usd", 0.0)
                aggregated_usage["reported_cost_prompt_tokens"] += response.usage.get("reported_cost_prompt_tokens", 0)
                aggregated_usage["reported_cost_completion_tokens"] += response.usage.get("reported_cost_completion_tokens", 0)
                # Stream the running usage after every call: the chat's working indicator
                # shows it as a live "· N tokens" counter (Claude-style), and the
                # orchestrator prices it into the cycle's row as it goes
                # (src/agents/live-spend.ts). That is the only record of spend a cycle that
                # dies before its final result block ever leaves, and what lets a daily
                # budget stop a cycle mid-run — so it carries every field the final price
                # uses (cache tokens, the provider's own billed figure), not just totals.
                _emit_progress({"type": "usage", **aggregated_usage})

            self.tracer.record("api_response_received", {
                "iteration": iteration,
                "duration_ms": _api_duration_ms,
                "has_tool_calls": response.has_tool_calls,
                "usage": response.usage or {},
            })

            await self.hooks.run(
                HookEvent.PostLLMCall, "_llm",
                {
                    "iteration": iteration,
                    "duration_ms": _api_duration_ms,
                    "prompt_tokens": response.usage.get("prompt_tokens", 0) if response.usage else 0,
                    "completion_tokens": response.usage.get("completion_tokens", 0) if response.usage else 0,
                    "has_tool_calls": response.has_tool_calls,
                },
                session_id=session_key,
            )

            # Budget alert hook — fires once when the context passes 75% of threshold.
            # Keyed off the last call's size, like compaction below, so the warning and
            # the action it warns about refer to the same number.
            if (
                not _budget_alerted
                and self._compact_threshold > 0
                and _last_prompt_tokens > self._compact_threshold * 0.75
            ):
                _budget_alerted = True
                await self.hooks.run(
                    HookEvent.BudgetAlert, "_budget",
                    {
                        "iteration": iteration,
                        "prompt_tokens": _last_prompt_tokens,
                        "threshold": self._compact_threshold,
                        "percent": _last_prompt_tokens / self._compact_threshold * 100,
                    },
                    session_id=session_key,
                )

            # Auto-compaction: if the context sent on the last call exceeds the
            # threshold, trim the message list before the next iteration to avoid
            # context-window exhaustion.
            if (
                self._compact_threshold > 0
                and _last_prompt_tokens > self._compact_threshold
                and (iteration - self._last_compaction_at) >= 5
            ):
                before = len(messages)
                await self.hooks.run(
                    HookEvent.PreCompaction, "_compaction",
                    {
                        "iteration": iteration,
                        "messages_to_remove": max(0, before - 4),
                        "prompt_tokens": _last_prompt_tokens,
                    },
                    session_id=session_key,
                )
                messages = await self._compact_messages(messages)
                # Compaction can summarise an assistant(tool_calls) into text while its
                # tool responses survive — repair any resulting orphans.
                messages = _sanitize_tool_pairs(messages)
                removed = before - len(messages)
                compacted = True
                self._last_compaction_at = iteration
                self.tracer.record("auto_compaction_triggered", {
                    "removed_messages": removed,
                    "prompt_tokens_before": _last_prompt_tokens,
                })
                await self.hooks.run(
                    HookEvent.PostCompaction, "_compaction",
                    {
                        "iteration": iteration,
                        "messages_removed": removed,
                        "prompt_tokens_before": _last_prompt_tokens,
                    },
                    session_id=session_key,
                )
                logger.info(
                    "Auto-compaction triggered: removed {} messages ({}k context tokens)",
                    removed,
                    _last_prompt_tokens // 1000,
                )

            if response.has_tool_calls:
                if on_progress:
                    if not _streaming:
                        # Non-streaming: send accumulated text now as progress
                        clean = self._strip_think(response.content)
                        if clean:
                            await on_progress(clean)
                    # Always send the tool hint (what tools are being called)
                    await on_progress(self._tool_hint(response.tool_calls), tool_hint=True, tool_calls_raw=[
                        {"name": tc.name, "arguments": tc.arguments} for tc in response.tool_calls
                    ])

                tool_call_dicts = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False)
                        }
                    }
                    for tc in response.tool_calls
                ]
                _rec_before = len(messages)
                messages = self.context.add_assistant_message(
                    messages, response.content, tool_call_dicts,
                    reasoning_content=response.reasoning_content,
                )
                turn_record.extend(messages[_rec_before:])

                # Cut off mid-call: the arguments are whatever fit before the output limit,
                # so running them runs something the model never finished writing. Measured
                # 2026-09-30: a 52k-character shell
                # command ran truncated ("Unterminated quoted string"), and a write_file lost
                # its `path` — the content came first and filled the reply — so the model was
                # told "missing required path" and never learned it had been cut off. Eight
                # minutes a call, three times. Nothing runs; each call is answered with why.
                if (response.finish_reason or "").lower() == "length":
                    for tc in response.tool_calls:
                        _rec_before = len(messages)
                        messages = self.context.add_tool_result(
                            messages, tc.id, tc.name, _cut_tool_call_message(tc.name, _call_max_tokens)
                        )
                        turn_record.extend(messages[_rec_before:])
                    logger.warning(
                        "Agent loop: tool call(s) {} cut off at max_tokens ({}) — not run",
                        [tc.name for tc in response.tool_calls], self.max_tokens,
                    )
                    _emit_progress({"type": "cut_tool_call", "tools": [tc.name for tc in response.tool_calls]})
                    _effort_next = _RECOVERY_EFFORT
                    continue

                # ── Parallel tool execution ────────────────────────────────────
                # All tool calls requested in this LLM response run concurrently.
                # Results are collected in original order and added to messages together.
                # Shared mutable state (_cache, _failure_counts) is safe under asyncio's
                # cooperative scheduler — no two coroutines can mutate the same dict
                # entry simultaneously without an intervening await.
                _messages_snapshot = messages  # passed to summarize_conversation_context

                async def _exec_tc(tool_call):
                    nonlocal _snapshotted
                    tools_used.append(tool_call.name)
                    # Stage 42 #10 — one snapshot per turn, taken before the first tool
                    # that could destroy something. Off-thread because it shells out to
                    # git, and never fatal: losing the undo history is bad, refusing to
                    # let the agent work is worse.
                    if not _snapshotted and tool_call.name in MUTATING_TOOLS:
                        _snapshotted = True
                        try:
                            await asyncio.to_thread(
                                self._checkpoints.snapshot, f"before {tool_call.name}"
                            )
                        except Exception as _cp_exc:
                            logger.debug("checkpoint skipped: {}", _cp_exc)
                    # Stage 42 #8 — passive: record what was edited and what was run,
                    # in order. Decides nothing here; the policy lives at turn end.
                    _verification.note(tool_call.name, tool_call.arguments)
                    args_str = json.dumps(tool_call.arguments, ensure_ascii=False)
                    logger.info("Tool call: {}({})", tool_call.name, args_str[:200])
                    raw_args = tool_call.arguments
                    if isinstance(raw_args, str):
                        try:
                            raw_args = json.loads(raw_args)
                        except Exception:
                            raw_args = {}
                    # DeepSeek sometimes wraps args in a list: [{"path": ..., "content": ...}]
                    if isinstance(raw_args, list):
                        raw_args = raw_args[0] if raw_args and isinstance(raw_args[0], dict) else {}
                    if not isinstance(raw_args, dict):
                        raw_args = {}
                    args = raw_args
                    if tool_call.name == "summarize_conversation_context":
                        args["history"] = _messages_snapshot

                    # ----------------------------------------------------------
                    # 1. PreToolUse hook
                    # ----------------------------------------------------------
                    pre_result = await self.hooks.run(
                        HookEvent.PreToolUse, tool_call.name, args,
                        session_id=session_key,
                    )
                    # Hook may rewrite the args (e.g. re-root a path)
                    if pre_result.updated_input:
                        args = pre_result.updated_input

                    # Hook deny is terminal
                    if pre_result.denied:
                        reason = "; ".join(pre_result.messages) or "denied by PreToolUse hook"
                        result = f"Error: tool call denied by hook — {reason}"
                        self.tracer.record("permission_decision", {
                            "tool": tool_call.name, "decision": "deny", "reason": reason,
                        })
                        return tool_call.id, tool_call.name, result

                    # ----------------------------------------------------------
                    # 2a. Plan mode guard — block write/exec while planning
                    # ----------------------------------------------------------
                    if getattr(self, "_plan_mode_state", None):
                        from nanoagent.agent.permissions import PermissionMode as _PM
                        _tool_obj_pm = self.tools.get(tool_call.name)
                        _req = _tool_obj_pm.required_permission if _tool_obj_pm else _PM.ReadOnly
                        if _req != _PM.ReadOnly:
                            # Plan mode is opt-in: entering it is the agent's own choice, and
                            # while it IS active write/exec stays blocked — otherwise the mode
                            # would mean nothing and enter_plan_mode would be a no-op. The
                            # separate plan-FIRST mandate that used to reject the first
                            # write/exec tool of a cycle until the agent had entered plan mode
                            # once (PLAN_FIRST_ENFORCE) was removed by owner decision: it cost
                            # every write cycle two extra tool calls to satisfy, and agents
                            # bypassed it with a back-to-back enter/exit anyway.
                            if self._plan_mode_state.active:
                                result = (
                                    f"Error: '{tool_call.name}' is blocked while plan mode is active. "
                                    "Finish planning and call exit_plan_mode first."
                                )
                                return tool_call.id, tool_call.name, result

                    # ----------------------------------------------------------
                    # 2. Permission policy check
                    # ----------------------------------------------------------
                    tool_obj = self.tools.get(tool_call.name)
                    if tool_obj is None:
                        await self.hooks.run(
                            HookEvent.ToolNotFound, tool_call.name, args,
                            session_id=session_key,
                        )
                    required_mode = (
                        tool_obj.required_permission
                        if tool_obj is not None
                        else PermissionMode.ReadOnly
                    )

                    # Hook allow override skips the policy tier check
                    if pre_result.permission_override == "allow":
                        decision, reason = PermissionDecision.Allow, f"hook override: {pre_result.permission_reason}"
                    elif pre_result.permission_override == "deny":
                        decision, reason = PermissionDecision.Deny, f"hook override: {pre_result.permission_reason}"
                    else:
                        decision, reason = await self.policy.authorize(
                            tool_call.name, args, required_mode
                        )

                    self.tracer.record("permission_decision", {
                        "tool": tool_call.name,
                        "decision": decision,
                        "reason": reason,
                        "required_mode": required_mode.name,
                    })

                    if decision == PermissionDecision.Deny:
                        result = f"Error: permission denied for {tool_call.name} — {reason}"
                        return tool_call.id, tool_call.name, result

                    # ----------------------------------------------------------
                    # 3. Workspace enforcement for write ops
                    # ----------------------------------------------------------
                    if tool_call.name in ("write_file", "edit_file") and "path" in args:
                        ok, err = self.enforcer.check(args["path"])
                        if not ok:
                            result = f"Error: {err}"
                            return tool_call.id, tool_call.name, result

                    # ----------------------------------------------------------
                    # 4. Execute
                    # ----------------------------------------------------------
                    self.tracer.record("tool_execution_started", {
                        "iteration": iteration,
                        "tool": tool_call.name,
                    })

                    # Emit truncated args preview — never emit secrets or full file contents
                    _args_preview = {
                        k: (str(v)[:60] + "…" if isinstance(v, str) and len(str(v)) > 60 else v)
                        for k, v in args.items()
                        if k not in ("content", "code", "data", "body")
                    }
                    _emit_progress({"type": "tool_call", "tool": tool_call.name, "args": _args_preview})

                    self._session_tool_count += 1
                    _tool_t0 = _time.monotonic()
                    is_error = False
                    result = ""

                    # Check cache before executing
                    _cached = _cache.get(tool_call.name, args)
                    if _cached is not None:
                        result = _cached
                        _emit_progress({"type": "cache_hit", "tool": tool_call.name})
                        self.tracer.record("tool_execution_finished", {
                            "iteration": iteration,
                            "tool": tool_call.name,
                            "duration_ms": 0,
                            "is_error": False,
                            "output_size": len(result),
                            "cache_hit": True,
                        })
                    else:
                        # Hard stop: tool has failed too many times this run
                        if _failure_counts.get(tool_call.name, 0) >= _MAX_TOOL_FAILURES:
                            result = (
                                f"[SKIPPED] {tool_call.name} has failed "
                                f"{_failure_counts[tool_call.name]} times this cycle. "
                                "Moving on to avoid an infinite loop."
                            )
                            is_error = True
                            await self.hooks.run(
                                HookEvent.ToolSkipped, tool_call.name, args,
                                session_id=session_key,
                            )
                        else:
                            _last_exc: Exception | None = None

                            async def _on_tool_chunk(chunk: str) -> None:
                                _emit_progress({
                                    "type": "tool_stream",
                                    "tool": tool_call.name,
                                    "chunk": chunk[:300],
                                })

                            for _attempt in range(_MAX_RETRIES + 1):
                                try:
                                    if _attempt > 0:
                                        await asyncio.sleep(2 ** _attempt)
                                        _emit_progress({"type": "retry", "tool": tool_call.name, "attempt": _attempt})
                                    async with _ToolHeartbeat():
                                        result = await self.tools.execute_streaming(
                                            tool_call.name, args, on_chunk=_on_tool_chunk,
                                        )
                                    _cache.set(tool_call.name, args, result)
                                    _failure_counts[tool_call.name] = 0
                                    _emit_progress({"type": "tool_result", "tool": tool_call.name, "preview": str(result)[:120]})
                                    break
                                except Exception as exc:
                                    _last_exc = exc
                                    _ec = classify_error(tool_call.name, exc)
                                    _emit_progress({"type": "error", "tool": tool_call.name, "class": _ec.value, "message": str(exc)[:150]})
                                    if not SHOULD_RETRY.get(_ec, False):
                                        break
                            else:
                                _last_exc = _last_exc  # loop exhausted without break

                            if _last_exc is not None and not result:
                                is_error = True
                                _ec = classify_error(tool_call.name, _last_exc)
                                hint = RECOVERY_HINTS[_ec]
                                result = f"[ERROR: {_ec.value}] {_last_exc}\n\nRecovery hint: {hint}"
                                _failure_counts[tool_call.name] = _failure_counts.get(tool_call.name, 0) + 1

                        _tool_dur_ms = int((_time.monotonic() - _tool_t0) * 1000)
                        self.tracer.record("tool_execution_finished", {
                            "iteration": iteration,
                            "tool": tool_call.name,
                            "duration_ms": _tool_dur_ms,
                            "is_error": is_error,
                            "output_size": len(str(result)),
                        })
                        _emit_progress({
                            "type": "tool_analytics",
                            "tool": tool_call.name,
                            "duration_ms": _tool_dur_ms,
                            "is_error": is_error,
                            "cache_hit": _cached is not None,
                        })

                    # ----------------------------------------------------------
                    # 5. PostToolUse / PostToolUseFailure hook
                    # ----------------------------------------------------------
                    post_event = HookEvent.PostToolUseFailure if is_error else HookEvent.PostToolUse
                    await self.hooks.run(
                        post_event, tool_call.name, args,
                        session_id=session_key, tool_result=str(result),
                    )

                    # ----------------------------------------------------------
                    # 6. Provenance fence
                    # ----------------------------------------------------------
                    # Externally-controlled output (a web page, an inbox, a third
                    # party's message) is wrapped before it enters the message
                    # history, so injected text reads as data rather than as an
                    # instruction. No-op under the Dangerous posture.
                    if not is_error:
                        result = fence_tool_result(tool_call.name, result, self.policy.posture)

                    return tool_call.id, tool_call.name, result

                # Run all tool calls concurrently, preserve original result order
                _tc_results = await asyncio.gather(
                    *[_exec_tc(tc) for tc in response.tool_calls]
                )
                for _tc_id, _tc_name, _tc_result in _tc_results:
                    _rec_before = len(messages)
                    messages = self.context.add_tool_result(
                        messages, _tc_id, _tc_name, _tc_result
                    )
                    turn_record.extend(messages[_rec_before:])

                # A repeat is the same call coming back with the same result. Until
                # 2026-10-01 only the call was compared, so work that rightly repeats one
                # call — polling a deploy, waiting on a job, a paced loop — was told it
                # "isn't making progress" on the third try. Live: a five-step task of
                # `sleep 840; date -u` got that nudge at step four, though every call had
                # returned a new time, and the agent abandoned the task. A stuck call
                # still returns the same thing every time (ox-alpha's 90 identical
                # `echo`s), so it is still caught.
                _cur_tool_sig = hash((
                    "|".join(
                        f"{tc.name}:{json.dumps(tc.arguments, sort_keys=True, default=str)}"
                        for tc in response.tool_calls
                    ),
                    tuple(str(_r) for _i, _n, _r in _tc_results),
                ))
                if _cur_tool_sig == _last_tool_sig:
                    _tool_repeat_streak += 1
                else:
                    _tool_repeat_streak = 1
                    _repeat_nudge_sent = False
                _last_tool_sig = _cur_tool_sig

                # A long turn saves its work as it goes. Measured 2026-09-30 (docs 21, bench
                # 3): a single agent researched 41 states for 106 minutes across two 50-minute
                # timeouts and a retry, never wrote a partial answer, and ended with nothing.
                # Every _CHECKPOINT_EVERY_S the agent is reminded to put its best result so
                # far where it belongs, then carry on.
                if _time.monotonic() - _last_checkpoint >= _CHECKPOINT_EVERY_S:
                    _last_checkpoint = _time.monotonic()
                    _mins = int((_last_checkpoint - _turn_t0) // 60)
                    _note = _checkpoint_message(_mins)
                    _last = messages[-1] if messages else None
                    if _last is not None and _last.get("role") == "tool" and isinstance(_last.get("content"), str):
                        # Same dict as the turn_record entry, so the record carries it too.
                        _last["content"] = _last["content"] + "\n\n" + _note
                    else:
                        messages.append({"role": "user", "content": _note})
                        turn_record.append(messages[-1])
                    _emit_progress({"type": "checkpoint_nudge", "minutes": _mins})

                # Surface tool results to the on_progress callback so persisted
                # activity traces (e.g. nanocrew_adapter's activity.json) can fill in
                # the `output` field on the matching tool_call step. Otherwise the
                # trace only captures the dispatch hint and the dashboard's cycle
                # drawer shows "output: null" for every tool.
                if on_progress:
                    try:
                        await on_progress(
                            "",
                            tool_result=True,
                            tool_results_raw=[
                                {"name": _n, "result": str(_r)} for _id, _n, _r in _tc_results
                            ],
                        )
                    except Exception:
                        pass

                # Repeated-identical-tool-call guard — see the comment where the
                # counters are initialised. One nudge (with a forced high-temp
                # retry) gets a real chance to break the loop; if the very same
                # call comes back after that, stop spending iterations on it.
                if _tool_repeat_streak >= _REPEAT_NUDGE_AT and not _repeat_nudge_sent:
                    _repeat_nudge_sent = True
                    _force_high_temp_next = True
                    _rec_before = len(messages)
                    messages.append({
                        "role": "user",
                        "content": (
                            f"You've called the exact same tool with the exact same "
                            f"arguments {_tool_repeat_streak} times in a row with no "
                            "change in outcome. This isn't making progress. Either take "
                            "a genuinely different, concrete action now, or stop and "
                            "explain plainly what's blocking you instead of repeating "
                            "the same call again."
                        ),
                    })
                    turn_record.extend(messages[_rec_before:])
                    logger.warning(
                        "Agent loop: nudging after {}x identical tool call ({})",
                        _tool_repeat_streak, response.tool_calls[0].name if response.tool_calls else "?",
                    )
                elif _tool_repeat_streak >= _REPEAT_ABORT_AT:
                    logger.warning(
                        "Agent loop: {}x identical tool call ({}) survived the nudge — aborting early instead of exhausting max_iterations",
                        _tool_repeat_streak, response.tool_calls[0].name if response.tool_calls else "?",
                    )
                    _repeat_loop_detected = True
                    break
            else:
                # Stage 42 #8 — verify-on-stop. The model is trying to finish; if it
                # edited code this turn and has run nothing since, spend one more
                # iteration asking it to. Policy only: this runs no checks itself,
                # fires at most once per turn, and is skipped entirely for doc-only
                # edits, where there is nothing a test could exercise.
                if _verification.needs_nudge():
                    _verification.nudged = True
                    logger.info(
                        "Verify-on-stop: {} code file(s) edited with no check run since — nudging",
                        len(_verification.code_edits()),
                    )
                    messages.append({"role": "user", "content": _verification.nudge_message()})
                    _emit_progress({"type": "verify_nudge", "paths": _verification.code_edits()[:8]})
                    continue

                clean = self._strip_think(response.content)

                # Stage 42 #9 — the model stopped because it hit max_tokens, not
                # because it was finished. Every provider sets finish_reason and,
                # before this, nothing read it: a sentence cut mid-word was handed
                # back as a complete answer, and a repetition loop's 4k tokens of
                # echoed text went into the session to be resent on every later
                # iteration.
                if (response.finish_reason or "").lower() == "length":
                    if is_repetition_dominated(clean):
                        # Degenerate — don't store it and don't show it. Fall through
                        # to the same grace-call recovery the repeated-tool-call abort
                        # uses, which explains itself instead of emitting the garbage.
                        logger.warning(
                            "Agent loop: truncated response is repetition-dominated "
                            "({} chars) — discarding and firing grace call",
                            len(clean or ""),
                        )
                        _truncated_repetition_detected = True
                        break
                    # Cut off before it acted: not an answer, a step that ran out of
                    # room. A reasoning model can spend its whole output budget thinking
                    # (measured 2026-09-29, GLM 5.3 Flash: two of three turns spent all
                    # 8,192 tokens on the first call, called no tool, and the turn ended
                    # — the agent never took a step). Continue instead, and say why, at
                    # most twice a turn; after that the old honest-marking path below.
                    if _length_continues < _LENGTH_CONTINUE_MAX:
                        _length_continues += 1
                        logger.warning(
                            "Agent loop: response cut off at max_tokens ({}) with no tool call — "
                            "continuing ({}/{})",
                            self.max_tokens, _length_continues, _LENGTH_CONTINUE_MAX,
                        )
                        _rec_before = len(messages)
                        if clean:
                            messages = self.context.add_assistant_message(
                                messages, clean, reasoning_content=response.reasoning_content,
                            )
                        messages.append({"role": "user", "content": _length_continue_message(_call_max_tokens, bool(clean))})
                        turn_record.extend(messages[_rec_before:])
                        _emit_progress({"type": "length_continue", "n": _length_continues})
                        _effort_next = _RECOVERY_EFFORT
                        continue
                    logger.warning(
                        "Agent loop: response truncated at max_tokens ({}) — "
                        "marking it incomplete",
                        self.max_tokens,
                    )
                    # Marked in `clean` itself so history, the session and the caller
                    # all carry the same honest record of what happened.
                    clean = (clean or "") + (
                        f"\n\n[Response was cut off at the {_call_max_tokens}-token "
                        "output limit and may be incomplete.]"
                    )
                elif not (clean or "").strip() and _empty_continues < _EMPTY_CONTINUE_MAX:
                    # An empty reply is a step that produced nothing, not the end of the
                    # task. Measured 2026-09-29: after
                    # two tool calls GLM 5.3 Flash returned 696 tokens of reasoning and no
                    # text or tool call; the grace call below then asked it for a "final
                    # summary", it wrote "no substantive work happened yet", and the trial
                    # ended with nothing. Ask it to continue first; the grace call is for when
                    # that has not worked.
                    _empty_continues += 1
                    logger.warning(
                        "Agent loop: empty reply (no text, no tool call) — continuing ({}/{})",
                        _empty_continues, _EMPTY_CONTINUE_MAX,
                    )
                    messages.append({"role": "user", "content": _EMPTY_CONTINUE_MESSAGE})
                    turn_record.append(messages[-1])
                    _emit_progress({"type": "empty_continue", "n": _empty_continues})
                    _effort_next = _RECOVERY_EFFORT
                    continue

                _rec_before = len(messages)
                messages = self.context.add_assistant_message(
                    messages, clean, reasoning_content=response.reasoning_content,
                )
                turn_record.extend(messages[_rec_before:])
                # A caller's own condition for being finished (a stage 57 worker: it has
                # called report_result). Asked once per turn; the model's words stay in
                # history so it sees what it said before being told what is missing.
                if self.stop_check is not None and not _stop_nudged:
                    _nudge = self.stop_check()
                    if _nudge:
                        _stop_nudged = True
                        messages.append({"role": "user", "content": _nudge})
                        turn_record.append(messages[-1])
                        _emit_progress({"type": "stop_nudge"})
                        continue
                final_content = clean
                break

        if final_content is None:
            # Two distinct ways to land here, both needing the same recovery:
            # (a) iteration exhaustion (the original case this was written for), or
            # (b) the model's final turn had no tool calls but its content was empty
            #     or was *only* a <think>...</think> block with nothing after it —
            #     _strip_think() returns None for both, and the "no tool calls" success
            #     path above did `final_content = clean; break` with no None check, so
            #     a degenerate empty turn silently looked like a valid completed answer.
            #     Seen in practice right after a tool timeout confused the model into
            #     producing a content-free turn. Previously this fell through to the
            #     caller's generic "I've completed processing but have no response to
            #     give" with zero context — worse than the max-iterations case, which
            #     at least explains itself, because nothing here ever explained *this*.
            _hit_max_iterations = iteration >= self.max_iterations
            if _repeat_loop_detected:
                _reason = f"detected a {_tool_repeat_streak}x repeated identical tool-call loop and stopped early"
            elif _truncated_repetition_detected:
                _reason = "ran its output budget out repeating itself, so its answer was discarded"
            elif _hit_max_iterations:
                _reason = f"reached max iterations ({self.max_iterations})"
            else:
                _reason = "produced an empty final turn (no tool calls, no content)"
            logger.warning("Agent loop {} — firing grace call", _reason)
            await self.hooks.run(
                HookEvent.MaxIterationsReached, "_session",
                {"iteration": iteration, "max_iterations": self.max_iterations, "tools_used": tools_used, "reason": _reason},
                session_id=session_key,
            )
            # Grace call: one final synthesis turn with no tools, giving the agent
            # a chance to summarise what was done and what remains before stopping.
            #
            # The empty-turn branch (not max-iterations) originally only asked for a task
            # summary — a framing that doesn't fit the case where the *reason* nothing was
            # produced is that the request itself conflicted with the agent's own system
            # prompt or guardrails. A model with nowhere to put "I'm not going to do this"
            # tends to produce nothing at all rather than explaining itself, and the old
            # prompt gave it no explicit permission to say that — so the grace call landed
            # on the same silence as the turn it was recovering from (seen live 2026-08-17:
            # a scraping agent asked to write fingerprint-spoofing/evasion code its own
            # guardrails explicitly forbid burned its full token budget and produced nothing,
            # twice in a row, on both the original turn and the grace call). Naming that
            # possibility directly gives the model something to say instead of nothing.
            if _repeat_loop_detected:
                _grace_prompt = (
                    f"This session is being cut short: you called the exact same tool with "
                    f"the exact same arguments {_tool_repeat_streak} times in a row with no "
                    "change in outcome, including after being told so directly. Stop here — "
                    "don't attempt the repeated call again. "
                )
            elif _hit_max_iterations:
                _grace_prompt = f"You have reached the maximum number of iterations ({self.max_iterations}). "
            else:
                _grace_prompt = (
                    "Your last turn produced no content and no tool calls, so this session has "
                    "nothing to show for itself yet. If you hesitated or declined to act on the "
                    "preceding request — for example because it conflicted with your system prompt, "
                    "compliance guardrails, or safety instructions — say so explicitly and explain "
                    "why, in plain language, instead of leaving it blank again. "
                )
            grace_messages = messages + [{
                "role": "user",
                "content": (
                    _grace_prompt +
                    "Please provide a final summary: what you accomplished (or declined, and why), "
                    "what remains incomplete, "
                    "and the most important context for whoever continues this work. "
                    "Be concise and concrete.\n\n"
                    "If — and only if — you discovered a reusable technique or workflow that future "
                    "sessions would benefit from, add a short note about it after the summary. It is "
                    "optional and secondary; never send it instead of the summary.\n\n"
                    # Without this the grace reply is free-form prose, and whatever the model
                    # chose to lead with becomes the cycle summary in the dashboard. A real
                    # cycle's history entry read "Tweet authorship verification via syndication
                    # endpoint — fetch cdn.syndication.twimg.com/..." — an accurate technique
                    # note, and a useless record of what the cycle actually did. Emitting the
                    # same block a normal turn ends with lets the runner extract a real summary
                    # and keep the prose as the body.
                    "End your reply with this block, exactly:\n"
                    "<cycle_result>\n"
                    "<summary>one sentence on what you actually did this cycle</summary>\n"
                    "<tasks_done>number of things you completed</tasks_done>\n"
                    "</cycle_result>"
                ),
            }]
            try:
                grace_response = await self.provider.chat(
                    messages=grace_messages,
                    tools=[],  # No tools in grace call — synthesis only
                    model=self.model,
                    temperature=self.temperature,
                    max_tokens=self.max_tokens,
                    on_token=_on_token if _streaming else None,
                )
                if grace_response.usage:
                    aggregated_usage["prompt_tokens"] += grace_response.usage.get("prompt_tokens", 0)
                    aggregated_usage["completion_tokens"] += grace_response.usage.get("completion_tokens", 0)
                    aggregated_usage["total_tokens"] += grace_response.usage.get("total_tokens", 0)
                    aggregated_usage["cache_creation_input_tokens"] += grace_response.usage.get("cache_creation_input_tokens", 0)
                    aggregated_usage["cache_read_input_tokens"] += grace_response.usage.get("cache_read_input_tokens", 0)
                    # The grace call bills like any other; omitting it here would make
                    # the reported total quietly smaller than the real invoice.
                    aggregated_usage["reported_cost_usd"] += grace_response.usage.get("reported_cost_usd", 0.0)
                    aggregated_usage["reported_cost_prompt_tokens"] += grace_response.usage.get("reported_cost_prompt_tokens", 0)
                    aggregated_usage["reported_cost_completion_tokens"] += grace_response.usage.get("reported_cost_completion_tokens", 0)
                final_content = self._strip_think(grace_response.content) or (
                    f"Agent loop {_reason}. Grace call produced no content either."
                )
                _emit_progress({"type": "grace_call", "content_preview": final_content[:120]})
                await self.hooks.run(
                    HookEvent.GraceCall, "_session",
                    {"iteration": iteration, "content_preview": final_content[:120]},
                    session_id=session_key,
                )
            except Exception as _grace_exc:
                logger.warning("Grace call failed: {}", _grace_exc)
                final_content = (
                    f"I {_reason} without completing the task. "
                    "You can try breaking the task into smaller steps."
                )
            # The grace/max-iterations final answer isn't added to `messages` either —
            # record it so the session keeps a trace of how the turn ended.
            if final_content:
                turn_record.append({"role": "assistant", "content": final_content})

        await self.hooks.run(
            HookEvent.SessionEnd, "_session",
            {
                "session_key": session_key,
                "iterations": iteration,
                "tools_used": tools_used,
                "final_content_length": len(final_content or ""),
                "compacted": compacted,
            },
            session_id=session_key,
        )

        aggregated_usage["compacted"] = compacted  # type: ignore[assignment]
        if _cache.hits > 0:
            logger.debug("Tool cache: {} hits, {} misses this run", _cache.hits, _cache.misses)
        _cache.clear()
        return final_content, tools_used, messages, aggregated_usage, turn_record

    async def run(self) -> None:
        """Run the agent loop, dispatching messages as tasks to stay responsive to /stop."""
        self._running = True
        await self._connect_mcp()
        logger.info("Agent loop started")

        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            if msg.content.strip().lower() == "/stop":
                await self._handle_stop(msg)
            else:
                def _on_done(t, k=msg.session_key):
                    if k in self._active_tasks and t in self._active_tasks[k]:
                        self._active_tasks[k].remove(t)

                task = asyncio.create_task(self._dispatch(msg))
                self._active_tasks.setdefault(msg.session_key, []).append(task)
                task.add_done_callback(_on_done)

    async def _handle_stop(self, msg: InboundMessage) -> None:
        """Cancel all active tasks for the session."""
        self._hook_abort.abort()   # kill any in-flight hooks immediately
        tasks = self._active_tasks.pop(msg.session_key, [])
        cancelled = sum(1 for t in tasks if not t.done() and t.cancel())
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        total = cancelled
        self._hook_abort.clear()   # reset so the next task can use hooks normally
        content = f"⏹ Stopped {total} task(s)." if total else "No active task to stop."
        await self.bus.publish_outbound(OutboundMessage(
            channel=msg.channel, chat_id=msg.chat_id, content=content,
        ))

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message under the global lock."""
        async with self._processing_lock:
            try:
                response = await self._process_message(msg)
                # `already_sent` = the message tool published this turn's reply itself;
                # publishing it again here is the double-post this guard exists to stop.
                # (It replaces an older `return None` — see _process_message for why that
                # broke cycle accounting.) Suppressed turns still fall through to the cli
                # sentinel below, exactly as the None case used to.
                _suppressed = bool(response is not None and (response.metadata or {}).get("already_sent"))
                if response is not None and not _suppressed:
                    await self.bus.publish_outbound(response)
                elif msg.channel == "cli":
                    await self.bus.publish_outbound(OutboundMessage(
                        channel=msg.channel, chat_id=msg.chat_id,
                        content="", metadata=msg.metadata or {},
                    ))
            except asyncio.CancelledError:
                logger.info("Task cancelled for session {}", msg.session_key)
                raise
            except Exception:
                logger.exception("Error processing message for session {}", msg.session_key)
                await self.bus.publish_outbound(OutboundMessage(
                    channel=msg.channel, chat_id=msg.chat_id,
                    content="Sorry, I encountered an error.",
                ))

    async def close_mcp(self) -> None:
        """Close MCP connections."""
        if self._mcp_stack:
            try:
                await self._mcp_stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                pass  # MCP SDK cancel scope cleanup is noisy but harmless
            self._mcp_stack = None

    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response."""
        # System messages: parse origin from chat_id ("channel:chat_id")
        if msg.channel == "system":
            channel, chat_id = (msg.chat_id.split(":", 1) if ":" in msg.chat_id
                                else ("cli", msg.chat_id))
            logger.info("Processing system message from {}", msg.sender_id)
            key = f"{channel}:{chat_id}"
            session = self.sessions.get_or_create(key)
            self._set_tool_context(channel, chat_id, msg.metadata.get("message_id"))
            history = session.get_history(max_messages=self.memory_window)
            messages = self.context.build_messages(
                history=history,
                current_message=msg.content, channel=channel, chat_id=chat_id,
            )
            final_content, _tools_used_sys, all_msgs, usage, turn_record = await self._run_agent_loop(messages, session_key=key)
            # Persist the turn record (immune to compaction), NOT a positional slice of
            # the possibly-compacted context list — see turn_record in _run_agent_loop.
            self._save_turn(session, turn_record, 0)
            self.sessions.save(session)
            
            meta = dict(msg.metadata or {})
            meta["usage"] = usage
            
            return OutboundMessage(channel=channel, chat_id=chat_id,
                                  content=final_content or "Background task completed.", metadata=meta)

        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.info("Processing message from {}:{}: {}", msg.channel, msg.sender_id, preview)

        key = session_key or msg.session_key
        session = self.sessions.get_or_create(key)

        # Ensure tracer is scoped to this session and advance the turn counter.
        if self.tracer.session_id != key:
            self.tracer = SessionTracer(
                session_id=key,
                sink=JsonlSink(session_id=key, workspace=self.workspace),
            )
        self.tracer.start_turn()
        self.tracer.record("turn_started", {
            "channel": msg.channel,
            "sender_id": msg.sender_id,
            "content_preview": preview,
        })

        # Slash commands
        cmd = msg.content.strip().lower()

        # Stage 42 #7 — /learn does not branch into a separate engine: it rewrites the
        # turn's prompt and lets the normal loop do the work with the tools it already
        # has. Handled before the exact-match commands because it carries an argument.
        _learn_subject = parse_learn_command(msg.content)
        if _learn_subject is not None:
            logger.info("/learn — authoring a skill from: {}", _learn_subject or "this conversation")
            msg = replace(msg, content=build_learn_prompt(_learn_subject))
            cmd = ""

        if cmd == "/new":
            lock = self._consolidation_locks.setdefault(session.key, asyncio.Lock())
            self._consolidating.add(session.key)
            try:
                async with lock:
                    snapshot = session.messages[session.last_consolidated:]
                    if snapshot:
                        temp = Session(key=session.key)
                        temp.messages = list(snapshot)
                        if not await self._consolidate_memory(temp, archive_all=True):
                            return OutboundMessage(
                                channel=msg.channel, chat_id=msg.chat_id,
                                content="Memory archival failed, session not cleared. Please try again.",
                            )
            except Exception:
                logger.exception("/new archival failed for {}", session.key)
                return OutboundMessage(
                    channel=msg.channel, chat_id=msg.chat_id,
                    content="Memory archival failed, session not cleared. Please try again.",
                )
            finally:
                self._consolidating.discard(session.key)
                if not lock.locked():
                    self._consolidation_locks.pop(session.key, None)

            session.clear()
            self.sessions.save(session)
            self.sessions.invalidate(session.key)
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id,
                                  content="New session started.")
        if cmd == "/help":
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id,
                                  content="🐈 nanoagent commands:\n/new — Start a new conversation\n/stop — Stop the current task\n/help — Show available commands")

        unconsolidated = len(session.messages) - session.last_consolidated
        if (unconsolidated >= self.memory_window and session.key not in self._consolidating):
            self._consolidating.add(session.key)
            lock = self._consolidation_locks.setdefault(session.key, asyncio.Lock())

            async def _consolidate_and_unlock():
                try:
                    async with lock:
                        await self._consolidate_memory(session)
                finally:
                    self._consolidating.discard(session.key)
                    if not lock.locked():
                        self._consolidation_locks.pop(session.key, None)
                    _task = asyncio.current_task()
                    if _task is not None:
                        self._consolidation_tasks.discard(_task)

            _task = asyncio.create_task(_consolidate_and_unlock())
            self._consolidation_tasks.add(_task)

        self._set_tool_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"))
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        # Lean conversational turn (the default Assistant): build a MINIMAL context — skip the
        # per-turn memory FTS5 injection, relevant-skill scoring, and workspace scan, and use a
        # short history window. These add ~15-20s of file I/O + an HTTP round-trip that a quick
        # "what's the capital of X?" chat doesn't need. Task cycles keep the full context.
        _lean = bool(getattr(self, "_lean", False))
        history = session.get_history(max_messages=(8 if _lean else self.memory_window))
        if _lean:
            _memory_ctx, _relevant_skills, _ws_awareness = "", [], ""
        else:
            _memory_ctx = await self.context.memory.get_relevant_memory_context(msg.content)
            _relevant_skills = self.context.skills.get_relevant_skills(msg.content, top_k=2)
            _ws_awareness = self._build_workspace_awareness()
        initial_messages = self.context.build_messages(
            history=history,
            current_message=msg.content,
            media=msg.media if msg.media else None,
            channel=msg.channel, chat_id=msg.chat_id,
            workspace_awareness=_ws_awareness,
            memory_context=_memory_ctx,
            relevant_skill_names=_relevant_skills,
        )

        async def _bus_progress(content: str, *, tool_hint: bool = False, streaming: bool = False, **_: object) -> None:
            meta = dict(msg.metadata or {})
            meta["_progress"] = True
            meta["_tool_hint"] = tool_hint
            if streaming:
                meta["_streaming"] = True
            await self.bus.publish_outbound(OutboundMessage(
                channel=msg.channel, chat_id=msg.chat_id, content=content, metadata=meta,
            ))

        final_content, _tools_used, all_msgs, usage, turn_record = await self._run_agent_loop(
            initial_messages, session_key=key, on_progress=on_progress or _bus_progress,
        )

        if final_content is None:
            final_content = "I've completed processing but have no response to give."

        # Persist the turn record (immune to compaction), NOT a positional slice of the
        # possibly-compacted context list. The old `1 + len(history)` offset went out of
        # range whenever a long, tool-heavy cycle triggered mid-turn compaction, silently
        # dropping the ENTIRE turn from the session — the reply was sent but never
        # remembered. See turn_record in _run_agent_loop.
        if not turn_record:
            logger.warning("Empty turn_record for session {} — turn not persisted", key)
        self._save_turn(session, turn_record, 0)
        self.sessions.save(session)

        # Stage 42 #1 — the fast learning loop. Fires HERE, once per finished turn,
        # and deliberately not inside _run_agent_loop: per-iteration it would cost
        # roughly triple the cycle it is reviewing. Fire-and-forget, restricted to
        # memory/skill tools, and silent on failure — the turn is already done and
        # answered, and its bookkeeping must not be able to undo that.
        self._reviewer.spawn(key, turn_record)

        self.tracer.end_turn({
            "tools_used": _tools_used,
            "iterations": len(_tools_used),  # rough proxy; exact count not tracked here
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
            "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
            "compacted": bool(usage.get("compacted", False)),
        })

        # The message tool already delivered this turn's reply to the agent's own chat,
        # so publishing final_content again would double-post it. This used to be a bare
        # `return None`, which suppressed the duplicate correctly for chat but was wrong
        # for cycles: process_direct() turns None into ("", {}), so the runner saw an
        # empty result AND empty usage, marked an otherwise-successful cycle 'failed'
        # with "produced no output", threw away its real summary, and recorded cost 0 —
        # meaning the cycle's spend never counted against the agent's budget. Verified
        # 2026-08-21: three of Seeker's fully successful cycles were logged as failures
        # this way, each triggering a pointless recovery retry. Carry the content back
        # with a suppression flag and let the chat dispatcher skip publishing instead.
        _already_sent = bool(
            (mt := self.tools.get("message")) and isinstance(mt, MessageTool) and mt._sent_in_turn
        )

        preview = final_content[:120] + "..." if len(final_content) > 120 else final_content
        logger.info("Response to {}:{}: {}", msg.channel, msg.sender_id, preview)

        meta = dict(msg.metadata or {})
        meta["usage"] = usage
        if _already_sent:
            meta["already_sent"] = True

        return OutboundMessage(
            channel=msg.channel, chat_id=msg.chat_id, content=final_content,
            metadata=meta,
        )

    def _save_turn(self, session: Session, messages: list[dict], skip: int) -> None:
        """Save new-turn messages into session, truncating large tool results."""
        from datetime import datetime
        for m in messages[skip:]:
            entry = cast(dict[str, Any], dict(m))
            if entry.get("role") == "tool" and isinstance(entry.get("content"), str):
                content = entry["content"]
                if len(content) > self._TOOL_RESULT_MAX_CHARS:
                    entry["content"] = content[:self._TOOL_RESULT_MAX_CHARS] + "\n... (truncated)"
            if entry.get("role") == "user" and isinstance(entry.get("content"), list):
                entry["content"] = [
                    {"type": "text", "text": "[image]"} if (
                        c.get("type") == "image_url"
                        and c.get("image_url", {}).get("url", "").startswith("data:image/")
                    ) else c
                    for c in entry["content"]
                ]
            entry.setdefault("timestamp", datetime.now().isoformat())
            session.messages.append(entry)
        session.updated_at = datetime.now()

    async def _consolidate_memory(self, session, archive_all: bool = False) -> bool:
        """Delegate to MemoryStore.consolidate(). Returns True on success."""
        return await MemoryStore(self.workspace).consolidate(
            session, self.provider, self.model,
            archive_all=archive_all, memory_window=self.memory_window,
        )

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Process a message directly (for CLI or adapter usage). Returns tuple of (response_text, response_metadata)."""
        await self._connect_mcp()
        msg = InboundMessage(channel=channel, sender_id="user", chat_id=chat_id, content=content)
        response = await self._process_message(msg, session_key=session_key, on_progress=on_progress)
        return (response.content if response else ""), (response.metadata if response else {})
