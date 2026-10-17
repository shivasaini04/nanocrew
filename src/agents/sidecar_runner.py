#!/usr/bin/env python3
"""
Sidecar runner — reads agent-env.json, installs declared deps,
then serves tool calls as a JSON-RPC loop over stdin/stdout.

Protocol (one JSON object per line):
  INSTALL progress → {"status": "installing", "phase": "apt"|"pip", "packages": [...]}
  Ready signal     → {"status": "ready"}
  Failed signal    → {"status": "failed", "phase": "...", "error": "..."}
  Tool call result → {"id": "<callId>", "status": "ok", "result": "<json string>"}
  Tool call error  → {"id": "<callId>", "status": "error", "error": "<message>"}
"""

import json
import sys
import os
import subprocess
import importlib.util
import inspect
import asyncio

# Extra packages go into the persistent cache volume (/root/.cache is mounted
# as a named Docker volume, so pip installs survive sidecar restarts)
_EXTRA_PKGS = '/root/.cache/sidecar-packages'
os.makedirs(_EXTRA_PKGS, exist_ok=True)
if _EXTRA_PKGS not in sys.path:
    sys.path.insert(0, _EXTRA_PKGS)
import pathlib


class Tool:
    """Minimal base class — matches the nanobot Tool interface so generated
    Python tool files work here without importing nanobot."""
    name: str = ''
    description: str = ''
    parameters: dict = {}

    async def execute(self, **kwargs) -> str:
        raise NotImplementedError


class _MainAdapter(Tool):
    """Adapts a factory-style `main(**kwargs)` entrypoint to the runner's
    class.execute() protocol. `main` may be sync or async and may return a
    str / list / dict — non-strings are JSON-encoded (matching the sandbox runner)."""

    def __init__(self, fn):
        self._fn = fn

    async def execute(self, **kwargs) -> str:
        res = self._fn(**kwargs)
        if inspect.iscoroutine(res):
            res = await res
        return res if isinstance(res, str) else json.dumps(res)


def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _collect_manifest_deps(tool_dir: str) -> list:
    """Factory tools declare their pip deps in <name>/manifest.yaml. Orchestrator tools'
    deps arrive via agent-env.json, but factory tools don't go through that path — so we
    gather sidecar-tier factory tools' dependencies here so the sidecar installs them too."""
    deps: list = []
    try:
        base = pathlib.Path(tool_dir)
        if base.is_dir():
            for mpath in base.glob("*/manifest.yaml"):
                try:
                    data = json.loads(mpath.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if str(data.get("tier")) == "sidecar":
                    for d in (data.get("dependencies") or []):
                        if d and d not in deps:
                            deps.append(d)
    except Exception:
        pass
    return deps


def install_deps() -> bool:
    env_path = "/workspace/group/agent-env.json"
    env: dict = {}
    if os.path.exists(env_path):
        try:
            with open(env_path) as f:
                env = json.load(f)
        except Exception:
            env = {}

    apt_pkgs = [p for p in env.get("aptPackages", []) if p]
    pip_pkgs = [p for p in env.get("pythonPackages", []) if p]

    # Merge factory-tool deps so sidecar-tier generated tools get their libraries.
    # A dep prefixed `apt:` is a SYSTEM package — route it to apt. apt installs into the
    # container filesystem (not the /root/.cache volume), so it doesn't survive --rm; we
    # re-install it here on every startup (the persistence mechanism for on-demand apt deps).
    for d in _collect_manifest_deps(os.environ.get("TOOL_DIR", "/workspace/group/tools")):
        if d.startswith("apt:"):
            ap = d.split("apt:", 1)[1].strip()
            if ap and ap not in apt_pkgs:
                apt_pkgs.append(ap)
        elif d not in pip_pkgs:
            pip_pkgs.append(d)

    if not apt_pkgs and not pip_pkgs:
        _emit({"status": "ready", "note": "no dependencies to install"})
        return True

    if apt_pkgs:
        # Only install packages not already present. Once the orchestrator snapshots the
        # sidecar (committing apt-installed files into a per-agent image), the next boot finds
        # them present and skips this phase entirely — so we don't re-run apt or trigger a
        # redundant re-commit, and startup is fast.
        missing_apt = []
        for p in apt_pkgs:
            chk = subprocess.run(["dpkg", "-s", p], capture_output=True, text=True)
            if chk.returncode != 0:
                missing_apt.append(p)
        if missing_apt:
            _emit({"status": "installing", "phase": "apt", "packages": missing_apt})
            # Update package index first so packages can be found
            subprocess.run(["apt-get", "update", "-qq"], capture_output=True, text=True)
            r = subprocess.run(
                ["apt-get", "install", "-y", "--no-install-recommends"] + missing_apt,
                capture_output=True, text=True
            )
            if r.returncode != 0:
                _emit({"status": "failed", "phase": "apt", "error": r.stderr[-1000:]})
                return False

    if pip_pkgs:
        # Skip re-install if all packages are already present in the cache dir.
        # We write a lockfile listing the installed specs; if it matches, we're done.
        lock_path = os.path.join(_EXTRA_PKGS, '.install-lock')
        lock_key = '|'.join(sorted(pip_pkgs))
        cached = False
        if os.path.exists(lock_path):
            try:
                cached = open(lock_path).read().strip() == lock_key
            except Exception:
                pass

        if not cached:
            _emit({"status": "installing", "phase": "pip", "packages": pip_pkgs})
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--prefer-binary", "--target", _EXTRA_PKGS] + pip_pkgs,
                capture_output=True, text=True
            )
            if r.returncode != 0:
                _emit({"status": "failed", "phase": "pip", "error": r.stderr[-1000:]})
                return False
            try:
                with open(lock_path, 'w') as lf:
                    lf.write(lock_key)
            except Exception:
                pass

    _emit({"status": "ready"})
    return True


