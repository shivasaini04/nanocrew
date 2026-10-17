"""Phase 9: Verification tests for Cryptographic Merkle State Ledger & HMAC-Chained Action Proofs.

Tests append-only hash chaining, Merkle block tamper detection, broken link detection,
and checkpoint HMAC signature verification.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.agent.effector.resilience.checkpoint import (
    RunCheckpoint,
    get_checkpoint,
    save_checkpoint,
)
from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger


def test_merkle_ledger_append_and_verify_clean_chain():
    """Verify that MerkleActionLedger builds an immutable, valid HMAC-chained audit log."""
    ledger = MerkleActionLedger(cycle_secret="test_secret_key_123")

    b1 = ledger.record_step(turn=1, action="navigate", url="https://example.com", status="success")
    b2 = ledger.record_step(turn=2, action="click", target="@e5", status="success")
    b3 = ledger.record_step(turn=3, action="type", target="@e12", snapshot_summary="Form filled", status="success")

    assert len(ledger.blocks) == 3
    assert b1.prev_hash == "0" * 64
    assert b2.prev_hash == b1.block_hmac
    assert b3.prev_hash == b2.block_hmac

    assert ledger.verify_integrity() is True


def test_merkle_ledger_detects_step_modification_tampering():
    """Verify that tampering with an action, target, or status in any block is caught by verify_integrity."""
    ledger = MerkleActionLedger(cycle_secret="test_secret_key_123")
    ledger.record_step(turn=1, action="navigate", url="https://example.com")
    ledger.record_step(turn=2, action="click", target="@e5")

    assert ledger.verify_integrity() is True

    # Malicious modification of historical turn
    ledger.blocks[0].action = "malicious_delete_action"
    assert ledger.verify_integrity() is False


def test_merkle_ledger_detects_chain_link_breakage():
    """Verify that inserting, deleting, or swapping blocks breaks prev_hash chain verification."""
    ledger = MerkleActionLedger(cycle_secret="test_secret_key_123")
    ledger.record_step(turn=1, action="step1")
    ledger.record_step(turn=2, action="step2")
    ledger.record_step(turn=3, action="step3")

    assert ledger.verify_integrity() is True

    # Break chain linkage
    ledger.blocks[2].prev_hash = "f" * 64
    assert ledger.verify_integrity() is False


def test_checkpoint_signature_and_tamper_rejection(tmp_path: Path, monkeypatch):
    """Verify save_checkpoint generates an HMAC signature and rejects modified checkpoints.

    R1 (2026-08-31): needs an explicit cycle token now. Signing only happens with a real
    ambient secret — an ephemeral per-process key would produce a signature that the
    process resuming the run could never reproduce. See the unsigned-path test below.
    """
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "test-cycle-secret")
    cp = RunCheckpoint(run_id="run-secure-42", agent_id="agent-007", goal="Scrape leads safely")
    save_checkpoint(tmp_path, cp)

    cp_file = tmp_path / ".effector" / "checkpoints" / "run-secure-42.json"
    sig_file = tmp_path / ".effector" / "checkpoints" / "run-secure-42.sig"

    assert cp_file.exists()
    assert sig_file.exists()
    assert len(sig_file.read_text(encoding="utf-8").strip()) == 64  # SHA-256 HMAC hex

    # Loading clean checkpoint succeeds
    loaded = get_checkpoint(tmp_path, "run-secure-42")
    assert loaded is not None
    assert loaded.goal == "Scrape leads safely"

    # Tamper with checkpoint JSON payload
    data = json.loads(cp_file.read_text(encoding="utf-8"))
    data["goal"] = "Malicious altered goal"
    cp_file.write_text(json.dumps(data), encoding="utf-8")

    # Loading tampered checkpoint MUST fail and return None
    tampered_load = get_checkpoint(tmp_path, "run-secure-42")
    assert tampered_load is None


def test_checkpoint_saves_unsigned_and_still_resumes_without_a_cycle_token(tmp_path: Path, monkeypatch):
    """R1: no ambient secret means no signature — but resume must still work.

    Signing with an ephemeral per-process key would guarantee a verify failure in the
    process that resumes the run, silently discarding a valid checkpoint and losing real
    work. Unsigned-and-usable is the correct degradation; the warning names the loss.
    """
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)

    cp = RunCheckpoint(run_id="run-unsigned", agent_id="agent-007", goal="Resume me")
    save_checkpoint(tmp_path, cp)

    sig_file = tmp_path / ".effector" / "checkpoints" / "run-unsigned.sig"
    assert not sig_file.exists(), "an unverifiable signature is worse than none"

    loaded = get_checkpoint(tmp_path, "run-unsigned")
    assert loaded is not None and loaded.goal == "Resume me"


def test_checkpoint_signed_by_another_process_resumes_unverified(tmp_path: Path, monkeypatch):
    """A signature we cannot check is not proof of tampering — don't discard the run."""
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "secret-from-the-original-cycle")
    cp = RunCheckpoint(run_id="run-crossproc", agent_id="agent-007", goal="Survive a restart")
    save_checkpoint(tmp_path, cp)
    assert (tmp_path / ".effector" / "checkpoints" / "run-crossproc.sig").exists()

    # The resuming process has no cycle token at all.
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)

    loaded = get_checkpoint(tmp_path, "run-crossproc")
    assert loaded is not None, "a checkpoint was discarded merely because the key was absent"
    assert loaded.goal == "Survive a restart"
