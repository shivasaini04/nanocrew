"""Stage 61 phase 1 (redo) — replay recorded Effector decisions against real Jev.

Same records, same sampling and same scoring as the LLM replay (llm_decider_replay.py),
so the numbers sit in one table: how often Jev picks the operation production picked on
a run that was independently verified, how often it picks the same element, how fast, and
what it costs.

Jev answers through OpenRouter's Decisions API (`~typesafe/jev-latest`), which is a
different surface from the chat models — it is NOT in /api/v1/models, which is how it was
missed the first time.

    python jev_replay.py --records /data/p0 /data/p6 --limit 60 --out jev.json
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

from nanoagent.agent.effector.jev_policy import decide_sync

# Production's action -> the operation Jev is allowed to choose. Anything Jev cannot do
# (a script, an extract schema, a download) is "other": Jev handing the turn to the LLM.
_OP_OF = {
    "click": "click", "right_click": "click", "double_click": "click", "hover": "click",
    "type": "type", "clear": "type", "select_combobox": "select_combobox",
    "scroll": "scroll", "wait": "wait", "done": "done",
}
_TARGET_OPS = {"click", "type", "select_combobox"}


def load(dirs: list[str]) -> list[dict]:
    out = []
    for d in dirs:
        for f in sorted(Path(d).glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("type") == "decision" and r.get("action") and r.get("elements"):
                    out.append(r)
    return out


def recent_actions(prompt: str) -> str:
    m = re.search(r"(?is)recent actions[^\n]*\n(.*?)(?:\n\s*\n|$)", prompt or "")
    return (m.group(1).strip() if m else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="+", required=True)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    records = load(args.records)
    if args.limit and len(records) > args.limit:
        records = records[:: max(1, len(records) // args.limit)][: args.limit]
    print(f"{len(records)} recorded decisions", flush=True)

    rows = []
    for i, r in enumerate(records, start=1):
        truth_action = str((r["action"] or {}).get("action") or "")
        truth_op = _OP_OF.get(truth_action, "other")
        truth_target = (r["action"] or {}).get("target") if truth_op in _TARGET_OPS else None
        d = decide_sync(r.get("goal", ""), r.get("elements", ""), recent_actions(r.get("prompt", "")), r.get("url", ""))
        target_ok = None
        if truth_target and str(truth_target).startswith("@e"):
            target_ok = (d.target == truth_target)
        rows.append({
            "truth": truth_op, "got": d.action, "op_ok": d.action == truth_op,
            "target_truth": truth_target, "target_got": d.target, "target_ok": target_ok,
            "op_conf": d.action_confidence, "target_conf": d.target_confidence,
            "seconds": d.seconds, "cost": d.cost, "error": d.error,
        })
        print(f"{i:>3} {truth_op:<16}->{str(d.action):<16} {str(d.action == truth_op):<5} "
              f"target {truth_target}->{d.target} {target_ok}  conf {d.action_confidence:.2f}  "
              f"{d.seconds:.2f}s" + (f"  ERR {d.error}" if d.error else ""), flush=True)

    n = len(rows)
    ok = [r for r in rows if not r["error"]]
    tgt = [r for r in rows if r["target_ok"] is not None]
    secs = [r["seconds"] for r in ok]
    summary = {
        "n": n, "errors": n - len(ok),
        "operation_agreement": f"{sum(r['op_ok'] for r in rows)}/{n}",
        "target_agreement": f"{sum(bool(r['target_ok']) for r in tgt)}/{len(tgt)}",
        "both_agree": sum(1 for r in rows if r["op_ok"] and r["target_ok"] is not False),
        "p50_s": round(statistics.median(secs), 2) if secs else None,
        "p95_s": round(sorted(secs)[int(0.95 * (len(secs) - 1))], 2) if secs else None,
        "total_cost_usd": round(sum(r["cost"] for r in rows), 6),
        "confusions": Counter(f"{r['truth']}->{r['got']}" for r in rows if not r["op_ok"]).most_common(8),
    }
    for bar in (0.5, 0.8, 0.9):
        conf = [r for r in rows if r["op_conf"] >= bar]
        summary[f"conf>={bar}"] = f"coverage {len(conf)}/{n}, accuracy {sum(r['op_ok'] for r in conf)}/{len(conf)}"
    print()
    print(json.dumps(summary, indent=1))
    if args.out:
        Path(args.out).write_text(json.dumps({"summary": summary, "rows": rows}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
