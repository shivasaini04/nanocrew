from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

class ResearchState(Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"

@dataclass
class ResearchConfig:
    goal: str
    workspace_path: str
    target_file: str
    run_command: str
    metric_key: str
    metric_direction: str = "minimize"  # "minimize" | "maximize"
    metric_regex: Optional[str] = None  # Optional regex to parse metric from stdout
    time_budget_per_run_sec: int = 300
    max_total_iterations: Optional[int] = None
    model_tier: str = "primary" # "primary" | "secondary" | "cheap"

@dataclass
class ResearchStatus:
    state: ResearchState
    iteration_count: int
    best_metric: Optional[float]
    elapsed_time_sec: float
    current_hypothesis: str
    total_budget_usd: float = 0.0
    remaining_budget_usd: float = 0.0
    last_error: Optional[str] = None
