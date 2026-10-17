"""clarify — ask the human a structured question mid-task, instead of guessing.

Stage 42 #12, the idea taken from Hermes Agent's ``tools/clarify_tool.py``
(NousResearch/hermes-agent @ a7cd15e): a schema for structured questions, with the
rendering left to whatever surface the human is on.

The gap it fills: ``request_approval`` gates an *action* — here is a draft, may I
send it. There was no way to ask a *question*. So an agent that hit a genuine fork
in the road had two bad options: guess, or stop and report. Both waste the cycle.

Transport reuses the check-in rail rather than inventing one. A clarify question is
a check-in with no attached action, so it lands in the same Check-in Inbox the human
already watches, and their answer comes back conversationally on the next turn
(``processFeedback``) exactly like any other check-in reply. Nothing in the
orchestrator needed changing for this.

The options are rendered as a numbered list — the human replies with a number or
with their own answer. That is deliberately low-effort to answer: a specific
question with three concrete choices takes a moment to settle, where a paragraph
asking for a decision tends to sit unanswered.

Stage 49 phase 3 — it now WAITS for the answer instead of ending the cycle.

The original returned as soon as the question was queued, and the answer arrived on a
later cycle through ``processFeedback``. That made asking cost the agent its entire
run: the browser closed, a half-filled form was lost, and whatever it had in progress
was gone. Guessing cost nothing. Any agent facing that trade will guess — and one did,
inventing a contact email on 2026-09-02 (prod cycle ``e1c1aecc``) rather than asking
which address to use. The bug was the incentive, not the model.

So this blocks on the answer the same way ``request_approval`` already blocks on an
approval, and hands the reply back as the tool result. The run continues in the same
cycle with the browser still open — which is what a person does when they message
their manager and carry on once they hear back.

The wait is bounded well inside ``CONTAINER_TIMEOUT`` (30 min), because a cycle killed
mid-question loses the work the waiting was meant to protect.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import httpx
from loguru import logger

from nanoagent.agent.tools.base import Tool

MAX_OPTIONS = 6

# Returned by a wait the person ended with Stop, instead of an answer.
STOPPED = object()


async def stop_requested(host: str, agent_id: str) -> bool:
    """Has the owner pressed Stop on this agent? Checked on every poll of a wait.

    Stage 60 live test: Stop is only read between tool calls, and a question can hold a
    run for 10 minutes, so pressing Stop on a waiting run did nothing it could see.
    Network trouble reads as "not stopped" — a blip must never end a run.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"{host}/api/agents/{agent_id}/interrupt-flag")
        return bool(res.is_success and res.json().get("interrupted"))
    except Exception:  # noqa: BLE001
        return False

# How long to hold the run open waiting for an answer, and how often to look.
#
# Deliberately well under CONTAINER_TIMEOUT (30 min, config.ts): the cycle is killed at
# that mark, so a wait anywhere near it would lose exactly the in-progress work that
# waiting exists to protect. Ten minutes is long enough for someone at their desk and
# short enough to leave the rest of the cycle room to finish the job afterwards.
CLARIFY_TIMEOUT_S = int(os.environ.get("CLARIFY_TIMEOUT_S", 600))
_POLL_INTERVAL_S = 3


