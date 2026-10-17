"""Ported from computer-use/session-keepalive.ts. Periodically warms up saved
per-domain sessions (logs in once, stays logged in) so a scheduled blueprint run
doesn't hit a stale/expired session and silently fail at the login wall — uses
browser_session.py + resilience/checkpoint.py's verify_session_health, both
already built rather than reimplemented here."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from nanoagent.agent.effector.browser_session import EffectorSession
from nanoagent.agent.effector.resilience.checkpoint import verify_session_health


@dataclass
class SessionHealthReport:
    domain: str
    is_valid: bool
    last_checked: str
    error: str | None = None


async def keep_alive_domain_session(domain: str, workspace: Path) -> SessionHealthReport:
    """Warm up and health-check a single saved domain session."""
    last_checked = datetime.now(timezone.utc).isoformat()
    logger.info(f"effector session-keepalive: checking and warming up session for {domain}")

    target_url = domain if domain.startswith("http") else f"https://{domain}"

    try:
        # allow_remote=False, stated rather than inherited.
        #
        # This keeps a CONTAINER-side login warm. Sending it to the user's browser would
        # refresh the wrong session — and hijack a browser the person is using — to keep
        # alive cookies that live somewhere else entirely. One of the two genuine reasons
        # a session must stay in the container; see EffectorSession.__init__.
        async with EffectorSession(
            workspace, session_domain=domain, stealth=True, network_shield=True,
            allow_remote=False,
        ) as session:
            await session.page.goto(target_url, wait_until="domcontentloaded", timeout=15000)
            health = await verify_session_health(session.page, domain)

        return SessionHealthReport(domain=domain, is_valid=health["is_healthy"], last_checked=last_checked,
                                    error=health.get("reason"))
    except Exception as err:
        logger.warning(f"effector session-keepalive: failed to warm up {domain} — {err}")
        return SessionHealthReport(domain=domain, is_valid=False, last_checked=last_checked, error=str(err))


async def batch_keep_alive_sessions(domains: list[str], workspace: Path) -> list[SessionHealthReport]:
    """Maintain health across a fleet of saved domain sessions, sequentially (each
    is a real browser launch — not worth parallelizing for what's normally a small,
    infrequent list)."""
    return [await keep_alive_domain_session(d, workspace) for d in domains]
