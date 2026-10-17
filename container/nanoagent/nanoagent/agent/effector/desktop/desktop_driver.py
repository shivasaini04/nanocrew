"""Ported from computer-use/desktop-driver.ts, plus a real Linux implementation.

The TS original's only working code path was Windows PowerShell — every real
capability gated on `platform === 'win32'`, shelling out to `powershell -NoProfile
-Command ...` for screen capture (System.Drawing), clipboard (Get-Clipboard/
Set-Clipboard), and later mouse control via user32.dll P/Invoke (desktop_vision.py).
The macOS/Linux branches in the original returned static fallbacks or shelled out to
tools (`screencapture`, `pbcopy`/`pbpaste`, `xclip`) that still assume a running GUI
session.

The actual prod container (`container/Dockerfile`) is headless Linux with no
PowerShell and no GUI at all — none of the original's real logic could ever execute
there. Founder decision (stage43 doc 03 phase 3, 2026-08-23): add a real Linux
implementation via a lazily-started virtual display (xvfb_session.py) + xdotool/
scrot/xclip, rather than porting dead code. Windows/macOS branches are still ported
in full, unmodified in behavior, for the standalone `nanoagent-ai` CLI running on an
actual desktop OS — same split as the cron tool (see reference_dead_agent_tools
memory). Linux support itself is new capability beyond the TS original, which had
none (its own osVisualClick returned False on every non-Windows platform).
"""

from __future__ import annotations

import base64
import json
import os
import platform
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

from nanoagent.agent.effector.desktop.xvfb_session import ensure_virtual_display


@dataclass
class DisplayMetrics:
    width: int
    height: int
    scale_factor: float
    platform: str


def _run(cmd: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _run_ps(script: str, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(["powershell", "-NoProfile", "-Command", script],
                           capture_output=True, text=True, timeout=timeout)


async def get_display_metrics() -> DisplayMetrics:
    system = platform.system()

    if system == "Windows":
        try:
            ps = ("Add-Type -AssemblyName System.Windows.Forms; "
                  "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json")
            proc = _run_ps(ps)
            bounds = json.loads(proc.stdout)
            return DisplayMetrics(width=bounds.get("Width", 1920), height=bounds.get("Height", 1080),
                                   scale_factor=1.0, platform=system)
        except Exception:
            return DisplayMetrics(width=1920, height=1080, scale_factor=1.0, platform=system)

    if system == "Darwin":
        # TS original had no real macOS metrics implementation either — same static fallback.
        return DisplayMetrics(width=1920, height=1080, scale_factor=1.0, platform=system)

    # Linux — the actual container path.
    display = ensure_virtual_display()
    if not display:
        return DisplayMetrics(width=1920, height=1080, scale_factor=1.0, platform=system)
    try:
        env = {**os.environ, "DISPLAY": display}
        proc = subprocess.run(["xdotool", "getdisplaygeometry"], capture_output=True, text=True, timeout=5, env=env)
        w, h = proc.stdout.strip().split()
        return DisplayMetrics(width=int(w), height=int(h), scale_factor=1.0, platform=system)
    except Exception as err:
        logger.debug(f"effector desktop: getdisplaygeometry failed — {err}")
        return DisplayMetrics(width=1920, height=1080, scale_factor=1.0, platform=system)


async def capture_desktop_screenshot() -> str:
    """Returns a base64-encoded PNG of the desktop, or '' if unavailable."""
    system = platform.system()
    tmp_file = Path(tempfile.gettempdir()) / f"effector-desktop-snap-{int(time.time() * 1000)}.png"

    try:
        if system == "Windows":
            escaped = str(tmp_file).replace("\\", "\\\\")
            script = (
                '[System.Reflection.Assembly]::LoadWithPartialName("System.Drawing") | Out-Null; '
                '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; '
                '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; '
                '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height; '
                '$g = [System.Drawing.Graphics]::FromImage($bmp); '
                '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); '
                f'$bmp.Save("{escaped}", [System.Drawing.Imaging.ImageFormat]::Png); '
                '$g.Dispose(); $bmp.Dispose();'
            )
            _run_ps(script)

        elif system == "Darwin":
            _run(["screencapture", "-x", str(tmp_file)])

        else:
            display = ensure_virtual_display()
            if not display:
                return ""
            env = {**os.environ, "DISPLAY": display}
            subprocess.run(["scrot", "--overwrite", str(tmp_file)], capture_output=True, timeout=10, env=env)

        if tmp_file.exists():
            data = tmp_file.read_bytes()
            tmp_file.unlink()
            return base64.b64encode(data).decode()
        return ""
    except Exception as err:
        logger.warning(f"effector desktop: failed to capture desktop screenshot — {err}")
        return ""


async def read_system_clipboard() -> str:
    system = platform.system()
    try:
        if system == "Windows":
            proc = _run_ps("Get-Clipboard")
            return proc.stdout.strip()
        if system == "Darwin":
            proc = _run(["pbpaste"])
            return proc.stdout
        display = ensure_virtual_display()
        if not display:
            return ""
        env = {**os.environ, "DISPLAY": display}
        proc = subprocess.run(["xclip", "-selection", "clipboard", "-o"], capture_output=True, text=True, timeout=5, env=env)
        return proc.stdout
    except Exception:
        return ""


async def write_system_clipboard(text: str) -> bool:
    system = platform.system()
    try:
        if system == "Windows":
            escaped = text.replace('"', '`"')
            _run_ps(f'Set-Clipboard -Value "{escaped}"')
            return True
        if system == "Darwin":
            proc = subprocess.run(["pbcopy"], input=text, text=True, timeout=5)
            return proc.returncode == 0
        display = ensure_virtual_display()
        if not display:
            return False
        env = {**os.environ, "DISPLAY": display}
        proc = subprocess.run(["xclip", "-selection", "clipboard"], input=text, text=True, timeout=5, env=env)
        return proc.returncode == 0
    except Exception:
        return False


_WIN_KEY_MAP = {
    "control+": "^", "alt+": "%", "shift+": "+",
    "enter": "{ENTER}", "tab": "{TAB}", "esc": "{ESC}",
}


async def send_desktop_hotkey(keys: str) -> bool:
    """Send a hotkey combo like 'Control+a' to the desktop's focused window."""
    system = platform.system()

    if system == "Windows":
        try:
            formatted = keys
            for pattern, repl in _WIN_KEY_MAP.items():
                import re
                formatted = re.sub(re.escape(pattern), repl, formatted, flags=re.IGNORECASE)
            script = f'$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys("{formatted}");'
            _run_ps(script)
            return True
        except Exception:
            return False

    if system == "Darwin":
        return False  # TS original had no macOS hotkey implementation either

    # Linux — xdotool's key syntax is "ctrl+a", "Return", "Tab", "Escape".
    try:
        display = ensure_virtual_display()
        if not display:
            return False
        xdotool_keys = (
            keys.replace("Control+", "ctrl+").replace("control+", "ctrl+")
                .replace("Alt+", "alt+").replace("Shift+", "shift+")
                .replace("Enter", "Return").replace("Esc", "Escape")
        )
        env = {**os.environ, "DISPLAY": display}
        proc = subprocess.run(["xdotool", "key", xdotool_keys], capture_output=True, timeout=5, env=env)
        return proc.returncode == 0
    except Exception:
        return False
