"""Static analysis security scanner for dynamic tools."""

import ast
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SecurityViolation:
    """Represents a specific security rule violation."""
    rule: str
    line: int
    description: str
    severity: str = "error"  # "warning" | "error"


@dataclass
class SecurityResult:
    """Results of a security scan."""
    safe: bool
    violations: list[SecurityViolation] = field(default_factory=list)
    risk_level: str = "safe"  # "safe" | "low" | "medium" | "high" | "critical"

    def to_report(self) -> str:
        if self.safe:
            return "Security scan passed: No violations found."
        
        report = [f"Security scan failed: {len(self.violations)} violations found."]
        for v in self.violations:
            report.append(f"  - [{v.rule}] Line {v.line}: {v.description} ({v.severity})")
        return "\n".join(report)


class SecurityScanner:
    """
    Performs static analysis on tool implementation to prevent dangerous patterns.
    """

    DANGEROUS_MODULES = {
        "os", "subprocess", "shutil", "importlib", "socket", 
        "ctypes", "multiprocessing", "threading", "pickle"
    }

    # Network clients a generated tool must not drive directly. Not a security rule — a
    # source-protection one, which is why it is separate from DANGEROUS_MODULES.
    #
    # A tool that builds its own httpx client gets: no residential proxy (so linkedin.com
    # and reddit.com answer from the datacenter IP with silence rather than an error), no
    # crawl delay, no per-cycle budget, no 429 latch, and no zero-result canary. Each of
    # those is a rule some 800-line built-in learned the hard way and wrote down in a
    # comment that a generated tool never reads. `agent/source_fetch.py` holds them per
    # destination domain instead, so anything fetching through it inherits all of them.
    #
    # `urllib.parse` and friends stay allowed — only the network-capable entry points are
    # listed, since parsing a URL is not the risk.
    NETWORK_MODULES = {
        "httpx", "requests", "aiohttp", "urllib3", "urllib.request", "http.client",
    }
    _NETWORK_SUBMODULES = {("urllib", "request"), ("http", "client")}

    DANGEROUS_FUNCTIONS = {
        "os.system", "os.popen", "os.spawn", "os.remove", "os.unlink", "os.rmdir",
        "subprocess.run", "subprocess.call", "subprocess.Popen", "subprocess.check_output",
        "shutil.rmtree", "shutil.copytree", "shutil.move",
        "eval", "exec", "compile", "__import__", "getattr", "setattr"
    }

    @staticmethod
    def _source_fetch_remedy(module: str) -> str:
        """The message a generated tool sees. It has to teach, not just refuse — the model
        reads this string and regenerates from it, so it names the replacement API."""
        return (
            f"Do not drive '{module}' directly. Fetch through the shared source capability "
            f"so this tool inherits residential-proxy routing, the per-domain crawl delay, "
            f"the per-cycle request budget, the never-retry-a-429 rule and the zero-result "
            f"canary:\n"
            f"    from nanoagent.agent.source_fetch import fetch, record_yield\n"
            f"    res = await fetch(url)            # res.ok / res.text / res.error\n"
            f"    record_yield(url, len(items))     # so a broken parser cannot look like a quiet day\n"
            f"Building your own client silently loses all of it — including the proxy, which "
            f"means linkedin.com and reddit.com return empty pages instead of errors."
        )

    def scan(self, code: str, language: str = "python", tier: str = "sandbox") -> SecurityResult:
        """
        Scans code for security violations.

        `tier` gates how strict we are. For the `sidecar` tier the tool runs in an
        isolated Docker container, so the module/function blocklist (subprocess, os,
        deps, …) is intentionally relaxed — those are the point of the powerful tier.
        The cheap obfuscation check (getattr to dangerous attrs) still runs for both.
        """
        if language != "python":
            # For now, we only support Python security scanning
            return SecurityResult(safe=True)

        is_sidecar = tier == "sidecar"

        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return SecurityResult(
                safe=False,
                violations=[SecurityViolation("syntax-error", e.lineno or 0, str(e))],
                risk_level="high"
            )

        violations = []

        for node in ast.walk(tree):
            # 1. Check Imports (sandbox tier only)
            if isinstance(node, ast.Import):
                if not is_sidecar:
                    for name in node.names:
                        if name.name in self.DANGEROUS_MODULES:
                            violations.append(SecurityViolation(
                                "restricted-import", node.lineno,
                                f"Importing module '{name.name}' is restricted for security reasons."
                            ))
                        elif name.name in self.NETWORK_MODULES:
                            violations.append(SecurityViolation(
                                "use-source-fetch", node.lineno, self._source_fetch_remedy(name.name)
                            ))

            elif isinstance(node, ast.ImportFrom):
                if not is_sidecar and node.module in self.DANGEROUS_MODULES:
                    violations.append(SecurityViolation(
                        "restricted-import", node.lineno,
                        f"Importing from module '{node.module}' is restricted for security reasons."
                    ))
                elif not is_sidecar and node.module:
                    imported = {a.name for a in node.names}
                    hit = node.module in self.NETWORK_MODULES or any(
                        node.module == pkg and sub in imported
                        for pkg, sub in self._NETWORK_SUBMODULES
                    )
                    if hit:
                        violations.append(SecurityViolation(
                            "use-source-fetch", node.lineno, self._source_fetch_remedy(node.module)
                        ))

            # 2. Check Function Calls
            elif isinstance(node, ast.Call):
                func_name = self._get_full_func_name(node.func)
                if not is_sidecar and func_name in self.DANGEROUS_FUNCTIONS:
                    violations.append(SecurityViolation(
                        f"no-{func_name.split('.')[-1]}", node.lineno,
                        f"Calling '{func_name}' is prohibited for security reasons.",
                        severity="error"
                    ))

                # Special check for getattr/setattr with dangerous targets (always on)
                if func_name == "getattr" and len(node.args) >= 2:
                    if isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
                        target = node.args[1].value
                        if target in ("system", "popen", "spawn", "unlink", "remove"):
                            violations.append(SecurityViolation(
                                "obfuscated-call", node.lineno,
                                f"Accessing dangerous attribute '{target}' via getattr is prohibited.",
                                severity="critical"
                            ))

        # Determine risk level
        risk_level = "safe"
        if any(v.severity == "error" for v in violations):
            risk_level = "high"
        if any(v.rule == "obfuscated-call" for v in violations):
            risk_level = "critical"
        elif violations:
            risk_level = "low"

        return SecurityResult(safe=not violations, violations=violations, risk_level=risk_level)

    def _get_full_func_name(self, node: ast.AST) -> str:
        """Helper to extract full function name (e.g., 'os.system') from AST node."""
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            obj_name = self._get_full_func_name(node.value)
            return f"{obj_name}.{node.attr}"
        return ""
