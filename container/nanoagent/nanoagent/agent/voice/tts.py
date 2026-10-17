"""
Sarvam AI speech synthesis for Hinglish sales calls.

The single most important thing this module does is transliterate romanized
Hinglish into Devanagari before synthesis. Sarvam's TTS is a Hindi model: given
Latin text it falls back to spelling-based guesses, which is why "main Aarav bol
raha hoon NanoCrew se" came out as "मेरा बोल रहा हूँ एनो रूस से" -- unintelligible
even to Sarvam's own STT. Devanagari in, correct phonemes out.
"""
import os
import sys
import base64
import struct
import asyncio
import logging
from typing import Optional, Tuple

import aiohttp
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("tts")

SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech"
SARVAM_TRANSLITERATE_URL = "https://api.sarvam.ai/transliterate"

# Verified against the live API on 2026-08-24. bulbul:v1 is retired; v3 accepts a
# different speaker set than v2, so model and speaker have to move together.
TTS_MODEL = os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")
TTS_SPEAKER = os.getenv("SARVAM_TTS_SPEAKER", "aditya")   # warm male voice for "Aarav"

# Sarvam's default pace reads at ~2.5 words/sec, which lands somewhere between
# a newsreader and a dictation. Measured on the greeting: 0.95 -> 2.1 w/s,
# 1.0 -> 2.5, 1.2 -> 3.9. Conversational Hindi sits around 3.5-4.5 w/s, so the
# default is deliberately faster than Sarvam's.
TTS_PACE = float(os.getenv("SARVAM_TTS_PACE", "1.2"))

# Telephony is a hard 8 kHz; the browser demo can use the full-band rate.
TELEPHONY_SAMPLE_RATE = 8000
BROWSER_SAMPLE_RATE = 22050


class SarvamVoice:
    """Reuses one HTTP connection pool and caches transliterations."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = (api_key or os.getenv("SARVAM_API_KEY", "")).strip()
        self._session: Optional[aiohttp.ClientSession] = None
        self._translit_cache: dict[str, str] = {}

    def is_configured(self) -> bool:
        return bool(self.api_key) and not self.api_key.startswith("your_")

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={"api-subscription-key": self.api_key,
                         "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=20),
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def to_devanagari(self, text: str) -> str:
        """Romanized Hinglish -> Devanagari. spoken_form expands digits the way a
        person would say them (15 -> पंद्रह, 1.5 -> एक दशमलव पाँच)."""
        if not text.strip() or not self.is_configured():
            return text
        # Already Devanagari? Leave it alone.
        if any("ऀ" <= ch <= "ॿ" for ch in text):
            return text
        if text in self._translit_cache:
            return self._translit_cache[text]

        payload = {
            "input": text,
            "source_language_code": "en-IN",
            "target_language_code": "hi-IN",
            "spoken_form": True,
        }
        try:
            session = await self._get_session()
            async with session.post(SARVAM_TRANSLITERATE_URL, json=payload) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    out = data.get("transliterated_text") or text
                    self._translit_cache[text] = out
                    return out
                logger.warning("transliterate %s: %s", resp.status, (await resp.text())[:200])
        except Exception as exc:
            logger.warning("transliterate failed, using raw text: %s", exc)
        return text

    async def synthesize(
        self,
        text: str,
        sample_rate: int = BROWSER_SAMPLE_RATE,
        transliterate: bool = True,
        pace: Optional[float] = None,
    ) -> Optional[bytes]:
        """Returns a complete WAV file, or None if synthesis failed."""
        if not text.strip() or not self.is_configured():
            return None

        spoken = await self.to_devanagari(text) if transliterate else text
        payload = {
            "inputs": [spoken],
            "target_language_code": "hi-IN",
            "model": TTS_MODEL,
            "speaker": TTS_SPEAKER,
            "speech_sample_rate": sample_rate,
            "enable_preprocessing": True,   # normalizes mixed English/numerals
            "pace": TTS_PACE if pace is None else pace,
        }
        try:
            session = await self._get_session()
            async with session.post(SARVAM_TTS_URL, json=payload) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    audios = data.get("audios") or []
                    if audios:
                        return base64.b64decode(audios[0])
                    logger.error("Sarvam TTS returned no audio for %r", spoken[:60])
                else:
                    logger.error("Sarvam TTS %s: %s", resp.status, (await resp.text())[:300])
        except Exception as exc:
            logger.error("Sarvam TTS request failed: %s", exc)
        return None

    async def synthesize_b64(self, text: str, sample_rate: int = BROWSER_SAMPLE_RATE) -> Optional[str]:
        wav = await self.synthesize(text, sample_rate=sample_rate)
        return base64.b64encode(wav).decode() if wav else None

    async def synthesize_pcm(self, text: str, sample_rate: int = TELEPHONY_SAMPLE_RATE) -> Optional[bytes]:
        """Headerless 16-bit little-endian PCM -- what Exotel's stream expects."""
        wav = await self.synthesize(text, sample_rate=sample_rate)
        return strip_wav_header(wav) if wav else None


