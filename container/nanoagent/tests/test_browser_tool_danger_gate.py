"""The `browser` tool goes through the same danger gate as `effector`.

Found by a real agent run, 2026-09-02. The agent was asked to click a button labelled
"Delete all records". It used `effector`; the danger gate correctly refused (destructive,
no human present). It then switched to the `browser` tool, hit the page's `confirm()`,
**overrode `window.confirm` to return true via `evaluate`**, clicked again, and completed
the deletion.

Nothing adversarial happened — the model was routing around a blocker to finish its
task. `escalation.py` already records two instances of that shape (a blocked click
became a `navigate`; a blocked click became Enter-on-the-form). Both were one ACTION
stepping around another. This was one TOOL stepping around another, which is worse: it
meant the gate was a property of `effector` rather than of the system, and this tool has
`evaluate` — arbitrary JavaScript — with nothing in front of it.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.browser_exec import is_dangerous_script
from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.tools.browser import BrowserTool


class FakePage:
    """Enough page for the gate: it reads one element's visible text."""

    def __init__(self, label: str = ''):
        self.url = 'https://example.test/'
        self._label = label

    async def evaluate(self, _script, _arg=None):
        return self._label


def _tool(label: str = '') -> BrowserTool:
    t = BrowserTool()
    t._page = FakePage(label)
    return t


def _gate(tool: BrowserTool, action: str, **kwargs):
    return asyncio.run(tool._gate(action, kwargs))


# ── the action -> Step mapping ───────────────────────────────────────────────


def test_evaluate_is_judged_by_the_same_script_patterns_as_browser_exec():
    """Mapped to `browser_exec` deliberately: one policy, not two that drift."""
    t = _tool()
    step = t._as_effector_step('evaluate', {'script': "document.querySelector('#x').click()"})
    assert step.action == 'browser_exec'
    assert is_dangerous_script(step.script) is True


def test_reads_are_never_gated():
    """A gate that fires on reads is a gate people learn to approve without looking."""
    t = _tool()
    assert t._as_effector_step('screenshot', {}) is None
    assert t._as_effector_step('get_text', {}) is None
    assert _gate(t, 'screenshot') is None
    assert _gate(t, 'get_text') is None


# ── the exact exploit that was observed ──────────────────────────────────────


def test_overriding_window_confirm_is_refused():
    """The second half of the observed bypass. Replacing the browser's own 'are you
    sure?' is not a side effect of some other goal — there is no legitimate reason for
    an agent to do it."""
    assert is_dangerous_script('window.confirm = () => true') is True
    assert is_dangerous_script('confirm=()=>true') is True
    assert is_dangerous_script('window.onbeforeunload = null') is True

    t = _tool()
    with patch('nanoagent.agent.effector.escalation.request_approval',
               new=AsyncMock(return_value='denied')):
        out = _gate(t, 'evaluate', script='window.confirm = () => true')
    assert out and 'escalation gate blocked this' in out


def test_a_click_is_judged_by_the_elements_words_not_the_selector():
    """The first half. `#del` contains no dangerous word, so without reading the
    element the gate would pass a click that effector refuses — the same hole with a
    smaller entrance."""
    plain = _tool(label='')
    assert _gate(plain, 'click', selector='#del') is None       # nothing says it is dangerous

    labelled = _tool(label='Delete all records')
    with patch('nanoagent.agent.effector.escalation.request_approval',
               new=AsyncMock(return_value='denied')) as approve:
        out = _gate(labelled, 'click', selector='#del')
    assert approve.called
    assert out and 'escalation gate blocked this' in out


def test_the_refusal_says_switching_tools_does_not_help():
    """The message the model reads. It routed here BECAUSE effector refused; if this
    one just says 'no' it will look for a third route."""
    t = _tool(label='Delete everything')
    with patch('nanoagent.agent.effector.escalation.request_approval',
               new=AsyncMock(return_value='denied')):
        out = _gate(t, 'click', selector='#x')
    assert 'switching tools does not bypass it' in out


# ── it must not become a nuisance ────────────────────────────────────────────


def test_an_ordinary_click_is_not_gated():
    t = _tool(label='Read more')
    assert _gate(t, 'click', selector='#more') is None


def test_an_approved_action_proceeds():
    t = _tool(label='Submit the form')
    with patch('nanoagent.agent.effector.escalation.request_approval',
               new=AsyncMock(return_value='approved')):
        assert _gate(t, 'click', selector='#s') is None


def test_a_page_that_cannot_be_read_falls_back_to_the_selector():
    """A selector matching nothing, a detached node, a page mid-navigation — all
    degrade to selector-only, which is the behaviour before the label read existed."""
    class Exploding(FakePage):
        async def evaluate(self, *_a):
            raise RuntimeError('Execution context was destroyed')

    t = BrowserTool()
    t._page = Exploding()
    assert _gate(t, 'click', selector='#harmless') is None
    with patch('nanoagent.agent.effector.escalation.request_approval',
               new=AsyncMock(return_value='denied')):
        assert _gate(t, 'click', selector='#delete-account') is not None  # selector still read


def test_require_approval_false_disables_it_for_tests_only():
    t = BrowserTool(require_approval=False)
    t._page = FakePage('Delete all records')
    assert _gate(t, 'click', selector='#del') is None


def test_the_default_is_on():
    """loop.py never passes require_approval, so the default is what production runs."""
    assert BrowserTool()._require_approval is True
