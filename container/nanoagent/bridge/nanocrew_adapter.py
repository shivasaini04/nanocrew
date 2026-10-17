"""
NanoCrew ↔ NanoAgent Bridge Adapter

Reads a JSON payload from stdin (provided by the NanoCrew orchestrator),
runs NanoAgent's AgentLoop with tools enabled, and writes structured JSON
output to stdout delimited by sentinel markers.

Model selection priority: DeepSeek → Gemini → Moonshot/Kimi → Groq
"""

import sys
import json
import asyncio
import os
import importlib.util
import inspect
import urllib.request
from pathlib import Path

# Add the parent directory to sys.path so 'nanoagent' can be imported
sys.path.insert(0, '/app/nanoagent')
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from nanoagent.agent.loop import AgentLoop
from nanoagent.session.manager import SessionManager
from nanoagent.config import load_config
from nanoagent.bus.queue import MessageBus
from nanoagent.providers.litellm_provider import LiteLLMProvider
from nanoagent.providers.fallback_provider import FallbackProvider
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.worker_policy import apply_worker_policy, is_worker, report_stop_check

OUTPUT_START_MARKER = '---NanoCrew_OUTPUT_START---'
OUTPUT_END_MARKER = '---NanoCrew_OUTPUT_END---'
# Per-request terminator (daemon mode) — lets the orchestrator know one request's
# response is fully emitted, since the process no longer exits between requests.
REQUEST_DONE_MARKER = '---NanoCrew_REQUEST_DONE---'

# Model selection priority — first available API key wins.
# Each entry: (env_var_for_key, litellm_model_name)
# Can be overridden at runtime via NANOBOT_MODEL_FALLBACK_CHAIN env var
# (comma-separated model names, e.g. "deepseek/deepseek-v4-flash,gemini/gemini-3.5-flash").
_PROVIDER_KEY_MAP = {
    "deepseek":   "DEEPSEEK_API_KEY",
    "gemini":     "GEMINI_API_KEY",
    "moonshot":   "MOONSHOT_API_KEY",
    "groq":       "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
# This is the fallback list EVERY warm-daemon cycle uses: daemons are never given
# NANOBOT_MODEL_FALLBACK_CHAIN (nanobot-cycle-runner.ts, daemon path), and the primary is
# always NANOBOT_MODEL, so order here only decides what runs after the agent's own model.
# On 2026-09-30 every entry below the first was dead — DeepSeek direct 402 (no balance),
# Gemini 402 (prepayment used up), Kimi k2.5 404, Groq llama-3.3-70b-versatile 404 — so one
# GLM timeout ended a cycle. OpenRouter is the one funded provider, so it goes first
# (~$0.0017 a call at 40k in / 1k out, and only when the agent's own model has failed
# twice). The rest stay for when their accounts are topped up; a dead one costs ~1 s.
_DEFAULT_CHAIN = [
    ("OPENROUTER_API_KEY", "openrouter/deepseek/deepseek-v4-flash-0731"),
    ("DEEPSEEK_API_KEY",  "deepseek/deepseek-v4-flash"),
    ("GEMINI_API_KEY",    "gemini/gemini-3.5-flash"),  # 2.0-flash retired (404)
    ("MOONSHOT_API_KEY",  "moonshot/kimi-k2.5"),
    ("GROQ_API_KEY",      "groq/openai/gpt-oss-120b"),  # llama-3.3-70b-versatile gone from Groq (404)
]

def _build_model_priority() -> list[tuple[str, str]]:
    chain_env = os.environ.get("NANOBOT_MODEL_FALLBACK_CHAIN", "")
    if not chain_env:
        return _DEFAULT_CHAIN
    result = []
    for model in chain_env.split(","):
        model = model.strip()
        if not model:
            continue
        provider = model.split("/")[0] if "/" in model else model
        env_key = _PROVIDER_KEY_MAP.get(provider, f"{provider.upper()}_API_KEY")
        result.append((env_key, model))
    return result if result else _DEFAULT_CHAIN

MODEL_PRIORITY = _build_model_priority()


def _provider_for_model(model_str: str) -> LiteLLMProvider:
    """Build a LiteLLMProvider for an explicit model string, deriving its API key env
    var the same generic way select_model()'s no-match branch does. Shared by every
    auxiliary-role override (memory, ...) that runs on a different model
    than the cycle's primary one."""
    provider = model_str.split("/")[0] if "/" in model_str else model_str
    env_key = _PROVIDER_KEY_MAP.get(provider, f"{provider.upper()}_API_KEY")
    return LiteLLMProvider(api_key=os.environ.get(env_key, ""), default_model=model_str)


def select_model() -> tuple[str, str]:
    """Select the best available model based on API keys in environment.
    
    Returns:
        (model_name, api_key) tuple
    """
    # Allow explicit override via NANOBOT_MODEL env var
    explicit = os.environ.get("NANOBOT_MODEL")
    if explicit:
        # Match on the model's own provider prefix (first path segment), not a loose
        # substring check — "openrouter/deepseek/deepseek-v4-flash-latest" contains
        # "deepseek" as a substring and would otherwise false-match the DeepSeek entry
        # in MODEL_PRIORITY, handing a DeepSeek key to an OpenRouter-routed call.
        explicit_provider = explicit.lower().split("/")[0]
        for env_key, model_name in MODEL_PRIORITY:
            provider_prefix = model_name.split("/")[0]
            if provider_prefix == explicit_provider:
                return explicit, os.environ.get(env_key, "")
        # No match in MODEL_PRIORITY (e.g. an explicit override outside the platform's
        # default fallback chain) — derive the key the same generic way
        # _build_model_priority() does, rather than returning an empty key and hoping
        # LiteLLM's own env lookup saves it.
        env_key = _PROVIDER_KEY_MAP.get(explicit_provider, f"{explicit_provider.upper()}_API_KEY")
        return explicit, os.environ.get(env_key, "")
    
    # Auto-select: first available key wins
    for env_key, model_name in MODEL_PRIORITY:
        key = os.environ.get(env_key, "")
        if key:
            return model_name, key
    
    # Fallback: Groq with no key (will error, but gives a clear message)
    return "groq/llama-3.3-70b-versatile", ""


def setup_env_mappings():
    """Map non-standard env var names to what NanoAgent's provider registry expects."""
    # .env uses MOONSHOT_KIMI_API_KEY but provider registry expects MOONSHOT_API_KEY
    kimi_key = os.environ.get("MOONSHOT_KIMI_API_KEY")
    if kimi_key and not os.environ.get("MOONSHOT_API_KEY"):
        os.environ["MOONSHOT_API_KEY"] = kimi_key


def load_system_prompt(workspace: Path) -> str | None:
    """Load system prompt from IDENTITY.md in workspace or global directory.
    
    NanoAgent's ContextBuilder looks for bootstrap files (IDENTITY.md, etc.)
    in the workspace directory. This function checks if one exists.
    Returns the content if found, None otherwise.
    """
    # Check both IDENTITY.md (global default) and CLAUDE.md (per-worker override).
    # CLAUDE.md takes precedence — swarm workers write their role prompt there
    # so it isn't overwritten by the global IDENTITY.md copy in container-runner.
    for search_dir in [workspace, Path("/workspace/global")]:
        for filename in ["CLAUDE.md", "IDENTITY.md"]:
            identity_path = search_dir / filename
            if identity_path.exists():
                return identity_path.read_text(encoding="utf-8")
    return None


def load_workspace_tools(workspace: Path, registry) -> int:
    """
    Scan workspace/tools/*.py for standalone Tool subclasses and register them.

    Standalone tools are plain .py files placed directly in workspace/tools/ by the
    agent creation pipeline (Gap 3). They are separate from manifest-based dynamic
    tools, which live in subdirectories (workspace/tools/{name}/manifest.yaml) and
    are already loaded inside AgentLoop.__init__ by ToolLoader.load_persisted_tools().

    Both formats coexist — this function handles the standalone .py format only.
    """
    tools_dir = workspace / "tools"
    if not tools_dir.exists():
        return 0

    count = 0
    for py_file in sorted(tools_dir.glob("*.py")):
        try:
            spec = importlib.util.spec_from_file_location(py_file.stem, py_file)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)  # type: ignore[union-attr]

            for _obj_name, obj in inspect.getmembers(module, inspect.isclass):
                # Skip the base class itself and any class not defined in this file
                if obj is Tool:
                    continue
                if not issubclass(obj, Tool):
                    continue
                if obj.__module__ != module.__name__:
                    continue
                try:
                    instance = obj()
                    registry.register_dynamic(instance)
                    count += 1
                    print(f"[adapter] Loaded tool: {instance.name} (from {py_file.name})", file=sys.stderr)
                except ValueError as e:
                    print(f"[adapter] Skipped tool in {py_file.name}: {e}", file=sys.stderr)
                except Exception as e:
                    print(f"[adapter] Failed to instantiate tool in {py_file.name}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[adapter] Failed to import tool file {py_file.name}: {e}", file=sys.stderr)

    if count > 0:
        print(f"[adapter] Loaded {count} workspace tool(s) from {tools_dir}", file=sys.stderr)
    return count


