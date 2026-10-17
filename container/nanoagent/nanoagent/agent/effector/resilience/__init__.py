"""Phase 1 of the Effector port — resilience: self-healing selectors, adaptive
per-domain throttling, checkpoint/resume, and speculative state rollback.
"""

from nanoagent.agent.effector.resilience.adaptive_throttle import DomainRateLimiter
from nanoagent.agent.effector.resilience.checkpoint import RunCheckpoint
from nanoagent.agent.effector.resilience.self_healing_selectors import (
    AnchorDescriptor,
    calculate_anchor_similarity,
    create_anchor_descriptor,
    resolve_self_healing_selector,
)
from nanoagent.agent.effector.resilience.speculative_rollback import (
    EphemeralTabCheckpoint,
    SpeculativeScope,
    capture_tab_checkpoint,
    restore_tab_checkpoint,
)

__all__ = [
    "DomainRateLimiter",
    "RunCheckpoint",
    "AnchorDescriptor",
    "create_anchor_descriptor",
    "calculate_anchor_similarity",
    "resolve_self_healing_selector",
    "EphemeralTabCheckpoint",
    "SpeculativeScope",
    "capture_tab_checkpoint",
    "restore_tab_checkpoint",
]
