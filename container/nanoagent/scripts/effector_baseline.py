"""Stage 61 phase 0 — live Effector baseline.

Runs a fixed set of real browser tasks through the real EffectorTool with the same
model resolution an agent uses, then checks every result against an answer this
script fetches for itself. The agent's own `done` is never the success signal
(memory: reference_agent_records_are_not_evidence).

Safe by construction: public read-only pages and public test sites only
(books/quotes.toscrape.com, the-internet.herokuapp.com, demoqa.com, Wikipedia,
Hacker News). No real account, no send, no purchase.

Run inside the agent image (see nanocrew-main/scripts/effector-baseline.sh):

    python /app/nanoagent/scripts/effector_baseline.py --workspace /workspace/group
    python ... --only books-price,wiki-open      # a subset

Writes <workspace>/baseline/results.json and prints a table plus the step-timing
report from nanoagent.agent.effector.metrics.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) nanocrew-baseline-check"}


def _get(url: str) -> str:
    r = httpx.get(url, headers=UA, timeout=30, follow_redirects=True)
    r.raise_for_status()
    return r.text


def _answer(result: dict) -> str:
    """The agent's reported answer: the `answer` field if it used one, else every
    extracted value joined, so a correct answer under another key still counts."""
    data = result.get("extracted_data") or {}
    if not isinstance(data, dict):
        return str(data)
    if "answer" in data:
        return str(data["answer"])
    return " | ".join(str(v) for v in data.values())


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


# ─── checks: each returns (passed, what was expected) ─────────────────────────

def check_contains(expected: str) -> Callable[[dict, Path], tuple[bool, str]]:
    def _check(result: dict, ws: Path) -> tuple[bool, str]:
        return _norm(expected) in _norm(_answer(result)), expected
    return _check


def check_url(fragment: str) -> Callable[[dict, Path], tuple[bool, str]]:
    def _check(result: dict, ws: Path) -> tuple[bool, str]:
        return fragment.lower() in (result.get("final_url") or "").lower(), f"url contains {fragment}"
    return _check


def check_book_price(result: dict, ws: Path) -> tuple[bool, str]:
    html = _get("https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html")
    price = re.search(r'class="price_color">([^<]+)<', html).group(1).replace("Â", "")
    digits = price.lstrip("£")
    return digits in _answer(result), price


def check_travel_count(result: dict, ws: Path) -> tuple[bool, str]:
    html = _get("https://books.toscrape.com/catalogue/category/books/travel_2/index.html")
    count = re.search(r"<strong>(\d+)</strong>\s*results", html).group(1)
    return re.search(rf"\b{count}\b", _answer(result)) is not None, count


def check_love_author(result: dict, ws: Path) -> tuple[bool, str]:
    html = _get("https://quotes.toscrape.com/tag/love/")
    author = re.search(r'class="author"[^>]*>([^<]+)<', html).group(1)
    return _norm(author) in _norm(_answer(result)), author


def check_hn_top(result: dict, ws: Path) -> tuple[bool, str]:
    ids = httpx.get("https://hacker-news.firebaseio.com/v0/topstories.json", timeout=30).json()
    titles = []
    # The front page can reorder between the run and this check; accept the top 3.
    for i in ids[:3]:
        item = httpx.get(f"https://hacker-news.firebaseio.com/v0/item/{i}.json", timeout=30).json()
        titles.append(item.get("title", ""))
    got = _norm(_answer(result))
    return any(_norm(t) and _norm(t) in got for t in titles), titles[0] if titles else "?"


def check_download(result: dict, ws: Path) -> tuple[bool, str]:
    saved = [d for d in (result.get("downloads") or []) if isinstance(d, dict) and d.get("path")]
    ok = any((ws / d["path"]).exists() and (ws / d["path"]).stat().st_size > 0 for d in saved)
    return ok, "a non-empty downloaded file"


@dataclass
class Task:
    id: str
    url: str
    goal: str
    check: Callable[[dict, Path], tuple[bool, str]]
    kind: str = "browser"
    tags: list[str] = field(default_factory=list)


_REPORT = ' Report the result as extracted data with the key "answer".'

TASKS: list[Task] = [
    Task("books-price", "https://books.toscrape.com/",
         "Find the book 'A Light in the Attic' and find its price." + _REPORT, check_book_price,
         tags=["search", "extract"]),
    Task("books-travel-count", "https://books.toscrape.com/",
         "Open the 'Travel' category and find how many books it contains." + _REPORT,
         check_travel_count, tags=["navigate", "extract"]),
    Task("wiki-open", "https://en.wikipedia.org/wiki/Main_Page",
         "Find and open the Wikipedia article about Gödel's incompleteness theorems.",
         check_url("incompleteness_theorems"), tags=["search", "navigate"]),
    Task("wiki-fact", "https://en.wikipedia.org/wiki/Main_Page",
         "Using Wikipedia, find the year the construction of the Eiffel Tower was completed." + _REPORT,
         check_contains("1889"), tags=["search", "extract"]),
    Task("heroku-login", "https://the-internet.herokuapp.com/login",
         "Log in with username 'tomsmith' and password 'SuperSecretPassword!' (public test "
         "credentials shown on the page).", check_url("/secure"), tags=["form", "login"]),
    Task("heroku-dropdown", "https://the-internet.herokuapp.com/dropdown",
         "Select 'Option 2' in the dropdown, then report which option is selected." + _REPORT,
         check_contains("Option 2"), tags=["select"]),
    Task("heroku-dynamic", "https://the-internet.herokuapp.com/dynamic_loading/1",
         "Click Start, wait for the hidden text to appear, and report that text." + _REPORT,
         check_contains("Hello World!"), tags=["wait", "extract"]),
    Task("heroku-download", "https://the-internet.herokuapp.com/download",
         "Download the first file listed on the page.", check_download, tags=["download"]),
    Task("quotes-love-author", "https://quotes.toscrape.com/",
         "Open the 'love' tag and find the author of the first quote shown." + _REPORT,
         check_love_author, tags=["navigate", "extract"]),
    Task("quotes-login", "https://quotes.toscrape.com/login",
         "Log in with username 'baseline' and password 'baseline' (this test site accepts "
         "any credentials), then report the text of the link in the top right corner." + _REPORT,
         check_contains("Logout"), tags=["form", "login"]),
    Task("demoqa-textbox", "https://demoqa.com/text-box",
         "Fill the form with Full Name 'Ada Lovelace', Email 'ada@example.com', Current "
         "Address '12 Test Street', Permanent Address '34 Sample Road', submit it, and report "
         "the Name line shown in the output below the form." + _REPORT,
         check_contains("Ada Lovelace"), tags=["form"]),
    Task("demoqa-combobox", "https://demoqa.com/automation-practice-form",
         "Fill First Name 'Ada', Last Name 'Lovelace', Gender 'Female', Mobile '9876543210', "
         "State 'NCR' and City 'Delhi', submit the form, and report the 'State and City' value "
         "shown in the confirmation dialog." + _REPORT,
         check_contains("NCR Delhi"), tags=["form", "combobox"]),
    Task("hn-top", "https://news.ycombinator.com/",
         "Find the title of the number 1 story on the front page." + _REPORT, check_hn_top,
         tags=["extract"]),
    Task("heroku-checkboxes", "https://the-internet.herokuapp.com/checkboxes",
         "Make sure checkbox 1 is checked and checkbox 2 is unchecked, then report the state "
         "of both as 'checkbox 1: checked, checkbox 2: unchecked' if that is what the page "
         "shows." + _REPORT, check_contains("checkbox 1: checked, checkbox 2: unchecked"),
         tags=["click"]),
]

# Repeats of earlier tasks, same wording: what a second visit costs (macro fast path).
REPEATS = [
    "books-price", "heroku-login", "heroku-dynamic",
    # Stage 61 phase 4: public reads — the ones a compiled read can serve without a browser.
    "books-travel-count", "quotes-love-author", "hn-top",
]


def _provider(model: str):
    from nanoagent.providers.litellm_provider import LiteLLMProvider

    prefix = model.split("/")[0]
    key_env = {
        "openrouter": "OPENROUTER_API_KEY", "gemini": "GEMINI_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY", "anthropic": "ANTHROPIC_API_KEY",
    }.get(prefix, f"{prefix.upper()}_API_KEY")
    return LiteLLMProvider(api_key=os.environ.get(key_env, ""), default_model=model)


def build_tool(workspace: Path, primary_model: str, decision_override: str | None = None):
    """The same model resolution loop.py uses for effector: decisions on
    model_router's tool_heavy tier when its key exists, else the primary model."""
    from nanoagent.agent.model_router import ModelRouter
    from nanoagent.agent.tools.effector import EffectorTool

    keys = {
        "claude": os.environ.get("ANTHROPIC_API_KEY", ""),
        "gemini": os.environ.get("GEMINI_API_KEY", ""),
        "openai": os.environ.get("OPENAI_API_KEY", ""),
    }
    router = ModelRouter()
    primary = _provider(primary_model)
    decision_provider, decision_model = primary, primary_model
    resolved = router.resolve("tool_heavy", keys)
    if decision_override:
        # Stage 61 phase 2: the same tasks under a candidate decider, for an A/B
        # against the default. Never used by agents — the harness only.
        decision_model = decision_override
        decision_provider = _provider(decision_override)
    elif resolved:
        from nanoagent.providers.litellm_provider import LiteLLMProvider
        decision_model = resolved[1]
        decision_provider = LiteLLMProvider(api_key=resolved[0], default_model=decision_model)
    synthesis_provider, synthesis_model = primary, primary_model
    resolved = router.resolve("reasoning", keys)
    if resolved:
        from nanoagent.providers.litellm_provider import LiteLLMProvider
        synthesis_model = resolved[1]
        synthesis_provider = LiteLLMProvider(api_key=resolved[0], default_model=synthesis_model)

    tool = EffectorTool(
        workspace=workspace, provider=primary, model=primary_model,
        decision_provider=decision_provider, decision_model=decision_model,
        synthesis_provider=synthesis_provider, synthesis_model=synthesis_model,
        # Every task here is read-only or a public test form; there is no operator to
        # approve anything, and a gate that waits would only measure the wait.
        require_approval=False,
    )
    return tool, decision_model