# ─── Injected helpers (available to all tool files) ──────────────────────────

# Holds the active call ID so helpers can emit events tied to the right call
_active_call_id: str = "unknown"


def emit_progress(message: str, percent: int = None) -> None:
    """Emit a progress event visible to the LLM during long-running operations."""
    obj: dict = {"id": _active_call_id, "status": "progress", "message": message}
    if percent is not None:
        obj["percent"] = percent
    _emit(obj)


def run_subprocess(cmd: list, cwd: str = None) -> str:
    """
    Run a shell command, stream stderr lines as progress events, and return
    combined stdout+stderr. Raises RuntimeError on non-zero exit code.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=cwd,
    )
    output_lines = []
    for line in proc.stdout:  # type: ignore
        stripped = line.rstrip()
        if stripped:
            output_lines.append(stripped)
            emit_progress(stripped[:200])   # cap line length for safety
    proc.wait()
    combined = "\n".join(output_lines)
    if proc.returncode != 0:
        raise RuntimeError(f"Command {cmd[0]} exited with code {proc.returncode}:\n{combined[-500:]}")
    return combined


# ─── Host RPC (Phase 3a) ──────────────────────────────────────────────────────
# Bidirectional bridge so a tool can call back into the agent's own powers. The tool
# emits a `host_call` line and blocks reading stdin for the matching `host_response`;
# the orchestrator (agent-sidecar.ts) permission-checks + serves it and writes the
# response back. The sidecar runs ONE tool at a time, so it owns stdin during the
# tool's execute() — safe to read the response inline here.
_host_seq = 0
_TOOL_DIR = "/workspace/group/tools"   # set by run_loop; used by host.call_tool for local lookup
_call_depth = 0                  # recursion guard for host.call_tool
_MAX_CALL_DEPTH = 3


def _host_call(method, args=None):
    global _host_seq
    _host_seq += 1
    host_id = f"h{_host_seq}"
    _emit({"type": "host_call", "host_id": host_id, "call_id": _active_call_id,
           "method": method, "args": args or {}})
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("sidecar stdin closed while awaiting host response")
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "host_response" and msg.get("host_id") == host_id:
            if msg.get("ok"):
                return msg.get("result")
            raise RuntimeError(msg.get("error") or "host call failed")
        # The sidecar runs one tool at a time, so any other line while we await our
        # response is unexpected — ignore and keep waiting for the matching host_id.


class _Host:
    """Brokered access to the agent's powers, injected into every tool as `host`.
    Each method is fulfilled by the orchestrator (permission-checked + logged)."""

    def search_memory(self, query, limit=20):
        """Search the agent's long-term memory. Returns a list of {type, content, relevance}."""
        return _host_call("search_memory", {"query": query, "limit": limit})

    def send_message(self, text):
        """Send a message to the operator. This is an external action, so it's QUEUED for
        operator approval (HITL) — returns a status note, not a delivery confirmation."""
        return _host_call("send_message", {"text": text})

    def handoff(self, to_agent, type, payload, note=""):
        """Hand off data/a task to another agent (by exact id or name). High-privilege
        agent-coordination → QUEUED for operator approval (HITL); delivered only once the
        operator approves. Requires the "handoff" capability. Returns a status note."""
        return _host_call("handoff", {
            "to_agent": to_agent, "type": type, "payload": payload, "note": note,
        })

    def call_tool(self, name, args=None):
        """Call another tool available in this sidecar by name and return its result.
        The orchestrator authorizes it (requires the "call_tool" capability; meta-tools
        are blocked; the call is audited); the target then runs locally in this sidecar,
        so there's no round-trip to the busy run-loop → no deadlock. Reaches other sidecar
        tools, not the agent's built-ins."""
        global _call_depth
        _host_call("call_tool", {"name": name})  # capability gate + meta-block + audit; raises if denied
        if _call_depth >= _MAX_CALL_DEPTH:
            raise RuntimeError(f"call_tool depth limit ({_MAX_CALL_DEPTH}) exceeded")
        instance, err = load_tool(name, _TOOL_DIR)
        if instance is None:
            raise RuntimeError(f"call_tool: tool '{name}' not available: {err}")
        import concurrent.futures
        _call_depth += 1
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                return ex.submit(lambda: asyncio.run(instance.execute(**(args or {})))).result()
        finally:
            _call_depth -= 1


