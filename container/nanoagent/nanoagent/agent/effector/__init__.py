"""Effector — the digital-employee engine, native to nanoagent.

Autonomous browser & desktop effector engine. Reachable from a real run (react_loop or
the `effector` tool drives each of these — grep for the call site before trusting the
list, which is how the discrepancy below was found in the first place):

- React Loop with self-healing perception & action
- God-Level Stealth & Anti-Detection (prototype cloaking, WebGL/OS coherence, WebRTC lockdown)
- Autonomous Zero-Touch TOTP & 2FA Resolution        (credential_inject.py)
- Neural Macro Distillation, zero-token fast path    (react_loop._try_macro_fast_path)
- Speculative State Rollback                         (guards the macro fast path)
- Multimodal Canvas & Spatial VLA Grounding          (resolver.py layer 1.5)
- Cross-Application Epistemic Knowledge Graph        (react_loop, recall + record)

NOT reachable, and listed separately rather than quietly among the rest:

- Proactive Event-Driven Background Watchdog (proactive/event_daemon.py) — real,
  unit-tested storage and matching logic with no event ingress anywhere in the agent
  runtime to feed it, and nothing that dispatches a matched trigger into a run.
  Scheduling and triggers are orchestrator-side concerns in this system, so making
  this live is a deliberate piece of work, not a wiring oversight. Until then it
  does nothing at runtime.

The four middle entries above were, as of 2026-08-24, in that same unreachable state:
exported, unit-tested, and called by nothing. Passing tests over a module the loop
never invokes prove the module works, not that the product does.
"""

from nanoagent.agent.effector.browser_session import EffectorSession
from nanoagent.agent.effector.credentials import (
    detect_totp_input_field,
    generate_totp_code,
    is_totp_prompt,
)
from nanoagent.agent.effector.dom_settler import wait_for_dom_settled
from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
from nanoagent.agent.effector.browser_exec import (
    BrowserExecError,
    is_dangerous_script,
    run_script,
)
from nanoagent.agent.effector.downloads import DownloadManager, DownloadRecord
from nanoagent.agent.effector.watchdogs import (
    CrashWatchdog,
    DialogWatchdog,
    looks_like_a_dead_browser,
)
from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.memory import (
    BusinessEntity,
    EntityRelationship,
    EpistemicKnowledgeGraph,
    find_identifiers,
    recall_for_goal,
    record_extraction,
)
from nanoagent.agent.effector.perception import (
    SpatialVisualMarker,
    generate_set_of_marks_overlay,
    ground_canvas_coordinates,
    parse_grid_cell_coordinate,
)
from nanoagent.agent.effector.proactive import (
    EventDaemon,
    EventMessage,
    EventTrigger,
)
from nanoagent.agent.effector.react_loop import run_react_loop
from nanoagent.agent.effector.resilience import (
    DomainRateLimiter,
    EphemeralTabCheckpoint,
    RunCheckpoint,
    SpeculativeScope,
    capture_tab_checkpoint,
    restore_tab_checkpoint,
)
from nanoagent.agent.effector.security import (
    CanaryGuard,
    DlpScanner,
    L7NetworkPolicy,
    MerkleActionLedger,
    MerkleBlock,
    SessionVault,
    sanitize_dom_text,
    wrap_untrusted_perception,
)
from nanoagent.agent.effector.stealth import (
    build_stealth_init_script,
    generate_bezier_trajectory,
    human_mouse_move,
    human_scroll,
    human_type,
    is_challenge_page,
)
from nanoagent.agent.effector.synthesis import (
    MacroAction,
    MacroAssertion,
    MacroExecutionResult,
    MacroWorkflow,
    distill_macro_from_action_log,
    execute_macro,
    find_matching_macro,
    load_macro,
    save_macro,
)

__all__ = [
    "run_react_loop",
    "execute_step",
    "ExecutorOptions",
    "EffectorSession",
    "capture_dom_snapshot",
    "BrowserExecError",
    "is_dangerous_script",
    "run_script",
    "CrashWatchdog",
    "DialogWatchdog",
    "looks_like_a_dead_browser",
    "DownloadManager",
    "DownloadRecord",
    "wait_for_dom_settled",
    "generate_totp_code",
    "is_totp_prompt",
    "detect_totp_input_field",
    "distill_macro_from_action_log",
    "execute_macro",
    "find_matching_macro",
    "save_macro",
    "load_macro",
    "MacroWorkflow",
    "MacroAction",
    "MacroAssertion",
    "MacroExecutionResult",
    "capture_tab_checkpoint",
    "restore_tab_checkpoint",
    "SpeculativeScope",
    "EphemeralTabCheckpoint",
    "RunCheckpoint",
    "DomainRateLimiter",
    "SpatialVisualMarker",
    "ground_canvas_coordinates",
    "parse_grid_cell_coordinate",
    "generate_set_of_marks_overlay",
    "BusinessEntity",
    "EntityRelationship",
    "EpistemicKnowledgeGraph",
    "record_extraction",
    "recall_for_goal",
    "find_identifiers",
    "EventDaemon",
    "EventMessage",
    "EventTrigger",
    "build_stealth_init_script",
    "generate_bezier_trajectory",
    "human_mouse_move",
    "human_scroll",
    "human_type",
    "is_challenge_page",
    "SessionVault",
    "L7NetworkPolicy",
    "DlpScanner",
    "CanaryGuard",
    "MerkleActionLedger",
    "MerkleBlock",
    "wrap_untrusted_perception",
    "sanitize_dom_text",
]
