"""Epistemic Business Knowledge Graph for Effector.

Persists cross-application entity relationships, unique identifiers, and business
state across independent browsing tasks (e.g. mapping Stripe customers to Salesforce
accounts, Jira tickets to GitHub PRs, user emails to company org charts).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class BusinessEntity:
    entity_id: str
    entity_type: str  # "user" | "organization" | "invoice" | "ticket" | "subscription" | "product"
    name: str
    attributes: dict[str, Any] = field(default_factory=dict)
    cross_system_ids: dict[str, str] = field(default_factory=dict)
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BusinessEntity":
        return cls(
            entity_id=data["entity_id"],
            entity_type=data["entity_type"],
            name=data["name"],
            attributes=data.get("attributes", {}),
            cross_system_ids=data.get("cross_system_ids", {}),
            updated_at=data.get("updated_at", ""),
        )


@dataclass
class EntityRelationship:
    source_id: str
    target_id: str
    relation_type: str  # "belongs_to" | "billed_to" | "assigned_to" | "created_by" | "depends_on"
    properties: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EntityRelationship":
        return cls(
            source_id=data["source_id"],
            target_id=data["target_id"],
            relation_type=data["relation_type"],
            properties=data.get("properties", {}),
            created_at=data.get("created_at", ""),
        )


class EpistemicKnowledgeGraph:
    """In-memory and persisted business entity knowledge graph."""

    def __init__(self):
        self._entities: dict[str, BusinessEntity] = {}
        self._relationships: list[EntityRelationship] = []
        self._system_id_index: dict[tuple[str, str], str] = {}

    def upsert_entity(self, entity: BusinessEntity) -> BusinessEntity:
        """Insert or update a business entity and update indexing."""
        entity.updated_at = datetime.now(timezone.utc).isoformat()
        self._entities[entity.entity_id] = entity

        for sys_name, sys_val in entity.cross_system_ids.items():
            self._system_id_index[(sys_name.lower(), str(sys_val).lower())] = entity.entity_id

        return entity

    def merge_entity(self, entity: BusinessEntity) -> BusinessEntity:
        """Upsert, but folding into whatever is already known about `entity_id` instead
        of replacing it. This is what makes the graph a join rather than a log: the run
        that read a customer's plan on Stripe and the run that read their account owner
        on Salesforce contribute different attributes to the SAME entity, keyed on the
        email both pages showed. `upsert_entity` deliberately keeps its replace
        semantics — a caller that has the full, authoritative record still wants it to
        win outright."""
        existing = self._entities.get(entity.entity_id)
        if existing is None:
            return self.upsert_entity(entity)

        merged = BusinessEntity(
            entity_id=existing.entity_id,
            entity_type=entity.entity_type or existing.entity_type,
            name=entity.name or existing.name,
            attributes={**existing.attributes, **entity.attributes},
            cross_system_ids={**existing.cross_system_ids, **entity.cross_system_ids},
        )
        return self.upsert_entity(merged)

    def get_entity(self, entity_id: str) -> BusinessEntity | None:
        """Retrieve an entity by primary ID."""
        return self._entities.get(entity_id)

    def find_by_system_id(self, system_name: str, system_id: str) -> BusinessEntity | None:
        """Lookup an entity by third-party system ID (e.g. system='stripe', system_id='cus_123')."""
        key = (system_name.lower(), str(system_id).lower())
        entity_id = self._system_id_index.get(key)
        if entity_id:
            return self._entities.get(entity_id)
        return None

    def query_entities(self, entity_type: str | None = None, **attribute_filters) -> list[BusinessEntity]:
        """Query entities by entity_type and exact attribute matches."""
        results = []
        for e in self._entities.values():
            if entity_type and e.entity_type != entity_type:
                continue
            matched = True
            for k, v in attribute_filters.items():
                if e.attributes.get(k) != v:
                    matched = False
                    break
            if matched:
                results.append(e)
        return results

    def link_entities(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        properties: dict[str, Any] | None = None,
    ) -> EntityRelationship:
        """Create a directional relationship between two entities."""
        rel = EntityRelationship(
            source_id=source_id,
            target_id=target_id,
            relation_type=relation_type,
            properties=properties or {},
        )
        self._relationships.append(rel)
        return rel

    def get_related_entities(
        self,
        entity_id: str,
        relation_type: str | None = None,
        direction: str = "outgoing",
    ) -> list[tuple[EntityRelationship, BusinessEntity]]:
        """Find related entities connected to entity_id."""
        results = []
        for r in self._relationships:
            if relation_type and r.relation_type != relation_type:
                continue

            if direction == "outgoing" and r.source_id == entity_id:
                target = self._entities.get(r.target_id)
                if target:
                    results.append((r, target))
            elif direction == "incoming" and r.target_id == entity_id:
                source = self._entities.get(r.source_id)
                if source:
                    results.append((r, source))
        return results

    def save(self, workspace: Path) -> Path:
        """Persist the knowledge graph to workspace `.effector/knowledge_graph/graph.json`."""
        d = Path(workspace) / ".effector" / "knowledge_graph"
        d.mkdir(parents=True, exist_ok=True)
        out_path = d / "graph.json"
        data = {
            "entities": [e.to_dict() for e in self._entities.values()],
            "relationships": [r.to_dict() for r in self._relationships],
        }
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return out_path

    @classmethod
    def load(cls, workspace: Path) -> "EpistemicKnowledgeGraph":
        """Load the knowledge graph from disk."""
        graph = cls()
        in_path = Path(workspace) / ".effector" / "knowledge_graph" / "graph.json"
        if not in_path.exists():
            return graph

        try:
            data = json.loads(in_path.read_text(encoding="utf-8"))
            for e_data in data.get("entities", []):
                graph.upsert_entity(BusinessEntity.from_dict(e_data))
            for r_data in data.get("relationships", []):
                graph._relationships.append(EntityRelationship.from_dict(r_data))
        except Exception:
            pass

        return graph


# ─── Connecting the graph to actual runs ───────────────────────────────────────
#
# The class above is storage. These two functions are what react_loop calls, and
# without them the graph was an unreachable module with passing unit tests — real
# storage that nothing ever wrote to or read from.

# An email address is the identifier that actually joins business systems: the same
# person is `cus_123` in Stripe, a numeric id in Salesforce, and an @-address in both.
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
# Prefixed opaque ids — Stripe's `cus_`/`in_`, Jira's `PROJ-123`, and the same shape
# most systems use. Deliberately narrow: matching bare numbers or long words would fill
# the graph with prices, quantities and page titles pretending to be identities.
_OPAQUE_ID_RE = re.compile(r"\b(?:[a-z]{2,12}_[A-Za-z0-9]{6,}|[A-Z]{2,10}-\d{1,7})\b")

# Per-run cap. One page of search results can carry hundreds of addresses, and a graph
# that grows without bound stops being a useful lookup and starts being a liability.
_MAX_IDENTIFIERS_PER_RUN = 12


def find_identifiers(text: str) -> list[str]:
    """Identifier-shaped strings in `text`, deduplicated, order preserved."""
    found: list[str] = []
    for match in _EMAIL_RE.findall(text) + _OPAQUE_ID_RE.findall(text):
        value = match.strip().lower()
        if value and value not in found:
            found.append(value)
    return found


def record_extraction(
    workspace: Path, domain: str, goal: str, extracted: dict[str, Any] | None,
) -> int:
    """Fold one run's extracted data into the graph, keyed on any identifiers it
    contains. Returns how many entities were touched.

    Every identifier in the payload gets the WHOLE payload as attributes rather than a
    guess at which field belongs to which id — the data came off one page about one
    thing, and being able to look that thing up by any of its identifiers is the point.
    """
    if not extracted:
        return 0

    payload = json.dumps(extracted, ensure_ascii=False, default=str)
    identifiers = find_identifiers(payload)[:_MAX_IDENTIFIERS_PER_RUN]
    if not identifiers:
        return 0

    graph = EpistemicKnowledgeGraph.load(workspace)
    for identifier in identifiers:
        graph.merge_entity(BusinessEntity(
            entity_id=identifier,
            entity_type="email" if "@" in identifier else "record",
            name=identifier,
            attributes={k: v for k, v in extracted.items() if v not in (None, "")},
            # Which site this was seen on, so a later run can say where it learned it.
            cross_system_ids={domain: identifier},
        ))
    graph.save(workspace)
    return len(identifiers)


def recall_for_goal(workspace: Path, goal: str) -> list[str]:
    """Prompt-ready notes about identifiers named in `goal` that the graph already
    knows. Empty when the goal names nothing recognised — which is the common case, and
    costs one file read.

    This is the payoff for recording: a run told to "find the plan for
    ada@example.com" starts already knowing what a previous run on a different site
    read about that address, instead of rediscovering it.
    """
    identifiers = find_identifiers(goal)
    if not identifiers:
        return []

    graph = EpistemicKnowledgeGraph.load(workspace)
    notes: list[str] = []
    for identifier in identifiers:
        entity = graph.get_entity(identifier)
        if entity is None or not entity.attributes:
            continue
        seen_on = ", ".join(entity.cross_system_ids.keys()) or "a previous run"
        facts = ", ".join(f"{k}={v}" for k, v in list(entity.attributes.items())[:8])
        notes.append(f"{identifier} (seen on {seen_on}): {facts}")
    return notes
