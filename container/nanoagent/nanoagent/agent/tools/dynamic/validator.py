"""Validation logic for agent-generated tools."""

import ast
import importlib.util
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

from nanoagent.agent.tools.dynamic.manifest import ToolManifest


@dataclass
class ValidationResult:
    """Outcomes of a tool validation check."""
    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class ToolValidator:
    """Checks generated tool code for syntax, security, and dependencies."""

    RESERVED_NAMES = {
        "exec", "bash", "write_file", "read_file", "list_dir", 
        "delegate_task", "search_web", "generate_tool", "list_tools"
    }

    def validate(self, manifest: ToolManifest) -> ValidationResult:
        """Run all validation checks on the manifest."""
        result = ValidationResult(valid=True)

        # 1. Name Collision Check
        if manifest.name in self.RESERVED_NAMES:
            result.valid = False
            result.errors.append(f"Name collision: '{manifest.name}' is a reserved tool name.")

        # 2. Language-specific validation
        if manifest.language == "python":
            self._validate_python(manifest, result)
        elif manifest.language == "bash":
            self._validate_bash(manifest, result)

        return result

    def _validate_python(self, manifest: ToolManifest, result: ValidationResult):
        """Perform AST-based analysis on Python implementation."""
        try:
            tree = ast.parse(manifest.implementation)
        except SyntaxError as e:
            result.valid = False
            result.errors.append(f"Syntax Error: {e.msg} (line {e.lineno})")
            return

        # Walk AST for imports and security
        for node in ast.walk(tree):
            # A. Check Imports
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self._check_python_imports(node, manifest, result)

            # B. Check Security (Dangerous Functions) — sandbox tier only.
            # Sidecar-tier tools run in an isolated Docker container, so subprocess/os/
            # open/etc. are legitimate there; the container is the safety boundary, not
            # this static blocklist. (Routing to that container is enforced in
            # DynamicTool.execute, so this relaxation can't leak into the sandbox.)
            if isinstance(node, ast.Call) and manifest.tier != "sidecar":
                self._check_python_security(node, result)

    def _check_python_imports(self, node: Any, manifest: ToolManifest, result: ValidationResult):
        """Verify imports are available or declared in dependencies."""
        names = []
        if isinstance(node, ast.Import):
            names = [n.name.split('.')[0] for n in node.names]
        else:  # ImportFrom
            if node.module:
                names = [node.module.split('.')[0]]

        for name in names:
            if name in sys.builtin_module_names:
                continue
            
            # Check if available in current environment
            spec = importlib.util.find_spec(name)
            if spec is None and name not in manifest.dependencies:
                result.warnings.append(
                    f"Possible missing dependency: '{name}'. "
                    "Ensure it's in the 'dependencies' list or available in the path."
                )

    def _check_python_security(self, node: ast.Call, result: ValidationResult):
        """Block dangerous functions via AST analysis."""
        func_name = ""
        
        # Determine function name (handles os.system etc)
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name):
                func_name = f"{node.func.value.id}.{node.func.attr}"
            else:
                func_name = node.func.attr

        # Blacklisted patterns
        dangerous_patterns = {
            "os.system", "os.popen", "subprocess.run", "subprocess.Popen",
            "subprocess.call", "subprocess.check_output", "eval", "exec", 
            "__import__", "open", "shutil.rmtree"
        }

        if func_name in dangerous_patterns:
            result.valid = False
            result.errors.append(f"Security Violation: Use of '{func_name}' is restricted.")

    def _validate_bash(self, manifest: ToolManifest, result: ValidationResult):
        """Basic regex-based validation for Bash scripts."""
        dangerous_bash = [
            r"rm\s+-rf\s+/",
            r"chmod\s+.*x",
            r">/dev/sda", # Disk direct write
            r"nc\s+-l",   # Netcat listener
            r"mkfifo"     # Named pipes (often used for shells)
        ]

        for pattern in dangerous_bash:
            if re.search(pattern, manifest.implementation):
                result.valid = False
                result.errors.append(f"Security Violation: Dangerous pattern detected in Bash script: {pattern}")

        # Warning for network commands without timeout/retry
        if "curl" in manifest.implementation or "wget" in manifest.implementation:
            if "--max-time" not in manifest.implementation and "-m" not in manifest.implementation:
                result.warnings.append("Best practice: Use --max-time with curl/wget in tools.")
