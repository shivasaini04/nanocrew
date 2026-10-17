import logging
import json
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional
from .arxiv import PaperMetadata

@dataclass
class KnowledgeCard:
    paper_id: str
    title: str
    key_findings: List[str]
    methodology: str
    limitations: List[str]
    relevance_to_goal: float
    potential_applications: List[str]

@dataclass
class SynthesisReport:
    summary: str
    common_themes: List[str]
    conflicting_results: List[str]
    identified_gaps: List[str]

class KnowledgeExtractor:
    """
    Analyzes paper metadata and abstracts to extract structured knowledge
    and synthesize research findings using an LLM.
    """
    def __init__(self, subagent_manager: Any):
        self.subagent_manager = subagent_manager
        self.logger = logging.getLogger(__name__)

    async def extract(self, paper: PaperMetadata, goal: str) -> KnowledgeCard:
        """
        Uses an LLM to analyze a paper's abstract and extract structured metadata.
        """
        self.logger.info(f"Extracting knowledge from paper: {paper.title}")
        
        # Placeholder for LLM extraction logic:
        # prompt = f"Analyze this abstract for research goal '{goal}': {paper.abstract}"
        # response = await self.subagent_manager.call_llm_json(prompt)
        
        # Default mock extraction if LLM is not used in this step
        return KnowledgeCard(
            paper_id=paper.arxiv_id or getattr(paper, 's2_id', 'unknown'),
            title=paper.title,
            key_findings=["Finding 1 from abstract", "Finding 2 from abstract"],
            methodology="Quantitative/Qualitative methodology mentioned",
            limitations=["Limitation 1", "Limitation 2"],
            relevance_to_goal=0.8,
            potential_applications=["App 1", "App 2"]
        )

    async def synthesize(self, cards: List[KnowledgeCard], goal: str) -> SynthesisReport:
        """
        Synthesizes a collection of KnowledgeCards into a unified research report.
        """
        self.logger.info(f"Synthesizing {len(cards)} knowledge cards into a report.")
        
        # Placeholder for LLM synthesis logic:
        # prompt = f"Synthesize these findings for goal '{goal}': {[asdict(c) for c in cards]}"
        # response = await self.subagent_manager.call_llm_json(prompt)
        
        return SynthesisReport(
            summary="This is a synthesized summary of current literature.",
            common_themes=["Theme A", "Theme B"],
            conflicting_results=["Conflict 1"],
            identified_gaps=["Gap 1", "Gap 2"]
        )

    def to_ki_markdown(self, card: KnowledgeCard) -> str:
        """
        Converts a KnowledgeCard into a formatted markdown string for KI storage.
        """
        md = f"# Knowledge Item: {card.title}\n\n"
        md += f"**Paper ID**: {card.paper_id}\n\n"
        md += "## Key Findings\n"
        for f in card.key_findings:
            md += f"- {f}\n"
        md += f"\n## Methodology\n{card.methodology}\n\n"
        md += "## Limitations\n"
        for l in card.limitations:
            md += f"- {l}\n"
        md += f"\n## Relevance to Goal: {card.relevance_to_goal}\n\n"
        md += "## Potential Applications\n"
        for a in card.potential_applications:
            md += f"- {a}\n"
        return md
