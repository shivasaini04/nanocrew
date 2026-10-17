"""Phase 4 of the Effector port — synthesis: self-synthesizing metaprogramming and
fast-path Neural Macro Distillation.
"""

from nanoagent.agent.effector.synthesis.jit_metaprogrammer import (
    looks_like_unsupported_interface,
    synthesize_driver,
)
from nanoagent.agent.effector.synthesis.macro_distiller import (
    MacroAction,
    MacroAssertion,
    MacroWorkflow,
    distill_macro_from_action_log,
    find_matching_macro,
    load_macro,
    save_macro,
)
from nanoagent.agent.effector.synthesis.macro_runner import (  # noqa: F401
    MacroExecutionResult,
    execute_macro,
)

__all__ = [
    "looks_like_unsupported_interface",
    "synthesize_driver",
    "MacroAction",
    "MacroAssertion",
    "MacroWorkflow",
    "distill_macro_from_action_log",
    "find_matching_macro",
    "load_macro",
    "save_macro",
    "MacroExecutionResult",
    "execute_macro",
]
