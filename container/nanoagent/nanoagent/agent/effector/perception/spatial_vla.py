"""Multimodal Canvas & Spatial VLA Grounding Engine for Effector.

Resolves coordinate-level actions on non-DOM, WebGL, Canvas, and spreadsheet
interfaces (e.g. Google Sheets, Figma, Tableau, Miro, Salesforce Canvas) using
Set-of-Marks (SoM) overlays and deterministic spatial grid geometry.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from nanoagent.agent.effector.types import Bounds, Point


@dataclass
class SpatialVisualMarker:
    mark_id: int
    label: str
    bounds: Bounds
    center: Point
    confidence: float = 1.0


_GRID_CELL_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def parse_grid_cell_coordinate(
    cell_ref: str,
    origin_x: int = 50,
    origin_y: int = 100,
    col_width: int = 100,
    row_height: int = 24,
) -> Point | None:
    """Translate a spreadsheet/grid cell identifier (e.g. 'A1', 'B4', 'AA10') into
    canvas pixel center coordinates."""
    m = _GRID_CELL_RE.match(cell_ref.strip())
    if not m:
        return None

    col_str, row_str = m.group(1).upper(), m.group(2)
    row_idx = int(row_str) - 1

    # Convert column letters to 0-indexed column integer (A=0, B=1, ... Z=25, AA=26)
    col_idx = 0
    for char in col_str:
        col_idx = col_idx * 26 + (ord(char) - ord("A") + 1)
    col_idx -= 1

    center_x = origin_x + (col_idx * col_width) + (col_width // 2)
    center_y = origin_y + (row_idx * row_height) + (row_height // 2)
    return Point(x=center_x, y=center_y)


_PERCENT_COORD_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*,\s*(\d+(?:\.\d+)?)\s*%")
_PIXEL_COORD_RE = re.compile(r"(\d+)\s*,\s*(\d+)")


def ground_canvas_coordinates(
    target: str,
    viewport_width: int = 1280,
    viewport_height: int = 720,
    canvas_bounds: Bounds | None = None,
) -> Point | None:
    """Resolve a target string describing a spatial region or coordinate to an exact Point.
    
    Supports:
    - Percentage coordinates: "50%, 50%" or "25%x, 75%y"
    - Exact pixel coordinates: "640, 360" or "point(640, 360)"
    - Grid cell notation: "cell:B4" or "grid:A1"
    - Relative named regions: "center", "top_left", "bottom_right"
    """
    clean = target.strip().lower()

    # 1. Check percentage coordinates
    m_pct = _PERCENT_COORD_RE.search(clean)
    if m_pct:
        pct_x = float(m_pct.group(1)) / 100.0
        pct_y = float(m_pct.group(2)) / 100.0
        if canvas_bounds:
            x = canvas_bounds.x + (canvas_bounds.width * pct_x)
            y = canvas_bounds.y + (canvas_bounds.height * pct_y)
        else:
            x = viewport_width * pct_x
            y = viewport_height * pct_y
        return Point(x=round(x), y=round(y))

    # 2. Check grid cell coordinates
    if clean.startswith("cell:") or clean.startswith("grid:"):
        ref = clean.split(":", 1)[1].strip()
        orig_x = int(canvas_bounds.x) if canvas_bounds else 50
        orig_y = int(canvas_bounds.y) if canvas_bounds else 100
        return parse_grid_cell_coordinate(ref, origin_x=orig_x, origin_y=orig_y)

    # 3. Check exact pixel coordinates
    m_px = _PIXEL_COORD_RE.search(clean)
    if m_px:
        return Point(x=int(m_px.group(1)), y=int(m_px.group(2)))

    # 4. Check relative named regions
    base_w = canvas_bounds.width if canvas_bounds else viewport_width
    base_h = canvas_bounds.height if canvas_bounds else viewport_height
    offset_x = canvas_bounds.x if canvas_bounds else 0
    offset_y = canvas_bounds.y if canvas_bounds else 0

    regions = {
        "center": Point(x=round(offset_x + base_w / 2), y=round(offset_y + base_h / 2)),
        "top_left": Point(x=round(offset_x + base_w * 0.1), y=round(offset_y + base_h * 0.1)),
        "top_right": Point(x=round(offset_x + base_w * 0.9), y=round(offset_y + base_h * 0.1)),
        "bottom_left": Point(x=round(offset_x + base_w * 0.1), y=round(offset_y + base_h * 0.9)),
        "bottom_right": Point(x=round(offset_x + base_w * 0.9), y=round(offset_y + base_h * 0.9)),
    }
    return regions.get(clean)


def generate_set_of_marks_overlay(marks: list[SpatialVisualMarker]) -> str:
    """Generate client-side JavaScript that renders Set-of-Mark visual bounding boxes
    and high-contrast numeric labels over the page for multimodal visual grounding."""
    mark_objs = [
        {
            "id": m.mark_id,
            "label": m.label,
            "x": m.bounds.x,
            "y": m.bounds.y,
            "w": m.bounds.width,
            "h": m.bounds.height,
        }
        for m in marks
    ]

    return f"""(() => {{
      const existing = document.getElementById('effector-som-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'effector-som-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';

      const marks = {mark_objs};
      marks.forEach(m => {{
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${{m.x}}px;top:${{m.y}}px;width:${{m.w}}px;height:${{m.h}}px;border:2px solid #ef4444;box-sizing:border-box;background:rgba(239,68,68,0.08);`;

        const tag = document.createElement('span');
        tag.textContent = `${{m.id}}`;
        tag.style.cssText = 'position:absolute;top:-18px;left:-2px;background:#ef4444;color:#ffffff;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:2px;font-family:sans-serif;';
        box.appendChild(tag);
        overlay.appendChild(box);
      }});

      document.body.appendChild(overlay);
    }})();"""
