#!/usr/bin/env python3
"""GUI fixtures for the computer-use benchmark — the shapes zenity cannot express.

zenity gave us dialogs: a field, some buttons, a list. Real desktop work is menus,
controls that are disabled until something else happens, and windows that take a moment
to catch up. Those are where a loop that "works" starts failing, so they need to be in
the benchmark.

Every mode writes a MARKER FILE when its goal is genuinely reached. That is the
verification: a file on disk, written by the application itself, which no amount of
confident reporting by the agent can produce. Same rule as the rest of the harness —
the app's own state decides, not the loop's account of itself.

Run with the SYSTEM python (/usr/bin/python3): PyGObject is a Debian package and the
container's own interpreter cannot see it.

    /usr/bin/python3 gtk_app.py --mode menu --title BENCH-MENU --marker /tmp/m.txt

Modes
    menu      a File menu whose Export item is the only way to succeed
    gated     Apply stays disabled until the checkbox is ticked
    slow      Start does nothing visible for 1.5s, then reveals Finish

Deliberately avoids words the loop refuses as irreversible (submit, send, delete, …) —
that refusal is correct and is tested separately.
"""

from __future__ import annotations

import argparse
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402


def write_marker(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def build_menu(win: Gtk.Window, marker: str, status: Gtk.Label) -> Gtk.Widget:
    """A real menu bar. The goal is only reachable through File -> Export."""
    bar = Gtk.MenuBar()

    file_item = Gtk.MenuItem(label="File")
    file_menu = Gtk.Menu()
    file_item.set_submenu(file_menu)

    export = Gtk.MenuItem(label="Export")
    # A second item so "click the only thing in the menu" is not a winning strategy.
    recent = Gtk.MenuItem(label="Recent files")

    def on_export(_w):
        status.set_text("EXPORTED")
        write_marker(marker, "EXPORTED")

    export.connect("activate", on_export)
    file_menu.append(recent)
    file_menu.append(export)

    help_item = Gtk.MenuItem(label="Help")
    help_item.set_submenu(Gtk.Menu())

    bar.append(file_item)
    bar.append(help_item)
    return bar


def build_gated(box: Gtk.Box, marker: str, status: Gtk.Label) -> None:
    """Apply is disabled until the checkbox is ticked.

    A loop that goes straight for the obvious button gets nothing: the click is
    delivered and the application ignores it, which is exactly the silent failure worth
    catching.
    """
    check = Gtk.CheckButton(label="I agree to the terms")
    apply_btn = Gtk.Button(label="Apply")
    apply_btn.set_sensitive(False)

    def on_toggle(_w):
        apply_btn.set_sensitive(check.get_active())

    def on_apply(_w):
        status.set_text("APPLIED")
        write_marker(marker, "APPLIED")

    check.connect("toggled", on_toggle)
    apply_btn.connect("clicked", on_apply)
    box.pack_start(check, False, False, 4)
    box.pack_start(apply_btn, False, False, 4)


def build_slow(box: Gtk.Box, marker: str, status: Gtk.Label) -> None:
    """Start looks like it did nothing for 1.5 seconds, then Finish appears.

    The loop's own stall detector fires after two unchanged snapshots, so an app that is
    merely slow can be mistaken for an app that is stuck.
    """
    finish = Gtk.Button(label="Finish")
    finish.set_sensitive(False)
    start = Gtk.Button(label="Start")

    def reveal() -> bool:
        finish.set_sensitive(True)
        status.set_text("READY TO FINISH")
        return False  # one-shot

    def on_start(_w):
        status.set_text("WORKING")
        GLib.timeout_add(1500, reveal)

    def on_finish(_w):
        status.set_text("FINISHED")
        write_marker(marker, "FINISHED")

    start.connect("clicked", on_start)
    finish.connect("clicked", on_finish)
    box.pack_start(start, False, False, 4)
    box.pack_start(finish, False, False, 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["menu", "gated", "slow"])
    ap.add_argument("--title", required=True)
    ap.add_argument("--marker", required=True)
    args = ap.parse_args()

    win = Gtk.Window(title=args.title)
    win.set_default_size(420, 220)
    win.connect("destroy", Gtk.main_quit)

    outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    win.add(outer)

    status = Gtk.Label(label="READY")
    status.set_name("status")

    if args.mode == "menu":
        outer.pack_start(build_menu(win, args.marker, status), False, False, 0)
    body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    body.set_margin_top(12)
    body.set_margin_start(12)
    body.set_margin_end(12)
    outer.pack_start(body, True, True, 0)

    if args.mode == "gated":
        build_gated(body, args.marker, status)
    elif args.mode == "slow":
        build_slow(body, args.marker, status)

    body.pack_start(status, False, False, 8)
    win.show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