class ClarifyTool(Tool):
    """Ask the human a specific question, with options, and stop."""

    @property
    def name(self) -> str:
        return "clarify"

    @property
    def description(self) -> str:
        return (
            "Ask your manager a specific question when you hit a real fork in the road "
            "and picking wrong would waste the work — which of several leads to prioritise, "
            "which of two interpretations of an instruction is meant, which draft to run with. "
            "Give concrete options; they appear as buttons in the chat, and in the Check-in "
            "Inbox. "
            "This WAITS for the answer and hands it straight back to you, so you keep "
            "everything you have open — the browser, the page you are on, a half-filled "
            "form — and carry on with the reply. Use this INSTEAD of inventing a value "
            "you were not given: a name, an email address, a reference number. Never make "
            "one of those up. Do NOT use it for something you could look up, test, or "
            "reasonably decide yourself — a question you could have answered is a wasted "
            "round trip for both of you. If nobody answers in time you are told so, and "
            "can finish what is safe to finish and report the rest."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": (
                        "The question, in one sentence. Be specific about what you will do "
                        "with each answer."
                    ),
                },
                "options": {
                    "type": "array",
                    "description": (
                        f"Between 2 and {MAX_OPTIONS} concrete choices. Each is "
                        "{label, detail} — label is short, detail says what happens if it "
                        "is chosen. Omit entirely for an open question."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "detail": {"type": "string"},
                        },
                        "required": ["label"],
                    },
                },
                "context": {
                    "type": "string",
                    "description": (
                        "What you already did and why you are stuck, so the answer can be "
                        "given without re-reading the whole cycle."
                    ),
                },
                "multi_select": {
                    "type": "boolean",
                    "description": "True if more than one option may be chosen. Default false.",
                    "default": False,
                },
            },
            "required": ["question"],
        }

    async def execute(
        self,
        question: str,
        options: list[dict[str, Any]] | None = None,
        context: str = "",
        multi_select: bool = False,
        **kwargs: Any,
    ) -> str:
        question = (question or "").strip()
        if not question:
            return json.dumps({"queued": False, "error": "question is required"})

        options = [o for o in (options or []) if isinstance(o, dict) and o.get("label")]
        if len(options) > MAX_OPTIONS:
            # Truncating beats refusing: the question is still answerable, and a
            # refusal here sends the agent back to guessing.
            options = options[:MAX_OPTIONS]

        agent_id = os.environ.get("AGENT_ID", "")
        host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        if not agent_id:
            return json.dumps({"queued": False, "error": "AGENT_ID not set"})

        # The give-up time travels with the question so the orchestrator can tell whether
        # a cycle is still listening: inside it, the reply is handed to this waiting run;
        # past it, it goes down the old processFeedback path instead of vanishing. See
        # isLiveClarifyAwaitingReply in api/routes/agents.ts.
        await_until_ms = int((time.time() + CLARIFY_TIMEOUT_S) * 1000)

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{host}/api/agents/{agent_id}/checkins",
                    json={
                        "status": "pending",
                        "report_md": render(question, options, context, multi_select),
                        # Marks a question a live cycle is blocked on. Still nothing
                        # fires on approval — this is a question, not a draft awaiting
                        # a go-ahead — but the reply must reach the waiting run rather
                        # than start a second cycle to answer it.
                        "action_type": "clarify_live",
                        # Stage 60 phase 2: the question travels structured too, so the
                        # chat can render option buttons instead of an approve/reject card.
                        "action_payload": json.dumps({
                            "awaitUntil": await_until_ms,
                            "question": question,
                            "options": [
                                {"label": str(o.get("label", "")).strip(),
                                 "detail": str(o.get("detail", "") or "").strip()}
                                for o in options
                            ],
                            "context": (context or "").strip(),
                            "multi_select": bool(multi_select),
                        }),
                    },
                )
            if not res.is_success:
                return json.dumps(
                    {"queued": False, "error": f"API {res.status_code}: {res.text[:200]}"}
                )
            checkin_id = res.json().get("id")
        except Exception as e:  # noqa: BLE001
            return json.dumps({"queued": False, "error": str(e)})

        if not checkin_id:
            return json.dumps({"queued": False, "error": "check-in created without an id"})

        logger.info(
            f"clarify: waiting up to {CLARIFY_TIMEOUT_S}s for an answer — "
            f"agent={agent_id} checkin={checkin_id}"
        )
        reply = await self._await_reply(host, agent_id, checkin_id)

        if reply is STOPPED:
            return json.dumps({
                "queued": True, "answered": False, "stopped": True, "checkin_id": checkin_id,
                "message": "The user pressed Stop. End the run now and do not continue the task.",
            })

        if reply is None:
            # Not an error: the run keeps whatever it has and the model decides what is
            # still safe to finish. It must NOT treat this as licence to invent the value.
            return json.dumps({
                "queued": True,
                "answered": False,
                "timed_out": True,
                "checkin_id": checkin_id,
                "message": (
                    f"Nobody answered within {CLARIFY_TIMEOUT_S}s. The question is still in "
                    "the Check-in Inbox and will reach you on a later cycle. Do NOT invent "
                    "the value you asked about — finish what you can safely do without it "
                    "and report clearly what you left undone and why."
                ),
            })

        return json.dumps({
            "queued": True,
            "answered": True,
            "checkin_id": checkin_id,
            "reply": reply,
            "message": "Your manager answered. Continue the task using this reply.",
        })

    async def _await_reply(self, host: str, agent_id: str, checkin_id: str) -> str | None:
        """Poll the check-in until a human replies. None on timeout.

        Same shape as escalation.request_approval's poll, and for the same reason: the
        orchestrator owns the answer and the container has no inbound channel. A poll
        that errors is retried rather than treated as a refusal — a blip in the
        orchestrator must not look like "no answer" and send the agent back to guessing.
        """
        # The cycle-token route, not /api/agents/:id/checkins/:id: that one needs a browser
        # session, so every poll was a 401 and no answer ever arrived (stage 60 live test).
        url = f"{host}/api/agents/{agent_id}/self/checkins/{checkin_id}"
        headers = {"Authorization": f"Bearer {os.environ.get('NANOCREW_CYCLE_TOKEN', '')}"}
        waited = 0
        while waited < CLARIFY_TIMEOUT_S:
            await asyncio.sleep(_POLL_INTERVAL_S)
            waited += _POLL_INTERVAL_S
            if await stop_requested(host, agent_id):
                logger.info(f"clarify: stopped by the owner while waiting — agent={agent_id}")
                return STOPPED
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    res = await client.get(url, headers=headers)
                if not res.is_success:
                    continue
                row = res.json()
            except Exception as err:  # noqa: BLE001
                logger.debug(f"clarify: poll failed, retrying — {err}")
                continue

            reply = (row.get("user_reply") or "").strip()
            if reply:
                logger.info(f"clarify: answer received — agent={agent_id} checkin={checkin_id}")
                return reply
            if row.get("status") == "responded":
                # Marked answered with nothing in it — treat as answered-but-empty rather
                # than waiting out the full timeout for a reply that already came.
                return ""

        logger.warning(
            f"clarify: no answer within {CLARIFY_TIMEOUT_S}s — agent={agent_id} checkin={checkin_id}"
        )
        return None


def render(
    question: str,
    options: list[dict[str, Any]],
    context: str = "",
    multi_select: bool = False,
) -> str:
    """Markdown for the Check-in Inbox. Pure, so it can be tested without a server."""
    parts = [f"## Question\n\n{question.strip()}"]
    if context.strip():
        parts.append(f"**Where I got to:** {context.strip()}")
    # Filtered here as well as in execute(): render is the public, pure unit, and a
    # label-less option would otherwise print as an empty numbered choice — which
    # reads as a real option the human cannot evaluate.
    options = [o for o in (options or []) if isinstance(o, dict) and str(o.get("label", "")).strip()]
    if options:
        lines = []
        for i, option in enumerate(options, start=1):
            label = str(option.get("label", "")).strip()
            detail = str(option.get("detail", "")).strip()
            lines.append(f"{i}. **{label}**" + (f" — {detail}" if detail else ""))
        how = (
            "Reply with the numbers you want (e.g. `1, 3`)"
            if multi_select
            else "Reply with a number"
        )
        parts.append("\n".join(lines))
        parts.append(f"_{how}, or just tell me what you'd rather do._")
    else:
        parts.append("_Reply in your own words._")
    return "\n\n".join(parts)
