"""Ported from computer-use/tab-manager.ts. Tracks every tab/popup a browser context
spawns (LinkedIn Easy Apply, OAuth flows, and "open in new tab" links all do this)
and keeps focus on the active one — without it, react_loop would keep issuing
actions against a page a site has already navigated away from."""

from __future__ import annotations

from dataclasses import dataclass

from loguru import logger


@dataclass
class TabInfo:
    index: int
    url: str
    title: str
    is_active: bool


class TabManager:
    def __init__(self, context, initial_page=None):
        self._context = context
        self._pages: list = [initial_page] if initial_page else list(context.pages)
        self._active_index = 0
        context.on("page", self._on_new_page)

    def _on_new_page(self, new_page) -> None:
        logger.info(f"effector tab-manager: new tab/popup detected — {new_page.url}")
        self._pages.append(new_page)
        self._active_index = len(self._pages) - 1
        new_page.on("close", lambda: self._on_page_closed(new_page))

    def _on_page_closed(self, closed_page) -> None:
        if closed_page in self._pages:
            self._pages.remove(closed_page)
            self._active_index = max(0, len(self._pages) - 1)
            logger.info(f"effector tab-manager: tab closed, {len(self._pages)} remaining")

    def get_active_page(self):
        if not self._pages:
            raise RuntimeError("TabManager: no active browser pages available")
        return self._pages[self._active_index] if self._active_index < len(self._pages) else self._pages[0]

    async def switch_to_tab(self, index: int):
        if index < 0 or index >= len(self._pages):
            raise ValueError(f"TabManager: invalid tab index {index}. Total tabs: {len(self._pages)}")
        self._active_index = index
        page = self._pages[self._active_index]
        try:
            await page.bring_to_front()
        except Exception:
            pass
        return page

    async def close_active_tab(self):
        if len(self._pages) <= 1:
            logger.warning("effector tab-manager: cannot close the only remaining root tab")
            return self.get_active_page()

        page_to_close = self.get_active_page()
        try:
            await page_to_close.close()
        except Exception:
            pass
        return self.get_active_page()

    async def get_tabs_info(self) -> list[TabInfo]:
        info = []
        for i, p in enumerate(self._pages):
            try:
                title = await p.title()
            except Exception:
                title = "Untitled"
            info.append(TabInfo(index=i, url=p.url, title=title, is_active=(i == self._active_index)))
        return info

    def get_tab_count(self) -> int:
        return len(self._pages)
