"""`run_voice_call` — the package's entry point, the way `run_react_loop` is
effector's.

One call in, one result out. No process, no poll loop, no server: the prototype's
`dialer.py` ran forever draining a queue and `server.py` held the FastAPI ingress,
and neither shape can live in an agent cycle (the container is `--rm`, capped at
30 minutes, and publishes no ports). What survives is the part that was always a
library — the compliance gate, the tenant's own credentials, origination, and the
call record.

The audio itself is not driven from here. Exotel calls the Voicebot flow on answer
and streams the media to whatever WebSocket the tenant's flow URL points at; this
function's job ends when the call is handed to the carrier, and the outcome is read
back later from the call record. That asymmetry is inherent to telephony, not a
shortcut: a live call outlives the cycle that started it.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

from nanoagent.agent.voice import db
from nanoagent.agent.voice.contact_gate import run_contact_gate
from nanoagent.agent.voice.telephony import place_call, tenant_telephony


async def run_voice_call(
    tenant_id: int,
    phone: str,
    lead_name: str = "",
    reason: str = "",
    context: Optional[Dict[str, Any]] = None,
    campaign_id: Optional[int] = None,
    contact_id: Optional[int] = None,
    bypass_calling_hours: bool = False,
) -> Dict[str, Any]:
    """Run the pre-call gate, then originate one call.

    Returns a plain dict (never raises for an expected failure) so the calling
    tool can serialise it straight back to the model:

        {ok, status, call_id?, provider_sid?, phone?, error?, rejection_code?}

    `status` is one of:
        dialed    — the carrier accepted it and the phone is ringing
        blocked   — the compliance gate refused (invalid number, DND, TRAI window)
        failed    — origination was rejected in a way retrying will not fix
        retryable — a transient failure; the same call may be placed again
    """
    # The gate is deliberately not bypassable from the tool surface. TRAI's
    # 9am-9pm window and the DND list are legal constraints on the tenant, not
    # preferences an agent should be able to argue its way past mid-cycle;
    # `bypass_calling_hours` exists for tests and is never exposed as a tool arg.
    gate = run_contact_gate(phone, bypass_time_check_for_dev=bypass_calling_hours)
    if not gate.is_approved:
        return {
            "ok": False,
            "status": "blocked",
            "rejection_code": gate.rejection_code,
            "error": gate.reason,
            "phone": phone,
        }

    cfg = tenant_telephony(tenant_id)
    custom = {"lead_name": lead_name or "", "reason": reason or ""}
    for key, value in (context or {}).items():
        if isinstance(value, (str, int, float)):
            custom[key] = value

    result = place_call(cfg, gate.phone_e164, custom)

    if result["ok"]:
        call_id = db.start_call(
            tenant_id,
            campaign_id=campaign_id,
            contact_id=contact_id,
            provider_sid=result.get("sid"),
            channel="phone",
            status="ringing",
            contact_name=lead_name or None,
            contact_phone=gate.phone_e164,
        )
        return {
            "ok": True,
            "status": "dialed",
            "call_id": call_id,
            "provider_sid": result.get("sid"),
            "phone": gate.phone_e164,
        }

    return {
        "ok": False,
        "status": "failed" if result.get("terminal") else "retryable",
        "error": result["error"],
        "phone": gate.phone_e164,
    }


async def get_call_result(tenant_id: int, call_id: int) -> Dict[str, Any]:
    """Read back what a call actually did — transcript, outcome, booking.

    A call outlives the cycle that placed it, so this is how a later cycle learns
    how the previous one went. Returns {ok: False} rather than raising when the
    call belongs to another tenant, so a wrong id cannot be used to read across
    the tenancy boundary.
    """
    # call_detail always returns a 3-tuple; a missing/foreign call is (None, [], None).
    call, turns, outcome = db.call_detail(tenant_id, call_id)
    if call is None:
        return {"ok": False, "error": f"no call {call_id} for this tenant"}
    return {
        "ok": True,
        "call_id": call_id,
        "status": call["status"] if call else None,
        "duration_s": call["duration_s"] if call else None,
        "transcript": [
            {"speaker": t["speaker"], "text": t["text"]} for t in (turns or [])
        ],
        "outcome": dict(outcome) if outcome else None,
    }
