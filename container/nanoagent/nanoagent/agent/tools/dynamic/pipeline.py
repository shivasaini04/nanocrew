import asyncio
import time
import json
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Union

from loguru import logger
from nanoagent.agent.tools.base import Tool


@dataclass
class PipelineStep:
    tool_name: str
    params: Dict[str, Any]
    output_key: str
    parallel: bool = False
    on_error: str = "fail"  # "fail" | "skip" | "retry"
    max_retries: int = 2
    condition: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineStep":
        return cls(**data)


@dataclass
class Pipeline:
    name: str
    description: str
    steps: List[PipelineStep]
    input_schema: Dict[str, Any]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Pipeline":
        data = data.copy()
        if "steps" in data:
            data["steps"] = [PipelineStep.from_dict(s) for s in data["steps"]]
        return cls(**data)
        
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class StepResult:
    step_name: str
    success: bool
    output: Any = None
    error: Optional[str] = None
    time_ms: int = 0
    
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PipelineResult:
    success: bool
    step_results: List[StepResult]
    final_output: Any
    total_time_ms: int
    
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PipelineExecutor:
    def __init__(self, tool_registry: Any, job_id: Optional[str] = None):
        self._registry = tool_registry
        self._job_id = job_id
        
    def _resolve_variables(self, params: Any, context: Dict[str, Any]) -> Any:
        if isinstance(params, dict):
            return {k: self._resolve_variables(v, context) for k, v in params.items()}
        elif isinstance(params, list):
            return [self._resolve_variables(v, context) for v in params]
        elif isinstance(params, str) and params.startswith("$"):
            # length hack for "$step1.output.length" -> evaluate length
            if ".length" in params:
                var_path = params.replace(".length", "")
                val = self._resolve_variables(var_path, context)
                return len(val) if isinstance(val, (list, str, dict)) else 0
                
            parts = params[1:].split(".")
            base = parts[0]
            if base in context:
                val = context[base]
                for p in parts[1:]:
                    if isinstance(val, dict) and p in val:
                        val = val[p]
                    else:
                        return params # couldn't resolve fully
                return val
            return params
        return params

    def _evaluate_condition(self, condition: str, context: Dict[str, Any]) -> bool:
        # A very basic evaluator for "$step1.output.length > 0"
        try:
            tokens = condition.split()
            if len(tokens) == 3:
                left = self._resolve_variables(tokens[0], context)
                op = tokens[1]
                right = tokens[2]
                
                # convert right to appropriate type
                if right.isdigit():
                    right = int(right)
                elif right.replace('.', '', 1).isdigit():
                    right = float(right)
                
                if op == ">": return left > right
                if op == "<": return left < right
                if op == "==": return left == right
                if op == "!=": return left != right
                if op == ">=": return left >= right
                if op == "<=": return left <= right
            
            return True
        except Exception as e:
            logger.warning(f"Condition evaluation failed: {e}. Defaulting to True.")
            return True

    async def _execute_single_tool(self, tool_name: str, params: Dict[str, Any]) -> Any:
        tool = None
        if hasattr(self._registry, "get_tool"):
            tool = self._registry.get_tool(tool_name)
        elif hasattr(self._registry, "_tools"):
            tool = self._registry._tools.get(tool_name)
            
        if not tool:
            raise ValueError(f"Tool '{tool_name}' not found.")
            
        result = await tool.execute(**params)
        # Try to parse JSON output if applicable
        if isinstance(result, str):
            try:
                return json.loads(result)
            except json.JSONDecodeError:
                return result
        return result

    async def execute(self, pipeline: Pipeline, inputs: Dict[str, Any]) -> PipelineResult:
        context = {
            "input": inputs,
            "env": {}, 
            "job": {"workspace": f"/workspace/jobs/{self._job_id}" if self._job_id else "/workspace"}
        }
        
        step_results: List[StepResult] = []
        final_output = None
        start_time = time.time()
        
        for step in pipeline.steps:
            step_start = time.time()
            
            if step.condition:
                if not self._evaluate_condition(step.condition, context):
                    step_results.append(StepResult(
                        step_name=step.output_key,
                        success=True,
                        output=None,
                        time_ms=int((time.time() - step_start) * 1000)
                    ))
                    continue

            logger.info(f"Executing pipeline step: {step.tool_name} -> {step.output_key}")
            
            resolved_params = self._resolve_variables(step.params, context)
            
            result_output = None
            step_success = False
            step_error = None
            
            retries = step.max_retries if step.on_error == "retry" else 0
            attempts = retries + 1
            
            for attempt in range(attempts):
                try:
                    if step.parallel and isinstance(resolved_params, list):
                        # Expects list of param dicts or maybe we have to distribute array elements
                        # If a tool expects multiple params, this may need more sophisticated fan-out.
                        # For now, assume resolved_params is a list of dicts or list of single values.
                        if all(isinstance(p, dict) for p in resolved_params):
                            tasks = [self._execute_single_tool(step.tool_name, p) for p in resolved_params]
                        else:
                            # if it's a list of primitives, and tool takes one param, we don't know the param name.
                            # Just pass it as "input" or similar.
                            logger.warning(f"Parallel param is not a list of dicts, passing as 'input' param")
                            tasks = [self._execute_single_tool(step.tool_name, {"input": p}) for p in resolved_params]

                        result_output = await asyncio.gather(*tasks, return_exceptions=True)
                        for r in result_output:
                            if isinstance(r, Exception):
                                raise r
                    else:
                        if not isinstance(resolved_params, dict):
                            resolved_params = {"input": resolved_params}
                        result_output = await self._execute_single_tool(step.tool_name, resolved_params)
                        
                    step_success = True
                    break
                except Exception as e:
                    step_error = str(e)
                    logger.warning(f"Step {step.output_key} failed: {e}")
                    if attempt < attempts - 1:
                        await asyncio.sleep(1)
                    
            time_ms = int((time.time() - step_start) * 1000)
            
            step_results.append(StepResult(
                step_name=step.output_key,
                success=step_success,
                output=result_output,
                error=step_error,
                time_ms=time_ms
            ))
            
            if step_success:
                context[step.output_key] = {"output": result_output}
                final_output = result_output
            else:
                if step.on_error == "fail":
                    logger.error(f"Pipeline failed at step {step.output_key}.")
                    return PipelineResult(
                        success=False,
                        step_results=step_results,
                        final_output=None,
                        total_time_ms=int((time.time() - start_time) * 1000)
                    )
                elif step.on_error == "skip":
                    context[step.output_key] = {"output": None}

        total_time_ms = int((time.time() - start_time) * 1000)
        return PipelineResult(
            success=True,
            step_results=step_results,
            final_output=final_output,
            total_time_ms=total_time_ms
        )
