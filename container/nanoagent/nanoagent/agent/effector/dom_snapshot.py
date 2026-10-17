"""Ported from computer-use/dom-snapshot.ts. Captures a compact, @ref-tagged snapshot
of interactive elements — the core perception primitive react_loop feeds to the LLM."""

from __future__ import annotations

import re

from loguru import logger

from nanoagent.agent.effector.isolated_world import evaluate_isolated
from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point

# Raw, because this is JavaScript and its one backslash belongs to a JS regex (`/\s+/g`).
# Unraw, Python read `\s` as an unknown escape — it passed it through unchanged, so the
# probe worked, but every run warned and Python 3.12+ turns that warning into a
# SyntaxError. The alternative, doubling it to `\\s`, is what the older probe string in
# this file does and is the reason a heredoc keeps mangling edits to it.
_CONTENT_JS = r"""
() => {
  // ── content, not just controls ──────────────────────────────────────────
  //
  // Everything above is a CLICK TARGET. That was the whole snapshot until 2026-09-06,
  // and it meant an agent looking at a LinkedIn feed saw twenty-six buttons and zero
  // posts — so it reported, correctly from where it stood, that it could not find the
  // feed content. Reading the page needed a separate `extract` call, which is a second
  // turn and a second thing to get wrong.
  //
  // Codex names the difference plainly: its snapshot carries "headings, post text,
  // author names, buttons, links and sidebar items" and it answers in one turn. This
  // pass is that missing half.
  //
  // Deliberately a SEPARATE pass rather than widening `selectors`: these are not
  // actionable, they must not be offered as click targets, and they need their own
  // rules about nesting and size that would make a mess of the walker above.
  const CONTENT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,article,blockquote,[role="article"],[role="heading"],td,dd,figcaption';
  const MAX_CONTENT = 120;          // a feed is unbounded; a snapshot is not
  const MAX_CHARS = 400;            // per block — enough to identify, not to quote
  const MIN_CHARS = 2;

  const content = [];
  const seenText = new Set();

  const roots = [document];
  for (const root of roots) {
    if (content.length >= MAX_CONTENT) break;
    let nodes;
    try { nodes = root.querySelectorAll(CONTENT_SEL); } catch (e) { continue; }

    for (const el of nodes) {
      if (content.length >= MAX_CONTENT) break;

      // Only what a person can actually see. An off-screen or zero-sized block is
      // usually a template or a hidden aria helper, and reporting it as page content
      // is how an agent ends up describing something nobody is looking at.
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > innerHeight * 3) continue;   // a little below the fold is still "loaded"

      const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (raw.length < MIN_CHARS) continue;

      // Nesting is the real hazard: an <article> contains its own <p>s, so naive
      // collection reports the same sentence three times and fills the budget with
      // duplicates. Keeping the first occurrence of a given text keeps the OUTERMOST
      // block — the post rather than its fragments — because the walk is document order.
      const key = raw.slice(0, 120);
      if (seenText.has(key)) continue;
      seenText.add(key);

      content.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + '…' : raw,
        bounds: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      });
    }
  }

  // One shape, two kinds. `content` is separate from `results` so nothing downstream
  // mistakes a paragraph for something it can click.
  return content;
}
"""


_INTERACTIVE_SELECTORS = ", ".join([
    "button", "a[href]", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[contenteditable="true"]', "[tabindex]:not([tabindex='-1'])",
])

