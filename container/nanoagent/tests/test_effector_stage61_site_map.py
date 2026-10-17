"""Stage 61 phase 5 — the shared site map (effector/site_map.py): an owner's agents share
compiled reads and per-site notes through one mounted directory; without it, each agent
keeps its own, as before."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.domain_memory import append_domain_note, load_domain_notes
from nanoagent.agent.effector.site_map import site_map_base, write_atomic
from nanoagent.agent.effector.synthesis import compiled_read as cr

PAGE = '<html><body><div id="m"><p class="price">£51.77</p></div></body></html>'


def _read(url="https://books.example/attic"):
    return cr.CompiledRead(domain="books.example", goal="Find the price",
                           goal_hash=cr._goal_hash("books.example", "Find the price"),
                           url=url, fields={"answer": "#m > p:nth-of-type(1)"})


def test_without_a_mounted_map_each_agent_keeps_its_own(tmp_path, monkeypatch):
    monkeypatch.delenv("EFFECTOR_SITE_MAP_DIR", raising=False)
    assert site_map_base(tmp_path) == tmp_path / ".effector"


def test_a_map_that_is_not_there_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(tmp_path / "missing"))
    assert site_map_base(tmp_path / "ws") == tmp_path / "ws" / ".effector"


def test_a_read_one_agent_compiled_serves_its_sibling(tmp_path, monkeypatch):
    shared = tmp_path / "owner-map"
    shared.mkdir()
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(shared))
    agent_a, agent_b = tmp_path / "agent-a", tmp_path / "agent-b"
    cr.save_compiled_read(agent_a, _read())
    with patch.object(cr, "_fetch", return_value=PAGE):
        hit = cr.replay_read(agent_b, "books.example", "Find the price")
    assert hit == {"url": "https://books.example/attic", "extracted_data": {"answer": "£51.77"}}
    assert not (agent_a / ".effector").exists()  # it went to the map, not agent A's workspace


def test_different_owners_do_not_see_each_others_map(tmp_path, monkeypatch):
    owner1, owner2 = tmp_path / "map-1", tmp_path / "map-2"
    owner1.mkdir(); owner2.mkdir()
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(owner1))
    cr.save_compiled_read(tmp_path / "a", _read())
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(owner2))
    assert cr.load_compiled_read(tmp_path / "b", "books.example", "Find the price") is None


def test_site_notes_are_shared_and_old_private_notes_still_read(tmp_path, monkeypatch):
    shared = tmp_path / "owner-map"
    shared.mkdir()
    agent_a, agent_b = tmp_path / "agent-a", tmp_path / "agent-b"
    # Agent B learned something before the map existed.
    monkeypatch.delenv("EFFECTOR_SITE_MAP_DIR", raising=False)
    append_domain_note(agent_b, "old.example", "private lesson")
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(shared))
    assert load_domain_notes(agent_b, "old.example") == ["private lesson"]
    # A lesson agent A learns now reaches agent B.
    append_domain_note(agent_a, "shop.example", "City is a combobox.")
    assert load_domain_notes(agent_b, "shop.example") == ["City is a combobox."]


def test_write_atomic_replaces_the_whole_file(tmp_path):
    p = tmp_path / "x" / "f.json"
    write_atomic(p, json.dumps([1]))
    write_atomic(p, json.dumps([1, 2]))
    assert json.loads(p.read_text()) == [1, 2]
    assert [f.name for f in p.parent.iterdir()] == ["f.json"]  # no temp files left


def test_a_call_with_no_url_finds_the_read_by_its_goal(tmp_path, monkeypatch):
    # Found live 2026-09-20: the sibling agent called effector without a url.
    shared = tmp_path / "owner-map"
    shared.mkdir()
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(shared))
    cr.save_compiled_read(tmp_path / "agent-a", _read())
    with patch.object(cr, "_fetch", return_value=PAGE):
        assert cr.replay_read(tmp_path / "agent-b", None, "  find the PRICE ") == {
            "url": "https://books.example/attic", "extracted_data": {"answer": "£51.77"},
        }
        assert cr.replay_read(tmp_path / "agent-b", None, "Find the price of something else") is None


@pytest.mark.asyncio
async def test_the_tool_uses_the_map_even_when_no_url_is_given(tmp_path, monkeypatch):
    from nanoagent.agent.tools.effector import EffectorTool

    shared = tmp_path / "owner-map"
    shared.mkdir()
    monkeypatch.setenv("EFFECTOR_SITE_MAP_DIR", str(shared))
    cr.save_compiled_read(tmp_path / "agent-a", _read())

    class _NoBrowser:
        def __init__(self, *a, **kw):
            raise AssertionError("a compiled read must not start a browser")

    tool = EffectorTool(workspace=tmp_path / "agent-b", provider=None, model="fake/model")
    with patch.object(cr, "_fetch", return_value=PAGE), \
         patch("nanoagent.agent.effector.browser_session.EffectorSession", _NoBrowser):
        out = json.loads(await tool.execute(goal="Find the price"))
    assert out["route"] == "compiled_read" and out["extracted_data"] == {"answer": "£51.77"}
