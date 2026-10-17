"""Proactive Event-Driven Background Daemon for Effector.

Enables standing watchdog and automated event dispatching for autonomous tasks
(e.g. webhooks, email arrivals, metric alerts, cron intervals) without waiting for
a human to initiate the prompt.
"""

from __future__ import annotations

import fnmatch
import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger


@dataclass
class EventTrigger:
    trigger_id: str
    name: str
    trigger_type: str  # "webhook" | "email" | "cron" | "metric_threshold"
    topic_pattern: str  # wildcard pattern e.g. "inbox.invoices.*", "webhook.stripe.*"
    goal_template: str  # template string e.g. "Review and approve invoice {invoice_id} from {vendor}"
    parameters: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EventTrigger":
        return cls(**data)


@dataclass
class EventMessage:
    event_id: str
    source: str
    topic: str
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class EventDaemon:
    """Watchdog event dispatcher for background Effector task execution."""

    def __init__(self):
        self._triggers: dict[str, EventTrigger] = {}

    def register_trigger(self, trigger: EventTrigger) -> EventTrigger:
        """Register a new proactive event trigger."""
        self._triggers[trigger.trigger_id] = trigger
        logger.info(f"effector-daemon: registered trigger {trigger.name} ({trigger.trigger_id}) on pattern {trigger.topic_pattern!r}")
        return trigger

    def unregister_trigger(self, trigger_id: str) -> bool:
        """Remove a trigger."""
        if trigger_id in self._triggers:
            del self._triggers[trigger_id]
            return True
        return False

    def list_triggers(self, enabled_only: bool = True) -> list[EventTrigger]:
        """List registered triggers."""
        if enabled_only:
            return [t for t in self._triggers.values() if t.enabled]
        return list(self._triggers.values())

    def evaluate_event(self, event: EventMessage) -> list[tuple[EventTrigger, str]]:
        """Evaluate an incoming event against registered triggers and render matched goals."""
        matches: list[tuple[EventTrigger, str]] = []

        for trigger in self._triggers.values():
            if not trigger.enabled:
                continue

            if fnmatch.fnmatch(event.topic.lower(), trigger.topic_pattern.lower()):
                try:
                    # Safe template format with payload keys
                    formatted_goal = trigger.goal_template.format(**event.payload)
                except KeyError:
                    # Fallback to simple replace for missing keys
                    formatted_goal = trigger.goal_template
                    for k, v in event.payload.items():
                        formatted_goal = formatted_goal.replace(f"{{{k}}}", str(v))

                logger.info(f"effector-daemon: trigger {trigger.trigger_id} matched event {event.event_id} on topic {event.topic}")
                matches.append((trigger, formatted_goal))

        return matches

    def save(self, workspace: Path) -> Path:
        """Persist triggers to disk."""
        d = Path(workspace) / ".effector" / "daemon"
        d.mkdir(parents=True, exist_ok=True)
        out_path = d / "triggers.json"
        data = [t.to_dict() for t in self._triggers.values()]
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return out_path

    @classmethod
    def load(cls, workspace: Path) -> "EventDaemon":
        """Load triggers from disk."""
        daemon = cls()
        in_path = Path(workspace) / ".effector" / "daemon" / "triggers.json"
        if not in_path.exists():
            return daemon

        try:
            data = json.loads(in_path.read_text(encoding="utf-8"))
            for t_data in data:
                daemon.register_trigger(EventTrigger.from_dict(t_data))
        except Exception:
            pass

        return daemon
