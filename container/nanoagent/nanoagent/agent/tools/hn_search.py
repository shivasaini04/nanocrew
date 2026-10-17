"""HN hiring search tool — finds companies in Hacker News "Who is Hiring?" threads.

DEPRECATED (Phase 7): This bespoke adapter will be retired once an HN MCP
server is available.  Prefer configuring an MCP server in .nanocrew/settings.json
under ``mcp_servers`` — its tools will be registered as ``mcp__hn__*`` and
work identically to this tool without any bespoke adapter code.
"""

import asyncio
import json
import re
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool

ALGOLIA_URL  = "https://hn.algolia.com/api/v1/search"
HN_ITEM_URL  = "https://hacker-news.firebaseio.com/v0/item/{}.json"
HN_POST_URL  = "https://news.ycombinator.com/item?id={}"
MAX_COMMENTS = 150   # limit per request to stay responsive


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    text = re.sub(r"<[^>]+>", " ", text)
    for ent, char in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&#x27;", "'"), ("&quot;", '"')]:
        text = text.replace(ent, char)
    return " ".join(text.split())


class HNSearchTool(Tool):
    """Search Hacker News 'Who is Hiring?' threads for companies matching keywords."""

    name        = "hn_search"
    description = (
        "Search the latest Hacker News 'Who is Hiring?' thread for companies matching keywords. "
        "No API key required. Returns company name, contact info, description, and HN post URL."
    )
    parameters  = {
        "type": "object",
        "properties": {
            "keywords": {
                "type":        "array",
                "items":       {"type": "string"},
                "description": "Keywords to look for in job postings (e.g. ['Python', 'remote', 'Series A'])",
            },
            "max_results": {
                "type":        "integer",
                "description": "Maximum number of matching postings to return",
                "minimum":     1,
                "maximum":     50,
            },
        },
        "required": ["keywords"],
    }

    async def execute(self, keywords: list[str], max_results: int = 20, **kwargs: Any) -> str:
        try:
            # 1. Find the latest "Ask HN: Who is hiring?" thread via Algolia
            async with httpx.AsyncClient() as client:
                algolia_res = await client.get(
                    ALGOLIA_URL,
                    params={
                        "query":                        "Ask HN: Who is hiring?",
                        "restrictSearchableAttributes": "title",
                        "tags":                         "ask_hn",
                        "hitsPerPage":                  1,
                    },
                    timeout=10.0,
                )
            if not algolia_res.is_success:
                return json.dumps({"leads": [], "error": "Could not reach HN Algolia API"})

            hits = algolia_res.json().get("hits") or []
            if not hits:
                return json.dumps({"leads": [], "error": "No 'Who is Hiring?' thread found"})

            thread_id = hits[0].get("objectID")
            if not thread_id:
                return json.dumps({"leads": [], "error": "Thread ID missing from Algolia response"})

            # 2. Fetch the thread to get top-level comment IDs
            async with httpx.AsyncClient() as client:
                thread_res = await client.get(HN_ITEM_URL.format(thread_id), timeout=10.0)
            if not thread_res.is_success:
                return json.dumps({"leads": [], "error": f"Could not fetch HN thread {thread_id}"})

            comment_ids: list[int] = (thread_res.json().get("kids") or [])[:MAX_COMMENTS]

            # 3. Fetch comments in parallel and filter by keywords
            lower_keywords = [kw.lower() for kw in keywords]

            async def fetch_comment(cid: int) -> dict | None:
                try:
                    async with httpx.AsyncClient() as client:
                        r = await client.get(HN_ITEM_URL.format(cid), timeout=8.0)
                    return r.json() if r.is_success else None
                except Exception:
                    return None

            comments = await asyncio.gather(*[fetch_comment(cid) for cid in comment_ids])

            leads = []
            for comment in comments:
                if not comment or not comment.get("text"):
                    continue

                plain = _strip_html(comment["text"])
                if not any(kw in plain.lower() for kw in lower_keywords):
                    continue

                # First line is usually the company name
                first_line = plain.split(".")[0].strip()
                company = first_line if 0 < len(first_line) < 80 else "Unknown"

                email_match = re.search(r"[\w.+\-]+@[\w\-]+\.[a-z]{2,}", plain, re.I)

                leads.append({
                    "company":     company,
                    "contactInfo": email_match.group(0) if email_match else "",
                    "description": plain[:200],
                    "postingText": plain[:500],
                    "url":         HN_POST_URL.format(comment.get("id", "")),
                })

                if len(leads) >= max_results:
                    break

            return json.dumps({"leads": leads, "count": len(leads), "thread_id": thread_id})

        except Exception as e:
            return json.dumps({"leads": [], "error": str(e)})
