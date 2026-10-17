"""Stage 49 phase 2 — a browser login must survive to the next cycle.

`SessionVault` derived its key from `NANOCREW_CYCLE_TOKEN`, which `cycle-token.ts`
mints as `randomBytes(32)` per cycle and revokes when the cycle ends. Every cycle
therefore derived a different key, so a session saved in cycle A could never be
decrypted in cycle B — `load_session` caught the failure, returned None, and the agent
opened a logged-out browser without telling anyone. The effector tool's documented
promise ("logs in once, reuses the session on later calls") only held inside one cycle.

The orchestrator now derives a stable per-agent secret and passes it in the cycle
payload as `vaultSecret`; the adapter promotes it to `NANOCREW_VAULT_SECRET`.

The headline test is `test_a_session_saved_in_one_cycle_opens_in_the_next`, which fails
against the old key derivation and is the entire point of the phase.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.security.session_vault import (
    SessionVault,
    VaultKeyUnavailable,
    vault_secret,
)

_STATE = {"cookies": [{"name": "li_at", "value": "secret-session-cookie", "domain": ".linkedin.com"}]}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("NANOCREW_VAULT_SECRET", raising=False)
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_ID", "agent-1")


# ─── the bug this phase exists to fix ─────────────────────────────────────────

def test_a_session_saved_in_one_cycle_opens_in_the_next(tmp_path, monkeypatch):
    """The whole phase in one test.

    Two cycles of the same agent: different cycle tokens (as prod always has), same
    stable vault secret. The login must still be there. Under the old derivation the
    key moved with the cycle token and this returned None.
    """
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")

    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "cycle-A-token")
    SessionVault.save_session(tmp_path, "linkedin.com", _STATE)

    # Next cycle: the cycle token is a fresh random value, as cycle-token.ts guarantees.
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "cycle-B-token-completely-different")
    restored = SessionVault.load_session(tmp_path, "linkedin.com")

    assert restored == _STATE, "the login must survive the cycle boundary"


def test_the_cycle_token_no_longer_influences_the_key(tmp_path, monkeypatch):
    """Guards against a well-meaning future edit reintroducing the cycle token into the
    derivation 'for extra entropy' — which is exactly what made the vault unreadable."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")

    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    SessionVault.save_session(tmp_path, "example.com", _STATE)

    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "suddenly-there-is-a-token")
    assert SessionVault.load_session(tmp_path, "example.com") == _STATE


# ─── isolation ────────────────────────────────────────────────────────────────

def test_another_agents_secret_cannot_open_this_vault(tmp_path, monkeypatch):
    """Per-agent, not per-owner: one agent's stolen workspace plus its own key must not
    open a sibling's sessions."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "agent-1-secret")
    SessionVault.save_session(tmp_path, "linkedin.com", _STATE)

    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "agent-2-secret")
    assert SessionVault.load_session(tmp_path, "linkedin.com") is None


def test_a_vault_is_bound_to_its_domain(tmp_path, monkeypatch):
    """The domain is the AEAD's associated data — a vault file renamed to another
    domain must not decrypt."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    SessionVault.save_session(tmp_path, "linkedin.com", _STATE)

    src = SessionVault.get_vault_path(tmp_path, "linkedin.com")
    SessionVault.get_vault_path(tmp_path, "evil.com").write_bytes(src.read_bytes())

    assert SessionVault.load_session(tmp_path, "evil.com") is None


def test_the_saved_vault_never_contains_the_cookie_in_clear(tmp_path, monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    path = SessionVault.save_session(tmp_path, "linkedin.com", _STATE)
    assert b"secret-session-cookie" not in path.read_bytes()


# ─── failing loudly instead of silently ───────────────────────────────────────

def test_no_secret_means_no_key_rather_than_a_constant(monkeypatch):
    """The old code fell back to the literal "ephemeral-local-fallback-key". A committed
    constant encrypts nothing, so this now refuses instead."""
    assert vault_secret() is None
    with pytest.raises(VaultKeyUnavailable):
        SessionVault.encrypt_storage_state("linkedin.com", _STATE)


def test_loading_without_a_secret_reports_none_rather_than_raising(tmp_path, monkeypatch):
    """A missing key must not take the run down — the browser starts logged out and the
    warning says why."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    SessionVault.save_session(tmp_path, "linkedin.com", _STATE)

    monkeypatch.delenv("NANOCREW_VAULT_SECRET", raising=False)
    assert SessionVault.load_session(tmp_path, "linkedin.com") is None


def test_a_corrupted_vault_returns_none_rather_than_raising(tmp_path, monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    path = SessionVault.save_session(tmp_path, "linkedin.com", _STATE)
    path.write_bytes(b"not a vault at all")
    assert SessionVault.load_session(tmp_path, "linkedin.com") is None


def test_a_missing_vault_is_simply_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    assert SessionVault.load_session(tmp_path, "never-seen.com") is None


# ─── legacy plaintext migration still works ───────────────────────────────────

def test_a_legacy_plaintext_session_is_migrated_into_the_vault(tmp_path, monkeypatch):
    import json

    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    legacy = tmp_path / ".effector" / "sessions"
    legacy.mkdir(parents=True)
    (legacy / "linkedin.com.json").write_text(json.dumps(_STATE), encoding="utf-8")

    assert SessionVault.load_session(tmp_path, "linkedin.com") == _STATE
    assert SessionVault.get_vault_path(tmp_path, "linkedin.com").exists()
