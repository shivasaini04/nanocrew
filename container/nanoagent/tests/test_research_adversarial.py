"""Unit tests for Adversarial Red-Team & Judge Arbitration Engine."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from nanoagent.agent.research.adversarial.challenger import ChallengerAgent
from nanoagent.agent.research.adversarial.champion import ChampionAgent
from nanoagent.agent.research.adversarial.consensus import ConsensusProtocol
from nanoagent.agent.research.adversarial.decision import DecisionEngine
from nanoagent.agent.research.adversarial.judge import JudgeAgent
from nanoagent.agent.research.adversarial.types import (
    ChallengeStatement,
    DefenseStatement,
    EvidenceItem,
    JudgeVerdict,
    ResearchFinding,
)


@pytest.mark.asyncio
async def test_champion_agent_build_defense():
    mock_provider = MagicMock()
    mock_provider.chat = AsyncMock(return_value=MagicMock(content="""{
        "thesis": "FlashAttention reduces memory complexity from quadratic to linear.",
        "methodology": "IO-aware tiling in GPU SRAM.",
        "confidence": 0.95,
        "evidence": [
            {"source": "benchmarks", "description": "3x speedup on A100", "value": "3.2x", "metric": 3.2}
        ]
    }"""))

    finding = ResearchFinding(
        id="f1",
        thesis="FlashAttention reduces memory complexity.",
        confidence=0.9,
    )
    champion = ChampionAgent(mock_provider, "mock-model", finding, [])
    defense = await champion.build_defense()

    assert defense.thesis == "FlashAttention reduces memory complexity from quadratic to linear."
    assert defense.confidence == 0.95
    assert len(defense.evidence) == 1
    assert defense.evidence[0].metric == 3.2


@pytest.mark.asyncio
async def test_challenger_agent_critique():
    mock_provider = MagicMock()
    mock_provider.chat = AsyncMock(return_value=MagicMock(content="""{
        "challenges": [
            {
                "type": "missing_baseline",
                "description": "Lacks comparison with Triton kernel implementation.",
                "severity": "major",
                "counter_evidence": ["arxiv:2205.14135"]
            }
        ]
    }"""))

    finding = ResearchFinding(
        id="f1",
        thesis="FlashAttention reduces memory complexity.",
        confidence=0.9,
    )
    challenger = ChallengerAgent(mock_provider, "mock-model", finding, [])
    defense = DefenseStatement(
        thesis="FlashAttention reduces memory complexity.",
        evidence=[],
        methodology="IO-aware tiling.",
        confidence=0.9,
    )

    challenges = await challenger.generate_challenges(defense)
    assert len(challenges) == 1
    assert challenges[0].type == "missing_baseline"
    assert challenges[0].severity == "major"


@pytest.mark.asyncio
async def test_judge_agent_arbitration():
    mock_provider = MagicMock()
    mock_provider.chat = AsyncMock(return_value=MagicMock(content="""{
        "outcome": "accepted",
        "score": 0.92,
        "reasoning": "Empirical benchmarks strongly substantiate the memory complexity claims.",
        "accepted_challenges": [],
        "revision_requirements": []
    }"""))

    judge = JudgeAgent(mock_provider, "mock-model")
    defense = DefenseStatement(
        thesis="FlashAttention reduces memory complexity.",
        evidence=[EvidenceItem(source="exp", description="Speedup", value="3x", metric=3.0)],
        methodology="GPU tiling",
        confidence=0.9,
    )
    challenges = [
        ChallengeStatement(id="c1", type="baseline", description="Compare with baseline", severity="minor")
    ]

    verdict = await judge.arbitrate(defense, challenges, [])
    assert verdict.outcome == "accepted"
    assert verdict.score == 0.92
    assert "Empirical benchmarks" in verdict.reasoning


@pytest.mark.asyncio
async def test_decision_engine_evaluates_verdict():
    mock_provider = MagicMock()
    mock_provider.chat = AsyncMock(return_value=MagicMock(content="""{
        "action": "proceed",
        "reasoning": "Verdict accepted with high score.",
        "refinement_hints": []
    }"""))

    decision_engine = DecisionEngine(mock_provider, "mock-model")
    verdict = JudgeVerdict(outcome="accepted", score=0.9, reasoning="Strong empirical proof")
    decision = await decision_engine.evaluate(verdict, [])

    assert decision.action == "proceed"
    assert "accepted" in decision.reasoning
