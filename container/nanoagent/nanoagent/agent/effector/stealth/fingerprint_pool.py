"""Device fingerprint pool.

Profiles are picked deterministically per session_domain (stable hash, not random) —
the same site sees the same "device" across visits, which is what a real returning
user looks like.

Each profile maintains strict cross-layer consistency:
- User-Agent <-> navigator.platform <-> userAgentData.platform/architecture/version
- GPU Vendor/Renderer <-> WebGL Supported Extensions
- OS <-> SpeechSynthesis Voices <-> installed font set
- Screen Resolution <-> Taskbar/Dock Avail Metrics

Review finding, 2026-08-30 — why every profile is now Linux
----------------------------------------------------------
The pool used to claim Windows 10 and an Apple M2. Neither survives contact with
the container this actually runs in:

- The image installs `fonts-liberation` + a few metric substitutes. A font-metric
  probe on a "Windows" device finds no Segoe UI, Tahoma or Calibri — impossible on
  a real Windows box, and unfixable from JS (font detection measures rendered text
  width; there is nothing to patch).
- The macOS profile shipped `architecture: 'x86'` and `platformVersion: '10.0.0'`
  (a *Windows* version string) for an Apple M2, and there is no San Francisco font
  in a Debian image either.

Detection scores inconsistency, not rarity. A perfectly coherent Linux Chrome is an
ordinary developer; a Windows UA with a Linux TLS stack and no Windows fonts is a
liar. So the pool is Linux-consistent, and the diversity that used to come from
faking three operating systems now comes from GPU/core-count/screen variation
within one honest OS.

`EFFECTOR_FINGERPRINT_OS=windows` opts back into the old Windows profiles for an
operator who has actually added the matching fonts to the image — the knob exists
so this is a reversible default, not a one-way door.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, replace

# Shared by every Linux profile — a desktop Mesa/ANGLE stack advertises the same
# core extension set regardless of which GPU is behind it. The claimed list is
# intersected against what the real context actually supports at injection time
# (see stealth.py's hookWebGL), so nothing here can promise an extension that
# `getExtension()` would then return null for.
_LINUX_WEBGL_EXTENSIONS: tuple[str, ...] = (
    "ANGLE_instanced_arrays",
    "EXT_blend_minmax",
    "EXT_clip_control",
    "EXT_color_buffer_half_float",
    "EXT_depth_clamp",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_polygon_offset_clamp",
    "EXT_shader_texture_lod",
    "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc",
    "EXT_texture_filter_anisotropic",
    "KHR_parallel_shader_compile",
    "OES_draw_buffers_indexed",
    "OES_element_index_uint",
    "OES_fbo_render_mipmap",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
    "WEBGL_multi_draw",
)

_LINUX_VOICES: tuple[str, ...] = (
    "English (America)",
    "English (Great Britain)",
    "English (Scotland)",
)

_WINDOWS_VOICES: tuple[str, ...] = (
    "Microsoft David - English (United States)",
    "Microsoft Zira - English (United States)",
    "Microsoft Mark - English (United States)",
)


@dataclass(frozen=True)
class MediaDeviceSpec:
    device_id: str
    kind: str  # 'audioinput', 'audiooutput', 'videoinput'
    label: str
    group_id: str


_DEFAULT_MEDIA_DEVICES: tuple[MediaDeviceSpec, ...] = (
    MediaDeviceSpec(device_id="default", kind="audioinput", label="Default - Internal Microphone", group_id="audio_group_1"),
    MediaDeviceSpec(device_id="audio_in_1", kind="audioinput", label="Built-in Audio Analog Stereo (Microphone)", group_id="audio_group_1"),
    MediaDeviceSpec(device_id="audio_out_1", kind="audiooutput", label="Built-in Audio Analog Stereo (Speakers)", group_id="audio_group_1"),
    MediaDeviceSpec(device_id="video_in_1", kind="videoinput", label="Integrated Camera (04f2:b604)", group_id="video_group_1"),
)


@dataclass(frozen=True)
class DeviceProfile:
    name: str
    user_agent: str
    platform: str  # navigator.platform value: 'Win32' | 'MacIntel' | 'Linux x86_64'
    ua_platform: str  # userAgentData.platform: 'Windows' | 'macOS' | 'Linux'
    gpu_vendor: str  # WebGL UNMASKED_VENDOR_WEBGL string
    gpu_renderer: str  # WebGL UNMASKED_RENDERER_WEBGL string
    hardware_concurrency: int
    device_memory: int
    chrome_version: str
    # Client Hints high-entropy values. Previously hardcoded to a Windows answer
    # for every profile including the Apple-Silicon one — now per-profile, because
    # `getHighEntropyValues()` returning x86/10.0.0 for an M2 is a contradiction a
    # detector gets for free.
    platform_version: str = "6.8.0"
    architecture: str = "x86"
    bitness: str = "64"
    screen_width: int = 1920
    screen_height: int = 1080
    screen_avail_width: int = 1920
    screen_avail_height: int = 1053  # Linux: ~27px top bar
    device_pixel_ratio: float = 1.0
    voices: tuple[str, ...] = _LINUX_VOICES
    webgl_extensions: tuple[str, ...] = _LINUX_WEBGL_EXTENSIONS
    media_devices: tuple[MediaDeviceSpec, ...] = _DEFAULT_MEDIA_DEVICES
    battery_charging: bool = True
    battery_level: float = 1.0
    network_downlink: float = 10.0
    network_rtt: int = 50
    network_effective_type: str = "4g"

    @property
    def browser_family(self) -> str:
        """"chromium" or "gecko" — which engine this profile can honestly be worn by.

        Added 2026-08-31 after measuring the deployed image. Every profile in this pool
        claims Chrome (`AppleWebKit/537.36 ... Chrome/124`), and the whole stealth init
        script is Chrome-shaped: it defines `window.chrome`, `navigator.userAgentData`,
        `deviceMemory` and a Chrome PDF plugin list. Firefox has *none* of those.

        Wearing a Chrome profile on a Gecko engine is not a partial disguise, it is a
        contradiction — Chrome APIs present on a browser whose TLS handshake, HTTP/2
        SETTINGS and JA4H header order all say Firefox. This module's own rule applies:
        *detection scores inconsistency, not rarity*. So the engine gate checks this
        rather than assuming any profile fits any browser.
        """
        ua = self.user_agent
        if "Firefox/" in ua or "Gecko/" in ua:
            return "gecko"
        return "chromium"

    @property
    def noise_seed(self) -> int:
        """Stable 32-bit seed for the canvas/audio noise functions.

        Derived from the profile name, so the *same device* produces the *same*
        canvas hash on every read and every visit — which is the property a real
        browser has and the previous `Math.random()` implementation destroyed. See
        stealth.py's noise section.
        """
        digest = hashlib.sha256(f"noise:{self.name}".encode()).hexdigest()
        return int(digest[:8], 16)

    def with_chrome_version(self, version: str) -> "DeviceProfile":
        """This profile, restated for the Chromium build that is actually running.

        Review finding, 2026-08-30: the pool hardcoded Chrome 123/124 (April 2024
        builds). The image installs Debian's unpinned `chromium`, so the real binary
        is whatever apt had at build time — and its TLS/HTTP2 fingerprint, JS engine
        behaviour and default headers all belong to that real version. Claiming a
        different one in the UA is a contradiction that gets worse as the image ages.
        Reading the version off the live browser removes the staleness problem
        permanently instead of restating it with a newer number.
        """
        if not isinstance(version, str):
            return self
        version = version.strip()
        if not version:
            return self
        major = version.split(".")[0]
        if not major.isdigit():
            return self
        user_agent = re.sub(r"Chrome/[\d.]+", f"Chrome/{major}.0.0.0", self.user_agent)
        return replace(self, chrome_version=version, user_agent=user_agent)


_LINUX_PROFILES: tuple[DeviceProfile, ...] = (
    DeviceProfile(
        name="linux-mesa-intel",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform="Linux x86_64",
        ua_platform="Linux",
        gpu_vendor="Google Inc. (Intel)",
        gpu_renderer="ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
        hardware_concurrency=8,
        device_memory=8,
        chrome_version="124.0.6367.91",
        platform_version="6.8.0",
        screen_width=1920,
        screen_height=1080,
        screen_avail_width=1920,
        screen_avail_height=1053,
    ),
    DeviceProfile(
        name="linux-mesa-amd",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform="Linux x86_64",
        ua_platform="Linux",
        gpu_vendor="Google Inc. (AMD)",
        gpu_renderer="ANGLE (AMD, AMD Radeon RX 6600 (radeonsi navi23 LLVM 15.0.6), OpenGL 4.6)",
        hardware_concurrency=12,
        device_memory=16,
        chrome_version="124.0.6367.91",
        platform_version="6.5.0",
        screen_width=2560,
        screen_height=1440,
        screen_avail_width=2560,
        screen_avail_height=1413,
    ),
    DeviceProfile(
        name="linux-nvidia",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        platform="Linux x86_64",
        ua_platform="Linux",
        gpu_vendor="Google Inc. (NVIDIA)",
        gpu_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 /PCIe/SSE2, OpenGL 4.6)",
        hardware_concurrency=16,
        device_memory=16,
        chrome_version="123.0.6312.106",
        platform_version="6.2.0",
        screen_width=1920,
        screen_height=1080,
        screen_avail_width=1920,
        screen_avail_height=1053,
    ),
    DeviceProfile(
        name="linux-mesa-xe",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        platform="Linux x86_64",
        ua_platform="Linux",
        gpu_vendor="Google Inc. (Mesa)",
        gpu_renderer="ANGLE (Mesa, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)",
        hardware_concurrency=8,
        device_memory=16,
        chrome_version="123.0.6312.106",
        platform_version="6.8.0",
        screen_width=1920,
        screen_height=1200,
        screen_avail_width=1920,
        screen_avail_height=1173,
    ),
)


# ─── Gecko / Firefox pool ────────────────────────────────────────────────────────
#
# For the vendored engine (agent/effector/engine/), which is a Firefox build — NOT for
# Chromium. The coherence gate in browser_session refuses to pair a chromium-family
# profile with it, because a Chrome JS surface over a Firefox transport is a
# contradiction no real client produces and is easier to detect than plain Chromium.
#
# Every value below was MEASURED from the engine itself on 2026-08-31, launched with
# os="linux" inside the production image — not copied from a Firefox release note:
#
#     ua        Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0
#     platform  Linux x86_64        oscpu       Linux x86_64
#     productSub 20100101           buildID     20181001000000
#     vendor    "" (empty)          colorDepth  24
#     maxTouchPoints 0              pdfViewerEnabled true
#     mimeTypes 2                   plugins     5 (the PDF viewer set)
#
# What Firefox does NOT have, and which the Chromium stealth script injects — so that
# script must never run on this engine: window.chrome, navigator.userAgentData,
# navigator.deviceMemory. All three read `undefined` on a real Firefox and were
# confirmed undefined here.
#
# `chrome_version` is retained only because DeviceProfile is shared with the Chromium
# pool; it is unused on this path and deliberately left empty so a stray Chrome-shaped
# consumer fails loudly instead of quietly emitting a Chrome version from Firefox.
_GECKO_VOICES: tuple[str, ...] = ()   # measured: speechSynthesis has no voices here

_GECKO_PROFILES: tuple[DeviceProfile, ...] = (
    DeviceProfile(
        name="gecko-linux-8core",
        user_agent="Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
        platform="Linux x86_64",
        ua_platform="Linux",
        # Firefox exposes no WEBGL_debug_renderer_info to content by default, so these
        # are never read on this path; kept truthful rather than Chrome-shaped.
        gpu_vendor="Mesa",
        gpu_renderer="llvmpipe (LLVM 15.0.6, 256 bits)",
        hardware_concurrency=8,
        device_memory=8,          # unused: Firefox has no navigator.deviceMemory
        chrome_version="",        # unused on Gecko — see note above
        platform_version="6.8.0",
        screen_width=1920,
        screen_height=1080,
        screen_avail_width=1920,
        screen_avail_height=1053,
        voices=_GECKO_VOICES,
    ),
    DeviceProfile(
        name="gecko-linux-16core",
        user_agent="Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
        platform="Linux x86_64",
        ua_platform="Linux",
        gpu_vendor="Mesa",
        gpu_renderer="llvmpipe (LLVM 15.0.6, 256 bits)",
        hardware_concurrency=16,
        device_memory=16,
        chrome_version="",
        platform_version="6.5.0",
        screen_width=2560,
        screen_height=1440,
        screen_avail_width=2560,
        screen_avail_height=1413,
        voices=_GECKO_VOICES,
    ),
)


_WINDOWS_PROFILES: tuple[DeviceProfile, ...] = (
    DeviceProfile(
        name="windows-nvidia",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform="Win32",
        ua_platform="Windows",
        gpu_vendor="Google Inc. (NVIDIA)",
        gpu_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        hardware_concurrency=8,
        device_memory=8,
        chrome_version="124.0.6367.91",
        platform_version="10.0.0",
        screen_avail_height=1040,  # Windows 40px taskbar
        voices=_WINDOWS_VOICES,
    ),
    DeviceProfile(
        name="windows-intel",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        platform="Win32",
        ua_platform="Windows",
        gpu_vendor="Google Inc. (Intel)",
        gpu_renderer="ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        hardware_concurrency=4,
        device_memory=8,
        chrome_version="123.0.6312.106",
        platform_version="10.0.0",
        screen_avail_height=1040,
        voices=_WINDOWS_VOICES,
    ),
    DeviceProfile(
        name="windows-amd",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform="Win32",
        ua_platform="Windows",
        gpu_vendor="Google Inc. (AMD)",
        gpu_renderer="ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        hardware_concurrency=12,
        device_memory=16,
        chrome_version="124.0.6367.91",
        platform_version="10.0.0",
        screen_avail_height=1040,
        voices=_WINDOWS_VOICES,
    ),
)


def _active_pool(browser_family: str = "chromium") -> tuple[DeviceProfile, ...]:
    """The profile pool for the browser that will actually wear it.

    `browser_family` is not cosmetic. A Chrome-claiming profile on the Gecko engine is
    the contradiction the coherence gate in browser_session exists to refuse — the JS
    surface would say Chrome while the transport says Firefox, which is easier to
    detect than plain unmodified Chromium.
    """
    if browser_family == "gecko":
        # No Windows variant: the container installs Linux fonts, and font metrics are
        # measured rather than read, so a Windows claim here is unfixable from JS. The
        # engine is launched with os="linux" to match (see camoufox_driver).
        return _GECKO_PROFILES
    if os.environ.get("EFFECTOR_FINGERPRINT_OS", "").strip().lower() == "windows":
        return _WINDOWS_PROFILES
    return _LINUX_PROFILES


# Kept as a module-level name because tests and `stealth/__init__.py` already import
# it. Reads the default pool; `pick_device_profile` consults `_active_pool()` so the
# env override is honoured at call time rather than at import time.
DEVICE_PROFILES: tuple[DeviceProfile, ...] = _LINUX_PROFILES


def pick_device_profile(
    session_domain: str | None, browser_family: str = "chromium",
) -> DeviceProfile:
    """Deterministic per-domain pick — same site, same device, every visit. A
    session with no domain (a one-off task, no persistence) still gets a stable
    profile per Python process, not a fresh random one per call within that run.

    `browser_family` selects which pool to draw from; it defaults to chromium so every
    existing caller keeps its current behaviour.
    """
    pool = _active_pool(browser_family)
    key = session_domain or "effector-default"
    idx = int(hashlib.sha256(key.encode()).hexdigest(), 16) % len(pool)
    return pool[idx]
