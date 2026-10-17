"""
Turn a finished call into a structured outcome.

A recording is not a result. What a sales team needs is: did this qualify, what
was the objection, when do we call back, and does anything need doing now. That
is the row a CRM can act on, and it is the reason anyone pays for this.

Two rules shape the design:

1. **Ground the outcome in what executed, not what was said.** The agent can
   claim a demo was booked; only a `book_demo_slot` tool call proves it. Earlier
   a live call promised a booking and a WhatsApp that never happened, so the
   extractor is told which tools actually ran and the result is overridden if the
   model disagrees with the tool log.

2. **Never invent a disposition.** If the call was too short or nothing was
   said, the answer is `no_conversation`, not a guess. A wrong disposition is
   worse than none: it sends a human to follow up on something that never
   happened.
"""
import os
import json
import asyncio
import logging
from typing import Dict, Any, List, Optional

import aiohttp
from dotenv import load_dotenv
from nanoagent.providers.relay_url import provider_url

load_dotenv()
logger = logging.getLogger("outcomes")

# Tried in order. Extraction runs after the call has ended, so there is no
# latency budget to protect -- being patient and trying another model beats
# returning a low-confidence "read this yourself" result to the customer.
OUTCOME_MODELS = [m.strip() for m in os.getenv(
    "OUTCOME_MODELS", "gemini-flash-latest,gemini-3.6-flash,gemini-flash-lite-latest"
).split(",") if m.strip()]
RETRYABLE = {429, 500, 502, 503, 504}
# Through the key relay when there is one (providers/relay_url.py, stage 64 phase 2).
GEMINI_PATH = "/v1beta/models/{model}:generateContent?key={key}"

DISPOSITIONS = [
    "demo_booked",          # a slot was actually reserved
    "interested",           # wants to continue, no slot yet
    "callback_requested",   # asked to be called another time
    "not_interested",       # declined
    "do_not_call",          # asked to be removed - must be honoured
    "wrong_number",
    "no_conversation",      # answered but nothing usable was said
]

SCHEMA = {
    "type": "object",
    "properties": {
        "disposition": {"type": "string", "enum": DISPOSITIONS},
        "summary": {"type": "string",
                    "description": "Two sentences maximum, factual, no sales spin."},
        "next_action": {"type": "string",
                        "description": "The single concrete next step for a human, "
                                       "or 'none' if nothing is needed."},
        "objection": {"type": "string",
                      "description": "The prospect's main hesitation, or empty."},
        "callback_at": {"type": "string",
                        "description": "When to call back if they asked, else empty."},
        "contact_email": {"type": "string",
                          "description": "Email the prospect gave, else empty."},
        "confidence": {"type": "number",
                       "description": "0 to 1. Below 0.5 means a human should read "
                                      "the transcript."},
    },
    "required": ["disposition", "summary", "next_action", "confidence"],
}

PROMPT = """You are reviewing a recorded sales call for an Indian B2B company.
The conversation is in Hinglish (Hindi written in Latin script, mixed with English).

Classify the outcome honestly. You are writing a CRM record a salesperson will act
on, so a wrong classification wastes their time and annoys the prospect.

Rules:
- Only use "demo_booked" if the TOOLS EXECUTED list contains book_demo_slot. If the
  agent said a slot was booked but no tool ran, it did not happen -- use
  "interested" and say so in the summary.
- Use "no_conversation" if the prospect barely spoke or the call was cut short.
- "do_not_call" outranks everything else. If they asked to be removed, that is the
  disposition regardless of what else was discussed.
- The summary is for a colleague, not the customer. State what happened plainly.
- Leave a field empty rather than guessing at it.

TOOLS EXECUTED (this is the ground truth of what actually happened):
{tools}

CALL DURATION: {duration} seconds

TRANSCRIPT:
{transcript}
"""


def _render_transcript(turns: List[Dict[str, Any]]) -> str:
    lines = []
    for t in turns:
        speaker = t.get("speaker", "agent")
        if speaker == "tool":
            continue
        who = "PROSPECT" if speaker == "caller" else "AGENT"
        text = (t.get("text") or "").strip()
        if text:
            lines.append(f"{who}: {text}")
    return "\n".join(lines) if lines else "(nothing was said)"


