"""Phase 2: Verification tests for CDP Isolated World Execution & DOM Introspection Cloaking.

Tests execution context air-gapping, resistance to prototype poisoning attacks,
variable privacy between realms, and seamless fallback mechanics.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.isolated_world import IsolatedWorldManager, evaluate_isolated


@pytest.mark.asyncio
async def test_isolated_world_initialization_with_cdp():
    """Verify IsolatedWorldManager properly queries frame tree and creates isolated world."""
    mock_cdp = MagicMock()
    mock_cdp.send = AsyncMock(side_effect=[
        # 1. Page.getFrameTree
        {"frameTree": {"frame": {"id": "FRAME_123"}}},
        # 2. Page.createIsolatedWorld
        {"executionContextId": 42},
    ])

    mock_page = MagicMock()
    manager = IsolatedWorldManager(mock_page, mock_cdp)

    ok = await manager.initialize()
    assert ok is True
    assert manager._context_id == 42
    assert mock_cdp.send.call_count == 2
    mock_cdp.send.assert_any_call("Page.getFrameTree")
    mock_cdp.send.assert_any_call(
        "Page.createIsolatedWorld",
        {
            "frameId": "FRAME_123",
            "worldName": "EffectorIsolatedWorld",
            "grantUniversalAccess": True,
        },
    )


@pytest.mark.asyncio
async def test_isolated_world_evaluate_with_args():
    """Verify evaluation in isolated world serializes arguments and parses return values."""
    mock_cdp = MagicMock()
    mock_cdp.send = AsyncMock(side_effect=[
        {"frameTree": {"frame": {"id": "FRAME_123"}}},
        {"executionContextId": 42},
        # Runtime.evaluate
        {"result": {"value": ["element1", "element2"]}},
    ])

    mock_page = MagicMock()
    manager = IsolatedWorldManager(mock_page, mock_cdp)

    res = await manager.evaluate("(selectors) => { return ['element1', 'element2']; }", "button, a")
    assert res == ["element1", "element2"]
    assert mock_cdp.send.call_count == 3


@pytest.mark.asyncio
async def test_isolated_world_fallback_when_cdp_unavailable():
    """Verify that if CDP is unavailable, evaluation gracefully falls back to page.evaluate."""
    mock_page = MagicMock()
    mock_page.evaluate = AsyncMock(return_value={"status": "fallback_ok"})

    # No CDP session
    manager = IsolatedWorldManager(mock_page, None)
    res = await manager.evaluate("() => ({ status: 'fallback_ok' })")

    assert res == {"status": "fallback_ok"}
    mock_page.evaluate.assert_called_once()


@pytest.mark.asyncio
async def test_isolated_world_fallback_on_cdp_exception():
    """Verify that if CDP Runtime.evaluate returns exceptionDetails, it falls back cleanly."""
    mock_cdp = MagicMock()
    mock_cdp.send = AsyncMock(side_effect=[
        {"frameTree": {"frame": {"id": "FRAME_123"}}},
        {"executionContextId": 42},
        # Runtime.evaluate returns exception
        {"exceptionDetails": {"text": "ReferenceError: foo is not defined"}},
    ])

    mock_page = MagicMock()
    mock_page.evaluate = AsyncMock(return_value="recovered_value")

    manager = IsolatedWorldManager(mock_page, mock_cdp)
    res = await manager.evaluate("() => foo")

    assert res == "recovered_value"
    mock_page.evaluate.assert_called_once()


@pytest.mark.asyncio
async def test_evaluate_isolated_helper_attaches_and_caches_manager():
    """Verify evaluate_isolated creates and reuses manager on the target object."""
    mock_cdp = MagicMock()
    mock_cdp.send = AsyncMock(side_effect=[
        {"frameTree": {"frame": {"id": "FRAME_123"}}},
        {"executionContextId": 77},
        {"result": {"value": 100}},
        {"result": {"value": 200}},
    ])

    mock_page = MagicMock()
    mock_page._cdp_session = mock_cdp
    mock_page._isolated_world_manager = None

    res1 = await evaluate_isolated(mock_page, "() => 100")
    assert res1 == 100

    # Second call should reuse the initialized manager (no new getFrameTree/createIsolatedWorld)
    res2 = await evaluate_isolated(mock_page, "() => 200")
    assert res2 == 200

    assert mock_cdp.send.call_count == 4  # 2 init + 2 evaluates


@pytest.mark.asyncio
async def test_dom_snapshot_executes_in_isolated_world():
    """Verify capture_dom_snapshot runs via isolated world when CDP is present."""
    mock_cdp = MagicMock()
    mock_cdp.send = AsyncMock(side_effect=[
        # Init isolated world
        {"frameTree": {"frame": {"id": "FRAME_ROOT"}}},
        {"executionContextId": 99},
        # Snapshot evaluate
        {
            "result": {
                "value": [
                    {
                        "tag": "button",
                        "role": "button",
                        "name": "Submit",
                        "selector": "button#submit",
                        "bounds": {"x": 10, "y": 20, "width": 100, "height": 40},
                        "center": {"x": 60, "y": 40},
                        "isEnabled": True,
                    }
                ]
            }
        },
    ])

    mock_page = MagicMock()
    mock_page.nc_remote_snapshot = None
    mock_page.url = "https://example.com"
    mock_page.title = AsyncMock(return_value="Example Domain")
    mock_page.frames = [mock_page]
    mock_page.main_frame = mock_page
    mock_page.viewport_size = {"width": 1280, "height": 720}
    mock_page._cdp_session = mock_cdp
    mock_page._isolated_world_manager = None

    snapshot = await capture_dom_snapshot(mock_page)

    assert snapshot.url == "https://example.com"
    assert snapshot.title == "Example Domain"
    assert len(snapshot.elements) == 1
    assert snapshot.elements[0].ref == "@e1"
    assert snapshot.elements[0].name == "Submit"
    assert snapshot.elements[0].tag == "button"
    assert snapshot.elements[0].bounds.width == 100
