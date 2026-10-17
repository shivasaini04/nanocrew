import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Dict, Any, Optional

@dataclass
class EvolutionLesson:
    """A single lesson learned from a research experiment."""
    category: str  # "decision", "experiment", "finding", "mistake", "optimization"
    description: str
    confidence: float
    domain: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    iteration: Optional[int] = None
    metric_impact: Optional[float] = None

class EvolutionEngine:
    """Manages the extraction and application of research lessons."""
    
    def __init__(self, knowledge_dir: str):
        self.knowledge_dir = knowledge_dir
        self.lessons_path = os.path.join(knowledge_dir, "evolution", "lessons.json")
        os.makedirs(os.path.dirname(self.lessons_path), exist_ok=True)
        self.lessons: List[EvolutionLesson] = self._load_lessons()

    def _load_lessons(self) -> List[EvolutionLesson]:
        if not os.path.exists(self.lessons_path):
            return []
        try:
            with open(self.lessons_path, 'r') as f:
                data = json.load(f)
                return [EvolutionLesson(**d) for d in data]
        except Exception:
            return []

    def save_lessons(self):
        with open(self.lessons_path, 'w') as f:
            json.dump([asdict(l) for l in self.lessons], f, indent=2)

    def extract_lessons_from_iteration(self, iteration_data: Dict[str, Any], domain: str):
        """Analyze a single iteration to extract potential lessons."""
        # Simple heuristic-based extraction for POC
        status = iteration_data.get("status")
        metric = iteration_data.get("metric", 0.0)
        reasoning = iteration_data.get("reasoning", "")
        it_num = iteration_data.get("iteration")

        reasoning_lower = reasoning.lower()
        if status == "discarded" and ("error" in reasoning_lower or "fail" in reasoning_lower or "crash" in reasoning_lower):
            lesson = EvolutionLesson(
                category="mistake",
                description=f"Experiment failed: {reasoning}",
                confidence=0.8,
                domain=domain,
                iteration=it_num,
                metric_impact=metric
            )
            self._add_lesson(lesson)
        elif status == "kept" and metric > 0.5:
            lesson = EvolutionLesson(
                category="optimization",
                description=f"High metric optimization found: {reasoning}",
                confidence=0.9,
                domain=domain,
                iteration=it_num,
                metric_impact=metric
            )
            self._add_lesson(lesson)

    def _add_lesson(self, lesson: EvolutionLesson):
        # Deduplication logic: check if similar lesson exists
        for existing in self.lessons:
            if existing.description == lesson.description:
                return
        self.lessons.append(lesson)
        self.save_lessons()

    def get_prompt_injection(self, domain: str) -> str:
        """Get a formatted string of relevant lessons for prompt injection."""
        relevant = [l for l in self.lessons if l.domain == domain or l.domain == "general"]
        if not relevant:
            return ""

        prompt = "\n### LESSONS LEARNED FROM PREVIOUS EXPERIMENTS\n"
        for l in relevant[-5:]:  # Last 5 lessons
            prompt += f"- [{l.category.upper()}]: {l.description} (Confidence: {l.confidence})\n"
        return prompt
