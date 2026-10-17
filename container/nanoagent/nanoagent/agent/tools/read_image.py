"""read_image — analyze image files using the agent's vision-capable LLM."""

from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path
from typing import Any, TYPE_CHECKING

from nanoagent.agent.tools.base import Tool

if TYPE_CHECKING:
    from nanoagent.providers.base import LLMProvider

_SUPPORTED_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB


class ReadImageTool(Tool):
    """Analyze an image file and return a detailed description using the LLM."""

    def __init__(self, provider: "LLMProvider", model: str) -> None:
        self._provider = provider
        self._model = model

    @property
    def name(self) -> str:
        return "read_image"

    @property
    def description(self) -> str:
        return (
            "Analyze an image file and return a detailed description or answer a specific "
            "question about it. Works on PNG, JPEG, WebP, GIF. Use for charts, screenshots, "
            "diagrams, scanned documents, photos, and any visual content."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Absolute path to the image file.",
                },
                "prompt": {
                    "type": "string",
                    "description": (
                        "What to focus on or ask about the image. "
                        "Examples: 'extract all numbers and labels from this chart', "
                        "'describe the UI layout', 'what does this diagram show'. "
                        "Defaults to a general description."
                    ),
                },
            },
            "required": ["file"],
        }

    async def execute(self, file: str, prompt: str = "Describe this image in detail.", **kwargs: Any) -> str:
        p = Path(file)
        if not p.exists():
            return f"File not found: {file}"

        size = p.stat().st_size
        if size > _MAX_FILE_BYTES:
            return f"File too large ({size // 1024 // 1024} MB) — max 20 MB"

        mime = mimetypes.guess_type(file)[0] or "image/png"
        if mime not in _SUPPORTED_MIME:
            return f"Unsupported file type: {mime}. Supported: PNG, JPEG, WebP, GIF."

        b64 = base64.b64encode(p.read_bytes()).decode()

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ]

        try:
            response = await self._provider.chat(
                messages=messages,
                model=self._model,
                max_tokens=1500,
                temperature=0.1,
            )
            result = response.content or "(no description returned)"
            return result[:3000]
        except Exception as exc:
            return f"Vision analysis failed: {exc}"
