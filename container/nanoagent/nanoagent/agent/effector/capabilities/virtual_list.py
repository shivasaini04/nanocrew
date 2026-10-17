"""Ported from computer-use/virtual-list.ts. Progressively scrolls virtualized
containers (Airtable, Salesforce Data Tables, TanStack Virtual) and accumulates data
rows across viewport slices — a plain DOM read only sees whatever's currently
rendered, which for a virtualized list is a small fraction of the real data."""

from __future__ import annotations

import json as _json
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

_EXTRACT_SLICE_JS = """
(extractorScript) => {
  try {
    const extractor = eval('(' + extractorScript + ')');
    return typeof extractor === 'function' ? extractor() : [];
  } catch (e) {
    return [];
  }
}
"""

_SCROLL_JS = """
({ selector, chunk }) => {
  const el = (selector === 'window' || selector === 'body')
    ? document.documentElement
    : document.querySelector(selector);
  if (!el) return true;
  const prevScroll = el.scrollTop;
  el.scrollTop += chunk;
  return el.scrollTop === prevScroll;
}
"""


@dataclass
class VirtualListResult:
    items: list[Any] = field(default_factory=list)
    total_collected: int = 0
    reached_end: bool = False


async def scroll_and_accumulate_virtual_list(
    page,
    container_selector: str,
    row_extractor_script: str,
    max_items: int = 500,
    scroll_chunk_px: int = 400,
    max_consecutive_empty_scrolls: int = 3,
    settle_delay_ms: int = 200,
) -> VirtualListResult:
    """`row_extractor_script` is the source of a JS function (as a string) returning
    an array of row objects for whatever's currently rendered — same contract as the
    TS original, evaluated in-page each slice."""
    collected: dict[str, Any] = {}
    empty_scrolls = 0
    reached_end = False

    logger.info(f"effector virtual-list: starting progressive accumulation on {container_selector}, max_items={max_items}")

    for _ in range(50):
        if len(collected) >= max_items:
            break

        try:
            slice_items = await page.evaluate(_EXTRACT_SLICE_JS, row_extractor_script)
            new_in_slice = 0
            for item in slice_items or []:
                key = str(item.get("id") or item.get("key") or _json.dumps(item, sort_keys=True))
                if key not in collected:
                    collected[key] = item
                    new_in_slice += 1

            if new_in_slice == 0:
                empty_scrolls += 1
                if empty_scrolls >= max_consecutive_empty_scrolls:
                    reached_end = True
                    break
            else:
                empty_scrolls = 0
        except Exception as err:
            logger.debug(f"effector virtual-list: extraction failed for current slice — {err}")

        try:
            at_bottom = await page.evaluate(_SCROLL_JS, {"selector": container_selector, "chunk": scroll_chunk_px})
            if at_bottom:
                reached_end = True
                break
        except Exception:
            break

        await page.wait_for_timeout(settle_delay_ms)

    items = list(collected.values())
    logger.info(f"effector virtual-list: completed accumulation — {len(items)} items, reached_end={reached_end}")

    return VirtualListResult(items=items, total_collected=len(items), reached_end=reached_end)
