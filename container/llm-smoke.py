"""Make one real litellm call inside the agent image, with no API key.

A local stand-in answers like an OpenAI-compatible API, so this exercises litellm's real
provider code paths (where dependency clashes surface) without spending anything.
Run (as root, like the orchestrator starts agents):
  docker run --rm --user 0:0 -v "$PWD/container/llm-smoke.py:/smoke.py:ro" --entrypoint python nanocrew-agent:latest /smoke.py
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import litellm

litellm.suppress_debug_info = True

REPLY = {
    "id": "smoke",
    "object": "chat.completion",
    "created": 0,
    "model": "smoke",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "ok"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        body = json.dumps(REPLY).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}/v1"

EXEC_TOOL = {
    "type": "function",
    "function": {
        "name": "exec",
        "description": "Run a shell command",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
}

failed = False
# The providers agents use by default; each goes through its own litellm handler.
# Pass a tool like every agent turn does: litellm takes a different path when tools are
# present (litellm 1.106 + mcp 1.x only broke there; a plain call still worked).
for model in ("openrouter/smoke/model", "deepseek/deepseek-chat", "openai/smoke"):
    try:
        resp = litellm.completion(
            model=model,
            api_base=base,
            api_key="smoke",
            messages=[{"role": "user", "content": "say ok"}],
            tools=[EXEC_TOOL],
            tool_choice="auto",
            num_retries=0,
        )
        text = resp.choices[0].message.content
        print(f"{model}: {text!r}")
        failed |= text != "ok"
    except Exception as exc:
        print(f"{model}: FAILED {type(exc).__name__}: {str(exc)[:300]}")
        failed = True

sys.exit(1 if failed else 0)
