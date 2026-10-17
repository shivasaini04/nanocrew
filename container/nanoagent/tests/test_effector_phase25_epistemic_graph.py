"""Unit tests for Phase 25: Epistemic Knowledge Graph & Cross-Application Memory."""

import pytest
from pathlib import Path

from nanoagent.agent.effector.memory.epistemic_graph import (
    BusinessEntity,
    EntityRelationship,
    EpistemicKnowledgeGraph,
)


def test_upsert_and_find_by_cross_system_id():
    graph = EpistemicKnowledgeGraph()
    user = BusinessEntity(
        entity_id="usr_001",
        entity_type="user",
        name="John Doe",
        attributes={"email": "john@acme.com", "role": "admin"},
        cross_system_ids={
            "salesforce": "0015000000XYZ",
            "stripe": "cus_123456",
            "hubspot": "contact_987",
        },
    )

    graph.upsert_entity(user)

    # Primary lookup
    assert graph.get_entity("usr_001") == user

    # Cross-system lookups
    sf_match = graph.find_by_system_id("salesforce", "0015000000XYZ")
    assert sf_match is not None
    assert sf_match.entity_id == "usr_001"

    stripe_match = graph.find_by_system_id("stripe", "cus_123456")
    assert stripe_match is not None
    assert stripe_match.name == "John Doe"

    missing = graph.find_by_system_id("stripe", "non_existent")
    assert missing is None


def test_entity_relationships_and_queries():
    graph = EpistemicKnowledgeGraph()
    org = BusinessEntity(
        entity_id="org_acme",
        entity_type="organization",
        name="Acme Corp",
        attributes={"tier": "enterprise"},
    )
    user = BusinessEntity(
        entity_id="usr_john",
        entity_type="user",
        name="John",
        attributes={"role": "admin"},
    )

    graph.upsert_entity(org)
    graph.upsert_entity(user)

    graph.link_entities(
        source_id="usr_john",
        target_id="org_acme",
        relation_type="belongs_to",
        properties={"since": "2024"},
    )

    related = graph.get_related_entities("usr_john", relation_type="belongs_to")
    assert len(related) == 1
    rel, target = related[0]
    assert rel.relation_type == "belongs_to"
    assert target.name == "Acme Corp"


def test_knowledge_graph_save_and_load(tmp_path: Path):
    graph = EpistemicKnowledgeGraph()
    graph.upsert_entity(BusinessEntity(
        entity_id="inv_99",
        entity_type="invoice",
        name="Invoice #99",
        attributes={"amount": 5000},
        cross_system_ids={"quickbooks": "qb_inv_99"},
    ))

    saved_path = graph.save(tmp_path)
    assert saved_path.exists()

    loaded = EpistemicKnowledgeGraph.load(tmp_path)
    inv = loaded.find_by_system_id("quickbooks", "qb_inv_99")
    assert inv is not None
    assert inv.name == "Invoice #99"
    assert inv.attributes["amount"] == 5000
