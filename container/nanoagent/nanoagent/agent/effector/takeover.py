"""Human input into the agent's browser (phase 5.3).

The human sees a downscaled screenshot in the dashboard and clicks on it. This turns
that click into a real event in whichever browser the run is actually driving.

**Lane-agnostic without a single branch.** Both lanes expose the same Playwright-shaped
surface: on the container lane `page.mouse` / `page.keyboard` are Playwright's own, and
on the user-browser lane `_RemoteMouse` / `_RemoteKeyboard` (remote_page.py) mirror that
surface over the extension bridge. So this dispatches through `page.mouse.click(...)`
and works on both, and neither needs a special case here.

**Coordinates arrive normalised, never in pixels.** The frame the human clicked is
downscaled from the real viewport (`_SCREENCAST_MAX_WIDTH` is 800, the viewport is
usually 1280), and the dashboard scales it again to whatever width the panel happens to
be. Pixels measured on that image mean nothing to the page. The dashboard sends a
fraction of the frame's width and height, and the scaling to real viewport coordinates
happens here, where the viewport is actually known.

**Input is refused unless takeover is armed.** A human clicking while the agent is mid-
action is two drivers fighting over one browser, and the resulting page state belongs to
neither of them. Arming is phase 5.4's job; until something arms it, this drops input on
the floor and says so.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

# Buttons a browser understands. Anything else is refused rather than passed through to
# the page: this input arrives from outside the agent, and the far end is a real browser.
_BUTTONS = frozenset({"left", "right", "middle"})

# Key names that may be pressed without text. Deliberately a small allowlist of the keys
# a human needs to get through a login or a consent dialog — not "any string the client
# sent", which would hand a socket the ability to drive arbitrary shortcuts.
_ALLOWED_KEYS = frozenset({
    "Enter", "Tab", "Escape", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown",
})


class TakeoverSession:
    """Holds whether a human currently has the wheel, and dispatches what they do.

    One per run. `armed` is the gate; everything else is mechanics.
    """

    def __init__(self, page: Any, page_resolver: Any = None):
        self._page = page
        # Optional `() -> page` (typically `tab_manager.get_active_page`). A click
        # dispatched against `self._page` alone lands on the tab that existed when the
        # takeover session was built — real bug, found live 2026-09-03: "Continue with
        # Google" opens a new tab, and every click after that kept landing on the
        # now-backgrounded sign-in page, which is why nothing the human did appeared to
        # work. Resolved fresh on every input rather than once, the same way the ReAct
        # loop already re-fetches `tab_manager.get_active_page()` each turn.
        self._page_resolver = page_resolver
        self.armed = False
        self.reason: str | None = None
        # Set when the human says they are finished, so the loop knows to resume rather
        # than keep waiting. Phase 5.4 reads this.
        self.released = False

    def arm(self, reason: str | None = None) -> None:
        self.armed = True
        self.released = False
        self.reason = reason
        logger.info(f"effector: takeover armed — {reason or 'no reason given'}")

    def disarm(self) -> None:
        if self.armed:
            logger.info("effector: takeover disarmed — the agent has the wheel again")
        self.armed = False

    def release(self) -> None:
        """The human says they are done. Ends the takeover; the agent resumes."""
        self.released = True
        self.disarm()

    # ── dispatch ─────────────────────────────────────────────────────────────

    def _target_page(self) -> Any:
        """The page a click actually belongs on right now.

        Never the fixed `self._page` alone when a resolver is available — a popup or
        new tab (OAuth is the common case) makes that reference stale the moment it
        opens, and a stale target is worse than none: input silently disappears into a
        page the human can no longer see, instead of failing loud.
        """
        if self._page_resolver is not None:
            try:
                resolved = self._page_resolver()
                if resolved is not None:
                    return resolved
            except Exception as err:
                logger.debug(f"effector: takeover page resolver failed, using original page — {err}")
        return self._page

    def _viewport(self) -> tuple[int, int]:
        try:
            size = self._target_page().viewport_size
            if callable(size):
                size = size()
            if size:
                return int(size.get("width") or 1280), int(size.get("height") or 720)
        except Exception:  # noqa: BLE001
            pass
        return 1280, 720

    def _to_pixels(self, nx: Any, ny: Any) -> tuple[float, float] | None:
        """Normalised (0..1) → viewport pixels. None when the input is not usable.

        Out-of-range is refused rather than clamped: a fraction outside 0..1 means the
        sender measured against something other than the frame, and a clamped click
        lands somewhere plausible-looking that the human did not choose.
        """
        try:
            fx, fy = float(nx), float(ny)
        except (TypeError, ValueError):
            return None
        if not (0.0 <= fx <= 1.0 and 0.0 <= fy <= 1.0):
            return None
        width, height = self._viewport()
        return fx * width, fy * height

    async def handle(self, msg: dict) -> None:
        """Act on one inbound channel message. Never raises."""
        try:
            kind = msg.get("kind")
            if not self.armed:
                logger.debug(f"effector: ignoring {kind!r} input — takeover is not armed")
                return
            if kind == "mouse":
                await self._mouse(msg)
            elif kind == "key":
                await self._key(msg)
            elif kind == "scroll":
                await self._scroll(msg)
            else:
                logger.debug(f"effector: unknown input kind {kind!r}")
        except Exception as err:  # noqa: BLE001
            # A human clicking something awkward must not end the run they are rescuing.
            logger.debug(f"effector: takeover input failed — {err}")

    async def _mouse(self, msg: dict) -> None:
        point = self._to_pixels(msg.get("nx"), msg.get("ny"))
        if point is None:
            logger.debug("effector: mouse input outside the frame — ignored")
            return
        x, y = point
        button = str(msg.get("button") or "left")
        if button not in _BUTTONS:
            logger.debug(f"effector: refusing unknown mouse button {button!r}")
            return

        action = str(msg.get("type") or "click")
        mouse = self._target_page().mouse
        if action == "move":
            await mouse.move(x, y)
        elif action == "dblclick":
            await mouse.dblclick(x, y)
        else:
            # Both lanes' click() move first, so hover-triggered menus are open by the
            # time the press lands — see _RemoteMouse.click and Playwright's own.
            await mouse.click(x, y, button=button)

    async def _key(self, msg: dict) -> None:
        keyboard = self._target_page().keyboard
        text = msg.get("text")
        if isinstance(text, str) and text:
            # insert_text, not per-character key events: it handles IME, emoji and
            # pasted input in one call, and it is what the extension lane does too.
            await keyboard.insert_text(text)
            return

        key = str(msg.get("key") or "")
        if key not in _ALLOWED_KEYS:
            logger.debug(f"effector: refusing key {key!r} — not in the takeover allowlist")
            return
        await keyboard.press(key)

    async def _scroll(self, msg: dict) -> None:
        mouse = self._target_page().mouse
        wheel = getattr(mouse, "wheel", None)
        if wheel is None:
            # An extension older than `input.scroll` has no wheel, and neither did this
            # lane before it. Degrade rather than fail: PageDown still works through
            # input.key, which is what this lane had all along.
            logger.debug("effector: this lane cannot scroll by wheel — ignored")
            return
        try:
            dx = float(msg.get("dx") or 0.0)
            dy = float(msg.get("dy") or 0.0)
        except (TypeError, ValueError):
            return

        # Put the pointer where the human's cursor was before scrolling. A wheel event
        # goes to whatever is under the pointer, so this is what makes an inner scroll
        # container — a modal body, a long dropdown — receive it rather than the page
        # behind it. Optional: a scroll with no position still scrolls the document.
        point = self._to_pixels(msg.get("nx"), msg.get("ny"))
        if point is not None:
            await mouse.move(point[0], point[1])
        await wheel(dx, dy)


def router(session: "TakeoverSession"):
    """An `on_message` handler for the cycle channel, bound to one takeover session.

    Kept here rather than in the tool so the message vocabulary and the thing that
    understands it live together: adding a message type means editing one file.
    """
    async def handle(msg: dict) -> None:
        kind = msg.get("t")
        if kind == "input":
            await session.handle(msg)
        elif kind == "release":
            session.release()
        else:
            logger.debug(f"effector: unhandled channel message {kind!r}")
    return handle
