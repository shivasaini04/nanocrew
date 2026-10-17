import json
import logging
from typing import List, Any
from nanoagent.providers.base import LLMProvider
from .types import ResearchFinding, DefenseStatement, RebuttalStatement, ChallengeStatement, ChallengeVerdict, EvidenceItem
from ..literature.extractor import KnowledgeCard

class ChallengerAgent:
    """
    A subagent persona whose sole job is to find flaws, logical gaps, and potential hallucinations.
    """
    def __init__(self, provider: LLMProvider, model: str, finding: ResearchFinding, literature: List[KnowledgeCard]):
        self.provider = provider
        self.model = model
        self.finding = finding
        self.literature = literature
        self.logger = logging.getLogger(__name__)

    async def generate_challenges(self, defense: DefenseStatement) -> List[ChallengeStatement]:
        """
        Analyzes a defense statement and generates potential challenges.
        """
        prompt = self._build_challenge_prompt(defense)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.4 # Slightly higher temperature for creative "red teaming"
        )
        
        try:
            data = json.loads(self._extract_json(response.content))
            return [
                ChallengeStatement(
                    id=f"c-{i}",
                    type=item.get("type", "logical_flaw"),
                    description=item.get("description", ""),
                    severity=item.get("severity", "major"),
                    counter_evidence=item.get("counter_evidence", [])
                )
                for i, item in enumerate(data.get("challenges", []))
            ]
        except Exception as e:
            self.logger.error(f"Failed to parse challenge statements: {e}")
            return []

    async def evaluate_rebuttal(self, rebuttal: RebuttalStatement) -> ChallengeVerdict:
        """
        Evaluates a rebuttal and issues a verdict.
        """
        prompt = self._build_evaluation_prompt(rebuttal)
        
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
            return ChallengeVerdict(
                challenge_id=rebuttal.challenge_id,
                is_addressed=data.get("is_addressed", False),
                reasoning=data.get("reasoning", "No evaluation provided.")
            )
        except Exception as e:
            self.logger.error(f"Failed to parse challenge verdict: {e}")
            return ChallengeVerdict(
                challenge_id=rebuttal.challenge_id,
                is_addressed=False,
                reasoning=f"Error processing evaluation: {e}"
            )

    def _get_system_prompt(self) -> str:
        return (
            "You are the Challenger Subagent (Red Team) in an adversarial research framework. "
            "Your sole mission is to find flaws, logical inconsistencies, missing evidence, and contradictions in research findings. "
            "You should be skeptical, rigorous, and focused on potential hallucinations or over-generalizations. "
            "Cross-reference every claim against the provided literature. "
            "Output your response in valid JSON format only."
        )

    def _build_challenge_prompt(self, defense: DefenseStatement) -> str:
        literature_str = "\n".join([f"- {c.title}: {c.key_findings}" for c in self.literature])
        evidence_str = "\n".join([f"- {e.source}: {e.description} ({e.value})" for e in defense.evidence])
        
        return (
            f"Please scrutinize the following defense for a research finding:\n"
            f"Thesis: {defense.thesis}\n"
            f"Methodology: {defense.methodology}\n"
            f"Supporting Evidence:\n{evidence_str}\n\n"
            f"Relevant Literature:\n{literature_str}\n\n"
            "Identify 1-3 specific challenges. Focus on:\n"
            "1. Logical gaps between evidence and thesis.\n"
            "2. Contradictions with known literature findings.\n"
            "3. Insufficient data or statistical significance.\n"
            "4. Risk of hallucination or over-generalization.\n\n"
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"challenges\": [\n"
            "    {\n"
            "      \"type\": \"logical_flaw\" | \"missing_evidence\" | \"conflicting_literature\" | \"hallucination_risk\",\n"
            "      \"description\": \"detailed critique\",\n"
            "      \"severity\": \"critical\" | \"major\" | \"minor\",\n"
            "      \"counter_evidence\": [\"specific counter-points or citations\"]\n"
            "    }\n"
            "  ]\n"
            "}"
        )

    def _build_evaluation_prompt(self, rebuttal: RebuttalStatement) -> str:
        return (
            f"You previously challenged a finding. The Champion has provided a rebuttal:\n"
            f"Rebuttal Argument: {rebuttal.argument}\n"
            f"New Evidence Provided: {[e.description for e in rebuttal.new_evidence]}\n\n"
            "Does this rebuttal satisfactorily address your original challenge? "
            "Be fair but remains skeptical. "
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"is_addressed\": boolean,\n"
            "  \"reasoning\": \"detailed explanation of why the challenge is or is not met\"\n"
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
