"""
Pluggable voice engines.

Two ways to run a spoken turn:

  SarvamEngine  - the classic pipeline: STT -> LLM -> TTS, three vendors, three
                  round trips. Latency is dominated by waiting for the LLM to
                  finish before synthesis starts, so it streams the LLM and
                  synthesizes sentence by sentence: the first sentence is already
                  playing while the rest is still being written.

  GeminiLiveEngine - speech-to-speech in one model. No STT/TTS hop, native
                  prosody, model-side VAD and interruption. Measured ~1.4s to
                  first audio versus ~4s for the Sarvam pipeline, and it is the
                  default engine. check_gemini_access() reports live usability.

Both expose the same contract:

    async for chunk in engine.respond(pcm_in, sample_rate):
        chunk.text   -> what the agent is saying (may be partial)
        chunk.audio  -> 16-bit LE PCM at chunk.sample_rate, or None
"""
import os
import re
import json
import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Optional, List, Dict, Any

import aiohttp
from dotenv import load_dotenv

from nanoagent.agent.voice.sales_tools import TOOL_DEFINITIONS, execute_tool_call
from nanoagent.providers.relay_url import provider_url

load_dotenv()
logger = logging.getLogger("engines")

# A sentence is the unit we synthesize. Splitting on punctuation keeps prosody
# intact -- splitting on a fixed word count makes the voice sound chopped.
SENTENCE_END = re.compile(r"(?<=[.!?])\s+|(?<=[।?!])\s*")
MIN_SENTENCE_CHARS = 12

# Sarvam's TTS latency scales with text length: ~1.9s for 85 characters, under a
# second for a short clause. Later chunks are synthesized while earlier ones are
# still playing, so only the FIRST chunk sits between the caller finishing and
# hearing a reply. Break that one at the first clause boundary instead of waiting
# for a whole sentence -- it is the single biggest win available in this pipeline.
FIRST_CHUNK_BREAK = re.compile(r"(?<=[,;:])\s+|(?<=[.!?।])\s*")
FIRST_CHUNK_MIN = 15
FIRST_CHUNK_MAX = 45


@dataclass
class SpeechChunk:
    text: str
    audio: Optional[bytes]
    sample_rate: int
    final: bool = False
    speaker: str = "agent"      # "user" carries the caller's own transcription
    tool: Optional[str] = None  # name of a tool that just executed
    tool_result: Optional[Dict[str, Any]] = None


class VoiceEngine:
    name = "base"
    available = False

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        raise NotImplementedError

    async def respond(self, transcript: str, sample_rate: int) -> AsyncIterator[SpeechChunk]:
        raise NotImplementedError
        yield  # pragma: no cover

    async def close(self) -> None:
        pass


