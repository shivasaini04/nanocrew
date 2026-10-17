"""read_pdf — extract text from PDF files page by page."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool

_MAX_CHARS = 6000


class ReadPdfTool(Tool):
    """Extract text content from a PDF file."""

    @property
    def name(self) -> str:
        return "read_pdf"

    @property
    def description(self) -> str:
        return (
            "Extract text content from a PDF file. Returns page-by-page text. "
            "For PDFs with charts or diagrams, save the PDF page as an image and "
            "use read_image to analyze the visual content."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Absolute path to the PDF file.",
                },
                "pages": {
                    "type": "string",
                    "description": (
                        "Page range to extract. Examples: '1', '1-5', 'all'. "
                        "Default: all pages (up to first ~6000 chars)."
                    ),
                },
            },
            "required": ["file"],
        }

    async def execute(self, file: str, pages: str = "all", **kwargs: Any) -> str:
        try:
            import pypdf  # type: ignore[import-untyped]
        except ImportError:
            return "pypdf not installed — add it to the container image or run: pip install pypdf"

        p = Path(file)
        if not p.exists():
            return f"File not found: {file}"

        try:
            reader = pypdf.PdfReader(str(p))
        except Exception as exc:
            return f"Failed to read PDF: {exc}"

        total = len(reader.pages)
        if total == 0:
            return "PDF has no pages."

        if pages == "all":
            page_range = range(total)
        else:
            parts = pages.split("-")
            try:
                start = max(0, int(parts[0]) - 1)
                end   = int(parts[1]) if len(parts) > 1 else start + 1
                page_range = range(start, min(total, end))
            except ValueError:
                return f"Invalid pages format: {pages!r} — use '1', '1-5', or 'all'"

        parts_text: list[str] = []
        for i in page_range:
            text = (reader.pages[i].extract_text() or "").strip()
            parts_text.append(f"--- Page {i + 1} ---\n{text}" if text else f"--- Page {i + 1} --- (no extractable text)")

        result = "\n\n".join(parts_text)
        if not result.strip():
            return "No extractable text found. The PDF may be image-only — try read_image on it."

        return result[:_MAX_CHARS] + (f"\n\n[truncated — {total} pages total]" if len(result) > _MAX_CHARS else "")
