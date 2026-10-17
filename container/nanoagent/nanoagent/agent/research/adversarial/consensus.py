import logging
from typing import List, Optional, Any
from nanoagent.providers.base import LLMProvider
from .types import (
    ResearchFinding, 
    DefenseStatement, 
    ChallengeStatement, 
    RebuttalStatement, 
    JudgeVerdict, 
    ResearchDecision,
    DebateLog,
    ConsensusResult,
    HumanVerdict
)
from .champion import ChampionAgent
from .challenger import ChallengerAgent
from .judge import JudgeAgent
from .decision import DecisionEngine
from ..runner import ExperimentResult
from ..literature.extractor import KnowledgeCard

class ConsensusProtocol:
    """
    Orchestrates the full adversarial debate and decision loop.
    """
    def __init__(self, provider: LLMProvider, model_map: dict[str, str]):
        self.provider = provider
        # model_map can specify different models for different agents
        # e.g., {"champion": "gpt-4", "challenger": "claude-3", "judge": "gpt-4o"}
        self.model_map = model_map
        self.logger = logging.getLogger(__name__)
        self.decision_engine = DecisionEngine(provider, model_map.get("decision", "default"))

    async def run_debate(
        self, 
        finding: ResearchFinding, 
        evidence: List[ExperimentResult], 
        literature: List[KnowledgeCard]
    ) -> ConsensusResult:
        """
        Runs the full Champion-Challenger-Judge cycle.
        """
        self.logger.info(f"Starting adversarial debate for finding: {finding.thesis}")

        # 1. Champion builds defense
        champion = ChampionAgent(
            self.provider, 
            self.model_map.get("champion", "default"), 
            finding, 
            evidence
        )
        defense = await champion.build_defense()

        # 2. Challenger generates challenges
        challenger = ChallengerAgent(
            self.provider, 
            self.model_map.get("challenger", "default"), 
            finding, 
            literature
        )
        challenges = await challenger.generate_challenges(defense)

        # 3. Champion rebutts each challenge
        rebuttals = []
        for challenge in challenges:
            rebuttal = await champion.respond_to_challenge(challenge)
            rebuttals.append(rebuttal)

        # 4. Judge arbitrates
        judge = JudgeAgent(
            self.provider, 
            self.model_map.get("judge", "default")
        )
        verdict = await judge.arbitrate(defense, challenges, rebuttals)

        # 5. Decision Engine evaluates next steps
        decision = await self.decision_engine.evaluate(verdict, evidence)

        # 6. Build final result
        debate_log = DebateLog(
            defense=defense,
            challenges=challenges,
            rebuttals=rebuttals,
            verdict=verdict
        )

        return ConsensusResult(
            finding=finding,
            debate=debate_log,
            decision=decision
        )

    async def request_human_review(
        self, 
        finding: ResearchFinding, 
        debate: DebateLog
    ) -> HumanVerdict:
        """
        Pauses the loop and requests human intervention.
        In this implementation, it's a placeholder for Bus notification.
        """
        self.logger.warning(f"HUMAN_GATE_TRIGGERED for finding: {finding.thesis}")
        # Integration with nanoagent bus would go here
        return HumanVerdict(approved=True, comments="Auto-approved by protocol placeholder.")
