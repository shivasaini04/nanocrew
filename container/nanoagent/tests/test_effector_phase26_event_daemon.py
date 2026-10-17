"""Unit tests for Phase 26: Proactive Event Daemon."""

import pytest
from pathlib import Path

from nanoagent.agent.effector.proactive.event_daemon import (
    EventDaemon,
    EventMessage,
    EventTrigger,
)


def test_register_and_evaluate_trigger():
    daemon = EventDaemon()
    trigger = EventTrigger(
        trigger_id="trig_stripe_invoice",
        name="Process Stripe Invoice",
        trigger_type="webhook",
        topic_pattern="webhook.stripe.invoice.*",
        goal_template="Review and record Stripe invoice {invoice_id} for customer {customer_id}",
    )
    daemon.register_trigger(trigger)

    assert len(daemon.list_triggers()) == 1

    event = EventMessage(
        event_id="evt_001",
        source="stripe_webhook",
        topic="webhook.stripe.invoice.created",
        payload={"invoice_id": "in_999", "customer_id": "cus_abc"},
    )

    matches = daemon.evaluate_event(event)
    assert len(matches) == 1
    matched_trig, rendered_goal = matches[0]
    assert matched_trig.trigger_id == "trig_stripe_invoice"
    assert rendered_goal == "Review and record Stripe invoice in_999 for customer cus_abc"


def test_disabled_trigger_ignored():
    daemon = EventDaemon()
    trigger = EventTrigger(
        trigger_id="trig_disabled",
        name="Disabled Trigger",
        trigger_type="webhook",
        topic_pattern="*",
        goal_template="Do something",
        enabled=False,
    )
    daemon.register_trigger(trigger)

    event = EventMessage(
        event_id="evt_002",
        source="test",
        topic="any.topic",
    )
    matches = daemon.evaluate_event(event)
    assert len(matches) == 0


def test_daemon_persistence_round_trip(tmp_path: Path):
    daemon = EventDaemon()
    daemon.register_trigger(EventTrigger(
        trigger_id="trig_cron_daily",
        name="Daily Sync",
        trigger_type="cron",
        topic_pattern="cron.daily",
        goal_template="Run daily reports sync",
    ))

    saved_path = daemon.save(tmp_path)
    assert saved_path.exists()

    loaded = EventDaemon.load(tmp_path)
    triggers = loaded.list_triggers()
    assert len(triggers) == 1
    assert triggers[0].trigger_id == "trig_cron_daily"
