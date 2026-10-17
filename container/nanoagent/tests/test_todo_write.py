"""
The todo list must be a record the model cannot quietly edit.

Regression cover for prod agent 0e6ebc15 (2026-07-17), which planned to build crm.html,
built the database, then rewrote its todo list without the three unfinished items —
substituting an invented easier one — and reported "7/7 completed, 0 remaining". The
deliverable was never written and the omission was never mentioned to the user.
"""
import pytest

from nanoagent.agent.tools.todo import TodoWriteTool


def item(id_, content, status="pending", priority="high"):
    return {"id": id_, "content": content, "status": status, "priority": priority}


@pytest.fixture
def todo():
    return TodoWriteTool()


async def test_omitted_pending_item_is_restored(todo):
    await todo.execute([item("1", "Create the database"), item("2", "Write crm.html")])
    out = await todo.execute([item("1", "Create the database", status="completed")])

    contents = [t["content"] for t in todo.get_todos()]
    assert "Write crm.html" in contents, "an unfinished item must survive being left out"
    assert "1 remaining" in out
    assert "⚠️" in out and "restored" in out.lower() or "put back" in out.lower()


async def test_the_prod_sequence(todo):
    """The actual incident, replayed: plan six, do three, rewrite the list without the rest."""
    await todo.execute([
        item("1", "Check tool availability (sql_query, emit_artifact)"),
        item("2", "Create SQLite DB with 4 tables (companies, contacts, deals, touches)"),
        item("3", "Seed 3 fake rows of data"),
        item("4", "Write crm.html with inline CSS/JS, data inlined, next-send panel + kanban"),
        item("5", "Call emit_artifact on crm.html", priority="medium"),
        item("6", "Tell user the chat phrasing for adding a prospect", priority="medium"),
    ])

    # The rewrite. Note id "4" is REUSED for a different task and an item the user never
    # asked for is invented — the two things that made this invisible.
    out = await todo.execute([
        item("1", "Create SQLite schema (companies, contacts, deals, touches)", status="completed"),
        item("2a", "Insert 3 companies: Nova Robotics, Quantum Dynamics, Synthetix AI", status="completed"),
        item("4", "Verify all data with SELECT queries", status="completed"),
        item("3", "Save CRM summary report to workspace", status="completed", priority="medium"),
    ])

    surviving = " | ".join(t["content"] for t in todo.get_todos())
    assert "Write crm.html" in surviving, "the deliverable must not vanish by omission"
    assert "emit_artifact on crm.html" in surviving
    assert "chat phrasing" in surviving
    assert "0 remaining" not in out, "the list must refuse to call this finished"


async def test_reused_id_does_not_hide_a_drop(todo):
    """
    Why the check compares content, not id: the model reshuffles ids freely, and here it
    reused '4' for unrelated work. An id-keyed check sees '4' in both lists, reports
    nothing, and the real task is gone.
    """
    await todo.execute([item("4", "Write crm.html with the next-send panel")])
    await todo.execute([item("4", "Verify all data with SELECT queries", status="completed")])

    contents = [t["content"] for t in todo.get_todos()]
    assert "Write crm.html with the next-send panel" in contents


async def test_cancelled_is_the_supported_way_to_drop_work(todo):
    """Dropping a task stays possible — it just has to be said out loud, and it sticks."""
    await todo.execute([item("1", "Write crm.html")])
    await todo.execute([item("1", "Write crm.html", status="cancelled")])
    assert [t["status"] for t in todo.get_todos()] == ["cancelled"]

    # …and once settled it is not resurrected on the next update.
    await todo.execute([item("2", "Something else")])
    assert [t["content"] for t in todo.get_todos()] == ["Something else"]


async def test_completed_work_is_not_resurrected(todo):
    """Only unfinished items are carried; finished ones are settled and may drop off."""
    await todo.execute([item("1", "Create the database", status="completed")])
    await todo.execute([item("2", "Next task")])
    assert [t["content"] for t in todo.get_todos()] == ["Next task"]


async def test_rewording_is_not_treated_as_a_drop(todo):
    """
    The false positive that would make this unusable: normal rewording between updates
    must not spawn a duplicate. Fuzzy matching earns its keep here.
    """
    await todo.execute([item("1", "Write crm.html with inline CSS and JS")])
    await todo.execute([item("1", "Write the crm.html file with inline CSS and JS", status="in_progress")])
    assert len(todo.get_todos()) == 1


async def test_in_progress_counts_as_unfinished(todo):
    await todo.execute([item("1", "Half-done thing", status="in_progress")])
    await todo.execute([item("2", "Different thing")])
    assert "Half-done thing" in [t["content"] for t in todo.get_todos()]


async def test_clean_update_is_silent(todo):
    """No warning noise when nothing was dropped — the guard must stay invisible in the normal case."""
    await todo.execute([item("1", "Task one"), item("2", "Task two")])
    out = await todo.execute([
        item("1", "Task one", status="completed"),
        item("2", "Task two", status="completed"),
    ])
    assert "⚠️" not in out
    assert "2/2 completed, 0 remaining" in out
