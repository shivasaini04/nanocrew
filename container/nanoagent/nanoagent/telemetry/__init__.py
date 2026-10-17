"""Telemetry package for nanocrew agent observability.

Quick-start::

    from nanoagent.telemetry import SessionTracer, JsonlSink, MemorySink

    # Production: write JSONL to <workspace>/.nanocrew/telemetry/
    sink = JsonlSink(session_id="cli_direct", workspace=workspace)

    # Tests: capture events in memory
    sink = MemorySink()

    tracer = SessionTracer(session_id="cli_direct", sink=sink)
"""

from nanoagent.telemetry.sink import JsonlSink, MemorySink, NoopSink, TelemetrySink
from nanoagent.telemetry.tracer import SessionTracer

__all__ = [
    "TelemetrySink",
    "JsonlSink",
    "MemorySink",
    "NoopSink",
    "SessionTracer",
]
