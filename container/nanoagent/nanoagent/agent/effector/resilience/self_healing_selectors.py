"""Ported from computer-use/self-healing-selectors.ts. Multi-vector anchor matching
that recovers when a @ref target from an earlier snapshot no longer resolves — the SPA
re-rendered between perceiving and acting, so the ref is dangling but the element the
LLM meant is very likely still on the page, just at a new @ref.

Field adaptation note: the TS `InteractiveElement` this was written against carries
separate `text` and `ariaLabel` fields; Effector's own `dom_snapshot.py` (this port's
actual perception layer) folds both into a single `name` field — that's what it
genuinely captures from the page (aria-label / title / placeholder / innerText, in that
priority order — see dom_snapshot.py). So `text` is sourced from `name` here, and the
ariaLabel-specific scoring branch is skipped in favor of the same `type`-match fallback
the TS original uses when ariaLabel is absent — which is what actually runs in every
real case here, since the field is never populated. The scoring weights and algorithm
(30/40/20/10 split, Dice bigram similarity, SHA256 text-hash exact-match bonus) are
otherwise unchanged.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from loguru import logger

from nanoagent.agent.effector.types import DOMElementNode

_EMPTY_TEXT_HASH = hashlib.sha256(b"").hexdigest()[:12]


@dataclass
class AnchorDescriptor:
    tag: str
    text_hash: str
    role: str | None = None
    name: str | None = None
    text: str | None = None
    original_selector: str | None = None
    type: str | None = None


def create_anchor_descriptor(element: DOMElementNode, original_selector: str | None = None) -> AnchorDescriptor:
    clean_text = (element.name or "").strip()
    text_hash = hashlib.sha256(clean_text.lower().encode()).hexdigest()[:12]
    return AnchorDescriptor(
        tag=element.tag.lower(),
        role=element.role,
        name=element.name,
        text=clean_text,
        text_hash=text_hash,
        original_selector=original_selector or element.selector,
        type=element.type,
    )


def _string_similarity(s1: str, s2: str) -> float:
    """Dice's coefficient over character bigrams."""
    a, b = s1.strip().lower(), s2.strip().lower()
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) < 2 or len(b) < 2:
        return 1.0 if a == b else 0.0

    def bigrams(s: str) -> set[str]:
        return {s[i:i + 2] for i in range(len(s) - 1)}

    bg1, bg2 = bigrams(a), bigrams(b)
    intersection = len(bg1 & bg2)
    return (2 * intersection) / (len(bg1) + len(bg2))


def calculate_anchor_similarity(anchor: AnchorDescriptor, candidate: DOMElementNode) -> float:
    score = 0.0

    # 1. Tag & role match — 30%
    if anchor.tag == candidate.tag.lower():
        score += 0.15
    if anchor.role and candidate.role and anchor.role == candidate.role:
        score += 0.15

    # 2. Text/name similarity — 40%
    candidate_text = (candidate.name or "").strip()
    if anchor.text and candidate_text:
        score += _string_similarity(anchor.text, candidate_text) * 0.4

    # 3. Type match — 20% (ariaLabel branch never applies here — see module docstring)
    if anchor.type and candidate.type and anchor.type == candidate.type:
        score += 0.15

    # 4. Exact text-hash bonus — 10%
    candidate_hash = hashlib.sha256(candidate_text.lower().encode()).hexdigest()[:12]
    if anchor.text_hash == candidate_hash and anchor.text_hash != _EMPTY_TEXT_HASH:
        score += 0.1

    return min(1.0, score)


def resolve_self_healing_selector(
    anchor: AnchorDescriptor,
    candidates: list[DOMElementNode],
    threshold: float = 0.55,
) -> tuple[DOMElementNode, float] | None:
    """Resolve a broken anchor to the highest-confidence candidate in a fresh
    snapshot. Returns (element, confidence) or None if nothing clears the threshold."""
    best_match: DOMElementNode | None = None
    highest_score = 0.0

    for candidate in candidates:
        score = calculate_anchor_similarity(anchor, candidate)
        if score > highest_score:
            highest_score = score
            best_match = candidate

    if best_match and highest_score >= threshold:
        logger.info(
            f"self-healing-selector: healed broken reference to "
            f'tag={best_match.tag} ref={best_match.ref} text="{best_match.name}" '
            f"confidence={round(highest_score, 2)}"
        )
        return best_match, highest_score

    return None
