"""Tool event emitter for IPC bridge to NanoCrew.

Emits lifecycle events (created, updated, deleted, tested) as JSON files
to the IPC directory so NanoCrew can pick them up and forward to the
ToolLifecycleManager.
"""

import json
import os
import time
from pathlib import Path
from typing import Optional, Any
from loguru import logger


class ToolEventEmitter:
    """Writes tool lifecycle events to the IPC events directory."""

    def __init__(self, workspace: Path, job_id: Optional[str] = None):
        self._workspace = workspace
        self._job_id = job_id
        group_folder = os.environ.get("GROUP_FOLDER", "main")
        self._events_dir = Path(os.environ.get(
            "IPC_DIR",
            str(workspace.parent / "ipc" / group_folder / "tool_events")
        ))
        self._events_dir.mkdir(parents=True, exist_ok=True)

    def _write_event(self, event: dict[str, Any]) -> None:
        """Write a single event JSON file for IPC pickup."""
        timestamp = int(time.time() * 1000)
        filename = f"tool_event_{timestamp}.json"
        filepath = self._events_dir / filename
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(event, f, indent=2)
            logger.debug(f"Emitted tool event: {event['type']} for '{event['toolName']}'")
        except Exception as e:
            logger.error(f"Failed to emit tool event: {e}")

    def emit_created(self, name: str, version: str, manifest_dict: dict[str, Any]) -> None:
        """Emit a tool_created event."""
        self._write_event({
            "type": "tool_created",
            "jobId": self._job_id,
            "toolName": name,
            "version": version,
            "timestamp": self._now(),
            "manifest": manifest_dict,
        })

    def emit_updated(self, name: str, version: str, manifest_dict: dict[str, Any]) -> None:
        """Emit a tool_updated event."""
        self._write_event({
            "type": "tool_updated",
            "jobId": self._job_id,
            "toolName": name,
            "version": version,
            "timestamp": self._now(),
            "manifest": manifest_dict,
        })

    def emit_deleted(self, name: str) -> None:
        """Emit a tool_deleted event."""
        self._write_event({
            "type": "tool_deleted",
            "jobId": self._job_id,
            "toolName": name,
            "version": "",
            "timestamp": self._now(),
        })

    def emit_tested(self, name: str, version: str, test_result: dict[str, Any]) -> None:
        """Emit a tool_tested event."""
        self._write_event({
            "type": "tool_tested",
            "jobId": self._job_id,
            "toolName": name,
            "version": version,
            "timestamp": self._now(),
            "testResult": test_result,
        })

    @staticmethod
    def _now() -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
