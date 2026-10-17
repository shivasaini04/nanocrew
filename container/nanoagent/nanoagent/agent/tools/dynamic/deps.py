"""Dependency management for dynamic tools."""

import subprocess
import sys
import importlib.util
from dataclasses import dataclass, field
from typing import List, Optional, Set
from loguru import logger


@dataclass
class DepsCheckResult:
    """Results of a dependency check."""
    missing: List[str]
    installed: List[str]
    blocked: List[str]
    
    @property
    def all_safe(self) -> bool:
        return not self.blocked


@dataclass
class DepsInstallResult:
    """Results of a dependency installation."""
    success: bool
    installed: List[str]
    failed: List[str]
    error: Optional[str] = None


class DependencyInstaller:
    """
    Checks and installs third-party dependencies for dynamic tools.
    """

    DEFAULT_ALLOWLIST = {
        "requests", "beautifulsoup4", "bs4", "pandas", "numpy", 
        "lxml", "pyyaml", "json5", "httpx", "pillow", "jinja2",
        "pyjokes", "yarl", "multidict"
    }
    
    DEFAULT_NODE_ALLOWLIST = {
        "lodash", "axios", "cheerio", "moment", "zod", "validator"
    }

    def __init__(self, allowlist: Optional[Set[str]] = None, node_allowlist: Optional[Set[str]] = None, blocklist: Optional[Set[str]] = None):
        self.allowlist = allowlist if allowlist is not None else self.DEFAULT_ALLOWLIST
        self.node_allowlist = node_allowlist if node_allowlist is not None else self.DEFAULT_NODE_ALLOWLIST
        self.blocklist = blocklist if blocklist is not None else set()

    def check(self, packages: List[str], language: str = "python", allow_any: bool = False) -> DepsCheckResult:
        """
        Checks which packages are installed, missing, or blocked.

        `allow_any` (Phase 2 / deferred-item #1): skip the curated allowlist — used for
        SIDECAR-tier tools, which run in a disposable, isolated container, so installing
        arbitrary packages there is safe. The blocklist still applies as a hard deny.
        """
        missing = []
        installed = []
        blocked = []

        allowlist = None if allow_any else (self.allowlist if language == "python" else self.node_allowlist)

        for pkg in packages:
            # An `apt:`-prefixed dep is a SYSTEM package (not pip-importable). It's installed
            # via apt in the sidecar (at verify + every startup), so it bypasses the pip
            # import/allowlist check — but the blocklist still applies to its bare name.
            is_apt = pkg.startswith("apt:")
            bare = pkg.split("apt:", 1)[1].strip() if is_apt else pkg

            # 1. Check Security — blocklist always; allowlist only for pip pkgs when not allow_any.
            if bare in self.blocklist or (allowlist and not is_apt and pkg not in allowlist):
                blocked.append(pkg)
                continue

            if is_apt:
                # Handled by the apt path; not a pip "missing" item.
                installed.append(pkg)
                continue

            # 2. Check Presence
            if self._is_package_installed(pkg, language):
                installed.append(pkg)
            else:
                missing.append(pkg)

        return DepsCheckResult(missing=missing, installed=installed, blocked=blocked)

    def install(self, packages: List[str], language: str = "python") -> DepsInstallResult:
        """
        Installs missing and allowed packages.
        """
        if not packages:
            return DepsInstallResult(success=True, installed=[], failed=[])

        try:
            if language == "python":
                cmd = [sys.executable, "-m", "pip", "install", "--user", "--no-cache-dir"] + packages
            elif language in ("javascript", "typescript"):
                # Install globally in the user's home or a shared location for the agent
                # For simplicity, we use npm install -g but that might need sudo.
                # Better: install in a shared dynamic tool node_modules
                cmd = ["npm", "install", "--no-save"] + packages
            else:
                return DepsInstallResult(success=False, installed=[], failed=packages, error=f"Unsupported language for deps: {language}")

            logger.info(f"Installing {language} dependencies: {', '.join(packages)}")
            
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                check=True
            )
            
            return DepsInstallResult(success=True, installed=packages, failed=[])
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install dependencies: {e.stderr}")
            return DepsInstallResult(
                success=False, 
                installed=[], 
                failed=packages, 
                error=e.stderr or str(e)
            )

    def _is_package_installed(self, package_name: str, language: str = "python") -> bool:
        """Checks if a package is available in the current environment."""
        if language == "python":
            # Special case for beautifulsoup4 which is imported as bs4
            name_to_check = "bs4" if package_name == "beautifulsoup4" else package_name
            try:
                return importlib.util.find_spec(name_to_check) is not None
            except (ImportError, ValueError):
                return False
        elif language in ("javascript", "typescript"):
            try:
                # Check if package exists in node_modules or global
                result = subprocess.run(["npm", "list", package_name, "--depth=0"], capture_output=True, text=True)
                return result.returncode == 0
            except:
                return False
        return False
