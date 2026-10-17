"""LiteLLM provider implementation for multi-provider support."""

import asyncio
import contextvars
import json
import json_repair
import os
import random
import re
from typing import Any, Awaitable, Callable

import litellm
from litellm import acompletion

from nanoagent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanoagent.providers.registry import find_by_model, find_gateway, find_gateway_by_prefix

# Set around a call that needs only a short structured answer — see the `reasoning` block
# in LiteLLMProvider.chat. A context variable rather than a chat() parameter so every
# provider and wrapper (FallbackProvider, test doubles) stays call-compatible.
from nanoagent.providers.output_limits import reasoning_budget, supports_reasoning  # noqa: E402

reasoning_effort_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("reasoning_effort", default=None)


# Standard OpenAI chat-completion message keys plus reasoning_content for
# thinking-enabled models (Kimi k2.5, DeepSeek-R1, etc.).
_ALLOWED_MSG_KEYS = frozenset({"role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content"})

# Providers whose chat API rejects `reasoning_content` on an assistant message. It is the
# opposite of DeepSeek, which requires the key once thinking is on — so _sanitize_messages
# keeps it, and it is dropped here only for these. Groq answers 400 "property
# 'reasoning_content' is unsupported": on 2026-09-30 a GLM 5.3 cycle timed out, fell back
# through the chain to groq/llama-3.3-70b-versatile, and died on that 400 because its
# history carried GLM's reasoning.
_REJECTS_REASONING_CONTENT = ("groq",)


