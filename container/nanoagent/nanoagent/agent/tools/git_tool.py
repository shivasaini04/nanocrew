"""git_tool — structured git operations for code-aware agents.

Stage 29 (Devin mode), piece 1 of 4: make push actually work, and make it safe.

Before this, the tool could build a `git push` command but had **no credential handling
at all** — the push would fail on any private remote, and `git commit` would fail outright
with "please tell me who you are" because no identity was configured either. Those are the
two things that stop an agent doing real work on a repo.

Three decisions worth knowing before changing this file:

1. **The token never touches disk in the repo.** The obvious approaches — rewriting the
   remote to `https://<token>@github.com/...`, or `git config credential.helper store` —
   both persist the token inside the working copy, where it survives the cycle, lands in
   `.git/config`, and can be committed or copied out. Instead we hand git a one-shot
   `GIT_ASKPASS` helper in a private temp file, mode 0600, deleted after the call, and
   explicitly disable any inherited credential helper with `-c credential.helper=`.

2. **Identity is passed per-command, not written to config.** `-c user.name=... -c
   user.email=...` keeps the repo's own config untouched, so nothing we do leaks into a
   commit the operator later inspects.

3. **Protected branches are refused here, not discouraged in a prompt.** The agent works
   on a branch and opens a PR; a human merges. This is the whole blast-radius story: a bad
   change costs a click to close, not a rollback of production. It is enforced mechanically
   for the reason everything else in this codebase is — six times out of six in stage 37,
   prose instructions lost and tool refusals held. `--force` is not reachable at all: there
   is no parameter for it, and asking for one is refused with an explanation.

Piece 2 adds the commit gate, and its shape is the important part. The spec words it as
"the agent must verify the build passes" — an instruction, and instructions lose. So the
commit path **runs the build itself**: there is no "did you build?" flag to set, no state to
go stale between building and committing, and nothing to forget. Broken code cannot reach a
commit object because the only route to one runs the build first.

The same call refuses a staged diff containing secrets. An agent with write access to a repo
will eventually stage a `.env`; the cheapest place to stop that is before the commit exists,
because afterwards it is in history and rewriting history is exactly what agents may not do.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.credentials import get_credential

_DEFAULT_CWD = "/workspace/group/workspace"
_TIMEOUT = 30
# Network operations are far slower than local ones — a push of a cold repo over a
# datacentre link routinely exceeds the 30s that suffices for `git log`.
_NET_TIMEOUT = 180

# Clone targets. HTTPS GitHub only: SSH needs key management and other hosts need their own
# auth story, so refusing clearly beats half-supporting them.
_REPO_URL_RE = re.compile(r"^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+?(?:\.git)?$")
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# A cold clone of a real project pulls far more than a push does.
_CLONE_TIMEOUT = int(os.environ.get("GIT_CLONE_TIMEOUT", "600"))

# Branches an agent may never push to. Overridable to add more, never to remove:
# whatever the operator sets, main and master stay protected.
_ALWAYS_PROTECTED = {"main", "master", "production", "prod", "release"}


# A build is minutes, not seconds. Separate from every other limit here.
_BUILD_TIMEOUT = int(os.environ.get("GIT_BUILD_TIMEOUT", "900"))

# ── Secret scanning ──────────────────────────────────────────────────────────
# Matched against the STAGED diff, so it fires before a commit object exists. Rewriting
# history is precisely what an agent is not allowed to do, so "catch it afterwards" is not
# an option — afterwards is already too late.
# STRONG — provider-specific formats that are secrets by shape. Never suppressed by the
# placeholder allowlist. The first version applied that allowlist to every pattern, and the
# test caught the consequence immediately: `AKIAIOSFODNN7EXAMPLE` sailed through because the
# line contained the word "example". Appending "# example" to any line would have bypassed
# the whole scanner — a check that anyone can talk their way past is not a check.
_STRONG_SECRET_PATTERNS: list[tuple[str, str]] = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key id"),
    (r"\bgh[pousr]_[A-Za-z0-9]{30,}", "GitHub token"),
    (r"\bsk-[A-Za-z0-9]{20,}", "OpenAI-style secret key"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"\bAIza[0-9A-Za-z_\-]{35}\b", "Google API key"),
]

# WEAK — shape alone proves nothing (`API_KEY = "..."` is as likely a template as a leak),
# so these DO respect the placeholder allowlist. Getting this wrong in the noisy direction
# is its own failure: a scanner that fires on every .env.example teaches the agent to route
# around it.
_WEAK_SECRET_PATTERNS: list[tuple[str, str]] = [
    (r"(?i)\b(secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?token)\b"
     r"\s*[:=]\s*['\"]?[A-Za-z0-9/+=_\-]{16,}", "credential-shaped assignment"),
]

# Values that look like secrets but are placeholders. Applies to WEAK patterns only.
_PLACEHOLDER = re.compile(
    r"(?i)(your[_-]?|example|placeholder|changeme|dummy|xxx+|\.\.\.|<[^>]+>|"
    r"sample|replace[_-]?me|todo|fake|test[_-]?key)"
)
# Files whose whole purpose is to show the shape of a secret.
_TEMPLATE_FILE = re.compile(r"(?i)\.(example|sample|template|dist)$|(^|/)\.env\.example$")
# Files that should never be committed at all, whatever their contents.
_FORBIDDEN_FILE = re.compile(r"(?i)(^|/)\.env(\.[a-z]+)?$|(^|/)id_(rsa|dsa|ecdsa|ed25519)$|"
                             r"\.(pem|p12|pfx|keystore)$|(^|/)\.npmrc$")


def _protected_branches() -> set[str]:
    extra = {b.strip() for b in os.environ.get("GIT_PROTECTED_BRANCHES", "").split(",") if b.strip()}
    return _ALWAYS_PROTECTED | extra


def _token() -> str | None:
    """The GitHub token, from an agent secret or the credential store."""
    return (
        os.environ.get("GITHUB_TOKEN")
        or os.environ.get("GH_TOKEN")
        or get_credential("github", "token")
    )


def _identity() -> tuple[str, str]:
    return (
        os.environ.get("GIT_AUTHOR_NAME") or "NanoCrew Agent",
        os.environ.get("GIT_AUTHOR_EMAIL") or "agent@nanocrew.local",
    )


class GitTool(Tool):
    """Run git operations on a repository inside the agent workspace."""

    @property
    def name(self) -> str:
        return "git"

    @property
    def description(self) -> str:
        return (
            "Run git operations on a repository. Use 'clone' to fetch a GitHub repo into your "
            "workspace and then work on it there — no separate setup is needed, just a "
            "GITHUB_TOKEN secret. Also reads history, stages, commits, branches and pushes. "
            "By default operates on "
            "/workspace/group/workspace — pass cwd to target a different path "
            "(e.g. /workspace/repo for a mounted external repo). "
            "Pushing to main/master is refused: work on a branch and open a pull request. "
            "Push and pull authenticate with the project's GitHub token when one is "
            "configured; without it, only local operations will work."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": [
                        "clone", "status", "log", "diff", "stage", "commit",
                        "create_branch", "checkout", "push", "pull",
                        "show", "blame", "current_branch",
                    ],
                    "description": "Git operation to perform.",
                },
                "args": {
                    "type": "object",
                    "description": (
                        "Operation-specific arguments. For 'clone': `url` (https GitHub), optional `name` (directory) and `branch`. For 'commit': `message` (required), "
                        "`files` (optional, staged first), and `build_command` to override "
                        "the detected build. Committing runs the project's build first and "
                        "refuses if it fails or if the staged diff contains secrets — there "
                        "is no flag to skip either check."
                    ),
                },
                "cwd": {
                    "type": "string",
                    "description": (
                        "Working directory for the git command. "
                        "Default: /workspace/group/workspace. "
                        "Use /workspace/repo for a mounted external repo."
                    ),
                },
            },
            "required": ["operation"],
        }

    # ── auth plumbing ─────────────────────────────────────────────────────────

    @staticmethod
    def _askpass_file(token: str) -> str:
        """A throwaway GIT_ASKPASS helper that answers git's credential prompts.

        git asks twice over HTTPS — once for a username, once for a password — passing the
        prompt text as argv[1]. `x-access-token` is GitHub's accepted username for a PAT.
        Written 0600 and removed by the caller; the token is never written into the repo.
        """
        fd, path = tempfile.mkstemp(prefix="gitaskpass-", suffix=".sh")
        with os.fdopen(fd, "w") as fh:
            fh.write(
                "#!/bin/sh\n"
                'case "$1" in\n'
                "  *[Uu]sername*) echo 'x-access-token' ;;\n"
                f"  *) echo '{token}' ;;\n"
                "esac\n"
            )
        os.chmod(path, stat.S_IRWXU)   # 0700, owner only
        return path

    def _git_base(self, cwd: str) -> list[str]:
        name, email = _identity()
        return [
            "git",
            "-c", "credential.helper=",      # ignore any inherited helper
            "-c", f"user.name={name}",
            "-c", f"user.email={email}",
            "-c", "advice.detachedHead=false",
        ]

    @staticmethod
    def _current_branch(cwd: str) -> str:
        try:
            r = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=cwd, capture_output=True, text=True, timeout=10,
            )
            return r.stdout.strip()
        except Exception:
            return ""

    # ── the commit gate ───────────────────────────────────────────────────────

    @staticmethod
    def _staged_files(cwd: str) -> list[str]:
        r = subprocess.run(["git", "diff", "--cached", "--name-only"],
                           cwd=cwd, capture_output=True, text=True, timeout=20)
        return [f for f in r.stdout.splitlines() if f.strip()]

    def _scan_secrets(self, cwd: str) -> list[str]:
        """Findings in the staged diff. Never returns the secret itself."""
        findings: list[str] = []

        for f in self._staged_files(cwd):
            if _FORBIDDEN_FILE.search(f) and not _TEMPLATE_FILE.search(f):
                findings.append(f"{f}: this file should never be committed")

        r = subprocess.run(["git", "diff", "--cached", "--unified=0"],
                           cwd=cwd, capture_output=True, text=True, timeout=30)
        current = ""
        for line in r.stdout.splitlines():
            if line.startswith("+++ b/"):
                current = line[6:]
                continue
            if not line.startswith("+") or line.startswith("+++"):
                continue
            if _TEMPLATE_FILE.search(current):
                continue
            body = line[1:]
            hit = next((lbl for pat, lbl in _STRONG_SECRET_PATTERNS if re.search(pat, body)), None)
            if hit is None and not _PLACEHOLDER.search(body):
                hit = next((lbl for pat, lbl in _WEAK_SECRET_PATTERNS if re.search(pat, body)), None)
            if hit:
                findings.append(f"{current}: looks like a {hit}")
        return sorted(set(findings))

    @staticmethod
    def _detect_build_command(cwd: str, explicit: str | None) -> str | None:
        """The build command for this repo, or None if it genuinely has no build."""
        if explicit:
            return explicit
        env_cmd = os.environ.get("PROJECT_BUILD_COMMAND")
        if env_cmd:
            return env_cmd
        pkg = os.path.join(cwd, "package.json")
        if os.path.exists(pkg):
            try:
                with open(pkg, encoding="utf-8") as fh:
                    scripts = (json.load(fh) or {}).get("scripts") or {}
                if "build" in scripts:
                    return "npm run build"
            except Exception:
                return "npm run build"   # unreadable package.json — assume a build exists
        return None

    def _commit_gate(self, args: dict[str, Any], cwd: str) -> str | None:
        """Refusal text, or None when the commit may proceed."""
        staged = self._staged_files(cwd)
        if not staged:
            return (
                "Nothing is staged, so there is nothing to commit. Stage the files you "
                "changed first (operation='stage')."
            )

        secrets = self._scan_secrets(cwd)
        if secrets:
            return (
                "Commit refused — the staged changes look like they contain secrets:\n\n"
                + "\n".join(f"  - {s}" for s in secrets)
                + "\n\nUnstage those files, add them to .gitignore, and commit the rest. "
                "This is checked before the commit exists on purpose: once a secret is in "
                "history the only fix is rewriting history, which you are not permitted to "
                "do.\n\nIf you are certain this is a placeholder rather than a real "
                "credential, say so in your report and let a human stage it — do not try to "
                "reshape the value to get past this check."
            )

        build_cmd = self._detect_build_command(cwd, args.get("build_command"))
        if not build_cmd:
            return None   # no build in this repo — nothing to verify

        try:
            proc = subprocess.run(
                build_cmd, cwd=cwd, capture_output=True, text=True,
                shell=True, timeout=_BUILD_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return (
                f"Commit refused — `{build_cmd}` did not finish within {_BUILD_TIMEOUT}s. "
                "Report this rather than retrying; a build that hangs is a problem a human "
                "needs to look at."
            )
        except Exception as exc:
            return f"Commit refused — could not run `{build_cmd}` ({type(exc).__name__}: {exc})."

        if proc.returncode != 0:
            tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-1500:]
            hint = ""
            if "not found" in tail.lower() or "cannot find module" in tail.lower():
                hint = ("\n\nThis looks like missing dependencies rather than your change — "
                        "install them first, then commit again.")
            return (
                f"Commit refused — `{build_cmd}` failed (exit {proc.returncode}).\n\n"
                "Fix the build and commit again. Committing code that does not compile is "
                "the failure this gate exists to prevent, and there is no flag to skip it."
                f"{hint}\n\n--- build output (tail) ---\n{tail}"
            )
        return None

    # ── execute ───────────────────────────────────────────────────────────────

    async def execute(self, operation: str, args: dict[str, Any] | None = None, cwd: str = _DEFAULT_CWD, **kwargs: Any) -> str:  # noqa: A002
        if args is None:
            args = {}

        if args.get("force") or args.get("force_with_lease"):
            return (
                "[git refused] Force-pushing is not available to agents, and this is not a "
                "limitation you can work around — it exists because a force-push destroys "
                "history that nobody can recover from a review. If you believe the branch "
                "genuinely needs rewriting, stop and say so in your report; a human will do it."
            )

        cmd_or_err = self._build_command(operation, args, cwd)
        if isinstance(cmd_or_err, str):
            return f"[git error] {cmd_or_err}"

        # Runs AFTER _build_command, because commit's `files` argument stages them and the
        # gate must see what was actually staged — not what was staged before this call.
        if operation == "commit":
            refusal = self._commit_gate(args, cwd)
            if refusal:
                return f"[git refused] {refusal}"

        needs_net = operation in ("push", "pull", "clone")
        env = os.environ.copy()
        askpass = None

        if needs_net:
            token = _token()
            if not token:
                return (
                    "[git error] No GitHub token is configured, so this operation cannot "
                    "authenticate. Add a `GITHUB_TOKEN` secret to this agent (or a `github` "
                    "credential with a `token` field) in the dashboard. Local operations — "
                    "status, diff, stage, commit, branching — work without it."
                )
            askpass = self._askpass_file(token)
            env["GIT_ASKPASS"] = askpass
            env["GIT_TERMINAL_PROMPT"] = "0"   # never hang waiting on a tty that isn't there

        cmd = self._git_base(cwd) + cmd_or_err[1:]
        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=_CLONE_TIMEOUT if operation == 'clone' else (_NET_TIMEOUT if needs_net else _TIMEOUT),
                env=env,
            )
            output = result.stdout.strip()
            if not output and result.stderr.strip():
                output = result.stderr.strip()
            # A token can surface in a remote URL echoed back by an error. Never return it.
            if askpass:
                tok = _token() or ""
                if tok:
                    output = output.replace(tok, "***")
            return (output or "(no output)")[:3000]
        except subprocess.TimeoutExpired:
            limit = _CLONE_TIMEOUT if operation == 'clone' else (_NET_TIMEOUT if needs_net else _TIMEOUT)
            return f"[git error] operation '{operation}' timed out after {limit}s"
        except FileNotFoundError:
            return "[git error] git not found — ensure git is installed in the container"
        except Exception as exc:
            return f"[git error] {exc}"
        finally:
            if askpass:
                try:
                    os.unlink(askpass)
                except Exception:
                    pass

    def _build_command(self, op: str, args: dict[str, Any], cwd: str) -> list[str] | str:
        if op == "clone":
            url = str(args.get("url", "")).strip().rstrip("/")
            if not url:
                return "clone requires a 'url', e.g. https://github.com/owner/repo"
            if not _REPO_URL_RE.match(url):
                return (
                    f"{url!r} is not a supported repository URL. Use an https GitHub URL "
                    "like https://github.com/owner/repo. SSH and other hosts are not "
                    "supported — say so rather than trying to work around it."
                )
            name = str(args.get("name") or url.split("/")[-1]).replace(".git", "").strip()
            if not _SAFE_NAME_RE.match(name):
                return f"{name!r} is not a safe directory name — use letters, numbers, dots, dashes or underscores"

            dest = Path(cwd).resolve() / name
            # Confine the checkout to the working directory. `name` is already pattern-checked,
            # but a symlink in cwd could still land the clone elsewhere, so verify the resolved
            # path rather than trusting the name alone.
            if not str(dest).startswith(str(Path(cwd).resolve()) + os.sep):
                return "refusing to clone outside the working directory"
            if dest.exists():
                return (
                    f"{dest} already exists. If you want a fresh copy, work with what is there "
                    "or choose a different `name` — this tool will not overwrite a checkout."
                )
            cmd = ["git", "clone"]
            if args.get("branch"):
                cmd += ["--branch", str(args["branch"])]
            return cmd + [url, str(dest)]

        if op == "status":
            return ["git", "status", "--short", "--branch"]

        if op == "current_branch":
            return ["git", "rev-parse", "--abbrev-ref", "HEAD"]

        if op == "log":
            n = str(args.get("n", 10))
            cmd = ["git", "log", "--oneline", f"-{n}"]
            if "file" in args:
                cmd += ["--", args["file"]]
            return cmd

        if op == "diff":
            ref = args.get("ref", "HEAD")
            cmd = ["git", "diff", ref]
            if "file" in args:
                cmd += ["--", args["file"]]
            return cmd

        if op == "stage":
            files = args.get("files", ["."])
            if isinstance(files, str):
                files = [files]
            return ["git", "add", "--"] + files

        if op == "commit":
            message = args.get("message", "").strip()
            if not message:
                return "commit requires a non-empty 'message'"
            files = args.get("files")
            if files:
                if isinstance(files, str):
                    files = [files]
                subprocess.run(["git", "add", "--"] + files, cwd=cwd, capture_output=True, timeout=10)
            return ["git", "commit", "-m", message]

        if op == "create_branch":
            name = args.get("name", "").strip()
            if not name:
                return "create_branch requires a 'name'"
            cmd = ["git", "checkout", "-b", name]
            if "from_ref" in args:
                cmd.append(str(args["from_ref"]))
            return cmd

        if op == "checkout":
            branch = args.get("branch", "").strip()
            if not branch:
                return "checkout requires a 'branch'"
            return ["git", "checkout", branch]

        if op == "push":
            remote = args.get("remote", "origin")
            branch = str(args.get("branch", "HEAD")).strip() or "HEAD"
            # `HEAD` hides which branch is actually being pushed, so resolve it before
            # deciding — otherwise the protection is trivially bypassed by omitting `branch`.
            target = self._current_branch(cwd) if branch == "HEAD" else branch
            if target in _protected_branches():
                return (
                    f"pushing to {target!r} is refused. Agents work on a branch and open a "
                    "pull request; a human merges it.\n\n"
                    "This is deliberate, and it is the reason you are allowed to push at all: "
                    "a change on a branch costs one click to reject, a bad change on "
                    f"{target!r} costs a production rollback. Create a branch "
                    "(create_branch), push that, and report the branch name so it can be "
                    "reviewed.\n\n"
                    f"Protected: {', '.join(sorted(_protected_branches()))}"
                )
            if not target:
                return "could not determine the current branch — checkout a branch first"
            return ["git", "push", "--set-upstream", remote, target]

        if op == "pull":
            remote = args.get("remote", "origin")
            branch = args.get("branch", "")
            cmd = ["git", "pull", remote]
            if branch:
                cmd.append(branch)
            return cmd

        if op == "show":
            ref = args.get("ref", "HEAD")
            return ["git", "show", "--stat", ref]

        if op == "blame":
            file_ = args.get("file", "").strip()
            if not file_:
                return "blame requires a 'file'"
            cmd = ["git", "blame", file_]
            if "lines" in args:
                cmd += ["-L", str(args["lines"])]
            return cmd

        return f"unknown operation: {op!r}"
