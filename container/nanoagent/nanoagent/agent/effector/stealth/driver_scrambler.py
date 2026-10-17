"""Stage 47 / Ultimaa Phase 3 — Binary Signature Normalization & Driver Attribute Scrambler.

Reads browser and driver binaries at boot runtime, searches for known orchestration
and automation telemetry identifiers (e.g. `cdc_` strings, ChromeDriver inspection tokens),
and replaces them with randomized, non-attribution byte sequences of identical length.
"""

from __future__ import annotations

import os
import random
import re
import string
from pathlib import Path
from typing import Sequence

from loguru import logger

# Common automation telemetry patterns found in chromedriver / chromium binaries
_CDC_PATTERN = re.compile(rb"cdc_[a-zA-Z0-9]{22}_")
_CHROMEDRIVER_VAR_PATTERNS = [
    re.compile(rb"\$cdc_[a-zA-Z0-9]{22}_"),
    re.compile(rb"cdc_[a-zA-Z0-9]{22}_"),
]

_CHROMIUM_DEFAULT_PATHS = [
    os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
    os.environ.get("CHROME_PATH"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
]


def verify_binary_cleanliness(binary_path: str | Path) -> bool:
    """Checks whether a binary contains any known automation signatures.

    Returns True if the binary is clean, False if signatures were found or file unreadable.
    """
    p = Path(binary_path)
    if not p.exists() or not p.is_file():
        return True

    try:
        data = p.read_bytes()
        for pattern in _CHROMEDRIVER_VAR_PATTERNS:
            if pattern.search(data):
                return False
        return True
    except Exception as err:
        logger.debug(f"driver_scrambler: verify error for {p} — {err}")
        return False


def scan_and_obfuscate_binaries(target_paths: Sequence[str | Path] | None = None) -> int:
    """Scans multiple binary executables and replaces automation string signatures in-place.

    Returns the total number of patched signatures across all target binaries.
    """
    targets: list[Path] = []
    if target_paths:
        for p in target_paths:
            if p:
                targets.append(Path(p))
    else:
        for p in _CHROMIUM_DEFAULT_PATHS:
            if p and Path(p).exists() and Path(p).is_file():
                targets.append(Path(p))

    total_patched = 0
    for target in targets:
        if not target.exists() or not target.is_file():
            continue

        try:
            raw_bytes = target.read_bytes()
            original_size = len(raw_bytes)
            modified_data = raw_bytes
            file_patches = 0

            for pattern in _CHROMEDRIVER_VAR_PATTERNS:
                matches = list(set(pattern.findall(modified_data)))
                for match in matches:
                    length = len(match)
                    if length <= 4:
                        continue
                    prefix = b"nav_" if not match.startswith(b"$") else b"$nav"
                    prefix_len = len(prefix)
                    random_suffix = "".join(
                        random.choices(string.ascii_letters, k=max(1, length - prefix_len))
                    )
                    replacement = f"{prefix.decode('utf-8')}{random_suffix}"[:length].encode("utf-8")

                    # Strict byte-length invariance invariant
                    if len(replacement) == length:
                        modified_data = modified_data.replace(match, replacement)
                        file_patches += 1
                        total_patched += 1
                        logger.debug(
                            f"driver_scrambler: normalized signature {match.decode('utf-8', 'ignore')} "
                            f"-> {replacement.decode('utf-8', 'ignore')} in {target}"
                        )

            if file_patches > 0:
                # Ensure file length hasn't changed by a single byte
                if len(modified_data) == original_size:
                    target.write_bytes(modified_data)
                    logger.info(
                        f"driver_scrambler: normalized {file_patches} automation signatures in {target}"
                    )
                else:
                    logger.error(
                        f"driver_scrambler: size mismatch during patch of {target} "
                        f"({len(modified_data)} vs {original_size}) — write aborted"
                    )
            else:
                logger.debug(f"driver_scrambler: binary signatures clean in {target}")

        except Exception as err:
            logger.warning(
                f"driver_scrambler: could not modify binary {target} (read-only or permission error) — {err}"
            )

    return total_patched


def obfuscate_driver_signatures(binary_path: str | Path | None = None) -> int:
    """Convenience alias to obfuscate a single binary or default browser paths."""
    if binary_path:
        return scan_and_obfuscate_binaries([binary_path])
    return scan_and_obfuscate_binaries(None)
