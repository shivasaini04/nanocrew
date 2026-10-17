import json
import logging
from typing import List, Any
from nanoagent.providers.base import LLMProvider
from .types import ResearchFinding, DefenseStatement, RebuttalStatement, ChallengeStatement, EvidenceItem
from ..runner import ExperimentResult

class ChampionAgent:
    """
    A subagent persona dedicated to defending a research finding with evidence and logical reasoning.
    """
    def __init__(self, provider: LLMProvider, model: str, finding: ResearchFinding, evidence: List[ExperimentResult]):
        self.provider = provider
        self.model = model
        self.finding = finding
        self.evidence = evidence
        self.logger = logging.getLogger(__name__)

    async def build_defense(self) -> DefenseStatement:
        """
        Builds a structured defense for the research finding.
        """
        prompt = self._build_defense_prompt()
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.3 # Lower temperature for more rigorous defense
        )
        
        try:
            # Expecting JSON response
            data = json.loads(self._extract_json(response.content))
            return DefenseStatement(
                thesis=data.get("thesis", self.finding.thesis),
                evidence=[EvidenceItem(**item) for item in data.get("evidence", [])],
                methodology=data.get("methodology", "Unknown"),
                confidence=data.get("confidence", 0.0)
            )
        except Exception as e:
            self.logger.error(f"Failed to parse defense statement: {e}")
            # Fallback to basic defense if LLM fails
            return DefenseStatement(
                thesis=self.finding.thesis,
                evidence=[],
                methodology="Error in processing",
                confidence=0.0
            )

    async def respond_to_challenge(self, challenge: ChallengeStatement) -> RebuttalStatement:
        """
        Responds to a specific challenge with a rebuttal.
        """
        prompt = self._build_rebuttal_prompt(challenge)
        
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
            return RebuttalStatement(
                finding_id=self.finding.id,
                challenge_id=challenge.id,
                argument=data.get("argument", "No rebuttal provided."),
                new_evidence=[EvidenceItem(**item) for item in data.get("new_evidence", [])]
            )
        except Exception as e:
            self.logger.error(f"Failed to parse rebuttal statement: {e}")
            return RebuttalStatement(
                finding_id=self.finding.id,
                challenge_id=challenge.id,
                argument=f"Error processing rebuttal: {e}",
                new_evidence=[]
            )

    def _get_system_prompt(self) -> str:
        return (
            "You are the Champion Subagent in an adversarial research framework. "
            "Your role is to DEFEND a specific research finding (thesis) using provided evidence. "
            "You must be logically rigorous, prioritize empirical data from experiments, "
            "and acknowledge limitations without conceding the core thesis unless it is completely invalidated. "
            "Output your response in valid JSON format only."
        )

    def _build_defense_prompt(self) -> str:
        evidence_str = "\n".join([f"- Result {i}: {res.metrics} (Success: {res.success})" for i, res in enumerate(self.evidence)])
        return (
            f"Please build a structured defense for the following research finding:\n"
            f"Thesis: {self.finding.thesis}\n\n"
            f"Available Evidence (Experiment Results):\n{evidence_str}\n\n"
            f"Provide your response in the following JSON format:\n"
            "{\n"
            "  \"thesis\": \"string\",\n"
            "  \"evidence\": [{\"source\": \"string\", \"description\": \"string\", \"value\": \"string\", \"metric\": float}],\n"
            "  \"methodology\": \"string\",\n"
            "  \"confidence\": float (0.0 to 1.0)\n"
            "}"
        )

    def _build_rebuttal_prompt(self, challenge: ChallengeStatement) -> str:
        return (
            f"A challenger has raised an issue with your finding:\n"
            f"Challenge Type: {challenge.type}\n"
            f"Description: {challenge.description}\n"
            f"Counter-Evidence: {challenge.counter_evidence}\n\n"
            f"Your Thesis: {self.finding.thesis}\n\n"
            f"Please provide a rebuttal in the following JSON format:\n"
            "{\n"
            "  \"argument\": \"string\",\n"
            "  \"new_evidence\": [{\"source\": \"string\", \"description\": \"string\", \"value\": \"string\", \"metric\": float}]\n"
            "}"
        )

    def _extract_json(self, text: str) -> str:
        """Extracts JSON block from text if it's wrapped in markdown code blocks."""
        if not text:
            return "{}"
        if "```json" in text:
            return text.split("```json")[1].split("```")[0].strip()
        if "```" in text:
            return text.split("```")[1].split("```")[0].strip()
        return text.strip()
