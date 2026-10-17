from dataclasses import dataclass, field
from typing import Dict, Any, Optional

@dataclass
class TokenBudget:
    """Configuration for research token budget."""
    max_total_usd: float = 10.0
    max_per_iteration_usd: float = 1.0
    warning_threshold: float = 0.8  # 80%
    pause_threshold: float = 0.95    # 95%

@dataclass
class TokenUsage:
    """Usage data for a single request."""
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float

class TokenBudgetManager:
    """Tracks and enforces model usage costs during research."""
    
    def __init__(self, budget: TokenBudget):
        self.budget = budget
        self.total_usage_usd: float = 0.0
        self.iteration_usage_usd: float = 0.0
        self.usage_history: list[TokenUsage] = []

    def track(self, usage: TokenUsage):
        """Records token usage and cost."""
        self.total_usage_usd += usage.cost_usd
        self.iteration_usage_usd += usage.cost_usd
        self.usage_history.append(usage)

    def reset_iteration(self):
        """Resets the per-iteration cost counter."""
        self.iteration_usage_usd = 0.0

    def get_status(self) -> str:
        """Checks the budget status."""
        usage_pct = self.total_usage_usd / self.budget.max_total_usd
        
        if usage_pct >= 1.0:
            return "emergency_stop"
        if usage_pct >= self.budget.pause_threshold:
            return "pause"
        if usage_pct >= self.budget.warning_threshold:
            return "cooling"
        
        return "ok"

    def get_model_for_tier(self, tier: int, current_model: str) -> str:
        """
        Suggests a model based on tiers and current budget status.
        Tier 1: Lead Scientist (Expensive)
        Tier 2: Assistant (Mid)
        Tier 3: Worker (Cheap)
        """
        status = self.get_status()
        
        # In cooling mode, downgrade Mid to Cheap
        if status == "cooling" and tier == 2:
            return "gpt-4o-mini" # Example cheap model
            
        return current_model

    def get_summary(self) -> Dict[str, Any]:
        """Provides a summary for the dashboard."""
        return {
            "total_usd": round(self.total_usage_usd, 4),
            "max_usd": self.budget.max_total_usd,
            "usage_pct": round(self.total_usage_usd / self.budget.max_total_usd, 2),
            "status": self.get_status()
        }
