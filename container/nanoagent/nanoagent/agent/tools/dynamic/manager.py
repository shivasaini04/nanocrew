"""Manager for dynamic tool lifecycle operations (validation, security, deps, testing)."""

import json
from typing import List, Optional, Tuple, Any
from loguru import logger

from nanoagent.agent.tools.dynamic.manifest import ToolManifest
from nanoagent.agent.tools.dynamic.sandbox import SandboxExecutor
from nanoagent.agent.tools.dynamic.validator import ToolValidator
from nanoagent.agent.tools.dynamic.test_runner import ToolTestRunner, TestRunResult, TestCaseResult
from nanoagent.agent.tools.dynamic.security import SecurityScanner
from nanoagent.agent.tools.dynamic.deps import DependencyInstaller


class DynamicToolManager:
    """
    Centralizes the logic for preparing, validating, and testing dynamic tools.
    Used by both GenerateToolTool and UpdateToolTool.
    """

    def __init__(self, registry: Optional[Any] = None, persistence: Optional[Any] = None,
                 health_monitor: Optional[Any] = None):
        # Needed so a re-registered tool keeps recording executions. Without it,
        # rollback_tool below — which IS the auto-rollback trigger — hands back an
        # unmonitored tool, so automatic rollback could fire exactly once per tool and
        # then never again.
        self._health_monitor = health_monitor
        self._validator = ToolValidator()
        self._executor = SandboxExecutor()
        self._test_runner = ToolTestRunner(self._executor)
        self._security_scanner = SecurityScanner()
        self._deps_installer = DependencyInstaller()
        self._registry = registry
        self._persistence = persistence

    def rollback_tool(self, tool_name: str, version: Optional[str] = None) -> Tuple[bool, str]:
        """
        Orchestrates tool rollback: Persistence -> Registry.
        """
        if not self._persistence or not self._registry:
            return False, "Error: Manager not initialized with persistence/registry."

        manifest = self._persistence.rollback(tool_name, version=version)
        if not manifest:
            return False, f"Error: Rollback failed for tool '{tool_name}'."

        # Re-register the tool in the active registry, still monitored — a tool that has
        # already been rolled back once is precisely the one worth continuing to watch.
        from nanoagent.agent.tools.dynamic.tool import DynamicTool
        dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
        
        try:
            if hasattr(self._registry, "unregister_dynamic"):
                self._registry.unregister_dynamic(tool_name)
            
            if hasattr(self._registry, "register_dynamic"):
                self._registry.register_dynamic(dynamic_tool)
            else:
                self._registry.register(dynamic_tool)
            
            return True, f"Successfully rolled back tool '{tool_name}' to v{manifest.version}."
        except Exception as e:
            logger.error(f"Failed to re-register tool after rollback: {e}")
            return False, f"Error: Roleback succeeded on disk, but registration failed: {e}"

    async def prepare_and_verify(self, manifest: ToolManifest) -> Tuple[bool, str, Optional[TestRunResult]]:
        """
        Runs the full verification pipeline: basic validation -> deps -> security -> tests.
        Returns (success, message, test_results).
        """
        # 1. Basic Schema Validation
        val_result = self._validator.validate(manifest)
        if not val_result.valid:
            return False, f"Error: Tool validation failed.\nIssues: " + "; ".join(val_result.errors), None

        is_sidecar = (manifest.tier == "sidecar")

        # 2. Handle Dependencies. Sidecar-tier tools run in an isolated container, so they
        # may declare ANY package (allowlist skipped, blocklist still enforced). Sandbox-tier
        # tools keep the curated allowlist. (Deferred-item #1 / Phase 2.)
        if manifest.dependencies:
            dep_check = self._deps_installer.check(
                manifest.dependencies, manifest.language, allow_any=is_sidecar,
            )
            if not dep_check.all_safe:
                return False, f"Error: The following dependencies are blocked: {', '.join(dep_check.blocked)}", None

            # Sidecar-tier deps are installed + cached IN the sidecar during the sidecar verify
            # run (step 4), so don't install them into the throwaway cycle container here.
            # Sandbox-tier tools never have deps (classify_tier routes any dep to the sidecar),
            # so this local-install branch only runs as a defensive fallback.
            if not is_sidecar and dep_check.missing:
                install_result = self._deps_installer.install(dep_check.missing, manifest.language)
                if not install_result.success:
                    return False, f"Error: Failed to install required dependencies.\nError: {install_result.error}", None

        # 3. Security Scan — every file in the set (multi-file tools), not just the entrypoint.
        # Tier-gated: sidecar tools (isolated container) are allowed subprocess/os/deps.
        for rel, content in manifest.files.items():
            security_result = self._security_scanner.scan(content, manifest.language, manifest.tier)
            if not security_result.safe:
                return False, f"[{rel}] " + security_result.to_report(), None

        # 4. Run Test Cases. Sidecar-tier tools verify IN the sidecar — deps install onto the
        # cached volume (reused at runtime) and the tool runs in the real isolation env (with
        # `host`/subprocess available). If the sidecar is unreachable (e.g. local/CI), fall back
        # to the in-process sandbox after a best-effort local install.
        if is_sidecar:
            test_results = await self._run_tests_in_sidecar(manifest)
            if test_results is None:
                if manifest.dependencies:
                    fb = self._deps_installer.check(manifest.dependencies, manifest.language, allow_any=True)
                    if fb.missing:
                        self._deps_installer.install(fb.missing, manifest.language)
                test_results = await self._test_runner.run_tests(manifest)
        else:
            test_results = await self._test_runner.run_tests(manifest)

        if not test_results.all_passed:
            if test_results.total == 0:
                return False, "Error: no test_cases provided. Add at least one test_case with {\"input\": {...}} so the tool can be verified before registration.", test_results
            failed_cases = []
            for r in test_results.results:
                if not r.passed:
                    # TestCase has no name; identify the case by its input so the agent can fix it.
                    label = json.dumps(r.test_case.input, default=str)[:120]
                    failed_cases.append(f"Case {label}: " + (r.error or "Validation failed"))

            return False, f"Error: {test_results.failed} test cases failed.\n" + "\n".join(failed_cases), test_results

        return True, "Verification passed", test_results

    async def _run_tests_in_sidecar(self, manifest: ToolManifest) -> Optional[TestRunResult]:
        """Verify a sidecar-tier tool by running its test cases IN the agent's sidecar via the
        orchestrator's /sidecar/verify route. Deps install onto the sidecar's cached volume
        (reused at runtime) and the tool runs in real isolation with `host` available.

        Returns a TestRunResult on success, or None if the sidecar can't be used (no AGENT_ID,
        httpx missing, unreachable, or the candidate couldn't load) so the caller falls back to
        the local sandbox.
        """
        import os

        agent_id = os.environ.get("AGENT_ID", "").strip()
        if not agent_id:
            return None
        try:
            import httpx
        except ImportError:
            return None

        host = (os.environ.get("NanoCrew_HOST", "") or "http://host.docker.internal:3002").rstrip("/")
        payload = {
            "files": manifest.files,
            "entrypoint": manifest.entrypoint,
            "language": manifest.language,
            "dependencies": manifest.dependencies,
            "capabilities": manifest.capabilities,
            "timeout": manifest.timeout,
            "test_cases": [
                {
                    "input": tc.input,
                    "expected_contains": tc.expected_contains,
                    "expected_type": tc.expected_type,
                    "expected_status": tc.expected_status,
                }
                for tc in manifest.test_cases
            ],
        }
        # First call may pip-install heavy deps (torch, …); give it room. Cached thereafter.
        http_timeout = 1200 if manifest.dependencies else 180
        url = f"{host}/api/agents/{agent_id}/sidecar/verify"
        try:
            async with httpx.AsyncClient(timeout=http_timeout) as client:
                resp = await client.post(url, json=payload)
                data = resp.json()
        except Exception as e:
            logger.warning(f"Sidecar verify unreachable ({e}); falling back to local sandbox.")
            return None

        # The route wraps the result as {status, result:<json-string>}.
        if not isinstance(data, dict) or data.get("status") != "ok":
            logger.warning(f"Sidecar verify did not return ok ({data}); falling back to local.")
            return None
        try:
            vr = json.loads(data.get("result") or "{}")
        except Exception:
            return None

        if vr.get("unsupported"):
            return None  # e.g. non-python — let the local sandbox handle it
        if vr.get("install_error") or vr.get("load_error"):
            # Deps failed to install / the tool failed to load in the sidecar — a real
            # verification failure (NOT a fallback): surface it as a failed run per test case.
            reason = (f"Dependency install failed in sidecar: {vr['install_error']}"
                      if vr.get("install_error")
                      else f"Tool failed to load in sidecar: {vr['load_error']}")
            tr = TestRunResult(total=max(len(manifest.test_cases), 1))
            tr.failed = tr.total
            tr.results = [
                TestCaseResult(test_case=tc, passed=False, actual_output="", error=reason)
                for tc in manifest.test_cases
            ]
            return tr

        exec_list = vr.get("results") or []
        if len(exec_list) != len(manifest.test_cases):
            # Mismatch — don't risk a false pass; fall back to the local sandbox.
            return None
        return self._test_runner.build_result_from_exec(manifest, exec_list)
