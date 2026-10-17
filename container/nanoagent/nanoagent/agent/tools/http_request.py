"""http_request — generic REST API call tool."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx

from nanoagent.agent.tools.base import Tool


def _validate_url(url: str) -> str | None:
    """Return error string if URL is invalid, else None."""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return f"Only http/https allowed, got '{p.scheme or 'none'}'"
        if not p.netloc:
            return "Missing domain"
        return None
    except Exception as e:
        return str(e)


class HttpRequestTool(Tool):
    """Make an HTTP request to any REST API endpoint."""

    @property
    def required_permission(self) -> "Any":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.ReadOnly

    @property
    def name(self) -> str:
        return "http_request"

    @property
    def description(self) -> str:
        return (
            "Make an HTTP request to any REST API endpoint. Supports GET, POST, PUT, PATCH, DELETE. "
            "Use for calling third-party APIs, webhooks, or any HTTP service that does not have a "
            "dedicated tool. Response is returned as JSON or plain text."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                    "description": "HTTP method.",
                },
                "url": {
                    "type": "string",
                    "description": "Full URL including scheme (https://...).",
                },
                "headers": {
                    "type": "object",
                    "description": "Optional HTTP headers as a key/value object (e.g. Authorization, Content-Type).",
                    "additionalProperties": {"type": "string"},
                },
                "params": {
                    "type": "object",
                    "description": "Optional URL query parameters as a key/value object.",
                    "additionalProperties": {"type": "string"},
                },
                "body": {
                    "type": "object",
                    "description": "Optional JSON body for POST/PUT/PATCH requests.",
                },
                "body_raw": {
                    "type": "string",
                    "description": "Optional raw string body (use instead of 'body' for non-JSON payloads). Sets Content-Type to text/plain unless overridden in headers.",
                },
                "timeout": {
                    "type": "number",
                    "description": "Request timeout in seconds (default 30, max 120).",
                    "default": 30,
                },
                "max_response_chars": {
                    "type": "integer",
                    "description": "Truncate response to this many characters (default 10000).",
                    "default": 10000,
                },
            },
            "required": ["method", "url"],
        }

    async def execute(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
        body_raw: str | None = None,
        timeout: float = 30,
        max_response_chars: int = 10000,
        **kwargs: Any,
    ) -> str:
        method = method.upper()
        if err := _validate_url(url):
            return json.dumps({"error": err})

        timeout = min(float(timeout), 120)
        max_response_chars = min(int(max_response_chars), 50000)

        req_headers: dict[str, str] = headers or {}

        try:
            async with httpx.AsyncClient(follow_redirects=True, max_redirects=5, timeout=timeout) as client:
                if body_raw is not None:
                    if "content-type" not in {k.lower() for k in req_headers}:
                        req_headers["Content-Type"] = "text/plain"
                    resp = await client.request(
                        method, url, headers=req_headers, params=params, content=body_raw.encode()
                    )
                elif body is not None:
                    resp = await client.request(
                        method, url, headers=req_headers, params=params, json=body
                    )
                else:
                    resp = await client.request(
                        method, url, headers=req_headers, params=params
                    )

            content_type = resp.headers.get("content-type", "")
            try:
                if "application/json" in content_type:
                    parsed = resp.json()
                    text = json.dumps(parsed, indent=2, ensure_ascii=False)
                else:
                    text = resp.text
            except Exception:
                text = resp.text

            truncated = len(text) > max_response_chars
            if truncated:
                text = text[:max_response_chars]

            return json.dumps({
                "status": resp.status_code,
                "ok": resp.is_success,
                "content_type": content_type,
                "truncated": truncated,
                "body": text,
            }, ensure_ascii=False)

        except httpx.TimeoutException:
            return json.dumps({"error": f"Request timed out after {timeout}s"})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