host = _Host()


# ─── Tool loading ─────────────────────────────────────────────────────────────

def load_tool(tool_name: str, tool_dir: str):
    """Load a tool by name, supporting BOTH conventions in the same tools dir:

      • Orchestrator: flat ``<name>.py`` exporting a ``class …(Tool)``.
      • Factory:      ``<name>/`` folder with an entrypoint (``impl.py`` by default,
                      or ``entrypoint`` from manifest.yaml) defining ``main(**kwargs)``,
                      optionally with helper modules under the folder / ``src/``.
    """
    base = pathlib.Path(tool_dir)
    flat = base / f"{tool_name}.py"
    tool_root = None

    if flat.exists():
        entry_file = flat
    else:
        d = base / tool_name
        if not d.is_dir():
            return None, f"Tool not found: {flat} (and no '{tool_name}/' folder)"
        tool_root = d
        entrypoint = "impl.py"
        manifest_path = d / "manifest.yaml"
        if manifest_path.exists():
            try:
                entrypoint = json.loads(manifest_path.read_text(encoding="utf-8")).get("entrypoint") or "impl.py"
            except Exception:
                pass
        entry_file = d / entrypoint
        if not entry_file.exists():
            for alt in ("impl.py", "implementation.py", "main.py"):
                if (d / alt).exists():
                    entry_file = d / alt
                    break
        if not entry_file.exists():
            return None, f"Tool entrypoint not found in {d}"

    # Multi-file factory tools: make the folder (and its src/) importable so the
    # entrypoint's `import helper` / `from src... ` resolve.
    if tool_root is not None:
        for p in (str(tool_root), str(tool_root / "src")):
            if os.path.isdir(p) and p not in sys.path:
                sys.path.insert(0, p)

    spec = importlib.util.spec_from_file_location(tool_name, str(entry_file))
    mod = importlib.util.module_from_spec(spec)  # type: ignore
    # Inject base class and helpers — tools use these without importing
    mod.Tool = Tool                        # type: ignore
    mod.emit_progress = emit_progress      # type: ignore
    mod.run_subprocess = run_subprocess    # type: ignore
    mod.host = host                        # type: ignore  # Phase 3a — brokered host RPC
    try:
        spec.loader.exec_module(mod)  # type: ignore
    except Exception as exc:
        return None, f"Error loading tool file: {exc}"

    # 1. Class-based tool (orchestrator convention)
    for _, cls in inspect.getmembers(mod, inspect.isclass):
        if issubclass(cls, Tool) and cls is not Tool:
            try:
                return cls(), None
            except Exception as exc:
                return None, f"Error instantiating tool class: {exc}"

    # 2. main()-based tool (factory convention)
    main_fn = getattr(mod, "main", None)
    if callable(main_fn):
        return _MainAdapter(main_fn), None

    return None, "No Tool subclass or main() function found in tool file"


