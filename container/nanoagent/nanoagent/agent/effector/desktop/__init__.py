"""Phase 3 of the Effector port — native desktop OS automation. Windows/macOS
branches are ported from computer-use/desktop-driver.ts + desktop-vision.ts for the
standalone `nanoagent-ai` CLI (same standalone-vs-container split as the cron tool —
see reference_dead_agent_tools memory). Linux is new: the TS original's only working
path was Windows PowerShell, which the actual prod container (headless Linux, no
PowerShell, no GUI) cannot run — see stage43 doc 03 phase-3 discussion, 2026-08-23.
xvfb_session.py provides the virtual display the Linux path needs.
"""

from nanoagent.agent.effector.desktop.xvfb_session import (
    ensure_authenticated_virtual_display,
    ensure_virtual_display,
    is_virtual_display_running,
    setup_xauth_cookie,
    stop_virtual_display,
)

__all__ = [
    "ensure_authenticated_virtual_display",
    "ensure_virtual_display",
    "is_virtual_display_running",
    "setup_xauth_cookie",
    "stop_virtual_display",
]
