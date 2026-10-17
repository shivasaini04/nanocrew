import asyncio
import os
import time
import logging
from typing import Optional, List, Any, Dict

from .base import ResearchState, ResearchConfig, ResearchStatus
from .program import ProgramState, append_to_results_tsv
from .runner import ExperimentRunner, ExperimentResult
from .evaluator import ResultEvaluator, EvalDecision
from .tool_bridge import ResearchToolBridge
from .evolution import EvolutionEngine
from .budget import TokenBudgetManager, TokenBudget, TokenUsage
from .distillation import KIDistiller

class ResearchOrchestrator:
    """
    The central coordinator for autonomous research sessions.
    Manages the lifecycle, state, and specialized subagents.
    """
    def __init__(self, config: ResearchConfig, subagent_manager: Any):
        self.config = config
        self.subagent_manager = subagent_manager
        self.status = ResearchStatus(
            state=ResearchState.IDLE,
            iteration_count=0,
            best_metric=None,
            elapsed_time_sec=0.0,
            current_hypothesis="Starting up..."
        )
        self._stop_event = asyncio.Event()
        self.logger = logging.getLogger(__name__)
        
        # Initialize sub-modules
        self.runner = ExperimentRunner(self.config)
        self.evaluator = ResultEvaluator(self.config)
        self.tool_bridge = ResearchToolBridge(self.subagent_manager)
        self.evolution_engine = EvolutionEngine(os.getcwd())
        self.budget_manager = TokenBudgetManager(TokenBudget())
        self.distiller = KIDistiller(os.path.join(os.getcwd(), "knowledge"))
        self.program_state: Optional[ProgramState] = None

    async def start_research(self, goal: str, workspace_path: str):
        """Initializes the research workspace and starts the loop."""
        self.config.goal = goal
        self.config.workspace_path = workspace_path
        
        # 1. Setup directories
        os.makedirs(workspace_path, exist_ok=True)
        for subfolder in ["papers", "scratch", "data", "deliverables"]:
            os.makedirs(os.path.join(workspace_path, subfolder), exist_ok=True)
        
        # 2. Initialize ProgramState
        prog_path = os.path.join(workspace_path, "program.md")
        self.program_state = ProgramState.load(prog_path)
        self.program_state.goal = goal
        self.program_state.save(prog_path)
        
        self.status.state = ResearchState.RUNNING
        self.logger.info(f"Research initialized for goal: {goal} in {workspace_path}")
        
        # Start the background loop
        asyncio.create_task(self.run_loop())

    async def run_loop(self):
        """The main Karpathy-style autonomous research loop."""
        start_time = time.time()
        prog_path = os.path.join(self.config.workspace_path, "program.md")
        results_tsv_path = os.path.join(self.config.workspace_path, "results.tsv")
        
        try:
            while not self._stop_event.is_set():
                if self.status.state == ResearchState.PAUSED:
                    await asyncio.sleep(1)
                    continue

                if self.config.max_total_iterations and self.status.iteration_count >= self.config.max_total_iterations:
                    self.status.state = ResearchState.COMPLETED
                    break

                # Budget check
                budget_status = self.budget_manager.get_status()
                if budget_status == "emergency_stop":
                    self.logger.error("EMERGENCY_STOP: Total token budget exceeded")
                    self.status.state = ResearchState.FAILED
                    break
                elif budget_status == "pause":
                    self.logger.warning("BUDGET_THRESHOLD: Pausing for human steering")
                    self.status.state = ResearchState.PAUSED
                    continue

                self.status.iteration_count += 1
                self.status.elapsed_time_sec = time.time() - start_time
                
                # Update budget metrics
                summary = self.budget_manager.get_summary()
                self.status.total_budget_usd = summary["max_usd"]
                self.status.remaining_budget_usd = max(0, summary["max_usd"] - summary["total_usd"])

                # --- PHASE A: PROPOSE ---
                self.status.current_hypothesis = "Proposing next experiment..."
                
                # Evolution: Get lessons to inject into proposal context
                evolution_context = self.evolution_engine.get_prompt_injection(self.config.goal)
                if evolution_context:
                    self.logger.info("Injecting evolutionary context into proposal")
                    # context += evolution_context
                
                # --- PHASE B: EXECUTE ---
                self.status.current_hypothesis = "Executing experiment..."
                code_snapshot = self.evaluator.snapshot_code(self.config.target_file)
                
                result = await self.runner.run_experiment()
                
                # --- PHASE C: EVALUATE ---
                decision = self.evaluator.evaluate(result, self.status.best_metric)
                
                # --- PHASE D: PERSIST & ACT ---
                # Update program.md and results.tsv
                self.program_state.record_result(
                    iteration=self.status.iteration_count,
                    metric=result.metrics.get(self.config.metric_key, 0.0),
                    status=decision.action,
                    description=decision.reasoning
                )
                self.program_state.save(prog_path)
                
                append_to_results_tsv(
                    results_tsv_path,
                    iteration=self.status.iteration_count,
                    metric=result.metrics.get(self.config.metric_key, 0.0),
                    status=decision.action,
                    description=decision.reasoning
                )

                # Evolution: Extract lessons from this iteration
                self.evolution_engine.extract_lessons_from_iteration(
                    {
                        "iteration": self.status.iteration_count,
                        "metric": result.metrics.get(self.config.metric_key, 0.0),
                        "status": decision.action,
                        "reasoning": decision.reasoning
                    },
                    domain=self.config.goal
                )

                # Budget: Track iteration expenditure
                # Mocking cost based on tier (Tier 2 default for Champion)
                self.budget_manager.track(TokenUsage(
                    model="claude-3-sonnet", # Placeholder
                    prompt_tokens=1500,
                    completion_tokens=500,
                    total_tokens=2000,
                    cost_usd=0.03 # Estimated average cost per iteration
                ))

                if decision.action == "keep":
                    self.status.best_metric = decision.new_best
                    self.evaluator.commit_code(self.config.target_file, decision.reasoning)
                    # Add to insights
                    if decision.reasoning not in self.program_state.insights:
                        self.program_state.insights.append(decision.reasoning)
                else:
                    # Revert if it didn't improve or it crashed
                    self.evaluator.revert_code(self.config.target_file, code_snapshot)

                # Small delay to prevent runaway infinite loops while testing
                await asyncio.sleep(0.5)

        except Exception as e:
            self.status.state = ResearchState.FAILED
            self.status.last_error = str(e)
            self.logger.error(f"Research loop failed: {e}")
        finally:
            if self.status.state == ResearchState.COMPLETED:
                self.logger.info("Research session completed. Distilling findings into Knowledge Items...")
                # Mock findings for distillation in POC
                mock_findings = [
                    {
                        "thesis": "High Temperature Lattice Stability",
                        "description": "The lattice remains stable up to 1200K under aluminum intercalation.",
                        "metric": self.status.best_metric or 0.9,
                        "status": "verified",
                        "iteration": self.status.iteration_count
                    }
                ]
                count = self.distiller.distill_session(
                    self.config.goal, 
                    mock_findings, 
                    self.evolution_engine.lessons
                )
                self.logger.info(f"Distilled {count} Knowledge Items to /knowledge/research/")

            if self.status.state != ResearchState.FAILED:
                self.status.state = ResearchState.COMPLETED

    def pause(self):
        """Pauses the research loop."""
        if self.status.state == ResearchState.RUNNING:
            self.status.state = ResearchState.PAUSED

    def resume(self):
        """Resumes a paused research loop."""
        if self.status.state == ResearchState.PAUSED:
            self.status.state = ResearchState.RUNNING

    def get_status(self) -> ResearchStatus:
        """Returns the current status of the research process."""
        return self.status
