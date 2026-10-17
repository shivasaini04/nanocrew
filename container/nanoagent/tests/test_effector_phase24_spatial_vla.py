"""Unit tests for Phase 24: Spatial VLA & Canvas Coordinate Grounding."""

import pytest
from nanoagent.agent.effector.perception.spatial_vla import (
    SpatialVisualMarker,
    generate_set_of_marks_overlay,
    ground_canvas_coordinates,
    parse_grid_cell_coordinate,
)
from nanoagent.agent.effector.types import Bounds, Point


def test_parse_grid_cell_coordinate():
    # A1: col 0, row 0 -> center at x=50+50=100, y=100+12=112
    pt_a1 = parse_grid_cell_coordinate("A1", origin_x=50, origin_y=100, col_width=100, row_height=24)
    assert pt_a1 is not None
    assert pt_a1.x == 100
    assert pt_a1.y == 112

    # B2: col 1, row 1 -> center at x=50+100+50=200, y=100+24+12=136
    pt_b2 = parse_grid_cell_coordinate("B2", origin_x=50, origin_y=100, col_width=100, row_height=24)
    assert pt_b2 is not None
    assert pt_b2.x == 200
    assert pt_b2.y == 136

    # AA1: col 26
    pt_aa1 = parse_grid_cell_coordinate("AA1", origin_x=0, origin_y=0, col_width=10, row_height=10)
    assert pt_aa1 is not None
    assert pt_aa1.x == 265


def test_ground_canvas_coordinates_percentages_and_pixels():
    # Percentage
    pt_pct = ground_canvas_coordinates("50%, 50%", viewport_width=1000, viewport_height=800)
    assert pt_pct == Point(x=500, y=400)

    # Pixel coordinates
    pt_px = ground_canvas_coordinates("320, 240")
    assert pt_px == Point(x=320, y=240)

    # Named regions
    pt_center = ground_canvas_coordinates("center", viewport_width=1000, viewport_height=800)
    assert pt_center == Point(x=500, y=400)


def test_generate_set_of_marks_overlay():
    marks = [
        SpatialVisualMarker(mark_id=1, label="Button", bounds=Bounds(x=10, y=20, width=80, height=30), center=Point(x=50, y=35)),
        SpatialVisualMarker(mark_id=2, label="Input", bounds=Bounds(x=10, y=60, width=200, height=30), center=Point(x=110, y=75)),
    ]
    js = generate_set_of_marks_overlay(marks)
    assert "effector-som-overlay" in js
    assert "2147483647" in js
    assert "Button" in js
