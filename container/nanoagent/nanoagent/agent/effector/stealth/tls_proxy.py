"""Phase 5: Cryptographic Transport Isolation (TLS / JA3/JA4 & HTTP/2 Virtualizer).

Manages the lifecycle of a local uTLS / JA4-aligned forward proxy helper that rewrites
outbound ClientHello cipher suites, extensions, elliptic curves, and HTTP/2 settings
to mirror the target DeviceProfile before connecting upstream.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.effector.stealth.fingerprint_pool import DeviceProfile


# Default binary candidate paths for uTLS forwarder
_UTLS_BINARY_CANDIDATES = [
    os.environ.get("UTLS_ROUTER_PATH"),
    "/usr/local/bin/utls-router",
    "/usr/bin/utls-router",
    "/opt/utls/utls-router",
]


def find_utls_binary() -> Path | None:
    """Returns the path to the uTLS router executable if installed on the system."""
    for cand in _UTLS_BINARY_CANDIDATES:
        if cand and Path(cand).exists() and Path(cand).is_file():
            return Path(cand)
    resolved = shutil.which("utls-router")
    return Path(resolved) if resolved else None


def is_utls_available() -> bool:
    """Predicate indicating whether uTLS-based transport virtualization is supported."""
    return find_utls_binary() is not None or os.environ.get("EFFECTOR_MOCK_UTLS", "0") == "1"


def map_device_profile_to_tls_preset(profile: DeviceProfile | None) -> str:
    """Maps a DeviceProfile to its corresponding uTLS / JA4 ClientHello preset."""
    if profile is None:
        return "chrome_124_win11"

    platform_lower = profile.platform.lower()
    version = profile.chrome_version.split(".")[0] if profile.chrome_version else "124"

    if "win" in platform_lower:
        return f"chrome_{version}_win11" if int(version) >= 120 else "chrome_120_win11"
    elif "mac" in platform_lower:
        return f"chrome_{version}_macos" if int(version) >= 120 else "chrome_120_macos"
    elif "linux" in platform_lower:
        return f"chrome_{version}_linux" if int(version) >= 120 else "chrome_120_linux"
    return f"chrome_{version}_win11"


def _find_free_port() -> int:
    """Finds an unbound ephemeral TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TLSVirtualizerProxy:
    """Manages a lightweight local forward proxy that rewrites TLS ClientHello via uTLS."""

    def __init__(
        self,
        profile: DeviceProfile | None = None,
        preset: str | None = None,
        listen_port: int | None = None,
        upstream_proxy: str | None = None,
    ) -> None:
        self.preset = preset or map_device_profile_to_tls_preset(profile)
        self.port = listen_port if listen_port and listen_port > 0 else _find_free_port()
        self.upstream_proxy = upstream_proxy
        self._process: asyncio.subprocess.Process | None = None
        self._mock_server: asyncio.Server | None = None
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> str:
        """Starts the uTLS virtualizer process or mock server and returns the local proxy URL."""
        if self._running:
            return f"http://127.0.0.1:{self.port}"

        bin_path = find_utls_binary()
        if bin_path is not None:
            cmd = [
                str(bin_path),
                "-listen", f"127.0.0.1:{self.port}",
                "-preset", self.preset,
            ]
            if self.upstream_proxy:
                cmd.extend(["-upstream", self.upstream_proxy])

            try:
                self._process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                self._running = True
                logger.info(f"tls_proxy: started uTLS virtualizer on port {self.port} (preset: {self.preset})")
                return f"http://127.0.0.1:{self.port}"
            except Exception as err:
                logger.warning(f"tls_proxy: failed to start uTLS binary {bin_path} ({err}) — falling back")
                self._process = None

        # If mock mode enabled or testing without external binary
        if os.environ.get("EFFECTOR_MOCK_UTLS", "0") == "1":
            async def _dummy_handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
                writer.close()
                await writer.wait_closed()

            try:
                self._mock_server = await asyncio.start_server(_dummy_handle, "127.0.0.1", self.port)
                self._running = True
                logger.debug(f"tls_proxy: started mock uTLS server on port {self.port}")
                return f"http://127.0.0.1:{self.port}"
            except Exception as err:
                logger.debug(f"tls_proxy: mock server start error ({err})")

        logger.debug("tls_proxy: no uTLS virtualizer available on this environment")
        return ""

    async def stop(self) -> None:
        """Terminates the proxy process or server."""
        if self._process is not None:
            try:
                if self._process.returncode is None:
                    self._process.terminate()
                    await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except Exception as err:
                logger.debug(f"tls_proxy: error during process shutdown ({err})")
                try:
                    self._process.kill()
                except Exception:
                    pass
            finally:
                self._process = None

        if self._mock_server is not None:
            try:
                self._mock_server.close()
                await self._mock_server.wait_closed()
            except Exception as err:
                logger.debug(f"tls_proxy: error closing mock server ({err})")
            finally:
                self._mock_server = None

        self._running = False
        logger.debug(f"tls_proxy: stopped virtualizer on port {self.port}")

    async def __aenter__(self) -> TLSVirtualizerProxy:
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.stop()
