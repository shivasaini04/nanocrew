"""Zero-Knowledge Session Vault for Effector.

Replaces plaintext `.effector/sessions/<domain>.json` files with AES-256-GCM encrypted
vaults stored in `.effector/vault/<domain>.vault`.

Keys are derived on-the-fly using HKDF-SHA256 from the execution cycle token (or a
machine-specific secret if running standalone), ensuring that persistent storage states
cannot be exfiltrated from the workspace or decrypted outside the authorized cycle.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from loguru import logger

_VAULT_DIR_NAME = ".effector/vault"
_SALT_LEN = 16
_NONCE_LEN = 12


def zeroize_buffer(buf: bytearray | list | memoryview) -> None:
    """Overwrites sensitive memory buffers in-place with null bytes."""
    if isinstance(buf, bytearray):
        for i in range(len(buf)):
            buf[i] = 0
    elif isinstance(buf, list):
        for i in range(len(buf)):
            buf[i] = 0


class VaultKeyUnavailable(RuntimeError):
    """No stable vault secret in the environment, so nothing may be saved or loaded.

    Raised rather than silently falling back to a constant: a committed fallback key
    encrypts nothing meaningfully, and a per-cycle key (the bug this replaced) writes
    a vault that can never be read again.
    """


def vault_secret() -> str | None:
    """The stable per-agent vault seed, or None when this process has none.

    Stage 49 phase 2. This used to read NANOCREW_CYCLE_TOKEN, which is minted fresh
    per cycle and revoked at its end — so every cycle derived a DIFFERENT key and a
    session saved in one cycle was undecryptable in the next. `load_session` caught
    the failure and returned None, so the agent just opened a logged-out browser and
    said nothing. "Log in once, reuse the session later" only ever held within a
    single cycle.

    The orchestrator now derives a stable per-agent secret (secret-crypto.ts
    `deriveVaultSecret`) and passes it in the cycle payload; the adapter promotes it
    to NANOCREW_VAULT_SECRET. Deliberately NOT falling back to the cycle token: doing
    so would restore the silent-loss bug for any path that forgets to pass the secret.
    """
    return os.environ.get("NANOCREW_VAULT_SECRET") or None


def _derive_vault_key(salt: bytes, domain: str) -> bytes:
    """Derives a 256-bit AES-GCM key from the stable vault secret + agent id + domain salt."""
    secret = vault_secret()
    if not secret:
        raise VaultKeyUnavailable(
            "NANOCREW_VAULT_SECRET is not set — browser sessions cannot be persisted "
            "or restored in this process"
        )
    agent_id = os.environ.get("AGENT_ID", "default-agent")
    ikm = f"{secret}:{agent_id}:{domain}".encode("utf-8")

    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        info=b"effector-session-vault-v1",
    )
    return hkdf.derive(ikm)


class SessionVault:
    """Provides authenticated AES-256-GCM encryption and decryption for browser storage states."""

    @staticmethod
    def encrypt_storage_state(domain: str, storage_state: dict[str, Any]) -> bytes:
        """Encrypts storage state dict into [salt (16B) | nonce (12B) | ciphertext + tag]."""
        raw_json = json.dumps(storage_state).encode("utf-8")
        salt = secrets.token_bytes(_SALT_LEN)
        nonce = secrets.token_bytes(_NONCE_LEN)

        key = _derive_vault_key(salt, domain)
        try:
            aesgcm = AESGCM(key)
            ciphertext = aesgcm.encrypt(nonce, raw_json, domain.encode("utf-8"))
            return salt + nonce + ciphertext
        finally:
            key_buf = bytearray(key)
            zeroize_buffer(key_buf)

    @staticmethod
    def decrypt_storage_state(domain: str, vault_data: bytes) -> dict[str, Any]:
        """Decrypts [salt | nonce | ciphertext + tag] back into a storage state dict."""
        if len(vault_data) < _SALT_LEN + _NONCE_LEN + 16:
            raise ValueError("Vault payload is truncated or invalid")

        salt = vault_data[:_SALT_LEN]
        nonce = vault_data[_SALT_LEN:_SALT_LEN + _NONCE_LEN]
        ciphertext = vault_data[_SALT_LEN + _NONCE_LEN:]

        key = _derive_vault_key(salt, domain)
        try:
            aesgcm = AESGCM(key)
            decrypted_bytes = aesgcm.decrypt(nonce, ciphertext, domain.encode("utf-8"))
            return json.loads(decrypted_bytes.decode("utf-8"))
        finally:
            key_buf = bytearray(key)
            zeroize_buffer(key_buf)

    @staticmethod
    def get_vault_path(workspace: Path, domain: str) -> Path:
        safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
        d = workspace / ".effector" / "vault"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{safe}.vault"

    @classmethod
    def save_session(cls, workspace: Path, domain: str, storage_state: dict[str, Any]) -> Path:
        vault_path = cls.get_vault_path(workspace, domain)
        encrypted_bytes = cls.encrypt_storage_state(domain, storage_state)
        vault_path.write_bytes(encrypted_bytes)
        logger.debug(f"session_vault: securely persisted encrypted session for {domain}")
        return vault_path

    @classmethod
    def load_session(cls, workspace: Path, domain: str) -> dict[str, Any] | None:
        vault_path = cls.get_vault_path(workspace, domain)
        if not vault_path.exists():
            # Check for legacy plaintext session file to migrate
            safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
            legacy_path = workspace / ".effector" / "sessions" / f"{safe}.json"
            if legacy_path.exists():
                try:
                    data = json.loads(legacy_path.read_text(encoding="utf-8"))
                    cls.save_session(workspace, domain, data)
                    logger.info(f"session_vault: migrated legacy plaintext session for {domain} into encrypted vault")
                    return data
                except Exception as err:
                    logger.warning(f"session_vault: failed to migrate legacy session for {domain} — {err}")
            return None

        try:
            vault_bytes = vault_path.read_bytes()
            return cls.decrypt_storage_state(domain, vault_bytes)
        except VaultKeyUnavailable as err:
            logger.warning(
                f"session_vault: a saved session for {domain} EXISTS but cannot be opened — "
                f"{err}. The browser will start logged out."
            )
            return None
        except Exception as err:
            # Loud on purpose (stage 49 phase 2). A vault that exists and will not open
            # is the exact shape of the bug this phase fixed: the agent carries on with a
            # logged-out browser and reports whatever it managed without the login. If
            # this line appears every run, the key is not stable — check that
            # `vaultSecret` is reaching the container and that nanocrew_SECRET_KEY has
            # not been rotated.
            logger.warning(
                f"session_vault: failed to decrypt the saved session for {domain} "
                f"(wrong key or tampered file) — {err}. The browser will start logged out."
            )
            return None
