"""Telemetry sinks: pluggable destinations for structured agent events."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class TelemetrySink(Protocol):
    """Pluggable destination for structured telemetry events.

    Implement this to ship events to JSONL files, OTel, StatsD, etc.
    """

    def record(self, event: str, payload: dict[str, Any]) -> None:
        """Append one event. Must be thread-safe."""
        ...

    def flush(self) -> None:
        """Flush any buffered writes (no-op for unbuffered sinks)."""
        ...


class NoopSink:
    """Silent sink used as the default when no sink is configured."""

    def record(self, event: str, payload: dict[str, Any]) -> None:
        pass

    def flush(self) -> None:
        pass


class JsonlSink:
    """Appends one JSON line per event to a session-scoped JSONL file.

    File location (in priority order):
      1. ``log_dir`` constructor arg
      2. ``nanocrew_LOG_DIR`` env var
      3. ``<workspace>/.nanocrew/telemetry/``

    Rotation: when the file exceeds ``rotate_bytes`` (default 256 KiB) the
    current file is renamed to ``<name>.1.jsonl`` and a fresh file is opened.
    """

    _ROTATE_BYTES = 256 * 1024  # 256 KiB

    def __init__(
        self,
        session_id: str,
        workspace: Path | None = None,
        log_dir: Path | str | None = None,
        rotate_bytes: int = _ROTATE_BYTES,
    ) -> None:
        self._rotate_bytes = rotate_bytes
        self._lock = threading.Lock()
        self._fh: Any = None  # open file handle

        # Resolve log directory
        if log_dir:
            resolved = Path(log_dir)
        elif env := os.environ.get("nanocrew_LOG_DIR"):
            resolved = Path(env)
        elif workspace:
            resolved = workspace / ".nanocrew" / "telemetry"
        else:
            resolved = Path.cwd() / ".nanocrew" / "telemetry"

        resolved.mkdir(parents=True, exist_ok=True)

        # Sanitise session_id for filesystem use
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in session_id)
        self._path = resolved / f"session-{safe}.jsonl"
        self._open()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _open(self) -> None:
        self._fh = open(self._path, "a", encoding="utf-8", buffering=1)  # line-buffered

    def _rotate(self) -> None:
        self._fh.flush()
        self._fh.close()
        rotated = self._path.with_suffix(".1.jsonl")
        self._path.rename(rotated)
        self._open()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record(self, event: str, payload: dict[str, Any]) -> None:
        line = json.dumps(
            {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **payload},
            ensure_ascii=False,
        )
        with self._lock:
            self._fh.write(line + "\n")
            if self._path.stat().st_size > self._rotate_bytes:
                self._rotate()

    def flush(self) -> None:
        with self._lock:
            if self._fh and not self._fh.closed:
                self._fh.flush()

    def close(self) -> None:
        with self._lock:
            if self._fh and not self._fh.closed:
                self._fh.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


class MemorySink:
    """In-memory sink for tests.

    Usage::

        sink = MemorySink()
        tracer = SessionTracer("s1", sink)
        # ... run agent ...
        assert sink.find("turn_completed") is not None
    """

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: str, payload: dict[str, Any]) -> None:
        self.events.append(
            {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **payload}
        )

    def flush(self) -> None:
        pass

    # ------------------------------------------------------------------
    # Test helpers
    # ------------------------------------------------------------------

    def find(self, event: str) -> dict[str, Any] | None:
        """Return the first recorded event with the given name, or None."""
        return next((e for e in self.events if e["event"] == event), None)

    def find_all(self, event: str) -> list[dict[str, Any]]:
        """Return all recorded events with the given name."""
        return [e for e in self.events if e["event"] == event]

    def clear(self) -> None:
        self.events.clear()
