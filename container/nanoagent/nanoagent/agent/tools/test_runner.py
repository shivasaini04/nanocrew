"""test_runner — run project test suites and return structured pass/fail results."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool

# Frameworks: (name, detect_files, command_template)
_FRAMEWORKS = [
    ("pytest",   ["pytest.ini", "pyproject.toml", "setup.cfg", "conftest.py"],  "pytest {args} --tb=short -q"),
    ("jest",     ["jest.config.js", "jest.config.ts", "jest.config.mjs"],        "npx jest {args} --no-coverage"),
    ("vitest",   ["vitest.config.ts", "vitest.config.js"],                       "npx vitest run {args}"),
    ("go",       ["go.mod"],                                                      "go test {args} ./..."),
    ("cargo",    ["Cargo.toml"],                                                  "cargo test {args}"),
    ("mocha",    [".mocharc.js", ".mocharc.yml", ".mocharc.json"],               "npx mocha {args}"),
]


def _detect_framework(cwd: Path) -> tuple[str, str] | None:
    """Return (name, command) for the first detected framework, or None."""
    for name, files, cmd in _FRAMEWORKS:
        if any((cwd / f).exists() for f in files):
            return name, cmd
    return None


def _parse_pytest(stdout: str, stderr: str, returncode: int) -> dict[str, Any]:
    passed = failed = errors = skipped = 0
    failures: list[str] = []

    # Summary line: "5 passed, 1 failed, 2 warnings in 1.23s"
    m = re.search(r"(\d+) passed", stdout)
    if m: passed = int(m.group(1))
    m = re.search(r"(\d+) failed", stdout)
    if m: failed = int(m.group(1))
    m = re.search(r"(\d+) error", stdout)
    if m: errors = int(m.group(1))
    m = re.search(r"(\d+) skipped", stdout)
    if m: skipped = int(m.group(1))

    # Capture FAILED lines
    for line in stdout.splitlines():
        if line.startswith("FAILED "):
            failures.append(line[7:].strip())

    return {"passed": passed, "failed": failed, "errors": errors, "skipped": skipped, "failures": failures}


def _parse_jest(stdout: str, stderr: str, returncode: int) -> dict[str, Any]:
    passed = failed = skipped = 0
    failures: list[str] = []
    combined = stdout + stderr

    m = re.search(r"Tests:\s+(?:(\d+) failed,?\s*)?(?:(\d+) skipped,?\s*)?(\d+) passed", combined)
    if m:
        failed = int(m.group(1) or 0)
        skipped = int(m.group(2) or 0)
        passed = int(m.group(3) or 0)

    for line in combined.splitlines():
        if re.match(r"\s+●\s+", line):
            failures.append(line.strip().lstrip("● "))

    return {"passed": passed, "failed": failed, "errors": 0, "skipped": skipped, "failures": failures}


def _parse_go(stdout: str, stderr: str, returncode: int) -> dict[str, Any]:
    passed = failed = 0
    failures: list[str] = []
    for line in (stdout + stderr).splitlines():
        if line.startswith("--- FAIL:"):
            failed += 1
            failures.append(line[9:].strip().split()[0])
        elif line.startswith("--- PASS:"):
            passed += 1
        elif line.startswith("ok "):
            m = re.search(r"\((\d+) tests", line)
            if m: passed += int(m.group(1))
    return {"passed": passed, "failed": failed, "errors": 0, "skipped": 0, "failures": failures}


def _parse_cargo(stdout: str, stderr: str, returncode: int) -> dict[str, Any]:
    passed = failed = 0
    failures: list[str] = []
    m = re.search(r"test result:.*?(\d+) passed.*?(\d+) failed", stdout + stderr)
    if m:
        passed, failed = int(m.group(1)), int(m.group(2))
    for line in (stdout + stderr).splitlines():
        if re.match(r"test .+ \.\.\. FAILED", line):
            failures.append(line.split("test ")[1].split(" ...")[0])
    return {"passed": passed, "failed": failed, "errors": 0, "skipped": 0, "failures": failures}


_PARSERS = {
    "pytest": _parse_pytest,
    "jest": _parse_jest,
    "vitest": _parse_jest,   # vitest output mirrors jest
    "mocha": _parse_jest,
    "go": _parse_go,
    "cargo": _parse_cargo,
}


class TestRunnerTool(Tool):
    """Run a project's test suite and return structured pass/fail results."""

    def __init__(self, workspace: Path | None = None) -> None:
        self._workspace = workspace

    @property
    def required_permission(self) -> "Any":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "run_tests"

    @property
    def description(self) -> str:
        return (
            "Run the project's test suite (pytest, jest, vitest, go test, cargo test, mocha) "
            "and return structured results: pass/fail counts and the names of failing tests. "
            "Auto-detects the framework from config files. Use after editing code to verify "
            "correctness. Can target a specific file or test with the 'filter' parameter."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "framework": {
                    "type": "string",
                    "enum": ["auto", "pytest", "jest", "vitest", "go", "cargo", "mocha"],
                    "description": "Test framework to use. 'auto' detects from project files (default).",
                    "default": "auto",
                },
                "filter": {
                    "type": "string",
                    "description": (
                        "Run only tests matching this pattern or file path. "
                        "e.g. 'test_auth', 'tests/test_api.py', 'TestLogin'."
                    ),
                },
                "working_dir": {
                    "type": "string",
                    "description": "Directory to run tests from. Defaults to workspace root.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Max seconds to wait for the test run (default 120, max 600).",
                    "default": 120,
                },
                "extra_args": {
                    "type": "string",
                    "description": "Extra CLI flags to pass to the test runner (e.g. '-v', '--no-cov').",
                },
            },
            "required": [],
        }

    async def execute(
        self,
        framework: str = "auto",
        filter: str | None = None,
        working_dir: str | None = None,
        timeout: int = 120,
        extra_args: str | None = None,
        **kwargs: Any,
    ) -> str:
        timeout = min(int(timeout), 600)

        # Resolve working directory
        if working_dir:
            cwd = Path(working_dir).expanduser().resolve()
        elif self._workspace:
            cwd = self._workspace.resolve()
        else:
            cwd = Path(os.environ.get("WORKSPACE_DIR", ".")).resolve()

        if not cwd.is_dir():
            return json.dumps({"error": f"Directory not found: {cwd}"})

        # Detect or validate framework
        if framework == "auto":
            detected = _detect_framework(cwd)
            if not detected:
                return json.dumps({
                    "error": "Could not auto-detect test framework. Specify 'framework' explicitly.",
                    "hint": "Looked for: pytest.ini, jest.config.*, go.mod, Cargo.toml, vitest.config.*",
                })
            fw_name, cmd_template = detected
        else:
            fw_name = framework
            cmd_template = next((c for n, _, c in _FRAMEWORKS if n == framework), None)
            if not cmd_template:
                return json.dumps({"error": f"Unknown framework: {framework}"})

        # Build args
        args_parts: list[str] = []
        if filter:
            if fw_name == "pytest":
                args_parts.append(f"-k '{filter}'" if not filter.endswith(".py") else filter)
            elif fw_name in ("jest", "vitest", "mocha"):
                args_parts.append(f"--testNamePattern='{filter}'" if not "/" in filter else filter)
            elif fw_name == "go":
                args_parts.append(f"-run '{filter}'")
            elif fw_name == "cargo":
                args_parts.append(filter)
        if extra_args:
            args_parts.append(extra_args)

        cmd = cmd_template.format(args=" ".join(args_parts)).strip()

        # Execute
        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                return json.dumps({"error": f"Test run timed out after {timeout}s", "framework": fw_name, "command": cmd})
        except Exception as exc:
            return json.dumps({"error": str(exc), "framework": fw_name, "command": cmd})

        duration_ms = int((time.monotonic() - start) * 1000)
        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        returncode = proc.returncode or 0

        # Parse results
        parser = _PARSERS.get(fw_name)
        if parser:
            stats = parser(stdout, stderr, returncode)
        else:
            stats = {"passed": 0, "failed": 0, "errors": 0, "skipped": 0, "failures": []}

        # Grab last 60 lines of output for context
        all_output = (stdout + stderr).strip()
        output_lines = all_output.splitlines()
        tail = "\n".join(output_lines[-60:]) if len(output_lines) > 60 else all_output

        result: dict[str, Any] = {
            "framework": fw_name,
            "command": cmd,
            "working_dir": str(cwd),
            "returncode": returncode,
            "passed": stats["passed"],
            "failed": stats["failed"],
            "errors": stats["errors"],
            "skipped": stats["skipped"],
            "duration_ms": duration_ms,
            "ok": returncode == 0,
        }
        if stats["failures"]:
            result["failing_tests"] = stats["failures"]
        if not result["ok"]:
            result["output_tail"] = tail

        return json.dumps(result, indent=2)
