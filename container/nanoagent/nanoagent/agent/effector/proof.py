"""Stage 61 phase 6 — proof, not just speed.

Every Effector result carries a `proof`: what was checked, independently of the agent's
own `done`, and a verdict — `verified`, `refuted` or `unknown`. An agent saying it
finished is not evidence (memory: reference_agent_records_are_not_evidence); phase 0
found a replay that reported success on a login it never completed.

Checks use only what the run already has in hand when it ends, so proving costs no
extra model call and no extra page load:

- **extracted values** must actually appear on the final page. A value that does not
  is not called wrong — the agent may have computed or summarised it ("checkbox 1:
  checked, checkbox 2: unchecked") — but it cannot be called verified either.
- **downloads** must exist on disk and be non-empty; a failed download refutes.
- **macro replays** were already held to their recorded end state (b66899c).
- **compiled reads** were just read live from the page at their recorded selectors.

`unknown` is the honest answer whenever nothing checkable was produced — a navigation
goal with no value and no file. It is never rounded up to `verified`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

VERIFIED, REFUTED, UNKNOWN = "verified", "refuted", "unknown"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


# An answer shorter than this is a token pulled out of a sentence, not a whole reading,
# so a longer line around it is normal. Above it, a near-complete line that stops just
# short looks like the end went missing.
_TRUNCATION_MIN_LEN = 12
# How much may follow the value, relative to its own length, before it stops looking
# like a dropped tail and starts looking like ordinary surrounding text.
_TRUNCATION_MAX_TAIL = 0.35


def _truncated_line(value: str, page_text: str | None) -> str | None:
    """The line this value is only the BEGINNING of, when that is all it is.

    Containment cannot detect a cut-short answer: "Grim Fandango Puzzle Document (1996)"
    is a perfect substring of "Grim Fandango Puzzle Document (1996) [pdf]", so proof
    called it verified while the independent check failed on the missing suffix.

    A value that matches some whole line exactly is fine, even if it also happens to
    start a longer one — that is a real, complete reading. Only a value that NEVER
    appears as a complete line, and does begin a longer one, looks cut short.

    Returns that longer line, or None.

    Being a prefix is NOT enough on its own, and a first version of this got that wrong:
    "11" extracted from "11 results" is a perfectly good reading of a count, and is a
    prefix exactly like the truncated title is. What separates them is how much is left
    over. A truncation loses a small tail — "[pdf]" off a 36-character title — while a
    short value pulled out of a longer sentence leaves far more behind than it took.

    So: the value has to be long enough to be an answer in itself, and what follows it
    on the line has to be small beside it.
    """
    if not value or not page_text or len(value) < _TRUNCATION_MIN_LEN:
        return None
    lines = [_norm(line) for line in str(page_text).splitlines()]
    lines = [line for line in lines if line]
    if any(line == value for line in lines):
        return None
    for line in lines:
        if line.startswith(value) and len(line) > len(value):
            remainder = len(line) - len(value)
            if remainder <= _TRUNCATION_MAX_TAIL * len(value):
                return line
    return None


def build_proof(
    *,
    success: bool,
    extracted: dict[str, Any] | None,
    page_text: str | None,
    downloads: list[dict[str, Any]] | None,
    workspace: Path,
    final_url: str | None,
    macro_used: str | None = None,
    route: str | None = None,
    error: str | None = None,
    steps: list[dict[str, Any]] | None = None,
    start_url: str | None = None,
) -> dict[str, Any]:
    checks: list[dict[str, str]] = []

    def check(name: str, result: str, detail: str) -> None:
        checks.append({"check": name, "result": result, "detail": detail})

    if not success:
        check("run completed", "fail", (error or "the run did not finish")[:200])

    if route == "compiled_read":
        check("read live from the page", "pass", "values read now, at the selectors a verified run recorded")
    if macro_used and success:
        check("replay reached the recorded end state", "pass", str(macro_used))

    for d in downloads or []:
        if not isinstance(d, dict):
            continue
        rel = d.get("path")
        if d.get("error") or not rel:
            check("download saved", "fail", str(d.get("error") or "no file path")[:200])
            continue
        p = Path(workspace) / rel
        if p.exists() and p.stat().st_size > 0:
            check("download saved", "pass", f"{rel} ({p.stat().st_size} bytes)")
        else:
            check("download saved", "fail", f"{rel} is missing or empty")

    # A value on the page proves the answer is real only when the run just READ. If it
    # changed the page in place (a select, a checkbox, typing that did not navigate), the
    # value may have been there before the action too — found live 2026-09-20: "select
    # Option 2 and report which is selected" was "verified" because every <option> label
    # is on the page whatever is selected. Same reading-vs-doing rule as compiled reads.
    in_place = False
    if steps is not None:
        from nanoagent.agent.effector.synthesis.compiled_read import only_navigation
        in_place = not only_navigation(steps, start_url)

    # A reported value that IS a saved file (its path or name) was already proven by the
    # download check above — found live: the download task reported its own file path,
    # which is not on the page, and "not seen" dragged a proven download to "unknown".
    saved_names = set()
    for d in downloads or []:
        if isinstance(d, dict) and d.get("path") and not d.get("error"):
            saved_names.add(_norm(d["path"]))
            saved_names.add(_norm(Path(str(d["path"])).name))

    if extracted and route != "compiled_read":
        text = _norm(page_text)
        for key, value in extracted.items():
            v = _norm(value)
            if not v or len(v) > 500 or v in saved_names:
                continue
            cut = _truncated_line(v, page_text)
            if text and v in text and cut:
                # Found live 2026-09-21: the answer was "Grim Fandango Puzzle Document
                # (1996)" and the page said "...(1996) [pdf]". Proof said VERIFIED and the
                # independent check failed, because a TRUNCATED answer is always a
                # substring of the full text — containment cannot see the missing end.
                check(f"'{key}' is on the final page", "weak",
                      f"{str(value)[:120]!r} appears only as the start of {cut[:140]!r} — "
                      "it may be cut short")
            elif text and v in text and in_place:
                check(f"'{key}' is on the final page", "weak",
                      f"{str(value)[:120]!r} is on the page, but the run changed the page in place, "
                      "so its presence does not show the action worked")
            elif text and v in text:
                check(f"'{key}' is on the final page", "pass", str(value)[:120])
            else:
                check(f"'{key}' is on the final page", "not seen",
                      f"{str(value)[:120]!r} does not appear on the final page — computed, reworded, or wrong")

    results = [c["result"] for c in checks]
    if "fail" in results:
        status = REFUTED
    elif results and all(r == "pass" for r in results):
        status = VERIFIED
    else:
        status = UNKNOWN
    return {"status": status, "checks": checks, "final_url": final_url}
