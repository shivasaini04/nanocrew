"""report_result — how a stage 57 worker hands back its answer.

Registered only in a worker (the orchestrator sends `reportSchema` in the payload). Its
`result` parameter IS the task's output schema, so the model fills a structure rather
than writing prose about one — and a mismatch is caught here, on the same turn, where
the worker can still fix it. The orchestrator checks it again (src/swarm/verify.ts);
this check is for the worker's benefit, not the platform's.

It writes result.json next to the worker's workspace, which the orchestrator reads when
the container exits. A worker that never calls it has failed its attempt.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


class ReportResultTool(Tool):
    """Hand back this task's result."""

    def __init__(self, out_path: Path, result_schema: Any = None):
        self._out = Path(out_path)
        self._schema = result_schema if isinstance(result_schema, dict) and result_schema else None

    @property
    def name(self) -> str:
        return "report_result"

    @property
    def description(self) -> str:
        return (
            "Hand back your task's answer. Call it ONCE, when you are done — or when you "
            "cannot finish, with what you have and what is missing in the summary. `result` "
            "must have the exact shape the task asks for. Then stop."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        if self._schema:
            result = dict(self._schema)
            result.setdefault("description", "Your answer, in the shape the task asks for.")
        else:
            result = {"description": "Your answer: any JSON value."}
        return {
            "type": "object",
            "properties": {
                "result": result,
                "summary": {"type": "string", "description": "Two or three sentences: what you found and how."},
                "evidence": {"type": "array", "items": {"type": "string"}, "description": "URLs or file paths the answer rests on."},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["result", "summary"],
        }

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        # Models often send an object argument as a JSON string. Decode it before the
        # type check rather than spend a turn on "result should be object".
        raw = params.get("result")
        if isinstance(raw, str) and self._schema and self._schema.get("type") in ("object", "array"):
            try:
                params["result"] = json.loads(raw)
            except ValueError:
                pass
        return super().validate_params(params)

    async def execute(self, result: Any, summary: str, evidence: list | None = None,
                      confidence: float | None = None, **_: Any) -> str:
        contract: dict[str, Any] = {"result": result, "summary": summary}
        if evidence:
            contract["evidence"] = [str(e) for e in evidence]
        if confidence is not None:
            contract["confidence"] = confidence
        try:
            self._out.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._out.with_suffix(".tmp")
            tmp.write_text(json.dumps(contract, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._out)
        except OSError as exc:
            return f"Could not save the result: {exc}"
        return "Result reported. You are done — stop now."