# Same discovery logic as the TS original, evaluated in-page. Kept as one JS blob
# (rather than many small page.evaluate calls) for the same reason the TS version did:
# one round trip per snapshot, not one per element.
_SNAPSHOT_JS = """
(selectors) => {
  // stage45 doc 04, phase 3: querySelectorAll does not cross a shadow boundary, so
  // every element inside a web component used to be invisible here — not mis-read,
  // absent. Shopify, Salesforce and most design systems build their controls this
  // way. Walking the roots is the only way to see them.
  //
  // Only OPEN roots: el.shadowRoot is null for mode:'closed', which JS cannot enter
  // at all. That is the one thing in this file that needs CDP, and it is deliberately
  // left to a later phase.
  // 12, not the 8 this was first written with: chromestatus.com measured at depth 7
  // on 2026-08-29 (160 roots and 741 nodes behind 34 light-DOM ones), leaving a
  // single level of margin on a real production app. The walk ends on its own once a
  // subtree has no more shadow roots, so a generous cap costs nothing on flat pages.
  const MAX_SHADOW_DEPTH = 12;
  const MAX_SCAN_NODES = 12000;    // the walker is O(all nodes); this is the ceiling on that
  let scanned = 0;

  const roots = [document];        // every root we searched — needed for uniqueness below
  const collected = [];            // { el, root, host }

  const walk = (root, depth, host) => {
    for (const el of root.querySelectorAll(selectors)) collected.push({ el, root, host });
    if (depth >= MAX_SHADOW_DEPTH || scanned >= MAX_SCAN_NODES) return;
    const all = root.querySelectorAll('*');
    scanned += all.length;
    for (const el of all) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      roots.push(sr);
      // `host || el` keeps the OUTERMOST host: that is the component a human would
      // name ("the address-form widget"), not whatever inner element re-shadowed.
      walk(sr, depth + 1, host || el);
      if (scanned >= MAX_SCAN_NODES) return;
    }
  };
  walk(document, 0, null);

  // Playwright's CSS engine pierces open shadow roots, so a selector that is unique
  // inside one root but ALSO present in another would resolve ambiguously and .first
  // would pick whichever came first. Counting across every root we searched is what
  // makes "unique" mean the same thing here as it will at click time. With no shadow
  // roots on the page this is exactly the old document-only check.
  const countAcross = (candidate) => {
    let n = 0;
    for (const r of roots) {
      n += r.querySelectorAll(candidate).length;
      if (n > 1) return n;
    }
    return n;
  };

  const hostSelector = (host) => {
    if (!host) return undefined;
    if (host.id) return `#${CSS.escape(host.id)}`;
    return host.tagName.toLowerCase();
  };

  const seen = new Set();
  const results = [];

  for (const { el, root, host } of collected) {
    if (seen.has(el)) continue;
    seen.add(el);
    const isShadow = root !== document;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    const isVisible =
      rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none' &&
      style.opacity !== '0' &&
      // Real viewport intersection, not just "not above/left of origin" — the
      // original only checked rect.bottom/rect.right >= 0, which never excluded
      // anything positioned off-screen to the right or below (a closed off-canvas
      // drawer, anything shifted via `transform`). Found 2026-08-23 against a real
      // site (demoqa.com) whose always-present left sidebar link leaked into the
      // interactive-element list and got clicked instead of the intended form field.
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= window.innerHeight && rect.left <= window.innerWidth;

    if (!isVisible) continue;

    let name = (
      el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || el.getAttribute('alt') ||
      ((el instanceof HTMLInputElement || el instanceof HTMLButtonElement) ? el.value : '') ||
      el.innerText || el.textContent || ''
    ).trim().replace(/\\s+/g, ' ').slice(0, 100);

    // Real bug, 2026-08-27: whether `name` is safe to use as a Playwright
    // :has-text() qualifier on THIS element below — true for everything found
    // above (an attribute of el itself, or el.innerText/textContent, which
    // includes descendant text — exactly what :has-text() checks) and for the
    // placeholder fallback just below. Explicitly set false in the three
    // fallback blocks further down that pull text from a SIBLING or ancestor
    // (aria-labelledby's target, the nearby-container climb, the ancestor-id
    // last resort) — that text isn't inside el, so :has-text(name) on el would
    // never match it.
    let nameIsWithinElement = true;

    if (name.length === 0 && el instanceof HTMLInputElement && el.placeholder) {
      name = el.placeholder;
    }

    // Gap-closing pass, 2026-08-23: found live against demoqa.com's practice
    // form — a react-select combobox's real <input> has NO name, label,
    // placeholder attribute, or text of its own; the "Select City..." text the
    // user actually sees is rendered as a SIBLING <div>, invisible to every
    // check above. The model was handed "[@e14] input role=combobox type=text"
    // with zero distinguishing text for either of two unlabeled comboboxes on
    // the page and had no way to know which one was City — it wasn't confused,
    // it was correctly refusing to guess blind. This pattern (label rendered as
    // a sibling node, not an attribute) is standard for React Select, Material
    // UI Autocomplete, Chakra UI Select, and most other custom dropdown
    // widgets — not a DemoQA-specific quirk.
    if (name.length === 0) {
      // aria-labelledby: a real accessible-name pattern these widgets DO often
      // set correctly, and cheaper/more reliable than guessing from nearby text.
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        name = labelledBy.split(/\\s+/)
          // ids are scoped to their root: document.getElementById would not find a
          // label that lives inside the same shadow root as the element.
          .map((id) => (isShadow ? root.getElementById(id) : document.getElementById(id)))
          .filter(Boolean)
          .map((labelEl) => (labelEl.innerText || labelEl.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 100);
        if (name) nameIsWithinElement = false;  // text lives on the labelling element, not el
      }
    }

    if (name.length === 0) {
      // Nearby-container fallback: climb a few ancestors and use the first one
      // whose visible text differs from the element's own (an <input> always
      // has empty innerText/textContent, so any non-empty ancestor text here is
      // necessarily coming from a SIBLING node — the rendered placeholder/label,
      // not the element itself). Bounded to 3 levels so it can't wander into an
      // unrelated section of the page and grab irrelevant text.
      const ownText = (el.innerText || el.textContent || '').trim();
      let node = el.parentElement;
      for (let depth = 0; depth < 3 && node; depth++) {
        const nodeText = (node.innerText || '').trim();
        if (nodeText && nodeText !== ownText) {
          name = nodeText.replace(/\\s+/g, ' ').slice(0, 100);
          nameIsWithinElement = false;  // came from an ancestor/sibling text, not el itself
          break;
        }
        node = node.parentElement;
      }
    }

    if (name.length === 0) {
      // Last resort: the nearest ancestor with a real, human-set id (react-select
      // containers are conventionally id'd after the field, e.g. id="city") —
      // worse than real label text, but still far better than nothing.
      let node = el;
      for (let depth = 0; depth < 3 && node; depth++) {
        if (node.id && !/^react-select-\\d/.test(node.id)) {
          name = `(${node.id})`;
          nameIsWithinElement = false;  // synthetic label, not real text inside el
          break;
        }
        node = node.parentElement;
      }
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || undefined;
    const type = el.type || undefined;
    const placeholder = el.placeholder || undefined;
    const value = el.value || undefined;
    const isEnabled = !el.disabled;

    // Real bug, 2026-08-27, found live against demoqa.com's homepage: none of the
    // tiers below were ever checked for uniqueness against the LIVE page. The
    // homepage's category cards all share className "card mt-4 top-card" (so the
    // class-based tier produced a selector matching all 6 cards, not just the
    // intended one), and their wrapping <a> tags have no id/name/data-testid/class
    // at all — falls straight to the bare tag "a", matching every link on the
    // page. resolve_target's @ref layer re-queries this selector at click time and
    // takes `.first` unconditionally — so the click landed on whichever element
    // happened to be first in DOM order (an empty skip-link, in this case), not
    // the one actually meant. It dispatched fine (no error — a `.first` match
    // always exists) and simply never did anything, no matter how many times it
    // was retried. Fixed with an href tier for <a> (common, usually unique, far
    // more stable than a shared class) and a live uniqueness check that keeps
    // trying more specific tiers instead of stopping at the first one that merely
    // exists, plus a Playwright-only :has-text() qualifier as a final
    // strengthening step when nothing above resolved uniquely.
    let selector = tag;
    let selectorIsUnique = false;
    const trySelector = (candidate) => {
      if (selectorIsUnique) return;
      try {
        if (countAcross(candidate) === 1) {
          selector = candidate;
          selectorIsUnique = true;
        } else if (selector === tag) {
          // Not unique yet, but still more specific than the bare tag — keep it
          // as the running best guess in case nothing ever resolves uniquely.
          selector = candidate;
        }
      } catch (e) { /* not valid as a real CSS selector — skip */ }
    };
    if (el.id) trySelector(`#${CSS.escape(el.id)}`);
    if (el.getAttribute('name')) trySelector(`${tag}[name="${CSS.escape(el.getAttribute('name'))}"]`);
    if (el.getAttribute('data-testid')) trySelector(`[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]`);
    if (tag === 'a' && el.getAttribute('href')) trySelector(`a[href="${CSS.escape(el.getAttribute('href'))}"]`);
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      const primaryClass = el.className.trim().split(/\\s+/)[0];
      if (primaryClass && !primaryClass.includes(':')) trySelector(`${tag}.${CSS.escape(primaryClass)}`);
    }
    // Still not confirmed unique. Playwright's :has-text() is a selector-engine
    // extension (not real CSS — document.querySelectorAll can't validate it,
    // which is why it isn't run through trySelector above), evaluated by
    // Playwright itself at click time — exactly the disambiguator this page
    // needs, using the same accessible name already computed above. Only safe
    // when that name is guaranteed to be inside this element (nameIsWithinElement)
    // — see that flag's own note.
    if (!selectorIsUnique && name && nameIsWithinElement) {
      selector = `${selector}:has-text(${JSON.stringify(name.slice(0, 60))})`;
    }

    const bounds = {
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
    const center = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };

    // stage45 doc 04, phase 4: is anything sitting on top of this element's centre?
    // A cookie banner or an open modal over a form does not make its fields vanish
    // from querySelectorAll -- they stay visible, enabled, and correctly positioned,
    // and the click lands on the overlay. No error, no navigation, nothing to
    // diagnose from, and the model looks like it clicked the wrong thing.
    //
    // elementFromPoint asks the browser's own hit-tester the exact question a click
    // asks: what would receive a click at this point. That is narrower than "what is
    // visible here", which is why this is a point test and not a rect-overlap
    // calculation -- the general question is harder and we do not have it.
    let occluded = false;
    try {
      // A shadow element must be hit-tested through its OWN root. document's version
      // retargets to the outermost host, which never `contains` the element (contains
      // does not cross a shadow boundary), so every component's contents would come
      // back "covered".
      const hit = (isShadow ? root : document).elementFromPoint(center.x, center.y);
      // null means the centre is outside the viewport -- a half-scrolled element, or
      // one just past the fold that the visibility check above still kept. That is
      // UNKNOWN, not covered. Marking it covered would prune away everything the
      // agent is supposed to scroll down to.
      if (hit) occluded = !(hit === el || el.contains(hit) || hit.contains(el));
    } catch (e) { /* no hit-testing here -- assume clear rather than hide a real element */ }

    // A shadow element whose selector never resolved uniquely has no address the
    // resolver can use: Playwright would pierce, match more than one, and .first
    // would pick the wrong one. Coordinates are the honest route in — the same flag
    // phase 2 built for elements in frames we cannot name, for the same reason.
    results.push({ tag, role: role || tag, name: name || undefined, value: value || undefined,
      placeholder: placeholder || undefined, type: type || undefined, selector,
      bounds, center, isVisible: true, isEnabled, isOccluded: occluded,
      shadowHost: isShadow ? hostSelector(host) : undefined,
      coordinateOnly: isShadow && !selectorIsUnique });
  }

  return results;
}
"""


