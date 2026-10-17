"""SMTP send tool — queues an email for human approval; the orchestrator sends it.

Distinct from gmail_send.py, which requires Gmail OAuth (GMAIL_REFRESH_TOKEN etc,
platform CREDENTIAL_ENV_MAP). This tool is for an agent whose owner connected a mailbox
by app password through the agent's own Secrets tab — EMAIL_SERVER_HOST/PORT/USER/
PASSWORD/EMAIL_FROM land directly in this container's env under those literal names
(SecretsManager injects a per-agent secret's `name` as the env var name verbatim, no
CREDENTIAL_ENV_MAP indirection needed), so a plain os.environ.get reads them.

**This tool does not send.** It creates a pending check-in and stops; the actual SMTP
send happens orchestrator-side in `_smtpSendForAgent` only after a human approves.

Why the send moved out of the agent: this mailbox is a *personal* one (the owner's own
address, by app password), and the agent's job — reading job posts, company sites and
inbound replies — is exactly the shape that ingests attacker-controllable text. Leaving
a real send behind a prompt instruction ("draft, then wait for approval") meant nothing
technically enforced it. Keeping the credentials reachable but the send unreachable is
the point: no phrasing the model can produce, and no text it can be fed, results in mail
leaving this container.
"""

import json
import os
from datetime import date
from pathlib import Path
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool

DEFAULT_DAILY_LIMIT = 20  # personal mailbox, not a bulk sender — stay conservative


def _count_sent_today(sent_file: Path) -> int:
    if not sent_file.exists():
        return 0
    today = date.today().isoformat()
    count = 0
    for line in sent_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            if (entry.get("sentAt") or "").startswith(today):
                count += 1
        except json.JSONDecodeError:
            pass
    return count


class SmtpSendTool(Tool):
    """Queue an email for human approval; the orchestrator sends it on Approve."""

    name        = "smtp_send"
    description = (
        "Queue an email for the owner's approval, sent from this agent's own mailbox "
        "(configured in the agent's Secrets tab as EMAIL_SERVER_HOST/PORT/USER/PASSWORD/"
        "EMAIL_FROM). Use this instead of gmail_send when the owner connected a mailbox by "
        "app password rather than Gmail OAuth. "
        "IMPORTANT: this does NOT send the email — it puts the draft in the owner's Check-in "
        "Inbox with Approve / Reject buttons, and it is only sent if they approve. Write the "
        "final wording you want sent, then call this once and consider the task done; do not "
        "wait for or poll the outcome. Sends are capped daily and recorded in outbox/sent.jsonl."
    )
    parameters  = {
        "type": "object",
        "properties": {
            "to":      {"type": "string", "description": "Recipient email address"},
            "subject": {"type": "string", "description": "Email subject line"},
            "body":    {"type": "string", "description": "Plain-text email body"},
        },
        "required": ["to", "subject", "body"],
    }

    def __init__(self, workspace: Path, daily_limit: int = DEFAULT_DAILY_LIMIT):
        self.workspace   = workspace
        self.daily_limit = daily_limit

    async def execute(self, to: str, subject: str, body: str, **kwargs: Any) -> str:
        # Config and quota are checked here purely so the agent finds out now rather than
        # after a human has already approved a draft that could never be delivered. Neither
        # check is the enforcement point — the orchestrator re-checks both at send time,
        # because that is the side this container cannot influence.
        from_email = os.environ.get("EMAIL_FROM") or os.environ.get("EMAIL_SERVER_USER")
        if not os.environ.get("EMAIL_SERVER_HOST") or not os.environ.get("EMAIL_SERVER_USER") \
           or not os.environ.get("EMAIL_SERVER_PASSWORD"):
            return json.dumps({
                "queued": False,
                "error": "SMTP not configured — add EMAIL_SERVER_HOST, EMAIL_SERVER_USER and "
                         "EMAIL_SERVER_PASSWORD in this agent's Secrets tab.",
            })

        today_count = _count_sent_today(self.workspace / "outbox" / "sent.jsonl")
        if today_count >= self.daily_limit:
            return json.dumps({
                "queued": False,
                "error": f"Daily send limit of {self.daily_limit} reached ({today_count} sent today). "
                         "Resuming tomorrow.",
            })

        agent_id = os.environ.get("AGENT_ID", "")
        host_url = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
        if not agent_id:
            return json.dumps({"queued": False, "error": "AGENT_ID not set"})

        # The whole email is rendered into the report so the reviewer approves what they can
        # actually read, rather than a summary of it.
        report_md = (
            f"## Draft email\n\n"
            f"**From:** {from_email}\n"
            f"**To:** {to}\n"
            f"**Subject:** {subject}\n\n"
            f"**Body:**\n\n{body}\n\n"
            f"---\n_Approve to send. {today_count}/{self.daily_limit} sent today._"
        )

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{host_url}/api/agents/{agent_id}/checkins",
                    json={
                        "status": "pending",
                        "report_md": report_md,
                        "action_type": "smtp_send",
                        "action_payload": json.dumps({"to": to, "subject": subject, "body": body}),
                    },
                )
            if not res.is_success:
                return json.dumps({"queued": False, "error": f"API {res.status_code}: {res.text[:200]}"})
            data = res.json()
            # The owner may have a standing rule that this email needs no asking; then the
            # orchestrator has already sent it, and saying "pending" would be a lie.
            if data.get("autoApproved"):
                return json.dumps({
                    "queued": False,
                    "sent": bool(data.get("executed")),
                    "checkin_id": data.get("id"),
                    "to": to,
                    "subject": subject,
                    "rule": data.get("rule"),
                    "message": data.get("actionResult"),
                })
            return json.dumps({
                "queued": True,
                "sent": False,
                "checkin_id": res.json().get("id"),
                "to": to,
                "subject": subject,
                "message": "Draft is pending approval in the Check-in Inbox. It has NOT been sent. "
                           "Do not retry or wait — you will be told the outcome.",
            })
        except Exception as e:
            return json.dumps({"queued": False, "error": f"{type(e).__name__}: {e}"})
