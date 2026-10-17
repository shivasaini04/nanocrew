"""CDP Isolated World Execution & DOM Introspection Cloaking.

Provides an air-gapped JavaScript execution context via Chrome DevTools Protocol
(Page.createIsolatedWorld). Automation and perception queries executed in this
world operate against the ground-truth DOM tree while remaining completely invisible
to in-page telemetry, prototype traps, and monitoring scripts in the main world.
"""

from __future__ import annotations

import json
from typing import Any
from loguru import logger


class IsolatedWorldManager:
    """Manages an isolated execution context for safe, cloaked DOM evaluation."""

    WORLD_NAME = "EffectorIsolatedWorld"

    def __init__(self, page_or_frame: Any, cdp_session: Any = None) -> None:
        self._target = page_or_frame
        self._cdp = cdp_session
        self._context_id: int | None = None
        self._initialized: bool = False

    @property
    def cdp_session(self) -> Any:
        return self._cdp

    @cdp_session.setter
    def cdp_session(self, session: Any) -> None:
        self._cdp = session
        self._context_id = None
        self._initialized = False

    def reset(self) -> None:
        """Resets the context ID (e.g. on navigation)."""
        self._context_id = None
        self._initialized = False

    async def initialize(self) -> bool:
        """Provisions the isolated execution world in the main frame via CDP."""
        if self._cdp is None:
            return False

        try:
            # 1. Resolve Frame ID
            frame_tree = await self._cdp.send("Page.getFrameTree")
            main_frame_id = (
                frame_tree.get("frameTree", {}).get("frame", {}).get("id")
                or frame_tree.get("frame", {}).get("id")
            )
            if not main_frame_id:
                logger.debug("effector: unable to resolve main frameId for isolated world")
                return False

            # 2. Create isolated world
            result = await self._cdp.send(
                "Page.createIsolatedWorld",
                {
                    "frameId": main_frame_id,
                    "worldName": self.WORLD_NAME,
                    "grantUniversalAccess": True,
                },
            )
            self._context_id = result.get("executionContextId")
            self._initialized = True
            logger.debug(f"effector: created isolated execution world (contextId={self._context_id})")
            return True
        except Exception as err:
            logger.debug(f"effector: failed to initialize CDP isolated world ({err}) — using fallback")
            self._context_id = None
            self._initialized = False
            return False

    async def evaluate(self, expression: str, arg: Any = None, return_by_value: bool = True) -> Any:
        """Executes a JavaScript expression or function safely inside the isolated world.

        If CDP is unavailable or if isolated evaluation encounters an error,
        it automatically falls back to standard in-page evaluate().
        """
        # If no CDP session or initialization fails, use standard target.evaluate
        if self._cdp is None:
            return await self._fallback_evaluate(expression, arg)

        if not self._initialized or self._context_id is None:
            ok = await self.initialize()
            if not ok or self._context_id is None:
                return await self._fallback_evaluate(expression, arg)

        # Prepare invocation expression
        expr = expression.strip()
        if arg is not None:
            serialized_arg = json.dumps(arg)
            # Wrap function expression or anonymous arrow function with invocation
            if expr.startswith("(") or expr.startswith("function") or "=>" in expr:
                eval_script = f"({expr})({serialized_arg})"
            else:
                eval_script = f"(function(arg) {{ {expr} }})({serialized_arg})"
        else:
            if expr.startswith("(") or expr.startswith("function") or "=>" in expr:
                eval_script = f"({expr})()"
            else:
                eval_script = expr

        try:
            res = await self._cdp.send(
                "Runtime.evaluate",
                {
                    "expression": eval_script,
                    "contextId": self._context_id,
                    "returnByValue": return_by_value,
                    "awaitPromise": True,
                    "userGesture": True,
                },
            )
            if "exceptionDetails" in res:
                exc = res["exceptionDetails"]
                err_msg = exc.get("exception", {}).get("description") or exc.get("text", "Unknown error")
                logger.debug(f"effector: isolated world evaluation threw ({err_msg}) — falling back")
                return await self._fallback_evaluate(expression, arg)

            result_val = res.get("result", {}).get("value")
            return result_val
        except Exception as err:
            logger.debug(f"effector: CDP isolated evaluate error ({err}) — falling back")
            # If context was destroyed (e.g. navigation), reset it
            self.reset()
            return await self._fallback_evaluate(expression, arg)

    async def _fallback_evaluate(self, expression: str, arg: Any = None) -> Any:
        """Fallback to standard evaluate on page or frame."""
        if hasattr(self._target, "evaluate"):
            if arg is not None:
                return await self._target.evaluate(expression, arg)
            return await self._target.evaluate(expression)
        return None


async def evaluate_isolated(target: Any, expression: str, arg: Any = None, cdp_session: Any = None) -> Any:
    """Helper function to execute script in an isolated world when possible."""
    candidate = getattr(target, "_isolated_world_manager", None)
    if isinstance(candidate, IsolatedWorldManager):
        manager = candidate
    else:
        cdp = cdp_session
        if cdp is None:
            raw_cdp = getattr(target, "_cdp_session", None)
            if raw_cdp is not None:
                cdp = raw_cdp
        if cdp is None and hasattr(target, "page"):
            raw_page_cdp = getattr(target.page, "_cdp_session", None)
            if raw_page_cdp is not None:
                cdp = raw_page_cdp

        manager = IsolatedWorldManager(target, cdp)
        try:
            target._isolated_world_manager = manager
        except Exception:
            pass

    return await manager.evaluate(expression, arg)
