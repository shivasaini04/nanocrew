"""Gmail replies tool — checks inbox for replies to sent emails."""

import json
from pathlib import Path
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.credentials import require_credential
from nanoagent.agent.tools._gmail_auth import get_access_token

GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
DEFAULT_SINCE_HOURS = 24


def _load_tracked_threads(sent_file: Path) -> set[str]:
    """Load thread IDs from sent.jsonl to know which threads to watch for replies."""
    threads: set[str] = set()
    if not sent_file.exists():
        return threads
    for line in sent_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            tid = entry.get("threadId")
            if tid:
                threads.add(tid)
        except json.JSONDecodeError:
            pass
    return threads


class GmailRepliesTool(Tool):
    """Check Gmail inbox for replies to emails this agent sent."""

    name        = "gmail_check_replies"
    description = (
        "Check Gmail inbox for replies to emails this agent has sent. "
        "Returns sender, subject, snippet, and thread ID for each reply found. "
        "Only returns replies to threads tracked in workspace/outbox/sent.jsonl."
    )
    parameters  = {
        "type": "object",
        "properties": {
            "since_hours": {
                "type":        "integer",
                "description": "How far back to look for replies, in hours",
                "minimum":     1,
                "maximum":     168,
            },
        },
        "required": [],
    }

    def __init__(self, workspace: Path):
        self.workspace = workspace

    async def execute(self, since_hours: int = DEFAULT_SINCE_HOURS, **kwargs: Any) -> str:
        require_credential("gmail", "refresh_token")

        sent_file      = self.workspace / "outbox" / "sent.jsonl"
        tracked        = _load_tracked_threads(sent_file)
        if not tracked:
            return json.dumps({"replies": [], "note": "No tracked threads — send some emails first."})

        try:
            access_token = await get_access_token()
        except Exception as e:
            return json.dumps({"replies": [], "error": str(e)})

        import time
        after_ts = int(time.time()) - since_hours * 3600

        try:
            async with httpx.AsyncClient() as client:
                list_res = await client.get(
                    GMAIL_MESSAGES_URL,
                    params={"q": f"in:inbox after:{after_ts}", "maxResults": 50},
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=15.0,
                )

            if not list_res.is_success:
                return json.dumps({"replies": [], "error": f"Gmail list failed: {list_res.status_code}"})

            messages: list[dict] = list_res.json().get("messages") or []
            replies = []

            async with httpx.AsyncClient() as client:
                for msg in messages:
                    if msg.get("threadId") not in tracked:
                        continue

                    msg_res = await client.get(
                        f"{GMAIL_MESSAGES_URL}/{msg['id']}",
                        params={"format": "metadata", "metadataHeaders": "Subject,From,Date"},
                        headers={"Authorization": f"Bearer {access_token}"},
                        timeout=10.0,
                    )
                    if not msg_res.is_success:
                        continue

                    msg_data = msg_res.json()
                    headers  = {h["name"]: h["value"] for h in (msg_data.get("payload", {}).get("headers") or [])}

                    replies.append({
                        "messageId":   msg["id"],
                        "threadId":    msg.get("threadId"),
                        "from":        headers.get("From", ""),
                        "subject":     headers.get("Subject", ""),
                        "date":        headers.get("Date", ""),
                        "snippet":     msg_data.get("snippet", ""),
                    })

            return json.dumps({"replies": replies, "count": len(replies)})

        except Exception as e:
            return json.dumps({"replies": [], "error": str(e)})
