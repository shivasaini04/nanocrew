"""Isolated execution environment for agent-generated tools."""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional


def _build_rlimit_preexec(memory_limit_mb: int, cpu_seconds: int) -> Optional[Callable[[], None]]:
    """Build a preexec_fn that caps the child's memory + CPU. Linux/POSIX only — the
    real execution path is the agent's Linux container; returns None on Windows (dev),
    where the limits simply don't apply. This is what turns the previously-unenforced
    SandboxConfig into a real resource boundary for the cheap (sandbox) tier."""
    if sys.platform == "win32":
        return None
    try:
        import resource  # POSIX-only
    except ImportError:
        return None

    def _apply() -> None:
        # CPU-seconds backstop in addition to the asyncio wall-clock timeout — kills a
        # busy-loop even if it somehow evades the wall timer.
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        except (ValueError, OSError):
            pass
        # Address-space cap — stops a memory bomb from OOM-ing the agent container.
        if memory_limit_mb and memory_limit_mb > 0:
            nbytes = memory_limit_mb * 1024 * 1024
            try:
                resource.setrlimit(resource.RLIMIT_AS, (nbytes, nbytes))
            except (ValueError, OSError):
                pass

    return _apply


@dataclass
class SandboxResult:
    """Outcomes of a sandboxed tool execution."""
    success: bool
    output: str
    error: Optional[str] = None
    execution_time_ms: int = 0
    memory_used_mb: float = 0.0


PYTHON_RUNNER_TEMPLATE = """
import json
import sys
import traceback

def run():
    try:
        # 1. Load arguments from CLI (as JSON)
        args_json = sys.argv[1] if len(sys.argv) > 1 else "{}"
        kwargs = json.loads(args_json)

        # 2. Import the implementation
        # The implementation is in the same directory as this runner
        import implementation
        
        # 3. Call the main function
        # We assume the tool defines a 'main' function or a function named after the tool
        # For simplicity in Phase 1, we require a 'main' function.
        if hasattr(implementation, 'main'):
            result = implementation.main(**kwargs)
        else:
            # Fallback: try to find any callable that isn't a built-in
            callables = [f for f in dir(implementation) if callable(getattr(implementation, f)) and not f.startswith('__')]
            if callables:
                result = getattr(implementation, callables[0])(**kwargs)
            else:
                raise AttributeError("No callable function found in implementation.")

        # 4. Output result as JSON
        print(json.dumps(result))

    except Exception as e:
        sys.stderr.write(str(e) + "\\n")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)

if __name__ == "__main__":
    run()
"""

JS_RUNNER_TEMPLATE = """
const fs = require('fs');

async function run() {
    try {
        const argsJson = process.argv[2] || '{}';
        const kwargs = JSON.parse(argsJson);

        const implementation = require('./implementation.js');
        
        let result;
        if (typeof implementation.main === 'function') {
            result = await implementation.main(kwargs);
        } else {
            // Find first exported function
            const exportedKeys = Object.keys(implementation);
            const firstFuncKey = exportedKeys.find(key => typeof implementation[key] === 'function');
            if (firstFuncKey) {
                result = await implementation[firstFuncKey](kwargs);
            } else {
                throw new Error("No callable function found in implementation.");
            }
        }

        console.log(JSON.stringify(result));
    } catch (e) {
        process.stderr.write(e.message + "\\n" + e.stack);
        process.exit(1);
    }
}

run();
"""

