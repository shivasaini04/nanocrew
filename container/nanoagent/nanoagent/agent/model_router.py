"""Dynamic model routing and adaptive temperature for NanoAgent."""

from __future__ import annotations


class ModelRouter:
    """Route to the cheapest model capable of the current task type."""

    TASK_MODELS: dict[str, str | None] = {
        "compaction": "claude-haiku-4-5-20251001",
        "grace_call": "claude-haiku-4-5-20251001",
        # gemini-2.0-flash was retired by Google — confirmed live 2026-08-23 via a
        # real API call, which returned 404 "no longer available... use
        # models/gemini-3.6-flash". Found running Effector's first live test, not a
        # guess — see docs/research/stage43 for the wider audit of stale references.
        "tool_heavy": "gemini/gemini-3.6-flash",
        "reasoning":  "claude-opus-4-7",
        "default":    None,
    }

    _PROVIDER_ENV: dict[str, str] = {
        "claude": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "openai": "OPENAI_API_KEY",
    }

    def select(self, task_type: str, available_keys: dict[str, str]) -> str | None:
        """Return the best model for task_type, or None to use the configured default."""
        target = self.TASK_MODELS.get(task_type)
        if target is None:
            return None
        provider = self._detect_provider(target)
        if available_keys.get(provider):
            return target
        return None

    def resolve(self, task_type: str, available_keys: dict[str, str]) -> tuple[str, str] | None:
        """Like select(), but also returns the API key value so a caller can build a
        dedicated LiteLLMProvider for this task's model without duplicating the
        provider-detection step. Returns (api_key, model) or None if unavailable —
        callers fall back to the primary provider/model on None, same as select()."""
        model = self.select(task_type, available_keys)
        if model is None:
            return None
        key = available_keys.get(self._detect_provider(model))
        if not key:
            return None
        return key, model

    def _detect_provider(self, model: str) -> str:
        if model.startswith("gemini"):
            return "gemini"
        if model.startswith("gpt") or model.startswith("openai"):
            return "openai"
        return "claude"


class AdaptiveTemperature:
    """Adjust LLM temperature based on current task phase.

    Low when executing many tool calls (precision mode),
    higher early in exploration to broaden the search space.
    """

    def __init__(self, base: float = 0.1) -> None:
        self._base = base

    def for_iteration(self, iteration: int, recent_tool_count: int) -> float:
        if recent_tool_count > 3:
            return max(0.05, self._base * 0.5)
        if iteration <= 3:
            return min(0.3, self._base * 2)
        return self._base
