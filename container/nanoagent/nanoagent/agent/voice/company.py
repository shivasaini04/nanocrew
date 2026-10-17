"""
Learn what a company does from its website, so the agent stops guessing.

Before this, every agent introduced itself as "Aarav from NanoCrew" regardless of
who had signed up. On a real call to a buildquick.tech lead the prospect replied
"मैंने बिल्ड की कंपनी को कॉन्टैक्ट किया था… आप Lenovo टीम से बोल रहे हो?" — they had
contacted BuildQuick, were greeted by a different company, and started guessing.
A sales call that opens with the wrong company name is over before it starts.

The flow: fetch a handful of pages, strip them to text, and have a model write a
short structured profile. No scraping service — plain HTTP and the same
HTML-to-text approach nanocrew's own web tool uses.
"""
import re
import json
import asyncio
import logging
from html import unescape
from typing import Dict, Any, List
from urllib.parse import urljoin, urlparse

import aiohttp
from dotenv import load_dotenv
from nanoagent.providers.relay_url import provider_url

load_dotenv()
logger = logging.getLogger("company")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

# Pages that actually say what a company sells. Ordered by how often they carry
# the offer rather than the story.
CANDIDATE_PATHS = ["", "/about", "/about-us", "/services", "/products",
                   "/pricing", "/solutions", "/what-we-do"]
MAX_PAGES = 5
PER_PAGE_CHARS = 6000

_STRIP = re.compile(
    r"<(script|style|noscript|svg|head|nav|footer|form)[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"[ \t\r\f\v]+")
_BLANK = re.compile(r"\n\s*\n+")


def normalise_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    parsed = urlparse(raw)
    if not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def html_to_text(markup: str) -> str:
    """Good enough to feed a model: drop chrome, keep the words."""
    text = _STRIP.sub(" ", markup)
    text = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text,
                  flags=re.IGNORECASE)
    text = _TAGS.sub(" ", text)
    text = unescape(text)
    text = _SPACE.sub(" ", text)
    return _BLANK.sub("\n\n", text).strip()


async def _fetch(session: aiohttp.ClientSession, url: str) -> str:
    try:
        async with session.get(url, allow_redirects=True) as resp:
            if resp.status != 200:
                return ""
            ctype = resp.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return await resp.text(errors="ignore")
    except Exception as exc:
        logger.info("fetch %s failed: %s", url, exc)
        return ""


async def scrape_site(url: str) -> Dict[str, Any]:
    """Homepage plus a few likely pages, as plain text."""
    base = normalise_url(url)
    if not base:
        return {"ok": False, "error": "That does not look like a website address."}

    pages: List[Dict[str, str]] = []
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout,
                                     headers={"User-Agent": UA}) as session:
        home = await _fetch(session, base)
        if not home:
            return {"ok": False,
                    "error": f"Could not reach {base}. Check the address is right "
                             f"and the site is public."}
        pages.append({"url": base, "text": html_to_text(home)[:PER_PAGE_CHARS]})

        # Follow only same-host links that look like the pages above; a full
        # crawl would be slow and mostly blog posts.
        hrefs = set(re.findall(r'href=["\']([^"\']+)["\']', home, re.IGNORECASE))
        wanted = []
        for path in CANDIDATE_PATHS[1:]:
            for href in hrefs:
                target = urljoin(base + "/", href)
                if urlparse(target).netloc != urlparse(base).netloc:
                    continue
                if urlparse(target).path.rstrip("/").lower().endswith(path):
                    wanted.append(target)
                    break
        seen = {base}
        for target in wanted:
            if len(pages) >= MAX_PAGES:
                break
            target = target.split("#")[0].rstrip("/")
            if target in seen:
                continue
            seen.add(target)
            markup = await _fetch(session, target)
            if markup:
                pages.append({"url": target,
                              "text": html_to_text(markup)[:PER_PAGE_CHARS]})

    total = sum(len(p["text"]) for p in pages)
    if total < 200:
        return {"ok": False,
                "error": "That site returned almost no text — it may render "
                         "entirely in JavaScript. Fill the details in by hand."}
    return {"ok": True, "base": base, "pages": pages, "chars": total}


# -- profile extraction ----------------------------------------------------
PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "company_name": {"type": "string"},
        "one_liner": {"type": "string",
                      "description": "What the company does, one plain sentence, "
                                     "as a person would say it on a phone call."},
        "what_they_sell": {"type": "string",
                           "description": "The product or service being sold, "
                                          "2-3 sentences, concrete."},
        "who_they_sell_to": {"type": "string",
                             "description": "The customer this is aimed at."},
        "key_facts": {"type": "array", "items": {"type": "string"},
                      "description": "3-5 short factual claims the agent may say "
                                     "aloud: pricing, setup time, scale, guarantees. "
                                     "Only facts stated on the site."},
        "tone": {"type": "string",
                 "description": "How the company writes about itself, one phrase."},
    },
    "required": ["company_name", "one_liner", "what_they_sell", "who_they_sell_to",
                 "key_facts"],
}

EXTRACT_PROMPT = """Read this company's own website and write a short profile a
phone sales agent will rely on.

The agent SPEAKS these facts to real prospects, so anything invented becomes a lie
told on a phone call. Use only what the site actually says. If the site does not
state pricing, do not produce a price. Leave a field brief rather than padding it.

Write plainly, the way someone would say it out loud — no marketing copy, no
buzzwords, no "leading provider of innovative solutions".

WEBSITE: {base}

{content}
"""


async def extract_profile(scraped: Dict[str, Any]) -> Dict[str, Any]:
    """Turn scraped pages into a structured profile via Gemini."""
    import os
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return {"ok": False, "error": "GEMINI_API_KEY not set"}

    content = "\n\n".join(f"--- {p['url']} ---\n{p['text']}" for p in scraped["pages"])
    payload = {
        "contents": [{"parts": [{"text": EXTRACT_PROMPT.format(
            base=scraped["base"], content=content[:24000])}]}],
        "generationConfig": {"responseMimeType": "application/json",
                             "responseSchema": PROFILE_SCHEMA, "temperature": 0.1},
    }

    models = [m.strip() for m in os.getenv(
        "OUTCOME_MODELS",
        "gemini-flash-latest,gemini-3.6-flash,gemini-flash-lite-latest"
    ).split(",") if m.strip()]

    timeout = aiohttp.ClientTimeout(total=45)
    last = "unknown"
    for model in models:
        url = provider_url("gemini", f"/v1beta/models/{model}:generateContent?key={key}")
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=payload) as resp:
                    body = await resp.text()
                    if resp.status == 200:
                        data = json.loads(body)
                        text = data["candidates"][0]["content"]["parts"][0]["text"]
                        profile = json.loads(text)
                        profile["source_url"] = scraped["base"]
                        return {"ok": True, "profile": profile}
                    last = f"HTTP {resp.status}"
                    if resp.status not in (429, 500, 502, 503, 504):
                        logger.error("profile %s: %s", resp.status, body[:200])
                        break
        except Exception as exc:
            last = type(exc).__name__
            logger.warning("profile via %s failed: %s", model, exc)
        await asyncio.sleep(1.5)
    return {"ok": False, "error": f"Could not read that site ({last})."}


async def profile_from_website(url: str) -> Dict[str, Any]:
    scraped = await scrape_site(url)
    if not scraped.get("ok"):
        return scraped
    result = await extract_profile(scraped)
    if result.get("ok"):
        result["pages_read"] = [p["url"] for p in scraped["pages"]]
    return result
