"""github_api — GitHub REST API tool: repos, issues, PRs, comments, branches."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool

_GH_API = "https://api.github.com"
_DEFAULT_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def _token() -> str | None:
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


def _auth_headers(token: str) -> dict[str, str]:
    return {**_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}


def _err(msg: str) -> str:
    return json.dumps({"error": msg})


class GitHubAPITool(Tool):
    """Interact with GitHub: repos, issues, PRs, comments, branches, file contents."""

    @property
    def required_permission(self) -> "Any":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "github_api"

    @property
    def description(self) -> str:
        return (
            "Interact with the GitHub API. Supports: list/get/create/close issues and PRs, "
            "add comments, list repos and branches, get file contents, create branches, "
            "get commit history, and search code/issues. "
            "Requires GITHUB_TOKEN env var (personal access token or fine-grained PAT)."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list_repos",
                        "get_repo",
                        "list_issues",
                        "get_issue",
                        "create_issue",
                        "close_issue",
                        "list_prs",
                        "get_pr",
                        "create_pr",
                        "merge_pr",
                        "add_comment",
                        "list_branches",
                        "get_file",
                        "list_commits",
                        "search_issues",
                        "search_code",
                    ],
                    "description": "The GitHub operation to perform.",
                },
                "owner": {
                    "type": "string",
                    "description": "Repository owner (user or org). Required for most actions.",
                },
                "repo": {
                    "type": "string",
                    "description": "Repository name. Required for most actions.",
                },
                "number": {
                    "type": "integer",
                    "description": "Issue or PR number. Required for get/close/comment/merge actions.",
                },
                "title": {
                    "type": "string",
                    "description": "Title for create_issue or create_pr.",
                },
                "body": {
                    "type": "string",
                    "description": "Body text for create_issue, create_pr, or add_comment.",
                },
                "head": {
                    "type": "string",
                    "description": "Head branch for create_pr (e.g. 'feature/my-branch').",
                },
                "base": {
                    "type": "string",
                    "description": "Base branch for create_pr (default 'main').",
                },
                "labels": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Labels for create_issue.",
                },
                "path": {
                    "type": "string",
                    "description": "File path in repo for get_file.",
                },
                "ref": {
                    "type": "string",
                    "description": "Branch/tag/commit for get_file or list_commits (default: default branch).",
                },
                "query": {
                    "type": "string",
                    "description": "Search query for search_issues or search_code.",
                },
                "state": {
                    "type": "string",
                    "enum": ["open", "closed", "all"],
                    "description": "Filter issues/PRs by state (default 'open').",
                    "default": "open",
                },
                "per_page": {
                    "type": "integer",
                    "description": "Results per page (max 30, default 20).",
                    "default": 20,
                },
            },
            "required": ["action"],
        }

    async def execute(self, action: str, **kwargs: Any) -> str:
        token = _token()
        if not token:
            return _err(
                "GITHUB_TOKEN (or GH_TOKEN) environment variable not set. "
                "Create a personal access token at https://github.com/settings/tokens and set it."
            )

        headers = _auth_headers(token)
        per_page = min(int(kwargs.get("per_page", 20)), 30)

        async with httpx.AsyncClient(headers=headers, timeout=30) as client:
            try:
                return await self._dispatch(client, action, per_page, **kwargs)
            except httpx.HTTPStatusError as exc:
                try:
                    detail = exc.response.json().get("message", exc.response.text[:300])
                except Exception:
                    detail = exc.response.text[:300]
                return _err(f"GitHub API {exc.response.status_code}: {detail}")
            except Exception as exc:
                return _err(str(exc))

    async def _dispatch(
        self, client: httpx.AsyncClient, action: str, per_page: int, **kw: Any
    ) -> str:
        owner = kw.get("owner", "")
        repo = kw.get("repo", "")
        number = kw.get("number")
        state = kw.get("state", "open")

        def _repo_required() -> str | None:
            if not owner or not repo:
                return _err(f"'owner' and 'repo' are required for action '{action}'")
            return None

        # ── Repos ────────────────────────────────────────────────────────────
        if action == "list_repos":
            r = await client.get(f"{_GH_API}/user/repos", params={"per_page": per_page, "sort": "updated"})
            r.raise_for_status()
            items = r.json()
            return json.dumps([{"full_name": x["full_name"], "description": x.get("description"), "private": x["private"], "updated_at": x["updated_at"]} for x in items], indent=2)

        if action == "get_repo":
            if e := _repo_required(): return e
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}")
            r.raise_for_status()
            d = r.json()
            return json.dumps({"full_name": d["full_name"], "description": d.get("description"), "default_branch": d["default_branch"], "stars": d["stargazers_count"], "open_issues": d["open_issues_count"], "url": d["html_url"]}, indent=2)

        # ── Issues ───────────────────────────────────────────────────────────
        if action == "list_issues":
            if e := _repo_required(): return e
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/issues", params={"state": state, "per_page": per_page})
            r.raise_for_status()
            items = [i for i in r.json() if "pull_request" not in i]  # exclude PRs
            return json.dumps([{"number": x["number"], "title": x["title"], "state": x["state"], "labels": [l["name"] for l in x["labels"]], "created_at": x["created_at"]} for x in items], indent=2)

        if action == "get_issue":
            if e := _repo_required(): return e
            if not number: return _err("'number' is required for get_issue")
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/issues/{number}")
            r.raise_for_status()
            d = r.json()
            return json.dumps({"number": d["number"], "title": d["title"], "state": d["state"], "body": (d.get("body") or "")[:2000], "labels": [l["name"] for l in d["labels"]], "user": d["user"]["login"], "created_at": d["created_at"], "url": d["html_url"]}, indent=2)

        if action == "create_issue":
            if e := _repo_required(): return e
            if not kw.get("title"): return _err("'title' is required for create_issue")
            payload: dict[str, Any] = {"title": kw["title"]}
            if kw.get("body"): payload["body"] = kw["body"]
            if kw.get("labels"): payload["labels"] = kw["labels"]
            r = await client.post(f"{_GH_API}/repos/{owner}/{repo}/issues", json=payload)
            r.raise_for_status()
            d = r.json()
            return json.dumps({"number": d["number"], "url": d["html_url"], "title": d["title"]}, indent=2)

        if action == "close_issue":
            if e := _repo_required(): return e
            if not number: return _err("'number' is required for close_issue")
            r = await client.patch(f"{_GH_API}/repos/{owner}/{repo}/issues/{number}", json={"state": "closed"})
            r.raise_for_status()
            return json.dumps({"closed": True, "number": number})

        # ── Pull Requests ────────────────────────────────────────────────────
        if action == "list_prs":
            if e := _repo_required(): return e
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/pulls", params={"state": state, "per_page": per_page})
            r.raise_for_status()
            return json.dumps([{"number": x["number"], "title": x["title"], "state": x["state"], "head": x["head"]["ref"], "base": x["base"]["ref"], "created_at": x["created_at"]} for x in r.json()], indent=2)

        if action == "get_pr":
            if e := _repo_required(): return e
            if not number: return _err("'number' is required for get_pr")
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/pulls/{number}")
            r.raise_for_status()
            d = r.json()
            return json.dumps({"number": d["number"], "title": d["title"], "state": d["state"], "body": (d.get("body") or "")[:2000], "head": d["head"]["ref"], "base": d["base"]["ref"], "mergeable": d.get("mergeable"), "url": d["html_url"]}, indent=2)

        if action == "create_pr":
            if e := _repo_required(): return e
            for req_field in ("title", "head"):
                if not kw.get(req_field):
                    return _err(f"'{req_field}' is required for create_pr")
            payload = {"title": kw["title"], "head": kw["head"], "base": kw.get("base", "main")}
            if kw.get("body"): payload["body"] = kw["body"]
            r = await client.post(f"{_GH_API}/repos/{owner}/{repo}/pulls", json=payload)
            r.raise_for_status()
            d = r.json()
            return json.dumps({"number": d["number"], "url": d["html_url"], "title": d["title"]}, indent=2)

        if action == "merge_pr":
            if e := _repo_required(): return e
            if not number: return _err("'number' is required for merge_pr")
            r = await client.put(f"{_GH_API}/repos/{owner}/{repo}/pulls/{number}/merge", json={"merge_method": "squash"})
            r.raise_for_status()
            d = r.json()
            return json.dumps({"merged": d.get("merged", True), "sha": d.get("sha"), "message": d.get("message")}, indent=2)

        # ── Comments ─────────────────────────────────────────────────────────
        if action == "add_comment":
            if e := _repo_required(): return e
            if not number: return _err("'number' is required for add_comment")
            if not kw.get("body"): return _err("'body' is required for add_comment")
            r = await client.post(f"{_GH_API}/repos/{owner}/{repo}/issues/{number}/comments", json={"body": kw["body"]})
            r.raise_for_status()
            d = r.json()
            return json.dumps({"comment_id": d["id"], "url": d["html_url"]}, indent=2)

        # ── Branches & Files ─────────────────────────────────────────────────
        if action == "list_branches":
            if e := _repo_required(): return e
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/branches", params={"per_page": per_page})
            r.raise_for_status()
            return json.dumps([{"name": b["name"], "sha": b["commit"]["sha"][:8]} for b in r.json()], indent=2)

        if action == "get_file":
            if e := _repo_required(): return e
            if not kw.get("path"): return _err("'path' is required for get_file")
            params: dict[str, str] = {}
            if kw.get("ref"): params["ref"] = kw["ref"]
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/contents/{kw['path']}", params=params)
            r.raise_for_status()
            d = r.json()
            if isinstance(d, list):
                return json.dumps([{"name": x["name"], "type": x["type"], "size": x.get("size")} for x in d], indent=2)
            import base64
            content = base64.b64decode(d["content"]).decode("utf-8", errors="replace")
            if len(content) > 8000:
                content = content[:8000] + "\n[truncated]"
            return json.dumps({"path": d["path"], "sha": d["sha"], "content": content}, indent=2)

        if action == "list_commits":
            if e := _repo_required(): return e
            params2: dict[str, Any] = {"per_page": per_page}
            if kw.get("ref"): params2["sha"] = kw["ref"]
            r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/commits", params=params2)
            r.raise_for_status()
            return json.dumps([{"sha": c["sha"][:8], "message": c["commit"]["message"].split("\n")[0], "author": c["commit"]["author"]["name"], "date": c["commit"]["author"]["date"]} for c in r.json()], indent=2)

        # ── Search ───────────────────────────────────────────────────────────
        if action == "search_issues":
            if not kw.get("query"): return _err("'query' is required for search_issues")
            q = kw["query"]
            if owner and repo: q += f" repo:{owner}/{repo}"
            r = await client.get(f"{_GH_API}/search/issues", params={"q": q, "per_page": per_page})
            r.raise_for_status()
            items = r.json().get("items", [])
            return json.dumps([{"number": x["number"], "title": x["title"], "state": x["state"], "url": x["html_url"]} for x in items], indent=2)

        if action == "search_code":
            if not kw.get("query"): return _err("'query' is required for search_code")
            q = kw["query"]
            if owner and repo: q += f" repo:{owner}/{repo}"
            r = await client.get(f"{_GH_API}/search/code", params={"q": q, "per_page": per_page})
            r.raise_for_status()
            items = r.json().get("items", [])
            return json.dumps([{"name": x["name"], "path": x["path"], "repo": x["repository"]["full_name"], "url": x["html_url"]} for x in items], indent=2)

        return _err(f"Unknown action: '{action}'")
