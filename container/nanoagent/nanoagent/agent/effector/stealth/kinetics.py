"""Neuromotor Human Biometrics for Effector.

Implements biophysically accurate human kinematic simulations:
1. Fitts' Law velocity pacing and approach deceleration.
2. Physiological 8-12 Hz Gaussian hand micro-tremors and corrective sub-movements.
3. Physical QWERTY keyboard layout digraph distance matrices for inter-key flight time.
"""

from __future__ import annotations

import math
import random
import re

from nanoagent.agent.effector.types import Point


# QWERTY physical key coordinates (row, col) on standard physical keyboards
QWERTY_LAYOUT_COORDS: dict[str, tuple[float, float]] = {
    # Row 1 (Numbers)
    '`': (0.0, 0.0), '1': (0.0, 1.0), '2': (0.0, 2.0), '3': (0.0, 3.0), '4': (0.0, 4.0),
    '5': (0.0, 5.0), '6': (0.0, 6.0), '7': (0.0, 7.0), '8': (0.0, 8.0), '9': (0.0, 9.0),
    '0': (0.0, 10.0), '-': (0.0, 11.0), '=': (0.0, 12.0),
    # Row 2
    'q': (1.0, 1.5), 'w': (1.0, 2.5), 'e': (1.0, 3.5), 'r': (1.0, 4.5), 't': (1.0, 5.5),
    'y': (1.0, 6.5), 'u': (1.0, 7.5), 'i': (1.0, 8.5), 'o': (1.0, 9.5), 'p': (1.0, 10.5),
    '[': (1.0, 11.5), ']': (1.0, 12.5), '\\': (1.0, 13.5),
    # Row 3 (Home row)
    'a': (2.0, 1.8), 's': (2.0, 2.8), 'd': (2.0, 3.8), 'f': (2.0, 4.8), 'g': (2.0, 5.8),
    'h': (2.0, 6.8), 'j': (2.0, 7.8), 'k': (2.0, 8.8), 'l': (2.0, 9.8), ';': (2.0, 10.8),
    "'": (2.0, 11.8),
    # Row 4
    'z': (3.0, 2.2), 'x': (3.0, 3.2), 'c': (3.0, 4.2), 'v': (3.0, 5.2), 'b': (3.0, 6.2),
    'n': (3.0, 7.2), 'm': (3.0, 8.2), ',': (3.0, 9.2), '.': (3.0, 10.2), '/': (3.0, 11.2),
    # Space / modifier
    ' ': (4.0, 6.0),
}

_SPECIAL_CHAR_RE = re.compile(r"""[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]""")
_VOWEL_PAIR_RE = re.compile(r"[aeiou]{2}", re.IGNORECASE)


def get_key_coordinate(char: str) -> tuple[float, float]:
    """Resolves character to its physical row/col on a standard QWERTY keyboard."""
    c = char.lower()
    return QWERTY_LAYOUT_COORDS.get(c, (2.0, 6.0))


def calculate_digraph_flight_delay(
    prev_char: str,
    curr_char: str,
    min_delay_ms: int = 35,
    max_delay_ms: int = 110,
) -> int:
    """Calculates realistic inter-key flight time based on physical distance between keys.

    Adjacent keys have shorter transition latency than distant keys across the keyboard plane.
    """
    if not prev_char:
        # Initial keystroke hesitation
        return random.randint(min_delay_ms, max_delay_ms)

    pos1 = get_key_coordinate(prev_char)
    pos2 = get_key_coordinate(curr_char)

    # Physical Euclidean distance across keyboard matrix
    dist = math.hypot(pos1[0] - pos2[0], pos1[1] - pos2[1])

    # Repeated identical char or common vowel pair: rapid tapping
    is_rapid = (prev_char == curr_char) or bool(_VOWEL_PAIR_RE.search(prev_char + curr_char))

    if is_rapid:
        base_ms = min_delay_ms * 0.7
    else:
        # Distance penalty: ~8ms per key unit distance
        base_ms = min_delay_ms + (dist * 7.5)

    # Gaussian noise modeling hand motor jitter
    noise = random.gauss(0, 8.0)
    delay = base_ms + noise

    # Shift / special char penalty
    if curr_char.isupper() or _SPECIAL_CHAR_RE.match(curr_char):
        delay += random.randint(30, 60)

    return max(10, min(250, round(delay)))


def generate_neuromotor_trajectory(
    start: Point,
    end: Point,
    steps: int = 20,
    target_width: float = 40.0,
) -> list[Point]:
    """Generates human-accurate trajectory with Fitts' deceleration and 8-12Hz micro-tremor noise."""
    delta_x = end.x - start.x
    delta_y = end.y - start.y
    distance = math.hypot(delta_x, delta_y)

    if distance < 5:
        return [Point(round(start.x), round(start.y)), Point(round(end.x), round(end.y))]

    # Adaptive step calculation derived from Fitts' index of difficulty: ID = log2(2D / W)
    difficulty_index = math.log2((2.0 * distance / max(10.0, target_width)) + 1.0)
    adaptive_steps = max(10, min(40, round(steps * (distance / 300.0) + difficulty_index * 2.0)))

    # Natural sub-movement overshoot factor for long distances
    overshoot_factor = 0.05 if distance > 200 else 0
    overshoot_x = end.x + (delta_x * overshoot_factor * (random.random() - 0.3))
    overshoot_y = end.y + (delta_y * overshoot_factor * (random.random() - 0.3))

    # Organic control points with lateral variance
    cp1 = Point(
        x=start.x + delta_x * (0.2 + (random.random() - 0.5) * 0.15),
        y=start.y + delta_y * (0.1 + (random.random() - 0.5) * 0.2),
    )
    cp2 = Point(
        x=start.x + delta_x * (0.7 + (random.random() - 0.5) * 0.15),
        y=start.y + delta_y * (0.85 + (random.random() - 0.5) * 0.2),
    )

    trajectory: list[Point] = []
    for i in range(adaptive_steps + 1):
        raw_t = i / adaptive_steps
        # S-curve velocity profiling: cubic ease-in-out modeling muscular ballistic acceleration and visual feedback deceleration
        t = 4.0 * raw_t ** 3 if raw_t < 0.5 else 1.0 - ((-2.0 * raw_t + 2.0) ** 3) / 2.0

        u = 1.0 - t
        tt, uu = t * t, u * u
        uuu, ttt = uu * u, tt * t

        target_end = end if i == adaptive_steps else Point(x=overshoot_x, y=overshoot_y)

        x = uuu * start.x + 3.0 * uu * t * cp1.x + 3.0 * u * tt * cp2.x + ttt * target_end.x
        y = uuu * start.y + 3.0 * uu * t * cp1.y + 3.0 * u * tt * cp2.y + ttt * target_end.y

        # Involuntary 8-12 Hz Gaussian hand micro-tremors (highest mid-trajectory, dampening at landing)
        if 0 < i < adaptive_steps:
            tremor_amp = math.sin(raw_t * math.pi) * 1.5
            x += random.gauss(0, 0.45) * tremor_amp
            y += random.gauss(0, 0.45) * tremor_amp

        trajectory.append(Point(x=round(x), y=round(y)))

    # Ensure final landing is exact target coordinate
    trajectory[0] = Point(x=round(start.x), y=round(start.y))
    trajectory[-1] = Point(x=round(end.x), y=round(end.y))
    return trajectory
