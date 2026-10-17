"""What an effector run actually had available — resolved at session start.

R3, 2026-08-31. The audit found two headline capabilities that could never activate in
production, both failing silently and correctly: clean try/except, sensible fallback, a
`logger.debug` line nobody reads. That is good engineering in isolation and bad system
behaviour in aggregate — an operator who sets stealth=True and reads "9.8" in a roadmap
believes they have TLS-level fingerprint protection when they have plain Chromium with
userland JS patches, and they make real decisions on that belief.

The rule this module exists to enforce: **an optional engine may degrade, but never
silently.** Degradation reaches the caller in the result payload, not only a log.

One distinction is load-bearing throughout: "off because nobody asked for it" is a
normal configuration and must stay quiet, while "on by config but impossible in this
image" is a degradation and must be loud. Conflating the two either buries the real
warning or trains everyone to ignore a permanent one.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from loguru import logger


@dataclass
class CapabilityManifest:
    """The honest answer to "what was actually switched on for this run"."""

    # Which browser engine ran, and which one was asked for. Our vendored fork lives at
    # agent/effector/engine/ — see stealth/camoufox_driver.engine_status().
    engine: str = "chromium"
    engine_requested: str = "auto"
    engine_reason: str = "not resolved"
    # Which browser family the active fingerprint pool claims ("chromium" | "gecko").
    # The engine only runs when this matches it — see the coherence gate in
    # browser_session. Reported so a run cannot silently wear the wrong disguise.
    profile_family: str = "chromium"

    # Transport. "utls" means the JA3/JA4 virtualizer is genuinely in front of the
    # proxy; "unavailable" means the wire fingerprint is stock Chromium regardless of
    # what the device profile claims. There is no third state that quietly pretends.
    tls_virtualizer: str = "unavailable"

    # True when this run was handed an already-running browser instead of launching one
    # (browser_pool.py). Reported because it is worth several seconds: a timing table
    # that mixes warm and cold runs is not comparing the same thing.
    warm_browser: bool = False

    stealth: bool = False
    network_shield: bool = False
    isolated_worlds: bool = False
    lifecycle_interception: bool = False        # R4
    proxy: bool = False

    # Human-readable reasons a requested capability is not active. Empty on a run that
    # got everything it asked for.
    degradations: list[str] = field(default_factory=list)

    # Trade-offs of the lane that ran, as opposed to things that failed.
    #
    # The native stealth engine is Gecko, and several capabilities here are CDP, which
    # is Chromium-only — so a run on it genuinely does not have isolated-world DOM
    # introspection, lifecycle interception, or a CDP screencast. None of that is a
    # fault: it is what choosing that engine costs, and the engine is the preferred
    # configuration.
    #
    # They are kept apart from `degradations` deliberately, in both directions. Silence
    # was wrong — a run reported `isolated_worlds: false` with nothing saying why or what
    # it cost, and the first live run on the engine a live cycle, 2026-09-03) reported
    # `degradations: []` while two capabilities had quietly gone. But recording them as
    # degradations would be wrong the other way: every native-engine run would read as
    # faulted, which is how a permanent warning trains everyone to ignore warnings — the
    # exact failure this module's own docstring names.
    notes: list[str] = field(default_factory=list)

    def note(self, reason: str) -> None:
        """Record a capability this lane structurally does not have.

        Not a fault, so it does not touch `degradations` or `degraded` — but it reaches
        the caller in the result payload rather than living only in a log line, which is
        the rule this whole module exists to enforce.
        """
        self.notes.append(reason)
        logger.info(f"effector capability: {reason}")

    def degrade(self, reason: str, *, requested: bool) -> None:
        """Record a capability that is not active.

        `requested=False` records the fact without treating it as a fault: a run that
        never asked for the native engine has not been degraded by its absence.
        """
        if not requested:
            logger.info(f"effector capability: {reason}")
            return
        self.degradations.append(reason)
        logger.warning(f"effector capability: {reason}")

    @property
    def degraded(self) -> bool:
        return bool(self.degradations)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def log_summary(self) -> None:
        active = [
            name for name, on in (
                ("stealth", self.stealth),
                ("network_shield", self.network_shield),
                ("isolated_worlds", self.isolated_worlds),
                ("lifecycle_interception", self.lifecycle_interception),
                ("proxy", self.proxy),
            ) if on
        ]
        logger.info(
            f"effector capabilities: engine={self.engine} tls={self.tls_virtualizer} "
            f"active=[{', '.join(active) or 'none'}]"
            + (f" degraded={len(self.degradations)}" if self.degradations else "")
            + (f" notes={len(self.notes)}" if self.notes else "")
        )
