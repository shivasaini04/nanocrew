"""Direct provider calls through the orchestrator's key relay (stage 64 phase 2).

With the relay on, this container holds the cycle's token where a provider key used to be,
and NC_LLM_RELAY names the relay (orchestrator src/agents/llm-relay.ts). litellm finds it on
its own through <PROVIDER>_API_BASE; code that calls a provider WITHOUT litellm builds its URL
here, so the request reaches the relay and the relay swaps the real key in.

Without NC_LLM_RELAY (relay off, or a local run) the provider's own origin is used, as before.
"""

from __future__ import annotations

import os

# Must match RELAY_PROVIDERS[*].upstream in llm-relay.ts: the relay appends the same path.
_ORIGINS = {
    "openrouter": "https://openrouter.ai/api",
    "gemini": "https://generativelanguage.googleapis.com",
}


def provider_url(provider: str, path: str) -> str:
    """Full URL for `path` (starting with "/") on `provider`, via the relay when there is one."""
    relay = os.environ.get("NC_LLM_RELAY", "").rstrip("/")
    if relay:
        return f"{relay}/{provider}{path}"
    return f"{_ORIGINS[provider]}{path}"
