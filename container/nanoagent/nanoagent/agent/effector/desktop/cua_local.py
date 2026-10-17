"""cua-driver running beside us, driving a local display.

This is the backend that makes computer use measurable without a person. cua-driver
(github.com/trycua/cua, MIT) ships a Linux build and speaks MCP over stdio; cua-bench
ships GUI tasks that run natively on Linux and **verify their own outcome** ("the Submit
button was clicked"), which is the part a screenshot-and-vibes benchmark never gives you.

Our agent image already runs Xvfb for the browser, so the same container can host a real
X11 desktop, a real window, and a real driver. That turns "is our computer-use loop any
good?" from an opinion into a number we can re-run after every change.

It is the same protocol shape as the desktop app's JS bridge (desktop/cua-driver-bridge.js),
kept deliberately parallel: if the two disagree about what a refusal means, the Linux
measurement stops predicting the Windows behaviour it exists to de-risk.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import Any

from loguru import logger

_PROTOCOL_VERSION = "2025-06-18"
_START_TIMEOUT_S = 20.0
_CALL_TIMEOUT_S = 30.0

# Windows and X11 both refuse some actions to a window that is not in front. These are
# the driver's names for "the system declined", as opposed to "the driver broke".
BACKGROUND_REFUSALS = {
    "background_unavailable",
    "background_occluded",
    "background_uipi_blocked",
}


_LABEL_RE = __import__("re").compile(r"^\s*-\s*label\s*=\s*\"(.*)\"\s*$")


def _readable_text(tree_markdown: str) -> str:
    """What the window SAYS, as opposed to what it offers to be clicked.

    `elements` holds only actionable controls, so a dialog whose whole point is a
    sentence — "Reference code: QX-7731" — came through as nothing but an OK button, and
    the loop correctly reported that it could not read the code. The driver does return
    the text, as label nodes inside tree_markdown.

    Same role as the browser's content summary: the difference between an agent that can
    act and one that can also read.
    """
    seen, out = set(), []
    for line in (tree_markdown or "").splitlines():
        m = _LABEL_RE.match(line)
        if not m:
            continue
        text = m.group(1).strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return "\n".join(out)[:2000]


def _is_app_window(w: dict[str, Any]) -> bool:
    """An actual application window, not the driver's own furniture.

    cua-driver paints its agent cursor into a real X11 window ("Cua.AgentCursorOverlay"),
    full-screen and above everything else. "Topmost window" therefore selects the cursor
    overlay, and get_window_state on it fails with tool_invocation_failed — which is how
    a benchmark run ended up driving a picture of a mouse pointer.
    """
    title = w.get("title") or ""
    if title.startswith("Cua.") or "AgentCursor" in title:
        return False
    return bool(w.get("pid")) and bool(w.get("is_on_screen", True))


class DriverUnavailable(RuntimeError):
    """cua-driver is not installed, or would not start."""


class WindowGone(DriverUnavailable):
    """The window being driven no longer exists.

    Usually this is SUCCESS, not a fault: a dialog closes because the button we pressed
    dismissed it. Treating it as an error made the benchmark report a failed run for
    every task that actually worked — the loop clicked OK, the dialog vanished, and the
    next read of that window raised.
    """


def find_driver() -> str | None:
    """The driver binary, or None. None is a supported state, not an error."""
    explicit = os.environ.get("CUA_DRIVER_BINARY", "").strip()
    if explicit:
        return explicit if os.path.exists(explicit) else None
    return shutil.which("cua-driver")


def interpret(result: dict[str, Any]) -> dict[str, Any]:
    """An MCP tool result as either a value or a named refusal.

    Mirrors interpretResult() in the JS bridge. A refusal carrying a background code is
    the system declining, which the caller may answer by falling back to a foreground
    route; anything else is a fault.
    """
    result = result or {}
    text = "\n".join(
        c.get("text", "") for c in result.get("content", []) or []
        if isinstance(c, dict) and c.get("type") == "text"
    )
    # `content` is the human-readable rendering ("Found 2 windows:"); the machine-readable
    # answer is `structuredContent`. Reading only the text is how the first version of
    # this got back the string "Found 2 windows:" and no windows.
    parsed: Any = result.get("structuredContent")
    if parsed is None:
        try:
            parsed = json.loads(text) if text else None
        except (TypeError, ValueError):
            parsed = None

    code = None
    if isinstance(parsed, dict):
        code = parsed.get("code") or (parsed.get("error") or {}).get("code")
    if (result or {}).get("isError") or code:
        return {
            "ok": False,
            "code": code or "driver_error",
            "background": code in BACKGROUND_REFUSALS,
            "message": (parsed or {}).get("message") if isinstance(parsed, dict) else text or "refused",
        }
    return {"ok": True, "value": parsed if parsed is not None else text}


class CuaLocalBackend:
    """Drives the local display through cua-driver. Start it with `await start()`."""

    name = "cua-local"

    def __init__(self, binary: str | None = None, display: str | None = None) -> None:
        self._binary = binary or find_driver()
        self._display = display or os.environ.get("DISPLAY")
        self._proc: asyncio.subprocess.Process | None = None
        # The window and snapshot the last ui_tree() read, so an action can name an
        # element inside it. Set by ui_tree, used by click/type/key.
        self._pid: int | None = None
        self._window_id: int | None = None
        self._snapshot_id: str | None = None
        # A window this backend is pinned to, set by a caller that already knows which
        # one it means (the benchmark launches the fixture, so it does). Without it the
        # backend guesses, and guessing picked the driver's own cursor overlay.
        self._target: tuple[int, int] | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None

    def installed(self) -> bool:
        return bool(self._binary)

    async def start(self) -> None:
        if self._proc is not None:
            return
        if not self._binary:
            raise DriverUnavailable("cua-driver is not installed (pip install cua-driver)")
        env = {**os.environ}
        if self._display:
            env["DISPLAY"] = self._display
        env.setdefault("CUA_DRIVER_PERMISSION_MODE", "standard")
        self._proc = await asyncio.create_subprocess_exec(
            self._binary, "mcp",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            # asyncio's StreamReader defaults to a 64 KiB line limit, and one MCP
            # message is one line. `tools/list` with full JSON schemas is bigger than
            # that: readline() raised, this reader task died, and every request after
            # it timed out with no error anywhere — measured 2026-09-21, and it looked
            # exactly like the driver ignoring us.
            limit=8 * 1024 * 1024,
        )
        self._reader = asyncio.create_task(self._read_loop())
        await self._request("initialize", {
            "protocolVersion": _PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "nanocrew-bench", "version": "1"},
        }, timeout=_START_TIMEOUT_S)
        await self._notify("notifications/initialized", {})
        logger.info(f"cua-driver started on DISPLAY={self._display or '(none)'}")

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            try:
                line = await self._proc.stdout.readline()
            except (asyncio.LimitOverrunError, ValueError) as err:
                # A message longer than the stream limit. Fail every waiter loudly
                # rather than leaving them to time out one by one against a reader
                # that is no longer running.
                self._fail_all(DriverUnavailable(f"cua-driver sent a message too large to read: {err}"))
                return
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8").strip())
            except (ValueError, UnicodeDecodeError):
                continue  # the driver logs to stderr; stray stdout is not ours
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                if msg.get("error"):
                    fut.set_exception(RuntimeError(str(msg["error"].get("message", "driver error"))))
                else:
                    fut.set_result(msg.get("result"))
        # stdout closed: the driver exited. Same reasoning as above — waiters must be
        # told, not left to time out.
        self._fail_all(DriverUnavailable("cua-driver exited"))

    def _fail_all(self, err: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()

    async def _notify(self, method: str, params: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n").encode())
        await self._proc.stdin.drain()

    async def _request(self, method: str, params: dict, timeout: float = _CALL_TIMEOUT_S) -> Any:
        assert self._proc and self._proc.stdin
        rid = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self._proc.stdin.write(
            (json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode()
        )
        await self._proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise DriverUnavailable(f"cua-driver did not answer {method} in {timeout}s") from None

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None:
            await self.start()
        try:
            return interpret(await self._request("tools/call", {"name": tool, "arguments": args}))
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "code": "driver_error", "background": False, "message": str(err)[:200]}

    # ---------------------------------------------------------------- DesktopBackend

    def set_target(self, pid: int, window_id: int) -> None:
        """Drive this exact window. Clears the remembered snapshot, which belonged to
        whatever window was being read before."""
        self._target = (pid, window_id)
        self._snapshot_id = None

    async def _target_window(self) -> dict[str, Any]:
        """The window this loop is driving.

        The driver's own cursor overlay is a real X11 window and shows up in the list;
        driving it would mean clicking on a drawing of a mouse pointer. Topmost real
        window wins, which is what "the focused window" means here.
        """
        out = await self.call("list_windows", {})
        if not out["ok"] or not isinstance(out["value"], dict):
            raise DriverUnavailable(f"list_windows failed [{out.get('code')}]: {out.get('message')}")
        windows = [w for w in out["value"].get("windows", []) if _is_app_window(w)]
        if self._target is not None:
            pid, window_id = self._target
            pinned = [w for w in windows if w.get("window_id") == window_id]
            if not pinned:
                raise WindowGone(f"window {window_id} (pid {pid}) has closed")
            return pinned[0]
        if not windows:
            raise DriverUnavailable("no application window is on screen")
        windows.sort(key=lambda w: w.get("z_index", 0), reverse=True)
        return windows[0]

    async def _window_exists(self, window_id: int) -> bool:
        out = await self.call("list_windows", {})
        if not out["ok"] or not isinstance(out["value"], dict):
            return True  # cannot tell — do not claim the window closed
        return any(w.get("window_id") == window_id for w in out["value"].get("windows", []))

    async def ui_tree(self, *, max_elements: int, reason: str) -> dict[str, Any]:
        """The focused window's controls.

        Two calls, not one: `list_windows` to find the window, then `get_window_state`
        to walk its AT-SPI tree. There is no `describe` tool — an earlier version of
        this file invented one and every run failed with "describe failed: None".
        """
        window = await self._target_window()
        out = await self.call("get_window_state", {
            "pid": window["pid"], "window_id": window["window_id"],
            "max_elements": max_elements,
        })
        if not out["ok"]:
            # A window that closed mid-run reports as a failed invocation. Ask whether
            # it still exists before calling this a fault: "the dialog we dismissed is
            # gone" and "the driver is broken" need different answers.
            if not await self._window_exists(window["window_id"]):
                raise WindowGone(f"window {window['window_id']} closed while being read")
            raise DriverUnavailable(
                f"get_window_state failed [{out.get('code')}]: {out.get('message')} "
                f"pid={self._pid} window={self._window_id}")
        value = out["value"] if isinstance(out["value"], dict) else {}

        # Remembered so click/type can address an element in THIS snapshot. The driver
        # rejects a token from a stale snapshot, which is the behaviour we want: better
        # a refusal than clicking whatever now sits at that index.
        self._pid = window["pid"]
        self._window_id = window["window_id"]
        self._snapshot_id = value.get("snapshot_id")

        if value.get("degraded"):
            # Say it rather than quietly benchmarking a crippled environment: without
            # AT-SPI the driver recovers window metadata only and cannot prove state.
            logger.warning(f"cua-driver degraded: {str(value.get('degraded_reason'))[:160]}")

        elements = []
        for e in (value.get("elements") or [])[:max_elements]:
            elements.append({
                "name": e.get("label") or "",
                "type": e.get("role") or "",
                "id": e.get("element_token"),
                "enabled": e.get("enabled", True),
                "token": e.get("element_token"),
                "index": e.get("element_index"),
                "actions": e.get("actions"),
                # Carried so the loop can tell that typing changed something. Without a
                # value in the snapshot, a filled field and an empty one look identical.
                "value": e.get("value") or e.get("text"),
                "checked": e.get("checked"),
                "x": e.get("x"), "y": e.get("y"),
            })
        return {
            "window": value.get("window_title"),
            "elements": elements,
            "text": _readable_text(value.get("tree_markdown") or ""),
            # How much of the window this is. GTK virtualises long lists: rows that are
            # off-screen do not exist in the accessibility tree at all, so a target can
            # be genuinely unreachable rather than merely missed. Without this the loop
            # cannot tell "no such control" from "not scrolled to yet".
            "shown": value.get("returned_element_count"),
            "total": value.get("total_element_count"),
            "degraded": bool(value.get("degraded")),
            "source": "cua-driver",
        }

    def _addr(self, token: str | None) -> dict[str, Any]:
        """How an action names its target: the window, plus the element within the
        snapshot the tree came from."""
        args: dict[str, Any] = {"pid": self._pid, "window_id": self._window_id}
        if token:
            args["element_token"] = token
            # Only meaningful WITH an element: a snapshot id identifies which reading of
            # the window the token came from. Sent on its own it is rejected outright
            # (`driver_error`), which is what failed every key press — the refusal was
            # not even a background limit we could escalate past, just a malformed call.
            if self._snapshot_id:
                args["snapshot_id"] = self._snapshot_id
        return args

    async def _act(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        """One action, escalating to the foreground only if the system insists.

        Measured on X11: keyboard input to a window that is not in front comes back
        `background_unavailable` — a system limit, not a fault, and the same one
        cua-driver documents for Linux. Their contract expects the caller to climb an
        escalation ladder rather than give up, so this brings the window forward and
        tries once more.

        That costs the user their focus, so it is never the first move and it is
        recorded (`escalated`) rather than hidden: "it worked" and "it worked by taking
        over your screen" are different answers.
        """
        out = await self.call(tool, args)
        if out["ok"] or not out.get("background"):
            return out
        if self._pid is None or self._window_id is None:
            return out
        logger.info(f"cua-driver: {out['code']} for {tool} — bringing the window forward and retrying")
        front = await self.call("bring_to_front", {"pid": self._pid, "window_id": self._window_id})
        if not front["ok"]:
            return out
        retry = await self.call(tool, args)
        if retry["ok"] and isinstance(retry.get("value"), dict):
            retry["value"]["escalated"] = "foreground"
        return retry

    async def menu(self, *, path: list[str], reason: str) -> Any:
        """Invoke an application menu by path, e.g. ["File", "Export"].

        A menu is not a button. Clicking one opens a native grab that held the driver
        until it timed out (30 s, measured) — cua-driver resolves the path through
        accessibility instead and fails closed on a missing or ambiguous segment rather
        than guessing at pixels.
        """
        out = await self._act("invoke_menu", {
            "pid": self._pid, "window_id": self._window_id, "path": list(path),
        })
        if not out["ok"]:
            raise DriverUnavailable(f"menu {path} refused ({out['code']}): {out['message']}")
        return out["value"]

    async def click(self, *, token, x, y, button, double, reason) -> Any:
        args = self._addr(token)
        args["button"] = button
        if double:
            args["count"] = 2
        if not token and x is not None and y is not None:
            # Coordinates are the fallback the driver itself discourages: they cannot
            # reach a backgrounded window and they land wherever the window now is.
            args["x"], args["y"] = x, y
        out = await self._act("click", args)
        if not out["ok"]:
            raise DriverUnavailable(f"click refused ({out['code']}): {out['message']}")
        return out["value"]

    async def type_text(self, *, text: str, token: str | None, reason: str) -> Any:
        args = self._addr(token)
        args["text"] = text
        out = await self._act("type_text", args)
        if not out["ok"]:
            raise DriverUnavailable(f"type refused ({out['code']}): {out['message']}")
        return out["value"]

    async def key(self, *, keys: str, reason: str) -> Any:
        from nanoagent.agent.effector.desktop.keys import to_x11

        key, modifiers = to_x11(keys)
        args = self._addr(None)
        args["key"] = key
        if modifiers:
            args["modifiers"] = modifiers
        out = await self._act("press_key", args)
        if not out["ok"]:
            raise DriverUnavailable(f"key refused ({out['code']}): {out['message']}")
        return out["value"]

    async def screenshot(self, *, reason: str) -> Any:
        # There is no `screenshot` tool; the display capture is get_desktop_state.
        out = await self.call("get_desktop_state", {})
        if not out["ok"]:
            raise DriverUnavailable(f"screenshot refused: {out['message']}")
        return out["value"]

    async def stop(self) -> None:
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._proc:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:  # noqa: BLE001
                pass
            self._proc = None
