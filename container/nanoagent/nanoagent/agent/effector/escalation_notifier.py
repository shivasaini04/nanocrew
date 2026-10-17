"""Ported from computer-use/escalation-notifier.ts. Dispatches an urgent
human-intervention notification via webhook (Slack/Discord) when Effector hits
something it must not decide alone — a 2FA prompt, a payment threshold, a CAPTCHA.

The TS original also emits to an in-process TS event bus (`globalEventBus`) — not
portable here (Effector runs in the per-cycle Python container, no shared event bus
with the orchestrator). The webhook path is unchanged; nanoagent's own `notify`
tool/pattern covers the operator-visible-in-app side this event bus emission was
approximating, so nothing is silently lost — see agent/tools/notify.py.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from loguru import logger

EscalationReason = Literal["2FA_REQUIRED", "PAYMENT_THRESHOLD", "CAPTCHA", "CRITICAL_ACTION", "EXCEPTION"]


@dataclass
class EscalationAlert:
    run_id: str
    domain: str
    reason: EscalationReason
    details: str
    takeover_url: str | None = None
    timestamp: str | None = None


@dataclass
class EscalationNotificationResult:
    dispatched: bool
    channel: str  # 'webhook' | 'event_bus' | 'console'
    error: str | None = None


def _webhook_url(custom: str | None) -> str | None:
    if custom:
        return custom
    return (
        os.environ.get("ESCALATION_WEBHOOK_URL")
        or os.environ.get("SLACK_WEBHOOK_URL")
        or os.environ.get("DISCORD_WEBHOOK_URL")
        or None
    )


async def dispatch_escalation_alert(alert: EscalationAlert, custom_webhook_url: str | None = None) -> EscalationNotificationResult:
    timestamp = alert.timestamp or datetime.now(timezone.utc).isoformat()
    takeover_url = alert.takeover_url or f"http://localhost:3000/takeover?runId={alert.run_id}"

    logger.warning(f"effector escalation-notifier: dispatching human takeover alert — {alert.reason} on {alert.domain}")

    webhook_url = _webhook_url(custom_webhook_url)
    if not webhook_url:
        return EscalationNotificationResult(dispatched=True, channel="console")

    try:
        import httpx

        payload = {
            "text": (
                f"🚨 *[Digital Employee Alert]* Intervention Required on *{alert.domain}*\n"
                f"*Reason:* {alert.reason}\n*Details:* {alert.details}\n"
                f"👉 <{takeover_url}|Click here for Live Takeover>"
            ),
            "run_id": alert.run_id, "domain": alert.domain, "reason": alert.reason,
            "details": alert.details, "takeover_url": takeover_url, "timestamp": timestamp,
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(webhook_url, json=payload, timeout=10)
        if response.status_code >= 400:
            raise RuntimeError(f"Webhook returned status {response.status_code}")

        return EscalationNotificationResult(dispatched=True, channel="webhook")
    except Exception as err:
        logger.debug(f"effector escalation-notifier: webhook delivery failed — {err}")
        return EscalationNotificationResult(dispatched=False, channel="webhook", error=str(err))
