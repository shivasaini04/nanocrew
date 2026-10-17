"""Ported from computer-use/resolver.ts + ocr.ts. Six-layer element resolver:

  1. Coordinate pair "x,y" — direct pixel click
  2. Ref tag "@e1" — instant snapshot reference lookup
  3. CSS selector
  4. Accessibility label (role + text + placeholder)
  5. Vision fallback — screenshot + vision LLM + coordinates, with scroll-to-find loop
  6. OCR fallback — Tesseract text extraction + word match + coordinates

Layers 5/6 need a vision-capable LLM provider; the caller passes the same one loop.py
already resolves for `read_image` (`_vision_provider`/`_vision_model`) rather than this
module picking its own model — see loop.py's tool-registration section.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

from loguru import logger

_COORD_RE = re.compile(r"^\[?(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\]?$")
_REF_RE = re.compile(r"^@e\d+$", re.IGNORECASE)
_ROLE_RE = re.compile(
    r"^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|heading):\s*(.+)$", re.IGNORECASE,
)


@dataclass
class Coordinate:
    x: float
    y: float


# resolve_target returns either a Playwright Locator or a Coordinate — callers branch
# on isinstance(resolved, Coordinate), mirroring the TS `'x' in resolved` check.
ResolvedTarget = "Locator | Coordinate"


def is_coordinate(target: str) -> bool:
    return bool(_COORD_RE.match(target.strip()))


async def resolve_target(page, target: str, provider=None, vision_model: str | None = None, usage_totals: dict | None = None):
    from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot, find_element_by_ref, is_ref_tag

    # Layer 1 — coordinate pair
    m = _COORD_RE.match(target.strip())
    if m:
        return Coordinate(x=float(m.group(1)), y=float(m.group(2)))

    # Layer 1.5 — spatial / canvas coordinates (grid cells, percentages, relative regions)
    if (
        target.lower().startswith("cell:")
        or target.lower().startswith("grid:")
        or "%" in target
        or target.lower() in ("center", "top_left", "top_right", "bottom_left", "bottom_right")
    ):
        from nanoagent.agent.effector.perception.spatial_vla import ground_canvas_coordinates
        vp = getattr(page, "viewport_size", None) or {"width": 1280, "height": 720}
        spatial_pt = ground_canvas_coordinates(target, viewport_width=vp.get("width", 1280), viewport_height=vp.get("height", 720))
        if spatial_pt:
            return Coordinate(x=float(spatial_pt.x), y=float(spatial_pt.y))

    # Layer 2 — @ref tag
    if is_ref_tag(target):
        snapshot = await capture_dom_snapshot(page)
        element = find_element_by_ref(target, snapshot)
        if element:
            # stage45 doc 04, phase 2: coordinate_only means this element came from
            # a frame we could place but not name, so there is no scope that reaches
            # it. Skipping the selector layers is the whole point of the flag: with
            # frame_selector None, `scope` below is the TOP page, and looking up an
            # in-frame selector there does not fail cleanly — on a checkout page
            # `#card-number` may match a different field, click it, and type into it
            # with no error. Not-trying is safer than trying-and-falling-back.
            if not element.coordinate_only:
                # God-level pillar 08: route through the right frame when the
                # element came from one — page.frame_locator(...).locator(...)
                # returns a real Locator, usable exactly like a top-level one by
                # everything downstream (executor.py never needs to know).
                scope = page.frame_locator(element.frame_selector) if element.frame_selector else page
                try:
                    loc = scope.locator(element.selector)
                    if await loc.count() > 0:
                        return loc.first
                except Exception:
                    pass
            # stage45 doc 04, phase 1 (2026-08-29): this used to raise for any
            # in-frame element. The reason was real — bounds/center were measured
            # inside the frame's own viewport, so a page-level click at them landed
            # somewhere real and wrong — and refusing was the honest answer while
            # that was true. capture_dom_snapshot now adds the frame's page-absolute
            # origin before the element ever gets here, and drops any frame it
            # cannot place, so an in-frame center is a page coordinate like any
            # other. The frame's own rect is kept on frame_bounds if anything ever
            # needs to go back the other way.
            return Coordinate(x=element.center.x, y=element.center.y)

    # Layer 3 — CSS selector
    try:
        locator = page.locator(target)
        if await locator.count() > 0:
            return locator.first
    except Exception:
        pass  # not a valid CSS selector, fall through

    # Layer 4 — accessibility: role:name, label, placeholder, text
    a11y = await _try_a11y_resolver(page, target)
    if a11y is not None:
        return a11y

    text_locator = page.get_by_text(target, exact=False)
    if await text_locator.count() > 0:
        return text_locator.first

    # Layer 5 — vision fallback
    logger.debug(f'resolver: CSS/a11y/text all failed for "{target}" — trying vision fallback')
    vision_coords = await _resolve_target_via_vision(page, target, provider, vision_model, usage_totals=usage_totals)
    if vision_coords:
        logger.debug(f"resolver: vision fallback succeeded for \"{target}\" at {vision_coords}")
        return vision_coords

    # Layer 6 — OCR fallback
    logger.debug(f'resolver: vision failed for "{target}" — trying OCR fallback')
    screenshot_bytes = await page.screenshot(type="jpeg", quality=70)
    ocr_coords = _resolve_target_via_ocr(screenshot_bytes, target)
    if ocr_coords:
        logger.debug(f"resolver: OCR fallback succeeded for \"{target}\" at {ocr_coords}")
        return ocr_coords

    raise RuntimeError(
        f'Could not resolve target: "{target}" — no matching element found via '
        f"Ref, CSS, a11y, text, vision, or OCR"
    )


async def _try_a11y_resolver(page, target: str):
    m = _ROLE_RE.match(target)
    if m:
        role, name = m.group(1), m.group(2)
        locator = page.get_by_role(role, name=name)
        if await locator.count() > 0:
            return locator.first

    label_locator = page.get_by_label(target, exact=False)
    if await label_locator.count() > 0:
        return label_locator.first

    placeholder_locator = page.get_by_placeholder(target, exact=False)
    if await placeholder_locator.count() > 0:
        return placeholder_locator.first

    return None


async def _resolve_target_via_vision(page, description: str, provider, vision_model, max_scrolls: int = 5, usage_totals: dict | None = None) -> Coordinate | None:
    if provider is None or not vision_model:
        return None

    for scroll in range(max_scrolls + 1):
        if scroll > 0:
            viewport = page.viewport_size or {"height": 720}
            await page.mouse.wheel(0, viewport.get("height", 720))
            await page.wait_for_timeout(400)

        coords = await _query_vision_once(page, description, provider, vision_model, usage_totals=usage_totals)
        if coords:
            if scroll > 0:
                logger.debug(f'resolver: vision found "{description}" after scroll {scroll}')
            return coords

    try:
        await page.evaluate("() => window.scrollTo(0, 0)")
    except Exception:
        pass
    return None


async def _query_vision_once(page, description: str, provider, vision_model: str, usage_totals: dict | None = None) -> Coordinate | None:
    viewport = page.viewport_size or {"width": 1280, "height": 720}
    screenshot_bytes = await page.screenshot(type="jpeg", quality=70)
    b64 = base64.b64encode(screenshot_bytes).decode()

    prompt = (
        f"The browser viewport is {viewport['width']}x{viewport['height']} pixels.\n"
        f'Find the UI element matching this description: "{description}"\n'
        'If the element is NOT visible in this screenshot, return exactly: {"found": false}\n'
        "If it IS visible, return ONLY a JSON object with its center pixel coordinates — "
        'no explanation, no markdown: {"x": number, "y": number}'
    )

    try:
        response = await provider.chat(
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            model=vision_model,
            max_tokens=64,
            temperature=0,
        )
        if usage_totals is not None:
            from nanoagent.agent.effector.types import accumulate_usage
            accumulate_usage(usage_totals, response.usage)
        text = (response.content or "").strip()
        cleaned = re.sub(r"```(?:json)?\n?", "", text).replace("```", "").strip()
        parsed = json.loads(cleaned)

        if parsed.get("found") is False:
            return None
        if isinstance(parsed.get("x"), (int, float)) and isinstance(parsed.get("y"), (int, float)):
            return Coordinate(
                x=max(0, min(viewport["width"], round(parsed["x"]))),
                y=max(0, min(viewport["height"], round(parsed["y"]))),
            )
    except Exception as err:
        logger.debug(f'resolver: vision LLM call failed for "{description}" — {err}')
    return None


_STOP_WORDS = frozenset({
    "the", "a", "an", "for", "of", "in", "on", "at", "to", "and", "or", "is", "it",
    "this", "that", "input", "field", "button", "box", "area",
})


def _tokenize(text: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9\s]", " ", text.lower())
    return [w for w in cleaned.split() if len(w) > 1 and w not in _STOP_WORDS]


def _score_match(candidate: str, desc_words: list[str]) -> float:
    if not desc_words:
        return 0.0
    cand_lower = candidate.lower()
    hits = sum(1 for w in desc_words if w in cand_lower)
    return hits / len(desc_words)


def _resolve_target_via_ocr(screenshot_bytes: bytes, description: str, min_confidence: float = 0.4) -> Coordinate | None:
    """OCR fallback via pytesseract (Python equivalent of the TS tesseract.js layer).
    Best for text buttons/links/labels; not designed for finding blank input fields —
    vision (layer 5) handles those. Requires the tesseract-ocr system package — see
    container/Dockerfile."""
    try:
        import io

        import pytesseract
        from PIL import Image

        image = Image.open(io.BytesIO(screenshot_bytes))
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    except Exception as err:
        logger.warning(f'resolver: OCR fallback unavailable for "{description}" — {err}')
        return None

    desc_words = _tokenize(description)
    best_score = 0.0
    best: Coordinate | None = None

    n = len(data.get("text", []))
    # Group words into lines (block/par/line) for multi-word phrase matching, same as
    # the TS original scored both individual words and reconstructed lines.
    lines: dict[tuple[int, int, int], list[int]] = {}
    for i in range(n):
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(i)

    for i in range(n):
        word = (data["text"][i] or "").strip()
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1
        if not word or conf < 30:
            continue

        score = _score_match(word, desc_words)
        if score > best_score:
            x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
            best_score = score
            best = Coordinate(x=x + w / 2, y=y + h / 2)

    for idxs in lines.values():
        words = [(data["text"][i] or "").strip() for i in idxs]
        line_text = " ".join(w for w in words if w)
        if not line_text:
            continue
        score = _score_match(line_text, desc_words)
        if score > best_score:
            xs0 = [data["left"][i] for i in idxs]
            xs1 = [data["left"][i] + data["width"][i] for i in idxs]
            ys0 = [data["top"][i] for i in idxs]
            ys1 = [data["top"][i] + data["height"][i] for i in idxs]
            best_score = score
            best = Coordinate(x=(min(xs0) + max(xs1)) / 2, y=(min(ys0) + max(ys1)) / 2)

    if best is not None and best_score >= min_confidence:
        logger.debug(f'resolver: OCR fallback matched "{description}" score={best_score:.2f}')
        return best
    return None
