"""A dynamic tool stays monitored across update and rollback.

Auto-rollback is the only thing standing between a bad generation and a tool that keeps
failing silently, and it depends entirely on DynamicTool holding a health monitor —
`record_execution` is guarded by `if self._health_monitor`. Four construction sites created
the tool without one, so:

  * a tool re-registered after an UPDATE lost its rollback protection permanently
  * `DynamicToolManager.rollback_tool` — which IS the auto-rollback trigger — handed back an
    unmonitored tool, so automatic rollback could fire exactly once per tool and never again

Both are silent: the tool works, it just stops being watched.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanoagent.agent.tools.dynamic import generate as gen  # noqa: E402
from nanoagent.agent.tools.dynamic.manager import DynamicToolManager  # noqa: E402
from nanoagent.agent.tools.dynamic.tool import DynamicTool  # noqa: E402


def test_no_construction_site_builds_an_unmonitored_tool():
    """The regression, stated directly against the source: a bare `DynamicTool(manifest)`
    anywhere in the generate/update/rollback paths is a tool nothing will ever roll back."""
    src = Path(gen.__file__).read_text(encoding="utf-8")

    assert "DynamicTool(manifest)" not in src, (
        "a DynamicTool built without health_monitor= will never record executions"
    )
    assert src.count("DynamicTool(manifest, health_monitor=self._health_monitor)") == 4


def test_the_manager_carries_a_monitor_for_its_own_rollback():
    assert "health_monitor" in inspect.signature(DynamicToolManager.__init__).parameters

    mgr = DynamicToolManager(health_monitor="sentinel")

    assert mgr._health_monitor == "sentinel"


def test_manager_rollback_reregisters_a_monitored_tool():
    src = Path(DynamicToolManager.__module__ and
               sys.modules[DynamicToolManager.__module__].__file__).read_text(encoding="utf-8")

    assert "DynamicTool(manifest, health_monitor=self._health_monitor)" in src


def test_every_tool_that_reregisters_accepts_a_monitor():
    """UpdateToolTool and RollbackToolTool re-register tools, so both need to carry one."""
    for cls in (gen.GenerateToolTool, gen.UpdateToolTool, gen.RollbackToolTool,
                gen.RegisterToolFromDirTool):
        params = inspect.signature(cls.__init__).parameters
        assert "health_monitor" in params, f"{cls.__name__} cannot carry a health monitor"


def test_they_actually_store_it():
    for cls in (gen.UpdateToolTool, gen.RollbackToolTool):
        tool = cls(registry=None, persistence=None, health_monitor="sentinel")
        assert tool._health_monitor == "sentinel", f"{cls.__name__} dropped the monitor"


def test_dynamic_tool_only_records_when_it_has_a_monitor():
    """Why the wiring matters at all — the guard that makes an unmonitored tool silent."""
    src = Path(DynamicTool.__module__ and
               sys.modules[DynamicTool.__module__].__file__).read_text(encoding="utf-8")

    assert "if self._health_monitor:" in src
    assert "record_execution" in src


def test_the_agent_loop_passes_a_monitor_to_all_three():
    """Wiring the classes is useless if the registration site still omits it."""
    from nanoagent.agent import loop as agent_loop

    src = Path(agent_loop.__file__).read_text(encoding="utf-8")
    for name in ("UpdateToolTool(", "RollbackToolTool(", "RegisterToolFromDirTool("):
        line = next(ln for ln in src.splitlines() if name in ln and "register(" in ln)
        assert "health_monitor=self.health_monitor" in line, f"{name} registered unmonitored"
