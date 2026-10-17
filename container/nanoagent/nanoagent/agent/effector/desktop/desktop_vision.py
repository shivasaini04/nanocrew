"""Ported from computer-use/desktop-vision.ts. Locates a GUI element on the desktop
screen via a vision-capable LLM, then dispatches a native click at that location.

Reuses the caller-supplied vision provider/model (the same `_vision_provider`/
`_vision_model` loop.py already resolves for `read_image` and the browser resolver's
vision fallback) instead of the TS original's own `getVisionModel()` — see resolver.py
for the established pattern. `os_visual_click`'s Linux path is new capability: the TS
original's click only ever worked on Windows (P/Invoke via user32.dll); it returned
False on every other platform. See desktop_driver.py's module docstring for why Linux
needed a real implementation here.
"""

from __future__ import annotations

import base64
import json
import os
import platform
import re
import subprocess

from loguru import logger

from nanoagent.agent.effector.desktop.desktop_driver import capture_desktop_screenshot, get_display_metrics
from nanoagent.agent.effector.desktop.xvfb_session import ensure_virtual_display
from nanoagent.agent.effector.types import Point


class VisualGroundingResult:
    def __init__(self, x: float, y: float, confidence: float, description: str):
        self.x = x
        self.y = y
        self.confidence = confidence
        self.description = description


async def ground_visual_element(
    instruction: str,
    provider=None,
    vision_model: str | None = None,
    screenshot_base64: str | None = None,
    usage_totals: dict | None = None,
) -> VisualGroundingResult | None:
    """Locate a GUI element on the desktop screen using vision-model perception."""
    screenshot = screenshot_base64 or (await capture_desktop_screenshot())
    metrics = await get_display_metrics()

    if not screenshot:
        logger.warning("effector desktop-vision: no screenshot available for grounding")
        return None

    if provider is None or not vision_model:
        # Fallback: heuristic center-screen coordinate — same contract as the TS
        # original's "no model configured" branch.
        return VisualGroundingResult(
            x=round(metrics.width / 2), y=round(metrics.height / 2),
            confidence=0.5, description=f"Default center fallback for: {instruction}",
        )

    prompt = (
        f'You are an expert GUI grounding visual AI.\nTARGET: "{instruction}"\n'
        f"SCREEN RESOLUTION: {metrics.width}x{metrics.height}\n\n"
        "Examine the screenshot and identify the exact center pixel coordinates (x, y) "
        "of the target element.\nReturn ONLY valid JSON matching this schema:\n"
        '{"x": number, "y": number, "confidence": number, "description": "brief description of located element"}'
    )

    try:
        response = await provider.chat(
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot}"}},
                ],
            }],
            model=vision_model,
            max_tokens=200,
        )
        if usage_totals is not None:
            from nanoagent.agent.effector.types import accumulate_usage
            accumulate_usage(usage_totals, response.usage)
        cleaned = re.sub(r"```(?:json)?\n?", "", response.content or "").replace("```", "").strip()
        parsed = json.loads(cleaned)

        return VisualGroundingResult(
            x=max(0, min(metrics.width, round(parsed["x"]))),
            y=max(0, min(metrics.height, round(parsed["y"]))),
            confidence=float(parsed.get("confidence") or 0.8),
            description=parsed.get("description", instruction),
        )
    except Exception as err:
        logger.warning(f"effector desktop-vision: failed to visually ground element — {err}")
        return None


async def os_visual_click(instruction: str, provider=None, vision_model: str | None = None, usage_totals: dict | None = None) -> bool:
    """Visually locate an element on the desktop screen and dispatch a native click."""
    result = await ground_visual_element(instruction, provider, vision_model, usage_totals=usage_totals)
    if not result:
        return False

    system = platform.system()

    if system == "Windows":
        try:
            script = f"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point({result.x}, {result.y})
$sig = @'
[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
'@
$type = Add-Type -MemberDefinition $sig -Name "Win32Mouse" -Namespace "Win32" -PassThru
[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
"""
            subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, timeout=10)
            return True
        except Exception:
            return False

    if system == "Darwin":
        return False  # TS original had no macOS click implementation either

    # Linux — new capability (the TS original never supported this on any non-Windows platform).
    try:
        display = ensure_virtual_display()
        if not display:
            return False
        env = {**os.environ, "DISPLAY": display}
        proc = subprocess.run(
            ["xdotool", "mousemove", str(result.x), str(result.y), "click", "1"],
            capture_output=True, timeout=5, env=env,
        )
        return proc.returncode == 0
    except Exception:
        return False
