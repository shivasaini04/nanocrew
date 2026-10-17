import json
import logging
from typing import List, Any
from nanoagent.providers.base import LLMProvider
from .types import PaperDraft, PeerReview, RevisionRequest

class PeerReviewer:
    """
    Simulates a professional peer review process for academic papers.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)

    async def review(self, draft: PaperDraft) -> PeerReview:
        """
        Conducts a technical review of a paper draft.
        """
        self.logger.info(f"Reviewing paper: {draft.title}")
        prompt = self._build_review_prompt(draft)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.2
        )
        
        try:
            data = json.loads(self._extract_json(response.content))
            revision_requests = [
                RevisionRequest(
                    section=r.get("section", "General"),
                    issue=r.get("issue", ""),
                    suggestion=r.get("suggestion", "")
                )
                for r in data.get("revision_requests", [])
            ]
            
            return PeerReview(
                overall_score=data.get("overall_score", 5.0),
                strengths=data.get("strengths", []),
                weaknesses=data.get("weaknesses", []),
                methodology_score=data.get("methodology_score", 5.0),
                evidence_score=data.get("evidence_score", 5.0),
                writing_score=data.get("writing_score", 5.0),
                revision_requests=revision_requests,
                verdict=data.get("verdict", "minor_revision")
            )
        except Exception as e:
            self.logger.error(f"Failed to parse peer review: {e}")
            return PeerReview(
                overall_score=0.0,
                strengths=[],
                weaknesses=[f"Error processing review: {e}"],
                methodology_score=0.0,
                evidence_score=0.0,
                writing_score=0.0,
                verdict="reject"
            )

    def _get_system_prompt(self) -> str:
        return (
            "You are a senior peer reviewer for top-tier academic journals. "
            "Your role is to rigorously evaluate research papers for methodology, evidence consistency, and writing quality. "
            "Provide critical but constructive feedback. Flag unsupported claims or logical inconsistencies. "
            "Output your response in valid JSON format only."
        )

    def _build_review_prompt(self, draft: PaperDraft) -> str:
        full_text = f"Title: {draft.title}\nAbstract: {draft.abstract}\n\n"
        for section in draft.sections:
            full_text += f"## {section.heading}\n{section.content}\n\n"
            
        return (
            f"Please conduct a formal peer review of the following paper draft:\n\n"
            f"{full_text}\n"
            "Review Criteria:\n"
            "- Methodology: Is the approach sound?\n"
            "- Evidence: Do results support the claims?\n"
            "- Writing: Is the prose clear and academic?\n"
            "- Novelty: Does it add value?\n\n"
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"overall_score\": float (1-10),\n"
            "  \"strengths\": [\"string\"],\n"
            "  \"weaknesses\": [\"string\"],\n"
            "  \"methodology_score\": float,\n"
            "  \"evidence_score\": float,\n"
            "  \"writing_score\": float,\n"
            "  \"revision_requests\": [\n"
            "    {\"section\": \"string\", \"issue\": \"string\", \"suggestion\": \"string\"}\n"
            "  ],\n"
            "  \"verdict\": \"accept\" | \"minor_revision\" | \"major_revision\" | \"reject\"\n"
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
