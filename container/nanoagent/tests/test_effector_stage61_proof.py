"""Stage 61 phase 6 — every Effector result carries a proof (effector/proof.py)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.proof import build_proof


def _proof(tmp_path, **kw):
    base = dict(success=True, extracted=None, page_text="", downloads=[], workspace=tmp_path, final_url="https://x.example/")
    base.update(kw)
    return build_proof(**base)


def test_a_value_that_is_on_the_final_page_is_verified(tmp_path):
    p = _proof(tmp_path, extracted={"answer": "£51.77"}, page_text="A Light in the Attic  £51.77  In stock")
    assert p["status"] == "verified"
    assert p["checks"][0]["result"] == "pass"


def test_a_value_the_page_does_not_show_is_not_verified(tmp_path):
    # e.g. a number the model invented, or one it computed — either way not provable here.
    p = _proof(tmp_path, extracted={"answer": "£99.00"}, page_text="A Light in the Attic £51.77")
    assert p["status"] == "unknown"
    assert p["checks"][0]["result"] == "not seen"


def test_a_saved_file_verifies_and_a_missing_one_refutes(tmp_path):
    (tmp_path / "downloads").mkdir()
    (tmp_path / "downloads" / "a.pdf").write_bytes(b"%PDF-1.4 x")
    ok = _proof(tmp_path, downloads=[{"path": "downloads/a.pdf", "error": None}])
    assert ok["status"] == "verified"
    missing = _proof(tmp_path, downloads=[{"path": "downloads/b.pdf", "error": None}])
    assert missing["status"] == "refuted"
    failed = _proof(tmp_path, downloads=[{"path": "", "error": "blocked by the network policy"}])
    assert failed["status"] == "refuted"


def test_a_run_that_did_not_finish_is_refuted(tmp_path):
    p = _proof(tmp_path, success=False, error="Gave up after 3 consecutive failures")
    assert p["status"] == "refuted"
    assert "Gave up" in p["checks"][0]["detail"]


def test_nothing_checkable_is_unknown_never_verified(tmp_path):
    assert _proof(tmp_path)["status"] == "unknown"


def test_a_replay_and_a_compiled_read_carry_their_own_proof(tmp_path):
    assert _proof(tmp_path, macro_used="macro_x")["status"] == "verified"
    assert _proof(tmp_path, route="compiled_read", extracted={"answer": "11"})["status"] == "verified"


def test_mixed_evidence_is_not_rounded_up(tmp_path):
    p = _proof(tmp_path, extracted={"a": "£51.77", "b": "a summary the model wrote"}, page_text="£51.77")
    assert p["status"] == "unknown"


@pytest.mark.asyncio
async def test_every_effector_result_carries_a_proof(tmp_path: Path):
    from nanoagent.agent.tools.effector import EffectorTool

    from test_effector_phase0 import FakeSession, ScriptedProvider

    provider = ScriptedProvider([{"thought": "done", "action": "done", "extractedData": {"answer": "x"}}])
    tool = EffectorTool(workspace=tmp_path, provider=provider, model="fake/p",
                        decision_provider=provider, decision_model="fake/d")
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        out = json.loads(await tool.execute(goal="read x", session_domain="example.test"))
    assert out["proof"]["status"] in ("verified", "unknown", "refuted")
    assert out["proof"]["checks"], out["proof"]

    from nanoagent.agent.effector.decision_log import read_records
    assert any(r["type"] == "proof" for r in read_records(tmp_path))


def test_a_value_on_the_page_does_not_verify_an_in_place_action(tmp_path):
    # Found live 2026-09-20: every <option> label is on the page whatever is selected.
    p = _proof(tmp_path, extracted={"answer": "Option 2"}, page_text="Option 1 Option 2",
               steps=[{"action": "select", "url_after": "https://h.example/dropdown"}],
               start_url="https://h.example/dropdown")
    assert p["status"] == "unknown"
    assert p["checks"][0]["result"] == "weak"


def test_a_value_on_the_page_verifies_a_read(tmp_path):
    p = _proof(tmp_path, extracted={"answer": "11"}, page_text="11 results",
               steps=[{"action": "click", "url_after": "https://b.example/travel"}],
               start_url="https://b.example/")
    assert p["status"] == "verified"


def test_a_saved_file_still_verifies_a_run_that_clicked_in_place(tmp_path):
    (tmp_path / "downloads").mkdir()
    (tmp_path / "downloads" / "f.txt").write_text("x")
    p = _proof(tmp_path, downloads=[{"path": "downloads/f.txt"}],
               steps=[{"action": "download", "url_after": "https://d.example/"}], start_url="https://d.example/")
    assert p["status"] == "verified"


def test_reporting_the_saved_files_own_path_does_not_undo_its_proof(tmp_path):
    (tmp_path / "downloads").mkdir()
    (tmp_path / "downloads" / "f.txt").write_text("x")
    p = _proof(tmp_path, extracted={"answer": "downloads/f.txt", "name": "f.txt"},
               downloads=[{"path": "downloads/f.txt"}], page_text="Download f.txt")
    assert p["status"] == "verified"
