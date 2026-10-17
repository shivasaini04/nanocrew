"""Unit tests for Phase 23: Speculative Action Branching & Ephemeral State Rollback."""

import pytest
from nanoagent.agent.effector.resilience.speculative_rollback import (
    EphemeralTabCheckpoint,
    SpeculativeScope,
    capture_tab_checkpoint,
    restore_tab_checkpoint,
)


class FakeRollbackPage:
    def __init__(self, initial_url: str = "https://example.com/step1"):
        self.url = initial_url
        self.actions = []
        self.storage = {"key1": "val1"}

    async def goto(self, url: str, **kw):
        self.actions.append(("goto", url))
        self.url = url

    async def evaluate(self, script: str, arg=None):
        self.actions.append(("evaluate", script))
        if "return res;" in script:
            return dict(self.storage)
        if arg and isinstance(arg, dict):
            self.storage = dict(arg)
        return True


class FakeRollbackContext:
    def __init__(self):
        self._cookies = [{"name": "session_id", "value": "xyz123"}]

    async def cookies(self):
        return list(self._cookies)

    async def add_cookies(self, cookies):
        self._cookies = list(cookies)


@pytest.mark.asyncio
async def test_capture_and_restore_checkpoint():
    page = FakeRollbackPage("https://example.com/checkout")
    context = FakeRollbackContext()

    checkpoint = await capture_tab_checkpoint(page, context)
    assert checkpoint.url == "https://example.com/checkout"
    assert checkpoint.cookies[0]["value"] == "xyz123"
    assert checkpoint.local_storage["key1"] == "val1"

    # Simulate state change
    page.url = "https://example.com/dead_end_modal"
    page.storage["key1"] = "corrupted_val"

    success = await restore_tab_checkpoint(page, checkpoint, context)
    assert success is True
    assert page.url == "https://example.com/checkout"
    assert page.storage["key1"] == "val1"


@pytest.mark.asyncio
async def test_speculative_scope_rolls_back_on_exception():
    page = FakeRollbackPage("https://example.com/initial")
    context = FakeRollbackContext()

    scope_ref = None
    with pytest.raises(RuntimeError, match="branch error"):
        async with SpeculativeScope(page, context) as scope:
            scope_ref = scope
            page.url = "https://example.com/bad_page"
            raise RuntimeError("branch error")

    assert scope_ref is not None
    assert scope_ref.rolled_back is True
    assert page.url == "https://example.com/initial"


@pytest.mark.asyncio
async def test_restore_reloads_even_when_the_url_string_never_changed():
    """Real bug, 2026-08-27 (test 4.2): a macro step can mutate the page (select a
    react-select value, which never touches page.url) without ever changing the URL
    string — none of that mutation is cookies or localStorage, so this checkpoint
    could never capture or undo it. Skipping the reload here left a genuinely-mutated
    page in place after a "rollback," which a caller (react_loop._try_macro_fast_path)
    then handed to a fresh ReAct loop with no explanation for what it would find."""
    page = FakeRollbackPage("https://example.com/form")
    context = FakeRollbackContext()

    checkpoint = await capture_tab_checkpoint(page, context)
    assert page.url == "https://example.com/form"  # unchanged going in

    success = await restore_tab_checkpoint(page, checkpoint, context)
    assert success is True
    assert ("goto", "https://example.com/form") in page.actions, (
        "a same-URL rollback must still reload the page — real component/DOM state "
        "can mutate without the URL ever changing"
    )
