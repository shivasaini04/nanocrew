"""Real bug found live, 2026-08-27, chasing test 0.2 of the manual capability
suite past the idempotency/anti-loop fixes: with genuine retries now happening
(see test_effector_live_run_idempotency_retry.py) AND the anti-loop guard still
correctly firing (see test_effector_phase13_antiloop_guard.py), the click on
demoqa.com's "Forms" homepage card STILL never navigated — proving it wasn't a
retry-blocking problem at all. Isolated the exact same click outside Effector
entirely (a plain `page.locator(".card", has_text="Forms").click()`) and it
worked fine — not the page, not an ad overlay, not Xvfb/DISPLAY.

Root cause, found by dumping the actual @ref → selector Effector derived: the
Forms card's wrapping `<a>` has no id/name/data-testid/class of its own —
`dom_snapshot.py`'s selector-derivation JS fell all the way to the bare tag
name `"a"`, which matches EVERY link on the page (8 of them, live-verified).
`resolve_target`'s @ref layer re-queries that selector fresh at click time and
takes `.first` unconditionally — so every click, regardless of which @ref
number was used, landed on whichever link happened to be first in DOM order
(an empty skip-link), not the one actually meant. It dispatched fine (no
exception — `.first` always exists) and simply never did anything, forever, no
matter how many genuine retries it got. A second, related failure mode
confirmed on the same page: even when a class-based selector DOES exist, it
isn't necessarily unique — demoqa.com's category cards all share className
"card mt-4 top-card", so `div.card` matched all 6.

Fixed by adding an href tier for `<a>` (common, usually unique, more stable
than a shared class) and validating EVERY tier's uniqueness live against the
page instead of stopping at the first one that merely exists, plus a
Playwright-only `:has-text()` qualifier as a final strengthening step when
nothing resolved uniquely — restricted to cases where the accessible name is
guaranteed to be inside the element itself (not a sibling/ancestor climb,
which the react-select gap-closing pass from test_effector_phase10_retry_and_
visibility.py depends on `:has-text()` NOT being applied to).

Live-verified against the real page (not just these source assertions): a
throwaway isolated container running the real `capture_dom_snapshot` →
`resolve_target` → `.click()` path navigated demoqa.com → /forms →
/automation-practice-form correctly with the fix in place, where it silently
went nowhere before.
"""

from __future__ import annotations


def test_selector_derivation_checks_uniqueness_before_settling_on_a_tier():
    """The core bug: the old code stopped at the FIRST tier that merely existed
    (id, then name-attr, then testid, then class) without ever checking whether
    that selector actually matched more than one element on the live page."""
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    # stage45 doc 04, phase 3 (2026-08-29): the check moved from
    # `document.querySelectorAll(candidate).length === 1` to `countAcross(candidate)`,
    # which sums the same query over the document AND every shadow root the walker
    # searched. The guarantee this test exists to protect got stronger, not weaker:
    # Playwright's CSS engine pierces open shadow roots, so a selector unique in the
    # light DOM but repeated inside a component was never really unique at click time
    # — document-only counting could not see that.
    #
    # Behaviourally verified against a real Chromium in
    # test_effector_shadow_dom.py::test_an_id_shared_by_light_and_shadow_makes_the_
    # shadow_one_coordinate_only, which is the evidence these source assertions are
    # only a cheap proxy for.
    assert "countAcross(candidate) === 1" in _SNAPSHOT_JS
    assert "r.querySelectorAll(candidate).length" in _SNAPSHOT_JS
    assert "selectorIsUnique" in _SNAPSHOT_JS


def test_selector_derivation_has_an_href_tier_for_anchors():
    """The specific gap that broke demoqa.com's homepage cards: a wrapping <a>
    with no id/name/testid/class at all fell straight to the bare tag "a" —
    matches every link on the page. href is common, usually unique, and far
    more stable than a shared class."""
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    assert 'a[href="' in _SNAPSHOT_JS
    assert "tag === 'a'" in _SNAPSHOT_JS


def test_selector_derivation_falls_back_to_has_text_when_still_ambiguous():
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    assert ":has-text(" in _SNAPSHOT_JS
    assert "selectorIsUnique" in _SNAPSHOT_JS


def test_has_text_qualifier_is_gated_on_name_being_inside_the_element():
    """Must NOT regress the react-select gap-closing pass (test_effector_phase10_
    retry_and_visibility.py): a name pulled from a SIBLING/ancestor (aria-
    labelledby's target, the nearby-container climb, the ancestor-id last
    resort) isn't inside the element itself, so :has-text(name) on that element
    would never match — each of those three fallback paths must explicitly mark
    the name as NOT safe to use this way."""
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    assert "nameIsWithinElement" in _SNAPSHOT_JS
    # All three external-text fallback paths must flip the flag to false.
    assert _SNAPSHOT_JS.count("nameIsWithinElement = false") == 3
    # The has-text qualifier itself must be gated on the flag.
    assert "nameIsWithinElement) {" in _SNAPSHOT_JS


def test_bare_tag_is_still_the_final_fallback_when_nothing_else_is_available():
    """An element with no id/name/testid/href/class AND no name text at all
    (nothing to disambiguate with) must still get a selector — even an
    imperfect one — not crash the whole snapshot capture over one element."""
    from nanoagent.agent.effector.dom_snapshot import _SNAPSHOT_JS

    assert "let selector = tag;" in _SNAPSHOT_JS
