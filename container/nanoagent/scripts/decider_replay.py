"""Stage 61 phase 1 — replay recorded Effector decisions against a typed decider.

Reads the decision records phase 0 wrote (workspace/.effector/decisions/*.jsonl),
asks the decider the same question the LLM answered, and scores agreement. Offline:
no browser, no live page, nothing clicked. Runs anywhere `laya` is installed:

    python decider_replay.py --records /data/p0 /data/p0b --variant labelled --limit 40

Ground truth is the LLM's action on runs whose result was independently verified
(phase 0's harness checked every task). That makes "agreement" a floor-ish measure: the
LLM also wandered at times, so a disagreement is not always the decider's error.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

# The subset of Effector's actions a typed decider can choose. Everything else
# (navigate, browser_exec, extract, download, key) needs text or code and stays with
# the LLM — those turns are counted as "OTHER" and the decider is only asked to
# recognise that it should hand them over.
OPS = {
    "CLICK": "click an element on the page",
    "TYPE": "type text into an input field",
    "SELECT": "choose an option in a dropdown",
    "SCROLL": "scroll to reveal more of the page",
    "WAIT": "wait for the page to finish changing",
    "DONE": "the goal is already achieved; stop",
    "OTHER": "something else: go to a URL, run a script, extract data, download a file",
}
_OP_OF = {
    "click": "CLICK", "right_click": "CLICK", "double_click": "CLICK", "hover": "CLICK",
    "type": "TYPE", "select_combobox": "TYPE", "clear": "TYPE",
    "select": "SELECT", "scroll": "SCROLL", "wait": "WAIT", "done": "DONE",
}
_TARGET_OPS = {"CLICK", "TYPE", "SELECT"}
_CHUNK = 18  # Laya: keep choice questions under ~20 options

_EL_RE = re.compile(r"^\s*\[(@e\d+)\]\s*(.*?)\s*(?:\(center:[^)]*\))?\s*$")


def parse_elements(summary: str) -> list[tuple[str, str]]:
    out = []
    for line in (summary or "").splitlines():
        m = _EL_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2)[:120]))
    return out


def recent_actions(prompt: str) -> str:
    m = re.search(r"(?is)recent actions[^\n]*\n(.*?)(?:\n\s*\n|$)", prompt or "")
    return (m.group(1).strip() if m else "none yet")[:400]


def page_text(summary: str) -> str:
    idx = (summary or "").find("Page Content:")
    return summary[idx + 13: idx + 13 + 500].strip() if idx >= 0 else ""


def state_for(rec: dict) -> dict:
    return {
        "goal": rec["goal"][:400],
        "url": rec.get("url", "")[:150],
        "recent_actions": recent_actions(rec.get("prompt", "")),
        "page_text": page_text(rec.get("elements", "")),
    }


def criteria_for(chunk: list[tuple[str, str]], variant: str) -> dict[str, str]:
    if variant == "bare":
        return {ref: desc for ref, desc in chunk}
    # "labelled": the option name itself says what the element is.
    seen: dict[str, int] = {}
    out = {}
    for ref, desc in chunk:
        label = f"{ref} {desc}"[:70]
        seen[label] = seen.get(label, 0) + 1
        out[label if seen[label] == 1 else f"{label} #{seen[label]}"] = desc
    return out


def _ref_of(label: str) -> str:
    return label.split(" ", 1)[0]


def decide(agent, rec: dict, variant: str) -> dict:
    state = state_for(rec)
    elements = parse_elements(rec.get("elements", ""))
    t0 = time.time()
    op = agent.predict(state, {"op": {
        "type": "choice", "instructions": "What should the browser do next to make progress on the goal?",
        "criteria": OPS,
    }})["answers"]["op"]
    calls = 1
    target, target_conf = None, None
    if op["choice"] in _TARGET_OPS and elements:
        verb = {"CLICK": "clicked", "TYPE": "typed into", "SELECT": "selected from"}[op["choice"]]
        instr = f"Which element should be {verb} next to make progress on the goal?"
        pool = elements
        while True:
            winners = []
            for i in range(0, len(pool), _CHUNK):
                chunk = pool[i:i + _CHUNK]
                if len(chunk) == 1:
                    winners.append((chunk[0], 1.0))
                    continue
                crit = criteria_for(chunk, variant)
                ans = agent.predict(state, {"t": {"type": "choice", "instructions": instr, "criteria": crit}})["answers"]["t"]
                calls += 1
                ref = _ref_of(ans["choice"]) if variant == "labelled" else ans["choice"]
                winners.append((next(c for c in chunk if c[0] == ref), ans["probabilities"][ans["choice"]]))
            if len(winners) == 1:
                target, target_conf = winners[0][0][0], winners[0][1]
                break
            pool = [w[0] for w in winners]
    return {
        "op": op["choice"], "op_conf": op["probabilities"][op["choice"]],
        "target": target, "target_conf": target_conf,
        "seconds": time.time() - t0, "calls": calls, "n_elements": len(elements),
    }


def load_records(dirs: list[str]) -> list[dict]:
    recs = []
    for d in dirs:
        for f in sorted(Path(d).glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                r = json.loads(line)
                if r.get("type") == "decision" and r.get("action") and r.get("elements"):
                    recs.append(r)
    return recs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="+", required=True)
    ap.add_argument("--variant", choices=["bare", "labelled"], default="labelled")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    import laya
    agent = laya.load("convaiinnovations/laya")
    recs = load_records(args.records)
    if args.limit:
        recs = recs[:: max(1, len(recs) // args.limit)][: args.limit]
    print(f"{len(recs)} decisions, variant={args.variant}", flush=True)

    rows = []
    for i, r in enumerate(recs):
        truth_op = _OP_OF.get(r["action"]["action"], "OTHER")
        truth_target = r["action"].get("target") if truth_op in _TARGET_OPS else None
        d = decide(agent, r, args.variant)
        row = {
            "truth_op": truth_op, "truth_target": truth_target, **d,
            "op_ok": d["op"] == truth_op,
            "target_ok": (d["target"] == truth_target) if truth_target and str(truth_target).startswith("@e") else None,
        }
        rows.append(row)
        print(f"{i+1:>3} {truth_op:<6}->{d['op']:<6} {row['op_ok']!s:<5} "
              f"target {truth_target}->{d['target']} {row['target_ok']}  "
              f"conf {d['op_conf']:.2f}/{d['target_conf'] if d['target_conf'] is None else round(d['target_conf'], 2)} "
              f"{d['seconds']:.1f}s", flush=True)

    op_ok = [r["op_ok"] for r in rows]
    tgt = [r for r in rows if r["target_ok"] is not None]
    both = [r for r in tgt if r["op_ok"]]
    print()
    print(f"operation agreement: {sum(op_ok)}/{len(op_ok)} = {sum(op_ok)/max(1,len(op_ok)):.0%}")
    print(f"target agreement (LLM chose an element): {sum(r['target_ok'] for r in tgt)}/{len(tgt)}")
    print(f"target agreement when op also agreed: {sum(r['target_ok'] for r in both)}/{len(both)}")
    for bar in (0.5, 0.8, 0.9, 0.95):
        conf = [r for r in rows if r["op_conf"] >= bar]
        print(f"  op conf >= {bar}: coverage {len(conf)}/{len(rows)}, accuracy "
              f"{sum(r['op_ok'] for r in conf)}/{len(conf)}")
    secs = [r["seconds"] for r in rows]
    print(f"seconds per decision: median {statistics.median(secs):.2f}, max {max(secs):.2f}; "
          f"calls median {statistics.median([r['calls'] for r in rows])}")
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
