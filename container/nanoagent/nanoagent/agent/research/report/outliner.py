import json
import logging
from typing import List, Any
from nanoagent.providers.base import LLMProvider
from .types import PaperOutline, OutlineSection
from ..adversarial.types import ResearchFinding, DebateLog
from ..literature.extractor import KnowledgeCard

class OutlineGenerator:
    """
    Takes research findings, literature, and debate outcomes and produces a structured paper outline.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)

    async def generate(
        self, 
        findings: List[ResearchFinding], 
        literature: List[KnowledgeCard], 
        debate_log: DebateLog
    ) -> PaperOutline:
        """
        Generates a structured paper outline from research data.
        """
        prompt = self._build_outline_prompt(findings, literature, debate_log)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.3
        )
        
        try:
            data = json.loads(self._extract_json(response.content))
            sections = [
                OutlineSection(
                    heading=s.get("heading", ""),
                    key_points=s.get("key_points", []),
                    assigned_citations=s.get("assigned_citations", []),
                    word_target=s.get("word_target", 500)
                )
                for s in data.get("sections", [])
            ]
            
            return PaperOutline(
                title=data.get("title", "Research Paper"),
                abstract_draft=data.get("abstract_draft", ""),
                sections=sections
            )
        except Exception as e:
            self.logger.error(f"Failed to parse paper outline: {e}")
            return PaperOutline(title="Error in Outline Generation", abstract_draft=str(e))

    def _get_system_prompt(self) -> str:
        return (
            "You are a professional academic editor specialized in high-impact scientific journals. "
            "Your task is to structure raw research findings, literature knowledge cards, and adversarial debate logs into a cohesive and rigorous paper outline. "
            "The outline must follow standard academic structures (Introduction, Related Work, Methodology, Experiments, Results, Discussion, Conclusion). "
            "Every section must have clear key points, assigned citations, and word count targets. "
            "The 'Results' and 'Discussion' sections must reflect the adversarial debate outcomes (critiques and rebuttals). "
            "Output your response in valid JSON format only."
        )

    def _build_outline_prompt(
        self, 
        findings: List[ResearchFinding], 
        literature: List[KnowledgeCard], 
        debate_log: DebateLog
    ) -> str:
        findings_str = "\n".join([f"- {sf.thesis} (Confidence: {sf.confidence})" for sf in findings])
        literature_str = "\n".join([f"- {c.title}: {c.key_findings}" for c in literature])
        
        return (
            f"Please generate a professional academic paper outline based on the following research data:\n\n"
            f"Core Findings:\n{findings_str}\n\n"
            f"Adversarial Debate Summary:\n"
            f"Verdict: {debate_log.verdict.outcome} (Score: {debate_log.verdict.score})\n"
            f"Key Challenges: {[c.description for c in debate_log.challenges]}\n\n"
            f"Supporting Literature:\n{literature_str}\n\n"
            "Requirements:\n"
            "1. Create a compelling Title and Abstract draft.\n"
            "2. Map specific KnowledgeCard findings to the 'Related Work' section.\n"
            "3. Ensure 'Methodology' and 'Experiments' sections are detailed.\n"
            "4. Incorporate the adversarial critiques directly into the 'Discussion' or 'Results' sections as 'Adversarial Verification'.\n"
            "5. Assign realistic word count targets (Total: 5,000-6,500 words).\n\n"
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"title\": \"string\",\n"
            "  \"abstract_draft\": \"string\",\n"
            "  \"sections\": [\n"
            "    {\n"
            "      \"heading\": \"string\",\n"
            "      \"key_points\": [\"string\"],\n"
            "      \"assigned_citations\": [\"List of paper titles/IDs\"],\n"
            "      \"word_target\": integer\n"
            "    }\n"
            "  ]\n"
            "}"
        )

    def _extract_json(self, text: str) -> str:
        if not text:
            return "{}"
        if "```json" in text:
            return text.split("```json")[1].split("```")[0].strip()
        if "```" in text:
            return text.split("```")[1].split("```")[0].strip()
        return text.strip()