def _merge_agent_turns(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Streamed transcripts arrive a word at a time; merge them back into turns."""
    merged: List[Dict[str, Any]] = []
    for t in turns:
        if merged and merged[-1]["speaker"] == t.get("speaker") \
                and t.get("speaker") != "tool":
            merged[-1]["text"] = (merged[-1]["text"] + " " + (t.get("text") or "")).strip()
        else:
            merged.append({"speaker": t.get("speaker", "agent"),
                           "text": (t.get("text") or "").strip()})
    return merged


def _fallback(turns: List[Dict[str, Any]], tools: List[str],
              reason: str) -> Dict[str, Any]:
    """Say what can be proven, rather than inventing a classification."""
    spoke = any(t.get("speaker") == "caller" and (t.get("text") or "").strip()
                for t in turns)
    if "book_demo_slot" in tools:
        disposition = "demo_booked"
    elif not spoke:
        disposition = "no_conversation"
    else:
        disposition = "interested"
    return {
        "disposition": disposition,
        "summary": f"Automatic classification unavailable ({reason}). "
                   f"{'A demo slot was booked. ' if 'book_demo_slot' in tools else ''}"
                   f"Read the transcript before acting.",
        "next_action": "Review the transcript manually.",
        "objection": "", "callback_at": "", "contact_email": "",
        "confidence": 0.0, "degraded": True,
    }


async def extract_outcome(turns: List[Dict[str, Any]], tools: List[str],
                          duration_s: float = 0.0) -> Dict[str, Any]:
    """Classify one call. Always returns a usable dict, never raises."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    merged = _merge_agent_turns(turns)

    if not key:
        return _fallback(merged, tools, "GEMINI_API_KEY not set")

    transcript = _render_transcript(merged)
    if transcript == "(nothing was said)" and not tools:
        return {"disposition": "no_conversation",
                "summary": "The call connected but nothing was said.",
                "next_action": "Retry at a better time.", "objection": "",
                "callback_at": "", "contact_email": "", "confidence": 0.9}

    payload = {
        "contents": [{"parts": [{"text": PROMPT.format(
            tools=", ".join(tools) if tools else "(none - no tool was executed)",
            duration=int(duration_s), transcript=transcript[:12000])}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
            "temperature": 0.1,
        },
    }

    timeout = aiohttp.ClientTimeout(total=30)
    last = "unknown"
    result = None

    for model in OUTCOME_MODELS:
        url = provider_url("gemini", GEMINI_PATH.format(model=model, key=key))
        for attempt in range(2):
            try:
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(url, json=payload) as resp:
                        body = await resp.text()
                        if resp.status == 200:
                            data = json.loads(body)
                            text = data["candidates"][0]["content"]["parts"][0]["text"]
                            result = json.loads(text)
                            break
                        last = f"HTTP {resp.status}"
                        if resp.status not in RETRYABLE:
                            logger.error("outcome model %s: %s", resp.status, body[:200])
                            return _fallback(merged, tools, last)
            except Exception as exc:
                last = type(exc).__name__
                logger.warning("%s attempt %d: %s", model, attempt + 1, exc)
            if attempt == 0:
                await asyncio.sleep(2)
        if result is not None:
            if model != OUTCOME_MODELS[0]:
                logger.info("outcome extracted with fallback model %s", model)
            break
        logger.warning("%s unavailable (%s), trying next model", model, last)

    if result is None:
        return _fallback(merged, tools, last)

    # The tool log is ground truth. A model that says "booked" without a booking
    # would put a phantom meeting in someone's pipeline.
    if result.get("disposition") == "demo_booked" and "book_demo_slot" not in tools:
        logger.warning("model claimed demo_booked with no book_demo_slot tool call")
        result["disposition"] = "interested"
        result["summary"] = ("[corrected: no booking tool ran] "
                             + result.get("summary", ""))
    if "book_demo_slot" in tools and result.get("disposition") not in (
            "demo_booked", "do_not_call"):
        result["disposition"] = "demo_booked"

    for field in ("objection", "callback_at", "contact_email"):
        result.setdefault(field, "")
    result.setdefault("confidence", 0.5)
    return result


async def notify_tenant(webhook_url: str, body: Dict[str, Any]) -> bool:
    """POST the outcome back to the tenant's system.

    Without this the result is stranded in our database and nobody follows up,
    which is the single most cited reason these deployments fail.
    """
    if not webhook_url:
        return False
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(webhook_url, json=body) as resp:
                if 200 <= resp.status < 300:
                    return True
                logger.warning("outcome webhook %s returned %s", webhook_url, resp.status)
    except Exception as exc:
        logger.warning("outcome webhook %s failed: %s", webhook_url, exc)
    return False
