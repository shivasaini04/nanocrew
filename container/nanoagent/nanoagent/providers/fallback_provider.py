"""
FallbackProvider — wraps multiple (provider, model) pairs and tries them in order.

On transient errors (rate limit, connection error, timeout, service unavailable) and on
errors that condemn only one provider (its model is gone, its key is bad), the next provider
in the chain is tried. On a bad request, the error propagates immediately.

Usage in nanocrew_adapter.py:
    provider = FallbackProvider([
        (LiteLLMProvider(api_key=deepseek_key), "deepseek/deepseek-v4-flash"),
        (LiteLLMProvider(api_key=gemini_key),   "gemini/gemini-3.5-flash"),
    ])
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from nanoagent.providers.base import LLMProvider, LLMResponse

logger = logging.getLogger(__name__)

# LiteLLM exception class names that indicate a transient failure worth retrying
# on a different provider.  We match by class name to avoid importing litellm at
# the module level (it is heavy and not always installed in test environments).
_TRANSIENT_EXCEPTION_NAMES = frozenset({
    "RateLimitError",
    "ServiceUnavailableError",
    "Timeout",
    "APIConnectionError",
    "InternalServerError",
    "ContextWindowExceededError",
})


# Errors that condemn ONE provider, not the request: its model is gone, or its key is bad.
# The next provider has its own model and key, so these are worth moving past too. They used
# to count as permanent, which let a dead fallback end the whole chain: on 2026-09-11
# (Crawler a live cycle the primary and DeepSeek both failed transiently, the chain
# reached gemini/gemini-2.0-flash — retired by Google, 404 NotFoundError — and raised,
# with groq still unused behind it. A bad request (BadRequestError) stays permanent: it
# would fail the same way everywhere.
_PROVIDER_SPECIFIC_EXCEPTION_NAMES = frozenset({
    "NotFoundError",
    "AuthenticationError",
    "PermissionDeniedError",
})

# The same idea one level down, because the class name is not always enough. DeepSeek
# answers an unfunded key with 402 "Insufficient Balance", and litellm raises that as
# BadRequestError — a class this module calls permanent, on the sound reasoning that a
# malformed request fails the same way everywhere. A 402 is not that. It says this
# ACCOUNT cannot pay; the next provider in the chain has its own account.
#
# This mattered only because of a bug next door. The streaming retry loop treated 402 as
# transient and slept 123 s, so the call reached this function as a TimeoutError, which
# IS transient, and failed over by accident. Fixing that loop to raise in 0.7 s would
# have turned every cycle on an unfunded key from slow-but-working into immediately
# dead, and the deploy that caused it would have looked unrelated.
#
# 400 stays permanent. It is the one status here that really is about the request.
#
# 429 is deliberately NOT here. A rate limit clears in seconds, so it belongs with the
# transient statuses below — condemning a provider for fifteen minutes over one would
# route around a perfectly healthy provider for the rest of the cycle.
_PROVIDER_CONDEMNING_STATUSES = frozenset({401, 402, 403, 404})

# Worth trying the next provider, without holding it against this one. Checked because
# _is_transient otherwise matches on the exception CLASS NAME alone: a 503 arriving as a
# class not in the set above was read as permanent and killed the turn with no failover
# at all. Names are what a library happens to call something this version; the status is
# what the server said.
_TRANSIENT_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


# A provider whose account cannot pay, or whose key is rejected, will answer the next
# call exactly the same way. Measured 2026-09-21: that doomed hop costs 0.87 s even with
# a 40K-token prompt (DeepSeek checks auth before reading the body), against ~3.3 s for
# the call that actually answers — about a fifth of every model call, paid forever,
# because selection picks the first available KEY and never a healthy one.
#
# So a condemning status is remembered and that provider is skipped. Keyed by model name
# rather than object identity: the adapter builds a fresh chain per request, so identity
# would forget between cycles and a warm daemon would pay this on every turn of its life.
#
# The TTL is what makes it safe to be wrong. Top the account up and the provider comes
# back by itself within the window; nothing has to be restarted and no state outlives the
# process. Skipping is never allowed to empty the chain — the last provider is always
# tried, so a mistake here can slow a call down but can never make one impossible.
_CONDEMNED_TTL_SECONDS = 900.0
_condemned: dict[str, float] = {}


def _condemn(model: str) -> None:
    _condemned[model] = time.monotonic() + _CONDEMNED_TTL_SECONDS


def _is_condemned(model: str) -> bool:
    until = _condemned.get(model)
    if until is None:
        return False
    if time.monotonic() >= until:
        del _condemned[model]
        return False
    return True


def _forget_condemned() -> None:
    """Test seam, and the honest way to clear it — there is no other global state here."""
    _condemned.clear()


def _is_transient(exc: Exception) -> bool:
    """Return True if the next provider in the chain is worth trying after this failure."""
    exc_type = type(exc).__name__
    if exc_type in _TRANSIENT_EXCEPTION_NAMES or exc_type in _PROVIDER_SPECIFIC_EXCEPTION_NAMES:
        return True
    status = getattr(exc, "status_code", None)
    if status in _PROVIDER_CONDEMNING_STATUSES or status in _TRANSIENT_STATUSES:
        return True
    # asyncio timeouts always warrant a fallback
    if isinstance(exc, asyncio.TimeoutError):
        return True
    return False


class FallbackProvider(LLMProvider):
    """Try each (provider, model) pair in order until one succeeds.

    Parameters
    ----------
    chain:
        List of (provider, model_name) tuples in priority order.
        The first entry is the primary provider; subsequent entries are fallbacks.
    per_provider_timeout:
        Hard timeout (seconds) applied to each provider call before falling
        back to the next one.  Defaults to 120s.
    """

    def __init__(
        self,
        chain: list[tuple[LLMProvider, str]],
        per_provider_timeout: float = 120.0,
        output_caps: dict[str, int] | None = None,
    ):
        if not chain:
            raise ValueError("FallbackProvider requires at least one provider in chain")
        # Each model's own output ceiling (output_limits.py): a fallback call is clamped to
        # its model's, instead of every call being held to the smallest in the chain.
        self._output_caps = dict(output_caps or {})
        # Use the first provider's identity as our own (for get_default_model etc.)
        super().__init__(
            api_key=chain[0][0].api_key,
            api_base=chain[0][0].api_base,
        )
        self._chain = chain
        self._timeout = per_provider_timeout

    def get_default_model(self) -> str:
        return self._chain[0][1]

    async def chat(
        self,
        messages: list[dict],
        # Optional, matching LiteLLMProvider.chat — the two must stay call-compatible or a
        # caller that omits `tools` works on one provider and raises TypeError on the other.
        # It was required here, so every tools-less caller broke the moment a fallback chain
        # was configured: read_image died with "missing 1 required positional argument:
        # 'tools'" (found 2026-08-22, blocking vision entirely), and the research/report and
        # adversarial modules call it the same way.
        tools: list[dict] | None = None,
        model: str | None = None,
        temperature: float = 0.1,
        max_tokens: int = 4096,
        on_token: Callable[[str], Awaitable[None]] | None = None,
        **kwargs,
    ) -> LLMResponse:
        last_exc: Exception | None = None

        # A transient failure on the agent's OWN model (provider[0]) gets one more try on
        # that model before the chain moves on. On 2026-09-30 one GLM 5.3 timeout sent a
        # cycle straight into a chain whose every entry was dead (DeepSeek 402, Gemini 402,
        # Kimi 404, Groq 404): the model the agent was configured with, and which worked,
        # was never asked twice. A timeout or a 429 is usually over by the next attempt.
        primary_retried = False
        idx = 0
        while idx < len(self._chain):
            provider, fallback_model = self._chain[idx]
            use_model = fallback_model if idx > 0 else model
            # Skip a provider already known to be refusing — but never the last one, so
            # this can only ever reorder work, never remove the chain's ability to answer.
            if idx + 1 < len(self._chain) and _is_condemned(fallback_model):
                logger.debug(
                    "FallbackProvider: skipping provider[%d] (%s) — refused recently",
                    idx, fallback_model,
                )
                idx += 1
                continue
            cap = self._output_caps.get(use_model or fallback_model) or self._output_caps.get(fallback_model)
            try:
                result = await asyncio.wait_for(
                    provider.chat(
                        messages=messages,
                        tools=tools,
                        model=use_model,
                        temperature=temperature,
                        max_tokens=min(max_tokens, cap) if cap else max_tokens,
                        on_token=on_token,
                        **kwargs,
                    ),
                    timeout=self._timeout,
                )
                if idx > 0:
                    logger.info(
                        "FallbackProvider: succeeded on provider[%d] (%s) after %d failure(s)",
                        idx, use_model, idx,
                    )
                return result

            except Exception as exc:
                last_exc = exc
                if getattr(exc, "status_code", None) in _PROVIDER_CONDEMNING_STATUSES:
                    _condemn(fallback_model)
                # A refusal that condemns the provider (unfunded, bad key, model gone) will
                # answer the same way a second later — only a temporary failure is retried.
                condemning = (
                    getattr(exc, "status_code", None) in _PROVIDER_CONDEMNING_STATUSES
                    or type(exc).__name__ in _PROVIDER_SPECIFIC_EXCEPTION_NAMES
                )
                if _is_transient(exc):
                    if idx == 0 and not primary_retried and not condemning:
                        primary_retried = True
                        logger.warning(
                            "FallbackProvider: provider[0] (%s) failed with %s (%s), "
                            "retrying it once before the fallbacks",
                            use_model, type(exc).__name__, str(exc)[:120],
                        )
                        continue
                    if idx + 1 < len(self._chain):
                        logger.warning(
                            "FallbackProvider: provider[%d] (%s) failed with %s (%s), "
                            "trying provider[%d]",
                            idx, use_model, type(exc).__name__, str(exc)[:120], idx + 1,
                        )
                        idx += 1
                        continue
                    else:
                        logger.error(
                            "FallbackProvider: all %d provider(s) exhausted. Last error: %s",
                            len(self._chain), exc,
                        )
                else:
                    # Permanent error — do not try other providers
                    logger.error(
                        "FallbackProvider: provider[%d] (%s) raised permanent error %s: %s",
                        idx, use_model, type(exc).__name__, str(exc)[:200],
                    )
                raise

        # Should be unreachable, but satisfy the type checker
        raise last_exc  # type: ignore[misc]
