"""Ported from computer-use/drag-and-drop.ts. Dispatches synthetic HTML5
drag-and-drop events (with a real DataTransfer + FileList) for modern canvas/custom
dropzone apps (Figma, Canva, internal portals) that lack a plain `<input
type="file">` — the `upload` action's file-chooser path can't reach these."""

from __future__ import annotations

import base64
from pathlib import Path

from loguru import logger

_DROP_JS = """
({ selector, b64, name, mime }) => {
  const el = document.querySelector(selector);
  if (!el) return false;

  const byteCharacters = atob(b64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const file = new File([byteArray], name, { type: mime });

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  const eventInit = { bubbles: true, cancelable: true, dataTransfer, clientX, clientY };

  el.dispatchEvent(new DragEvent('dragenter', eventInit));
  el.dispatchEvent(new DragEvent('dragover', eventInit));
  el.dispatchEvent(new DragEvent('drop', eventInit));

  return true;
}
"""


async def dispatch_drag_and_drop_file(
    page,
    target_selector: str,
    file_name: str | None = None,
    mime_type: str | None = None,
    file_buffer_base64: str | None = None,
    file_path: str | None = None,
) -> bool:
    try:
        b64 = file_buffer_base64
        name = file_name or "upload.pdf"
        mime = mime_type or "application/octet-stream"

        if not b64 and file_path:
            data = Path(file_path).read_bytes()
            b64 = base64.b64encode(data).decode()
            if not file_name:
                name = Path(file_path).name

        if not b64:
            raise ValueError("dispatch_drag_and_drop_file: No file buffer or path provided")

        return await page.evaluate(_DROP_JS, {"selector": target_selector, "b64": b64, "name": name, "mime": mime})
    except Exception as err:
        logger.debug(f"effector drag-and-drop: failed to dispatch drop event for {target_selector} — {err}")
        return False
