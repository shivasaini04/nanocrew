"""Ported from computer-use/waitfor.ts."""

from __future__ import annotations

from nanoagent.agent.effector.types import WaitForSpec


async def apply_wait_for(page, wait_for: WaitForSpec) -> None:
    """Wait for an element to reach the specified state before proceeding."""
    timeout = wait_for.timeout or 10000
    state = wait_for.state or "visible"

    if wait_for.selector:
        await page.wait_for_selector(wait_for.selector, state=state, timeout=timeout)
        return

    # No selector specified — just wait for the page to be stable.
    await page.wait_for_load_state("domcontentloaded", timeout=timeout)


async def wait_for_navigation(page, timeout: int = 5000) -> None:
    """Wait for navigation to complete after an action. Best-effort: networkidle can
    time out on SPAs that keep a connection open — that's fine, content already loaded."""
    try:
        await page.wait_for_load_state("networkidle", timeout=timeout)
    except Exception:
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=2000)
        except Exception:
            pass  # best effort


async def wait_for_url_change(page, current_url: str, timeout: int = 5000) -> bool:
    """Wait for the URL to change away from current_url."""
    try:
        await page.wait_for_function(
            "(url) => window.location.href !== url", arg=current_url, timeout=timeout,
        )
        return True
    except Exception:
        return False
