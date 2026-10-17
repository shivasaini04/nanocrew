"""Stage 61 phase 8 — elements from pixels, for pages the DOM cannot describe.

Effector reads a page as a list of controls. On a canvas app, a WebGL view or a remote
desktop there is no such list, and the loop stalls with "no interactive elements". This
turns a screenshot into the same shape: numbered items with a label and a centre point,
so the ordinary decide → act → check loop keeps working and CODE clicks the centre
(`resolver` already accepts an "x,y" target).

Two detectors, both optional and both off the hot path — this runs only when the DOM
found nothing:

- **ocr** (default): pytesseract, already in the image, local and free. Finds text —
  buttons, menu entries, labels. Blind to unlabelled icons.
- **replicate**: OmniParser v2, which also finds icons. Costs money per call, so it is
  opt-in via `EFFECTOR_PIXEL_DETECTOR=replicate` and needs `REPLICATE_API_KEY`
  (founder decision 2026-09-19: Replicate for tests, within the cap).

`EFFECTOR_PIXEL_DETECTOR=off` disables the fallback entirely.
"""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass
from typing import Any

from loguru import logger

_MIN_CONF = 45.0
_MAX_ELEMENTS = 40
_REPLICATE_MODEL = "microsoft/omniparser-v2"


@dataclass
class PixelElement:
    label: str
    x: int
    y: int
    source: str = "ocr"
    kind: str = "text"

    @property
    def target(self) -> str:
        """What the executor resolves — a coordinate pair, never a guess."""
        return f"{self.x},{self.y}"


def detector_name() -> str:
    return (os.environ.get("EFFECTOR_PIXEL_DETECTOR") or "ocr").strip().lower()


def detect_with_ocr(png_bytes: bytes, min_conf: float = _MIN_CONF) -> list[PixelElement]:
    """Text lines on screen, with their centres. Words are grouped into lines so a
    two-word button ("Save As") is one target rather than two."""
    try:
        import pytesseract
        from PIL import Image

        data = pytesseract.image_to_data(
            Image.open(io.BytesIO(png_bytes)), output_type=pytesseract.Output.DICT,
        )
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: OCR detector unavailable — {err}")
        return []

    lines: dict[tuple[int, int, int], list[int]] = {}
    for i, word in enumerate(data.get("text", [])):
        if not str(word).strip():
            continue
        try:
            if float(data["conf"][i]) < min_conf:
                continue
        except (TypeError, ValueError):
            continue
        lines.setdefault((data["block_num"][i], data["par_num"][i], data["line_num"][i]), []).append(i)

    out: list[PixelElement] = []
    for idxs in lines.values():
        label = re.sub(r"\s+", " ", " ".join(str(data["text"][i]).strip() for i in idxs)).strip()
        if not label:
            continue
        left = min(data["left"][i] for i in idxs)
        top = min(data["top"][i] for i in idxs)
        right = max(data["left"][i] + data["width"][i] for i in idxs)
        bottom = max(data["top"][i] + data["height"][i] for i in idxs)
        out.append(PixelElement(label=label[:80], x=int((left + right) / 2), y=int((top + bottom) / 2)))
    return out[:_MAX_ELEMENTS]


def detect_with_replicate(png_bytes: bytes) -> list[PixelElement]:
    """OmniParser v2 on Replicate: text AND icons. Paid, so opt-in."""
    token = os.environ.get("REPLICATE_API_KEY") or os.environ.get("REPLICATE_API_TOKEN") or ""
    if not token:
        logger.debug("effector: replicate detector asked for but no REPLICATE_API_KEY")
        return []
    try:
        import base64

        import httpx

        b64 = base64.b64encode(png_bytes).decode()
        r = httpx.post(
            "https://api.replicate.com/v1/models/" + _REPLICATE_MODEL + "/predictions",
            headers={"Authorization": f"Bearer {token}", "Prefer": "wait"},
            json={"input": {"image": f"data:image/png;base64,{b64}"}},
            timeout=120,
        )
        r.raise_for_status()
        payload = r.json().get("output")
    except Exception as err:  # noqa: BLE001
        logger.warning(f"effector: replicate detector failed — {err}")
        return []
    return _parse_replicate(payload, len(png_bytes))


