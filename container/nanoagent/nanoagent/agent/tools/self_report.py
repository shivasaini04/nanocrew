"""self_report — what this agent has actually done, read from the orchestrator.

Separate from ``self_manage`` on purpose. That tool is the control plane: it changes
which model you run, how much you may spend, and whether you run at all, and its ``get``
action answers "when do I run next" — forward-looking config, no history whatsoever.
This one is read-only and points backwards.

The gap it closes: nothing else gives an agent access to its own past. The identity
block injected at cycle start carries name, id and role. The container mounts only its
own workspace, so ``sql_query`` cannot reach ``agent_cycles``. Asked to summarise its own
work, Finder counted the ``sweep-results-*.json`` files in its workspace — 210 — and
reported that as its cycle count, because that was the only observable it had. The real
number was 378. It was not guessing carelessly; it had nothing else to count.

The orchestrator renders the report text; this tool is a thin client. Wording lives on
the side that redeploys with a normal compose deploy — ``container/`` changes need
``bash build.sh``, which a standard deploy skips.
"""

from __future__ import annotations

import json
import os
from urllib.parse import quote
from typing import Any

from nanoagent.agent.tools.base import Tool


class SelfReportTool(Tool):
    """Read this agent's own history, output and health from the orchestrator."""

    @property
    def name(self) -> str:
        return "self_report"

    @property
    def description(self) -> str:
        return (
            "Facts about YOURSELF that you cannot get any other way: how many cycles you "
            "have run and of what type, how often they failed, what you have spent, how "
            "many items you are tracking and at which stage, handoffs, pending check-ins, "
            "and how long you have existed.\n"
            "ALWAYS call this before answering any question about your own history, "
            "output or performance — 'how many cycles have you run', 'what have you done "
            "so far', 'summarise your work', 'how much have you spent', 'how are you "
            "doing'. Counting files in your workspace is NOT the same thing and will be "
            "wrong: workspace files are one artefact of your work, not a record of it.\n"
            "It also runs reality checks you cannot run yourself — whether your schedule "
            "is actually firing, whether your tracked file and the database still agree, "
            "and whether anything is blocked waiting on a human. Read those before "
            "concluding your pipeline is healthy.\n"
            "Quote the numbers it returns verbatim. Do not recompute or round them, and "
            "do not state a figure it did not print.\n"
            "Pass `agent` with a teammate's name to read THEIR report instead of yours — "
            "use it when your work depends on what another agent has actually done, rather "
            "than guessing or assuming. The figures then describe them, not you.\n"
            "With `agent` you can also `action='wake'` to make them run ONE cycle now (use "
            "it when you have handed them something that needs picking up) or "
            "`action='pause'` to stop a teammate you can see looping or burning budget. "
            "Both need a `reason`. You cannot start a paused teammate again and you cannot "
            "reconfigure one — those are your owner's, deliberately."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "description": (
                        "Optional. A teammate's name (or id) to read their report instead of "
                        "your own. Only agents belonging to the same owner are visible."
                    ),
                },
                "action": {
                    "type": "string",
                    "enum": ["read", "wake", "pause"],
                    "description": (
                        "With `agent`. 'read' (default) fetches their report. 'wake' runs ONE "
                        "cycle for them now — use it when you have handed them something and "
                        "need it picked up. 'pause' stops their scheduled cycles when you can "
                        "see they are looping or burning budget; you CANNOT start them again, "
                        "only your owner can. You can never reconfigure a teammate."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": (
                        "Required for wake and pause. One sentence on why — it is what tells "
                        "your owner why one of their agents acted on another."
                    ),
                },
                "instruction": {
                    "type": "string",
                    "description": "For action=wake. What the teammate should do when it runs.",
                },
            },
            "required": [],
        }

    async def execute(self, agent: str = "", action: str = "read", **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return "self_report unavailable: httpx is not installed."

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return "self_report needs NanoCrew context: AGENT_ID is not set."
        if not token:
            return (
                "self_report needs a per-cycle token, which only a NanoCrew cycle on a "
                "current orchestrator build provides. Outside one, you cannot read your "
                "own history — say so rather than substituting a workspace file count."
            )

        target = str(agent or "").strip()
        act = str(action or "read").strip().lower()
        if act not in ("read", "wake", "pause"):
            return f"action must be read, wake or pause — got {act!r}."
        if act != "read" and not target:
            return f"action={act} needs `agent` — the teammate to act on."

        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with httpx.AsyncClient() as client:
                if act == "read":
                    url = (
                        f"{host}/api/agents/{agent_id}/self/crew/{quote(target, safe='')}/report"
                        if target else
                        f"{host}/api/agents/{agent_id}/self/report"
                    )
                    resp = await client.get(url, headers=headers, timeout=20)
                else:
                    resp = await client.post(
                        f"{host}/api/agents/{agent_id}/self/crew/{quote(target, safe='')}/{act}",
                        json={k: v for k, v in (
                            ("reason", kwargs.get("reason")),
                            ("instruction", kwargs.get("instruction")),
                        ) if v is not None},
                        headers=headers, timeout=20,
                    )
        except Exception as exc:
            return f"Could not reach the orchestrator for your self-report: {exc}"

        if resp.status_code >= 400:
            try:
                detail = resp.json().get("error", resp.text[:300])
            except Exception:
                detail = resp.text[:300]
            return f"self_report failed (HTTP {resp.status_code}): {detail}"

        try:
            body = json.loads(resp.text)
        except Exception:
            return f"self_report returned an unreadable body: {resp.text[:300]}"

        # wake/pause answer with an outcome, not a report.
        if act != "read":
            return json.dumps(body)

        # The rendered text is the product. `data` carries the same figures structured,
        # and is deliberately not returned: handing the model raw fields to interpret is
        # how a null-count once got reported as a filled-count.
        return body["report"]