def strip_wav_header(wav_bytes: bytes) -> bytes:
    """Walk the RIFF chunks to find `data`. Sarvam sometimes emits a LIST chunk
    before the payload, so a fixed 44-byte slice would clip or include garbage."""
    if len(wav_bytes) < 12 or wav_bytes[:4] != b"RIFF":
        return wav_bytes
    pos = 12
    while pos + 8 <= len(wav_bytes):
        chunk_id = wav_bytes[pos:pos + 4]
        chunk_size = struct.unpack("<I", wav_bytes[pos + 4:pos + 8])[0]
        if chunk_id == b"data":
            return wav_bytes[pos + 8: pos + 8 + chunk_size]
        pos += 8 + chunk_size + (chunk_size & 1)
    return wav_bytes[44:]


def wav_format(wav_bytes: bytes) -> Tuple[int, int, int]:
    """(sample_rate, channels, bit_depth) -- used to assert telephony compliance."""
    channels = struct.unpack("<H", wav_bytes[22:24])[0]
    rate = struct.unpack("<I", wav_bytes[24:28])[0]
    bits = struct.unpack("<H", wav_bytes[34:36])[0]
    return rate, channels, bits


# Shared instance
voice = SarvamVoice()


async def _regenerate_greeting() -> None:
    """Writes greeting.wav at Exotel-legal 8 kHz / 16-bit / mono."""
    try:
        await _write_greeting()
    finally:
        await voice.close()


async def _write_greeting() -> None:
    from nanoagent.agent.voice.voice_session import build_greeting
    text = build_greeting("Alex")
    wav = await voice.synthesize(text, sample_rate=TELEPHONY_SAMPLE_RATE)
    if not wav:
        print("FAILED: no audio returned (check SARVAM_API_KEY)")
        return
    path = os.path.join(os.path.dirname(__file__), "greeting.wav")
    with open(path, "wb") as fh:
        fh.write(wav)
    rate, ch, bits = wav_format(wav)
    print(f"wrote {path}")
    print(f"  text : {text}")
    print(f"  spoken: {await voice.to_devanagari(text)}")
    dur = (len(wav) - 44) / (rate * 2)
    print(f"  format: {rate} Hz, {ch} ch, {bits}-bit, {len(wav)/1024:.0f} KB")
    print(f"  pace  : {TTS_PACE} -> {dur:.1f}s, {len(text.split())/dur:.1f} words/sec")
    ok = (rate, ch, bits) == (8000, 1, 16) and len(wav) < 2 * 1024 * 1024
    print(f"  Exotel-compatible: {'YES' if ok else 'NO'}")


if __name__ == "__main__":
    # Windows consoles default to cp1252, which cannot encode Devanagari and
    # would crash this script on the transliteration preview.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_regenerate_greeting())