def load_mcp_servers(*candidate_dirs: Path) -> dict:
    """Load the per-agent MCP servers the NanoCrew orchestrator writes to the agent's
    private group dir as ``mcp-servers.json`` (an array), and convert them to the
    ``{name: MCPServerConfig}`` dict AgentLoop expects.

    This is the bridge that makes dashboard-configured MCP servers actually reach the
    agent at runtime — without it, ``mcp_servers`` defaults to empty and the servers a
    user connects in the UI are silently ignored. MCP is always optional: any missing
    file / parse error / bad entry is skipped, never fatal.

    Multiple candidate dirs are accepted because the file lives on the agent's private
    mount (``/workspace/group``) which is ``state_dir`` for regular + project cycles;
    the first one that has the file wins.
    """
    from nanoagent.config.schema import MCPServerConfig

    seen: set = set()
    for d in candidate_dirs:
        path = d / "mcp-servers.json"
        if path in seen or not path.exists():
            continue
        seen.add(path)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[adapter] mcp-servers.json parse failed ({path}): {e}", file=sys.stderr)
            continue

        servers: dict = {}
        for entry in raw if isinstance(raw, list) else []:
            if not isinstance(entry, dict):
                continue
            if entry.get("enabled") is False:
                continue
            name = entry.get("name")
            if not name:
                continue
            try:
                if entry.get("transport") == "sse" or entry.get("url"):
                    cfg = MCPServerConfig(
                        url=entry.get("url", ""),
                        headers=dict(entry.get("headers", {}) or {}),
                        tool_timeout=int(entry.get("tool_timeout", 30)),
                    )
                else:
                    cfg = MCPServerConfig(
                        command=entry.get("command", ""),
                        args=list(entry.get("args", []) or []),
                        env=dict(entry.get("env", {}) or {}),
                        tool_timeout=int(entry.get("tool_timeout", 30)),
                    )
                servers[name] = cfg
            except Exception as e:
                print(f"[adapter] skipping MCP server {name!r}: {e}", file=sys.stderr)

        if servers:
            print(f"[adapter] Loaded {len(servers)} MCP server(s) from {path}: "
                  f"{', '.join(servers)}", file=sys.stderr)
        return servers

    return {}


