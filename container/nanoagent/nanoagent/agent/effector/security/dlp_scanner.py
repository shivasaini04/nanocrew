"""Data Loss Prevention (DLP) & Exfiltration Scanner for Effector.

Scans outbound HTTP request payloads, URLs, and form parameters to detect and block
accidental or malicious exfiltration of sensitive enterprise credentials and PII.
"""

from __future__ import annotations

import json
import re
from typing import Any

from loguru import logger

_SSN_PATTERN = re.compile(r"\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
_API_KEY_PATTERNS = [
    re.compile(r"\b(sk-[a-zA-Z0-9_-]{20,})\b"),                       # OpenAI / Anthropic style
    re.compile(r"\b(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{60,})\b"), # GitHub Personal Access Tokens
    re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"), # Private Keys
    re.compile(r"\b(AIza[0-9A-Za-z-_]{35})\b"),                        # Google API Key
    re.compile(r"\b(xox[baprs]-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24,})\b"), # Slack Tokens
]
_CREDIT_CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")


def _luhn_checksum_valid(card_num: str) -> bool:
    """Verifies Luhn checksum algorithm on digit string."""
    digits = [int(c) for c in card_num if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    checksum = 0
    reverse_digits = digits[::-1]
    for idx, d in enumerate(reverse_digits):
        if idx % 2 == 1:
            doubled = d * 2
            checksum += doubled - 9 if doubled > 9 else doubled
        else:
            checksum += d
    return checksum % 10 == 0


class DlpScanner:
    """Scans structured or textual data for sensitive enterprise credentials and PII."""

    @classmethod
    def scan_text(cls, text: str) -> list[str]:
        """Returns list of detected vulnerability labels, or empty list if clean."""
        violations = []
        if not text:
            return violations

        if _SSN_PATTERN.search(text):
            violations.append("SSN_DETECTED")

        for pat in _API_KEY_PATTERNS:
            if pat.search(text):
                violations.append("API_KEY_OR_PRIVATE_KEY_DETECTED")
                break

        for match in _CREDIT_CARD_CANDIDATE.finditer(text):
            candidate = re.sub(r"\D", "", match.group())
            if _luhn_checksum_valid(candidate):
                violations.append("CREDIT_CARD_DETECTED")
                break

        return violations

    @classmethod
    def scan_payload(cls, payload: Any) -> list[str]:
        """Recursively inspects dict, list, string, or bytes payload."""
        if payload is None:
            return []
        if isinstance(payload, bytes):
            try:
                text = payload.decode("utf-8", errors="ignore")
            except Exception:
                return []
            return cls.scan_text(text)
        if isinstance(payload, str):
            return cls.scan_text(payload)
        if isinstance(payload, (dict, list)):
            try:
                dumped = json.dumps(payload)
                return cls.scan_text(dumped)
            except Exception:
                return []
        return []

    @classmethod
    def is_clean(cls, payload: Any) -> bool:
        violations = cls.scan_payload(payload)
        if violations:
            logger.warning(f"dlp_scanner: BLOCKED outbound exfiltration payload containing {violations}")
            return False
        return True