# God-level pillar 08, 2026-08-23: bounds how many extra (non-main) frames get
# queried per snapshot — an ad-heavy page can have dozens of tracking iframes
# that are never worth the extra evaluate() round trips. Generous enough for
# the real cases this exists for (one payment widget, one chat widget, maybe
# a CAPTCHA), not unbounded.
_MAX_EXTRA_FRAMES = 5

# stage45 doc 04, phase 1: how far up a frame's parent chain _frame_origin will walk
# before giving up. Real nesting is one or two deep (a widget inside a widget); this
# only exists so a malformed or cyclic chain can't spin forever.
_MAX_FRAME_DEPTH = 8

# stage45 doc 04, phase 2: frames smaller than this in either axis hold nothing a
# human could click — analytics beacons and consent pings are conventionally 0x0 or
# 1x1. Worth filtering now that unnamed frames are kept, because their contents would
# otherwise compete for dom_pruner's 80-element budget against real page content.
# Free to check: _frame_origin already measures the frame's own box.
_MIN_FRAME_PX = 4


async def _frame_selector(frame) -> str | None:
    """Best-effort CSS selector identifying `frame`'s own <iframe> element in
    ITS PARENT frame — the string page.frame_locator(...) needs to route a
    later action into this frame's content. None means "couldn't identify it
    reliably" (no id/name/src attribute found) — that frame's elements are
    skipped entirely rather than guessed at with something fragile like a
    positional index."""
    try:
        element = await frame.frame_element()
        if element is None:
            return None
        frame_id = await element.get_attribute("id")
        if frame_id:
            return f"#{frame_id}"
        frame_name = await element.get_attribute("name")
        if frame_name:
            return f'iframe[name="{frame_name}"]'
        frame_src = await element.get_attribute("src")
        if frame_src:
            return f'iframe[src="{frame_src}"]'
    except Exception:
        pass
    return None


