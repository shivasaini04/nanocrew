"""Can the effector actually LOAD a page? (production default: stealth=True)

Kept in its own module deliberately. `test_effector_stealth_live_browser.py` drives a
SYNC Playwright browser from a module-scoped fixture, and running an async
EffectorSession test alongside it makes the two fight over the event loop.

This is the check whose absence let a total outage ship on 2026-08-31. R4 armed
Target.setAutoAttach with waitForDebuggerOnStart=True; Chromium then pauses every new
target until Runtime.runIfWaitingForDebugger reaches that target's OWN session, which a
Playwright browser-level CDPSession cannot send. The pause was permanent, so page.goto()
timed out on every URL — under the production default.

Every probe written to "verify" that feature used about:blank or data: URLs driven
through page.evaluate. Those never need the target released, so the whole stack looked
healthy while it could not load a single page. The unit tests asserted
waitForDebuggerOnStart=True and so encoded the bug rather than catching it.
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_effector_session_can_load_a_page_with_stealth_on():
    """A REAL navigation through the production path, not page.evaluate on about:blank.

    A data: URL is enough — the bug was in target lifecycle, not the network — which
    keeps this runnable in an offline CI image.
    """
    pytest.importorskip("playwright.async_api")

    from nanoagent.agent.effector.browser_session import EffectorSession

    session = EffectorSession(".", headless=True, stealth=True)
    try:
        entered = await session.__aenter__()
    except Exception as err:
        # No Chromium on this machine (dev box without `playwright install`).
        pytest.skip(f"no Chromium available for EffectorSession: {err}")

    try:
        await entered.page.goto(
            "data:text/html,<title>loaded</title><h1>ok</h1>", timeout=20000,
        )
        title = await entered.page.title()
    finally:
        await session.__aexit__(None, None, None)

    assert title == "loaded", (
        "the page never finished loading under stealth=True — check that "
        "waitForDebuggerOnStart is not pausing targets again"
    )