def _strip_reasoning_for(model: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop reasoning_content when `model` routes to a provider that rejects it."""
    segments = (model or "").lower().split("/")
    if not any(p in segments[:-1] for p in _REJECTS_REASONING_CONTENT):
        return messages
    return [{k: v for k, v in m.items() if k != "reasoning_content"} for m in messages]

# Some models (observed on DeepSeek, 2026-08-17) occasionally emit a batch of
# tool calls as literal pseudo-XML text in .content instead of the provider's
# structured tool_calls field — e.g. `<DSMLtool_calls><DSMLinvoke name="read_file">
# <DSMLparameter name="path">...</DSMLparameter></DSMLinvoke></DSMLtool_calls>`.
# Undetected, this is silently fatal: has_tool_calls is False, so the loop
# treats the raw markup as the agent's final answer and ends the turn — a lead-
# qualification cycle stopped here mid-task, with the tags landing in the chat
# as if they were the agent's own words. Recover real tool calls from it instead
# of letting the turn die. Tag-name-flexible ("DSMLinvoke", "invoke", "Invoke", …)
# since the exact made-up prefix isn't guaranteed to repeat.
_PSEUDO_INVOKE_RE = re.compile(
    r'<\w*[Ii]nvoke\s+name="([^"]+)"[^>]*>(.*?)</\w*[Ii]nvoke>', re.DOTALL,
)
_PSEUDO_PARAM_RE = re.compile(
    r'<\w*[Pp]arameter\s+name="([^"]+)"[^>]*>(.*?)</\w*[Pp]arameter>', re.DOTALL,
)

# GLM's native shape, which the DeepSeek pattern above cannot see: no `name=` attribute
# anywhere, the tool name is bare text straight after the opening tag, and arguments are
# alternating key/value elements —
#   <tool_call>yc_jobs<arg_key>action</arg_key><arg_value>sweep</arg_value></tool_call>
# Observed 2026-09-10 on openrouter/z-ai/glm-5.3-flash (Crawler a live cycle, when
# the model called a deferred tool that was not in its schema list: the provider could not
# convert it, so it arrived as .content and ended the cycle with nothing run.
#
# This is the backstop, not the fix. The fix is advertising an agent's declared tools so
# the call is structured in the first place. A second leak in the same session (83011180)
# arrived with its opening `<tool_call>yc_jobs` already cut off — no name survives in that
# text, and recovery that guessed one would run a tool nobody chose.
_GLM_CALL_RE = re.compile(
    r'<tool_call>\s*([A-Za-z_][\w.\-]*)\s*((?:<arg_key>.*?</arg_key>\s*<arg_value>.*?</arg_value>\s*)*)</tool_call>',
    re.DOTALL,
)
_GLM_ARG_RE = re.compile(r'<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>', re.DOTALL)


def _coerce_pseudo_param(value: str) -> Any:
    """Best-effort typing for a pseudo-XML parameter value — it arrives as raw
    text with no JSON schema to anchor it, so recover bool/number/JSON where the
    text unambiguously looks like one, and fall back to the literal string."""
    v = value.strip()
    low = v.lower()
    if low in ("true", "false"):
        return low == "true"
    if v and (v[0] in "{[" or re.fullmatch(r"-?\d+(\.\d+)?", v)):
        try:
            return json.loads(v)
        except Exception:
            pass
    return value


def _parse_pseudo_xml_tool_calls(content: str) -> list[ToolCallRequest]:
    """Recover tool calls a model emitted as pseudo-XML text rather than a real
    structured tool call. Returns [] if nothing matches, so callers can treat it
    as a plain no-op fallback."""
    calls: list[ToolCallRequest] = []
    for i, m in enumerate(_PSEUDO_INVOKE_RE.finditer(content)):
        name, body = m.group(1), m.group(2)
        args = {pm.group(1): _coerce_pseudo_param(pm.group(2)) for pm in _PSEUDO_PARAM_RE.finditer(body)}
        if name and args:
            calls.append(ToolCallRequest(id=f"pseudo_{i}", name=name, arguments=args))
    if calls:
        return calls

    # GLM shape. A zero-argument call is legitimate here (unlike the DeepSeek shape, where
    # an invoke with no parameters is more likely a fragment), so only the name is required.
    # Identical calls in one response are collapsed: the same leaked call was seen quoted
    # twice in one message, and replaying it would run a 15-minute sweep twice.
    seen: set[str] = set()
    for i, m in enumerate(_GLM_CALL_RE.finditer(content)):
        name = m.group(1).strip()
        args = {am.group(1).strip(): _coerce_pseudo_param(am.group(2)) for am in _GLM_ARG_RE.finditer(m.group(2))}
        key = name + json.dumps(args, sort_keys=True, default=str)
        if not name or key in seen:
            continue
        seen.add(key)
        calls.append(ToolCallRequest(id=f"pseudo_glm_{i}", name=name, arguments=args))
    return calls

# HTTP statuses worth another attempt vs. ones where retrying can only waste budget.
#
# Both paths now decide with _should_retry. They did NOT used to, despite a comment here
# saying they did: the non-streaming path tested `status in _RETRYABLE` (an allowlist,
# so anything unrecognised raised at once) while the streaming path tested
# `status in _FATAL` (a denylist, so anything unrecognised RETRIED). Every real cycle
# streams, so the denylist is the one that ran.
#
# What that cost, measured on prod 2026-09-21: DeepSeek answers an unfunded key with
# 402 "Insufficient Balance" in 0.6 s. 402 is in neither set. The streaming path read
# that as transient and slept 1+2+4+8+16+32+60 = 123 s — past FallbackProvider's 120 s
# bound, so every call surfaced as `TimeoutError ()` with an empty message and no hint
# that the real answer had arrived, definitively, in under a second. Three model calls
# into one verify run: 15:53:06 -> 15:55:07 -> 15:57:11 -> 15:59:13, 120 s apiece, each
# one a wait for a reply that was never coming.
_RETRYABLE = {429, 500, 502, 503, 504}
_FATAL = {400, 401, 403, 404}
_MAX_ATTEMPTS = 8

# The ladder above sums to 123 s, and FallbackProvider bounds each provider at 120 s. So
# the last rungs were unreachable even for a status that genuinely deserved them: a real
# 503 spent its whole allowance sleeping and then died as a timeout rather than failing
# over to a provider that was up. A retry budget is only meaningful inside the timeout
# that bounds it.
_RETRY_BUDGET_SECONDS = 45.0


def _should_retry(status: int | None) -> bool:
    """Whether another attempt can plausibly succeed.

    `None` means the request never got an HTTP reply — a connection reset or
    TransferEncodingError during the handshake, which is the case this loop was written
    for and is genuinely worth repeating. A status the server did send is an answer:
    retried only when it is explicitly transient, never merely because it is unlisted.
    """
    return status is None or status in _RETRYABLE


def _is_reasoning_content_error(e: Exception) -> bool:
    """DeepSeek's hybrid-reasoning models (deepseek-v4-flash) sometimes reject a request with
    a 400: 'The reasoning_content in the thinking mode must be passed back to the API.' —
    observed in prod (2026-08-18/19, Mailer/Finder/Crawler, ~$1.30 burned across 4 identical
    failures) even though `add_assistant_message`/`_sanitize_tool_pairs` already propagate
    reasoning_content on every path that appends an assistant turn. Root cause not fully
    pinned down — could not confirm it with certainty, so this does not touch the message-
    history code (which already carries real historical bug-fix weight; a wrong change there
    risks reintroducing the empty-message poisoning bug documented in add_assistant_message).
    Blindly retrying a 400 would just hit the same rejection again — _FATAL excludes 400 for
    exactly that reason — so this is a narrow, targeted exception, not a general retry."""
    msg = str(e).lower()
    return "reasoning_content" in msg and "must be passed back" in msg


def _usage_field(u: Any, name: str) -> Any:
    """Read a usage field whether litellm hands back a pydantic model or a plain dict.

    OpenRouter's cost keys aren't part of the OpenAI usage schema, so depending on the
    litellm version they land on the object, in .model_extra, or only in the raw dict.
    """
    val = getattr(u, name, None)
    if val is None and hasattr(u, "model_extra"):
        val = (getattr(u, "model_extra", None) or {}).get(name)
    if val is None and isinstance(u, dict):
        val = u.get(name)
    return val


def _reported_cost_fields(u: Any, prompt_tokens: int, completion_tokens: int) -> dict[str, Any]:
    """Cost as billed by the provider, plus the tokens that figure covers.

    With provider routing on, an `openrouter/...` model has no single price — the
    upstream that wins the sort sets the rate, and that changes between calls. The
    static table in nanobot-cycle-runner.ts can only guess, so we carry the real
    number when the provider states it.

    The token counts travel with it because they are what make the figure safe to
    mix: a cycle that falls back mid-run (FallbackProvider) bills part of its work
    to OpenRouter and part elsewhere, and the JS side needs to know which slice this
    covers rather than assuming it covers everything.

    Absent or non-positive cost returns {} — the caller then prices from the table
    exactly as before, so a provider that reports nothing changes no behaviour.
    """
    cost = _usage_field(u, "cost")
    if cost is None:
        details = _usage_field(u, "cost_details") or {}
        if isinstance(details, dict):
            cost = details.get("upstream_inference_cost")
    if not isinstance(cost, (int, float)) or isinstance(cost, bool) or cost <= 0:
        return {}
    return {
        "reported_cost_usd": float(cost),
        "reported_cost_prompt_tokens": prompt_tokens,
        "reported_cost_completion_tokens": completion_tokens,
    }


class LiteLLMProvider(LLMProvider):
    """
    LLM provider using LiteLLM for multi-provider support.
    
    Supports OpenRouter, Anthropic, OpenAI, Gemini, MiniMax, and many other providers through
    a unified interface.  Provider-specific logic is driven by the registry
    (see providers/registry.py) — no if-elif chains needed here.
    """
    
    def __init__(
        self, 
        api_key: str | None = None, 
        api_base: str | None = None,
        default_model: str = "anthropic/claude-opus-4-5",
        extra_headers: dict[str, str] | None = None,
        provider_name: str | None = None,
    ):
        super().__init__(api_key, api_base)
        self.default_model = default_model
        self.extra_headers = extra_headers or {}
        
        # Detect gateway / local deployment.
        # provider_name (from config key) is the primary signal;
        # api_key / api_base are fallback for auto-detection.
        self._gateway = find_gateway(provider_name, api_key, api_base) or find_gateway_by_prefix(default_model)
        
        # Configure environment variables
        if api_key:
            self._setup_env(api_key, api_base, default_model)
        
        if api_base:
            litellm.api_base = api_base
        
        # Disable LiteLLM logging noise
        litellm.suppress_debug_info = True
        # Drop unsupported parameters for providers (e.g., gpt-5 rejects some params)
        litellm.drop_params = True
    
    def _setup_env(self, api_key: str, api_base: str | None, model: str) -> None:
        """Set environment variables based on detected provider."""
        spec = self._gateway or find_by_model(model)
        if not spec:
            return
        if not spec.env_key:
            # OAuth/provider-only specs (for example: openai_codex)
            return

        # Gateway/local overrides existing env; standard provider doesn't
        if self._gateway:
            os.environ[spec.env_key] = api_key
        else:
            os.environ.setdefault(spec.env_key, api_key)

        # Resolve env_extras placeholders:
        #   {api_key}  → user's API key
        #   {api_base} → user's api_base, falling back to spec.default_api_base
        effective_base = api_base or spec.default_api_base
        for env_name, env_val in spec.env_extras:
            resolved = env_val.replace("{api_key}", api_key)
            resolved = resolved.replace("{api_base}", effective_base)
            os.environ.setdefault(env_name, resolved)
    
    def _resolve_model(self, model: str) -> str:
        """Resolve model name by applying provider/gateway prefixes."""
        gateway = self._gateway or find_gateway_by_prefix(model)
        if gateway:
            # Gateway mode: apply gateway prefix, skip provider-specific prefixes
            prefix = gateway.litellm_prefix
            if gateway.strip_model_prefix:
                model = model.split("/")[-1]
            if prefix and not model.startswith(f"{prefix}/"):
                model = f"{prefix}/{model}"
            return model
        
        # Standard mode: auto-prefix for known providers
        spec = find_by_model(model)
        if spec and spec.litellm_prefix:
            model = self._canonicalize_explicit_prefix(model, spec.name, spec.litellm_prefix)
            if not any(model.startswith(s) for s in spec.skip_prefixes):
                model = f"{spec.litellm_prefix}/{model}"

        return model

    @staticmethod
    def _canonicalize_explicit_prefix(model: str, spec_name: str, canonical_prefix: str) -> str:
        """Normalize explicit provider prefixes like `github-copilot/...`."""
        if "/" not in model:
            return model
        prefix, remainder = model.split("/", 1)
        if prefix.lower().replace("-", "_") != spec_name:
            return model
        return f"{canonical_prefix}/{remainder}"
    
    def _supports_cache_control(self, model: str) -> bool:
        """Return True when the provider supports cache_control on content blocks."""
        if self._gateway is not None:
            return self._gateway.supports_prompt_caching
        spec = find_by_model(model)
        return spec is not None and spec.supports_prompt_caching

    def _apply_cache_control(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]] | None]:
        """Return copies of messages and tools with cache_control injected.

        System messages that already carry a list of content blocks (i.e. were
        pre-segmented by ``ContextBuilder.build_system_prompt_segments``) are
        passed through unchanged — their cache breakpoints are already placed
        correctly on the static segment.  Only plain-string system messages get
        a breakpoint added here (backward-compat for callers that bypass
        ``ContextBuilder``).
        """
        new_messages = []
        for msg in messages:
            if msg.get("role") == "system":
                content = msg["content"]
                if isinstance(content, str):
                    # Legacy path: wrap the whole string in one cached block.
                    new_content = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
                    new_messages.append({**msg, "content": new_content})
                else:
                    # Pre-segmented list — cache_control already in place; don't touch.
                    new_messages.append(msg)
            else:
                new_messages.append(msg)

        # Always put a cache breakpoint on the last tool definition so the
        # tool list is cached independently of the system prompt.
        new_tools = tools
        if tools:
            new_tools = list(tools)
            new_tools[-1] = {**new_tools[-1], "cache_control": {"type": "ephemeral"}}

        return new_messages, new_tools

    def _apply_model_overrides(self, model: str, kwargs: dict[str, Any]) -> None:
        """Apply model-specific parameter overrides from the registry."""
        model_lower = model.lower()
        spec = find_by_model(model)
        if spec:
            for pattern, overrides in spec.model_overrides:
                if pattern in model_lower:
                    kwargs.update(overrides)
                    return
    
    @staticmethod
    def _flatten_system_content(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert list-of-blocks system messages to plain strings.

        ContextBuilder produces Anthropic-style segmented system prompts
        (list of {type, text, cache_control} dicts). Non-Anthropic providers
        only accept a plain string. This strips the block wrapper and joins.
        """
        result = []
        for msg in messages:
            if msg.get("role") == "system" and isinstance(msg.get("content"), list):
                text = "\n\n".join(
                    block.get("text", "") for block in msg["content"]
                    if isinstance(block, dict) and block.get("type") == "text"
                )
                result.append({**msg, "content": text})
            else:
                result.append(msg)
        return result

    @staticmethod
    def _sanitize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Strip non-standard keys, ensure assistant messages have a content key, and
        make reasoning_content presence consistent across assistant turns.

        DeepSeek's hybrid-reasoning models reject the whole request if ANY assistant
        message follows one that carried reasoning_content but itself omits the key
        ("The `reasoning_content` in the thinking mode must be passed back to the
        API."). Session.get_history() already backfills this for the initial window
        it loads from disk, but that's only one of several places messages get built —
        a daemon continuing a live turn, a fallback-chain hop through a non-thinking
        model for one iteration, or _sanitize_tool_pairs's own repairs can each
        reintroduce the gap afterwards. _is_reasoning_content_error's retry-with-
        thinking-off (below) only papers over this: it resends the SAME malformed
        history and hits the identical 400 again if the gap is upstream of this call —
        confirmed in prod 2026-08-22 (Crawler, two ~1hr-long failed cycles that
        each crashed the container instead of recovering). Normalizing right here, once,
        on every outgoing request regardless of how messages were assembled, closes the
        whole class instead of chasing each producer.
        """
        sanitized = []
        seen_reasoning = False
        for msg in messages:
            clean = {k: v for k, v in msg.items() if k in _ALLOWED_MSG_KEYS}
            # Strict providers require "content" even when assistant only has tool_calls
            if clean.get("role") == "assistant" and "content" not in clean:
                clean["content"] = None
            if clean.get("role") == "assistant":
                if "reasoning_content" in clean:
                    seen_reasoning = True
                elif seen_reasoning:
                    clean["reasoning_content"] = ""
            sanitized.append(clean)
        return sanitized

    async def _chat_streaming(
        self,
        kwargs: dict[str, Any],
        on_token: Callable[[str], Awaitable[None]],
    ) -> LLMResponse:
        """Stream a completion, forward text tokens via on_token, return assembled LLMResponse.

        Retries, but only while nothing has reached the caller yet. Once a single token
        has been forwarded through on_token the stream is committed — a retry would
        replay visible output — so a genuinely mid-stream failure still surfaces as an
        error. A provider that dies before the first delta has emitted nothing, and that
        case is both safe to retry and the one that was silently killing whole scheduled
        cycles: DeepSeek's "Service is too busy" 503s and connection resets
        (TransferEncodingError) arrive during the handshake, not mid-stream.
        """
        last_exc: Exception | None = None
        _reasoning_retry_done = False
        slept = 0.0
        for attempt in range(_MAX_ATTEMPTS):
            progress = {"emitted": False}
            try:
                return await self._stream_once(kwargs, on_token, progress)
            except Exception as e:
                last_exc = e
                status = getattr(e, "status_code", None)
                # Same narrow, one-shot carve-out as the non-streaming path — see
                # _is_reasoning_content_error. Only safe before any token reached the caller.
                if not progress["emitted"] and not _reasoning_retry_done and _is_reasoning_content_error(e):
                    _reasoning_retry_done = True
                    extra_body = dict(kwargs.get("extra_body") or {})
                    ctk = dict(extra_body.get("chat_template_kwargs") or {})
                    ctk["thinking"] = False
                    extra_body["chat_template_kwargs"] = ctk
                    kwargs["extra_body"] = extra_body
                    continue
                if (
                    progress["emitted"]
                    or not _should_retry(status)
                    or attempt == _MAX_ATTEMPTS - 1
                ):
                    break
                delay = min(2 ** attempt + random.random(), 60)
                if slept + delay > _RETRY_BUDGET_SECONDS:
                    # Out of budget. Raising now hands the turn to the next provider in
                    # the chain with time left to answer, which is worth more than one
                    # more attempt at a provider that has already failed this often.
                    break
                slept += delay
                await asyncio.sleep(delay)
        # Nothing was ever streamed to the caller — safe to raise instead of
        # swallowing, whether from a fatal status or exhausting every retry.
        # This is what lets FallbackProvider actually fail over to a different
        # model/provider; previously chat() never raised for any failure, so the
        # fallback chain was constructed correctly but never engaged.
        if not progress["emitted"] and last_exc is not None:
            raise last_exc
        return LLMResponse(content=f"Error calling LLM: {last_exc}", finish_reason="error")

    async def _stream_once(
        self,
        kwargs: dict[str, Any],
        on_token: Callable[[str], Awaitable[None]],
        progress: dict[str, bool],
    ) -> LLMResponse:
        """A single streaming attempt.

        Raises provider errors rather than swallowing them; _chat_streaming decides
        whether a retry is safe. Sets progress["emitted"] as soon as a token is handed
        to on_token, which is what makes that decision possible.
        """
        stream_kwargs = {**kwargs, "stream": True, "stream_options": {"include_usage": True}}

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        # Maps delta index → accumulated {id, name, arguments} for tool calls
        tool_map: dict[int, dict[str, str]] = {}
        finish_reason = "stop"
        usage: dict[str, int] = {}

        response_stream = await acompletion(**stream_kwargs)
        async for chunk in response_stream:
            # Usage-only final chunk (stream_options support)
            if not chunk.choices:
                if hasattr(chunk, "usage") and chunk.usage:
                    u = chunk.usage
                    usage = {
                        "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                        "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                        "total_tokens": getattr(u, "total_tokens", 0) or 0,
                        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
                        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
                        # DeepSeek context-cache fields (different names from Anthropic's).
                        "prompt_cache_hit_tokens": getattr(u, "prompt_cache_hit_tokens", 0) or 0,
                        "prompt_cache_miss_tokens": getattr(u, "prompt_cache_miss_tokens", 0) or 0,
                    }
                    usage.update(_reported_cost_fields(
                        u, usage["prompt_tokens"], usage["completion_tokens"]))
                continue

            choice = chunk.choices[0]
            if choice.finish_reason:
                finish_reason = choice.finish_reason

            # Capture usage when embedded in content chunks
            if not usage and hasattr(chunk, "usage") and chunk.usage:
                u = chunk.usage
                usage = {
                    "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(u, "total_tokens", 0) or 0,
                    "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
                    "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
                }
                usage.update(_reported_cost_fields(
                    u, usage["prompt_tokens"], usage["completion_tokens"]))

            delta = choice.delta
            if delta is None:
                continue

            # Reasoning content (thinking-mode models like DeepSeek V4 Pro)
            rc = getattr(delta, "reasoning_content", None)
            if rc:
                reasoning_parts.append(rc)

            # Text token
            if delta.content:
                text_parts.append(delta.content)
                # Set before the await: once on_token is entered we must assume the
                # token was delivered, so the stream counts as committed either way.
                progress["emitted"] = True
                await on_token(delta.content)

            # Tool call deltas — accumulate by index
            if hasattr(delta, "tool_calls") and delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_map:
                        tool_map[idx] = {"id": "", "name": "", "arguments": ""}
                    if tc_delta.id:
                        tool_map[idx]["id"] = tc_delta.id
                    if tc_delta.function:
                        fn = tc_delta.function
                        if fn.name:
                            tool_map[idx]["name"] += fn.name
                        if fn.arguments:
                            tool_map[idx]["arguments"] += fn.arguments

        # Assemble tool calls from accumulated deltas
        tool_calls = []
        for idx in sorted(tool_map):
            raw = tool_map[idx]
            args_str = raw["arguments"]
            args = json_repair.loads(args_str) if args_str else {}
            # DeepSeek sometimes wraps args in a list: [{"path": ..., "content": ...}]
            if isinstance(args, list):
                args = args[0] if args and isinstance(args[0], dict) else {}
            tool_calls.append(ToolCallRequest(
                id=raw["id"] or f"call_{idx}",
                name=raw["name"],
                arguments=args if isinstance(args, dict) else {},
            ))

        content_str = "".join(text_parts) or None
        if not tool_calls and content_str:
            recovered = _parse_pseudo_xml_tool_calls(content_str)
            if recovered:
                tool_calls = recovered
                content_str = None

        return LLMResponse(
            content=content_str,
            tool_calls=tool_calls,
            finish_reason=finish_reason or "stop",
            usage=usage,
            reasoning_content="".join(reasoning_parts) or None,
        )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        on_token: Callable[[str], Awaitable[None]] | None = None,
    ) -> LLMResponse:
        """
        Send a chat completion request via LiteLLM.
        
        Args:
            messages: List of message dicts with 'role' and 'content'.
            tools: Optional list of tool definitions in OpenAI format.
            model: Model identifier (e.g., 'anthropic/claude-sonnet-4-5').
            max_tokens: Maximum tokens in response.
            temperature: Sampling temperature.
        
        Returns:
            LLMResponse with content and/or tool calls.
        """
        original_model = model or self.default_model
        model = self._resolve_model(original_model)

        if self._supports_cache_control(original_model):
            messages, tools = self._apply_cache_control(messages, tools)

        # Clamp max_tokens to at least 1 — negative or zero values cause
        # LiteLLM to reject the request with "max_tokens must be at least 1".
        max_tokens = max(1, max_tokens)
        
        sanitized = _strip_reasoning_for(model, self._sanitize_messages(self._sanitize_empty_content(messages)))

        # Non-Anthropic providers (DeepSeek, Groq, Moonshot, etc.) require the
        # system message content to be a plain string, not a list of content blocks.
        # ContextBuilder always returns list-of-blocks (for Anthropic caching), so
        # we flatten it here for every provider that doesn't support cache_control.
        if not self._supports_cache_control(original_model):
            sanitized = self._flatten_system_content(sanitized)


        kwargs: dict[str, Any] = {
            "model": model,
            "messages": sanitized,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        
        # Apply model-specific overrides (e.g. kimi-k2.5 temperature)
        self._apply_model_overrides(model, kwargs)

        # Optional: disable DeepSeek "thinking"/reasoning. Hybrid DeepSeek models
        # (e.g. deepseek-v4-flash) emit reasoning_content by default, which adds
        # latency + token cost and can produce reasoning-only turns. Set
        # DEEPSEEK_DISABLE_THINKING=1 to suppress it. Best-effort: litellm has
        # drop_params=True, so if a given API version doesn't accept this key it
        # is dropped rather than erroring.
        # DeepSeek's OWN API only. Through OpenRouter these keys collide with the `reasoning`
        # cap set below — OpenRouter maps reasoning_effort onto reasoning.effort and answers
        # 400 "Only one of reasoning.effort and reasoning.max_tokens can be specified", so no
        # openrouter/deepseek/* model ever completed a call here (found 2026-09-30, the
        # OpenRouter fallback's first live use). OpenRouter-hosted DeepSeek gets that cap,
        # like GLM.
        if (
            os.environ.get("DEEPSEEK_DISABLE_THINKING", "").strip().lower() in ("1", "true", "yes", "on")
            and "deepseek" in (model or "").lower()
            and not (model or "").lower().startswith("openrouter/")
        ):
            extra_body = dict(kwargs.get("extra_body") or {})
            # Measured against api.deepseek.com on 2026-08-31, same prompt each time:
            #
            #   nothing                              reasoning 1381 chars
            #   chat_template_kwargs.thinking=False  reasoning  502 chars   <- no effect
            #   thinking={"type": "disabled"}        reasoning    0
            #   reasoning_effort="none"              reasoning    0
            #
            # So the flag this block is named after was a no-op against the real API, and
            # every DeepSeek call has been paying for reasoning it asked not to have. It
            # showed up as effector decision calls dying on "Response was cut off": the
            # 1024-token budget went to reasoning_content and the JSON never closed. (The
            # cap was already doubled from 512 once for the same symptom — see
            # react_loop._DECISION_MAX_TOKENS.)
            #
            # chat_template_kwargs stays for self-hosted/vLLM deployments, where it IS the
            # switch; the two that work go in beside it. extra_body is passed through
            # verbatim, so drop_params cannot quietly remove them.
            ctk = dict(extra_body.get("chat_template_kwargs") or {})
            ctk["thinking"] = False
            extra_body["chat_template_kwargs"] = ctk
            extra_body["thinking"] = {"type": "disabled"}
            extra_body.setdefault("reasoning_effort", "none")
            kwargs["extra_body"] = extra_body

        # A caller that only needs a short structured answer (effector's per-turn decision)
        # asks for low reasoning effort through reasoning_effort_var. Measured 2026-09-17
        # on openrouter z-ai/glm-5.3-flash, whose reasoning cannot be disabled ("Reasoning
        # is mandatory"): default effort spent 43–1005 reasoning tokens and up to 16 s on a
        # one-line JSON reply — enough to fill effector's 1024-token budget on a real page
        # and cut the decision off — while effort "low" spent 0–5 tokens in ~1.5 s with the
        # same correct answer. OpenRouter only: its unified `reasoning` block is the switch.
        effort = reasoning_effort_var.get()
        # Only to models whose hosts accept it: routing below sets require_parameters, so a
        # `reasoning` block sent to one that doesn't (gpt-4o-mini) leaves no host at all.
        reasoning_ok = (model or "").lower().startswith("openrouter/") and supports_reasoning(model)
        if effort and reasoning_ok:
            extra_body = dict(kwargs.get("extra_body") or {})
            extra_body["reasoning"] = {**dict(extra_body.get("reasoning") or {}), "effort": effort}
            kwargs["extra_body"] = extra_body
        elif reasoning_ok and reasoning_budget(max_tokens) and not (kwargs.get("extra_body") or {}).get("reasoning"):
            # Thinking may never take the whole reply. Measured 2026-09-30 on GLM 5.3 Flash
            #: uncapped, 2 of 4 calls reasoned to the
            # 32,768 limit and wrote nothing; in the stage 57 benchmark three in a row did and
            # the agent never acted. The cap is advice to GLM, not a wall — see REASONING_SHARE.
            extra_body = dict(kwargs.get("extra_body") or {})
            extra_body["reasoning"] = {"max_tokens": reasoning_budget(max_tokens)}
            kwargs["extra_body"] = extra_body

        # OpenRouter provider routing. Without this the request carries no provider
        # block at all, so OpenRouter picks the upstream itself — its default weighs
        # price against uptime, which means a pricier host can and does serve a
        # request while a cheaper one is up. These three keys make the choice ours:
        #   sort="price"         — strict cheapest-first, not weighted balancing
        #   allow_fallbacks      — cheapest down/erroring → next cheapest, down the list
        #   require_parameters   — only hosts that honour THIS request's params
        # The last one is load-bearing, not a nicety. Every cycle sends a `tools`
        # array; a host that quietly ignores it makes the model narrate tool calls as
        # text instead. That exact failure killed a Finder cycle on 2026-08-17 (see
        # _PSEUDO_INVOKE_RE above) and sorting on price alone steers us straight at
        # the cheap, degraded hosts where it is likeliest. Better to pay the second
        # -cheapest rate than to lose the turn.
        # OPENROUTER_PROVIDER_SORT=throughput|latency trades cost for speed;
        # =off hands routing back to OpenRouter's default.
        if model.startswith("openrouter/"):
            _sort = os.environ.get("OPENROUTER_PROVIDER_SORT", "price").strip().lower() or "price"
            if _sort != "off":
                extra_body = dict(kwargs.get("extra_body") or {})
                routing = dict(extra_body.get("provider") or {})
                routing.setdefault("sort", _sort)
                routing.setdefault("allow_fallbacks", True)
                routing.setdefault("require_parameters", True)
                extra_body["provider"] = routing
                # Ask OpenRouter to report what it actually billed. Now that routing
                # moves between hosts at different rates, a static per-model price is
                # a guess; this is the invoice. See _reported_cost_fields.
                usage_opt = dict(extra_body.get("usage") or {})
                usage_opt.setdefault("include", True)
                extra_body["usage"] = usage_opt
                kwargs["extra_body"] = extra_body

        # Pass api_key directly — more reliable than env vars alone
        if self.api_key:
            kwargs["api_key"] = self.api_key
        
        # Pass api_base for custom endpoints
        if self.api_base:
            kwargs["api_base"] = self.api_base
        
        # Pass extra headers (e.g. APP-Code for AiHubMix)
        if self.extra_headers:
            kwargs["extra_headers"] = dict(self.extra_headers)

        # Inject Anthropic beta headers for direct Anthropic calls.
        # claude-code-20250219: activates Anthropic's coding-agent behavior variant.
        # prompt-caching-scope-2026-01-05: scopes cache keys so tool outputs don't
        # invalidate the static system-prompt cache (preserves 60-90% cache hit rate).
        if "anthropic" in original_model.lower() or "claude" in original_model.lower():
            if self._gateway is None or "anthropic" in (getattr(self._gateway, "name", "") or "").lower():
                kwargs.setdefault("extra_headers", {})
                existing = kwargs["extra_headers"].get("anthropic-beta", "")
                betas = "claude-code-20250219,prompt-caching-scope-2026-01-05"
                kwargs["extra_headers"]["anthropic-beta"] = (
                    f"{existing},{betas}" if existing else betas
                )
        
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        # Streaming path — forwards tokens in real time and retries only up to the first
        # token (see _chat_streaming); past that a retry would replay visible output.
        if on_token is not None:
            return await self._chat_streaming(kwargs, on_token)

        last_exc: Exception | None = None
        _reasoning_retry_done = False
        slept = 0.0
        for attempt in range(_MAX_ATTEMPTS):
            try:
                response = await acompletion(**kwargs)
                return self._parse_response(response)
            except Exception as e:
                # NOTE: do NOT reference litellm.APIStatusError here — it doesn't exist in current
                # litellm versions, and naming a missing attribute in an `except` clause raises
                # AttributeError that masks the real error. Inspect status_code on whatever was raised.
                status = getattr(e, "status_code", None)
                if _should_retry(status) and attempt < _MAX_ATTEMPTS - 1:
                    delay = min(2 ** attempt + random.random(), 60)
                    if slept + delay <= _RETRY_BUDGET_SECONDS:
                        last_exc = e
                        slept += delay
                        await asyncio.sleep(delay)
                        continue
                # Narrow exception to the 400-is-fatal rule above: this exact DeepSeek error is
                # recoverable by disabling thinking mode for one retry (see
                # _is_reasoning_content_error), unlike every other 400 in _FATAL, which really is
                # unrecoverable by resending the same request. One-shot — if it fails again with
                # thinking already off, something else is wrong and this must not loop.
                if not _reasoning_retry_done and _is_reasoning_content_error(e):
                    _reasoning_retry_done = True
                    last_exc = e
                    extra_body = dict(kwargs.get("extra_body") or {})
                    ctk = dict(extra_body.get("chat_template_kwargs") or {})
                    ctk["thinking"] = False
                    extra_body["chat_template_kwargs"] = ctk
                    kwargs["extra_body"] = extra_body
                    continue
                # Non-streaming: nothing is ever partially delivered, so raising is
                # always safe — lets FallbackProvider fail over to the next
                # provider/model instead of this silently returning error text
                # dressed up as a normal reply.
                raise e
        raise last_exc
    
    def _parse_response(self, response: Any) -> LLMResponse:
        """Parse LiteLLM response into our standard format."""
        choice = response.choices[0]
        message = choice.message
        
        tool_calls = []
        if hasattr(message, "tool_calls") and message.tool_calls:
            for tc in message.tool_calls:
                # Parse arguments from JSON string if needed
                args = tc.function.arguments
                if isinstance(args, str):
                    args = json_repair.loads(args)
                
                tool_calls.append(ToolCallRequest(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=args,
                ))
        
        usage = {}
        if hasattr(response, "usage") and response.usage:
            u = response.usage
            usage = {
                "prompt_tokens": getattr(u, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(u, "completion_tokens", 0) or 0,
                "total_tokens": getattr(u, "total_tokens", 0) or 0,
                # Anthropic prompt-cache accounting
                "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
                "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
            }
            usage.update(_reported_cost_fields(
                u, usage["prompt_tokens"], usage["completion_tokens"]))
        
        reasoning_content = getattr(message, "reasoning_content", None) or None

        content = message.content
        if not tool_calls and content:
            recovered = _parse_pseudo_xml_tool_calls(content)
            if recovered:
                tool_calls = recovered
                content = None

        return LLMResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage=usage,
            reasoning_content=reasoning_content,
        )
    
    def get_default_model(self) -> str:
        """Get the default model."""
        return self.default_model
