"""Ported from computer-use/dom-pruner.ts. Prunes a DOM snapshot down to
visible/near-viewport interactive nodes, so a page with thousands of nodes doesn't
blow the LLM's context budget every turn."""

from __future__ import annotations

import copy
from dataclasses import dataclass

from nanoagent.agent.effector.types import DOMElementNode, DOMSnapshot

_ACTIONABLE_TAGS = {"button", "input", "select", "textarea", "a"}

# How many content blocks reach the prompt after pruning. Lower than the 120 the page scan
# collects: a content block is a sentence or more where an element line is a few words, so
# the same count costs far more of the context window.
_MAX_CONTENT_IN_PROMPT = 40


def prune_dom_snapshot(
    snapshot: DOMSnapshot,
    buffer_px: int = 250,
    max_elements: int = 80,
) -> DOMSnapshot:
    """Return a copy of `snapshot` retaining only elements inside the visible
    viewport (+ buffer_px), actionable elements (button/input/select/textarea/a)
    prioritized, capped at max_elements."""
    vp_height = snapshot.viewport.get("height", 720) or 720
    vp_width = snapshot.viewport.get("width", 1280) or 1280

    def in_range(el: DOMElementNode) -> bool:
        if not el.is_visible:
            return False
        x, y, w, h = el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height
        vertical = (y + h) >= -buffer_px and y <= vp_height + buffer_px
        horizontal = (x + w) >= -buffer_px and x <= vp_width + buffer_px
        return vertical and horizontal

    visible = [el for el in snapshot.elements if in_range(el)]

    # stage45 doc 04, phase 4: something else would receive a click at these elements'
    # centres, so offering them to the model is offering a click that silently lands
    # on the overlay. Dropping them leaves the overlay's OWN controls in the list,
    # which is the affordance that actually moves the task forward: dismiss the
    # banner, and the form is back on the next turn.
    #
    # The all-or-nothing guard is the safety valve. is_occluded is a centre-POINT
    # test, so a full-viewport scrim or an unusual layout could in principle mark
    # everything — and an agent shown an empty page is worse off than one shown a
    # covered element it can try. Filter only while something survives it.
    unoccluded = [el for el in visible if not el.is_occluded]
    if unoccluded:
        visible = unoccluded

    sorted_els = sorted(visible, key=lambda el: 0 if el.tag in _ACTIONABLE_TAGS else 1)
    capped = sorted_els[:max_elements]

    from nanoagent.agent.effector.dom_snapshot import build_content_summary, build_summary

    pruned = copy.copy(snapshot)
    pruned.elements = capped
    pruned.tree_text = "\n".join(f"{el.ref} [{el.tag}] {el.name or ''}" for el in capped)
    # Regenerate summary from the capped elements — this is the actual point of
    # pruning: react_loop's prompt reads .summary, not .tree_text, so leaving the
    # unpruned summary in place here would mean pruning had no effect on prompt size.
    pruned.summary = build_summary(snapshot.url, snapshot.title, capped)

    # ...and put the page's TEXT back, because rebuilding from `capped` alone drops it.
    #
    # Every snapshot passes through here before the model sees it, so the content pass
    # added on 2026-09-06 was captured and then silently discarded one function later —
    # the agent was still shown controls and no prose. Found the same evening, with the
    # probe working and zero errors reported anywhere.
    #
    # Capped harder than the raw capture: pruning exists to bound the prompt, and a
    # content block is a sentence or more where an element line is a few words, so
    # restoring all 120 would undo the saving the element cap had just made.
    content_summary = build_content_summary(snapshot.content, limit=_MAX_CONTENT_IN_PROMPT)
    if content_summary:
        pruned.summary = pruned.summary + "\n\n" + content_summary
    return pruned


@dataclass
class DOMDiffResult:
    added: list[DOMElementNode]
    removed: list[str]        # refs
    unchanged_count: int


def compute_dom_diff(
    previous_elements: list[DOMElementNode],
    current_elements: list[DOMElementNode],
) -> DOMDiffResult:
    """Semantic diff between two consecutive snapshots, so a follow-up prompt can be
    told only what changed rather than resending the whole element list."""
    prev_refs = {el.ref for el in previous_elements}
    curr_refs = {el.ref for el in current_elements}

    added = [el for el in current_elements if el.ref not in prev_refs]
    removed = [ref for ref in prev_refs if ref not in curr_refs]
    unchanged_count = len(current_elements) - len(added)

    return DOMDiffResult(added=added, removed=removed, unchanged_count=unchanged_count)
