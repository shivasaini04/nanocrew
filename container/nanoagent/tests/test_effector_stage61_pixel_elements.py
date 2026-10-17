"""Stage 61 phase 8 — elements from pixels (effector/perception/pixel_elements.py), for
pages the DOM cannot describe. The OCR detector is local; the Replicate one is opt-in."""

from __future__ import annotations

import io
import shutil

import pytest

# The OCR detector needs the tesseract binary — present in the agent image (and so in
# CI and prod), absent on a plain dev machine. The wiring tests below never need it.
needs_tesseract = pytest.mark.skipif(
    shutil.which("tesseract") is None, reason="tesseract-ocr is not installed here (it is in the agent image)",
)

from nanoagent.agent.effector.perception import pixel_elements as px


def _png(lines: list[tuple[str, int, int]], size=(600, 300)) -> bytes:
    from PIL import Image, ImageDraw

    im = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(im)
    for text, x, y in lines:
        d.text((x, y), text, fill="black")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


@needs_tesseract
def test_ocr_finds_text_controls_and_their_centres():
    found = px.detect_with_ocr(_png([("Save Document", 60, 40), ("Cancel", 60, 160)]), min_conf=20)
    labels = [e.label for e in found]
    assert any("Save" in l for l in labels), labels
    save = next(e for e in found if "Save" in e.label)
    assert 60 <= save.x <= 300 and 30 <= save.y <= 80
    assert save.target == f"{save.x},{save.y}"


@needs_tesseract
def test_a_blank_screen_yields_nothing_rather_than_noise():
    assert px.detect_with_ocr(_png([]), min_conf=20) == []


def test_the_table_numbers_controls_and_maps_them_to_coordinates():
    els = [px.PixelElement(label="Save", x=120, y=48), px.PixelElement(label="Cancel", x=120, y=168)]
    block, refs = px.table(els)
    assert "[@p1]" in block and "Save" in block and "@p2" in block
    # The block must tell the decider these labels are the page's only readable text —
    # found live 2026-09-20: it clicked the same control seven times while the answer
    # it needed was already listed.
    assert "ALL the text on the screen" in block and '"done"' in block
    assert refs["@p2"].target == "120,168"


def test_replicate_output_is_parsed_and_junk_is_skipped():
    out = px._parse_replicate([
        {"content": "Save", "bbox": [100, 40, 140, 60], "type": "icon"},
        {"content": "", "bbox": [0, 0, 10, 10]},
        {"content": "no box"},
        "not a dict",
    ], 0)
    assert len(out) == 1
    assert out[0].label == "Save" and out[0].target == "120,50" and out[0].source == "replicate"


def test_the_detector_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("EFFECTOR_PIXEL_DETECTOR", "off")
    assert px.detector_name() == "off"
    monkeypatch.delenv("EFFECTOR_PIXEL_DETECTOR")
    assert px.detector_name() == "ocr"


def test_replicate_without_a_key_returns_nothing(monkeypatch):
    monkeypatch.delenv("REPLICATE_API_KEY", raising=False)
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    assert px.detect_with_replicate(b"x") == []


@pytest.mark.asyncio
async def test_a_page_with_no_dom_elements_is_clicked_by_coordinate(tmp_path, monkeypatch):
    """End to end: the DOM shows nothing, the screen shows a button, the loop clicks its
    centre — the coordinate the detector measured, never one the model produced."""
    import json
    from unittest.mock import patch

    from nanoagent.agent.tools.effector import EffectorTool
    from test_effector_phase0 import FakeContext, FakePage, ScriptedProvider

    # A stub detector, so this test proves the LOOP's wiring (a chosen @pN becomes the
    # coordinate the detector measured) rather than re-testing OCR.
    async def fake_detect(_page):
        return [px.PixelElement(label="Start Game", x=232, y=126)]

    monkeypatch.setattr(px, "detect", fake_detect)
    shot = _png([("Start Game", 200, 120)])

    class CanvasPage(FakePage):
        async def evaluate(self, script, arg=None):
            if "querySelectorAll" in script:
                return []          # no interactive elements at all
            return await super().evaluate(script, arg)

        async def screenshot(self, **kw):
            return shot

    page = CanvasPage()
    clicked: list[str] = []

    class Session:
        def __init__(self, *a, **kw):
            self.page = page
            self.context = FakeContext(pages=[page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    async def fake_execute_step(step, _page, _opts):
        from nanoagent.agent.effector.types import StepResult
        clicked.append(str(step.target))
        return StepResult(step=step.step, status="success", url_after="about:blank")

    provider = ScriptedProvider([
        {"thought": "click start", "action": "click", "target": "@p1"},
        {"thought": "done", "action": "done"},
    ])
    tool = EffectorTool(workspace=tmp_path, provider=provider, model="fake/p",
                        decision_provider=provider, decision_model="fake/d", require_approval=False)
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", Session), \
         patch("nanoagent.agent.effector.react_loop.execute_step", fake_execute_step):
        out = json.loads(await tool.execute(goal="start the game", session_domain="game.test"))
    assert out["success"] is True, out
    assert clicked and "," in clicked[0], clicked  # a coordinate, not "@p1"
    x, y = (int(v) for v in clicked[0].split(","))
    assert 150 < x < 450 and 90 < y < 170


@pytest.mark.asyncio
async def test_detected_points_are_converted_from_screenshot_pixels_to_css_pixels(monkeypatch):
    """Found live 2026-09-20: on a 2x profile every click landed above the control it
    had just read — the picture is in device pixels, a click is in CSS pixels."""
    shot = _png([("Start Game", 200, 120)], size=(1600, 1000))  # a 2x screenshot

    class Page:
        async def screenshot(self, **kw):
            return shot

        async def evaluate(self, script):
            return 800  # CSS width — half the picture

    monkeypatch.setattr(px, "detect_with_ocr", lambda png, **kw: [px.PixelElement(label="Start Game", x=460, y=250)])
    found = await px.detect(Page())
    assert (found[0].x, found[0].y) == (230, 125)


@pytest.mark.asyncio
async def test_a_one_to_one_screenshot_is_left_alone(monkeypatch):
    shot = _png([("Start Game", 200, 120)], size=(800, 600))

    class Page:
        async def screenshot(self, **kw):
            return shot

        async def evaluate(self, script):
            return 800

    monkeypatch.setattr(px, "detect_with_ocr", lambda png, **kw: [px.PixelElement(label="Start Game", x=230, y=125)])
    found = await px.detect(Page())
    assert (found[0].x, found[0].y) == (230, 125)