# -- Sarvam: STT -> streaming LLM -> per-sentence TTS ----------------------
class SarvamEngine(VoiceEngine):
    name = "sarvam"

    def __init__(self, session):
        from nanoagent.agent.voice.tts import voice
        self.voice = voice
        self.session = session          # a VoiceSession (history, tools, prompt)
        self.available = voice.is_configured()

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        from nanoagent.agent.voice.stt import transcribe_pcm
        return await transcribe_pcm(pcm, sample_rate)

    async def respond(self, transcript: str, sample_rate: int) -> AsyncIterator[SpeechChunk]:
        """Streams the LLM and synthesizes each finished sentence immediately."""
        buffer = ""
        spoken_any = False
        first_chunk = True

        async for delta in self.session.stream_reply(transcript):
            buffer += delta
            while True:
                if first_chunk:
                    piece, buffer = self._take_first_chunk(buffer)
                else:
                    piece, buffer = self._take_sentence(buffer)
                if piece is None:
                    break
                audio = await self.voice.synthesize_pcm(piece, sample_rate=sample_rate)
                spoken_any = True
                first_chunk = False
                yield SpeechChunk(piece, audio, sample_rate)

        tail = buffer.strip()
        if tail:
            audio = await self.voice.synthesize_pcm(tail, sample_rate=sample_rate)
            spoken_any = True
            yield SpeechChunk(tail, audio, sample_rate)

        if not spoken_any:
            logger.warning("SarvamEngine produced no speech for %r", transcript[:60])
        yield SpeechChunk("", None, sample_rate, final=True)

    @staticmethod
    def _take_first_chunk(buffer: str):
        """Shortest natural opening fragment, so audio starts as soon as possible."""
        for match in FIRST_CHUNK_BREAK.finditer(buffer):
            head = buffer[:match.end()].strip()
            if len(head) >= FIRST_CHUNK_MIN:
                return head, buffer[match.end():]
        # No punctuation yet: once enough words have accumulated, break on a space
        # rather than waiting for the model to reach a comma.
        if len(buffer) >= FIRST_CHUNK_MAX:
            cut = buffer.rfind(" ", 0, FIRST_CHUNK_MAX)
            if cut > FIRST_CHUNK_MIN:
                return buffer[:cut].strip(), buffer[cut:]
        return None, buffer

    @staticmethod
    def _take_sentence(buffer: str):
        match = SENTENCE_END.search(buffer)
        if not match:
            return None, buffer
        sentence = buffer[:match.end()].strip()
        if len(sentence) < MIN_SENTENCE_CHARS:
            return None, buffer
        return sentence, buffer[match.end():]


# -- Gemini Live: speech to speech ----------------------------------------
# Head-to-head 2026-08-24, identical prompt and audio, thinking off, 600 ms endpoint:
#
#   gemini-3.1-flash-live-preview          first audio 1.32-1.37s
#       heard  "haan, bataiye. ye kitne ka padega?"  (accurate, punctuated)
#       said   "Bas 15 minute mein setup ho jayega..."  (natural Hinglish)
#   gemini-2.5-flash-native-audio-latest   first audio 3.21-4.46s
#       heard  "haan bataiye ye KISKE ka padega"     (misheard kitne -> kiske)
#       said   "cost Rs1 to Rs1.5 rupees per minute hogi"  (reads symbols aloud)
#
# 3.1-flash is the better model on latency, recognition and prosody.
#
# One catch that makes it look broken: it needs the client to KEEP STREAMING audio
# during silence to endpoint a turn. 2.5-native-audio tolerates a client that stops
# sending; 3.1 does not, and simply never replies. A real microphone streams
# continuously so this is a non-issue in the browser, but it will fool a test
# harness that stops sending when the caller stops talking.
#
# It also supports AUDIO output only -- response_modalities=["TEXT"] is rejected
# with APIError 1007.
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
# Tried in order when the first will not open. 3.1-flash is the best of them
# (1.3s to first audio, accurate Hindi); 2.5-native-audio is slower and mishears
# more, but a working slower agent beats a caller listening to silence.
# Deliberately EMPTY by default. 2.5-native-audio has a different voice and a
# noticeably different manner, so silently swapping mid-call makes a real call
# impossible to judge -- and hides how often 3.1 actually fails. Set this to a
# comma-separated list to re-enable model fallback.
GEMINI_LIVE_FALLBACKS = [m.strip() for m in os.getenv(
    "GEMINI_LIVE_FALLBACKS", "").split(",") if m.strip()]
# Install-wide DEFAULTS only. A tenant that has chosen a voice/language on its
# agent row overrides these per call (see GeminiLiveEngine.__init__).
GEMINI_LIVE_VOICE = os.getenv("GEMINI_LIVE_VOICE", "Puck")
GEMINI_LIVE_LANGUAGE = os.getenv("GEMINI_LIVE_LANGUAGE", "hi-IN")
GEMINI_THINKING_BUDGET = int(os.getenv("GEMINI_THINKING_BUDGET", "0"))
GEMINI_SILENCE_MS = int(os.getenv("GEMINI_SILENCE_MS", "600"))
# The handshake takes ~0.3s when healthy. Waiting 10s for a stalled one just
# burns the caller's patience -- retry instead.
GEMINI_CONNECT_TIMEOUT = float(os.getenv("GEMINI_CONNECT_TIMEOUT", "1.5"))
GEMINI_INPUT_RATE = 16000       # what the Live API expects to receive
GEMINI_OUTPUT_RATE = 24000      # what it returns


