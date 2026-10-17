"""The `voice_call` tool — place one outbound phone call.

Drives agent/voice/runner.py the way tools/effector.py drives effector/react_loop.py:
the package holds the engine, this file is the thin surface the model sees.

Unlike `effector`, this tool does NOT run the work it starts. It hands the call to
the carrier and returns; the conversation happens on the tenant's Voicebot flow and
outlives the cycle. `voice_call_result` reads back what happened. That split is
inherent to telephony — see agent/voice/__init__.py — so the description below is
explicit that a successful return means "ringing", never "talked to them".
"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger

from nanoagent.agent.tools.base import Tool


class VoiceCallTool(Tool):
    """Place a real outbound phone call to a person, with an AI agent speaking on
    the tenant's behalf."""

    def __init__(self, owner_id: str | None = None):
        # The NanoCrew user this agent belongs to. The voice tenant (carrier
        # account, persona, calling rules) is resolved FROM this at call time, not
        # passed in as a raw row id: a bare integer invites defaulting to tenant 1,
        # which would mean dialling on the first-created account's carrier.
        # None -> voice is not provisioned, and every call is refused.
        self._owner_id = owner_id

    def _tenant(self):
        """The caller's voice tenant id, or None if they have not provisioned voice."""
        if not self._owner_id:
            return None
        from nanoagent.agent.voice import db
        row = db.tenant_for_owner(self._owner_id)
        return row["id"] if row else None

    @property
    def name(self) -> str:
        return "voice_call"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def description(self) -> str:
        return (
            "Place a real outbound phone call to a real person. A human's phone rings "
            "and an AI agent speaks to them on your behalf — this is irreversible and "
            "costs money, so only call it when the user has asked for a specific person "
            "to be called.\n"
            "IMPORTANT: this returns as soon as the carrier accepts the call, which "
            "means the phone is RINGING — not that anyone answered, and not that the "
            "conversation happened. Never report to the user that you spoke to someone, "
            "that they agreed to anything, or that a meeting was booked, on the strength "
            "of this tool's result. The call outlives this cycle; use `voice_call_result` "
            "with the returned call_id (usually on a later run) to find out what was "
            "actually said and decided.\n"
            "Calls are refused outside the TRAI 9am-9pm IST window, to non-Indian or "
            "malformed mobile numbers, and to numbers on the DND list. That gate is a "
            "legal requirement and cannot be overridden — a `blocked` status is final, "
            "so do not retry the same number in the same cycle."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "phone": {
                    "type": "string",
                    "description": "The person's Indian mobile number, e.g. '+919876543210' "
                                   "or '9876543210'.",
                },
                "lead_name": {
                    "type": "string",
                    "description": "Who is being called. The agent greets them by name, so "
                                   "give the name they'd expect to be called — omit it "
                                   "rather than guessing, which greets them without a name.",
                },
                "reason": {
                    "type": "string",
                    "description": "Why this person is being called, in one short phrase spoken "
                                   "aloud in the opening line (e.g. 'you asked about pricing "
                                   "last week'). Must be true — it is the first thing they hear.",
                },
                "context": {
                    "type": "object",
                    "description": "Extra facts about this person the agent can use on the call "
                                   "(plan, invoice number, cart value). Flat string/number "
                                   "values only.",
                },
            },
            "required": ["phone"],
        }

    async def execute(
        self,
        phone: str,
        lead_name: str = "",
        reason: str = "",
        context: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str:
        tenant_id = self._tenant()
        if tenant_id is None:
            return json.dumps({
                "ok": False,
                "status": "not_provisioned",
                "error": "Voice calling is not set up for this agent. It needs a carrier "
                         "account (Exotel) connected in Settings -> Credentials before any "
                         "call can be placed.",
            })

        from nanoagent.agent.voice import run_voice_call

        try:
            result = await run_voice_call(
                tenant_id=tenant_id,
                phone=phone,
                lead_name=lead_name,
                reason=reason,
                context=context or {},
            )
        except Exception as err:
            logger.warning(f"voice_call: failed for phone={phone!r} — {err}")
            return json.dumps({"ok": False, "status": "error", "error": str(err)})

        return json.dumps(result, ensure_ascii=False)


class VoiceCallResultTool(Tool):
    """Read back what a previously placed call actually did."""

    def __init__(self, owner_id: str | None = None):
        self._owner_id = owner_id

    def _tenant(self):
        if not self._owner_id:
            return None
        from nanoagent.agent.voice import db
        row = db.tenant_for_owner(self._owner_id)
        return row["id"] if row else None

    @property
    def name(self) -> str:
        return "voice_call_result"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.ReadOnly

    @property
    def description(self) -> str:
        return (
            "Look up what happened on a call placed earlier by `voice_call` — whether it "
            "was answered, the transcript of what was said, and the outcome (interested, "
            "callback requested, demo booked, not interested). Use the call_id that "
            "`voice_call` returned.\n"
            "A call that is still ringing or in progress has no transcript yet; that means "
            "it has not finished, not that it failed. This is the ONLY honest source for "
            "what was said on a call — `voice_call` itself only reports that the phone rang."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "call_id": {
                    "type": "integer",
                    "description": "The call_id returned by `voice_call`.",
                },
            },
            "required": ["call_id"],
        }

    async def execute(self, call_id: int, **kwargs: Any) -> str:
        tenant_id = self._tenant()
        if tenant_id is None:
            return json.dumps({
                "ok": False,
                "error": "Voice calling is not set up for this agent.",
            })

        from nanoagent.agent.voice import get_call_result

        try:
            result = await get_call_result(tenant_id=tenant_id, call_id=call_id)
        except Exception as err:
            logger.warning(f"voice_call_result: failed for call_id={call_id} — {err}")
            return json.dumps({"ok": False, "error": str(err)})

        return json.dumps(result, ensure_ascii=False)