# stage45 doc 04, phase 1. Reads the iframe element's CONTENT-box origin in its
# OWN parent's coordinate space. Not element.bounding_box(): that returns the
# BORDER box, and Chrome's UA stylesheet gives a bare <iframe> a 2px inset border,
# so every coordinate inside an iframe that didn't reset its border would have been
# off by 2px in both axes. Cheap to be exact here, so be exact.
_FRAME_OFFSET_JS = """
(el) => {
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  const num = (v) => parseFloat(v) || 0;
  return {
    x: r.left + num(s.borderLeftWidth) + num(s.paddingLeft),
    y: r.top + num(s.borderTopWidth) + num(s.paddingTop),
    width: r.width,
    height: r.height,
  };
}
"""


async def _frame_origin(frame) -> Bounds | None:
    """Page-absolute content origin of `frame`, as a Bounds whose x/y is the origin
    and whose width/height is the iframe's own size.

    Everything a frame reports through getBoundingClientRect() is relative to THAT
    frame's viewport, not the page's. Adding this origin is what converts it. The
    walk goes up the whole parent chain and sums each hop, so a frame nested three
    deep lands in the right place for the same reason a frame nested one deep does
    — depth is handled by construction, not by a special case.

    Each hop's rect is measured inside the parent frame, which means the parent's
    own scroll position is already accounted for. So is the child's, in the rects it
    reported. Summing them gives a coordinate in the main frame's viewport, which is
    exactly the space page.mouse.click() takes.

    None means some hop could not be measured — a frame_element() that raises on a
    detached or genuinely unreachable frame, or an offset that came back malformed.
    The caller drops the frame rather than emitting refs whose coordinates would be
    silently wrong; see capture_dom_snapshot.
    """
    x = y = 0.0
    width = height = 0.0
    node = frame
    hops = 0
    while hops < _MAX_FRAME_DEPTH:
        parent = getattr(node, "parent_frame", None)
        if parent is None:
            # No parent -> `node` is the main frame and the walk is complete.
            return Bounds(x=x, y=y, width=width, height=height)
        try:
            element = await node.frame_element()
            if element is None:
                return None
            offset = await element.evaluate(_FRAME_OFFSET_JS)
        except Exception:
            return None
        if not isinstance(offset, dict) or "x" not in offset or "y" not in offset:
            return None
        if hops == 0:
            # The innermost hop is the frame's own box -- its size is what we report.
            width = float(offset.get("width", 0) or 0)
            height = float(offset.get("height", 0) or 0)
        x += float(offset["x"])
        y += float(offset["y"])
        node = parent
        hops += 1
    return None  # cycle, or nesting deeper than we are willing to walk


