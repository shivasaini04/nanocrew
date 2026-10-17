"""Persistence layer for dynamically generated tools."""

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional, Any

from loguru import logger
from nanoagent.agent.tools.dynamic.manifest import ToolManifest
from nanoagent.agent.tools.dynamic.pipeline import Pipeline
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from nanoagent.agent.tools.dynamic.test_runner import TestRunResult


class ToolPersistence:
    """
    Handles saving, loading, and deleting dynamic tools from disk.
    
    Structure:
    tools_dir/
      {tool_name}/
        manifest.yaml      # ToolManifest as JSON (YAML compatible)
        impl.py            # The tool's implementation code
        test_results.json  # Latest test results
        history.json       # Version history log
    """

    def __init__(self, tools_dir: Path):
        self.tools_dir = tools_dir
        self.tools_dir.mkdir(parents=True, exist_ok=True)

    def _get_tool_path(self, tool_name: str, job_id: Optional[str] = None) -> Path:
        """
        Determines the path for a tool.
        If job_id is provided, looks in the job-specific tools directory.
        Otherwise, looks in the global tools directory.
        """
        if job_id:
            # workspace/jobs/{job_id}/tools/{tool_name}
            job_tools_dir = self.tools_dir.parent / "jobs" / job_id / "tools"
            job_tools_dir.mkdir(parents=True, exist_ok=True)
            return job_tools_dir / tool_name
        
        # Global: workspace/tools/{tool_name}
        return self.tools_dir / tool_name

    def save(self, manifest: ToolManifest, test_result: Optional["TestRunResult"] = None) -> Path:
        """
        Saves a tool's manifest and implementation to disk, including a version snapshot.
        """
        tool_path = self._get_tool_path(manifest.name, job_id=manifest.job_scope)
        tool_path.mkdir(parents=True, exist_ok=True)
        
        # 1. Versioned Snapshot folder
        version_dir = tool_path / "versions" / manifest.version
        version_dir.mkdir(parents=True, exist_ok=True)

        # 2. Save manifest.yaml (main + versioned)
        for path in [tool_path / "manifest.yaml", version_dir / "manifest.yaml"]:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(manifest.to_dict(), f, indent=2)

        # 3. Save impl file (main + versioned)
        ext = "py" if manifest.language == "python" else "js" if manifest.language in ("javascript", "typescript") else "sh"
        impl_name = f"impl.{ext}"
        for path in [tool_path / impl_name, version_dir / impl_name]:
            with open(path, "w", encoding="utf-8") as f:
                f.write(manifest.implementation)

        # 3b. Multi-file tools: also write every file in the set to disk (main + versioned)
        # so the full structure is visible/inspectable — not just the entrypoint.
        if manifest.files and set(manifest.files) != {impl_name}:
            for base in (tool_path / "src", version_dir / "src"):
                for rel, content in manifest.files.items():
                    dest = base / rel
                    if base.resolve() in dest.resolve().parents or dest.resolve() == base.resolve():
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        with open(dest, "w", encoding="utf-8") as f:
                            f.write(content)

        # 4. Initialize/Update history.json
        history_file = tool_path / "history.json"
        history = []
        if history_file.exists():
            try:
                with open(history_file, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except: pass
        
        # Avoid duplicate history entries for same version during re-saves
        if not any(h.get("version") == manifest.version for h in history):
            history.append({
                "version": manifest.version,
                "created_at": manifest.created_at,
                "action": "created" if not history else "updated"
            })
            with open(history_file, "w", encoding="utf-8") as f:
                json.dump(history, f, indent=2)

        # 5. Save test_results.json
        results_file = tool_path / "test_results.json"
        if test_result:
            with open(results_file, "w", encoding="utf-8") as f:
                json.dump(test_result.to_dict(), f, indent=2)
        
        logger.info(f"Saved tool '{manifest.name}' v{manifest.version} to {tool_path}")
        return tool_path

    def load(self, tool_name: str, job_id: Optional[str] = None) -> Optional[ToolManifest]:
        """Loads a ToolManifest from disk by name and job_id."""
        tool_path = self._get_tool_path(tool_name, job_id=job_id)
        manifest_file = tool_path / "manifest.yaml"

        if not manifest_file.exists():
            # If not in job-specific, check global if job_id was provided
            if job_id:
                tool_path = self._get_tool_path(tool_name)
                manifest_file = tool_path / "manifest.yaml"
                if not manifest_file.exists():
                    return None
            else:
                return None

        try:
            with open(manifest_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return ToolManifest.from_dict(data)
        except Exception as e:
            logger.error(f"Failed to load manifest for tool '{tool_name}': {e}")
            return None

    def load_all(self, job_id: Optional[str] = None) -> list[ToolManifest]:
        """
        Loads all persisted tools.
        If job_id is provided, loads both Global and job-specific tools.
        """
        tools = []
        
        # 1. Load Global Tools
        if self.tools_dir.exists():
            for tool_dir in self.tools_dir.iterdir():
                if tool_dir.is_dir():
                    manifest = self.load(tool_dir.name)
                    if manifest:
                        tools.append(manifest)
        
        # 2. Load Job-specific Tools
        if job_id:
            job_tools_root = self.tools_dir.parent / "jobs" / job_id / "tools"
            if job_tools_root.exists():
                for tool_dir in job_tools_root.iterdir():
                    if tool_dir.is_dir():
                        # Use job_id to ensure we load from the right spot
                        manifest = self.load(tool_dir.name, job_id=job_id)
                        if manifest:
                            # Avoid duplicates if a tool exists in both (though shouldn't happen with proper management)
                            if not any(t.name == manifest.name for t in tools):
                                tools.append(manifest)
        
        return tools

    def delete(self, tool_name: str, job_id: Optional[str] = None) -> bool:
        """Deletes a tool's persistence directory."""
        tool_path = self._get_tool_path(tool_name, job_id=job_id)
        if tool_path.exists() and tool_path.is_dir():
            shutil.rmtree(tool_path)
            logger.info(f"Deleted tool persistence for '{tool_name}' (job={job_id})")
            return True
        return False

    def exists(self, tool_name: str, job_id: Optional[str] = None) -> bool:
        """Checks if a tool is persisted on disk (global or specific job)."""
        return (self._get_tool_path(tool_name, job_id=job_id) / "manifest.yaml").exists()

    async def update(self, manifest: ToolManifest, test_result: Optional["TestRunResult"] = None, reason: Optional[str] = None, bump_type: str = "patch") -> Path:
        """
        Updates an existing tool, archiving the old version in history.
        bump_type: "patch", "minor", or "major".
        """
        old_manifest = self.load(manifest.name, job_id=manifest.job_scope)
        if old_manifest:
            # Increment version based on bump_type
            manifest.version = self._bump_version(old_manifest.version, bump_type)
        
        tool_path = self.save(manifest, test_result=test_result)
        
        # Update history with reason
        history_file = tool_path / "history.json"
        if history_file.exists():
            try:
                with open(history_file, "r", encoding="utf-8") as f:
                    history = json.load(f)
                
                # The 'save' method already added a 'updated' entry, let's decorate it
                for entry in reversed(history):
                    if entry.get("version") == manifest.version:
                        entry["reason"] = reason or "No reason provided"
                        break
                
                with open(history_file, "w", encoding="utf-8") as f:
                    json.dump(history, f, indent=2)
            except: pass

        return tool_path

    def rollback(self, tool_name: str, version: Optional[str] = None, job_id: Optional[str] = None) -> Optional[ToolManifest]:
        """
        Rolls back a tool to a specific version by restoring files from the versions/ folder.
        """
        tool_path = self._get_tool_path(tool_name, job_id=job_id)
        history_path = tool_path / "history.json"
        if not history_path.exists():
            return None

        with open(history_path, "r", encoding="utf-8") as f:
            history = json.load(f)

        if not history:
            return None

        # Find target version
        target_version = version
        if not target_version:
            # Rollback to the immediate previous version
            current_manifest = self.load(tool_name, job_id=job_id)
            curr_v = current_manifest.version if current_manifest else None
            for entry in reversed(history):
                if entry.get("version") != curr_v:
                    target_version = entry.get("version")
                    break
        
        if not target_version:
            return None

        version_dir = tool_path / "versions" / target_version
        if not (version_dir / "manifest.yaml").exists():
            logger.error(f"Cannot rollback tool '{tool_name}': Version folder {target_version} missing manifest.")
            return None

        # Restore files: Copy manifest.yaml and impl.* from versions folder to tool root
        shutil.copy(version_dir / "manifest.yaml", tool_path / "manifest.yaml")
        
        # Find and copy implementation file
        for impl_file in version_dir.glob("impl.*"):
            shutil.copy(impl_file, tool_path / impl_file.name)

        # Log rollback in history
        history.append({
            "version": target_version,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "action": "rolled_back",
            "reason": f"Restored {target_version}"
        })
        with open(history_path, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)

        return self.load(tool_name, job_id=job_id)

    def _bump_version(self, version: str, bump_type: str) -> str:
        """Bumps semantic version string."""
        parts = version.split(".")
        if len(parts) != 3: return version
        
        try:
            major, minor, patch = map(int, parts)
            if bump_type == "major":
                major += 1
                minor = 0
                patch = 0
            elif bump_type == "minor":
                minor += 1
                patch = 0
            else: # patch
                patch += 1
            return f"{major}.{minor}.{patch}"
        except ValueError:
            return version


class PipelinePersistence:
    """
    Handles saving, loading, and deleting dynamic pipelines from disk.
    
    Structure:
    pipelines_dir/
      {pipeline_name}.json
    """
    def __init__(self, pipelines_dir: Path):
        self.pipelines_dir = pipelines_dir
        self.pipelines_dir.mkdir(parents=True, exist_ok=True)
        
    def _get_pipeline_path(self, pipeline_name: str, job_id: Optional[str] = None) -> Path:
        if job_id:
            job_pipelines_dir = self.pipelines_dir.parent / "jobs" / job_id / "pipelines"
            job_pipelines_dir.mkdir(parents=True, exist_ok=True)
            return job_pipelines_dir / f"{pipeline_name}.json"
        
        return self.pipelines_dir / f"{pipeline_name}.json"

    def save(self, pipeline: Pipeline, job_id: Optional[str] = None) -> Path:
        pipeline_path = self._get_pipeline_path(pipeline.name, job_id=job_id)
        
        with open(pipeline_path, "w", encoding="utf-8") as f:
            json.dump(pipeline.to_dict(), f, indent=2)
            
        logger.info(f"Saved pipeline '{pipeline.name}' to {pipeline_path}")
        return pipeline_path

    def load(self, pipeline_name: str, job_id: Optional[str] = None) -> Optional[Pipeline]:
        pipeline_path = self._get_pipeline_path(pipeline_name, job_id=job_id)
        
        if not pipeline_path.exists():
            if job_id:
                pipeline_path = self._get_pipeline_path(pipeline_name)
                if not pipeline_path.exists():
                    return None
            else:
                return None
                
        try:
            with open(pipeline_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return Pipeline.from_dict(data)
        except Exception as e:
            logger.error(f"Failed to load pipeline '{pipeline_name}': {e}")
            return None

    def load_all(self, job_id: Optional[str] = None) -> list[Pipeline]:
        pipelines = []
        
        if self.pipelines_dir.exists():
            for p_file in self.pipelines_dir.glob("*.json"):
                pipeline = self.load(p_file.stem)
                if pipeline:
                    pipelines.append(pipeline)
                    
        if job_id:
            job_pipelines_root = self.pipelines_dir.parent / "jobs" / job_id / "pipelines"
            if job_pipelines_root.exists():
                for p_file in job_pipelines_root.glob("*.json"):
                    pipeline = self.load(p_file.stem, job_id=job_id)
                    if pipeline:
                        if not any(p.name == pipeline.name for p in pipelines):
                            pipelines.append(pipeline)
                            
        return pipelines

    def delete(self, pipeline_name: str, job_id: Optional[str] = None) -> bool:
        pipeline_path = self._get_pipeline_path(pipeline_name, job_id=job_id)
        if pipeline_path.exists():
            pipeline_path.unlink()
            logger.info(f"Deleted pipeline '{pipeline_name}' (job={job_id})")
            return True
        return False