async def run_task(tool, task: Task, workspace: Path, max_turns: int) -> dict:
    t0 = time.monotonic()
    try:
        raw = await tool.execute(goal=task.goal, url=task.url, max_turns=max_turns)
        result = json.loads(raw)
    except Exception as err:  # noqa: BLE001
        result = {"success": False, "error": f"harness: {err}"}
    elapsed = time.monotonic() - t0
    try:
        passed, expected = task.check(result, workspace)
    except Exception as err:  # noqa: BLE001
        passed, expected = False, f"check failed to run: {err}"
    return {
        "task": task.id,
        "tags": task.tags,
        "seconds": round(elapsed, 1),
        "agent_success": bool(result.get("success")),
        "verified": passed,
        "expected": expected,
        "answer": _answer(result)[:300],
        "final_url": result.get("final_url"),
        "run_id": result.get("run_id"),
        "turns": result.get("turns_executed"),
        "error": (result.get("error") or "")[:300] or None,
        "timings": result.get("timings"),
        "macro_used": result.get("macro_used"),
        "route": result.get("route") or ("macro" if result.get("macro_used") else "browser"),
        "proof": ((result.get("proof") or {}).get("status")),
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default="/workspace/group")
    ap.add_argument("--model", default=os.environ.get("BASELINE_MODEL", "openrouter/z-ai/glm-5.3-flash"))
    ap.add_argument("--only", default="")
    ap.add_argument("--no-repeats", action="store_true")
    ap.add_argument("--max-turns", type=int, default=20)
    ap.add_argument("--label", default="baseline")
    ap.add_argument("--decision-model", default="", help="override the per-step decider (A/B only)")
    args = ap.parse_args()

    ws = Path(args.workspace)
    ws.mkdir(parents=True, exist_ok=True)
    tool, decision_model = build_tool(ws, args.model, args.decision_model or None)

    wanted = {t for t in args.only.split(",") if t}
    tasks = [t for t in TASKS if not wanted or t.id in wanted]
    order = [(t, "first") for t in tasks]
    if not args.no_repeats:
        by_id = {t.id: t for t in tasks}
        order += [(by_id[i], "repeat") for i in REPEATS if i in by_id]

    print(f"effector baseline — primary {args.model}, decisions on {decision_model}, {len(order)} runs", flush=True)
    rows = []
    for task, visit in order:
        row = await run_task(tool, task, ws, args.max_turns)
        row["visit"] = visit
        rows.append(row)
        mark = "PASS" if row["verified"] else "FAIL"
        print(f"  {mark}  {task.id:<20} {visit:<6} {row['seconds']:>6}s  turns={row['turns']}  route={row['route']}  proof={row['proof']}  "
              f"answer={row['answer'][:60]!r}  expected={str(row['expected'])[:40]!r}"
              + (f"  error={row['error'][:80]!r}" if row["error"] else ""), flush=True)

    out = ws / "baseline"
    out.mkdir(exist_ok=True)
    summary = {
        "label": args.label, "primary_model": args.model, "decision_model": decision_model,
        "runs": rows,
        "verified": sum(r["verified"] for r in rows), "total": len(rows),
        "agent_claimed_success": sum(r["agent_success"] for r in rows),
    }
    (out / f"{args.label}-results.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    from nanoagent.agent.effector.metrics import format_report
    first = [r for r in rows if r["visit"] == "first"]
    repeat = [r for r in rows if r["visit"] == "repeat"]
    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else None  # noqa: E731
    print()
    # Phase 6 gate: the run's own proof must never say "verified" where the independent
    # check failed — a false "verified" is worse than none.
    false_verified = [r["task"] for r in rows if r["proof"] == "verified" and not r["verified"]]
    by_proof = {k: sum(1 for r in rows if r["proof"] == k) for k in ("verified", "unknown", "refuted", None)}
    print(f"Proof: {by_proof}   false 'verified' (proof verified, check failed): {false_verified or 'none'}")
    print(f"Verified: {summary['verified']}/{summary['total']}   "
          f"agent claimed success: {summary['agent_claimed_success']}/{summary['total']}")
    print(f"Median seconds — first visit: {med([r['seconds'] for r in first])}   "
          f"repeat: {med([r['seconds'] for r in repeat])}")
    print()
    print(format_report(ws))

    # Close the warm browser before the loop does. Without this the pooled browser is
    # finalized by the garbage collector after asyncio.run() has already closed the
    # loop, and Playwright's subprocess transport raises "RuntimeError: Event loop is
    # closed" out of __del__ — noise at the end of a clean run, and a leaked driver.
    from nanoagent.agent.effector import browser_pool
    await browser_pool.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
