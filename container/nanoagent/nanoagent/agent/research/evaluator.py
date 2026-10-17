import os
import shutil
from dataclasses import dataclass
from typing import Optional, Tuple
from .runner import ExperimentResult
from .base import ResearchConfig

@dataclass
class EvalDecision:
    action: str  # "keep" | "discard" | "crash"
    improvement: float
    new_best: float
    reasoning: str

class ResultEvaluator:
    """
    Compares experiment results against the current best and manages code state.
    """
    def __init__(self, config: ResearchConfig):
        self.config = config
        # Simplicity penalty: penalize for added lines
        # Default: 0.1% penalty per 10 lines added (very conservative)
        self.simplicity_factor = 0.0001 

    def evaluate(self, result: ExperimentResult, current_best: Optional[float]) -> EvalDecision:
        """
        Decides whether to keep the current experiment's code changes.
        """
        if not result.success:
            return EvalDecision(
                action="crash",
                improvement=0.0,
                new_best=current_best or 0.0,
                reasoning=f"Experiment failed or crashed: {result.error}"
            )

        new_val = result.metrics.get(self.config.metric_key)
        if new_val is None:
            return EvalDecision(
                action="discard",
                improvement=0.0,
                new_best=current_best or 0.0,
                reasoning=f"Metric '{self.config.metric_key}' not found in results."
            )

        if current_best is None:
            return EvalDecision(
                action="keep",
                improvement=0.0,
                new_best=new_val,
                reasoning="Initial experiment baseline established."
            )

        # Standard delta
        delta = current_best - new_val if self.config.metric_direction == "minimize" else new_val - current_best
        
        # Apply simplicity criterion
        # We'll calculate it but for now just use the raw delta for decision
        # A more advanced version would use: improved_metric = new_val * (1 + penalty)
        # For Milestone 1.4, we follow Karpathy's lead: strict metric improvement or simplicity tie-break.
        
        if delta > 0:
            return EvalDecision(
                action="keep",
                improvement=delta,
                new_best=new_val,
                reasoning=f"Improved {self.config.metric_key} by {delta:.6f}."
            )
        else:
            return EvalDecision(
                action="discard",
                improvement=delta,
                new_best=current_best,
                reasoning=f"No improvement (delta: {delta:.6f})."
            )

    def snapshot_code(self, target_file: str) -> str:
        """
        Returns the current content of the target file.
        """
        full_path = os.path.join(self.config.workspace_path, target_file)
        if not os.path.exists(full_path):
            return ""
        with open(full_path, "r", encoding='utf-8') as f:
            return f.read()

    def revert_code(self, target_file: str, snapshot: str):
        """
        Restores the target file content from the snapshot.
        """
        full_path = os.path.join(self.config.workspace_path, target_file)
        with open(full_path, "w", encoding='utf-8') as f:
            f.write(snapshot)

    def commit_code(self, target_file: str, description: str):
        """
        Saves the current successful state.
        (Future implementation may use git here).
        """
        # For now, we manually backup the best version
        src_path = os.path.join(self.config.workspace_path, target_file)
        dst_path = os.path.join(self.config.workspace_path, f"{target_file}.best")
        if os.path.exists(src_path):
            shutil.copy2(src_path, dst_path)

    def calculate_simplicity_score(self, code: str) -> int:
        """
        Returns the number of non-empty lines as a proxy for simplicity.
        """
        lines = [l for l in code.splitlines() if l.strip()]
        return len(lines)
