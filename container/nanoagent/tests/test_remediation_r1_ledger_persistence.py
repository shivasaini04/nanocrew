"""R1 — Merkle ledger persistence, verification and key handling.

Audit of 2026-08-31 found the dispatcher building a full HMAC chain and then dropping it
when the function returned, and the ledger falling back to a hardcoded key committed to
the repo. See docs/research/ultimaa/18-remediation-01-merkle-ledger-persistence.md.

The reachability tests at the bottom are the ones that matter: they assert on the
production side effect (a file on disk, a key in the result JSON), not on the ledger
class in isolation. A test that only exercises MerkleActionLedger directly would have
passed throughout the period the dispatcher was throwing its output away.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger
from nanoagent.agent.tools.effector import EffectorTool


# --------------------------------------------------------------------------- keying


def test_ledger_never_uses_a_hardcoded_default_key(monkeypatch):
    """The committed literal key is gone: two unkeyed ledgers must not agree."""
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)

    a, b = MerkleActionLedger(), MerkleActionLedger()

    assert a._secret != b._secret, "unkeyed ledgers share a key — the literal is back"
    assert a._secret != b"ephemeral-ledger-secret"
    assert a.trusted is False and b.trusted is False


def test_ledger_is_trusted_when_cycle_token_present(monkeypatch):
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "real-cycle-secret")
    assert MerkleActionLedger().trusted is True


def test_explicit_secret_takes_precedence_and_is_trusted(monkeypatch):
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)
    assert MerkleActionLedger(cycle_secret="explicit").trusted is True


# ----------------------------------------------------------------------- persistence


def test_persist_then_load_roundtrips(tmp_path: Path):
    ledger = MerkleActionLedger(cycle_secret="k")
    ledger.record_step(turn=1, action="navigate", url="https://example.com")
    ledger.record_step(turn=2, action="click", target="@e1")

    path = ledger.persist(tmp_path, "run-1")
    assert path.exists()

    blocks, header = MerkleActionLedger.load(tmp_path, "run-1")
    assert header["block_count"] == 2
    assert header["trusted"] is True
    assert header["final_hmac"] == ledger.final_hmac
    assert [b.action for b in blocks] == ["navigate", "click"]


def test_load_returns_none_when_no_ledger_exists(tmp_path: Path):
    assert MerkleActionLedger.load(tmp_path, "never-ran") is None


def test_persisted_header_records_untrusted_key(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)

    ledger = MerkleActionLedger()
    ledger.record_step(turn=1, action="navigate")
    ledger.persist(tmp_path, "run-untrusted")

    _, header = MerkleActionLedger.load(tmp_path, "run-untrusted")
    assert header["trusted"] is False


def test_run_id_with_path_separators_cannot_escape_the_ledger_dir(tmp_path: Path):
    """run_id reaches the filesystem — it must be sanitised like action_log does."""
    ledger = MerkleActionLedger(cycle_secret="k")
    ledger.record_step(turn=1, action="navigate")

    path = ledger.persist(tmp_path, "../../etc/passwd")

    # Separators become underscores, so ".." survives as literal filename characters
    # but cannot traverse. The property that matters is containment, not the spelling.
    assert path.parent == tmp_path / ".effector" / "ledger"
    assert path.resolve().is_relative_to((tmp_path / ".effector" / "ledger").resolve())
    assert "/" not in path.name and "\\" not in path.name


# -------------------------------------------------------------------------- tamper


def test_persisted_chain_detects_on_disk_tampering(tmp_path: Path):
    """Rewriting a recorded action on disk must break verification on reload."""
    ledger = MerkleActionLedger(cycle_secret="k")
    ledger.record_step(turn=1, action="navigate", url="https://example.com")
    ledger.record_step(turn=2, action="click", target="@pay-now")
    path = ledger.persist(tmp_path, "run-1")

    lines = path.read_text(encoding="utf-8").splitlines()
    lines[2] = lines[2].replace("@pay-now", "@cancel")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    replay = MerkleActionLedger(cycle_secret="k")
    replay.blocks, _ = MerkleActionLedger.load(tmp_path, "run-1")
    assert replay.verify_integrity() is False


def test_dropping_a_block_breaks_the_chain(tmp_path: Path):
    """Deleting history is as much a tamper as editing it."""
    ledger = MerkleActionLedger(cycle_secret="k")
    for turn, action in enumerate(["navigate", "click", "fill"], start=1):
        ledger.record_step(turn=turn, action=action)
    ledger.persist(tmp_path, "run-1")

    blocks, _ = MerkleActionLedger.load(tmp_path, "run-1")
    replay = MerkleActionLedger(cycle_secret="k")
    replay.blocks = [blocks[0], blocks[2]]          # excise the middle turn
    assert replay.verify_integrity() is False


def test_wrong_key_cannot_verify_the_chain(tmp_path: Path):
    ledger = MerkleActionLedger(cycle_secret="right")
    ledger.record_step(turn=1, action="navigate")
    ledger.persist(tmp_path, "run-1")

    replay = MerkleActionLedger(cycle_secret="wrong")
    replay.blocks, _ = MerkleActionLedger.load(tmp_path, "run-1")
    assert replay.verify_integrity() is False


# -------------------------------------------------------------- reachability (R1)


def _mock_result(turns: int = 2):
    result = MagicMock()
    result.success = True
    result.goal = "test goal"
    result.turns_executed = turns
    result.final_url = "https://example.com"
    result.extracted_data = None
    result.error = None
    result.synthesized_tool = None
    result.synthesis_context = None
    result.usage = {}
    result.goal_checklist = []
    result.macro_used = None
    result.macro_distilled = None

    logs = []
    for i in range(1, turns + 1):
        t = MagicMock()
        t.turn = i
        t.thought = f"thought {i}"
        t.action.action = "click"
        t.action.target = f"@e{i}"
        t.result.status = "done"
        t.self_healed = False
        logs.append(t)
    result.turns = logs
    return result


def _patched_session():
    session = AsyncMock()
    session.page = AsyncMock()
    session.context = MagicMock()
    session.last_frame_data_url = None
    session.__aenter__.return_value = session
    session.__aexit__.return_value = None
    return session


@pytest.mark.asyncio
async def test_dispatcher_actually_persists_the_ledger_to_disk(tmp_path: Path, monkeypatch):
    """R1 core guard: a real execute() must leave a ledger FILE behind.

    Fails if anyone removes the persist() call from tools/effector.py — which is
    exactly the defect R1 exists to fix.
    """
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "cycle-secret")
    tool = EffectorTool(
        workspace=tmp_path, provider=MagicMock(), model="test-model",
        require_approval=False, merkle_audit=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession") as MockSession, \
         patch("nanoagent.agent.effector.react_loop.run_react_loop",
               new=AsyncMock(return_value=_mock_result(turns=2))):
        MockSession.return_value = _patched_session()
        out = json.loads(await tool.execute(goal="test goal", url="https://example.com"))

    ledger_dir = tmp_path / ".effector" / "ledger"
    assert ledger_dir.exists(), "dispatcher computed a ledger but never wrote it"
    assert list(ledger_dir.glob("*.ndjson")), "no ledger file produced for the run"

    assert out["audit"]["verified"] is True
    assert out["audit"]["trusted_key"] is True
    assert out["audit"]["blocks"] == 2
    assert out["audit"]["path"] is not None


@pytest.mark.asyncio
async def test_persisted_dispatcher_ledger_verifies_on_reload(tmp_path: Path, monkeypatch):
    """The written file must be independently checkable, not just present."""
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "cycle-secret")
    tool = EffectorTool(
        workspace=tmp_path, provider=MagicMock(), model="test-model",
        require_approval=False, merkle_audit=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession") as MockSession, \
         patch("nanoagent.agent.effector.react_loop.run_react_loop",
               new=AsyncMock(return_value=_mock_result(turns=3))):
        MockSession.return_value = _patched_session()
        out = json.loads(await tool.execute(goal="test goal", url="https://example.com"))

    replay = MerkleActionLedger()
    replay.blocks, header = MerkleActionLedger.load(tmp_path, out["run_id"])
    assert header["block_count"] == 3
    assert replay.verify_integrity() is True


@pytest.mark.asyncio
async def test_audit_reports_untrusted_key_when_no_cycle_token(tmp_path: Path, monkeypatch):
    """An unkeyed environment must be visible to the caller, not silently degraded."""
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    monkeypatch.delenv("CYCLE_TOKEN", raising=False)
    tool = EffectorTool(
        workspace=tmp_path, provider=MagicMock(), model="test-model",
        require_approval=False, merkle_audit=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession") as MockSession, \
         patch("nanoagent.agent.effector.react_loop.run_react_loop",
               new=AsyncMock(return_value=_mock_result())):
        MockSession.return_value = _patched_session()
        out = json.loads(await tool.execute(goal="test goal", url="https://example.com"))

    assert out["audit"]["trusted_key"] is False
    assert out["audit"]["verified"] is True          # chain is still internally sound


@pytest.mark.asyncio
async def test_audit_is_none_when_merkle_audit_disabled(tmp_path: Path):
    tool = EffectorTool(
        workspace=tmp_path, provider=MagicMock(), model="test-model",
        require_approval=False, merkle_audit=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession") as MockSession, \
         patch("nanoagent.agent.effector.react_loop.run_react_loop",
               new=AsyncMock(return_value=_mock_result())):
        MockSession.return_value = _patched_session()
        out = json.loads(await tool.execute(goal="test goal", url="https://example.com"))

    assert out["audit"] is None
    assert not (tmp_path / ".effector" / "ledger").exists()


@pytest.mark.asyncio
async def test_persist_failure_does_not_fail_the_run(tmp_path: Path, monkeypatch):
    """Degraded observability must not cost the user their automation result."""
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "cycle-secret")
    tool = EffectorTool(
        workspace=tmp_path, provider=MagicMock(), model="test-model",
        require_approval=False, merkle_audit=True,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession") as MockSession, \
         patch("nanoagent.agent.effector.react_loop.run_react_loop",
               new=AsyncMock(return_value=_mock_result())), \
         patch.object(MerkleActionLedger, "persist", side_effect=OSError("read-only fs")):
        MockSession.return_value = _patched_session()
        out = json.loads(await tool.execute(goal="test goal", url="https://example.com"))

    assert out["success"] is True, "a failed audit write must not sink the run"
    assert out["audit"]["path"] is None
    assert out["audit"]["verified"] is True
