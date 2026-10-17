"""Speculative Action Branching & Ephemeral State Rollback for Effector.

Enables risk-free exploration of uncertain UI branches, multi-step form paths,
and modal dialogs by snapshotting ephemeral browser state and rolling back on failure.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from loguru import logger


@dataclass
class EphemeralTabCheckpoint:
    checkpoint_id: str
    url: str
    cookies: list[dict[str, Any]] = field(default_factory=list)
    local_storage: dict[str, str] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


async def capture_tab_checkpoint(page: Any, context: Any = None) -> EphemeralTabCheckpoint:
    """Capture ephemeral browser state (URL, cookies, localStorage) for clean rollback."""
    checkpoint_id = f"ckpt_{uuid.uuid4().hex[:8]}"
    current_url = getattr(page, "url", "")

    cookies = []
    if context and hasattr(context, "cookies"):
        try:
            cookies = await context.cookies()
        except Exception:
            cookies = []

    local_storage = {}
    if hasattr(page, "evaluate"):
        try:
            items = await page.evaluate(r"() => { const res = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); res[k] = localStorage.getItem(k); } return res; }")
            if isinstance(items, dict):
                local_storage = items
        except Exception:
            local_storage = {}

    logger.debug(f"effector-rollback: captured checkpoint {checkpoint_id} at {current_url}")
    return EphemeralTabCheckpoint(
        checkpoint_id=checkpoint_id,
        url=current_url,
        cookies=cookies,
        local_storage=local_storage,
    )


async def restore_tab_checkpoint(page: Any, checkpoint: EphemeralTabCheckpoint, context: Any = None) -> bool:
    """Restore browser state to a previously captured checkpoint."""
    logger.info(f"effector-rollback: restoring checkpoint {checkpoint.checkpoint_id} (target URL: {checkpoint.url})")

    # 1. Restore cookies if context provided
    if context and checkpoint.cookies and hasattr(context, "add_cookies"):
        try:
            await context.add_cookies(checkpoint.cookies)
        except Exception as err:
            logger.debug(f"effector-rollback: cookie restore error — {err}")

    # 2. Reload the checkpoint URL — unconditionally, not just when the URL string
    # changed. Real bug, 2026-08-27 (test 4.2): a macro step can mutate the page
    # (select a react-select value, open then "close" a listbox) without ever
    # changing page.url, and none of that is cookies/localStorage — it's live
    # React/DOM state this checkpoint was never able to capture or restore. Skipping
    # the reload here left a caller (react_loop._try_macro_fast_path) handing off to
    # a fresh decision loop that inherited a half-mutated page with no explanation,
    # which then burned its whole turn budget looking for elements a real reload
    # would have simply put back.
    if checkpoint.url and hasattr(page, "goto"):
        try:
            await page.goto(checkpoint.url, wait_until="domcontentloaded", timeout=15000)
        except Exception as err:
            logger.warning(f"effector-rollback: navigation rollback failed — {err}")
            return False

    # 3. Restore localStorage entries
    if checkpoint.local_storage and hasattr(page, "evaluate"):
        try:
            await page.evaluate(
                r"""(data) => {
                    try {
                        localStorage.clear();
                        for (const [k, v] of Object.entries(data)) {
                            localStorage.setItem(k, v);
                        }
                    } catch (e) {}
                }""",
                checkpoint.local_storage,
            )
        except Exception as err:
            logger.debug(f"effector-rollback: localStorage restore error — {err}")

    return True


class SpeculativeScope:
    """Context manager for speculative execution with automatic rollback on error/failure."""

    def __init__(self, page: Any, context: Any = None):
        self._page = page
        self._context = context
        self._checkpoint: EphemeralTabCheckpoint | None = None
        self.rolled_back: bool = False

    async def __aenter__(self) -> "SpeculativeScope":
        self._checkpoint = await capture_tab_checkpoint(self._page, self._context)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        if exc_type is not None:
            logger.warning(f"effector-rollback: speculative branch raised {exc_type.__name__}: {exc_val} — initiating rollback")
            if self._checkpoint:
                await restore_tab_checkpoint(self._page, self._checkpoint, self._context)
                self.rolled_back = True
            return False  # propagate exception unless explicitly suppressed
        return False

    async def rollback(self) -> bool:
        """Explicitly trigger rollback if speculative branch outcome was unsatisfactory."""
        if self._checkpoint:
            success = await restore_tab_checkpoint(self._page, self._checkpoint, self._context)
            self.rolled_back = True
            return success
        return False
