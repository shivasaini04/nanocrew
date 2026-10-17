"""Stage 61 phase 0: the live baseline's own checks (scripts/effector_baseline.py).
A wrong checker would make every baseline number wrong, so the offline parts are
pinned here. The network-backed checks are exercised by the live run itself."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "effector_baseline", Path(__file__).parent.parent / "scripts" / "effector_baseline.py",
)
eb = importlib.util.module_from_spec(_SPEC)
sys.modules["effector_baseline"] = eb  # dataclasses look their module up here
_SPEC.loader.exec_module(eb)


def test_answer_prefers_the_answer_key():
    assert eb._answer({"extracted_data": {"answer": "51.77", "other": "x"}}) == "51.77"


def test_answer_falls_back_to_every_extracted_value():
    assert eb._answer({"extracted_data": {"price": "£51.77"}}) == "£51.77"
    assert eb._answer({"extracted_data": None}) == ""


def test_contains_check_ignores_case_and_spacing():
    check = eb.check_contains("NCR Delhi")
    assert check({"extracted_data": {"answer": "ncr   delhi"}}, Path("."))[0]
    assert not check({"extracted_data": {"answer": "Haryana Karnal"}}, Path("."))[0]


def test_url_check_uses_the_final_url():
    check = eb.check_url("/secure")
    assert check({"final_url": "https://the-internet.herokuapp.com/secure"}, Path("."))[0]
    assert not check({"final_url": "https://the-internet.herokuapp.com/login"}, Path("."))[0]
    assert not check({}, Path("."))[0]


def test_download_check_needs_a_real_non_empty_file(tmp_path: Path):
    (tmp_path / "downloads").mkdir()
    (tmp_path / "downloads" / "a.txt").write_text("data")
    (tmp_path / "downloads" / "empty.txt").write_text("")
    assert eb.check_download({"downloads": [{"path": "downloads/a.txt"}]}, tmp_path)[0]
    assert not eb.check_download({"downloads": [{"path": "downloads/empty.txt"}]}, tmp_path)[0]
    assert not eb.check_download({"downloads": [{"path": "downloads/missing.txt"}]}, tmp_path)[0]
    assert not eb.check_download({"downloads": []}, tmp_path)[0]


def test_task_ids_are_unique_and_repeats_exist():
    ids = [t.id for t in eb.TASKS]
    assert len(ids) == len(set(ids))
    assert set(eb.REPEATS) <= set(ids)
