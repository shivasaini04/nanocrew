"""How many tokens a model may write in one reply — per model, not per chain.

Measured 2026-09-29: GLM 5.3 Flash via OpenRouter
got an 8,192-token ceiling because litellm has no entry for it, and a fallback chain took
the minimum across every model in it. OpenRouter publishes 943,717 for that model. A
reasoning model spent all 8,192 thinking; asked to write a ~300-line module, the agent was
cut off three times in one turn and wrote nothing.

So: a model's ceiling comes from OpenRouter's own figure for `openrouter/...` models, else
from litellm's map, else a conservative floor; one agent turn is bounded by a practical
ceiling; and a fallback call is clamped to its own model's ceiling (fallback_provider.py)
instead of every call being held to the smallest in the chain.
"""
from __future__ import annotations

import json
import sys
import urllib.request

UNKNOWN_MODEL_MAX_TOKENS = 8192
# Bounds one step, not the task: max_tokens competes with the prompt for the context
# window, and compaction only trims at 100k input.
PRACTICAL_MAX_TOKENS = 32768

_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
_openrouter_caps: dict[str, int] | None = None
_openrouter_reasoning: set[str] = set()


def _load_openrouter_caps() -> dict[str, int]:
    """OpenRouter's published max output per model id, fetched once per process. Also notes
    which models accept the `reasoning` parameter (see supports_reasoning)."""
    global _openrouter_caps
    if _openrouter_caps is None:
        caps: dict[str, int] = {}
        try:
            with urllib.request.urlopen(_OPENROUTER_MODELS_URL, timeout=5) as resp:
                for m in json.load(resp).get("data", []):
                    mid = m.get("id")
                    if not isinstance(mid, str):
                        continue
                    v = (m.get("top_provider") or {}).get("max_completion_tokens")
                    if isinstance(v, int) and v > 0:
                        caps[mid] = v
                    if "reasoning" in (m.get("supported_parameters") or []):
                        _openrouter_reasoning.add(mid)
        except Exception as exc:  # noqa: BLE001 - offline or blocked: keep the floor
            print(f"[output_limits] OpenRouter model limits unavailable ({exc}); "
                  f"unknown models keep the {UNKNOWN_MODEL_MAX_TOKENS}-token floor", file=sys.stderr)
        _openrouter_caps = caps
    return _openrouter_caps


def supports_reasoning(model: str) -> bool:
    """Does OpenRouter list `reasoning` among this model's parameters? Unknown → no.

    It matters because our routing sets require_parameters: a `reasoning` block sent to a
    model whose hosts don't accept it (gpt-4o-mini, say) leaves no host to serve the call.
    """
    if not model.startswith("openrouter/"):
        return False
    _load_openrouter_caps()
    return model[len("openrouter/"):] in _openrouter_reasoning


def model_output_cap(model: str) -> int:
    """The most this model may write in one reply, as its provider states it."""
    if model.startswith("openrouter/"):
        v = _load_openrouter_caps().get(model[len("openrouter/"):])
        if v:
            return v
    try:
        from litellm import get_max_tokens
        v = get_max_tokens(model)
        if isinstance(v, (int, float)) and v and v > 0:
            return int(v)
    except Exception:  # noqa: BLE001 - not in litellm's map
        pass
    return UNKNOWN_MODEL_MAX_TOKENS


def step_ceiling(model: str) -> int:
    """One agent step's output budget on this model."""
    return min(model_output_cap(model), PRACTICAL_MAX_TOKENS)


def call_timeout_s(max_tokens: int) -> float:
    """A provider call's time limit, long enough to write `max_tokens` at a slow ~60 tokens/s.

    The old flat 120 s already cut a reasoning call close (one took 124 s at 8,192); four
    times the output needs more time, or a long reply times out and silently fails over to
    another model mid-turn. Capped under the daemon's 10-minute idle sweep.
    """
    return max(120.0, min(540.0, max_tokens / 60))


# The share of a step's output budget that reasoning may use; the rest is kept for the
# answer. Set from the 2026-09-30 probe: the same hard
# coding prompt to GLM 5.3 Flash, scored on 1,550 hidden tests —
#   default           2 of 4 calls reasoned to the 32,768 limit and wrote nothing
#   cap 16k (0.5)     1 of 4 ran away anyway — OpenRouter treats the cap as advice for GLM
#   cap 8k  (0.25)    0 of 4 ran away (max 16.7k); 1377–1508 correct on the first try
#   effort low        0 of 6; 1202–1547
# A first try that is a little less exact is fixed by the agent's own testing; a step that
# ran away wrote nothing. The loop gives the call after any runaway low effort (loop.py).
REASONING_SHARE = 0.25


def reasoning_budget(max_tokens: int) -> int:
    """How many tokens a reasoning model may think for in a reply of `max_tokens`; 0 = no cap.

    Small calls (a one-line decision, a judge's verdict) are left alone: a cap of a few
    hundred tokens would starve a model that needs to think a little, and those calls are
    not where reasoning ran away.
    """
    budget = int(max_tokens * REASONING_SHARE)
    return budget if budget >= 2048 else 0