def _save_attachments(prompt: str, attachments: list) -> str:
    """Save base64 attachments to /workspace/group/workspace/attachments/ and inject a note into the prompt."""
    import base64

    # Pick the right workspace root depending on context (mirrors workspace selection in main())
    if os.environ.get("PROJECT_ID"):
        ws_root = Path("/workspace/shared")
    else:
        ws_root = Path("/workspace/group")

    attach_dir = ws_root / "workspace" / "attachments"
    attach_dir.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []
    for i, att in enumerate(attachments):
        mime = att.get("mimeType", "application/octet-stream")
        ext  = mime.split("/")[-1].replace("jpeg", "jpg")
        data = att.get("data", "")
        if not data:
            continue
        dest = attach_dir / f"attachment_{i + 1}.{ext}"
        try:
            dest.write_bytes(base64.b64decode(data))
            saved.append(str(dest))
            print(f"[adapter] Saved attachment: {dest}", file=sys.stderr)
        except Exception as e:
            print(f"[adapter] Failed to save attachment {i}: {e}", file=sys.stderr)

    if not saved:
        return prompt

    file_list = "\n".join(f"  - {f}" for f in saved)
    note = (
        f"\n\n[Attached files — use read_image or read_pdf to analyze them:]\n{file_list}\n"
    )
    return prompt + note


# Output-token budget: see resolve_max_tokens and nanoagent/providers/output_limits.py.
from nanoagent.providers.output_limits import (  # noqa: E402
    UNKNOWN_MODEL_MAX_TOKENS, call_timeout_s, step_ceiling,
)


