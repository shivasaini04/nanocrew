import json
import logging
from typing import List, Any
from nanoagent.providers.base import LLMProvider
from .types import DefenseStatement, ChallengeStatement, RebuttalStatement, JudgeVerdict

class JudgeAgent:
    """
    A neutral subagent that reviews the Champion-Challenger debate and issues a binding verdict.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)

    async def arbitrate(
        self, 
        defense: DefenseStatement, 
        challenges: List[ChallengeStatement], 
        rebuttals: List[RebuttalStatement]
    ) -> JudgeVerdict:
        """
        Arbitrates the debate and issues a final verdict.
        """
        prompt = self._build_arbitration_prompt(defense, challenges, rebuttals)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.2 # Lower temperature for stable judgment
        )
        
        try:
            data = json.loads(self._extract_json(response.content))
            return JudgeVerdict(
                outcome=data.get("outcome", "rejected"),
                score=data.get("score", 0.0),
                reasoning=data.get("reasoning", "No reasoning provided."),
                accepted_challenges=data.get("accepted_challenges", []),
                revision_requirements=data.get("revision_requirements", [])
            )
        except Exception as e:
            self.logger.error(f"Failed to parse judge verdict: {e}")
            return JudgeVerdict(
                outcome="rejected",
                score=0.0,
                reasoning=f"Error processing judgment: {e}",
                accepted_challenges=[],
                revision_requirements=["Re-run arbitration due to parsing error."]
            )

    def _get_system_prompt(self) -> str:
        return (
            "You are the Judge Arbitrator in an adversarial research framework. "
            "Your role is to review a debate between a Champion (defending a thesis) and a Challenger (critiquing it). "
            "You must remain neutral, demand high standards of evidence, and weigh the strength of arguments and counter-evidence. "
            "Your verdict is binding. Outcome must be one of: 'accepted', 'rejected', or 'needs_revision'. "
            "Output your response in valid JSON format only."
        )

    def _build_arbitration_prompt(
        self, 
        defense: DefenseStatement, 
        challenges: List[ChallengeStatement], 
        rebuttals: List[RebuttalStatement]
    ) -> str:
        challenges_str = "\n".join([f"- Challenge {c.id} ({c.type}): {c.description}" for c in challenges])
        rebuttals_str = "\n".join([f"- Rebuttal for {r.challenge_id}: {r.argument}" for r in rebuttals])
        
        return (
            f"Please review the following research debate and issue a final verdict:\n\n"
            f"Thesis: {defense.thesis}\n"
            f"Champion's Initial Defense: {defense.methodology}\n"
            f"Supporting Evidence count: {len(defense.evidence)}\n\n"
            f"Challenger's Critiques:\n{challenges_str}\n\n"
            f"Champion's Rebuttals:\n{rebuttals_str}\n\n"
            "Evaluate:\n"
            "1. Did the Champion satisfactorily address the challenges?\n"
            "2. Is the evidence strong enough to support the thesis?\n"
            "3. Are there still major logical flaws or risks of hallucination?\n\n"
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"outcome\": \"accepted\" | \"rejected\" | \"needs_revision\",\n"
            "  \"score\": float (0.0 to 1.0 confidence),\n"
            "  \"reasoning\": \"detailed explanation\",\n"
            "  \"accepted_challenges\": [\"list of challenge IDs that remain valid/unsolved\"],\n"
            "  \"revision_requirements\": [\"specific steps required if needs_revision\"]\n"
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
