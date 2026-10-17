"""Stage 61 phase 1 — replay recorded Effector decisions against other (faster) LLMs.

Each phase 0 decision record keeps the exact user prompt the decision model saw. This
sends that same prompt, with Effector's own system prompt, to a candidate model and
compares its action and target with what production chose on independently verified
runs. Offline: no browser, nothing clicked.

Run inside the agent image (litellm + nanoagent available):

    python llm_decider_replay.py --records /data/p0 /data/p0b /data/p0c \\
        --models gemini/gemini-3.6-flash openrouter/inception/mercury-2.5 --limit 60

Replaying production's own model gives the self-agreement ceiling: a model at
temperature 0.1 does not always repeat itself, so no candidate should be expected to
agree more often than that.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path


def load_records(dirs: list[str]) -> list[dict]:
    recs = []
    for d in dirs:
        for f in sorted(Path(d).glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                r = json.loads(line)
                if r.get("type") == "decision" and r.get("action") and r.get("prompt"):
                    recs.append(r)
    return recs


def _key_for(model: str) -> str:
    prefix = model.split("/")[0]
    return {"openrouter": "OPENROUTER_API_KEY", "gemini": "GEMINI_API_KEY",
            "groq": "GROQ_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}.get(prefix, "")


async def ask(provider, model: str, system: str, prompt: str) -> tuple[dict | None, float, dict]:
    from nanoagent.agent.effector.react_loop import _parse_action_json
    from nanoagent.providers.litellm_provider import reasoning_effort_var

    token = reasoning_effort_var.set("low")
    t0 = time.monotonic()
    try:
        resp = await provider.chat(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            model=model, max_tokens=400, temperature=0.1,
        )
        elapsed = time.monotonic() - t0
        try:
            return _parse_action_json(resp.content or ""), elapsed, resp.usage or {}
        except Exception:  # noqa: BLE001
            return None, elapsed, resp.usage or {}
    finally:
        reasoning_effort_var.reset(token)


def same_target(a: dict, b: dict) -> bool | None:
    ta, tb = a.get("target"), b.get("target")
    if not ta or not str(ta).startswith("@e"):
        return None
    return str(ta).strip() == str(tb or "").strip()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="+", required=True)
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from nanoagent.agent.effector.react_loop import _SYSTEM_PROMPT
    from nanoagent.providers.litellm_provider import LiteLLMProvider

    recs = load_records(args.records)
    if args.limit and len(recs) > args.limit:
        recs = recs[:: max(1, len(recs) // args.limit)][: args.limit]
    print(f"{len(recs)} recorded decisions", flush=True)

    report = {}
    for model in args.models:
        provider = LiteLLMProvider(api_key=os.environ.get(_key_for(model), ""), default_model=model)
        rows = []
        for r in recs:
            truth = r["action"]
            got, secs, usage = await ask(provider, model, _SYSTEM_PROMPT, r["prompt"])
            rows.append({
                "truth": truth.get("action"), "got": (got or {}).get("action"),
                "parsed": got is not None, "secs": secs,
                "action_ok": bool(got) and got.get("action") == truth.get("action"),
                "target_ok": same_target(truth, got or {}),
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
            })
        n = len(rows)
        tgt = [x for x in rows if x["target_ok"] is not None]
        both = sum(1 for x in rows if x["action_ok"] and x["target_ok"] is not False)
        secs = [x["secs"] for x in rows]
        summary = {
            "n": n,
            "parse_ok": sum(x["parsed"] for x in rows),
            "action_agree": sum(x["action_ok"] for x in rows),
            "target_agree": f"{sum(x['target_ok'] for x in tgt)}/{len(tgt)}",
            "action_and_target_agree": both,
            "p50_s": round(statistics.median(secs), 2),
            "p95_s": round(sorted(secs)[int(0.95 * (n - 1))], 2),
            "prompt_tokens": sum(x["prompt_tokens"] for x in rows),
            "completion_tokens": sum(x["completion_tokens"] for x in rows),
        }
        report[model] = {"summary": summary, "rows": rows}
        print(f"{model:<42} agree(action) {summary['action_agree']}/{n}  "
              f"agree(action+target) {both}/{n}  target {summary['target_agree']}  "
              f"parse {summary['parse_ok']}/{n}  p50 {summary['p50_s']}s  p95 {summary['p95_s']}s  "
              f"tokens {summary['prompt_tokens']}/{summary['completion_tokens']}", flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