class SandboxExecutor:
    """Executes code in an isolated subprocess with timeout and error handling."""

    async def run(
        self,
        code: str,
        args: dict[str, Any],
        language: str = "python",
        timeout: int = 10,
        files: Optional[dict[str, str]] = None,
        entrypoint: Optional[str] = None,
        memory_limit_mb: int = 512,
    ) -> SandboxResult:
        start_time = time.time()

        if language == "python":
            return await self._run_python(code, args, timeout, start_time, files=files, entrypoint=entrypoint, memory_limit_mb=memory_limit_mb)
        elif language == "bash":
            return await self._run_bash(code, args, timeout, start_time)
        elif language == "javascript":
            return await self._run_javascript(code, args, timeout, start_time)
        elif language == "typescript":
            return await self._run_typescript(code, args, timeout, start_time)
        else:
            return SandboxResult(
                success=False, 
                output="", 
                error=f"Unsupported language: {language}"
            )

    async def _run_python(
        self,
        code: str,
        args: dict[str, Any],
        timeout: int,
        start_time: float,
        files: Optional[dict[str, str]] = None,
        entrypoint: Optional[str] = None,
        memory_limit_mb: int = 512,
    ) -> SandboxResult:
        with tempfile.TemporaryDirectory(prefix="nanoagent_sandbox_") as tmpdir:
            # 1. Write the implementation. Multi-file: write every file at its relative
            # path (so the entrypoint can import its helpers), then mirror the entrypoint
            # to implementation.py so the runner's `import implementation` finds main().
            if files:
                entry_code = files.get(entrypoint or "", code)
                for rel, content in files.items():
                    dest = os.path.join(tmpdir, rel)
                    parent = os.path.dirname(dest)
                    if parent and os.path.abspath(parent).startswith(os.path.abspath(tmpdir)):
                        os.makedirs(parent, exist_ok=True)
                    with open(dest, "w", encoding="utf-8") as f:
                        f.write(content)
                impl_path = os.path.join(tmpdir, "implementation.py")
                with open(impl_path, "w", encoding="utf-8") as f:
                    f.write(entry_code)
            else:
                impl_path = os.path.join(tmpdir, "implementation.py")
                with open(impl_path, "w", encoding="utf-8") as f:
                    f.write(code)

            # 2. Write the runner script
            runner_path = os.path.join(tmpdir, "runner.py")
            with open(runner_path, "w", encoding="utf-8") as f:
                f.write(PYTHON_RUNNER_TEMPLATE)

            # 3. Prepare args
            args_str = json.dumps(args)

            # 4. Execute — with real resource limits (Linux container; no-op on Windows dev).
            exec_kwargs: dict[str, Any] = {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "cwd": tmpdir,  # Ensure it can import implementation.py
            }
            preexec = _build_rlimit_preexec(memory_limit_mb, timeout)
            if preexec is not None:
                exec_kwargs["preexec_fn"] = preexec
            try:
                process = await asyncio.create_subprocess_exec(
                    "python", runner_path, args_str,
                    **exec_kwargs,
                )

                try:
                    stdout_data, stderr_data = await asyncio.wait_for(
                        process.communicate(), 
                        timeout=timeout
                    )
                    
                    execution_time = int((time.time() - start_time) * 1000)
                    stdout = stdout_data.decode().strip()
                    stderr = stderr_data.decode().strip()

                    if process.returncode == 0:
                        return SandboxResult(
                            success=True, 
                            output=stdout, 
                            execution_time_ms=execution_time
                        )
                    else:
                        return SandboxResult(
                            success=False, 
                            output="", 
                            error=stderr or f"Process exited with code {process.returncode}",
                            execution_time_ms=execution_time
                        )

                except asyncio.TimeoutError:
                    if process:
                        try:
                            process.kill()
                        except:
                            pass
                    return SandboxResult(
                        success=False, 
                        output="", 
                        error=f"Execution timed out after {timeout}s"
                    )

            except Exception as e:
                return SandboxResult(
                    success=False, 
                    output="", 
                    error=f"Failed to start process: {str(e)}"
                )

    async def _run_bash(
        self, 
        code: str, 
        args: dict[str, Any], 
        timeout: int, 
        start_time: float
    ) -> SandboxResult:
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".sh", delete=False, mode="w") as tmp:
                tmp.write(code)
                tmp_path = tmp.name

            process = await asyncio.create_subprocess_exec(
                "bash", tmp_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )

            try:
                stdout_data, stderr_data = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=timeout
                )
                
                execution_time = int((time.time() - start_time) * 1000)
                stdout = stdout_data.decode().strip()
                stderr = stderr_data.decode().strip()

                if process.returncode == 0:
                    return SandboxResult(
                        success=True, 
                        output=stdout, 
                        execution_time_ms=execution_time
                    )
                else:
                    return SandboxResult(
                        success=False, 
                        output="", 
                        error=stderr or f"Process exited with code {process.returncode}",
                        execution_time_ms=execution_time
                    )

            except asyncio.TimeoutError:
                if process:
                    try:
                        process.kill()
                    except:
                        pass
                return SandboxResult(
                    success=False, 
                    output="", 
                    error=f"Execution timed out after {timeout}s"
                )

        except Exception as e:
            return SandboxResult(
                success=False, 
                output="", 
                error=f"Failed to run bash tool: {str(e)}"
            )
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    async def _run_javascript(
        self, 
        code: str, 
        args: dict[str, Any], 
        timeout: int, 
        start_time: float
    ) -> SandboxResult:
        with tempfile.TemporaryDirectory(prefix="nanoagent_sandbox_js_") as tmpdir:
            impl_path = os.path.join(tmpdir, "implementation.js")
            with open(impl_path, "w", encoding="utf-8") as f:
                f.write(code)

            runner_path = os.path.join(tmpdir, "runner.js")
            with open(runner_path, "w", encoding="utf-8") as f:
                f.write(JS_RUNNER_TEMPLATE)

            args_str = json.dumps(args)

            try:
                process = await asyncio.create_subprocess_exec(
                    "node", runner_path, args_str,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=tmpdir
                )

                try:
                    stdout_data, stderr_data = await asyncio.wait_for(
                        process.communicate(), 
                        timeout=timeout
                    )
                    
                    execution_time = int((time.time() - start_time) * 1000)
                    stdout = stdout_data.decode().strip()
                    stderr = stderr_data.decode().strip()

                    if process.returncode == 0:
                        return SandboxResult(success=True, output=stdout, execution_time_ms=execution_time)
                    else:
                        return SandboxResult(success=False, output="", error=stderr or f"Node exited with code {process.returncode}", execution_time_ms=execution_time)

                except asyncio.TimeoutError:
                    if process:
                        try: process.kill()
                        except: pass
                    return SandboxResult(success=False, output="", error=f"Execution timed out after {timeout}s")

            except Exception as e:
                return SandboxResult(success=False, output="", error=f"Failed to start node process: {str(e)}")

    async def _run_typescript(
        self, 
        code: str, 
        args: dict[str, Any], 
        timeout: int, 
        start_time: float
    ) -> SandboxResult:
        # For TS, we use esbuild if available for fast transpilation, 
        # or tsc if esbuild is missing. If both missing, it fails.
        with tempfile.TemporaryDirectory(prefix="nanoagent_sandbox_ts_") as tmpdir:
            ts_path = os.path.join(tmpdir, "implementation.ts")
            js_path = os.path.join(tmpdir, "implementation.js")
            with open(ts_path, "w", encoding="utf-8") as f:
                f.write(code)

            # Transpile using esbuild (silent, much faster than tsc)
            try:
                cmd = "npx.cmd" if os.name == "nt" else "npx"
                transpile_process = await asyncio.create_subprocess_exec(
                    cmd, "-y", "esbuild", ts_path, "--format=cjs", f"--outfile={js_path}",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                _, ts_stderr = await transpile_process.communicate()
                
                if transpile_process.returncode != 0:
                    return SandboxResult(
                        success=False, output="", 
                        error=f"TypeScript transpilation failed: {ts_stderr.decode()}",
                        execution_time_ms=int((time.time() - start_time) * 1000)
                    )
            except Exception as e:
                return SandboxResult(success=False, output="", error=f"Failed to run transpiler: {str(e)}")

            # Now run as JS
            with open(js_path, "r", encoding="utf-8") as f:
                js_code = f.read()
            
            return await self._run_javascript(js_code, args, timeout, start_time)
