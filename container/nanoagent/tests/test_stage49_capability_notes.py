"""A lane's trade-offs must reach the caller, without reading as a fault.

The first live run on the native stealth engine a live cycle, 2026-09-03) reported:

    "isolated_worlds": false, "lifecycle_interception": false, "degradations": []

Both facts were true and neither was explained. The one that matters is not obvious
from a boolean: with no CDP there is no isolated world, so DOM introspection runs in the
page's own world and a hostile page can watch the agent read it. That is a real price for
native fingerprint masking and worth paying deliberately.

Recording it in `degradations` would have been wrong in the other direction — every
native-engine run would read as faulted, and a permanent warning is how everyone learns
to ignore warnings. That is this module's own docstring talking. So notes are a separate
channel: reported, not alarming.
"""

from __future__ import annotations

from nanoagent.agent.effector.capability_manifest import CapabilityManifest


def test_a_note_reaches_the_caller_rather_than_only_a_log():
    """The rule the manifest exists to enforce: it must be in the payload."""
    m = CapabilityManifest()
    m.note("no CDP on this engine (Gecko)")

    assert m.notes == ["no CDP on this engine (Gecko)"]
    assert m.to_dict()["notes"] == ["no CDP on this engine (Gecko)"]


def test_a_note_is_not_a_degradation():
    """The distinction the whole design turns on. A lane that structurally lacks a
    capability has not failed at anything."""
    m = CapabilityManifest()
    m.note("no CDP lifecycle interception on this engine")

    assert m.degradations == []
    assert m.degraded is False


def test_a_real_degradation_still_registers():
    """And the other half — notes must not have diluted the fault channel."""
    m = CapabilityManifest()
    m.note("no CDP on this engine (Gecko)")
    m.degrade("native engine requested but the binary is missing", requested=True)

    assert m.degraded is True
    assert len(m.degradations) == 1
    assert len(m.notes) == 1


def test_an_unrequested_capability_stays_quiet_in_both_channels():
    """"Off because nobody asked" was already handled and must stay handled: it is
    neither a fault nor a trade-off of the lane."""
    m = CapabilityManifest()
    m.degrade("native engine not requested", requested=False)

    assert m.degradations == []
    assert m.notes == []


def test_a_fresh_manifest_claims_nothing():
    m = CapabilityManifest()
    assert m.notes == [] and m.degradations == [] and m.degraded is False


def test_the_summary_line_mentions_notes_without_calling_them_degradations(caplog):
    """An operator skimming logs should be able to tell the two apart at a glance."""
    import logging

    from loguru import logger

    records: list[str] = []
    sink_id = logger.add(lambda msg: records.append(str(msg)), level="INFO")
    try:
        m = CapabilityManifest()
        m.engine = "camoufox-native"
        m.note("no CDP on this engine (Gecko)")
        m.log_summary()
    finally:
        logger.remove(sink_id)

    summary = [r for r in records if "effector capabilities:" in r]
    assert summary, "the summary line should have been logged"
    assert "notes=1" in summary[0]
    assert "degraded=" not in summary[0], "a trade-off must not print as a degradation"
