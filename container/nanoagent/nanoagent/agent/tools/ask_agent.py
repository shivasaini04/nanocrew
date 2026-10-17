"""ask_agent — ask a teammate a question and wait here for the answer.

Stage 56 phase 5, and the last piece of what this stage set out to do: *"that agent can
call it, wait for the response, and once confirmed continue its job."*

`borrow_tool` covers that when what you need is a TOOL — you take it and the result is in
your hands this turn. This is for the other half, where what you need is a colleague's
JUDGEMENT: what did you make of these leads, is this worth chasing, did you already try it.

The waiting happens inside ONE call, server-side. That is deliberate and it is the whole
safety property: the obvious design is to let the model poll — send, sleep, check, repeat —
and every one of those polls is a model turn. Mailer has already demonstrated what this
system does with a loop it cannot exit: 174 malformed retries in eight days, 90 in a single
day. Here there is no loop. One call returns either the answer or "not yet", and "not yet"
explicitly tells you not to ask again, because the question still stands and the answer
will reach you later whatever happens.

Use it sparingly. Waking a teammate costs a container and a model call on their side, and
one waiting agent is fine while two waiting on each other is a deadlock — which is why the
orchestrator refuses to wait on an agent that is already running.
"""

from __future__ import annotations

import json
import os
from typing import Any

from nanoagent.agent.tools.base import Tool


class AskAgentTool(Tool):
    """Ask a teammate a question and block until they answer, or until you give up."""

    @property
    def name(self) -> str:
        return "ask_agent"

    @property
    def description(self) -> str:
        return (
            "Ask a teammate a question and WAIT for their answer before you carry on. Use "
            "it when you genuinely cannot continue without their judgement — what they made "
            "of something, whether they have already tried it, what happened to work you "
            "gave them.\n"
            "Prefer the cheaper options first:\n"
            "  - need a TOOL they have? use `borrow_tool` — no waiting, no second agent runs\n"
            "  - can you carry on without the answer? use `handoff_to` — they reply on their "
            "next cycle and you are shown it on yours\n"
            "  - don't know who to ask? use `find_agent` first\n"
            "This wakes them for one cycle and holds your own cycle open, so it costs both "
            "of you. If they do not answer in time you get told so — the "
            "question still stands and their answer will reach you later, so do NOT ask "
            "again; carry on with whatever you can do without it."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "description": "Teammate's name, exactly as shown in your crew roster.",
                },
                "question": {
                    "type": "string",
                    "description": "What you need to know. Be specific — they answer from this alone, without your context.",
                },
                "wait_seconds": {
                    "type": "number",
                    "description": "How long to hold your cycle open waiting. Default 60, capped by the orchestrator. Longer is not better: you are paying for both cycles.",
                },
                "deadline_hours": {
                    "type": "number",
                    "description": "How long the question stays open after you stop waiting. Default 24. When it lapses you are told, rather than waiting forever.",
                },
            },
            "required": ["agent", "question"],
        }

    async def execute(
        self,
        agent: str = "",
        question: str = "",
        wait_seconds: float = 60,
        deadline_hours: float = 0,
        **kwargs: Any,
    ) -> str:
        try:
            import httpx
        except ImportError:
            return "ask_agent unavailable: httpx is not installed."

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return "ask_agent needs NanoCrew context: AGENT_ID is not set."
        if not token:
            return (
                "ask_agent needs a per-cycle token, which only a NanoCrew cycle provides. "
                "Outside one you cannot reach a teammate — say so rather than inventing their answer."
            )

        who = str(agent or "").strip()
        ask = str(question or "").strip()
        if not who:
            return "Name the teammate to ask. Use find_agent if you are not sure who holds what."
        if not ask:
            return "Say what you want to know — they answer from the question alone, without your context."

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{host}/api/agents/{agent_id}/self/ask",
                    json={
                        "to": who,
                        "question": ask,
                        # Not `wait_seconds or 60`: an explicit 0 means do not wait,
                        # and `0 or 60` would quietly turn that into a full minute.
                        "waitSeconds": wait_seconds if wait_seconds is not None else 60,
                        "deadlineHours": deadline_hours or None,
                    },
                    headers={"Authorization": f"Bearer {token}"},
                    # Generous relative to the server's own cap: the server is the thing
                    # enforcing the wait, and a client that gives up first would leave the
                    # model believing nobody was asked when a cycle is running for it.
                    timeout=max(float(wait_seconds if wait_seconds is not None else 60) + 60, 120),
                )
        except Exception as exc:
            return (
                f"Could not complete the wait ({exc}). The question may still have been sent — "
                f"check your Messages block next cycle before asking again."
            )

        if resp.status_code >= 400:
            # Every refusal here names the cheaper thing to do instead. Passing it through
            # whole is what keeps a refusal from becoming a retry.
            try:
                body = resp.json()
                detail = body.get("error", resp.text[:400])
                if body.get("yourCrew"):
                    detail += f"\nYour crew: {', '.join(body['yourCrew'])}"
                return f"ask_agent refused (HTTP {resp.status_code}): {detail}"
            except Exception:
                return f"ask_agent refused (HTTP {resp.status_code}): {resp.text[:400]}"

        try:
            return json.dumps(resp.json(), indent=2)
        except Exception:
            return resp.text[:1500]
