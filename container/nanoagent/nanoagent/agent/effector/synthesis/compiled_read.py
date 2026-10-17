"""Stage 61 phase 4 — compiled reads: a verified read task becomes a browser-free tool.

The phase 0 baseline measured ~10 s of every Effector run spent starting a browser and
loading the first page, before a single decision. For a task that only READS a public
page, none of that is needed the second time: the answer lives at a known place on a
known URL. So when a run finishes with extracted data, this records where on the final
page each value sat, and the next run of the same goal fetches that page over plain
HTTP and reads the values from those places — no browser at all.

The guard that makes this safe is the compile-time proof: a read is saved only if a
plain GET of the final URL, right now, with no cookies and no browser, already shows
every extracted value at its recorded selector. Anything that depended on this run's
session or actions fails that proof and is never compiled — a login's secure page
(redirects without cookies), a submitted form's confirmation (exists only in the
browser), a ticked checkbox (a fresh GET shows the default). What survives is exactly
"public page, value at a stable place".

Replays re-read the live page every time, so values are always current; only the
structure is cached. Any miss (non-200, a selector finding nothing, an empty value)
falls through to the normal browser run. GET only — read-only by construction
(founder decision 2026-09-19: compiled hidden-API tools are read-only).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

# Bumped when a change makes older compiled reads unsafe to replay.
# v2 (2026-09-20): only navigation-only runs compile; v1 also compiled runs that
# selected/clicked in place, whose replays reported an answer without doing the action.
COMPILED_READ_VERSION = 2

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0"
)
_FETCH_TIMEOUT_S = 15
_MAX_VALUE_CHARS = 300

# A compiled read may only stand in for a run that READ: every interaction in it must
# have been getting somewhere (the URL changed), because a GET of the final URL can
# reproduce "where we ended up" and nothing else. The proof alone is not enough — found
# live 2026-09-20: "select Option 2 and report which is selected" compiled, because the
# page's HTML contains an <option>Option 2</option> whether or not it is selected, and
# "click Start and report the text" compiled because the hidden text is in the HTML
# before the click. Replaying either reports the answer without doing the action.
_READ_ACTIONS = frozenset({"navigate", "scroll", "wait", "extract", "browser_exec", "done", "hover"})
# Interactions that are acceptable only when they navigated (or, for typing, when the
# very next step submitted and navigated — a search box).
_NAVIGATING_ACTIONS = frozenset({"click", "double_click", "key"})
_TYPING_ACTIONS = frozenset({"type", "select_combobox", "clear"})


@dataclass
class CompiledRead:
    domain: str
    goal: str
    goal_hash: str
    url: str
    fields: dict[str, str]  # extracted key -> CSS selector on `url`
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    replays: int = 0
    version: int = COMPILED_READ_VERSION


def _goal_hash(domain: str, goal: str) -> str:
    norm = re.sub(r"\s+", " ", goal.strip().lower())
    return hashlib.sha256(f"{domain}|{norm}".encode()).hexdigest()[:16]


def _path(workspace: Path, domain: str, goal: str) -> Path:
    from nanoagent.agent.effector.site_map import site_map_base

    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in domain)
    # Stage 61 phase 5: in the owner's shared site map when one is mounted, so every
    # agent of that owner gets the browser-free path the first agent earned.
    return site_map_base(workspace) / "compiled-reads" / safe / f"{_goal_hash(domain, goal)}.json"


def load_compiled_read(workspace: Path, domain: str, goal: str) -> CompiledRead | None:
    p = _path(workspace, domain, goal)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        cr = CompiledRead(**data)
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: unreadable compiled read {p} — {err}")
        return None
    if cr.version < COMPILED_READ_VERSION or cr.goal_hash != _goal_hash(domain, goal):
        return None
    return cr


def find_by_goal(workspace: Path, goal: str) -> CompiledRead | None:
    """A compiled read for this exact goal on any site in the map — for a call that named
    no URL, so there is no domain to key on. Found live 2026-09-20: a sibling agent called
    effector with the same goal but no url, missed the read its sibling had compiled, and
    started a browser on about:blank. Still exact-goal only; the replay still proves itself
    against the live page."""
    from nanoagent.agent.effector.site_map import site_map_base

    root = site_map_base(workspace) / "compiled-reads"
    if not root.is_dir():
        return None
    want = re.sub(r"\s+", " ", goal.strip().lower())
    for p in root.glob("*/*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if re.sub(r"\s+", " ", str(data.get("goal", "")).strip().lower()) == want:
            return load_compiled_read(workspace, data.get("domain", ""), data.get("goal", ""))
    return None


def save_compiled_read(workspace: Path, cr: CompiledRead) -> Path:
    from nanoagent.agent.effector.site_map import write_atomic

    p = _path(workspace, cr.domain, cr.goal)
    write_atomic(p, json.dumps(asdict(cr), indent=2))
    return p


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


# Runs in the live page: for one value, the one element whose text IS that value, and
# a selector path to it that the page itself confirms is unique. Equality, not
# containment: "11" is contained in a price "£41.11", and a selector chosen that way
# would pass the proof today and return the price on every later replay. Nested
# elements with the same text count once (the innermost); two separate elements with
# the value is ambiguous, and ambiguous is refused.
_LOCATE_JS = r"""
(value) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(value);
  if (!want) return null;
  const exact = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"].includes(el.tagName)) continue;
    if (norm(el.textContent) === want) exact.push(el);
  }
  const innermost = exact.filter((el) => !exact.some((o) => o !== el && el.contains(o)));
  if (innermost.length !== 1) return null;
  const best = innermost[0];
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const parts = [];
  let el = best;
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    if (el.id && document.querySelectorAll("#" + esc(el.id)).length === 1) {
      parts.unshift("#" + esc(el.id));
      break;
    }
    let i = 1, sib = el;
    while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
    parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
    el = el.parentElement;
  }
  const sel = parts.join(" > ");
  const found = document.querySelectorAll(sel);
  if (found.length !== 1 || found[0] !== best) return null;
  return sel;
}
"""


def _fetch(url: str) -> str | None:
    import httpx

    try:
        r = httpx.get(url, headers={"User-Agent": _UA}, timeout=_FETCH_TIMEOUT_S, follow_redirects=False)
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: compiled-read fetch failed for {url} — {err}")
        return None
    # A redirect is the page saying "not without a session" — that is a miss, not a
    # page to follow somewhere else and read something unrelated from.
    if r.status_code != 200:
        return None
    return r.text


def read_fields(html: str, fields: dict[str, str]) -> dict[str, str] | None:
    """Every field's text from `html`, or None if any selector finds nothing or
    finds an empty element."""
    import lxml.html
    from lxml.cssselect import CSSSelector

    try:
        doc = lxml.html.fromstring(html)
    except Exception:  # noqa: BLE001
        return None
    out: dict[str, str] = {}
    for key, sel in fields.items():
        try:
            hits = CSSSelector(sel)(doc)
        except Exception:  # noqa: BLE001
            return None
        if len(hits) != 1:
            return None
        text = re.sub(r"\s+", " ", hits[0].text_content() or "").strip()
        if not text:
            return None
        out[key] = text
    return out


def _strip_fragment(url: str | None) -> str:
    return (url or "").split("#", 1)[0]


def only_navigation(steps: list[dict[str, Any]], start_url: str | None) -> bool:
    """True when every step either just read, or moved the browser to a new URL.

    `steps` are the run's executed actions in order, each {"action", "url_after"}."""
    before = _strip_fragment(start_url)
    moved: list[bool] = []
    for st in steps:
        after = _strip_fragment(st.get("url_after")) or before
        moved.append(bool(after) and after != before)
        before = after
    for i, st in enumerate(steps):
        action = st.get("action")
        if action in _READ_ACTIONS:
            continue
        if action in _NAVIGATING_ACTIONS and moved[i]:
            continue
        if action in _TYPING_ACTIONS and (
            moved[i] or (i + 1 < len(steps) and steps[i + 1].get("action") in _NAVIGATING_ACTIONS and moved[i + 1])
        ):
            continue
        return False
    return True


