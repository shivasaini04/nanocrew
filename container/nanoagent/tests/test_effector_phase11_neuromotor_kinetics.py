"""Phase 11: Verification tests for Neuromotor Human Biometrics (Fitts' Law & QWERTY Flight Physics).

Tests physical QWERTY distance digraph flight timing, Fitts' law velocity pacing,
micro-tremor Gaussian hand oscillations, and endpoint accuracy.
"""

from __future__ import annotations

import math
import pytest

from nanoagent.agent.effector.stealth.kinetics import (
    Point,
    calculate_digraph_flight_delay,
    generate_neuromotor_trajectory,
    get_key_coordinate,
)


def test_digraph_flight_timing_reflects_qwerty_distance():
    """Verify that adjacent keys on QWERTY take less average flight time than distant keys."""
    # Measure sample averages across 50 simulated keystrokes
    trials = 50
    adjacent_delays = [calculate_digraph_flight_delay('a', 's', min_delay_ms=30, max_delay_ms=100) for _ in range(trials)]
    distant_delays = [calculate_digraph_flight_delay('q', 'p', min_delay_ms=30, max_delay_ms=100) for _ in range(trials)]

    avg_adjacent = sum(adjacent_delays) / trials
    avg_distant = sum(distant_delays) / trials

    # Distant keys ('q' -> 'p') across the keyboard span should take measurably longer
    assert avg_distant > avg_adjacent
    assert min(adjacent_delays) >= 10
    assert max(distant_delays) <= 250


def test_neuromotor_trajectory_starts_and_ends_at_exact_coordinates():
    """Verify trajectory preserves precise pixel coordinates for start and target."""
    start = Point(100.0, 200.0)
    end = Point(850.0, 640.0)

    traj = generate_neuromotor_trajectory(start, end, steps=20)

    assert len(traj) >= 10
    assert traj[0] == Point(100, 200)
    assert traj[-1] == Point(850, 640)


def test_neuromotor_trajectory_short_hop_is_direct():
    """Verify micro-movements under 5px do not generate excessive control points."""
    start = Point(50.0, 50.0)
    end = Point(52.0, 53.0)

    traj = generate_neuromotor_trajectory(start, end)
    assert len(traj) == 2
    assert traj[0] == Point(50, 50)
    assert traj[1] == Point(52, 53)


def test_neuromotor_trajectory_deceleration_and_jitter():
    """Verify trajectory has S-curve velocity variation and non-linear path progression."""
    start = Point(0.0, 0.0)
    end = Point(600.0, 400.0)

    traj = generate_neuromotor_trajectory(start, end, steps=24)

    # Compute step deltas
    deltas = [
        math.hypot(traj[i + 1].x - traj[i].x, traj[i + 1].y - traj[i].y)
        for i in range(len(traj) - 1)
    ]

    # Max step delta in the middle should be larger than the final deceleration step near target
    mid_delta = max(deltas)
    final_delta = deltas[-1]
    assert mid_delta > final_delta


def test_get_key_coordinate_maps_physical_rows():
    """Verify physical key layout positioning."""
    num_1 = get_key_coordinate('1')
    key_q = get_key_coordinate('q')
    key_a = get_key_coordinate('a')
    key_z = get_key_coordinate('z')
    space = get_key_coordinate(' ')

    # Row checks: Row 0 (numbers) < Row 1 ('q') < Row 2 ('a') < Row 3 ('z') < Row 4 (' ')
    assert num_1[0] < key_q[0]
    assert key_q[0] < key_a[0]
    assert key_a[0] < key_z[0]
    assert key_z[0] < space[0]
