"""Stage 61 phase 9 — our own decisions as a dataset, and a tiny model trained on them.

Phase 0 made every Effector decision a record (decision_log.py). This turns those records
into training examples and trains the smallest useful piece of the phase 9 plan — the
action policy: given the goal, the page's controls and what just happened, which KIND of
action comes next (click / type / done / …). No GPU, no framework: hashed bag-of-features
and a softmax classifier in numpy, which trains on a laptop CPU in seconds.

Honest by construction:

- runs are split whole, never shuffled per decision — two decisions from the same run
  share a goal and a page, and mixing them across the split would inflate every number;
- accuracy is reported against the majority-class baseline ("always guess click"), which
  is what a model has to beat to mean anything;
- selective accuracy (accuracy when confident, and how often it is confident) is the
  number that decides whether a small model can take real traffic, per the phase 9 plan.

    python decision_dataset.py export --records /data/p0 /data/p6 --out data.jsonl
    python decision_dataset.py train  --data data.jsonl --report report.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# The kinds of action the policy predicts. Everything rarer is folded into "other" —
# a class with three examples teaches nothing and flatters the accuracy.
ACTIONS = ["click", "type", "done", "browser_exec", "extract", "select_combobox", "scroll", "wait", "other"]
_FEATURE_BITS = 14  # 16k buckets — plenty for a few thousand examples
_N_FEATURES = 1 << _FEATURE_BITS


def load_examples(dirs: list[str]) -> list[dict[str, Any]]:
    """One example per recorded decision, with the outcome of the step that followed."""
    out: list[dict[str, Any]] = []
    for d in dirs:
        for f in sorted(Path(d).glob("*.jsonl")):
            records = []
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            outcomes = {r.get("turn"): r for r in records if r.get("type") == "outcome"}
            for r in records:
                if r.get("type") != "decision" or not r.get("action"):
                    continue
                action = str(r["action"].get("action") or "")
                if not action:
                    continue
                out.append({
                    "run_id": r.get("run_id", f.stem),
                    "turn": r.get("turn"),
                    "goal": r.get("goal", ""),
                    "url": r.get("url", ""),
                    "elements": r.get("elements", ""),
                    "prompt": r.get("prompt", ""),
                    "action": action if action in ACTIONS else "other",
                    "target": r["action"].get("target"),
                    "model": r.get("model"),
                    "decision_ms": r.get("decision_ms"),
                    "outcome": (outcomes.get(r.get("turn")) or {}).get("status"),
                })
    return out


_TOKEN = re.compile(r"[a-z0-9_]+")


def _bucket(text: str) -> int:
    return int(hashlib.blake2b(text.encode(), digest_size=4).hexdigest(), 16) % _N_FEATURES


def featurise(ex: dict[str, Any]) -> dict[int, float]:
    """Hashed features: goal words, the roles/names on the page, the recent-action tail,
    and a few counts. Deliberately crude — the question is what the SIGNAL is worth, not
    how good a feature engineer one can be."""
    feats: Counter[int] = Counter()
    for word in _TOKEN.findall((ex.get("goal") or "").lower())[:40]:
        feats[_bucket("g:" + word)] += 1.0
    elements = (ex.get("elements") or "")
    roles = re.findall(r"\[@e\d+\]\s*(\w+)", elements)
    for role in roles[:60]:
        feats[_bucket("r:" + role.lower())] += 1.0
    for word in _TOKEN.findall(elements.lower())[:120]:
        feats[_bucket("e:" + word)] += 0.5
    prompt = (ex.get("prompt") or "")
    tail = prompt[-600:].lower()
    for word in _TOKEN.findall(tail)[:60]:
        feats[_bucket("h:" + word)] += 0.5
    feats[_bucket("n_elements")] = min(len(roles), 60) / 10.0
    feats[_bucket("turn")] = min(int(ex.get("turn") or 1), 20) / 5.0
    feats[_bucket("bias")] = 1.0
    if "no interactive elements" in elements.lower() or not roles:
        feats[_bucket("empty_page")] = 1.0
    if "-> failed" in tail:
        feats[_bucket("last_failed")] = 1.0
    if "success" in tail:
        feats[_bucket("last_ok")] = 1.0
    return dict(feats)


def _split_by_run(examples: list[dict[str, Any]], holdout: float, seed: int) -> tuple[list, list]:
    runs = sorted({e["run_id"] for e in examples})
    random.Random(seed).shuffle(runs)
    n_test = max(1, int(len(runs) * holdout))
    test_runs = set(runs[:n_test])
    return ([e for e in examples if e["run_id"] not in test_runs],
            [e for e in examples if e["run_id"] in test_runs])


def train_softmax(train: list[dict], classes: list[str], epochs: int, lr: float, l2: float, seed: int):
    import numpy as np

    rng = np.random.default_rng(seed)
    W = np.zeros((_N_FEATURES, len(classes)), dtype=np.float32)
    idx = {c: i for i, c in enumerate(classes)}
    order = list(range(len(train)))
    for epoch in range(epochs):
        rng.shuffle(order)
        for i in order:
            ex = train[i]
            feats = ex["_f"]
            keys = np.fromiter(feats.keys(), dtype=np.int64)
            vals = np.fromiter(feats.values(), dtype=np.float32)
            scores = (W[keys] * vals[:, None]).sum(axis=0)
            scores -= scores.max()
            p = np.exp(scores)
            p /= p.sum()
            p[idx[ex["action"]]] -= 1.0
            W[keys] -= lr * (vals[:, None] * p[None, :] + l2 * W[keys])
    return W


def predict(W, feats: dict[int, float]):
    import numpy as np

    keys = np.fromiter(feats.keys(), dtype=np.int64)
    vals = np.fromiter(feats.values(), dtype=np.float32)
    scores = (W[keys] * vals[:, None]).sum(axis=0)
    scores -= scores.max()
    p = np.exp(scores)
    return p / p.sum()


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--records", nargs="+", required=True)
    e.add_argument("--out", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", required=True)
    t.add_argument("--report", default="")
    t.add_argument("--epochs", type=int, default=25)
    t.add_argument("--lr", type=float, default=0.15)
    t.add_argument("--l2", type=float, default=1e-5)
    t.add_argument("--holdout", type=float, default=0.3)
    t.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if args.cmd == "export":
        examples = load_examples(args.records)
        Path(args.out).write_text(
            "\n".join(json.dumps(x, ensure_ascii=False) for x in examples), encoding="utf-8")
        counts = Counter(x["action"] for x in examples)
        print(f"{len(examples)} decisions from {len({x['run_id'] for x in examples})} runs -> {args.out}")
        print("actions:", dict(counts.most_common()))
        return 0

    examples = [json.loads(l) for l in Path(args.data).read_text(encoding="utf-8").splitlines() if l.strip()]
    for ex in examples:
        ex["_f"] = featurise(ex)
    train, test = _split_by_run(examples, args.holdout, args.seed)
    classes = [c for c in ACTIONS if any(x["action"] == c for x in train)]
    if not test or not train:
        print("not enough runs to split")
        return 1

    W = train_softmax(train, classes, args.epochs, args.lr, args.l2, args.seed)

    majority = Counter(x["action"] for x in train).most_common(1)[0][0]
    base_hits = sum(1 for x in test if x["action"] == majority)
    hits, confident, conf_hits = 0, 0, 0
    per_class: Counter[str] = Counter()
    per_class_hits: Counter[str] = Counter()
    for x in test:
        p = predict(W, x["_f"])
        k = int(p.argmax())
        ok = classes[k] == x["action"]
        hits += ok
        per_class[x["action"]] += 1
        per_class_hits[x["action"]] += ok
        if float(p[k]) >= 0.9:
            confident += 1
            conf_hits += ok
    report = {
        "train_examples": len(train), "test_examples": len(test),
        "train_runs": len({x["run_id"] for x in train}), "test_runs": len({x["run_id"] for x in test}),
        "classes": classes,
        "majority_class": majority,
        "baseline_accuracy": round(base_hits / len(test), 3),
        "accuracy": round(hits / len(test), 3),
        "confident_coverage": round(confident / len(test), 3),
        "accuracy_when_confident": round(conf_hits / confident, 3) if confident else None,
        "per_class": {c: f"{per_class_hits[c]}/{per_class[c]}" for c in sorted(per_class)},
    }
    print(json.dumps(report, indent=1))
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
