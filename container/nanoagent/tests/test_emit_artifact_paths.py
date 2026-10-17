"""emit_artifact must store a path the orchestrator can serve.

The manifest's `file` is joined onto the agent's folder by the orchestrator. Models write
to, and then register, the absolute path they just used (`/workspace/group/workspace/x`);
stored as-is it resolves to nothing, so the artifact is listed and never opens.
"""
import json
from pathlib import Path

import pytest

from nanoagent.agent.tools import emit_artifact as mod
from nanoagent.agent.tools.emit_artifact import EmitArtifactTool


@pytest.fixture
def group(tmp_path, monkeypatch):
    """Redirect /workspace/group to a temp dir for the duration of a test."""
    real_path = mod.Path

    def fake_path(p, *rest):
        s = str(p)
        if s.startswith("/workspace/group"):
            s = str(tmp_path) + s[len("/workspace/group"):]
        return real_path(s, *rest)

    monkeypatch.setattr(mod, "Path", fake_path)
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "checklist.html").write_text("<!DOCTYPE html><title>x</title>")
    return tmp_path


@pytest.mark.asyncio
@pytest.mark.parametrize("given", [
    "/workspace/group/workspace/checklist.html",
    "workspace/checklist.html",
])
async def test_manifest_stores_a_path_relative_to_the_group_folder(group, given):
    out = json.loads(await EmitArtifactTool().execute(file=given, type="page", title="Checklist"))
    assert out["file"] == "workspace/checklist.html"
    manifest = json.loads((group / "workspace" / "artifacts.json").read_text())
    assert manifest["artifacts"][0]["file"] == "workspace/checklist.html"
    assert manifest["artifacts"][0]["type"] == "page"


@pytest.mark.asyncio
async def test_a_missing_file_is_refused(group):
    out = json.loads(await EmitArtifactTool().execute(file="workspace/nope.html", type="page", title="x"))
    assert "error" in out
