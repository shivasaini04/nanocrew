import json
import logging
from typing import List, Optional, Any
from nanoagent.providers.base import LLMProvider
from .types import JudgeVerdict, ResearchDecision
from ..runner import ExperimentResult

class DecisionEngine:
    """
    The autonomous decision engine that determines whether to PROCEED, REFINE, or PIVOT.
    """
    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model
        self.logger = logging.getLogger(__name__)
        
        # State for safeguards
        self.consecutive_refines = 0
        self.consecutive_pivots = 0
        self.MAX_REFINES = 3
        self.MAX_PIVOTS = 5

    async def evaluate(
        self, 
        verdict: JudgeVerdict, 
        research_history: List[ExperimentResult]
    ) -> ResearchDecision:
        """
        Determines the next research action based on judge results and history.
        """
        # --- Rule-based pre-processing ---
        if verdict.outcome == "accepted":
            self.consecutive_refines = 0
            self.consecutive_pivots = 0
            return ResearchDecision(
                action="proceed",
                reasoning=f"Judge accepted the finding with score {verdict.score}. {verdict.reasoning}"
            )

        # Handle safeguards first
        if self.consecutive_refines >= self.MAX_REFINES:
            self.logger.warning(f"Max refines ({self.MAX_REFINES}) reached. Forcing PIVOT.")
            return await self._generate_intelligent_pivot(
                verdict, 
                research_history, 
                "Max refinement attempts reached without acceptance."
            )

        if self.consecutive_pivots >= self.MAX_PIVOTS:
            self.logger.error("Max pivots reached. Escalating to human.")
            return ResearchDecision(
                action="pivot",
                reasoning="MAX_PIVOTS_REACHED: 5 consecutive pivots. Manual intervention required.",
                pivot_direction="ESCALATE_TO_HUMAN"
            )

        # --- Intelligent Decision via LLM ---
        prompt = self._build_decision_prompt(verdict, research_history)
        
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": self._get_system_prompt()},
                {"role": "user", "content": prompt}
            ],
            model=self.model,
            temperature=0.4
        )
        
        try:
            data = json.loads(self._extract_json(response.content))
            action = data.get("action", "refine")
            
            # Update counters
            if action == "refine":
                self.consecutive_refines += 1
            elif action == "pivot":
                self.consecutive_pivots += 1
                self.consecutive_refines = 0
            
            return ResearchDecision(
                action=action,
                reasoning=data.get("reasoning", "LLM decision."),
                refinement_hints=data.get("refinement_hints", []),
                pivot_direction=data.get("pivot_direction")
            )
        except Exception as e:
            self.logger.error(f"Failed to parse research decision: {e}")
            self.consecutive_refines += 1
            return ResearchDecision(
                action="refine",
                reasoning=f"Error in intelligent decision loop: {e}. Defaulting to REFINE.",
                refinement_hints=verdict.revision_requirements
            )

    async def _generate_intelligent_pivot(
        self, 
        verdict: JudgeVerdict, 
        history: List[ExperimentResult], 
        reason: str
    ) -> ResearchDecision:
        """Helper to generate a PIVOT decision when safeguards are triggered."""
        self.consecutive_pivots += 1
        self.consecutive_refines = 0
        
        prompt = f"We need to PIVOT. {reason}\nJudge reasoning: {verdict.reasoning}\nSuggest a new direction."
        response = await self.provider.chat(
            messages=[
                {"role": "system", "content": "You are a research strategist. Suggest a new direction (PIVOT)."},
                {"role": "user", "content": prompt}
            ],
            model=self.model
        )
        
        return ResearchDecision(
            action="pivot",
            reasoning=reason,
            pivot_direction=response.content or "Reset research loop with random hypothesis tweak."
        )

    def _get_system_prompt(self) -> str:
        return (
            "You are the Decision Engine in an autonomous research system. "
            "Your job is to decide whether to: "
            "1. 'refine': Tweak the current approach based on judge feedback. "
            "2. 'pivot': The current path is a dead end. Suggest a fundamentally different hypothesis. "
            "Weight the judge's score and history heavily. "
            "Output your response in valid JSON format only."
        )

    def _build_decision_prompt(self, verdict: JudgeVerdict, history: List[ExperimentResult]) -> str:
        history_summary = [f"Iter {i}: success={r.success}, metrics={r.metrics}" for i, r in enumerate(history[-5:])]
        return (
            f"Decision Context:\n"
            f"Judge Outcome: {verdict.outcome}\n"
            f"Judge Reasoning: {verdict.reasoning}\n"
            f"Revision Requirements: {verdict.revision_requirements}\n"
            f"Recent History:\n" + "\n".join(history_summary) + "\n\n"
            "Should we REFINE or PIVOT? "
            "Provide your response in the following JSON format:\n"
            "{\n"
            "  \"action\": \"refine\" | \"pivot\",\n"
            "  \"reasoning\": \"string\",\n"
            "  \"refinement_hints\": [\"list of suggestions if refining\"],\n"
            "  \"pivot_direction\": \"string (new hypothesis if pivoting)\"\n"
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
