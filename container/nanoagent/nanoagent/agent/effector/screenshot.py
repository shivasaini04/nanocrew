"""Ported from computer-use/screenshot.ts. Screenshot capture itself is done inline
wherever it's needed (resolver.py's vision fallback, desktop_vision.py) rather than
through a shared wrapper, since each caller needs slightly different encoding — but
`extract_page_text` is genuinely shared logic (strips script/style/noscript before
extracting, so captured text isn't polluted with JS/CSS source) and is used by
react_loop.py's synthesis trigger to build the problem context a driver gets
synthesized against."""

from __future__ import annotations

_EXTRACT_TEXT_JS = """
() => {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  return (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim();
}
"""


async def extract_page_text(page, max_chars: int = 3000) -> str:
    """Extract readable page text (script/style/noscript stripped) for LLM
    consumption — verification prompts, synthesis problem context, etc."""
    try:
        text = await page.evaluate(_EXTRACT_TEXT_JS)
    except Exception:
        return "(could not extract page text)"
    # The JS above always returns a string, but `evaluate` returns whatever it is
    # handed — and a caller that feeds this straight into string operations (the
    # anti-bot challenge gate in react_loop.py does) crashes the whole run on a
    # non-str. Keep the annotated contract true rather than trusting the caller.
    if not isinstance(text, str):
        return ""
    return text[:max_chars]