async def handle_request(payload):
    """Process ONE cycle request payload.

    Called once in one-shot mode, or once per request in persistent (daemon) mode.
    All per-cycle state (prompt, session, cycle id, AgentLoop) is derived from the
    payload here — nothing cycle-specific is read from the (daemon-lifetime) env."""
    bot = None   # bound below; the finally block closes its MCP stack if it got that far
    prompt = payload.get("prompt", "")
    session_id = payload.get("sessionId", "default-session")
    secrets = payload.get("secrets", {})
    attachments = payload.get("attachments", [])
    lean = bool(payload.get("lean", False))  # conversational turn → skip heavy per-turn work

    # 1. Stamp CYCLE_ID from the per-request payload so emit_artifact reads the right
    #    value in persistent/warm-daemon mode (the container env is frozen at start;
    #    only the payload carries the current cycle's id across requests).
    cycle_id_payload = payload.get("cycleId")
    if cycle_id_payload:
        os.environ["CYCLE_ID"] = str(cycle_id_payload)

    # 1a. Whether a person directly asked for this cycle. The source tools' what/when gates
    #     (rotation, write gate, contact gate, cooldowns) yield to that; their how-hard
    #     limits never do. See agent/request_origin.py.
    #
    #     Set or CLEARED on every request, never left alone: this daemon serves many
    #     requests, and a "1" surviving from a chat turn would let the next scheduled cycle
    #     skip rotation — the starvation rotation exists to prevent.
    if payload.get("humanRequested") is True:
        os.environ["NANOCREW_HUMAN_REQUEST"] = "1"
    else:
        os.environ.pop("NANOCREW_HUMAN_REQUEST", None)

    # 1b. Same reasoning for the self-management bearer token: it is minted per cycle and
    #     arrives in the payload, because a warm daemon's env is frozen at container start.
    #     Clear it when absent so a stale token from the previous request on this daemon
    #     can never be replayed by the current one.
    cycle_token = payload.get("cycleToken")
    if cycle_token:
        os.environ["NANOCREW_CYCLE_TOKEN"] = str(cycle_token)
    else:
        os.environ.pop("NANOCREW_CYCLE_TOKEN", None)

    # 1b-ii. stage 49 phase 2: the browser-session vault key. Same payload-not-env and
    #     clear-when-absent rules as above, for the daemon reason rather than the rotation
    #     one — one warm daemon serves several agents over its life, so a per-agent secret
    #     left behind by the previous request would let this cycle decrypt another agent's
    #     saved logins. Unlike the cycle token this value is STABLE for a given agent:
    #     that is what makes a login survive to the next cycle at all.
    vault_secret = payload.get("vaultSecret")
    if vault_secret:
        os.environ["NANOCREW_VAULT_SECRET"] = str(vault_secret)
    else:
        os.environ.pop("NANOCREW_VAULT_SECRET", None)

    # 1b-iii. stage 55 phase 1: which keys of the agent's own .nanocrew/settings.json may
    #     take effect. Read by nanocrewSettings.load() when it merges the two tiers that
    #     live inside the agent's writable workspace.
    #
    #     Set even when the list is EMPTY, and cleared only when the field is absent
    #     entirely — because "" and unset mean different things here: "" is a real policy
    #     saying this agent may set nothing, and unset means no orchestrator, apply the
    #     file as-is. Getting that backwards would either brick standalone nanoagent or
    #     reopen the escalation path this exists to close.
    allowed_settings = payload.get("allowedSettings")
    if isinstance(allowed_settings, list):
        os.environ["NANOCREW_ALLOWED_SETTINGS"] = ",".join(str(k) for k in allowed_settings)
    else:
        os.environ.pop("NANOCREW_ALLOWED_SETTINGS", None)

    # 1c. stage45 doc 05: which of the owner browsers this cycle may drive, if any. Same
    #     payload-not-env reasoning again, and the same clear-when-absent rule: a warm
    #     daemon must not keep driving a browser for a later cycle that was never opted in.
    browser_controller = payload.get("browserControllerId")
    if browser_controller:
        os.environ["NC_BROWSER_CONTROLLER_ID"] = str(browser_controller)
    else:
        os.environ.pop("NC_BROWSER_CONTROLLER_ID", None)

    # 1d. stage 60 phase 1: the operator's browser picker for this message ('local' |
    #     'cloud'). Cleared when absent, or a warm daemon would carry one message's choice
    #     into the next scheduled cycle, which made no such choice.
    # Stage 60 phase 4: the agent's name, for the permission dialogs on the user's machine.
    agent_name = payload.get("agentName")
    if isinstance(agent_name, str) and agent_name.strip():
        os.environ["AGENT_NAME"] = agent_name.strip()[:80]
    else:
        os.environ.pop("AGENT_NAME", None)

    browser_lane = payload.get("browserLane")
    if browser_lane in ("local", "cloud"):
        os.environ["NC_BROWSER_LANE"] = browser_lane
    else:
        os.environ.pop("NC_BROWSER_LANE", None)

    # 2. Inject Secrets into Environment Variables
    for k, v in secrets.items():
        if v:
            os.environ[k] = str(v)

    # 3. Map env var names for provider compatibility
    setup_env_mappings()

    # 3b. Save image/file attachments from the payload to the workspace so the agent
    #     can use read_image / read_pdf on them.
    if attachments:
        prompt = _save_attachments(prompt, attachments)

    # 4. Select the primary model and build a fallback provider chain.
    # All providers with available API keys are tried in MODEL_PRIORITY order.
    model, api_key = select_model()
    print(f"[adapter] Selected model: {model}", file=sys.stderr)

    # When LITELLM_PROXY_URL is set, route ALL calls through the proxy.
    # The proxy owns provider keys and handles fallback natively — we use a
    # single LiteLLMProvider with the proxy as api_base.
    _proxy_url = os.environ.get("LITELLM_PROXY_URL", "").rstrip("/")
    _proxy_key = os.environ.get("LITELLM_PROXY_KEY", "sk-nanocrew-proxy")

    _chain: list[tuple[LiteLLMProvider, str]] = []
    if _proxy_url:
        print(f"[adapter] LiteLLM proxy active: {_proxy_url}", file=sys.stderr)
        # Multiple models through the ONE proxy, rather than a single-entry chain.
        #
        # Proxy mode used to build a chain of one and delegate failover entirely to
        # litellm's router_settings.fallbacks. Those fallbacks are configured and their
        # targets are registered — and a DeepSeek "Service is too busy" still killed live
        # cycles, with no fallback attempt visible in the proxy logs. Whatever the reason,
        # relying on it means one provider having a bad hour stops every agent on the
        # platform.
        #
        # FallbackProvider retrying a different model against the same proxy costs nothing
        # when the primary is healthy and is independent of the router behaving as
        # documented. Belt and braces on the single external dependency every cycle has.
        # Built from DIRECT provider keys, not proxy-backed entries.
        #
        # The first version of this chain used api_base=<proxy> for every entry and broke
        # production immediately. litellm recognises the `deepseek/` prefix, strips it, and
        # posts model=deepseek-v4-flash to whatever api_base it was given — and the proxy
        # only knows the prefixed name, so every call 400'd with "Invalid model name".
        #
        # It had never been exercised: with a single entry, `len(_chain) > 1` was false and
        # the constructor below fell through to a direct LiteLLMProvider with the real
        # provider key. The chain was constructed and discarded. Giving it more entries
        # activated a path that had never worked.
        #
        # So entry 0 is exactly what worked before — direct, real key — and the rest are
        # other providers with their own keys. Behaviour is unchanged while the primary is
        # healthy, and failover no longer depends on the proxy's model naming.
        _chain = [(LiteLLMProvider(api_key=api_key, default_model=model), model)]
        for _env_key, _model_name in MODEL_PRIORITY:
            if _model_name == model:
                continue
            _k = os.environ.get(_env_key, "")
            if _k:
                _chain.append((LiteLLMProvider(api_key=_k, default_model=_model_name), _model_name))
    else:
        # Direct provider chain. Entry 0 must be the model select_model() actually
        # resolved (agent/task override, or the default) — building this purely from
        # MODEL_PRIORITY silently discarded any override outside that 3-model default
        # chain whenever 2+ of its providers had keys (the normal case in prod), so an
        # explicit NANOBOT_MODEL never actually ran. Mirror the proxy branch above:
        # explicit selection first, then the rest of MODEL_PRIORITY as true fallback.
        if api_key:
            _chain.append((LiteLLMProvider(api_key=api_key, default_model=model), model))
        for _env_key, _model_name in MODEL_PRIORITY:
            if _model_name == model:
                continue
            _key = os.environ.get(_env_key, "")
            if _key:
                _chain.append((LiteLLMProvider(api_key=_key, default_model=_model_name), _model_name))
        if not _chain:
            # No keys found — add an empty provider to give a clear error message
            _chain = [(LiteLLMProvider(api_key="", default_model=model), model)]
        if len(_chain) > 1:
            print(f"[adapter] Fallback chain: {[m for _, m in _chain]}", file=sys.stderr)

    # 5. Initialize NanoAgent Agent with tools enabled
    try:
        # Pick the correct persistent workspace mount for each context:
        #   - Projects: /workspace/shared → host: projects/{projectId}/workspace
        #   - Regular:  /workspace/group  → host: groups/{folder}
        extra_read_dirs: list = []
        if os.environ.get("PROJECT_ID"):
            # Project cycles: agent FILES go to the shared workspace, but the agent's
            # private state (sessions, telemetry) stays in its own mount — never pollute
            # the shared project folder, and keep the persistent session continuous.
            workspace = Path("/workspace/shared")
            state_dir = Path("/workspace/group")
            # Let the agent READ its private mount (pins, prior notes) while working in
            # the project — reads only; writes stay confined to the shared workspace.
            extra_read_dirs = [Path("/workspace/group")]
        else:
            workspace = Path("/workspace/group")
            state_dir = workspace

        # Telemetry → private state dir (JsonlSink honours nanocrew_LOG_DIR).
        os.environ["nanocrew_LOG_DIR"] = str(state_dir / ".nanocrew" / "telemetry")
        bus = MessageBus()

        _resolved_max_tokens = resolve_max_tokens([m for _, m in _chain] or [model])
        provider = FallbackProvider(
            _chain,
            per_provider_timeout=call_timeout_s(_resolved_max_tokens),
            output_caps={m: step_ceiling(m) for _, m in _chain},
        ) if len(_chain) > 1 else LiteLLMProvider(
            api_key=api_key,
            default_model=model,
        )

        # Get Brave API key for web search (optional — falls back to DDGS)
        brave_api_key = os.environ.get("BRAVE_API_KEY")

        # Per-agent MCP servers configured in the dashboard. The orchestrator writes
        # them to mcp-servers.json on the agent's private group mount; state_dir points
        # there for regular + project cycles (workspace does too for regular cycles).
        mcp_servers = load_mcp_servers(state_dir, workspace, Path("/workspace/group"))
        # A stage 57 worker gets exactly its allowlist (applied below), and MCP tools are
        # registered lazily after that — so they would slip past it. A worker has none.
        if is_worker(payload):
            mcp_servers = {}

        bot = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=workspace,
            model=model,
            brave_api_key=brave_api_key,
            # Not locked to the workspace (was True until 2026-09-14, removed at the
            # owner's request). Each cycle runs in its own disposable container, which is
            # the real boundary; inside it, file tools and exec may use any path. The
            # always-on floor in agent/security.py still refuses wiping / or /workspace,
            # disk formats, shutdown, and piping secrets off the box.
            restrict_to_workspace=False,
            # Sessions live in the private state dir, not the (possibly shared) workspace.
            session_manager=SessionManager(state_dir),
            extra_read_dirs=extra_read_dirs,
            mcp_servers=mcp_servers,
            # Was the AgentLoop default of 90 steps, then 400. Since 2026-09-30 a cycle has
            # no wall-clock limit (src/agents/liveness.ts) — it may work for hours or days —
            # so a step count is no longer what should end one. What bounds a cycle now is
            # money (the daily budget is enforced mid-cycle by the orchestrator, which
            # interrupts the loop when it is spent), silence (the liveness watchdog), and the
            # loop's own identical-call abort. 10,000 steps at ~30 s each is ~3.5 days; it
            # is a runaway backstop, not a working limit. Override per agent with a
            # NANOBOT_MAX_ITERATIONS secret.
            max_iterations=int(os.environ.get("NANOBOT_MAX_ITERATIONS", "") or 10000),
            # Output budget, derived per-model from litellm rather than a flat constant.
            # See resolve_max_tokens() for why 4096 silently produced empty turns, and why
            # the chain minimum rather than the primary model's limit is the safe answer.
            max_tokens=_resolved_max_tokens,
        )

        # Drop `message` on the NanoCrew path.
        #
        # It publishes to bus.outbound — an asyncio.Queue created fresh a few lines above
        # and handed to AgentLoop. Standalone nanoagent drains that queue (see
        # _consume_outbound in cli/commands.py); nothing here does, and nothing ever has.
        # So a NanoCrew agent calling `message` got a cheerful "Message sent to ..." for a
        # message that was discarded when the cycle ended — and it was in the advertised
        # CORE set, so the model saw it constantly.
        #
        # Unregistering is better than leaving it to fail loudly: send_whatsapp and notify
        # cover the real delivery paths, and a tool the model cannot see is a tool it
        # cannot waste a turn on.
        if bot.tools.has("message"):
            bot.tools.unregister("message")
            print("[adapter] Unregistered 'message' (no outbound consumer on the NanoCrew path)", file=sys.stderr)

        # The outbound tools (email, WhatsApp, voice, messaging) this agent's owner has not
        # granted. Every other tool stays: there is no per-agent tool allowlist any more
        # (removed 2026-09-14 — it had withheld emit_artifact from an agent asked to make
        # an artifact). See tool-grants.ts on the orchestrator side.
        #
        # withdraw(), not unregister(), so the registry can still restore a tool — and
        # applied before workspace tools load, like the allowlist it replaces.
        withheld_tools = payload.get("withheldTools")
        if isinstance(withheld_tools, list):
            withdrawn = [str(t) for t in withheld_tools if bot.tools.has(str(t))]
            for name in withdrawn:
                bot.tools.withdraw(name)
            if withdrawn:
                print(
                    f"[adapter] Outbound tools not granted, withheld: {', '.join(sorted(withdrawn))}",
                    file=sys.stderr,
                )

        # Advertise the tools this agent's owner declared, from turn one.
        #
        # With DEFERRED_TOOLS=on the model only sees a CORE set; everything else waits for
        # tool_search. For a source agent that hides its whole job. On 2026-09-10 Crawler
        # was asked to call yc_jobs, called a tool missing from its schema list, and the
        # provider could not turn that into a structured call — it leaked out as text and the
        # loop ended the cycle having run nothing, twice in a row.
        #
        # activate() only ever ADDS visibility and is a no-op when deferral is off. It runs
        # after the policy withdraw above on purpose: a withdrawn tool is no longer in the
        # registry, so it lands in `unknown` and cannot be advertised back into existence.
        advertised = payload.get("advertisedTools")
        if isinstance(advertised, list) and advertised:
            activated, _unknown = bot.tools.activate([str(t) for t in advertised])
            if activated:
                print(
                    f"[adapter] Advertised {len(activated)} declared tool(s) past deferral: "
                    f"{', '.join(sorted(activated)[:12])}",
                    file=sys.stderr,
                )

        # Load standalone .py tools from workspace/tools/*.py
        # These are placed by the agent creation pipeline at agent creation time.
        # Manifest-based tools (workspace/tools/{name}/manifest.yaml) are already
        # loaded inside AgentLoop.__init__ by ToolLoader.load_persisted_tools().
        load_workspace_tools(workspace, bot.tools)

        # Stage 57 worker: report_result, then its allowlist. Last, after workspace tools,
        # so nothing loaded afterwards gets past it. See worker_policy.py.
        if is_worker(payload):
            dropped = apply_worker_policy(bot.tools, payload, state_dir / "result.json")
            bot.stop_check = report_stop_check(state_dir / "result.json")
            print(
                f"[adapter] Worker tools: {', '.join(sorted(bot.tools.tool_names))} "
                f"({len(dropped)} removed)",
                file=sys.stderr,
            )

        # 6. Process the message with streaming support
        results = []
        activity_steps = []
        activity_file = workspace / "activity.json"
        pending_text_chunks: list[str] = []  # accumulate assistant text between tool calls

        # Phase 2: push the current step list to the orchestrator for real-time
        # chat streaming + durable DB persistence, in addition to the local file
        # (which the legacy file-watcher / group path still use). POST is synchronous
        # so pushes stay ordered (on_progress calls are sequential); errors are
        # swallowed so a network hiccup never breaks the cycle.
        #
        # Not from a stage 57 worker. It runs under its owner's AGENT_ID, so its steps
        # landed in the owner's chat as the owner's own messages — seen live 2026-09-29,
        # three workers left eight "Assistant" bubbles ahead of the real answer. A worker
        # answers through report_result; its steps stay in its own activity.json.
        _push_host = None if is_worker(payload) else os.environ.get("NanoCrew_HOST")
        _push_agent = os.environ.get("AGENT_ID")
        # cycle id is per-request (the daemon serves many cycles), so prefer the
        # payload; fall back to env for the legacy one-shot invocation.
        _push_cycle = payload.get("cycleId") or os.environ.get("CYCLE_ID")

        # Bound the live PUSH payload to a recent window instead of the full
        # cumulative activity_steps list. The orchestrator's own diffing
        # (streamCycleSteps) already ignores any step index below what it's
        # already seen, so for a long cycle every push beyond the window was
        # pure waste: re-serializing and re-transmitting hundreds of already-
        # acknowledged steps (including their full tool input/output content)
        # on every single new tool call is O(cycle_length^2) data transfer AND
        # JSON parse cost on the orchestrator side. A 900+ step research cycle
        # (a real sweep run, not a hypothetical) made this the dominant cost —
        # confirmed as the trigger for a V8 heap-exhaustion crash that took the
        # whole orchestrator down, not just this agent's session. startSeq tells
        # the orchestrator what real sequence number steps[0] in this push
        # corresponds to, so it can still map indices correctly.
        _PUSH_WINDOW = 60

        def persist_activity():
            """Write activity.json locally AND push it to the orchestrator."""
            try:
                # Stamp the cycle id: activity.json lives at a fixed path in the
                # workspace and is overwritten each run, so without this the
                # orchestrator's end-of-cycle snapshot cannot tell a fresh file from
                # a leftover one. A cycle that dies before its first tool call never
                # rewrites this file, and the stale trace would be attributed to it.
                # This local file keeps the FULL array (it's the legacy fallback
                # source for the end-of-cycle snapshot, not a per-push wire payload).
                activity_file.write_text(json.dumps({"cycleId": _push_cycle, "steps": activity_steps}))
            except Exception:
                pass
            if _push_host and _push_agent and _push_cycle:
                try:
                    _start_seq = max(0, len(activity_steps) - _PUSH_WINDOW)
                    _window = activity_steps[_start_seq:]
                    body = json.dumps({"startSeq": _start_seq, "steps": _window}).encode("utf-8")
                    req = urllib.request.Request(
                        f"{_push_host}/api/agents/{_push_agent}/cycles/{_push_cycle}/steps",
                        data=body,
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    urllib.request.urlopen(req, timeout=2).read()
                except Exception:
                    pass

        def flush_pending_text():
            """Flush accumulated assistant text as a thinking step (if any)."""
            text = "".join(pending_text_chunks).strip()
            pending_text_chunks.clear()
            if not text:
                return
            activity_steps.append({
                "type": "thinking",
                "id": f"th-{len(activity_steps)}",
                "content": text,
            })

        # Cap on each persisted tool output so activity.json doesn't bloat with
        # large file reads / web responses (the dashboard only previews them).
        _TOOL_OUTPUT_CAP = 4000

        async def on_progress(content: str, **kwargs):
            """Stream intermediate results back to orchestrator."""
            if kwargs.get("tool_hint"):
                # Flush any assistant narration text that preceded this tool call
                flush_pending_text()
                # Save structured tool call info to activity.json for the dashboard
                raw_calls = kwargs.get("tool_calls_raw", [])
                for tc in raw_calls:
                    step = {
                        "type": "tool_call",
                        "id": f"tc-{len(activity_steps)}",
                        "tool": tc.get("name", "unknown"),
                        "input": json.dumps(tc.get("arguments", {})),
                        "output": None,
                    }
                    activity_steps.append(step)
                persist_activity()
                return  # Skip tool hint messages from stdout output
            if kwargs.get("tool_result"):
                # Pair tool results with their dispatch tool_call steps in dispatch
                # ORDER. The original walk-backwards-and-match-by-name approach broke
                # for concurrent same-tool calls: when 3 verify_email calls were
                # dispatched via asyncio.gather and 3 results arrived in the same
                # input order, the reverse walk paired result[0] with step[2],
                # result[1] with step[1], etc — inverting the inputs/outputs in the
                # cycle drawer. The LLM saw correct results via tool_call_id pairing
                # in the message context; only the persisted activity.json was wrong.
                #
                # Fix: take the last N tool_call steps with output=None (the
                # most-recent batch, in dispatch order) and pair them positionally
                # with the N results. Defensive name check on each pair to catch
                # logic errors silently rather than corrupting the trace.
                raw_results = kwargs.get("tool_results_raw", [])
                if raw_results:
                    n = len(raw_results)
                    pending_steps = [
                        s for s in activity_steps
                        if s.get("type") == "tool_call" and s.get("output") is None
                    ]
                    most_recent = pending_steps[-n:]  # last N in dispatch order
                    for tr, step in zip(raw_results, most_recent):
                        if step.get("tool") != tr.get("name"):
                            # Pairing assumption broke — skip this one rather than mis-attribute.
                            continue
                        result = tr.get("result", "")
                        if isinstance(result, str) and len(result) > _TOOL_OUTPUT_CAP:
                            result = result[:_TOOL_OUTPUT_CAP] + f"... [truncated, {len(tr.get('result', ''))} chars total]"
                        step["output"] = result
                persist_activity()
                return  # Skip tool result events from stdout output
            # Accumulate assistant text for the thinking step
            pending_text_chunks.append(content)
            print_output(content, session_id, status="success")

        # Lean conversational turn → minimal context build (see AgentLoop turn handler).
        bot._lean = lean
        response_text, response_metadata = await bot.process_direct(
            content=prompt,
            session_key=session_id,
            on_progress=on_progress,
        )
        # Flush any trailing assistant text after the last tool call
        flush_pending_text()
        if activity_steps:
            persist_activity()
        usage = response_metadata.get("usage", {})

        # 7. Consolidate memory — extract key facts and save to MEMORY.md.
        #    Skipped for lean conversational turns: it's an ~8s LLM call after every
        #    reply, which is pure overhead for quick chat. Task cycles still consolidate.
        if not lean:
            try:
                session = bot.sessions.get_or_create(session_id)
                if session:
                    mem_provider, mem_model = provider, model
                    mem_model_override = os.environ.get("NANOBOT_MEMORY_MODEL", "")
                    if mem_model_override and mem_model_override != model:
                        mem_provider = _provider_for_model(mem_model_override)
                        mem_model = mem_model_override
                    await bot.context.memory.consolidate(
                        session, mem_provider, mem_model
                    )
            except Exception as mem_err:
                print(f"[adapter] Memory consolidation failed (non-fatal): {mem_err}", file=sys.stderr)

        # 8b. Wait for the post-turn learning review, for exactly the same reason.
        #
        # Stage 42 #1 spawns a review task at the end of _process_message and returns
        # immediately. Nothing kept it alive: a one-shot cycle ends at asyncio.run(),
        # which cancels every pending task, and in daemon mode the `finally` below
        # tears down the MCP stack while the review is still using the provider. The
        # review needs up to 4 sequential model round-trips, so it never survived long
        # enough to write anything — which is why the flag was on for 13h across ~10
        # Mailer cycles and produced zero skills and an empty ledger.
        #
        # Bounded, and never fatal: the turn is already answered and printed below, so
        # bookkeeping that overruns gets cancelled rather than holding the cycle open.
        reviewer = getattr(bot, "_reviewer", None)
        if reviewer is not None and getattr(reviewer, "pending", 0):
            try:
                if not await reviewer.drain():
                    print("[adapter] Background review timed out — cancelled", file=sys.stderr)
            except Exception as rev_err:  # noqa: BLE001 - must never fail a finished turn
                print(f"[adapter] Background review drain failed (non-fatal): {rev_err}", file=sys.stderr)

        # 9. Return final output. `already_sent` in response_metadata is deliberately NOT
        # forwarded: in a cycle the message tool posts to `cli:direct`, which is not a real
        # conversation, so the orchestrator's own chat post is the only copy the user sees.
        print_success(response_text, session_id, usage, model)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[adapter] Error: {tb}", file=sys.stderr)
        print_error(f"Agent execution failed: {str(e)}")

    finally:
        # Tear down this request's MCP connections in the same task that opened them.
        #
        # handle_request builds a FRESH AgentLoop per request, and _connect_mcp() opens an
        # AsyncExitStack holding one anyio task group per MCP server. Nothing on this path
        # ever closed it — close_mcp() is only called from the CLI — so in daemon mode
        # (NANOBOT_PERSISTENT=on) every cycle leaked a stack and its stdio subprocesses.
        # When one of those orphaned stacks was finally garbage-collected, anyio unwound its
        # cancel scope from whatever task happened to be running and raised "Attempted to
        # exit cancel scope in a different task than it was entered in", killing the daemon
        # mid-cycle with exit code 1.
        #
        # Seen 2026-08-22: Crawler failed four consecutive lead_search cycles this way,
        # 6-15 minutes in, at a different tool each time — the timing follows GC, not any
        # particular tool. Its retries reused one warm daemon, which is what made the leak
        # accumulate fast enough to notice. close_mcp() already swallows the RuntimeError
        # and BaseExceptionGroup this teardown can raise; the belt-and-braces guard here is
        # so a failure to clean up can never mask a result that was already emitted.
        try:
            if bot is not None:
                await bot.close_mcp()
        except BaseException as _mcp_exc:   # noqa: BLE001 - cleanup must never fail a cycle
            print(f"[adapter] MCP teardown ignored: {_mcp_exc}", file=sys.stderr)


def print_output(result: str, session_id: str, status: str = "success"):
    """Print a structured output block (can be called multiple times for streaming)."""
    output = {
        "status": status,
        "result": result,
        "newSessionId": session_id
    }
    
    print(OUTPUT_START_MARKER)
    print(json.dumps(output))
    print(OUTPUT_END_MARKER)
    sys.stdout.flush()


def print_success(result: str, session_id: str, usage: dict = None, model: str = None):
    output = {
        "status": "success",
        "result": result,
        "newSessionId": session_id,
        "usage": usage or {},
        "model": model
    }
    
    print(OUTPUT_START_MARKER)
    print(json.dumps(output))
    print(OUTPUT_END_MARKER)
    sys.stdout.flush()   # flush BEFORE exit — in daemon mode SystemExit is caught,
    sys.exit(0)          # so the interpreter's exit-time flush never runs.

def print_error(error_msg: str):
    output = {
        "status": "error",
        "result": None,
        "error": error_msg
    }

    print(OUTPUT_START_MARKER)
    print(json.dumps(output))
    print(OUTPUT_END_MARKER)
    sys.stdout.flush()
    sys.exit(1)


def resolve_max_tokens(models: list[str]) -> int:
    """One agent step's output-token budget: the PRIMARY model's own ceiling.

    max_tokens caps the model's output per call, and on a reasoning model the internal
    reasoning pass is billed against that same budget before a single character of the
    answer is written. AgentLoop's old flat 4096 default meant a rule-dense prompt over
    enough data spent its whole allowance thinking and returned empty content with
    finish_reason "length" — no error, full cost, nothing produced.

    This used to be the minimum across the whole fallback chain, with 8,192 for any model
    litellm didn't know. That held GLM 5.3 Flash — 943,717 by OpenRouter's own figure — to
    8,192 on every call because litellm had no entry for it and DeepSeek sat later in the
    chain. Now the primary's ceiling comes from its
    provider (output_limits.model_output_cap), bounded by PRACTICAL_MAX_TOKENS because
    max_tokens competes with the prompt for the context window; and FallbackProvider clamps
    each fallback call to that model's own ceiling, so a smaller model later in the chain
    no longer shrinks every call.

    NANOBOT_MAX_TOKENS may lower the budget, never raise it past what the provider accepts.
    """
    ceiling = step_ceiling(models[0]) if models else UNKNOWN_MODEL_MAX_TOKENS
    override = os.environ.get("NANOBOT_MAX_TOKENS")
    if override:
        try:
            return max(1, min(int(override), ceiling))
        except (TypeError, ValueError):
            pass
    return ceiling


async def main():
    """Entry point. One-shot mode (default) reads a single payload from stdin and
    exits. Persistent mode (NANOBOT_PERSISTENT=on) keeps the process — and the warm
    litellm/model client — alive, serving one JSON request per stdin line until EOF.
    print_success/print_error raise SystemExit; in the loop we catch it so a finished
    (or failed) request doesn't tear down the daemon."""
    if os.environ.get("NANOBOT_PERSISTENT", "off") == "on":
        loop = asyncio.get_event_loop()
        print("[adapter] persistent daemon ready", file=sys.stderr, flush=True)
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if line == "":          # EOF — pipe closed, shut down
                break
            line = line.lstrip("﻿").strip()   # tolerate a stray UTF-8 BOM
            if not line:
                continue
            try:
                payload = json.loads(line)
            except Exception as e:
                print_error_safe(f"Failed to parse request JSON: {str(e)}")
                continue
            try:
                await handle_request(payload)
            except SystemExit:
                pass                # print_success/error already emitted the result marker
            except Exception as e:
                print_error_safe(f"Request crashed: {str(e)}")
            print(REQUEST_DONE_MARKER)   # terminate this request's response
            sys.stdout.flush()
            sys.stderr.flush()
    else:
        try:
            payload = json.loads(sys.stdin.read().lstrip("﻿"))   # tolerate a stray BOM
        except Exception as e:
            print_error(f"Failed to parse stdin JSON: {str(e)}")
            return
        await handle_request(payload)


def print_error_safe(error_msg: str):
    """Emit an error marker WITHOUT exiting — for the daemon loop's own framing errors."""
    print(OUTPUT_START_MARKER)
    print(json.dumps({"status": "error", "result": None, "error": error_msg}))
    print(OUTPUT_END_MARKER)
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
