"""One key vocabulary, two keyboards.

The desktop loop's prompt used to ask for **Windows SendKeys** syntax — `{ENTER}`, `^s`,
`%{F4}` — because the only machine it could reach was Windows. The moment a second
backend existed, that leaked: cua-driver on X11 wants `Return` with a `ctrl` modifier and
refuses `{ENTER}` outright (`key refused (driver_error)`, measured 2026-09-21 on the
long-list benchmark task).

So the model now names keys the way a person would — `Enter`, `Tab`, `Ctrl+S`,
`Alt+F4` — and each backend translates into whatever its keyboard wants. A model should
not have to know which operating system is on the other end of the loop.
"""

from __future__ import annotations

# Canonical name -> (SendKeys token, X11 keysym). Lower-case keys; lookup is folded.
_NAMED: dict[str, tuple[str, str]] = {
    "enter": ("{ENTER}", "Return"),
    "return": ("{ENTER}", "Return"),
    "tab": ("{TAB}", "Tab"),
    "escape": ("{ESC}", "Escape"),
    "esc": ("{ESC}", "Escape"),
    "space": ("{SPACE}", "space"),
    "backspace": ("{BACKSPACE}", "BackSpace"),
    "delete": ("{DELETE}", "Delete"),
    "home": ("{HOME}", "Home"),
    "end": ("{END}", "End"),
    "pageup": ("{PGUP}", "Page_Up"),
    "pagedown": ("{PGDN}", "Page_Down"),
    "up": ("{UP}", "Up"),
    "down": ("{DOWN}", "Down"),
    "left": ("{LEFT}", "Left"),
    "right": ("{RIGHT}", "Right"),
    "insert": ("{INSERT}", "Insert"),
}
for _n in range(1, 13):  # F1..F12
    _NAMED[f"f{_n}"] = (f"{{F{_n}}}", f"F{_n}")

_MODIFIERS = {
    "ctrl": ("^", "ctrl"), "control": ("^", "ctrl"),
    "alt": ("%", "alt"),
    "shift": ("+", "shift"),
    "win": ("", "super"), "super": ("", "super"), "cmd": ("", "super"),
}


def parse(spec: str) -> tuple[list[str], str]:
    """`"Ctrl+Shift+S"` -> `(["ctrl", "shift"], "s")`.

    Also accepts what the old prompt produced, so a model that still emits `{ENTER}` or
    `^s` is understood rather than refused — the loop has no way to re-ask.
    """
    text = (spec or "").strip()
    if not text:
        return [], ""

    # Legacy SendKeys: leading ^ % + modifiers, and {NAME} tokens.
    mods: list[str] = []
    while text and text[0] in "^%+":
        mods.append({"^": "ctrl", "%": "alt", "+": "shift"}[text[0]])
        text = text[1:]
    if text.startswith("{") and text.endswith("}"):
        text = text[1:-1]

    parts = [p for p in text.replace("-", "+").split("+") if p.strip()] if "+" in text else [text]
    key = parts[-1].strip() if parts else ""
    for part in parts[:-1]:
        canonical = _MODIFIERS.get(part.strip().lower())
        if canonical:
            mods.append(canonical[1])
    return mods, key


def to_sendkeys(spec: str) -> str:
    """What the Windows desktop app's `desktop.key` expects."""
    mods, key = parse(spec)
    prefix = "".join({"ctrl": "^", "alt": "%", "shift": "+"}.get(m, "") for m in mods)
    named = _NAMED.get(key.lower())
    if named:
        return prefix + named[0]
    # LOWER-CASED on purpose. SendKeys reads an upper-case letter as shifted, so "^S"
    # is Ctrl+Shift+S, not Ctrl+S — in most editors the difference between "Save As"
    # and "Save". Shift is only ever expressed by the explicit "+" prefix above.
    # Anything longer and unknown is passed untouched rather than mangled into
    # something that would press the wrong key.
    return prefix + (key.lower() if len(key) == 1 else f"{{{key.upper()}}}")


def to_x11(spec: str) -> tuple[str, list[str]]:
    """`(key, modifiers)` for cua-driver's press_key on X11."""
    mods, key = parse(spec)
    named = _NAMED.get(key.lower())
    if named:
        return named[1], mods
    if len(key) == 1:
        return key.lower(), mods
    # Unknown multi-character name: hand it over capitalised, which is the X11
    # convention (Return, Escape, BackSpace) and the best guess available.
    return key[:1].upper() + key[1:], mods
