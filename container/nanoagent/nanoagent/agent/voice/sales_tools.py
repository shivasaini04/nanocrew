"""
In-call tools the agent can actually execute.

Two tools, both real:

  check_calendar_slots  reads free slots from the database, excluding ones
                        already booked
  book_demo_slot        writes the booking and emails a calendar invite

WhatsApp was removed. Meta's Cloud API needs a Meta Business account, a dedicated
verified phone number (a personal number cannot be reused), and template approval
before a business may open a conversation — days of approval process, not code.
Email does the same job for a prototype, sends instantly, and carries a real .ics
invite the prospect can accept in any calendar client.

Nothing here returns a fake success. If a tool cannot do the thing, it says so and
the agent has to tell the prospect the truth.
"""
import os
import ssl
import json
import smtplib
import logging
import datetime
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Dict, Any, List, Optional

import pytz

logger = logging.getLogger("sales_tools")

IST = pytz.timezone("Asia/Kolkata")
SLOT_MINUTES = int(os.getenv("DEMO_SLOT_MINUTES", "15"))
BUSINESS_START = int(os.getenv("DEMO_HOUR_START", "10"))
BUSINESS_END = int(os.getenv("DEMO_HOUR_END", "18"))

def _smtp_config(tenant_id: Optional[int] = None) -> Dict[str, Any]:
    """The TENANT's own SMTP account. No operator fallback, deliberately.

    This used to read the operator's nanocrew-main/.env when the tenant had no
    SMTP of its own, which meant a tenant's demo invite was sent FROM the
    operator's address: the prospect saw the wrong sender, and a reply went to
    the wrong company entirely.

    A tenant with no SMTP configured sends no invite. The booking is still
    recorded and the agent is told the invite could not be sent, which is
    recoverable; sending under someone else's identity is not.
    """
    if tenant_id is None:
        return {"host": "", "port": 465, "user": "", "password": "", "sender": ""}
    # Imported lazily, matching the other db uses in this module (avoids a cycle:
    # db imports nothing from here, but the tools are loaded at prompt-build time).
    from nanoagent.agent.voice import db
    try:
        row = db.tenant_row(tenant_id)
    except Exception:
        row = None
    if row is None:
        return {"host": "", "port": 465, "user": "", "password": "", "sender": ""}

    def _col(name: str) -> str:
        try:
            return (row[name] or "").strip()
        except (KeyError, IndexError, TypeError):
            return ""

    port_raw = ""
    try:
        port_raw = str(row["smtp_port"] or "")
    except (KeyError, IndexError, TypeError):
        pass
    return {
        "host": _col("smtp_host"),
        "port": int(port_raw or 465),
        "user": _col("smtp_user"),
        "password": _col("smtp_password"),
        "sender": _col("smtp_from"),
    }


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "check_calendar_slots",
            "description": ("Look up genuinely free demo slots. Call this as soon "
                            "as the prospect shows any interest in a demo, before "
                            "suggesting any time."),
            "parameters": {
                "type": "object",
                "properties": {
                    "day": {"type": "string",
                            "description": "'today', 'tomorrow', or YYYY-MM-DD"}
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_demo_slot",
            "description": ("Reserve a demo slot and email the prospect a calendar "
                            "invite. Only call this after they have chosen a time "
                            "from check_calendar_slots. Ask for their email first — "
                            "without it no invite can be sent."),
            "parameters": {
                "type": "object",
                "properties": {
                    "slot_start": {"type": "string",
                                   "description": "Exact slot_start from check_calendar_slots"},
                    "lead_email": {"type": "string",
                                   "description": "Prospect's email address for the invite"},
                    "lead_name": {"type": "string", "description": "Prospect's name"},
                },
                "required": ["slot_start"],
            },
        },
    },
]