def _parse_replicate(payload: Any, _size: int) -> list[PixelElement]:
    """OmniParser returns the parsed elements as a list (or a JSON/text blob) of
    {content|label, bbox:[x1,y1,x2,y2] normalised 0-1 or absolute}. Anything that does
    not carry a label and a box is skipped rather than guessed at."""
    items: list[Any] = []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        for key in ("elements", "parsed_content_list", "output"):
            if isinstance(payload.get(key), list):
                items = payload[key]
                break
    out: list[PixelElement] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        label = str(it.get("content") or it.get("label") or it.get("text") or "").strip()
        box = it.get("bbox") or it.get("box") or it.get("bounds")
        if not label or not isinstance(box, (list, tuple)) or len(box) != 4:
            continue
        try:
            x1, y1, x2, y2 = (float(v) for v in box)
        except (TypeError, ValueError):
            continue
        out.append(PixelElement(
            label=label[:80], x=int((x1 + x2) / 2), y=int((y1 + y2) / 2),
            source="replicate", kind=str(it.get("type") or "element"),
        ))
    return out[:_MAX_ELEMENTS]


async def _css_scale(page: Any, png: bytes) -> float:
    """Screenshot pixels per CSS pixel.

    A screenshot is in DEVICE pixels; a click is in CSS pixels. On a profile that claims
    a 2x display they differ by two, and a control read at (423,186) in the picture is
    really at (211,93) on the page. Found live 2026-09-20: every click on a canvas
    fixture landed above the button it had just read, reported success, and changed
    nothing. Measured from the image itself rather than trusting devicePixelRatio, so a
    scaled or clipped screenshot is handled the same way.
    """
    try:
        import io

        from PIL import Image

        width_px = Image.open(io.BytesIO(png)).size[0]
        width_css = float(await page.evaluate("window.innerWidth") or 0)
        if width_css > 0 and width_px > 0:
            return width_px / width_css
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: could not measure the screenshot scale — {err}")
    return 1.0


def _to_css(elements: list[PixelElement], scale: float) -> list[PixelElement]:
    if not scale or abs(scale - 1.0) < 0.01:
        return elements
    for el in elements:
        el.x = int(round(el.x / scale))
        el.y = int(round(el.y / scale))
    return elements


async def detect(page: Any) -> list[PixelElement]:
    """Screenshot the page and turn it into elements with the configured detector.
    Coordinates come back in CSS pixels, ready for a click."""
    name = detector_name()
    if name == "off":
        return []
    try:
        png = await page.screenshot(type="png")
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: pixel fallback could not screenshot — {err}")
        return []
    import asyncio

    loop = asyncio.get_running_loop()
    scale = await _css_scale(page, png)
    found: list[PixelElement] = []
    if name == "replicate":
        found = await loop.run_in_executor(None, detect_with_replicate, png)
        if not found:
            logger.debug("effector: replicate detector returned nothing — falling back to OCR")
    if not found:
        found = await loop.run_in_executor(None, detect_with_ocr, png)
    if found and abs(scale - 1.0) >= 0.01:
        logger.debug(f"effector: screen controls scaled by 1/{scale:.2f} into CSS pixels")
    return _to_css(found, scale)


def table(elements: list[PixelElement]) -> tuple[str, dict[str, PixelElement]]:
    """The perception block for these elements, and the @pN → element map the loop uses
    to turn a chosen tag into a coordinate target."""
    refs = {f"@p{i}": el for i, el in enumerate(elements, start=1)}
    lines = [
        "Screen controls (read from the picture — this page exposes no DOM elements).",
        "These labels are ALL the text on the screen right now. Read answers from them:",
        "if the information the goal asks for is already listed here, answer with",
        '{"action": "done", "extractedData": {...}} and copy the label exactly.',
        "Do not repeat a click whose result is already visible in this list.",
        'To act, target a control by its tag, e.g. {"action": "click", "target": "@p3"}:',
    ]
    lines += [f"  [{ref}] {el.kind} \"{el.label}\" ({el.source})" for ref, el in refs.items()]
    return "\n".join(lines), refs
