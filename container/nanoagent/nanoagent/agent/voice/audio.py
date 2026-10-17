"""
PCM helpers shared by the browser and telephony paths.

Every leg of this system runs at a different rate: Exotel negotiates 8/16/24 kHz,
Gemini Live wants 16 kHz in and always returns 24 kHz, and Sarvam synthesizes at
whatever it is asked for. Getting a rate wrong does not error -- it just plays
back at the wrong pitch and speed, which is easy to misdiagnose as a bad model.
"""
import audioop
from typing import Optional


def resample_pcm(pcm: bytes, src_rate: int, dst_rate: int,
                 state: Optional[tuple] = None):
    """Resample 16-bit mono PCM. Returns (audio, state).

    Carry `state` across successive chunks of the same stream: audioop uses it to
    keep the filter continuous, and dropping it introduces a click at every chunk
    boundary — roughly 25 clicks a second on a 40 ms frame size.
    """
    if src_rate == dst_rate or not pcm:
        return pcm, state
    converted, new_state = audioop.ratecv(pcm, 2, 1, src_rate, dst_rate, state)
    return converted, new_state


def rms(pcm: bytes) -> float:
    """Loudness of a 16-bit mono buffer, 0 for empty input."""
    if len(pcm) < 2:
        return 0.0
    return audioop.rms(pcm, 2)
