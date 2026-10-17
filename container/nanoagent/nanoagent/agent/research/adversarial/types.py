from dataclasses import dataclass, field
from typing import List, Optional
from ..runner import ExperimentResult

@dataclass
class EvidenceItem:
    source: str  # e.g., "experiment_3", "arxiv:1234.5678"
    description: str
    value: str
    metric: Optional[float] = None

@dataclass
class ResearchFinding:
    id: str
    thesis: str
    confidence: float
    supporting_results: List[ExperimentResult] = field(default_factory=list)

@dataclass
class DefenseStatement:
    thesis: str
    evidence: List[EvidenceItem]
    methodology: str
    confidence: float

@dataclass
class ChallengeStatement:
    id: str
    type: str  # "logical_flaw", "missing_evidence", "conflicting_literature", "hallucination_risk"
    description: str
    severity: str  # "critical", "major", "minor"
    counter_evidence: List[str] = field(default_factory=list)

@dataclass
class RebuttalStatement:
    finding_id: str
    challenge_id: str
    argument: str
    new_evidence: List[EvidenceItem] = field(default_factory=list)

@dataclass
class ChallengeVerdict:
    challenge_id: str
    is_addressed: bool
    reasoning: str

@dataclass
class JudgeVerdict:
    outcome: str  # "accepted" | "rejected" | "needs_revision"
    score: float
    reasoning: str
    accepted_challenges: List[str] = field(default_factory=list)
    revision_requirements: List[str] = field(default_factory=list)

@dataclass
class ResearchDecision:
    action: str  # "proceed" | "refine" | "pivot"
    reasoning: str
    refinement_hints: List[str] = field(default_factory=list)
    pivot_direction: Optional[str] = None

@dataclass
class DebateLog:
    defense: DefenseStatement
    challenges: List[ChallengeStatement]
    rebuttals: List[RebuttalStatement]
    verdict: JudgeVerdict

@dataclass
class ConsensusResult:
    finding: ResearchFinding
    debate: DebateLog
    decision: ResearchDecision

@dataclass
class HumanVerdict:
    approved: bool
    comments: Optional[str] = None
