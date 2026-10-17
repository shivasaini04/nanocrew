"""Stage 63 — one key vocabulary, two keyboards.

The loop's prompt asked for Windows SendKeys because Windows was the only place it could
run. cua-driver on X11 refuses `{ENTER}` outright, which failed a benchmark task with
`key refused (driver_error)`. The model now names keys plainly and each backend
translates; these tests are the translation, including the legacy forms a model might
still emit.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.desktop.keys import parse, to_sendkeys, to_x11


@pytest.mark.parametrize("spec,key,mods", [
    ("Enter", "Return", []),
    ("enter", "Return", []),
    ("Return", "Return", []),
    ("Tab", "Tab", []),
    ("Escape", "Escape", []),
    ("Down", "Down", []),
    ("Space", "space", []),
    ("Backspace", "BackSpace", []),
    ("F5", "F5", []),
    ("Ctrl+S", "s", ["ctrl"]),
    ("ctrl+shift+S", "s", ["ctrl", "shift"]),
    ("Alt+F4", "F4", ["alt"]),
])
def test_plain_names_become_x11_keys(spec, key, mods):
    got_key, got_mods = to_x11(spec)
    assert got_key == key
    assert sorted(got_mods) == sorted(mods)


@pytest.mark.parametrize("spec,expected", [
    ("Enter", "{ENTER}"),
    ("Tab", "{TAB}"),
    ("Escape", "{ESC}"),
    ("F5", "{F5}"),
    ("Ctrl+S", "^s"),
    ("Alt+F4", "%{F4}"),
    ("ctrl+shift+s", "^+s"),
])
def test_plain_names_become_sendkeys(spec, expected):
    assert to_sendkeys(spec) == expected


@pytest.mark.parametrize("legacy,key,mods", [
    ("{ENTER}", "Return", []),
    ("{TAB}", "Tab", []),
    ("{F4}", "F4", []),
    ("^s", "s", ["ctrl"]),
    ("%{F4}", "F4", ["alt"]),
    ("+{TAB}", "Tab", ["shift"]),
])
def test_the_old_sendkeys_dialect_is_still_understood(legacy, key, mods):
    """A model that still emits the old syntax must not be refused — the loop has no
    way to ask it again, and refusing cost a benchmark task."""
    got_key, got_mods = to_x11(legacy)
    assert got_key == key
    assert sorted(got_mods) == sorted(mods)


def test_sendkeys_round_trips_the_old_dialect_unchanged():
    assert to_sendkeys("{ENTER}") == "{ENTER}"
    assert to_sendkeys("^s") == "^s"


def test_an_unknown_name_is_passed_on_rather_than_mangled():
    # Better a key the driver may reject by name than a confident press of the wrong one.
    assert to_x11("Menu") == ("Menu", [])
    assert to_sendkeys("Menu") == "{MENU}"


def test_a_single_character_is_that_character():
    assert to_x11("a") == ("a", [])
    assert to_sendkeys("a") == "a"


def test_empty_input_produces_nothing_to_press():
    assert parse("") == ([], "")
    assert to_x11("") == ("", [])