def _shift(rect: dict, dx: float, dy: float) -> dict:
    return {**rect, "x": rect.get("x", 0) + dx, "y": rect.get("y", 0) + dy}


async def _snapshot_frame(frame, frame_selector: str | None, origin: Bounds | None = None) -> list[dict]:
    """Runs the same _SNAPSHOT_JS inside one frame's own document context —
    it's a plain DOM query, identical whether it's the top page or an iframe's
    content. Tags each raw element dict with which frame it came from before
    handing back to the caller, which is what makes it possible to route a
    later click/type back into the right frame. Builds NEW dicts rather than
    mutating what evaluate() returned in place — a real fake-page test fixture
    returned the same shared list object on every call, and mutating it here
    would have quietly corrupted every other test importing that fixture."""
    try:
        raw_elements = await evaluate_isolated(frame, _SNAPSHOT_JS, _INTERACTIVE_SELECTORS)
        if not isinstance(raw_elements, list):
            raw_elements = []
    except Exception:
        return []

    # stage45 doc 04, phase 1: shift into page space here, once, at the boundary
    # where the frame's identity is still known. Everything downstream — the model
    # prompt, the resolver, the executor's mouse — then deals in one coordinate
    # space and never has to ask which document a number came from.
    if origin is None:
        return [
            {**el, "_frame_selector": frame_selector, "_frame_bounds": None, "_coordinate_only": False}
            for el in raw_elements
        ]
    # stage45 doc 04, phase 2: in a frame, with no selector for the frame itself, the
    # element's own selector is only resolvable inside that frame's document — and the
    # resolver has no way to get there. Coordinates are the only route in.
    coordinate_only = frame_selector is None
    return [
        {
            **el,
            "bounds": _shift(el.get("bounds", {}), origin.x, origin.y),
            "center": _shift(el.get("center", {}), origin.x, origin.y),
            "_frame_selector": frame_selector,
            "_frame_bounds": origin,
            "_coordinate_only": coordinate_only,
        }
        for el in raw_elements
    ]


