"""Live finding, 2026-08-24: `effector` (and its sibling entry points) were never
added to ToolResultCache's NEVER_CACHE set. Calling effector twice with identical
args — a normal retry pattern, e.g. "try the same goal again after fixing an
environment issue" — silently replayed the FIRST call's cached result instead of
launching a new browser. Traced live via cycle_steps: two separate `effector`
tool_call entries returned a byte-identical Playwright error (same PID, same
microsecond timestamp) — an Xvfb-crash failure got "stuck" and replayed for the
cache's 120s TTL even after the underlying issue was already fixed on a later call.

No prior test file existed for tool_cache.py at all before this fix.
"""

from __future__ import annotations

from nanoagent.agent.tool_cache import NEVER_CACHE, ToolResultCache


def test_effector_and_its_siblings_are_in_never_cache():
    for tool in ("effector", "effector_workflow", "effector_swarm", "learn_from_recording"):
        assert tool in NEVER_CACHE, f"{tool} must never be cached — it drives a real, stateful browser session"


def test_two_identical_effector_calls_never_hit_the_cache():
    """The exact live bug shape: same goal/url/max_turns, called twice."""
    cache = ToolResultCache()
    args = {"goal": "go to https://demoqa.com and click Forms", "url": "https://demoqa.com", "max_turns": 12}

    assert cache.get("effector", args) is None  # miss — nothing cached yet
    cache.set("effector", args, '{"error": "some transient failure"}')

    # A second call with IDENTICAL args must still miss — effector is never cached,
    # so this always re-executes rather than replaying the first call's result.
    assert cache.get("effector", args) is None


def test_a_failed_effector_result_is_never_replayed_as_a_stale_success():
    """Direct regression guard for the actual failure mode: a call that failed for
    an environmental reason (Xvfb down) must not poison a later call made after the
    environment recovered."""
    cache = ToolResultCache()
    args = {"goal": "extract form fields", "url": "https://demoqa.com/automation-practice-form"}

    cache.set("effector", args, '{"success": false, "error": "no XServer running"}')
    # Even though .set() was called, .get() must never return it for effector.
    assert cache.get("effector", args) is None
    assert cache.size == 0  # set() was a no-op — nothing was ever actually stored


def test_browser_tool_and_exec_remain_uncached_unaffected_by_this_change():
    """Regression guard: adding effector must not accidentally remove or shadow
    the pre-existing NEVER_CACHE entries this fix didn't touch."""
    for tool in ("browser", "exec", "python_repl", "write_file", "spawn"):
        assert tool in NEVER_CACHE


def test_a_genuinely_cacheable_tool_still_caches_normally():
    """Regression guard: this fix must not have broken caching for tools that
    SHOULD be cached (read-only, deterministic within a run)."""
    cache = ToolResultCache()
    args = {"query": "some search"}

    assert cache.get("web_search", args) is None
    cache.set("web_search", args, '{"results": ["a", "b"]}')

    assert cache.get("web_search", args) == '{"results": ["a", "b"]}'
    assert cache.hits == 1
    assert cache.misses == 1
