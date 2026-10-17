"""Cryptographic Merkle Action Ledger & tamper-evident audit chain for Effector.

Maintains an append-only, hash-chained ledger of every executed step, DOM snapshot hash,
and result status. Provides HMAC-SHA256 checkpoint signatures to detect state poisoning.

Tamper-EVIDENT, not tamper-proof: the chain proves that a persisted run record was not
edited after the fact by someone without the cycle secret. It does not prevent an
attacker who holds that secret from rewriting history.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from loguru import logger

_GENESIS_PREV_HASH = "0" * 64


def _resolve_secret(cycle_secret: str | None) -> tuple[bytes, bool]:
    """Returns (key, trusted). Never falls back to a literal committed key.

    R1, 2026-08-31: this used to default to the string "ephemeral-ledger-secret" when no
    cycle token was in the environment. A signature made with a key that is committed to
    the repo is not evidence of anything — anyone who can edit the ledger can also
    recompute every HMAC in it. When there is no ambient secret we now derive a random
    per-process key instead: the chain still detects accidental corruption, but the
    ledger is marked UNTRUSTED so nothing downstream reports it as tamper-evident.
    """
    explicit = (
        cycle_secret
        or os.environ.get("NANOCREW_CYCLE_TOKEN")
        or os.environ.get("CYCLE_TOKEN")
    )
    if explicit:
        return explicit.encode("utf-8"), True
    return secrets.token_bytes(32), False


@dataclass
class MerkleBlock:
    turn: int
    action: str
    target: str
    url: str
    snapshot_hash: str
    status: str
    timestamp: float
    prev_hash: str
    block_hmac: str

    def compute_payload_hash(self) -> str:
        data = f"{self.turn}:{self.action}:{self.target}:{self.url}:{self.snapshot_hash}:{self.status}:{self.timestamp}:{self.prev_hash}"
        return hashlib.sha256(data.encode("utf-8")).hexdigest()


class MerkleActionLedger:
    """Tamper-evident append-only cryptographic ledger for Effector runs."""

    def __init__(self, cycle_secret: str | None = None):
        self._secret, self.trusted = _resolve_secret(cycle_secret)
        self.blocks: list[MerkleBlock] = []

    @property
    def final_hmac(self) -> str:
        """The chain's current leaf — the value a later verifier anchors against."""
        return self.blocks[-1].block_hmac if self.blocks else _GENESIS_PREV_HASH

    def record_step(
        self,
        turn: int,
        action: str,
        target: str = "",
        url: str = "",
        snapshot_summary: str = "",
        status: str = "success",
    ) -> MerkleBlock:
        prev_hash = self.blocks[-1].block_hmac if self.blocks else _GENESIS_PREV_HASH
        snapshot_hash = hashlib.sha256(snapshot_summary.encode("utf-8")).hexdigest()
        ts = time.time()

        payload = f"{turn}:{action}:{target}:{url}:{snapshot_hash}:{status}:{ts}:{prev_hash}".encode("utf-8")
        block_hmac = hmac.new(self._secret, payload, hashlib.sha256).hexdigest()

        block = MerkleBlock(
            turn=turn,
            action=action,
            target=target,
            url=url,
            snapshot_hash=snapshot_hash,
            status=status,
            timestamp=ts,
            prev_hash=prev_hash,
            block_hmac=block_hmac,
        )
        self.blocks.append(block)
        return block

    append_step = record_step

    def verify_integrity(self) -> bool:
        """Verifies full cryptographic chain integrity from genesis to current leaf."""
        expected_prev = _GENESIS_PREV_HASH
        for block in self.blocks:
            if block.prev_hash != expected_prev:
                logger.error(f"merkle_ledger: CHAIN BROKEN at turn {block.turn}. Expected prev_hash {expected_prev}, got {block.prev_hash}")
                return False

            payload = f"{block.turn}:{block.action}:{block.target}:{block.url}:{block.snapshot_hash}:{block.status}:{block.timestamp}:{block.prev_hash}".encode("utf-8")
            computed_hmac = hmac.new(self._secret, payload, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(computed_hmac, block.block_hmac):
                logger.error(f"merkle_ledger: TAMPERING DETECTED at turn {block.turn}. HMAC mismatch!")
                return False

            expected_prev = block.block_hmac

        return True

    @staticmethod
    def ledger_path(workspace: Path, run_id: str) -> Path:
        """Mirrors action_log._log_path's naming so a run's audit trail and its action
        log sort together and share the same sanitisation rules."""
        safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in run_id)
        d = Path(workspace) / ".effector" / "ledger"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{safe}.ndjson"

    def persist(self, workspace: Path, run_id: str) -> Path:
        """Writes the chain to .effector/ledger/<run_id>.ndjson and returns the path.

        R1: before this existed the dispatcher built a chain and dropped it on the floor
        when the function returned — an audit log that lived for microseconds and was
        never read. The header line carries `trusted` so a reader can tell a real
        tamper-evident chain from a corruption-only one (see _resolve_secret).
        """
        path = self.ledger_path(workspace, run_id)
        header = {
            "_header": True,
            "run_id": run_id,
            "trusted": self.trusted,
            "block_count": len(self.blocks),
            "final_hmac": self.final_hmac,
        }
        with path.open("w", encoding="utf-8") as f:
            f.write(json.dumps(header, ensure_ascii=False) + "\n")
            for b in self.blocks:
                f.write(json.dumps(asdict(b), ensure_ascii=False) + "\n")
        return path

    @classmethod
    def load(cls, workspace: Path, run_id: str) -> tuple[list[MerkleBlock], dict[str, Any]] | None:
        """Reads a persisted chain back for out-of-band verification.

        Returns (blocks, header), or None when no ledger exists for that run. Verifying
        the result needs a ledger constructed with the same cycle secret — assign the
        returned blocks to `.blocks` and call verify_integrity().
        """
        path = cls.ledger_path(workspace, run_id)
        if not path.exists():
            return None

        header: dict[str, Any] = {}
        blocks: list[MerkleBlock] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("_header"):
                header = row
                continue
            blocks.append(MerkleBlock(**row))
        return blocks, header

    def sign_checkpoint(self, raw_bytes: bytes) -> str:
        """Signs arbitrary checkpoint binary data with the cycle HMAC secret."""
        return hmac.new(self._secret, raw_bytes, hashlib.sha256).hexdigest()

    def verify_checkpoint(self, raw_bytes: bytes, signature_hex: str) -> bool:
        """Verifies checkpoint binary data against an HMAC signature."""
        expected = hmac.new(self._secret, raw_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature_hex)
