import asyncio
import os
import re
import json
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Any
from .base import ResearchConfig

@dataclass
class ExperimentResult:
    success: bool
    metrics: Dict[str, float] = field(default_factory=dict)
    stdout_tail: str = ""
    stderr_tail: str = ""
    execution_time_sec: float = 0.0
    exit_code: int = 0
    error: Optional[str] = None

class ExperimentRunner:
    """
    Executes research experiments in a controlled subprocess and extracts metrics.
    """
    def __init__(self, config: ResearchConfig):
        self.config = config
        self._process: Optional[asyncio.subprocess.Process] = None

    async def run_experiment(self) -> ExperimentResult:
        """
        Runs the experiment command, enforces timeout, and parses results.
        """
        start_time = time.time()
        stdout_path = os.path.join(self.config.workspace_path, "run.log")
        
        # Prepare the command execution
        try:
            # We use a shell to allow for complex commands like 'uv run train.py'
            process = await asyncio.create_subprocess_shell(
                self.config.run_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.config.workspace_path
            )
            self._process = process

            try:
                # Wait with timeout
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.config.time_budget_per_run_sec
                )
                stdout = stdout_bytes.decode('utf-8', errors='replace')
                stderr = stderr_bytes.decode('utf-8', errors='replace')
                exit_code = process.returncode
            except asyncio.TimeoutError:
                await self.kill()
                return ExperimentResult(
                    success=False,
                    error=f"Experiment timeout after {self.config.time_budget_per_run_sec}s",
                    execution_time_sec=time.time() - start_time,
                    exit_code=-1
                )

            execution_time = time.time() - start_time
            
            # Save full output to log
            with open(stdout_path, "w", encoding='utf-8') as f:
                f.write(f"STDOUT:\n{stdout}\n\nSTDERR:\n{stderr}")

            # Extract metrics
            metrics = self._parse_metrics(stdout, stderr)
            
            success = (exit_code == 0) and (self.config.metric_key in metrics)

            return ExperimentResult(
                success=success,
                metrics=metrics,
                stdout_tail="\n".join(stdout.splitlines()[-50:]),
                stderr_tail="\n".join(stderr.splitlines()[-50:]),
                execution_time_sec=execution_time,
                exit_code=exit_code
            )

        except Exception as e:
            return ExperimentResult(
                success=False,
                error=str(e),
                execution_time_sec=time.time() - start_time,
                exit_code=-1
            )
        finally:
            self._process = None

    async def kill(self):
        """
        Force-terminates the running experiment.
        """
        if self._process:
            try:
                self._process.terminate()
                # Give it a moment to terminate gracefully
                await asyncio.sleep(0.5)
                if self._process.returncode is None:
                    self._process.kill()
            except ProcessLookupError:
                pass

    def _parse_metrics(self, stdout: str, stderr: str) -> Dict[str, float]:
        """
        Extracts metrics from stdout/stderr using regex or JSON.
        """
        metrics = {}

        # 1. Regex parsing if configured
        if self.config.metric_regex:
            pattern = re.compile(self.config.metric_regex)
            # Find all matches, take the last one (assuming most recent/final metric)
            matches = list(pattern.finditer(stdout))
            if not matches:
                matches = list(pattern.finditer(stderr))
            
            if matches:
                last_match = matches[-1]
                try:
                    # If there's a group, use it, otherwise use the whole match
                    val = float(last_match.group(1)) if last_match.groups() else float(last_match.group(0))
                    metrics[self.config.metric_key] = val
                except (ValueError, IndexError):
                    pass

        # 2. Generic key: value parsing for common metrics
        # Look for patterns like "loss: 0.123" or "accuracy: 0.95"
        common_patterns = [
            rf"{self.config.metric_key}[:=]\s*(-?\d+\.?\d*)"
        ]
        for p in common_patterns:
            if self.config.metric_key not in metrics:
                match = re.search(p, stdout, re.IGNORECASE)
                if not match:
                    match = re.search(p, stderr, re.IGNORECASE)
                if match:
                    try:
                        metrics[self.config.metric_key] = float(match.group(1))
                    except ValueError:
                        pass

        # 3. JSON parsing (look for a JSON block at the end of output)
        json_match = re.search(r"\{.*\}", stdout.strip().splitlines()[-1] if stdout.strip() else "")
        if json_match:
            try:
                data = json.loads(json_match.group(0))
                if isinstance(data, dict):
                    for k, v in data.items():
                        if isinstance(v, (int, float)):
                            metrics[k] = float(v)
            except json.JSONDecodeError:
                pass

        return metrics
