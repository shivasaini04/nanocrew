"""Credentials subpackage for Effector."""

from nanoagent.agent.effector.credentials.totp_engine import (
    detect_totp_input_field,
    generate_totp_code,
    is_totp_prompt,
)

__all__ = [
    "generate_totp_code",
    "is_totp_prompt",
    "detect_totp_input_field",
]
