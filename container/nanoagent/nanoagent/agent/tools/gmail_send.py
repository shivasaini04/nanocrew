"""Gmail send tool — sends email via Gmail API using stored OAuth credentials."""

import base64
import json
from pathlib import Path
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.credentials import get_credential, require_credential
from nanoagent.agent.tools._gmail_auth import get_access_token

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
DEFAULT_DAILY_LIMIT = 50


def _build_raw_message(to: str, subject: str, body: str, from_email: str | None) -> str:
    """Build a base64url-encoded RFC 5322 email message."""
    headers = []
    if from_email:
        headers.append(f"From: {from_email}")
    headers += [
        f"To: {to}",
        f"Subject: {subject}",
        "Content-Type: text/plain; charset=utf-8",
    ]
    raw = "\r\n".join(headers) + "\r\n\r\n" + body
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("utf-8")


def _count_sent_today(sent_file: Path) -> int:
    """Count emails sent today by reading the sent log."""
    if not sent_file.exists():
        return 0
    from datetime import date
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


class GmailSendTool(Tool):
    """Send an email via Gmail using stored OAuth credentials."""

    name        = "gmail_send"
    description = (
        "Send an email via Gmail. Requires Gmail to be connected in the dashboard. "
        "Tracks sent emails in workspace/outbox/sent.jsonl to enforce daily limits."
    )
    parameters  = {
        "type": "object",
        "properties": {
            "to":        {"type": "string", "description": "Recipient email address"},
            "subject":   {"type": "string", "description": "Email subject line"},
            "body":      {"type": "string", "description": "Plain-text email body"},
            "thread_id": {"type": "string", "description": "Gmail thread ID to reply into (optional)"},
        },
        "required": ["to", "subject", "body"],
    }

    def __init__(self, workspace: Path, daily_limit: int = DEFAULT_DAILY_LIMIT):
        self.workspace   = workspace
        self.daily_limit = daily_limit

    async def execute(self, to: str, subject: str, body: str, thread_id: str | None = None, **kwargs: Any) -> str:
        # Check credentials up front — fail fast with a clear message
        require_credential("gmail", "refresh_token")

        # Enforce daily send limit
        sent_file = self.workspace / "outbox" / "sent.jsonl"
        today_count = _count_sent_today(sent_file)
        if today_count >= self.daily_limit:
            return json.dumps({
                "sent": False,
                "error": f"Daily send limit of {self.daily_limit} reached ({today_count} sent today). "
                         "Resuming tomorrow.",
            })

        try:
            access_token = await get_access_token()
        except Exception as e:
            return json.dumps({"sent": False, "error": str(e)})

        from_email = get_credential("gmail", "email")
        raw = _build_raw_message(to, subject, body, from_email)

        req_body: dict[str, Any] = {"raw": raw}
        if thread_id:
            req_body["threadId"] = thread_id

        try:
            async with httpx.AsyncClient() as client:
                res = await client.post(
                    GMAIL_SEND_URL,
                    json=req_body,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=20.0,
                )

            if not res.is_success:
                return json.dumps({
                    "sent": False,
                    "error": f"Gmail API returned {res.status_code}: {res.text[:200]}",
                })

            data = res.json()
            result = {
                "sent":      True,
                "messageId": data.get("id"),
                "threadId":  data.get("threadId"),
                "to":        to,
                "subject":   subject,
            }

            # Append to sent log
            import datetime
            sent_file.parent.mkdir(parents=True, exist_ok=True)
            with sent_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps({**result, "sentAt": datetime.datetime.utcnow().isoformat() + "Z"}) + "\n")

            return json.dumps(result)

        except Exception as e:
            return json.dumps({"sent": False, "error": str(e)})
