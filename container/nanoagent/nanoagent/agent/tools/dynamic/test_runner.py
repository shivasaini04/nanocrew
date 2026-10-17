"""Advanced test runner for dynamic tools."""

import json
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from loguru import logger
from nanoagent.agent.tools.dynamic.manifest import ToolManifest, TestCase
from nanoagent.agent.tools.dynamic.sandbox import SandboxExecutor, SandboxResult


@dataclass
class TestCaseResult:
    """Detailed result for a single test case."""
    test_case: TestCase
    passed: bool
    actual_output: str
    error: Optional[str] = None
    execution_time_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "test_case": self.test_case.input,
            "passed": self.passed,
            "actual_output": self.actual_output,
            "error": self.error,
            "execution_time_ms": self.execution_time_ms
        }


@dataclass
class TestRunResult:
    """Aggregated results for a full test run of a tool."""
    passed: int = 0
    failed: int = 0
    total: int = 0
    results: list[TestCaseResult] = field(default_factory=list)
    avg_latency_ms: float = 0.0
    timestamp: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ"))

    @property
    def all_passed(self) -> bool:
        return self.failed == 0 and self.total > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failed": self.failed,
            "total": self.total,
            "results": [r.to_dict() for r in self.results],
            "avg_latency_ms": self.avg_latency_ms,
            "timestamp": self.timestamp,
            "all_passed": self.all_passed
        }


class ToolTestRunner:
    """
    Executes tests for dynamic tools and validates output against multiple modes.
    """

    def __init__(self, executor: SandboxExecutor):
        self._executor = executor

    async def run_tests(self, manifest: ToolManifest) -> TestRunResult:
        """
        Runs all test cases for a tool.
        """
        run_result = TestRunResult(total=len(manifest.test_cases))
        if not manifest.test_cases:
            return run_result

        total_latency = 0
        for tc in manifest.test_cases:
            start_time = time.time()
            
            # Execute in sandbox
            exec_result = await self._executor.run(
                code=manifest.implementation,
                args=tc.input,
                language=manifest.language,
                timeout=manifest.timeout,
                files=manifest.files,
                entrypoint=manifest.entrypoint,
            )
            
            latency = int((time.time() - start_time) * 1000)
            total_latency += latency
            
            # Validate
            passed, error = self._validate_test_case(tc, exec_result)
            
            case_result = TestCaseResult(
                test_case=tc,
                passed=passed,
                actual_output=exec_result.output,
                error=error,
                execution_time_ms=latency
            )
            
            run_result.results.append(case_result)
            if passed:
                run_result.passed += 1
            else:
                run_result.failed += 1
                
        run_result.avg_latency_ms = total_latency / run_result.total if run_result.total > 0 else 0
        return run_result

    def build_result_from_exec(self, manifest: ToolManifest, exec_list: list[dict]) -> TestRunResult:
        """Build a TestRunResult from raw per-case execution results produced ELSEWHERE
        (e.g. the sidecar's __verify__ run). The same `_validate_test_case` logic is applied,
        so sidecar-run and locally-run verifications validate identically."""
        run_result = TestRunResult(total=len(manifest.test_cases))
        total_latency = 0
        for tc, ex in zip(manifest.test_cases, exec_list):
            er = SandboxResult(
                success=bool(ex.get("success")),
                output=ex.get("output") or "",
                error=ex.get("error"),
                execution_time_ms=int(ex.get("execution_time_ms") or 0),
            )
            total_latency += er.execution_time_ms
            passed, error = self._validate_test_case(tc, er)
            run_result.results.append(TestCaseResult(
                test_case=tc, passed=passed, actual_output=er.output,
                error=error, execution_time_ms=er.execution_time_ms,
            ))
            if passed:
                run_result.passed += 1
            else:
                run_result.failed += 1
        run_result.avg_latency_ms = total_latency / run_result.total if run_result.total > 0 else 0
        return run_result

    def _validate_test_case(self, test_case: TestCase, exec_result: Any) -> tuple[bool, Optional[str]]:
        """
        Validates output against all specified modes in the test case.
        """
        # 1. Status Check
        if test_case.expected_status == "success" and not exec_result.success:
            return False, f"Execution failed when success was expected: {exec_result.error}"
        if test_case.expected_status == "error" and exec_result.success:
            return False, "Execution succeeded when error was expected"
        
        # If execution failed as expected, we're done
        if not exec_result.success:
            return True, None

        output = exec_result.output

        # 2. expected_contains
        if test_case.expected_contains and test_case.expected_contains not in output:
            return False, f"Output does not contain expected string: '{test_case.expected_contains}'"

        # 3. expected_type
        if test_case.expected_type:
            try:
                data = json.loads(output)
                if test_case.expected_type == "json" and not (isinstance(data, (dict, list))):
                    return False, f"Output is not valid JSON object/array (got {type(data).__name__})"
                if test_case.expected_type == "int" and not isinstance(data, int):
                    return False, f"Output is not an integer"
                if test_case.expected_type == "float" and not isinstance(data, (int, float)):
                    return False, f"Output is not a number"
                if test_case.expected_type == "array" and not isinstance(data, list):
                    return False, f"Output is not an array"
            except json.JSONDecodeError:
                if test_case.expected_type in ("json", "array", "int"):
                    return False, f"Output is not parseable as JSON (required for type '{test_case.expected_type}')"

        # 4. expected_schema (Simplified check for now)
        if test_case.expected_schema:
            try:
                data = json.loads(output)
                # In a real implementation, we'd use jsonschema validation here
                # For now, we just ensure it's a dict if schema is provided
                if not isinstance(data, dict):
                    return False, "Schema provided but output is not a JSON object"
            except json.JSONDecodeError:
                return False, "Schema provided but output is not parseable as JSON"

        return True, None
