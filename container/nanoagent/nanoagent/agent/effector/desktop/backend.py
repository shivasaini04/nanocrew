"""Where a desktop action actually lands.

Until now `desktop_task` called `dispatch()` directly, which meant exactly one
destination: the founder's Windows machine, through the desktop app, behind a consent
dialog. That is the right destination in production and it made the loop **untestable**
— there is no way to run it in CI, on a Linux container, or against a benchmark, because
every step needs a human to click Allow on a specific computer.

So the transport becomes a seam. Two implementations today:

    DispatchBackend   the user's own computer, via the desktop app (production)
    CuaLocalBackend   cua-driver running beside us, driving a local X11 display

The second is what makes an autonomous "measure, fix, measure again" loop possible at
all: cua-bench ships verifiable GUI tasks that run natively on Linux, and our agent image
already has Xvfb for the browser. Same loop code, same decisions, same proof — a
destination that does not need anyone to be awake.

The contract is deliberately the capability names the desktop app already speaks, so the
production path stays a thin pass-through and cannot drift from the thing it models.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class DesktopBackend(Protocol):
    """The five things the desktop loop needs a computer to do."""

    name: str

    async def ui_tree(self, *, max_elements: int, reason: str) -> dict[str, Any]:
        """The focused window's controls. Elements may carry a `token`."""
        ...

    async def click(
        self, *, token: str | None, x: float | None, y: float | None,
        button: str, double: bool, reason: str,
    ) -> Any: ...

    async def type_text(self, *, text: str, token: str | None, reason: str) -> Any: ...

    async def key(self, *, keys: str, reason: str) -> Any: ...

    async def screenshot(self, *, reason: str) -> Any: ...


class DispatchBackend:
    """Production: the user's computer, through the desktop app.

    A pass-through on purpose. Every payload key here is one the app's capability
    handlers already read, so this class adds no translation layer that could disagree
    with them.
    """

    name = "dispatch"

    async def ui_tree(self, *, max_elements: int, reason: str) -> dict[str, Any]:
        from nanoagent.agent.tools.local_computer import dispatch

        return await dispatch("desktop.ui_tree", {"maxElements": max_elements, "reason": reason}) or {}

    async def click(self, *, token, x, y, button, double, reason) -> Any:
        from nanoagent.agent.tools.local_computer import dispatch

        return await dispatch("desktop.click", {
            "token": token, "x": x, "y": y, "button": button, "double": double, "reason": reason,
        })

    async def type_text(self, *, text: str, token: str | None, reason: str) -> Any:
        from nanoagent.agent.tools.local_computer import dispatch

        return await dispatch("desktop.type", {"text": text, "token": token, "reason": reason})

    async def key(self, *, keys: str, reason: str) -> Any:
        from nanoagent.agent.effector.desktop.keys import to_sendkeys
        from nanoagent.agent.tools.local_computer import dispatch

        # The model names keys plainly ("Enter", "Ctrl+S"); the desktop app speaks
        # SendKeys. Translating here keeps that dialect on the Windows side of the wire
        # instead of in the prompt, where it broke the moment a second backend existed.
        return await dispatch("desktop.key", {"keys": to_sendkeys(keys), "reason": reason})

    async def screenshot(self, *, reason: str) -> Any:
        from nanoagent.agent.tools.local_computer import dispatch

        return await dispatch("desktop.screenshot", {"reason": reason})


def default_backend() -> DesktopBackend:
    """What `desktop_task` uses when nobody passes one.

    Production behaviour is unchanged and stays the default: a benchmark run has to ask
    for the local backend explicitly, so no code path can quietly start driving a
    container when it meant to drive a person's computer.
    """
    return DispatchBackend()