async def capture_dom_snapshot(page) -> DOMSnapshot:
    """Capture a compact, token-efficient DOM + accessibility snapshot of every
    interactive element currently on the page — including, since the god-level
    pillar 08 pass, single-level iframe content (a payment widget, an embedded
    chat, some CAPTCHA implementations), which was previously invisible: the
    interactive-elements query only ever looked at the top document. Ref
    numbering (@e1, @e2, ...) is continuous across the top page and every
    frame — from the model's point of view a ref is just a ref, which frame it
    resolves through is this module's problem, not something it needs to know.

    stage45 doc 04, phase 1 (2026-08-29): every element's bounds/center is now
    PAGE-absolute regardless of which frame it came from, at any nesting depth
    (_frame_origin sums the chain). Before this, a frame element's coordinates
    were measured from its own frame's viewport, which made them unusable for a
    page-level click — and the resolver correctly refused to use them, sending
    every in-frame miss to the vision LLM instead.

    Corrected 2026-08-29: an earlier version of this note claimed nested frames "were
    already being captured". They were not. NOTHING in any frame was, because the
    enumeration below called page.frames() on a property — see the comment there.
    Page.frames does return the whole tree, so depth is handled once the call is right,
    and _frame_origin sums the chain to place each frame on the page."""
    # stage45 doc 05 phase 3: on the remote lane the page is the user's own browser and
    # the snapshot comes back from the extension, already assembled and page-absolute. One
    # branch here rather than a parallel capture function, so every caller — the loop, the
    # resolver, self-heal, escalation — keeps working without knowing which lane it is on.
    remote = getattr(page, "nc_remote_snapshot", None)
    if callable(remote):
        return await remote()

    url = page.url
    try:
        title = await page.title()
    except Exception:
        title = ""

    raw_elements = await _snapshot_frame(page, frame_selector=None)

    # Playwright's Page.frames is a PROPERTY, not a method. This called page.frames(),
    # which raises TypeError: 'list' object is not callable on every real page — and the
    # bare `except` below turned that into an empty list, silently. Iframe support has
    # therefore never worked in production: not phases 1-2 of stage45 doc 04, and not the
    # god-level pillar 08 work this was added for on 2026-08-23. Every iframe's contents
    # were dropped on every snapshot, with no error anywhere.
    #
    # It passed its entire test file because the fake page in
    # test_effector_phase18_iframe_and_dialogs.py defines frames() as a METHOD — the test
    # double asserted the API the code assumed instead of the one Playwright has. Found
    # 2026-08-29 by running the deployed image against demoqa.com/frames and
    # google.com/recaptcha/api2/demo and seeing 4 frames enumerated alongside 0 in-frame
    # elements.
    #
    # The except is kept, but narrowed and no longer silent: a page object with no frame
    # support at all is a legitimate degrade (several older fakes are exactly that);
    # anything else is a bug, and a bare swallow is the worst possible handling of it.
    try:
        all_frames = page.frames
        if callable(all_frames):  # never true for Playwright; older test doubles differ
            all_frames = all_frames()
        child_frames = [f for f in all_frames if f != page.main_frame][:_MAX_EXTRA_FRAMES]
    except AttributeError:
        child_frames = []  # no frame support on this page object — top document only
    except Exception as err:
        logger.warning(f"effector: frame enumeration failed, top document only — {err}")
        child_frames = []

    for frame in child_frames:
        # stage45 doc 04, phase 1: a frame we can identify but cannot PLACE is worse
        # than one we skip. Its elements would get refs, reach the model, and resolve
        # to coordinates measured from the wrong origin — a click that lands
        # somewhere real and wrong, with no error. Drop it instead.
        origin = await _frame_origin(frame)
        if origin is None:
            continue
        if origin.width < _MIN_FRAME_PX or origin.height < _MIN_FRAME_PX:
            continue  # tracking pixel / collapsed frame — nothing clickable inside
        # stage45 doc 04, phase 2: an unnamed frame is no longer skipped. Being unable
        # to NAME a frame only costs us frame_locator routing; phase 1 means we can
        # still place and click its contents. The elements come back flagged
        # coordinate_only so the resolver knows not to try the selector — see
        # _snapshot_frame and DOMElementNode.coordinate_only for why that flag has to
        # be obeyed rather than merely preferred.
        selector = await _frame_selector(frame)
        raw_elements.extend(await _snapshot_frame(frame, frame_selector=selector, origin=origin))

    elements: list[DOMElementNode] = []
    for idx, el in enumerate(raw_elements):
        bounds = el.get("bounds", {})
        center = el.get("center", {})
        elements.append(DOMElementNode(
            ref=f"@e{idx + 1}",
            tag=el.get("tag", ""),
            role=el.get("role"),
            name=el.get("name"),
            value=el.get("value"),
            placeholder=el.get("placeholder"),
            type=el.get("type"),
            selector=el.get("selector", el.get("tag", "")),
            bounds=Bounds(x=bounds.get("x", 0), y=bounds.get("y", 0),
                           width=bounds.get("width", 0), height=bounds.get("height", 0)),
            center=Point(x=center.get("x", 0), y=center.get("y", 0)),
            is_visible=True,
            is_enabled=el.get("isEnabled", True),
            frame_selector=el.get("_frame_selector"),
            frame_bounds=el.get("_frame_bounds"),
            # Two independent reasons an element can be coordinate-only, and they
            # compose: "_coordinate_only" is set per-FRAME by _snapshot_frame (phase
            # 2, a frame we could place but not name), "coordinateOnly" per-ELEMENT
            # by the walker (phase 3, a shadow element with no unique selector). An
            # unnamed component inside an unnamed iframe carries both.
            coordinate_only=bool(el.get("_coordinate_only") or el.get("coordinateOnly")),
            shadow_host=el.get("shadowHost"),
            is_occluded=bool(el.get("isOccluded")),
        ))

    viewport = page.viewport_size or {"width": 1280, "height": 720}

    # What the page SAYS. A separate evaluate rather than part of the element walk: it
    # answers a different question, and a failure to read the prose must never cost the
    # controls — an agent with buttons and no text can still work, one with neither
    # cannot.
    content: list[dict] = []
    try:
        raw_content = await evaluate_isolated(page, _CONTENT_JS)
        if isinstance(raw_content, list):
            content = [c for c in raw_content if isinstance(c, dict)]
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: page content scan failed — {err}")

    summary = build_summary(url, title, elements)
    content_summary = build_content_summary(content)
    if content_summary:
        summary = summary + "\n\n" + content_summary

    return DOMSnapshot(
        url=url,
        title=title,
        elements=elements,
        summary=summary,
        viewport=dict(viewport),
        content=content,
    )


