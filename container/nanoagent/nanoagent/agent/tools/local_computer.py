"""The user's own computer: folders, terminal, desktop apps (stage 60 phases 4 and 5).

Three tools, one transport. Each call goes container -> orchestrator
(`/browser-control/dispatch`, cycle-token gated) -> the NanoCrew desktop app on the user's
machine, which checks its own permission rules and asks the person in a native dialog
before anything is shared (desktop/local-policy.js). Nothing here decides what is allowed;
this side only asks and reports what the machine said.

    local_files      roots, request_access, list, read, search, write
    local_terminal   run one command
    local_desktop    screenshot, windows, focus, ui_tree, click, type, key

Available when the run can reach the user's machine: the operator picked "This computer"
under the chat box, or the agent is set to use the user's browser and the desktop app is
connected. With "Cloud" picked, every call says so instead of trying.
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool

# Dialogs wait up to 90 s on the machine; the orchestrator clamps a dispatch at 120 s.
_DISPATCH_TIMEOUT_MS = 118_000
_TEXT_RESULT_CHARS = 20_000


class LocalUnavailable(RuntimeError):
    pass


def _unavailable_reason() -> str | None:
    lane = os.environ.get("NC_BROWSER_LANE", "").strip().lower()
    if lane == "cloud":
        return (
            "The user chose Cloud for this message, so their computer is not available. If the "
            "task needs their files, terminal or apps, say so and ask them to switch the picker "
            "under the message box to This computer."
        )
    from nanoagent.agent.effector.remote_page import RemoteConfig

    if RemoteConfig.from_env() is None:
        return (
            "The user's computer is not connected to this run. Ask them to open the NanoCrew "
            "desktop app and choose This computer under the message box, then try again."
        )
    return None


async def dispatch(capability: str, payload: dict[str, Any]) -> Any:
    """Send one command to the desktop app. Raises LocalUnavailable with a usable message."""
    why = _unavailable_reason()
    if why:
        raise LocalUnavailable(why)
    from nanoagent.agent.effector.remote_page import RemoteConfig

    cfg = RemoteConfig.from_env()
    body = {
        "capability": capability,
        "payload": {**payload, "agentName": os.environ.get("AGENT_NAME") or None},
        "controllerId": cfg.controller_id,
        "browserProfileId": cfg.browser_profile_id,
        "timeoutMs": _DISPATCH_TIMEOUT_MS,
    }
    try:
        async with httpx.AsyncClient(timeout=_DISPATCH_TIMEOUT_MS / 1000 + 10) as client:
            res = await client.post(
                f"{cfg.host}/api/agents/{cfg.agent_id}/browser-control/dispatch",
                headers={"X-Cycle-Token": cfg.cycle_token},
                json=body,
            )
    except Exception as err:  # noqa: BLE001
        raise LocalUnavailable(f"Could not reach the user's computer: {err}") from err

    if res.status_code == 401:
        raise LocalUnavailable("This run's token was rejected — the run may have ended.")
    try:
        data = res.json()
    except Exception:  # noqa: BLE001
        raise LocalUnavailable(f"The broker answered {res.status_code}: {res.text[:200]}") from None
    if res.status_code == 409 or not data.get("ok"):
        msg = str(data.get("error") or f"HTTP {res.status_code}")
        if "capability not implemented" in msg or "no controller for" in msg:
            msg = (
                "The connected app cannot do this. The user needs the NanoCrew desktop app "
                "(an up-to-date version) — the browser extension and the companion only lend "
                "the browser."
            )
        raise LocalUnavailable(msg)
    return data.get("result")


def _ok(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _err(msg: str) -> str:
    return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)


def _inside(workspace: Path, rel: str) -> Path:
    p = (workspace / rel).resolve() if not os.path.isabs(rel) else Path(rel).resolve()
    ws = workspace.resolve()
    if p != ws and ws not in p.parents:
        raise ValueError(f"{rel} is outside your workspace")
    return p


class LocalFilesTool(Tool):
    def __init__(self, workspace: Path):
        self._workspace = Path(workspace)

    @property
    def name(self) -> str:
        return "local_files"

    @property
    def description(self) -> str:
        return (
            "Read and save files on the USER'S OWN COMPUTER (not your workspace), through the "
            "NanoCrew desktop app. The first time you touch a folder the user is asked in a "
            "dialog on their screen, so give a short `reason`. Actions: "
            "roots (folders already shared), request_access (ask for a folder; omit path to let "
            "them pick one), list, read (text comes back inline; binary or large files can be "
            "saved into your workspace with save_to), search (file names under a folder), write "
            "(content, or from_workspace to copy a file you made — e.g. an .xlsx — onto their "
            "computer). Paths are the user's own, e.g. C:\\Users\\name\\Documents or ~/Documents. "
            "Never retry a denied folder in the same run; say what you needed instead."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["roots", "request_access", "list", "read", "search", "write"]},
                "path": {"type": "string", "description": "A folder or file on the user's computer."},
                "mode": {"type": "string", "enum": ["read", "write"], "description": "For request_access. Default read."},
                "query": {"type": "string", "description": "For search: part of a file name."},
                "content": {"type": "string", "description": "For write: the text to save."},
                "from_workspace": {"type": "string", "description": "For write: a file in YOUR workspace to copy to `path`."},
                "save_to": {"type": "string", "description": "For read: also save the file into your workspace at this path."},
                "overwrite": {"type": "boolean", "description": "For write: replace an existing file. Default false."},
                "reason": {"type": "string", "description": "One line the user sees in the permission dialog."},
            },
            "required": ["action"],
        }

    async def execute(self, action: str, **kw: Any) -> str:
        try:
            if action == "roots":
                return _ok(await dispatch("fs.roots", {}))
            if action == "request_access":
                return _ok(await dispatch("fs.request", {"path": kw.get("path"), "mode": kw.get("mode") or "read", "reason": kw.get("reason")}))
            if action == "list":
                return _ok(await dispatch("fs.list", {"path": kw.get("path"), "reason": kw.get("reason")}))
            if action == "search":
                return _ok(await dispatch("fs.search", {"path": kw.get("path"), "query": kw.get("query"), "reason": kw.get("reason")}))
            if action == "read":
                res = await dispatch("fs.read", {"path": kw.get("path"), "reason": kw.get("reason")}) or {}
                raw = res.get("content") or ""
                saved = None
                if kw.get("save_to"):
                    dest = _inside(self._workspace, str(kw["save_to"]))
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    data = base64.b64decode(raw) if res.get("encoding") == "base64" else raw.encode("utf-8")
                    dest.write_bytes(data)
                    saved = str(dest)
                out = {k: res.get(k) for k in ("path", "size", "encoding", "truncated")}
                if saved:
                    out["saved_to"] = saved
                if res.get("encoding") == "text":
                    out["content"] = raw[:_TEXT_RESULT_CHARS]
                    if len(raw) > _TEXT_RESULT_CHARS:
                        out["content_truncated"] = f"showing {_TEXT_RESULT_CHARS} of {len(raw)} characters; use save_to to keep all of it"
                elif not saved:
                    out["note"] = "Binary file — pass save_to to put it in your workspace, then open it with the right tool."
                return _ok(out)
            if action == "write":
                if kw.get("from_workspace"):
                    src = _inside(self._workspace, str(kw["from_workspace"]))
                    if not src.is_file():
                        return _err(f"{kw['from_workspace']} is not a file in your workspace")
                    payload = {"content": base64.b64encode(src.read_bytes()).decode("ascii"), "encoding": "base64"}
                elif isinstance(kw.get("content"), str):
                    payload = {"content": kw["content"], "encoding": "text"}
                else:
                    return _err("write needs content or from_workspace")
                return _ok(await dispatch("fs.write", {
                    "path": kw.get("path"), "overwrite": bool(kw.get("overwrite")), "reason": kw.get("reason"), **payload,
                }))
            return _err(f"unknown action {action!r}")
        except LocalUnavailable as err:
            return _err(str(err))
        except ValueError as err:
            return _err(str(err))


class LocalTerminalTool(Tool):
    @property
    def name(self) -> str:
        return "local_terminal"

    @property
    def description(self) -> str:
        return (
            "Run ONE command on the USER'S OWN COMPUTER through the NanoCrew desktop app — "
            "PowerShell on Windows, bash elsewhere. The user sees the exact command in a dialog "
            "and must allow it (they can always-allow a simple exact command). Use it for what "
            "only their machine can do: their installed programs, local projects, opening a "
            "file in its app. Prefer your own shell for everything else. `cwd` must be a folder "
            "they share. Output is capped; a command times out after 100 s."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "cwd": {"type": "string", "description": "Folder on their computer to run in."},
                "timeout_s": {"type": "integer", "description": "Max 100. Default 60."},
                "reason": {"type": "string", "description": "One line the user sees in the dialog."},
            },
            "required": ["command"],
        }

    async def execute(self, command: str, cwd: str | None = None, timeout_s: int | None = None,
                      reason: str | None = None, **_: Any) -> str:
        try:
            res = await dispatch("shell.run", {
                "command": command, "cwd": cwd, "reason": reason,
                "timeoutMs": int(min(max(timeout_s or 60, 1), 100) * 1000),
            })
            return _ok(res)
        except LocalUnavailable as err:
            return _err(str(err))


class LocalDesktopTool(Tool):
    def __init__(self, workspace: Path):
        self._workspace = Path(workspace)

    @property
    def name(self) -> str:
        return "local_desktop"

    @property
    def description(self) -> str:
        return (
            "See and operate desktop apps on the USER'S OWN COMPUTER (Windows) — for things "
            "that are not in a browser: Excel, a desktop CRM, a file dialog. The first call asks "
            "the user to allow control for 15 minutes. Actions: screenshot (saved to your "
            "workspace — look at it with read_image), windows, focus (by title), ui_tree (the "
            "focused window's buttons and fields with click points — use this before guessing "
            "from pixels), click (x,y in SCREENSHOT pixels), type (text), key (SendKeys: ^s, "
            "{ENTER}, %{TAB}). Work step by step: look, act once, look again. For websites use "
            "the browser tools instead."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["screenshot", "windows", "focus", "ui_tree", "click", "type", "key"]},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "button": {"type": "string", "enum": ["left", "right"]},
                "double": {"type": "boolean"},
                "text": {"type": "string"},
                "keys": {"type": "string"},
                "title": {"type": "string"},
                "reason": {"type": "string", "description": "One line the user sees when asked to allow control."},
            },
            "required": ["action"],
        }

    async def execute(self, action: str, **kw: Any) -> str:
        try:
            if action == "screenshot":
                res = await dispatch("desktop.screenshot", {"reason": kw.get("reason")}) or {}
                data_url = str(res.get("dataUrl") or "")
                if "," not in data_url:
                    return _err("the desktop app returned no image")
                shots = self._workspace / ".local" / "screens"
                shots.mkdir(parents=True, exist_ok=True)
                dest = shots / f"screen-{int(time.time() * 1000)}.jpg"
                dest.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
                return _ok({
                    "saved_to": str(dest), "width": res.get("width"), "height": res.get("height"),
                    "next": f"read_image(file='{dest}') to look at it; click coordinates are in this image's pixels.",
                })
            capability = {
                "windows": "desktop.windows", "focus": "desktop.focus", "ui_tree": "desktop.ui_tree",
                "click": "desktop.click", "type": "desktop.type", "key": "desktop.key",
            }.get(action)
            if not capability:
                return _err(f"unknown action {action!r}")
            payload = {k: kw[k] for k in ("x", "y", "button", "double", "text", "keys", "title", "reason") if k in kw}
            return _ok(await dispatch(capability, payload))
        except LocalUnavailable as err:
            return _err(str(err))