async def check_gemini_access() -> Dict[str, Any]:
    """Reports whether this key can actually run inference.

    Listing models succeeds even on a blocked project, so a live generateContent
    call is the only honest check. A 403 "Your project has been denied access"
    despite active billing means the AI Studio identity/organization verification
    is still pending, not that the key is wrong.
    """
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return {"available": False, "reason": "GEMINI_API_KEY not set"}

    # gemini-flash-latest answers this probe reliably; gemini-3.6-flash has been
    # seen to hang for >15s, which would grey the engine out in the UI over a
    # transient blip rather than a real access problem.
    url = provider_url("gemini", f"/v1beta/models/{os.getenv('GEMINI_TEXT_MODEL', 'gemini-flash-latest')}:generateContent?key={key}")
    payload = {"contents": [{"parts": [{"text": "ping"}]}],
               "generationConfig": {"maxOutputTokens": 1}}

    last = "unknown"
    # A timeout is not evidence of no access, so retry once before saying no.
    for attempt in (1, 2):
        try:
            async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=12)) as session:
                async with session.post(url, json=payload) as resp:
                    if resp.status == 200:
                        return {"available": True, "reason": None}
                    body = await resp.text()
                    try:
                        msg = json.loads(body)["error"]["message"]
                    except Exception:
                        msg = body[:160]
                    # An auth/permission answer is definitive; do not retry it.
                    return {"available": False, "reason": f"HTTP {resp.status}: {msg}"}
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
            if attempt == 1:
                await asyncio.sleep(1)
    return {"available": False, "reason": f"{last} (after retry)"}


def _gemini_function_declarations():
    """Reuse sales_tools' schemas rather than maintaining a second copy.

    TOOL_DEFINITIONS is in OpenAI's {"type":"function","function":{...}} shape;
    Gemini wants the inner object as a FunctionDeclaration.
    """
    from google.genai import types
    declarations = []
    for entry in TOOL_DEFINITIONS:
        fn = entry.get("function", entry)
        declarations.append(types.FunctionDeclaration(
            name=fn["name"],
            description=fn.get("description", ""),
            parameters_json_schema=fn.get("parameters") or {"type": "object",
                                                            "properties": {}},
        ))
    return declarations


