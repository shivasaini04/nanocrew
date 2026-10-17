"""Autonomous Research Engine subpackage for nanoagent.

Features:
- Multi-Source Literature Discovery & Anti-Hallucination Citation Verification Gate
- Karpathy-Style Empirical Experiment Loop with Pareto-Frontier Optimization
- Adversarial Red-Team (Champion vs Challenger) & Binding Judge Arbitration
- Academic Paper, Technical Memo & Publication Drafting (Markdown, LaTeX)
- Knowledge Item (KI) Memory Distillation
"""

from .adversarial import (
    ChallengerAgent,
    ChallengeStatement,
    ChallengeVerdict,
    ChampionAgent,
    ConsensusProtocol,
    DebateLog,
    DecisionEngine,
    DefenseStatement,
    EvidenceItem,
    HumanVerdict,
    JudgeAgent,
    JudgeVerdict,
    RebuttalStatement,
    ResearchDecision,
    ResearchFinding,
)
from .base import ResearchConfig, ResearchState, ResearchStatus
from .budget import TokenBudget, TokenBudgetManager, TokenUsage
from .distillation import KIDistiller
from .evaluator import EvalDecision, ResultEvaluator
from .evolution import EvolutionEngine
from .literature import (
    ArxivClient,
    CitationVerificationResult,
    CitationVerifier,
    KnowledgeCard,
    KnowledgeExtractor,
    LiteratureCache,
    PaperMetadata,
    SearchStrategy,
    SemanticScholarClient,
    SynthesisReport,
    VerificationResult,
    filter_hallucinated_citations,
    verify_citation,
)
from .orchestrator import ResearchOrchestrator
from .program import ProgramState, append_to_results_tsv
from .report import (
    DraftReviser,
    DraftSection,
    ExportPipeline,
    OutlineSection,
    PaperDraft,
    PaperOutline,
    PaperOutliner,
    PeerReview,
    PeerReviewer,
    RevisionRequest,
    SectionDrafter,
)
from .runner import ExperimentResult, ExperimentRunner
from .tool_bridge import ResearchToolBridge

__all__ = [
    "ResearchConfig",
    "ResearchState",
    "ResearchStatus",
    "ExperimentRunner",
    "ExperimentResult",
    "ResultEvaluator",
    "EvalDecision",
    "ProgramState",
    "append_to_results_tsv",
    "KIDistiller",
    "ResearchOrchestrator",
    "EvolutionEngine",
    "TokenBudget",
    "TokenBudgetManager",
    "TokenUsage",
    "ResearchToolBridge",
    "ArxivClient",
    "PaperMetadata",
    "SemanticScholarClient",
    "SearchStrategy",
    "KnowledgeExtractor",
    "KnowledgeCard",
    "SynthesisReport",
    "CitationVerifier",
    "VerificationResult",
    "LiteratureCache",
    "CitationVerificationResult",
    "verify_citation",
    "filter_hallucinated_citations",
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
    "HumanVerdict",
    "SectionDrafter",
    "ExportPipeline",
    "PaperOutliner",
    "PeerReviewer",
    "DraftReviser",
    "DraftSection",
    "OutlineSection",
    "PaperDraft",
    "PaperOutline",
    "PeerReview",
    "RevisionRequest",
]
