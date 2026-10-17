"""Effector Security, Privacy, and Integrity Architecture.

Stage 47 hardening modules:
- SessionVault: AES-256-GCM encrypted session states at rest with zeroization.
- L7NetworkPolicy: Task-scoped domain allowlisting & SSRF link-local blocking.
- DlpScanner: Outbound data loss prevention and credential exfiltration detection.
- PromptFirewall: Dual-plane XML taint boundaries & adversarial DOM text sanitization.
- CanaryGuard: Ephemeral canary tokens & exfiltration leak detection.
- MerkleActionLedger: Cryptographic append-only hash-chained action audit ledger.
"""

from nanoagent.agent.effector.security.canary_guard import CanaryGuard
from nanoagent.agent.effector.security.dlp_scanner import DlpScanner
from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger, MerkleBlock
from nanoagent.agent.effector.security.network_policy import L7NetworkPolicy, is_private_or_metadata_host
from nanoagent.agent.effector.security.prompt_firewall import (
    is_adversarial_injection,
    sanitize_dom_text,
    wrap_untrusted_perception,
)
from nanoagent.agent.effector.security.session_vault import SessionVault, zeroize_buffer

__all__ = [
    "SessionVault",
    "zeroize_buffer",
    "L7NetworkPolicy",
    "is_private_or_metadata_host",
    "DlpScanner",
    "PromptFirewall",
    "wrap_untrusted_perception",
    "sanitize_dom_text",
    "is_adversarial_injection",
    "CanaryGuard",
    "MerkleActionLedger",
    "MerkleBlock",
]
