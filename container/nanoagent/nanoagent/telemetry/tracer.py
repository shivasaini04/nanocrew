"""SessionTracer: per-session wrapper that tags every event with context."""

from __future__ import annotations

from typing import Any

from nanoagent.telemetry.sink import NoopSink, TelemetrySink


class SessionTracer:
    """Tags every telemetry event with session_id and current turn number.

    Injected into AgentLoop and incremented on each call to ``start_turn()``.

    Usage::

        from nanoagent.telemetry.sink import JsonlSink
        sink = JsonlSink(session_id="cli_direct", workspace=workspace)
        tracer = SessionTracer("cli_direct", sink)

        tracer.start_turn()
        tracer.record("turn_started", {"user_input": "hello"})
        tracer.record("tool_execution_started", {"tool": "web_search"})
        tracer.end_turn({"tools_used": ["web_search"], "total_tokens": 1200})
    """

    def __init__(self, session_id: str, sink: TelemetrySink | None = None) -> None:
        self._session_id = session_id
        self._sink: TelemetrySink = sink if sink is not None else NoopSink()
        self._turn: int = 0

    # ------------------------------------------------------------------
    # Turn lifecycle
    # ------------------------------------------------------------------

    def start_turn(self) -> None:
        """Increment the turn counter. Call once at the top of each agent turn."""
        self._turn += 1

    def end_turn(self, payload: dict[str, Any] | None = None) -> None:
        """Convenience wrapper that emits ``turn_completed``."""
        self.record("turn_completed", payload or {})

    # ------------------------------------------------------------------
    # Core record
    # ------------------------------------------------------------------

    def record(self, event: str, payload: dict[str, Any] | None = None) -> None:
        """Emit one event, always tagged with session + turn context."""
        tagged = {
            "session_id": self._session_id,
            "turn": self._turn,
            **(payload or {}),
        }
        self._sink.record(event, tagged)

    def flush(self) -> None:
        """Flush the underlying sink."""
        self._sink.flush()

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def turn(self) -> int:
        return self._turn

    @property
    def sink(self) -> TelemetrySink:
        return self._sink