# -- calendar --------------------------------------------------------------
def _generate_slots(day: str, taken: List[str]) -> List[Dict[str, str]]:
    """Free slots on a given day, in business hours, at least an hour out."""
    now = datetime.datetime.now(IST)
    if day in ("", "today"):
        target = now.date()
    elif day == "tomorrow":
        target = (now + datetime.timedelta(days=1)).date()
    else:
        try:
            target = datetime.datetime.strptime(day, "%Y-%m-%d").date()
        except ValueError:
            target = (now + datetime.timedelta(days=1)).date()

    slots = []
    cursor = IST.localize(datetime.datetime.combine(
        target, datetime.time(BUSINESS_START, 0)))
    end = IST.localize(datetime.datetime.combine(
        target, datetime.time(BUSINESS_END, 0)))
    earliest = now + datetime.timedelta(hours=1)

    while cursor < end:
        key = cursor.strftime("%Y-%m-%d %H:%M:%S")
        if cursor > earliest and key not in taken:
            slots.append({
                "slot_start": key,
                "spoken": cursor.strftime("%A %-d %B, %-I:%M %p")
                          if os.name != "nt"
                          else cursor.strftime("%A %d %B, %I:%M %p").lstrip("0"),
            })
        cursor += datetime.timedelta(minutes=SLOT_MINUTES)
    return slots


