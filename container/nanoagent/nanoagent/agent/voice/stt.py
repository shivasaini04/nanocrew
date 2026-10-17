"""
Sarvam AI speech recognition (Saarika) for the telephony leg.

The Voicebot stream hands us headerless PCM, but the REST endpoint wants a file,
so we wrap the buffer in a WAV header before posting. saarika:v2 is retired --
the live API rejects it and names saarika:v2.5 as the replacement.
"""
import os
import io
import struct
import logging
from typing import Optional

import aiohttp
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("stt")

SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
STT_MODEL = os.getenv("SARVAM_STT_MODEL", "saarika:v2.5")

_session: Optional[aiohttp.ClientSession] = None


def wrap_pcm_as_wav(pcm: bytes, sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " \
        + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits) \
        + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


async def _get_session() -> aiohttp.ClientSession:
    global _session
    if _session is None or _session.closed:
        key = os.getenv("SARVAM_API_KEY", "").strip()
        _session = aiohttp.ClientSession(
            headers={"api-subscription-key": key},
            timeout=aiohttp.ClientTimeout(total=15),
        )
    return _session


async def close() -> None:
    if _session and not _session.closed:
        await _session.close()


async def transcribe_pcm(pcm: bytes, sample_rate: int, language: str = "hi-IN") -> str:
    """Returns the transcript, or "" when recognition fails or the clip is silent."""
    key = os.getenv("SARVAM_API_KEY", "").strip()
    if not key or key.startswith("your_"):
        logger.error("SARVAM_API_KEY missing; cannot transcribe")
        return ""
    # Below ~0.3 s Saarika reliably returns nothing useful.
    if len(pcm) < sample_rate * 2 * 0.3:
        return ""

    wav = wrap_pcm_as_wav(pcm, sample_rate)
    form = aiohttp.FormData()
    form.add_field("file", io.BytesIO(wav), filename="audio.wav", content_type="audio/wav")
    form.add_field("language_code", language)
    form.add_field("model", STT_MODEL)

    try:
        session = await _get_session()
        async with session.post(SARVAM_STT_URL, data=form) as resp:
            body = await resp.text()
            if resp.status == 200:
                import json
                return (json.loads(body).get("transcript") or "").strip()
            logger.error("Sarvam STT %s: %s", resp.status, body[:250])
    except Exception as exc:
        logger.error("Sarvam STT request failed: %s", exc)
    return ""
