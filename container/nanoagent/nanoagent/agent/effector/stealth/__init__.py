"""Phase 2 of the Effector port — stealth: fingerprint masking, organic mouse/typing/scrolling
cadence, network shield, and residential proxy routing.
"""

from nanoagent.agent.effector.stealth.camoufox_driver import (
    get_camoufox_engine_options,
    is_camoufox_available,
)
from nanoagent.agent.effector.stealth.driver_scrambler import (
    obfuscate_driver_signatures,
    scan_and_obfuscate_binaries,
    verify_binary_cleanliness,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import (
    DEVICE_PROFILES,
    DeviceProfile,
    pick_device_profile,
)
from nanoagent.agent.effector.stealth.geo_profile import (
    GeoProfile,
    resolve_geo_profile,
)
from nanoagent.agent.effector.stealth.network_shield import (
    BLOCKED_MEDIA_EXTENSIONS,
    TRACKING_DOMAINS,
    apply_network_shield,
)
from nanoagent.agent.effector.stealth.kinetics import (
    Point,
    calculate_digraph_flight_delay,
    generate_neuromotor_trajectory,
    get_key_coordinate,
)
from nanoagent.agent.effector.stealth.stealth import (
    STEALTH_INIT_SCRIPT,
    ULTRA_STEALTH_INIT_SCRIPT,
    apply_stealth_to_context,
    build_stealth_init_script,
    generate_bezier_trajectory,
    human_mouse_move,
    human_scroll,
    human_type,
    is_challenge_page,
)
from nanoagent.agent.effector.stealth.tls_proxy import (
    TLSVirtualizerProxy,
    is_utls_available,
    map_device_profile_to_tls_preset,
)

__all__ = [
    "Point",
    "calculate_digraph_flight_delay",
    "generate_neuromotor_trajectory",
    "get_key_coordinate",
    "is_camoufox_available",
    "get_camoufox_engine_options",
    "obfuscate_driver_signatures",
    "scan_and_obfuscate_binaries",
    "verify_binary_cleanliness",
    "TLSVirtualizerProxy",
    "is_utls_available",
    "map_device_profile_to_tls_preset",
    "DeviceProfile",
    "DEVICE_PROFILES",
    "pick_device_profile",
    "GeoProfile",
    "resolve_geo_profile",
    "BLOCKED_MEDIA_EXTENSIONS",
    "TRACKING_DOMAINS",
    "apply_network_shield",
    "STEALTH_INIT_SCRIPT",
    "ULTRA_STEALTH_INIT_SCRIPT",
    "apply_stealth_to_context",
    "build_stealth_init_script",
    "generate_bezier_trajectory",
    "human_mouse_move",
    "human_scroll",
    "human_type",
    "is_challenge_page",
]