async def _check_calendar_slots(args: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    from nanoagent.agent.voice import db
    tenant_id = ctx.get("tenant_id", 1)
    taken = db.booked_slots(tenant_id)
    day = (args.get("day") or "tomorrow").strip().lower()

    slots = _generate_slots(day, taken)
    if not slots and day in ("today", ""):
        slots = _generate_slots("tomorrow", taken)     # nothing left today

    offered = slots[:3]
    logger.info("calendar: %d free slots for %s, offering %d", len(slots), day, len(offered))
    return {
        "status": "success",
        "day": day,
        "available_slots": offered,
        "note": ("Read the 'spoken' field aloud. Use the exact 'slot_start' value "
                 "when calling book_demo_slot."),
    }


async def _book_demo_slot(args: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    from nanoagent.agent.voice import db
    tenant_id = ctx.get("tenant_id", 1)
    slot_start = (args.get("slot_start") or "").strip()
    if not slot_start:
        return {"status": "error",
                "message": "No slot chosen. Call check_calendar_slots and let the "
                           "prospect pick one first."}

    try:
        start = datetime.datetime.strptime(slot_start, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return {"status": "error",
                "message": f"'{slot_start}' is not a slot from check_calendar_slots. "
                           f"Use the exact slot_start value returned there."}

    if slot_start in db.booked_slots(tenant_id):
        return {"status": "error",
                "message": "That slot was just taken. Offer the prospect another one."}

    end = start + datetime.timedelta(minutes=SLOT_MINUTES)
    email = (args.get("lead_email") or ctx.get("lead_email") or "").strip()
    name = (args.get("lead_name") or ctx.get("lead_name") or "there").strip()

    booking_id = db.create_booking(
        tenant_id, slot_start, end.strftime("%Y-%m-%d %H:%M:%S"),
        call_id=ctx.get("call_id"), contact_name=name, contact_email=email,
        contact_phone=ctx.get("lead_phone"))

    spoken = start.strftime("%A %d %B at %I:%M %p").replace(" 0", " ")
    result = {"status": "success", "booking_id": booking_id,
              "slot_confirmed": spoken, "company": ctx.get("company_name", "")}

    if not email:
        # Booked, but the prospect gets nothing. Say so rather than implying an
        # invite is on its way.
        result["email_sent"] = False
        result["message"] = ("Slot is reserved but no email address was given, so "
                             "no invite could be sent. Ask for their email and "
                             "tell them it will follow.")
        return result

    sent = _send_invite(email, name, start, end, ctx)
    result["email_sent"] = sent["ok"]
    if sent["ok"]:
        db.mark_booking_emailed(booking_id)
        result["message"] = f"Booked and calendar invite emailed to {email}."
    else:
        result["message"] = (f"Slot is reserved, but the invite email failed "
                             f"({sent['error']}). Tell them the team will confirm "
                             f"separately.")
    return result


# -- email -----------------------------------------------------------------
def _ics(start: datetime.datetime, end: datetime.datetime, name: str,
         company: str, organiser: str) -> str:
    """A real calendar invite the prospect can accept in any client."""
    fmt = "%Y%m%dT%H%M%S"
    return "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NanoCrew//Voice Agent//EN",  # product id, not tenant-facing
        "CALSCALE:GREGORIAN", "METHOD:REQUEST", "BEGIN:VEVENT",
        f"UID:{make_msgid(domain='nanocrew.local')[1:-1]}",
        f"DTSTAMP:{datetime.datetime.utcnow().strftime(fmt)}Z",
        f"DTSTART;TZID=Asia/Kolkata:{start.strftime(fmt)}",
        f"DTEND;TZID=Asia/Kolkata:{end.strftime(fmt)}",
        f"SUMMARY:Product demo with {company or 'our team'}",
        f"DESCRIPTION:15-minute walkthrough booked over a call with {name}.",
        f"ORGANIZER;CN={company or 'Sales'}:mailto:{organiser}",
        "STATUS:CONFIRMED", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR",
    ])


def _send_invite(to_email: str, name: str, start: datetime.datetime,
                 end: datetime.datetime, ctx: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _smtp_config(ctx.get("tenant_id"))
    if not cfg["host"] or not cfg["user"]:
        return {"ok": False, "error": "SMTP not configured"}

    # The tenant's own name, never the operator's. This defaulted to "NanoCrew",
    # so an unconfigured tenant's invite was signed by the operator's brand.
    company = (ctx.get("company_name") or "").strip() or "our team"
    when = start.strftime("%A %d %B at %I:%M %p").replace(" 0", " ")

    msg = EmailMessage()
    msg["Subject"] = f"Your demo is confirmed — {when} IST"
    msg["From"] = cfg["sender"] or cfg["user"]
    msg["To"] = to_email
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(
        f"Hi {name},\n\n"
        f"Thanks for speaking with us. Your {SLOT_MINUTES}-minute demo is confirmed "
        f"for {when} IST.\n\n"
        f"A calendar invite is attached — open it to add the slot to your calendar.\n\n"
        f"If that time stops working, just reply to this email.\n\n"
        f"— {company}\n")
    msg.add_attachment(
        _ics(start, end, name, company, cfg["sender"] or cfg["user"]).encode(),
        maintype="text", subtype="calendar", filename="demo.ics")

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=context, timeout=20) as srv:
            srv.login(cfg["user"], cfg["password"])
            srv.send_message(msg)
        logger.info("demo invite emailed to %s for %s", to_email, when)
        return {"ok": True}
    except Exception as exc:
        logger.error("invite email to %s failed: %s", to_email, exc)
        return {"ok": False, "error": str(exc)[:120]}


# -- dispatch --------------------------------------------------------------
async def execute_tool_call(tool_name: str, arguments_json: str,
                            context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run a tool. `context` carries trusted per-call values (tenant, contact)."""
    ctx = context or {}
    if isinstance(arguments_json, str):
        try:
            args = json.loads(arguments_json)
        except json.JSONDecodeError:
            logger.warning("bad arguments for %s: %r", tool_name, arguments_json)
            args = {}
    else:
        args = dict(arguments_json or {})

    handlers = {
        "check_calendar_slots": _check_calendar_slots,
        "book_demo_slot": _book_demo_slot,
    }
    handler = handlers.get(tool_name)
    if not handler:
        return {"status": "error", "message": f"Unknown tool: {tool_name}"}
    try:
        return await handler(args, ctx)
    except Exception as exc:
        logger.exception("tool %s failed", tool_name)
        return {"status": "error", "message": str(exc)[:150]}
