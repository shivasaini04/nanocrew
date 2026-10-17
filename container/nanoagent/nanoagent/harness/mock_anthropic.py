"""Mock Anthropic API server for deterministic turn-loop testing.

Implements just enough of the Anthropic Messages API to drive the NanoAgent
AgentLoop without spending tokens or requiring credentials.

Protocol:
    POST /v1/messages            — serve next fixture turn as SSE stream
    POST /__mock__/load          — load a fixture: {"fixture": "scenario_name"}
    POST /__mock__/reset         — reset call counter (keep fixture)
    GET  /__mock__/status        — returns {"fixture", "call_count", "turns_available"}

Fixture format (nanoagent/harness/fixtures/{scenario}/events.json):
    {
      "description": "...",
      "turns": [
        [                                          // turn 0 events
          {"event": "message_start", "data": {...}},
          {"event": "content_block_start", "data": {...}},
          ...
          {"event": "message_stop", "data": {}}
        ],
        [...]                                      // turn 1 events (after tool result)
      ]
    }
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import threading
from pathlib import Path
from typing import Any

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class _MockHandler(http.server.BaseHTTPRequestHandler):
    """Handles POST /v1/messages and /__mock__/* control endpoints."""

    # Shared state — set by MockAnthropicServer before any request
    server: "MockAnthropicServer"

    def log_message(self, fmt: str, *args: Any) -> None:  # type: ignore[override]
        pass  # silence per-request log noise in test output

    def do_GET(self) -> None:
        if self.path == "/__mock__/status":
            self._json_response({
                "fixture": self.server.fixture_name,
                "call_count": self.server.call_count,
                "turns_available": len(self.server.turns),
            })
        else:
            self._not_found()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if self.path == "/__mock__/load":
            data = json.loads(body) if body else {}
            fixture = data.get("fixture", "")
            self.server.load_fixture(fixture)
            self._json_response({"ok": True, "fixture": fixture})

        elif self.path == "/__mock__/reset":
            self.server.call_count = 0
            self._json_response({"ok": True})

        elif self.path == "/v1/messages":
            req = json.loads(body) if body else {}
            if req.get("stream", False):
                self._serve_messages_streaming()
            else:
                self._serve_messages_json()

        else:
            self._not_found()

    def _get_turn_events(self) -> list[dict] | None:
        turns = self.server.turns
        if not turns:
            self.send_error(500, "No fixture loaded")
            return None
        idx = self.server.call_count
        events = turns[idx % len(turns)]
        self.server.call_count += 1
        return events

    def _serve_messages_streaming(self) -> None:
        """Serve the fixture turn as a raw SSE stream (for stream=true requests)."""
        events = self._get_turn_events()
        if events is None:
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        for ev in events:
            event_type: str = ev.get("event", "")
            data_obj = ev.get("data", {})
            chunk = f"event: {event_type}\ndata: {json.dumps(data_obj)}\n\n"
            try:
                self.wfile.write(chunk.encode())
                self.wfile.flush()
            except BrokenPipeError:
                break

    def _serve_messages_json(self) -> None:
        """Synthesize a non-streaming Anthropic JSON response from fixture events."""
        events = self._get_turn_events()
        if events is None:
            return

        # Extract fields from the SSE event list
        msg_id = "msg_mock00"
        model = "claude-haiku-4-5-20251001"
        input_tokens = 25
        output_tokens = 8
        stop_reason = "end_turn"
        content_blocks: list[dict] = []

        current_block: dict | None = None
        partial_json = ""

        for ev in events:
            data = ev.get("data", {})
            etype = ev.get("event", "")

            if etype == "message_start":
                msg = data.get("message", {})
                msg_id = msg.get("id", msg_id)
                model = msg.get("model", model)
                usage = msg.get("usage", {})
                input_tokens = usage.get("input_tokens", input_tokens)

            elif etype == "content_block_start":
                block = data.get("content_block", {})
                current_block = dict(block)
                partial_json = ""

            elif etype == "content_block_delta" and current_block is not None:
                delta = data.get("delta", {})
                if delta.get("type") == "text_delta":
                    current_block["text"] = current_block.get("text", "") + delta.get("text", "")
                elif delta.get("type") == "input_json_delta":
                    partial_json += delta.get("partial_json", "")

            elif etype == "content_block_stop" and current_block is not None:
                if current_block.get("type") == "tool_use":
                    try:
                        current_block["input"] = json.loads(partial_json) if partial_json else {}
                    except json.JSONDecodeError:
                        current_block["input"] = {}
                content_blocks.append(current_block)
                current_block = None
                partial_json = ""

            elif etype == "message_delta":
                delta = data.get("delta", {})
                stop_reason = delta.get("stop_reason", stop_reason)
                usage = data.get("usage", {})
                output_tokens = usage.get("output_tokens", output_tokens)

        response = {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": content_blocks,
            "model": model,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
        }
        self._json_response(response)

    def _json_response(self, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self) -> None:
        self.send_error(404, "Not found")


# ---------------------------------------------------------------------------
# Server class
# ---------------------------------------------------------------------------

class _ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class MockAnthropicServer:
    """
    In-process mock Anthropic API server for pytest fixtures.

    Usage:
        server = MockAnthropicServer()
        server.start()
        # Point LiteLLM / Anthropic SDK at it:
        os.environ["ANTHROPIC_BASE_URL"] = server.base_url
        os.environ["ANTHROPIC_API_KEY"]  = "mock-key"
        ...
        server.stop()

    Or use as a context manager:
        with MockAnthropicServer() as server:
            server.load_fixture("streaming_text")
            ...
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._port = port
        self._server: _ThreadedTCPServer | None = None
        self._thread: threading.Thread | None = None

        # Shared state accessed by the handler
        self.turns: list[list[dict]] = []
        self.fixture_name: str = ""
        self.call_count: int = 0

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> "MockAnthropicServer":
        self._server = _ThreadedTCPServer((self._host, self._port), _MockHandler)
        # Inject self as the server so handler can access shared state
        self._server.fixture_name = self.fixture_name  # type: ignore[attr-defined]
        self._server.turns       = self.turns           # type: ignore[attr-defined]
        self._server.call_count  = self.call_count      # type: ignore[attr-defined]
        # Sync attributes back: handler reads from self._server, not self
        self._server_ref = self._server

        # Bind the mutable lists/ints so handler mutations propagate to us
        self._server.turns       = self.turns           # same list object  # type: ignore[attr-defined]

        # Give the handler a back-reference to this MockAnthropicServer
        self._server.__class__ = type(
            "_BoundServer",
            (self._server.__class__,),
            {
                "fixture_name": property(lambda s: self.fixture_name, lambda s, v: setattr(self, "fixture_name", v)),  # type: ignore
                "turns":       property(lambda s: self.turns),  # type: ignore
                "call_count":  property(lambda s: self.call_count, lambda s, v: setattr(self, "call_count", v)),  # type: ignore
                "load_fixture": lambda s, name: self.load_fixture(name),  # type: ignore
            },
        )

        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def __enter__(self) -> "MockAnthropicServer":
        return self.start()

    def __exit__(self, *_: Any) -> None:
        self.stop()

    # ── Control ───────────────────────────────────────────────────────────────

    @property
    def port(self) -> int:
        if not self._server:
            raise RuntimeError("Server not started")
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://{self._host}:{self.port}"

    def load_fixture(self, name: str) -> None:
        """Load a fixture by scenario name from the fixtures directory."""
        fixture_path = FIXTURES_DIR / name / "events.json"
        if not fixture_path.exists():
            raise FileNotFoundError(
                f"Fixture '{name}' not found at {fixture_path}. "
                f"Available: {[d.name for d in FIXTURES_DIR.iterdir() if d.is_dir()]}"
            )
        data = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.turns = data["turns"]
        self.fixture_name = name
        self.call_count = 0

    def reset(self) -> None:
        """Reset the call counter (keep the loaded fixture)."""
        self.call_count = 0

    def set_env(self) -> None:
        """Set ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY to point at this server."""
        os.environ["ANTHROPIC_BASE_URL"] = self.base_url
        os.environ["ANTHROPIC_API_KEY"]  = "mock-test-key"

    @property
    def calls_made(self) -> int:
        return self.call_count
