"""Phase 6: Verification tests for Zero-Knowledge Session Vault (AES-256-GCM) & Wire-Level Auth.

Tests domain-bound authenticated encryption, tamper detection, multi-domain isolation,
memory zeroization, and legacy session migration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag

from nanoagent.agent.effector.security.session_vault import SessionVault, zeroize_buffer


# Stage 49 phase 2: the vault used to fall back to a committed constant when no key was
# in the environment, so these tests passed with no key set. That fallback is gone — a
# key derivable from the source encrypts nothing — so the suite now supplies one, the
# same way the orchestrator supplies `vaultSecret` in the cycle payload.
@pytest.fixture(autouse=True)
def _vault_secret(monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "test-stable-per-agent-secret")
    monkeypatch.setenv("AGENT_ID", "test-agent")



def test_session_vault_aes_gcm_domain_bound_aad(tmp_path: Path):
    """Verify AES-256-GCM encryption binds ciphertext to the domain via Associated Authenticated Data."""
    domain_a = "app.internal.corp"
    domain_b = "other.internal.corp"
    state = {"cookies": [{"name": "auth", "value": "top_secret_jwt"}]}

    encrypted_a = SessionVault.encrypt_storage_state(domain_a, state)
    assert b"top_secret_jwt" not in encrypted_a

    # Decrypting under correct domain succeeds
    decrypted = SessionVault.decrypt_storage_state(domain_a, encrypted_a)
    assert decrypted == state

    # Attempting to decrypt under a different domain must fail (AAD mismatch)
    with pytest.raises(InvalidTag):
        SessionVault.decrypt_storage_state(domain_b, encrypted_a)


def test_session_vault_ciphertext_tamper_rejection():
    """Verify that any tampering with salt, nonce, or ciphertext payload throws InvalidTag."""
    domain = "vault-security.test"
    state = {"token": "valid_token_value"}
    raw_vault = bytearray(SessionVault.encrypt_storage_state(domain, state))

    # Flip a single bit in the ciphertext portion
    raw_vault[-1] ^= 0x01

    with pytest.raises(InvalidTag):
        SessionVault.decrypt_storage_state(domain, bytes(raw_vault))


def test_session_vault_zeroize_memory_buffer():
    """Verify zeroize_buffer overwrites memory buffers in-place."""
    sensitive_data = bytearray(b"super_secret_master_key_12345678")
    original_len = len(sensitive_data)
    zeroize_buffer(sensitive_data)

    assert len(sensitive_data) == original_len
    assert all(b == 0 for b in sensitive_data)


def test_session_vault_migration_from_legacy_plaintext(tmp_path: Path):
    """Verify automatic migration from legacy plaintext .json to AES-256-GCM .vault."""
    domain = "legacy-portal.org"
    legacy_dir = tmp_path / ".effector" / "sessions"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_file = legacy_dir / "legacy-portal.org.json"

    state = {"cookies": [{"name": "sid", "value": "migrated_123"}]}
    legacy_file.write_text(json.dumps(state))

    # Loading session should load plaintext and transparently save encrypted vault
    loaded = SessionVault.load_session(tmp_path, domain)
    assert loaded == state

    vault_file = tmp_path / ".effector" / "vault" / "legacy-portal.org.vault"
    assert vault_file.exists()
    assert b"migrated_123" not in vault_file.read_bytes()
