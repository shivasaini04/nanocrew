"""Autonomous RFC 6238 TOTP Engine for Effector.

Generates standard Time-Based One-Time Passwords (RFC 6238) from base32 secrets
with zero cloud dependencies. Also detects 2FA / authenticator prompts in the DOM
and identifies the target verification code input fields.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import struct
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nanoagent.agent.effector.types import DOMElementNode, DOMSnapshot

_TOTP_PROMPT_PATTERN = re.compile(
    r"two-factor|2-step|authenticator|verification\s*code|security\s*code|one-time\s*(?:passcode|password)|6-digit|enter\s*code",
    re.IGNORECASE,
)

_TOTP_FIELD_PATTERN = re.compile(
    r"totp|otp|2fa|code|token|verification|mfa|auth_code",
    re.IGNORECASE,
)


def generate_totp_code(
    secret: str,
    digits: int = 6,
    time_step: int = 30,
    for_time: float | None = None,
    algorithm: str = "sha1",
) -> str:
    """Generate an RFC 6238 TOTP code from a base32-encoded secret.
    
    Supports SHA-1, SHA-256, and SHA-512 with configurable digits and time steps.
    """
    cleaned_secret = re.sub(r"[\s\-]", "", secret.upper())
    missing_padding = len(cleaned_secret) % 8
    if missing_padding:
        cleaned_secret += "=" * (8 - missing_padding)

    try:
        key = base64.b32decode(cleaned_secret, casefold=True)
    except Exception as err:
        raise ValueError(f"Invalid base32 TOTP secret: {err}") from err

    current_time = for_time if for_time is not None else time.time()
    counter = int(current_time // time_step)
    msg = struct.pack(">Q", counter)

    algo_map = {
        "sha1": hashlib.sha1,
        "sha256": hashlib.sha256,
        "sha512": hashlib.sha512,
    }
    hash_fn = algo_map.get(algorithm.lower(), hashlib.sha1)

    hmac_digest = hmac.new(key, msg, hash_fn).digest()
    offset = hmac_digest[-1] & 0x0F
    binary = struct.unpack(">I", hmac_digest[offset:offset + 4])[0] & 0x7FFFFFFF
    otp = binary % (10 ** digits)

    return f"{otp:0{digits}d}"


def is_totp_prompt(title: str, body_text: str) -> bool:
    """True if the page title or visible text indicates a 2FA/MFA challenge."""
    combined = f"{title}\n{body_text}"
    return bool(_TOTP_PROMPT_PATTERN.search(combined))


def detect_totp_input_field(elements: list[DOMElementNode]) -> DOMElementNode | None:
    """Find the best-matching input element for a TOTP code in a list of DOMElementNodes."""
    candidates: list[tuple[int, DOMElementNode]] = []

    for el in elements:
        if el.tag not in ("input", "textarea") and el.role not in ("textbox", "spinbutton"):
            continue

        score = 0
        attrs_haystack = f"{el.name or ''} {el.placeholder or ''} {el.type or ''} {el.value or ''}".lower()

        if _TOTP_FIELD_PATTERN.search(attrs_haystack):
            score += 10

        if el.type in ("tel", "number"):
            score += 5

        if score > 0:
            candidates.append((score, el))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]
