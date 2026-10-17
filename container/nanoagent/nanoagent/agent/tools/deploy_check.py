"""deploy_check — confirm a push actually reached the live site.

Devin mode, piece 4 of 4 (spec item F). It closes the loop: the agent edits, the commit gate
proves it builds, the push lands, and this proves the change is *serving*.

**The trap this tool exists to avoid: HTTP 200 proves nothing.** The site that was already
live returns 200 as well. An agent that pushes, polls for 200, sees 200 and reports "deployed"
is reporting the OLD page — and it will do that confidently, every time, whether the deploy
succeeded, is still building, or failed outright. So `expect` is required: a string that
exists only in the new version. Absent that, this tool refuses rather than guessing.

The spec suggests polling the Vercel API. That needs a project token per client and ties the
tool to one host; fetching the page works for Vercel, Netlify, Cloudflare, a VPS, anything.
The API version is a refinement, not the first cut.

The three outcomes are deliberately distinct, because they need different actions:
  * `live`        — the marker is serving. Done.
  * `stale`       — reachable, but the marker never appeared before the timeout. The old
                    version is still up: the deploy is building, queued, or failed. This is
                    NOT success, and is the case a naive 200-check silently mislabels.
  * `unreachable` — the host did not answer. An infrastructure problem, not a deploy one.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from nanoagent.agent.tools.base import Tool

_DEFAULT_TIMEOUT_S = int(os.environ.get("DEPLOY_CHECK_TIMEOUT", "300"))
_MAX_TIMEOUT_S = 900
_INTERVAL_S = 10
_FETCH_TIMEOUT_S = 20


class DeployCheckTool(Tool):
    """Poll a deployed URL until it serves the new build."""

    @property
    def name(self) -> str:
        return "deploy_check"

    @property
    def description(self) -> str:
        return (
            "Confirm a deploy is live by polling a URL until the page contains a marker "
            "string unique to your change. Use it after pushing, before reporting a change "
            "as done. Requires `expect` — a snippet of the NEW content — because HTTP 200 "
            "alone is returned by the old version too and proves nothing. Returns one of: "
            "live (marker serving), stale (reachable but still the old version), or "
            "unreachable. Polls for up to a few minutes; that is expected, not a hang."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": (
                        "The page to check. Defaults to PROJECT_DEPLOY_URL, set when the "
                        "repo was attached."
                    ),
                },
                "expect": {
                    "type": "string",
                    "description": (
                        "A string that appears in the NEW version and not the old — the "
                        "headline you changed, the new copy, a value you added. This is what "
                        "distinguishes a real deploy from the old page still being served."
                    ),
                },
                "absent": {
                    "type": "string",
                    "description": (
                        "Optional: a string from the OLD version that must be GONE. Useful "
                        "when you replaced text rather than adding it."
                    ),
                },
                "timeout_s": {
                    "type": "integer",
                    "description": f"How long to keep polling (default {_DEFAULT_TIMEOUT_S}, max {_MAX_TIMEOUT_S}).",
                },
            },
            "required": ["expect"],
        }

    async def execute(self, expect: str = "", url: str = "", absent: str = "", timeout_s: int = 0, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return "httpx is not installed in this image — deploy_check cannot run."

        target = (url or os.environ.get("PROJECT_DEPLOY_URL") or "").strip()
        if not target:
            return (
                "No URL to check. Pass `url`, or set PROJECT_DEPLOY_URL when attaching the "
                "repo. Without a deployed URL a deploy cannot be verified at all — say so in "
                "your report rather than assuming it worked."
            )
        if not target.startswith(("http://", "https://")):
            target = "https://" + target

        expect = str(expect or "").strip()
        if not expect:
            return (
                "deploy_check needs `expect`: a string that appears in the NEW version of the "
                "page.\n\nA 200 response is not evidence of anything — the version that was "
                "already live returns 200 too, so polling for status alone would report "
                "success while the old page is still being served. Pass a snippet of what you "
                "actually changed."
            )

        budget = min(int(timeout_s or _DEFAULT_TIMEOUT_S), _MAX_TIMEOUT_S)
        started = time.time()
        attempts = 0
        last_status: int | None = None
        last_error: str | None = None
        saw_absent = False

        async with httpx.AsyncClient(follow_redirects=True) as client:
            while time.time() - started < budget:
                attempts += 1
                try:
                    r = await client.get(
                        target,
                        timeout=_FETCH_TIMEOUT_S,
                        headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
                    )
                    last_status = r.status_code
                    last_error = None
                    body = r.text
                    if r.status_code == 200:
                        has_expect = expect in body
                        saw_absent = bool(absent) and absent in body
                        if has_expect and not saw_absent:
                            return json.dumps({
                                "result": "live",
                                "url": target,
                                "status": r.status_code,
                                "elapsed_s": round(time.time() - started, 1),
                                "attempts": attempts,
                                "note": (
                                    f"The deploy is live: {expect!r} is being served"
                                    + (f" and {absent!r} is gone" if absent else "")
                                    + "."
                                ),
                            }, indent=2)
                except Exception as exc:
                    last_error = f"{type(exc).__name__}: {exc}"

                remaining = budget - (time.time() - started)
                if remaining <= 0:
                    break
                await _sleep(min(_INTERVAL_S, remaining))

        elapsed = round(time.time() - started, 1)
        if last_status is None:
            return json.dumps({
                "result": "unreachable",
                "url": target, "elapsed_s": elapsed, "attempts": attempts,
                "last_error": last_error,
                "note": (
                    "The host never answered, so nothing can be said about the deploy. This is "
                    "an infrastructure problem rather than a problem with your change — report "
                    "it as that, and do not describe the change as deployed."
                ),
            }, indent=2)

        return json.dumps({
            "result": "stale",
            "url": target, "status": last_status, "elapsed_s": elapsed, "attempts": attempts,
            "expected_found": False,
            "old_content_still_present": saw_absent,
            "note": (
                f"The page responded ({last_status}) but {expect!r} never appeared within "
                f"{budget}s. **This is not a successful deploy** — it means the version that "
                "was already live is still being served, so the build is queued, still "
                "running, or failed. Report it as not-yet-deployed and say how long you "
                "waited. Do not report the change as done because the page returned 200; the "
                "old page returns 200 too."
            ),
        }, indent=2)


async def _sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)