def _is_eligible(extracted: dict[str, Any] | None, steps: list[dict[str, Any]], start_url: str | None, url: str) -> bool:
    from nanoagent.agent.proxy_config import should_route_through_proxy

    if not extracted or not isinstance(extracted, dict):
        return False
    if not only_navigation(steps, start_url):
        return False
    # Bot-sensitive sites stay on the browser path, with its proxy and cadence.
    if should_route_through_proxy(url):
        return False
    return all(
        isinstance(v, (str, int, float)) and 0 < len(str(v)) <= _MAX_VALUE_CHARS
        for v in extracted.values()
    )


async def compile_read(
    page: Any,
    workspace: Path,
    domain: str,
    goal: str,
    extracted: dict[str, Any] | None,
    steps: list[dict[str, Any]],
    start_url: str | None,
) -> CompiledRead | None:
    """Try to compile this finished run into a browser-free read. Never raises."""
    try:
        url = getattr(page, "url", "") or ""
        if not url.startswith(("http://", "https://")) or not _is_eligible(extracted, steps, start_url, url):
            return None
        fields: dict[str, str] = {}
        for key, value in extracted.items():
            sel = await page.evaluate(_LOCATE_JS, str(value))
            if not sel:
                logger.debug(f"effector: not compiling a read — {key!r} has no unique place on the page")
                return None
            fields[key] = sel

        # The proof: the same values, at the same places, with no browser and no session.
        import asyncio

        html = await asyncio.get_running_loop().run_in_executor(None, _fetch, url)
        got = read_fields(html, fields) if html else None
        if got is None or any(_norm(str(extracted[k])) != _norm(got[k]) for k in fields):
            logger.debug("effector: not compiling a read — a plain GET does not show the same values")
            return None

        cr = CompiledRead(domain=domain, goal=goal, goal_hash=_goal_hash(domain, goal), url=url, fields=fields)
        save_compiled_read(workspace, cr)
        logger.info(f"effector: compiled a browser-free read for {domain} ({len(fields)} field(s)) — {url}")
        return cr
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: compiling a read failed (the run itself was fine) — {err}")
        return None


def replay_read(workspace: Path, domain: str | None, goal: str) -> dict[str, Any] | None:
    """Run a compiled read if one exists and still works. Returns the extracted data,
    or None — in which case the caller runs the browser as usual. With no domain (the
    call named no URL), the read is looked up by its exact goal instead."""
    cr = load_compiled_read(workspace, domain, goal) if domain else find_by_goal(workspace, goal)
    if cr is None:
        return None
    html = _fetch(cr.url)
    got = read_fields(html, cr.fields) if html else None
    if got is None:
        logger.info(f"effector: compiled read for {domain} missed — using the browser")
        return None
    cr.replays += 1
    try:
        save_compiled_read(workspace, cr)
    except Exception:  # noqa: BLE001
        pass
    return {"url": cr.url, "extracted_data": got}
