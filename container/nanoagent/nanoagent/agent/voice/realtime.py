"""
Real-time browser conversation over a single WebSocket.

The old demo was turn-based: the browser did its own recognition, POSTed a
transcript, waited for a whole WAV, then played it. That is why it felt like
walkie-talkie rather than a phone call.

Here the browser streams raw microphone PCM continuously; this module runs voice
activity detection, decides when the caller has finished a thought, and starts
streaming synthesized speech back before the model has finished writing it.
Barge-in cancels playback the moment the caller talks over the agent.

Wire protocol (browser <-> server):
  browser -> binary frames  : 16-bit LE PCM mono at RATE
  browser -> {"type":"hello"|"bye"}
  server  -> binary frames  : 16-bit LE PCM mono at RATE (agent speech)
  server  -> {"type": "state"|"user"|"agent"|"error"|"clear"|"tool"}
"""
import json
import asyncio
import logging
from typing import Optional

logger = logging.getLogger("realtime")

RATE = 16000                 # browser capture + playback rate
FRAME_MS = 40
FRAME_BYTES = RATE * 2 * FRAME_MS // 1000        # 1280 bytes

# Endpointing. Shorter than the telephony path because a laptop mic is clean and
# people expect a snappier reply from a screen than from a phone.
SILENCE_MS_TO_END_TURN = 400
SILENCE_FRAMES = SILENCE_MS_TO_END_TURN // FRAME_MS
MIN_SPEECH_MS = 300
MIN_SPEECH_FRAMES = MIN_SPEECH_MS // FRAME_MS
BARGE_IN_FRAMES = 3          # ~120 ms of caller speech cancels agent playback
RMS_THRESHOLD = 900          # laptop mics idle well below this


def rms(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    total = 0
    positions = range(0, len(pcm) - 1, 32)
    for i in positions:
        val = int.from_bytes(pcm[i:i + 2], "little", signed=True)
        total += val * val
    return (total / max(1, len(positions))) ** 0.5


class RealtimeConversation:
    """Drives one browser call. Engine-agnostic: it only needs transcribe() and
    respond() from whatever engine it is handed."""

    def __init__(self, websocket, engine, session):
        self.ws = websocket
        self.engine = engine
        self.session = session
        self.speaking_task: Optional[asyncio.Task] = None
        self.inbound = bytearray()
        self.silent_run = 0
        self.speech_run = 0
        self.closed = False

    # -- outbound helpers -------------------------------------------------
    async def send_event(self, kind: str, **fields) -> None:
        try:
            await self.ws.send_json({"type": kind, **fields})
        except Exception as exc:
            # Marking the conversation closed here silently would strand every
            # later send, so say why the socket went away.
            logger.info("send_event(%s) failed, closing: %s", kind, exc)
            self.closed = True

    async def _stream_reply(self, transcript: str) -> None:
        """Synthesize and stream the agent's answer, sentence by sentence."""
        try:
            await self.send_event("state", value="thinking")
            first = True
            async for chunk in self.engine.respond(transcript, RATE):
                if chunk.final:
                    break
                if chunk.text:
                    await self.send_event("agent", text=chunk.text, partial=True)
                if chunk.audio:
                    if first:
                        await self.send_event("state", value="speaking")
                        first = False
                    # Send in frame-sized pieces so the browser can start playing
                    # immediately instead of waiting for a whole sentence.
                    for off in range(0, len(chunk.audio), FRAME_BYTES):
                        if self.closed:
                            return
                        await self.ws.send_bytes(chunk.audio[off:off + FRAME_BYTES])
                        await asyncio.sleep(0)      # yield so barge-in can land
            if self.session.tool_events:
                last = self.session.tool_events[-1]
                await self.send_event("tool", name=last["tool"])
            if self.session.llm_degraded:
                await self.send_event("error", message=self.session.last_error or "LLM unavailable")
        except asyncio.CancelledError:
            logger.info("reply cancelled (barge-in)")
            raise
        except Exception as exc:
            logger.exception("reply failed: %s", exc)
            await self.send_event("error", message=str(exc)[:200])
        finally:
            if not self.closed:
                await self.send_event("state", value="listening")

    def is_speaking(self) -> bool:
        return self.speaking_task is not None and not self.speaking_task.done()

    async def stop_speaking(self) -> None:
        if self.is_speaking():
            self.speaking_task.cancel()
            try:
                await self.speaking_task
            except (asyncio.CancelledError, Exception):
                pass
            # Tell the browser to drop whatever it has buffered, or the agent
            # keeps talking from the client-side queue after being interrupted.
            await self.send_event("clear")
        self.speaking_task = None

    # -- inbound ----------------------------------------------------------
    async def on_audio(self, pcm: bytes) -> None:
        voiced = rms(pcm) > RMS_THRESHOLD

        if voiced:
            self.speech_run += 1
            self.silent_run = 0
            self.inbound.extend(pcm)
            if self.is_speaking() and self.speech_run >= BARGE_IN_FRAMES:
                await self.stop_speaking()
        else:
            if self.inbound:
                self.silent_run += 1
                self.inbound.extend(pcm)      # keep trailing silence for the STT
                if self.silent_run >= SILENCE_FRAMES:
                    await self._end_of_turn()
            self.speech_run = 0

    async def _end_of_turn(self) -> None:
        audio = bytes(self.inbound)
        self.inbound.clear()
        self.silent_run = 0
        self.speech_run = 0

        if len(audio) < MIN_SPEECH_FRAMES * FRAME_BYTES:
            return                                  # a cough, not a sentence
        if self.is_speaking():
            return                                  # already answering

        await self.send_event("state", value="transcribing")
        transcript = await self.engine.transcribe(audio, RATE)
        if not transcript.strip():
            await self.send_event("state", value="listening")
            return

        await self.send_event("user", text=transcript)
        self.speaking_task = asyncio.create_task(self._stream_reply(transcript))

    async def shutdown(self) -> None:
        self.closed = True
        if self.is_speaking():
            self.speaking_task.cancel()
