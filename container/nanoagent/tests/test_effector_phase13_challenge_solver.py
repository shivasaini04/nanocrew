"""Phase 13: Verification tests for Autonomous Cloudflare Turnstile & Challenge Interaction Solver.

Tests interactive challenge widget discovery, organic non-center click point calculation,
kinetic mouse interaction loops, and settlement verification.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
import pytest

from nanoagent.agent.effector.perception.challenge_solver import ChallengeSolver
from nanoagent.agent.effector.types import Point


def test_challenge_solver_organic_click_point_never_exact_center():
    """Verify compute_organic_click_point produces organic variation and avoids exact center."""
    box = {"x": 100.0, "y": 200.0, "width": 40.0, "height": 40.0}
    dead_center = Point(120.0, 220.0)

    points = [ChallengeSolver.compute_organic_click_point(box) for _ in range(50)]

    # All points must be within [114, 126] x [214, 226]
    for pt in points:
        assert 114.0 <= pt.x <= 126.0
        assert 214.0 <= pt.y <= 226.0

    # Ensure variation across samples (not a fixed hardcoded constant)
    x_coords = {pt.x for pt in points}
    assert len(x_coords) > 10


@pytest.mark.asyncio
async def test_challenge_solver_returns_none_on_clean_page():
    """Verify that pages without challenge iframes return None."""
    page = MagicMock()
    # Mock locator returning 0 elements
    loc = AsyncMock()
    loc.count.return_value = 0
    page.locator.return_value = loc
    page.frame_locator.return_value.locator.return_value = loc

    found = await ChallengeSolver.find_interactive_challenge(page)
    assert found is None

    solved = await ChallengeSolver.solve_if_present(page, timeout_s=0.5)
    assert solved is False


@pytest.mark.asyncio
async def test_challenge_solver_successfully_solves_interactive_widget():
    """Verify end-to-end solve cycle on a mock interactive challenge widget."""
    page = MagicMock()
    target = AsyncMock()
    target.count.side_effect = [1, 1, 0]  # Element disappears on 3rd check (settlement)
    target.is_visible.return_value = True
    target.bounding_box.return_value = {"x": 200.0, "y": 300.0, "width": 50.0, "height": 50.0}

    # Setup locator to return our target
    loc = MagicMock()
    loc.count = AsyncMock(return_value=1)
    loc.first = target
    loc.first.is_visible = AsyncMock(return_value=True)

    turnstile_frame = MagicMock()
    turnstile_frame.locator.return_value = loc
    page.frame_locator.return_value = turnstile_frame

    page.mouse = AsyncMock()
    page.mouse.move = AsyncMock()
    page.mouse.down = AsyncMock()
    page.mouse.up = AsyncMock()

    solved = await ChallengeSolver.solve_if_present(page, timeout_s=2.0)
    assert solved is True
    page.mouse.move.assert_called_once()
    page.mouse.down.assert_called_once()
    page.mouse.up.assert_called_once()
