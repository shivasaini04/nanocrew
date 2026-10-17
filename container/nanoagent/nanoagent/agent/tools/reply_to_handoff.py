"""reply_to_handoff — answer a message another agent sent you.

Stage 56 phase 1. Until this existed, `agent_handoffs` carried work in one direction and
had nowhere to put an answer, so there were no answers. Finder handed Mailer 84 leads and
never learned what became of one of them; asked later to summarise its own results, it
filled the gap by inventing an email address.

The agents noticed the missing channel before we did. Crawler and Finder took to
embedding an `ack_received` field in the payload of the NEXT message going the other way,
acknowledging the PREVIOUS one — a half-duplex protocol invented out of a free-text blob,
because it was the only field they had. This tool is the real channel that replaces it.

The two verbs that matter are the ones the system never had:

  cannot   "I would, but I do not have verify_email." Worth more than a successful
           handoff: it tells the sender where to route instead and tells the owner what
           to build. It is also the message a human collaborator most often fails to
           send — we say we will get to it.

  refuse   "I will not, and here is why." The reason is mandatory. A bare rejection on a
           check-in was once LLM-summarised into invented instructions and written to
           IDENTITY.md at relevance 0.9; a refusal with no reason gets one imagined for it.

The orchestrator owns the wording of the errors and the reply record. This is a thin
client — `container/` changes need `bash build.sh`, which a standard deploy skips.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import quote

from nanoagent.agent.tools.base import Tool

REPLY_VERBS = ("agree", "refuse", "cannot", "result", "failure")


class ReplyToHandoffTool(Tool):
    """Answer a message another agent sent you — with a result, a refusal, or a gap."""

    @property
    def name(self) -> str:
        return "reply_to_handoff"

    @property
    def description(self) -> str:
        return (
            "Answer a message another agent handed you. The sender CANNOT see what you did "
            "unless you reply — doing the work and saying nothing leaves them believing "
            "nothing happened, and they will hand you the same work again.\n"
            "Use `action='list'` first if you do not have the message id in front of you; "
            "it also shows which of your own requests are still unanswered.\n"
            "Pick the verb that is true:\n"
            "  result  — here is the answer / here is what I did. Put it in `result`.\n"
            "  agree   — I will do it, not done yet. Reply again with `result` when it is.\n"
            "  cannot  — I would, but I lack a tool, access or skill. Name exactly what is "
            "missing in `reason`. This is a GOOD answer, not a failure: it tells the sender "
            "to route elsewhere and tells your owner what to give you. Never stay silent "
            "because you could not do something.\n"
            "  refuse  — I will not, and `reason` says why.\n"
            "  failure — I tried and it broke; put the error in `reason`.\n"
            "One call per message. Answer every message addressed to you before your cycle "
            "ends, even if the answer is that you did nothing."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", *REPLY_VERBS, "reply"],
                    "description": "What you are doing: the answer verb (result / agree / cannot / refuse / failure), or 'list' to see the messages you owe an answer on with their ids.",
                },
                "handoff_id": {
                    "type": "string",
                    "description": "The id of the message you are answering, exactly as shown in your Messages block or by action='list'.",
                },
                "performative": {
                    "type": "string",
                    "enum": list(REPLY_VERBS),
                    "description": "The answer verb, if you did not already put it in `action`. Same values; either field works.",
                },
                "result": {
                    "type": "string",
                    "description": "The answer itself, in your own words — what you did, what you found, or what you are going to do. The sender reads this verbatim, so give numbers rather than adjectives.",
                },
                "reason": {
                    "type": "string",
                    "description": "Required for cannot/refuse/failure. For 'cannot', name the exact tool, credential or access you are missing — that name is the useful part.",
                },
            },
            "required": [],
        }

    async def execute(
        self,
        action: str = "reply",
        handoff_id: str = "",
        performative: str = "",
        result: str = "",
        reason: str = "",
        **kwargs: Any,
    ) -> str:
        try:
            import httpx
        except ImportError:
            return "reply_to_handoff unavailable: httpx is not installed."

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        token    = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

        if not agent_id:
            return "reply_to_handoff needs NanoCrew context: AGENT_ID is not set."
        if not token:
            return (
                "reply_to_handoff needs a per-cycle token, which only a NanoCrew cycle on a "
                "current orchestrator build provides. Outside one you cannot answer a "
                "teammate — say so rather than assuming the reply was sent."
            )

        # `action` and `performative` are one question asked twice, so accept the answer in
        # either. Measured 2026-09-09, Mailer's first live cycle on this tool: it wrote
        # `action="result"` ten times — the natural reading, since `action` is the field
        # that asks what you are doing — got ten schema errors, then retried all ten with
        # `action="reply", performative="result"`. Twenty calls for ten messages, about
        # half the cycle, and the model was not wrong; the schema was. Two enums that both
        # answer "what am I doing" is a trap, and a tool that reads the caller's intent
        # only when it lands in the field the author happened to pick is a tool that
        # produces retry storms. The old shape still works — Mailer has now learned it.
        act = str(action or "").strip().lower()
        verb = str(performative or "").strip().lower()
        if act in REPLY_VERBS:
            # A verb in `action` always means "reply with this". An explicit `performative`
            # wins if both are set, so the more specific field is never silently ignored.
            if not verb:
                verb = act
            act = "reply"
        if not act:
            act = "reply"
        if act not in ("reply", "list"):
            return (
                f"action must be 'list' or one of the answer verbs "
                f"({', '.join(REPLY_VERBS)}) — got {act!r}."
            )

        headers = {"Authorization": f"Bearer {token}"}

        try:
            async with httpx.AsyncClient() as client:
                if act == "list":
                    resp = await client.get(
                        f"{host}/api/agents/{agent_id}/self/handoffs", headers=headers, timeout=20,
                    )
                else:
                    hid = str(handoff_id or "").strip()
                    if not hid:
                        return (
                            "handoff_id is required to reply. Call action='list' to see the "
                            "messages you owe an answer on and their ids."
                        )
                    if verb not in REPLY_VERBS:
                        return (
                            f"Name the answer verb — one of: {', '.join(REPLY_VERBS)}. "
                            f"Put it in `action` (e.g. action='result') or in `performative`; "
                            f"either works. Got action={action!r}, performative={performative!r}."
                        )
                    resp = await client.post(
                        f"{host}/api/agents/{agent_id}/self/handoffs/{quote(hid, safe='')}/reply",
                        json={"performative": verb, "result": result, "reason": reason or None},
                        headers=headers, timeout=20,
                    )
        except Exception as exc:
            return f"Could not reach the orchestrator to answer that message: {exc}"

        if resp.status_code >= 400:
            # The orchestrator's errors are written for the model — they say what is
            # missing and why it matters. Pass them through rather than flattening them
            # into "that failed", which is what sends a model round a retry loop.
            try:
                body = resp.json()
                detail = body.get("error", resp.text[:400])
                extra = body.get("meaning")
                if extra:
                    detail = f"{detail}\n{json.dumps(extra, indent=2)}"
            except Exception:
                detail = resp.text[:400]
            return f"reply_to_handoff failed (HTTP {resp.status_code}): {detail}"

        try:
            return json.dumps(resp.json(), indent=2)
        except Exception:
            return resp.text[:1000]
