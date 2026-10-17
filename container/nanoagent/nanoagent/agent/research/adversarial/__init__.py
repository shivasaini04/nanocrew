"""Adversarial Red-Team & Judge Arbitration subpackage for Research."""

from .challenger import ChallengerAgent
from .champion import ChampionAgent
from .consensus import ConsensusProtocol
from .decision import DecisionEngine
from .judge import JudgeAgent
from .types import (
    ChallengeStatement,
    ChallengeVerdict,
    ConsensusResult,
    DebateLog,
    DefenseStatement,
    EvidenceItem,
    HumanVerdict,
    JudgeVerdict,
    RebuttalStatement,
    ResearchDecision,
    ResearchFinding,
)

__all__ = [
    "ChampionAgent",
    "ChallengerAgent",
    "JudgeAgent",
    "ConsensusProtocol",
    "DecisionEngine",
    "EvidenceItem",
    "ResearchFinding",
    "DefenseStatement",
    "ChallengeStatement",
    "RebuttalStatement",
    "ChallengeVerdict",
    "JudgeVerdict",
    "ResearchDecision",
    "DebateLog",
    "ConsensusResult",
    "HumanVerdict",
]
