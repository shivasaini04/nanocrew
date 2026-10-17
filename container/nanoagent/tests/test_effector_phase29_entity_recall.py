"""Phase 29: the epistemic knowledge graph, connected to actual runs.

Phase 25 shipped the graph as storage with unit tests that built entities by hand.
Nothing in the loop ever wrote to it or read from it, so no run ever produced an entity
and no run ever benefited from one — a working data structure with no data.

The join these tests pin is the whole reason the graph exists: run 1 reads something
about an email address on one site, run 2 on a DIFFERENT site names that address in its
goal, and starts already knowing.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.memory.epistemic_graph import (
    EpistemicKnowledgeGraph,
    find_identifiers,
    recall_for_goal,
    record_extraction,
)
from nanoagent.agent.tools.effector import EffectorTool
from test_effector_phase0 import FakeSession, ScriptedProvider


class _RecordingProvider(ScriptedProvider):
    """Keeps the first user prompt it was handed, so a test can assert on what the
    model was actually told rather than on what was merely stored."""

    def __init__(self, script):
        super().__init__(script)
        self.first_prompt = ""

    async def chat(self, messages, **kw):
        if not self.first_prompt:
            content = messages[-1]["content"]
            self.first_prompt = content if isinstance(content, str) else json.dumps(content)
        return await super().chat(messages, **kw)


def _tool(workspace: Path, provider) -> EffectorTool:
    return EffectorTool(
        workspace=workspace, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        use_human_cadence=False, require_approval=False,
    )


def test_identifiers_are_the_ones_that_actually_join_systems():
    found = find_identifiers("contact ada@example.com about cus_9x8y7z6w and PROJ-412")
    assert found == ["ada@example.com", "cus_9x8y7z6w", "proj-412"]

    # Prices, counts and ordinary prose must not become entities — a graph full of
    # "1500" and "pricing" is worse than an empty one, because lookups start hitting.
    assert find_identifiers("the plan costs 1500 per seat across 30 teams") == []


def test_two_runs_on_different_sites_merge_into_one_entity(tmp_path: Path):
    """The cross-application join, at the storage layer."""
    record_extraction(tmp_path, "stripe.com", "look up the customer", {
        "email": "ada@example.com", "plan": "Scale", "mrr": "$400",
    })
    record_extraction(tmp_path, "salesforce.com", "look up the account", {
        "email": "ada@example.com", "account_owner": "Marie",
    })

    graph = EpistemicKnowledgeGraph.load(tmp_path)
    entity = graph.get_entity("ada@example.com")

    assert entity is not None
    # Both runs' facts survive — the second did not overwrite the first.
    assert entity.attributes["plan"] == "Scale"
    assert entity.attributes["account_owner"] == "Marie"
    assert set(entity.cross_system_ids) == {"stripe.com", "salesforce.com"}


def test_recall_only_fires_for_identifiers_the_goal_actually_names(tmp_path: Path):
    record_extraction(tmp_path, "stripe.com", "look up the customer", {
        "email": "ada@example.com", "plan": "Scale",
    })

    assert recall_for_goal(tmp_path, "Find the invoice for ada@example.com")
    assert recall_for_goal(tmp_path, "Find the invoice for grace@example.com") == []
    assert recall_for_goal(tmp_path, "Find the pricing page") == []


@pytest.mark.asyncio
async def test_a_run_files_what_it_extracted_and_the_next_run_is_told(tmp_path: Path):
    """End to end through the real tool: extract on run 1, recalled into the prompt on
    run 2. Asserting on the prompt text is the point — a graph that stores perfectly
    but never reaches the model changes nothing about what the agent can do."""
    first = ScriptedProvider([
        {"thought": "read the record", "action": "type", "target": "@e1", "text": "search"},
        {"thought": "found it", "action": "done",
         "extractedData": {"email": "ada@example.com", "plan": "Scale", "seats": "12"}},
    ])
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        result = json.loads(await _tool(tmp_path, first).execute(goal="Look up the customer record"))
    assert result["success"] is True, result

    second = _RecordingProvider([{"thought": "already know this", "action": "done"}])
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        await _tool(tmp_path, second).execute(goal="Renew the subscription for ada@example.com")

    prompt = second.first_prompt
    assert "ada@example.com" in prompt
    assert "Scale" in prompt, f"what run 1 learned never reached run 2's prompt:\n{prompt}"
