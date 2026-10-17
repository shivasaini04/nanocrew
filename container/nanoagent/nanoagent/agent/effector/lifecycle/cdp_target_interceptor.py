"""CDP target auto-attach observer for Effector.

Attaches to every new target (popups, `target=_blank` tabs, iframes, workers) so the
session can see and harden them.

Scope note, measured 2026-08-31 — the name overstates what this can do on Playwright.
It does NOT pause targets: `waitForDebuggerOnStart=True` hung every navigation, because
releasing a paused target needs `Runtime.runIfWaitingForDebugger` on that target's own
session, which a browser-level CDPSession cannot send. Pre-first-script patching is
delivered instead by `context.add_init_script()`, which Playwright applies to every page
in the context before its first script — verified by comparing a popup's own reading of
its fingerprint against its opener's.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

from loguru import logger


class CDPTargetInterceptor:
    """Manages CDP Target auto-attachment and pre-execution initialization hooks."""

    def __init__(
        self,
        init_script: str | None = None,
        user_agent_override: dict[str, Any] | None = None,
    ) -> None:
        self.init_script = init_script or ""
        self.user_agent_override = user_agent_override or {}
        self._attached_targets: set[str] = set()
        self._is_active: bool = False

    @property
    def is_active(self) -> bool:
        return self._is_active

    @property
    def attached_targets(self) -> set[str]:
        return set(self._attached_targets)

    async def enable_auto_attach(self, cdp_session: Any) -> bool:
        """Enables auto-attachment with debugger pause on start across all targets."""
        try:
            # 1. Register event handler for Target.attachedToTarget
            if hasattr(cdp_session, "on"):
                cdp_session.on(
                    "Target.attachedToTarget",
                    lambda event: asyncio.create_task(self._on_target_attached(cdp_session, event)),
                )

            # 2. Issue Target.setAutoAttach.
            #
            # waitForDebuggerOnStart is FALSE, and that is not a downgrade — it is the
            # only workable setting here. Measured live 2026-08-31: with it true, every
            # navigation timed out. Chromium pauses each new target and will not run a
            # byte until something sends Runtime.runIfWaitingForDebugger to that
            # target's OWN session — which a Playwright browser-level CDPSession cannot
            # do (Page.*/Runtime.* come back "Protocol error ('X' wasn't found)", and
            # send() takes no sessionId). So the pause was permanent: page.goto()
            # hung on about:blank and on every real URL.
            #
            # This silently broke ALL browsing under stealth=True. It went unnoticed
            # because the probes that "verified" R4 used about:blank and data: URLs
            # driven through page.evaluate, which do not depend on the target ever
            # being released.
            #
            # Losing the pause loses nothing real. The pre-script patching it was
            # supposed to guarantee is already delivered by
            # context.add_init_script(), which Playwright applies to every page in the
            # context — popups included — before that page's first script runs. That
            # was verified independently: an opener and a popup reading their own
            # fingerprints from a first inline <script> agree on every field.
            if hasattr(cdp_session, "send"):
                await cdp_session.send(
                    "Target.setAutoAttach",
                    {
                        "autoAttach": True,
                        "waitForDebuggerOnStart": False,
                        "flatten": True,
                    },
                )

            self._is_active = True
            logger.info(
                "cdp_target_interceptor: auto-attach ring armed (observing targets; "
                "pre-script patching is delivered by the context init script)"
            )
            return True
        except Exception as err:
            logger.warning(f"cdp_target_interceptor: failed to arm auto-attach ({err})")
            return False

    async def _on_target_attached(self, parent_session: Any, event: dict[str, Any]) -> None:
        """Handles newly attached target, injecting stealth before releasing debugger."""
        target_info = event.get("targetInfo", {})
        target_id = target_info.get("targetId", "")
        target_type = target_info.get("type", "page")
        session_id = event.get("sessionId")

        self._attached_targets.add(target_id)
        logger.debug(f"cdp_target_interceptor: target attached id={target_id} type={target_type}")

        # Playwright's CDPSession.send(method, params) takes NO sessionId: it owns one
        # session per target and flattens routing itself. Passing the kwarg raises
        # TypeError, which the handlers below caught and logged as "non-fatal" — so on
        # 2026-08-31 every popup patch silently failed AND every target failed to
        # resume, on a live run, while the capability manifest still said
        # lifecycle_interception=true. Found only by driving a real browser.
        #
        # Commands are therefore issued on the session Playwright already gives us for
        # the attached target; `session_id` is kept for logging/diagnostics only.
        # Measured 2026-08-31 against a live browser: a Playwright BROWSER-level CDP
        # session cannot route Page.* or Network.* commands to an attached target —
        # both come back "Protocol error ('X' wasn't found)". Those domains only exist
        # on a page-scoped session, which Playwright does not hand out for a target
        # paused on waitForDebuggerOnStart.
        #
        # That is fine, because the patching is already covered: the session calls
        # context.add_init_script() (stealth.apply_stealth_to_context), and Playwright
        # applies a context init script to EVERY page in the context — popups and
        # target=_blank tabs included — before that page runs its own first script.
        # The client-hint override is likewise re-applied per page by
        # browser_session._on_new_page.
        #
        # The per-target sends below are best-effort for runtimes that DO expose those
        # domains here; on Chromium they no-op and the context init script has already
        # done the work. Nothing here is load-bearing.
        try:
            if self.user_agent_override and hasattr(parent_session, "send"):
                try:
                    await parent_session.send(
                        "Network.setUserAgentOverride", self.user_agent_override,
                    )
                except Exception as err:
                    logger.debug(
                        f"cdp_target_interceptor: per-target UA override unavailable "
                        f"({err}) — context-level override already covers this page"
                    )

            if self.init_script and target_type in ("page", "iframe") and hasattr(parent_session, "send"):
                try:
                    await parent_session.send(
                        "Page.addScriptToEvaluateOnNewDocument",
                        {"source": self.init_script},
                    )
                except Exception as err:
                    logger.debug(
                        f"cdp_target_interceptor: per-target script injection unavailable "
                        f"({err}) — context init script already covers this page"
                    )

            # Harmless when nothing is paused (autoAttach no longer sets
            # waitForDebuggerOnStart), and the correct thing to send if a future runtime
            # ever does pause a target we can address.
            if hasattr(parent_session, "send"):
                await parent_session.send("Runtime.runIfWaitingForDebugger", {})
        except Exception as err:
            logger.error(f"cdp_target_interceptor: error provisioning attached target {target_id}: {err}")
            # Ensure we unpause even on error so the target does not hang forever —
            # a target left paused on waitForDebuggerOnStart never loads at all.
            try:
                if hasattr(parent_session, "send"):
                    await parent_session.send("Runtime.runIfWaitingForDebugger", {})
            except Exception as resume_err:
                logger.error(
                    f"cdp_target_interceptor: target {target_id} could not be resumed "
                    f"({resume_err}) — it may hang"
                )

    async def detach_all(self, cdp_session: Any) -> None:
        """Disables auto-attach and cleans up listeners."""
        try:
            if hasattr(cdp_session, "send"):
                await cdp_session.send(
                    "Target.setAutoAttach",
                    {"autoAttach": False, "waitForDebuggerOnStart": False, "flatten": True},
                )
        except Exception:
            pass
        self._is_active = False
        self._attached_targets.clear()
