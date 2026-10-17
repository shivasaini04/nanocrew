"""
A local page whose in-frame content is random, for testing frame traversal.

Why this exists: tier tests 3.3 and 3.4 used demoqa.com, whose frame text ("This is a
sample page", "Parent frame", "Child Iframe") is among the most memorised text on the
internet. Both tests returned correct answers with the mechanism bypassed — the model wrote
the answer from recall, not from perception. See
`docs/research/digital-employee-engine/test/03-hard.md`, section "Correction".

A frame test is only valid when the in-frame content is (a) interactive, so perception has
to reach it, and (b) unguessable, so recall cannot. This fixture is both: every run mints
fresh tokens, and the control carrying one is a button whose click writes observable state
back into the frame.

The frame boundaries are real origin boundaries: the parent is served on `localhost` and
the child on `127.0.0.1` (and the grandchild back on `localhost`), so nothing here passes
by same-origin accident.

Run it directly to serve until interrupted:

    python serve.py --port 8917

It prints one JSON line describing the run — url, tokens, port — and then serves.
"""

from __future__ import annotations

import argparse
import json
import secrets
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent

PARENT_HOST = "localhost"
CHILD_HOST = "127.0.0.1"


def mint_tokens() -> dict:
    """Fresh per run. Short enough to read off a screenshot, long enough not to collide."""
    return {
        "parent": f"PT-{secrets.token_hex(4).upper()}",
        "child": f"CT-{secrets.token_hex(4).upper()}",
        "deep": f"DT-{secrets.token_hex(4).upper()}",
    }


class FixtureHandler(BaseHTTPRequestHandler):
    """Serves the three pages with this run's tokens substituted in."""

    def __init__(self, *args, tokens: dict, port: int, **kwargs):
        self.tokens = tokens
        self.port = port
        super().__init__(*args, **kwargs)

    def log_message(self, *_args):  # quiet — the harness owns stdout
        pass

    def _render(self, name: str) -> bytes:
        html = (HERE / name).read_text(encoding="utf-8")
        return (
            html.replace("__PARENT_TOKEN__", self.tokens["parent"])
            .replace("__CHILD_TOKEN__", self.tokens["child"])
            .replace("__DEEP_TOKEN__", self.tokens["deep"])
            .replace("__CHILD_URL__", f"http://{CHILD_HOST}:{self.port}/child.html")
            .replace("__GRANDCHILD_URL__", f"http://{PARENT_HOST}:{self.port}/grandchild.html")
        ).encode("utf-8")

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's name
        path = self.path.split("?")[0]
        name = {
            "/": "parent.html",
            "/parent.html": "parent.html",
            "/child.html": "child.html",
            "/grandchild.html": "grandchild.html",
        }.get(path)
        if name is None:
            self.send_error(404)
            return
        body = self._render(name)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # No caching: a second run must never see the first run's tokens.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def serve(port: int = 8917, tokens: dict | None = None):
    """Start the fixture on a background thread. Returns (server, description)."""
    tokens = tokens or mint_tokens()
    handler = partial(FixtureHandler, tokens=tokens, port=port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, {
        "url": f"http://{PARENT_HOST}:{port}/",
        "childUrl": f"http://{CHILD_HOST}:{port}/child.html",
        "grandchildUrl": f"http://{PARENT_HOST}:{port}/grandchild.html",
        "tokens": tokens,
        "port": port,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Serve the random-token frame fixture.")
    ap.add_argument("--port", type=int, default=8917)
    args = ap.parse_args()
    _httpd, described = serve(args.port)
    print(json.dumps(described), flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