def _install_verify_deps(packages: list, language: str = "python"):
    """Install a candidate tool's declared deps during verification so the verify run uses
    the SAME install the tool will use at runtime. pip packages go to the cached volume
    (persist); `apt:`-prefixed system packages go via apt-get (re-applied at every startup
    by install_deps, since apt doesn't persist on the cache volume). Returns an error string
    on failure, else None."""
    if not packages:
        return None
    apt_pkgs = [p.split("apt:", 1)[1].strip() for p in packages if p.startswith("apt:")]
    pip_pkgs = [p for p in packages if not p.startswith("apt:")]

    # apt first — system libs that pip wheels may link against (e.g. tesseract for pytesseract).
    apt_pkgs = [p for p in apt_pkgs if p]
    if apt_pkgs:
        subprocess.run(["apt-get", "update", "-qq"], capture_output=True, text=True)
        r = subprocess.run(
            ["apt-get", "install", "-y", "--no-install-recommends"] + apt_pkgs,
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return ("apt install failed: " + (r.stderr or r.stdout or "unknown error"))[-1500:]

    if pip_pkgs and language == "python":
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--prefer-binary", "--target", _EXTRA_PKGS] + pip_pkgs,
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return (r.stderr or r.stdout or "pip install failed")[-1500:]
    return None


def run_verify(args: dict) -> dict:
    """Verify a CANDIDATE tool in the sidecar (Phase 2 / deferred-item #1 follow-up).

    A sidecar-tier tool's creation-time tests used to run in the throwaway cycle container,
    so heavy deps (torch, manim, …) were installed there and discarded. Running them HERE
    instead means the install lands on the persistent cache volume (reused at runtime) and
    the tool executes in the real isolation env — with `host`/`emit_progress`/`run_subprocess`
    injected — so capability tools verify correctly too.

    Returns one of:
      {"install_error": str}   deps couldn't be installed
      {"load_error": str}      the tool failed to load
      {"unsupported": str}     not runnable here (caller should fall back to local)
      {"results": [{success, output, error, execution_time_ms}, ...]}  per test case
    """
    files = args.get("files") or {}
    entrypoint = args.get("entrypoint") or "implementation.py"
    language = (args.get("language") or "python").lower()
    deps = args.get("dependencies") or []
    test_cases = args.get("test_cases") or []
    timeout = int(args.get("timeout") or 30)

    if language != "python":
        return {"unsupported": f"sidecar verify supports python only (got {language!r})"}

    err = _install_verify_deps(deps, language)
    if err:
        return {"install_error": err}

    import tempfile
    import time as _time
    tmp = tempfile.mkdtemp(prefix="verify_", dir="/workspace/group")
    cand_dir = os.path.join(tmp, "candidate")
    os.makedirs(cand_dir, exist_ok=True)
    try:
        # Lay out the candidate as a factory-style folder so load_tool's injection
        # (Tool base, host, emit_progress, run_subprocess) and entrypoint resolution apply.
        for rel, content in files.items():
            dest = os.path.join(cand_dir, rel)
            parent = os.path.dirname(dest)
            if parent and os.path.abspath(parent).startswith(os.path.abspath(cand_dir)):
                os.makedirs(parent, exist_ok=True)
            with open(dest, "w", encoding="utf-8") as f:
                f.write(content)
        with open(os.path.join(cand_dir, "manifest.yaml"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"entrypoint": entrypoint}))

        instance, load_err = load_tool("candidate", tmp)
        if instance is None:
            return {"load_error": load_err or "candidate tool failed to load"}

        results = []
        for tc in test_cases:
            inp = tc.get("input") or {}
            start = _time.time()
            try:
                out = asyncio.run(asyncio.wait_for(instance.execute(**inp), timeout))
                out = out if isinstance(out, str) else json.dumps(out)
                results.append({"success": True, "output": out, "error": None,
                                "execution_time_ms": int((_time.time() - start) * 1000)})
            except asyncio.TimeoutError:
                results.append({"success": False, "output": "", "error": f"Execution timed out after {timeout}s",
                                "execution_time_ms": int((_time.time() - start) * 1000)})
            except Exception as exc:
                results.append({"success": False, "output": "", "error": str(exc),
                                "execution_time_ms": int((_time.time() - start) * 1000)})
        return {"results": results}
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _tool_source_mtime(tool_name: str, tool_dir: str) -> float:
    """Newest mtime among a tool's source files (flat <name>.py or <name>/ folder + manifest).
    Used to invalidate the run-loop cache when update_tool rewrites a tool on disk — otherwise
    a long-lived sidecar keeps serving the STALE cached version and update_tool silently no-ops."""
    base = pathlib.Path(tool_dir)
    paths = []
    flat = base / f"{tool_name}.py"
    if flat.exists():
        paths.append(flat)
    d = base / tool_name
    if d.is_dir():
        paths.extend(d.rglob("*.py"))
        mf = d / "manifest.yaml"
        if mf.exists():
            paths.append(mf)
    mt = 0.0
    for p in paths:
        try:
            mt = max(mt, p.stat().st_mtime)
        except OSError:
            pass
    return mt


