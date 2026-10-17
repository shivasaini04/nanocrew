"""Stage 61 phase 9 — decisions become a dataset, and the tiny action policy trained on it
(scripts/decision_dataset.py). The split is by RUN: two decisions from one run share a goal
and a page, so mixing them across the split would inflate every number."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "decision_dataset", Path(__file__).parent.parent / "scripts" / "decision_dataset.py")
dd = importlib.util.module_from_spec(_SPEC)
sys.modules["decision_dataset"] = dd
_SPEC.loader.exec_module(dd)


def _write_run(dirpath: Path, run_id: str, steps: list[tuple[str, str]]) -> None:
    dirpath.mkdir(parents=True, exist_ok=True)
    lines = []
    for turn, (action, elements) in enumerate(steps, start=1):
        lines.append(json.dumps({
            "type": "decision", "run_id": run_id, "turn": turn, "goal": "find the price",
            "url": "https://x.example/", "elements": elements, "prompt": "Recent actions:\nnone yet",
            "action": {"action": action, "target": "@e1"}, "model": "m", "decision_ms": 1200,
        }))
        lines.append(json.dumps({"type": "outcome", "run_id": run_id, "turn": turn, "status": "success"}))
    (dirpath / f"{run_id}.jsonl").write_text("\n".join(lines), encoding="utf-8")


def test_export_reads_decisions_and_their_outcomes(tmp_path: Path):
    _write_run(tmp_path / "recs", "run-1", [("click", "[@e1] button \"Buy\""), ("done", "[@e1] p \"£5\"")])
    examples = dd.load_examples([str(tmp_path / "recs")])
    assert [e["action"] for e in examples] == ["click", "done"]
    assert examples[0]["outcome"] == "success" and examples[0]["run_id"] == "run-1"


def test_a_rare_action_is_folded_into_other(tmp_path: Path):
    _write_run(tmp_path / "r", "run-1", [("takeover", "[@e1] button \"x\"")])
    assert dd.load_examples([str(tmp_path / "r")])[0]["action"] == "other"


def test_features_describe_the_page_and_the_goal():
    f = dd.featurise({"goal": "find the price", "elements": '[@e1] button "Buy"\n[@e2] input "Search"',
                      "prompt": "Recent actions:\n1. click -> failed", "turn": 3})
    assert f[dd._bucket("bias")] == 1.0
    assert f[dd._bucket("last_failed")] == 1.0
    assert f[dd._bucket("n_elements")] == pytest.approx(0.2)
    assert dd._bucket("g:price") in f and dd._bucket("r:button") in f


def test_an_empty_page_is_a_feature():
    f = dd.featurise({"goal": "g", "elements": "Interactive Elements:", "prompt": "", "turn": 1})
    assert f[dd._bucket("empty_page")] == 1.0


def test_whole_runs_go_to_one_side_of_the_split():
    examples = [{"run_id": f"run-{i}", "action": "click"} for i in range(10) for _ in range(3)]
    train, test = dd._split_by_run(examples, holdout=0.3, seed=1)
    assert {e["run_id"] for e in train}.isdisjoint({e["run_id"] for e in test})
    assert len(test) == 9  # 3 of 10 runs, 3 decisions each


def test_the_policy_learns_a_separable_signal(tmp_path: Path):
    """A page with a search box is typed into; a page of links is clicked. Trivial on
    purpose — this proves the training path works end to end, not that the task is easy."""
    recs = tmp_path / "recs"
    for i in range(8):
        _write_run(recs, f"type-{i}", [("type", '[@e1] input "Search books"')])
        _write_run(recs, f"click-{i}", [("click", '[@e1] link "Next page"')])
    data = tmp_path / "d.jsonl"
    examples = dd.load_examples([str(recs)])
    data.write_text("\n".join(json.dumps(e) for e in examples), encoding="utf-8")

    rc = dd.main.__wrapped__ if hasattr(dd.main, "__wrapped__") else None
    sys.argv = ["x", "train", "--data", str(data), "--report", str(tmp_path / "r.json"), "--epochs", "30"]
    assert dd.main() == 0
    report = json.loads((tmp_path / "r.json").read_text())
    assert report["accuracy"] >= report["baseline_accuracy"]
    assert report["train_runs"] and report["test_runs"]
