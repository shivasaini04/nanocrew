"""Phase 14: Verification tests for CDP Target Auto-Attach & Lifecycle Interception Rings.

Tests Target.setAutoAttach configuration, pre-execution stealth script injection,
debugger unpausing, and multi-target tracking.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
import pytest

from nanoagent.agent.effector.lifecycle.cdp_target_interceptor import CDPTargetInterceptor


@pytest.mark.asyncio
async def test_target_interceptor_enables_auto_attach():
    """Verify enable_auto_attach sends the correct CDP command.

    waitForDebuggerOnStart is FALSE: measured live 2026-08-31, pausing targets hung
    every navigation because nothing in this stack can release them. See
    test_auto_attach_never_pauses_targets for the full account.
    """
    cdp_session = MagicMock()
    cdp_session.send = AsyncMock(return_value={})
    cdp_session.on = MagicMock()

    interceptor = CDPTargetInterceptor(init_script="console.log('stealth');")
    res = await interceptor.enable_auto_attach(cdp_session)

    assert res is True
    assert interceptor.is_active is True
    cdp_session.send.assert_called_once_with(
        "Target.setAutoAttach",
        {
            "autoAttach": True,
            "waitForDebuggerOnStart": False,
            "flatten": True,
        },
    )
    cdp_session.on.assert_called_once_with("Target.attachedToTarget", pytest.approx(cdp_session.on.call_args[0][1]))


@pytest.mark.asyncio
async def test_target_interceptor_injects_script_and_unpauses():
    """Verify attached target receives script injection and debugger unpause."""
    cdp_session = MagicMock()
    cdp_session.send = AsyncMock(return_value={})

    interceptor = CDPTargetInterceptor(
        init_script="window.__STEALTH__ = true;",
        user_agent_override={"userAgent": "CustomUA/1.0"},
    )

    event = {
        "sessionId": "sess_123",
        "targetInfo": {
            "targetId": "target_999",
            "type": "page",
            "url": "https://example.com/popup",
        },
        "waitingForDebugger": True,
    }

    await interceptor._on_target_attached(cdp_session, event)

    assert "target_999" in interceptor.attached_targets

    # Verify calls to send: Network override, Page script, Runtime unpause
    calls = [call[0][0] for call in cdp_session.send.call_args_list]
    assert "Network.setUserAgentOverride" in calls
    assert "Page.addScriptToEvaluateOnNewDocument" in calls
    assert "Runtime.runIfWaitingForDebugger" in calls


@pytest.mark.asyncio
async def test_target_interceptor_detach_cleans_up():
    """Verify detach_all resets state and disables autoAttach."""
    cdp_session = MagicMock()
    cdp_session.send = AsyncMock(return_value={})

    interceptor = CDPTargetInterceptor()
    interceptor._is_active = True
    interceptor._attached_targets.add("target_1")

    await interceptor.detach_all(cdp_session)

    assert interceptor.is_active is False
    assert len(interceptor.attached_targets) == 0
    cdp_session.send.assert_called_once_with(
        "Target.setAutoAttach",
        {"autoAttach": False, "waitForDebuggerOnStart": False, "flatten": True},
    )