class GeminiLiveEngine(VoiceEngine):
    """Speech-to-speech. Audio goes straight in and comes straight out, so there
    is no STT or TTS stage and no transcription step to add latency."""
    name = "gemini"

    def __init__(self, system_prompt: str, lead_name: str = "", lead_phone: str = "",
                 tool_context: Optional[Dict[str, Any]] = None,
                 voice_name: Optional[str] = None,
                 language: Optional[str] = None):
        self.system_prompt = system_prompt
        self.lead_name = lead_name
        self.lead_phone = lead_phone
        # Which voice the caller hears, and in which language. These belong to the
        # TENANT (agent.voice / agent.language), not to the deployment: two users
        # on the same NanoCrew install must be able to sound different. The env
        # vars remain only as the install-wide default for a tenant that has not
        # chosen. The API key is deliberately NOT per-tenant -- NanoCrew provides
        # the Gemini capacity; the user chooses how it sounds, not who pays.
        self.voice_name = (voice_name or "").strip() or GEMINI_LIVE_VOICE
        self.language = (language or "").strip() or GEMINI_LIVE_LANGUAGE
        # Trusted per-call values: tenant, call row, contact details.
        # Set per call once the tenant profile is known, so the opening line
        # names the right company.
        self.greeting: str = ""
        self.model: str = GEMINI_LIVE_MODEL
        self.active_model: str = GEMINI_LIVE_MODEL
        self.tool_context: Dict[str, Any] = dict(tool_context or {})
        self.tool_context.setdefault("lead_name", lead_name)
        self.tool_context.setdefault("lead_phone", lead_phone)
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.available = bool(self.api_key)
        self._client = None
        self._session_cm = None
        self._session = None

    async def connect(self, attempts: int = 3):
        """Open the Live session, retrying a flaky handshake.

        The handshake normally completes in ~0.3s but occasionally hangs. The
        SDK's default open timeout is ~10s, so three retries spent 32 seconds of
        a live call in silence before the fourth succeeded and the caller hung
        up. Fail fast instead: a stalled handshake is not going to recover, and a
        fresh attempt costs a third of a second.
        """
        # Measured on the VPS: a healthy handshake completes in 0.2-0.9s, but the
        # first one after an idle spell hangs ~10s and then the next succeeds
        # immediately. So the first attempt gets a short leash -- if it has not
        # answered in ~1.5s it is on the cold path and retrying beats waiting.
        last = None
        for model in [self.model] + [m for m in GEMINI_LIVE_FALLBACKS
                                     if m != self.model]:
            for attempt in range(attempts):
                budget = GEMINI_CONNECT_TIMEOUT * (1, 2, 4)[min(attempt, 2)]
                try:
                    session = await asyncio.wait_for(self._connect_once(model),
                                                     timeout=budget)
                    if model != GEMINI_LIVE_MODEL:
                        logger.warning("Gemini Live running on fallback model %s",
                                       model)
                    self.active_model = model
                    return session
                except Exception as exc:
                    last = exc
                    logger.warning("%s handshake %d/%d failed after %.1fs: %s",
                                   model, attempt + 1, attempts, budget,
                                   str(exc)[:70] or type(exc).__name__)
                    await self.close()
                    if attempt < attempts - 1:
                        await asyncio.sleep(0.3)
            logger.warning("%s unavailable, trying the next model", model)
        raise last or RuntimeError("no Gemini Live model would open")

    async def _connect_once(self, model: Optional[str] = None):
        from google import genai
        from google.genai import types

        self._client = genai.Client(api_key=self.api_key,
                                    http_options={"api_version": "v1alpha"})
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=self.system_prompt,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice_name))),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            # Measured on the reply-latency probe: thinking on = 5.79s to first
            # audio, thinking off = 4.48s, thinking off with a 600 ms endpoint =
            # 3.33s. A sales agent does not need to deliberate before answering.
            thinking_config=types.ThinkingConfig(thinking_budget=GEMINI_THINKING_BUDGET),
            # Without these the model cannot book or send anything -- and on the
            # 2026-08-25 call it invented a booking and a WhatsApp that never
            # happened rather than admitting it could not act.
            tools=[types.Tool(function_declarations=_gemini_function_declarations())],
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    prefix_padding_ms=100,
                    # Do not push this much below 600 ms. At 300 ms with HIGH end
                    # sensitivity the model endpointed on the first word ("haan")
                    # and then never answered at all.
                    silence_duration_ms=GEMINI_SILENCE_MS)),
        )
        self._session_cm = self._client.aio.live.connect(
            model=model or self.model, config=config)
        self._session = await self._session_cm.__aenter__()
        return self._session

    async def open_with(self, greeting: str) -> None:
        """Make Aarav speak first, the way an outbound call actually starts."""
        from google.genai import types
        if self._session is None:
            await self.connect()
        await self._session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(
                # "then stop" was also reading as "take no further action" and
                # discouraged tool use later in the call.
                text=f"Begin the call by saying exactly this: {greeting}")]),
            turn_complete=True)

    async def seed_said(self, text: str) -> None:
        """Tell the model what was already spoken aloud on its behalf, without
        making it say it again."""
        from google.genai import types
        if self._session is None:
            await self.connect()
        await self._session.send_client_content(
            turns=types.Content(role="model", parts=[types.Part(text=text)]),
            turn_complete=True)

    async def send_audio(self, pcm: bytes) -> None:
        """Push caller audio straight through; Gemini handles VAD itself."""
        if self._session is None:
            await self.connect()
        await self._session.send_realtime_input(
            audio={"data": pcm, "mime_type": f"audio/pcm;rate={GEMINI_INPUT_RATE}"})

    async def receive(self) -> AsyncIterator[SpeechChunk]:
        """Yields for the whole call, not just one turn.

        session.receive() completes at the end of each turn, so iterating it once
        forwards the greeting and then goes quiet for the rest of the call. Google's
        own examples re-enter it in an outer loop; this does the same.
        """
        if self._session is None:
            await self.connect()
        while True:
            got_anything = False
            async for response in self._session.receive():
                got_anything = True

                # The model asked to actually do something. Run it and hand the
                # result straight back, or it stalls waiting for a response.
                if response.tool_call and response.tool_call.function_calls:
                    async for chunk in self._run_tools(response.tool_call.function_calls):
                        yield chunk
                    continue

                server = response.server_content
                if response.data:
                    yield SpeechChunk("", response.data, GEMINI_OUTPUT_RATE)
                if server and server.output_transcription and server.output_transcription.text:
                    yield SpeechChunk(server.output_transcription.text, None,
                                      GEMINI_OUTPUT_RATE)
                # The caller's own words. Without this the transcript only ever
                # shows Aarav's side of the conversation.
                if server and server.input_transcription and server.input_transcription.text:
                    yield SpeechChunk(server.input_transcription.text, None,
                                      GEMINI_OUTPUT_RATE, speaker="user")
                if server and server.interrupted:
                    # Gemini detected the caller talking over it.
                    yield SpeechChunk("", None, GEMINI_OUTPUT_RATE, final=True)
                if server and server.turn_complete:
                    yield SpeechChunk("", None, GEMINI_OUTPUT_RATE, final=True)
            if not got_anything:
                # The socket is gone; re-entering would spin forever.
                return

    async def _run_tools(self, function_calls):
        """Execute each requested tool and report back to the model."""
        from google.genai import types

        responses = []
        for call in function_calls:
            name = call.name
            args = dict(call.args or {})
            # The model echoes contact details back from the prompt and can mangle
            # or invent them. These tools book real slots and send real email, so
            # trusted values are passed as context rather than taken from args.
            ctx = dict(self.tool_context)
            if self.lead_name and not args.get("lead_name"):
                args["lead_name"] = self.lead_name

            try:
                result = await execute_tool_call(name, json.dumps(args), ctx)
            except Exception as exc:
                logger.exception("tool %s failed: %s", name, exc)
                result = {"status": "error", "message": str(exc)[:150]}

            logger.info("tool %s(%s) -> %s", name, args, result.get("status"))
            responses.append(types.FunctionResponse(id=call.id, name=name,
                                                    response=result))
            yield SpeechChunk("", None, GEMINI_OUTPUT_RATE,
                              tool=name, tool_result=result)

        if responses and self._session is not None:
            await self._session.send_tool_response(function_responses=responses)

    async def close(self) -> None:
        if self._session_cm is not None:
            try:
                await self._session_cm.__aexit__(None, None, None)
            except Exception:
                pass
            self._session_cm = None
            self._session = None


async def prewarm_live(interval: float = 90.0) -> None:
    """Keep the Gemini Live path warm.

    The first connection after an idle period times out; every one after it is
    fast. Opening a throwaway session on a timer means a real call never lands on
    the cold path. The session carries no audio, so it costs nothing measurable.
    """
    from google import genai
    from google.genai import types

    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return
    while True:
        try:
            client = genai.Client(api_key=key,
                                  http_options={"api_version": "v1alpha"})
            cm = client.aio.live.connect(
                model=GEMINI_LIVE_MODEL,
                config=types.LiveConnectConfig(response_modalities=["AUDIO"]))
            session = await asyncio.wait_for(cm.__aenter__(), timeout=8)
            await cm.__aexit__(None, None, None)
            logger.debug("live path warm")
        except Exception as exc:
            logger.info("prewarm failed (harmless): %s", str(exc)[:60])
        await asyncio.sleep(interval)