def build_content_summary(content: list[dict], limit: int = 60) -> str:
    """Render the page's readable text for the prompt.

    Kept apart from the element list on purpose: these carry no @ref and must never look
    like something to click. An agent that tries to click a paragraph has been misled by
    its own snapshot.
    """
    if not content:
        return ""
    lines = ["Page Content:"]
    for block in content[:limit]:
        text = str(block.get("text") or "").strip()
        if not text:
            continue
        tag = str(block.get("tag") or "")
        # Headings earn their tag: they are how a model finds its way around a page.
        # Everything else reads better as plain text than as markup.
        prefix = f"{tag}: " if tag in {"h1", "h2", "h3"} else ""
        lines.append(f"  {prefix}{text}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_summary(url: str, title: str, elements: list[DOMElementNode]) -> str:
    """Render an element list as the compact, LLM-facing summary. Shared by
    capture_dom_snapshot (full list) and dom_pruner.prune_dom_snapshot (pruned list) —
    the pruner regenerates this from its capped elements so pruning actually reduces
    what reaches the prompt, not just an unused side field."""
    lines = [f"Page URL: {url}", f"Page Title: {title}", "Interactive Elements:"]
    for el in elements:
        parts = [f"[{el.ref}]", el.tag]
        if el.role and el.role != el.tag:
            parts.append(f'role="{el.role}"')
        if el.type:
            parts.append(f'type="{el.type}"')
        if el.name:
            parts.append(f'"{el.name}"')
        if el.placeholder and el.placeholder != el.name:
            parts.append(f'placeholder="{el.placeholder}"')
        if el.value:
            parts.append(f'value="{el.value}"')
        if not el.is_enabled:
            parts.append("[disabled]")
        if el.frame_selector:
            # God-level pillar 08: purely informational — the model never
            # needs to route a click through the frame itself, resolve_target
            # already does that from el.frame_selector — but "this field is
            # inside an embedded widget" is useful context (e.g. don't expect
            # it to behave like the surrounding page).
            parts.append(f'[in iframe "{el.frame_selector}"]')
        if el.shadow_host:
            # stage45 doc 04, phase 3: "this control is inside a web component" is
            # real context for the model — such widgets often ignore the surrounding
            # page's conventions, and their inner text is frequently unlabelled.
            parts.append(f'[in shadow DOM of "{el.shadow_host}"]')
        if el.is_occluded:
            # stage45 doc 04, phase 4: dom_pruner drops these before the prompt, so
            # this normally shows only in the full snapshot the escalation and
            # self-heal paths read. It is here so that when one does surface, the
            # reason it is unclickable is stated rather than inferred.
            parts.append("[covered]")
        if not el.frame_selector and el.coordinate_only and not el.shadow_host:
            # stage45 doc 04, phase 2: same informational purpose. Worth saying out
            # loud because it is the one case where a ref is genuinely less capable
            # than usual — see the executor's `select` and `extract` branches, which
            # both need a real Locator and cannot act on one of these.
            parts.append("[in an unnamed iframe]")
        parts.append(f"(center: {el.center.x},{el.center.y})")
        lines.append("  " + " ".join(parts))
    return "\n".join(lines)


def find_element_by_ref(ref: str, snapshot: DOMSnapshot) -> DOMElementNode | None:
    normalized = ref if ref.startswith("@") else f"@{ref}"
    for el in snapshot.elements:
        if el.ref == normalized:
            return el
    return None


_REF_RE = re.compile(r"^@e\d+$", re.IGNORECASE)


def is_ref_tag(target: str) -> bool:
    return bool(_REF_RE.match(target.strip()))