def run_loop(tool_dir: str) -> None:
    global _active_call_id, _TOOL_DIR
    _TOOL_DIR = tool_dir
    tool_cache: dict = {}   # tool_name -> (instance, load_err, source_mtime)

    # readline() (not `for line in sys.stdin`) so the iterator's read-ahead buffer
    # doesn't swallow host_response lines that _host_call reads mid-tool-execution.
    while True:
        raw_line = sys.stdin.readline()
        if not raw_line:
            break
        line = raw_line.strip()
        if not line:
            continue

        call_id = "unknown"
        try:
            req = json.loads(line)
            call_id = req.get("id", "unknown")
            _active_call_id = call_id
            tool_name = req.get("tool", "")
            args = req.get("args", {})

            # Control verb: verify a candidate tool (deps install + test runs) in-place,
            # so heavy-dep installs land on the cached volume instead of the cycle container.
            if tool_name == "__verify__":
                _emit({"id": call_id, "status": "ok", "result": json.dumps(run_verify(args))})
                continue

            # Reload if the tool isn't cached OR its source changed on disk (update_tool /
            # rollback). Without the mtime check, a warm sidecar serves the stale version forever.
            cur_mtime = _tool_source_mtime(tool_name, tool_dir)
            cached = tool_cache.get(tool_name)
            if cached is None or cached[2] < cur_mtime:
                inst, err = load_tool(tool_name, tool_dir)
                tool_cache[tool_name] = (inst, err, cur_mtime)

            instance, load_err, _ = tool_cache[tool_name]
            if instance is None:
                _emit({"id": call_id, "status": "error", "error": load_err or f"Tool '{tool_name}' could not be loaded"})
                continue

            result = asyncio.run(instance.execute(**args))
            _emit({"id": call_id, "status": "ok", "result": result})

        except json.JSONDecodeError as exc:
            _emit({"id": call_id, "status": "error", "error": f"Invalid JSON input: {exc}"})
        except Exception as exc:
            _emit({"id": call_id, "status": "error", "error": str(exc)})


if __name__ == "__main__":
    tool_dir = os.environ.get("TOOL_DIR", "/workspace/group/tools")
    os.makedirs(tool_dir, exist_ok=True)
    if install_deps():
        run_loop(tool_dir)
