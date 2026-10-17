"""Canary Token Exfiltration Guard for Effector.

Generates high-entropy ephemeral tokens injected into control-plane prompts to detect
prompt leakage or indirect injection exfiltration attempts before actions are executed.
"""

from __future__ import annotations

import secrets
from typing import Any

from loguru import logger


class CanaryGuard:
    """Manages ephemeral canary tokens and validates outbound action payloads."""

    def __init__(self, canary_token: str | None = None):
        self._canary = canary_token or f"CANARY_SEC_{secrets.token_hex(8)}"

    @property
    def token(self) -> str:
        return self._canary

    def is_leaked(self, payload: Any) -> bool:
        """True if the canary token is detected within payload data."""
        if not payload:
            return False
        text = str(payload)
        if self._canary in text:
            logger.critical(f"canary_guard: DETECTED EXFILTRATION LEAK of canary token in outbound payload!")
            return True
        return False

    def validate_step(self, step_dict: dict[str, Any]) -> tuple[bool, str]:
        """Validates step parameters against canary leaks. Returns (is_valid, reason)."""
        for field, val in step_dict.items():
            if val and self._canary in str(val):
                return False, f"Step parameter '{field}' contains leaked internal canary token"
        return True, "Valid"
