import os
import re
from dataclasses import dataclass, field
from typing import List, Optional, Dict

@dataclass
class ExperimentResult:
    iteration: int
    metric: float
    status: str
    description: str

@dataclass
class ProgramState:
    goal: str = ""
    hypothesis: str = ""
    constraints: str = ""
    insights: List[str] = field(default_factory=list)
    next_steps: List[str] = field(default_factory=list)
    results: List[ExperimentResult] = field(default_factory=list)

    @classmethod
    def load(cls, path: str) -> 'ProgramState':
        """
        Parses program.md and returns a ProgramState object.
        """
        if not os.path.exists(path):
            return cls()

        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()

        state = cls()
        
        # Parse sections using regex
        def get_section(name, text):
            pattern = rf"## {name}\n(.*?)(?=\n## |\Z)"
            match = re.search(pattern, text, re.DOTALL)
            return match.group(1).strip() if match else ""

        state.goal = get_section("Goal", content)
        state.hypothesis = get_section("Current Hypothesis", content)
        state.constraints = get_section("Constraints", content)
        
        insights_raw = get_section("Insights", content)
        state.insights = [line.strip("- ").strip() for line in insights_raw.split("\n") if line.strip()]

        next_steps_raw = get_section("Next Steps", content)
        state.next_steps = [line.strip("- ").strip() for line in next_steps_raw.split("\n") if line.strip()]

        # Parse Results Log (skip header)
        results_section = get_section("Results Log", content)
        lines = results_section.split("\n")
        for line in lines:
            if "|" in line and "Iteration" not in line and "---" not in line:
                parts = [p.strip() for p in line.split("|") if p.strip()]
                if len(parts) >= 4:
                    try:
                        state.results.append(ExperimentResult(
                            iteration=int(parts[0]),
                            metric=float(parts[1]),
                            status=parts[2],
                            description=parts[3]
                        ))
                    except ValueError:
                        continue
        
        return state

    def save(self, path: str):
        """
        Serializes the state back to program.md.
        """
        content = [
            "# Research Program",
            "",
            "## Goal",
            self.goal,
            "",
            "## Current Hypothesis",
            self.hypothesis,
            "",
            "## Constraints",
            self.constraints,
            "",
            "## Results Log",
            "| Iteration | Metric | Status | Description |",
            "|-----------|--------|--------|-------------|",
        ]

        for res in self.results:
            content.append(f"| {res.iteration} | {res.metric} | {res.status} | {res.description} |")

        content.append("")
        content.append("## Insights")
        for insight in self.insights:
            content.append(f"- {insight}")

        content.append("")
        content.append("## Next Steps")
        for step in self.next_steps:
            content.append(f"- {step}")

        with open(path, 'w', encoding='utf-8') as f:
            f.write("\n".join(content))

    def update_hypothesis(self, hypothesis: str):
        self.hypothesis = hypothesis

    def record_result(self, iteration: int, metric: float, status: str, description: str):
        self.results.append(ExperimentResult(iteration, metric, status, description))

    def get_context_for_agent(self) -> str:
        """
        Renders the full state as LLM context.
        """
        context = [
            f"RESEARCH GOAL: {self.goal}",
            f"CURRENT HYPOTHESIS: {self.hypothesis}",
            "CONSTRAINTS:",
            self.constraints or "None specified",
            "INSIGHTS SO FAR:",
            "\n".join([f"- {i}" for i in self.insights]) if self.insights else "None yet",
            "RESULTS LOG (Last 5):",
            "\n".join([f"It {r.iteration}: {r.metric} ({r.status}) - {r.description}" for r in self.results[-5:]]) if self.results else "No experiments yet",
            "NEXT STEPS:",
            "\n".join([f"- {s}" for s in self.next_steps]) if self.next_steps else "None formulated yet"
        ]
        return "\n\n".join(context)

def init_results_tsv(path: str):
    """
    Initializes or appends to results.tsv (Karpathy-style logs).
    """
    if not os.path.exists(path):
        with open(path, 'w', encoding='utf-8') as f:
            f.write("iteration\tmetric\tstatus\tdescription\n")

def append_to_results_tsv(path: str, iteration: int, metric: float, status: str, description: str):
    init_results_tsv(path)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(f"{iteration}\t{metric}\t{status}\t{description}\n")
