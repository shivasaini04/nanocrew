# Voice Sales Agent — Prototype

Hinglish outbound voice agent for the Indian market. Exotel telephony, Sarvam AI
for speech, OpenRouter for reasoning.

## Quick start

```bash
pip install -r requirements.txt
cp .env.example .env          # fill in your keys
python tts.py                 # regenerate greeting.wav at 8 kHz
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Then open `http://localhost:8000/demo`, or check `http://localhost:8000/health`
to confirm keys and audio format before placing a real call.

Terminal testing without a phone:

```bash
python test_simulator.py          # text conversation
python test_simulator.py --tts    # also speaks each reply and transcribes it back
```

## The Exotel setup you have to do by hand

**Exotel will not run a call flow from an arbitrary webhook.** `connect.json`'s
`Url` must name a flow built in App Bazaar. Pointing it at this server is why the
call used to connect and then drop the instant it was answered — Exotel dialled
the number, fetched something it could not interpret as a flow, and hung up.

1. Expose this server publicly (`lt --port 8000`, ngrok, or a cloudflared tunnel).
2. Exotel dashboard → **App Bazaar → Create App**.
3. Drag one applet onto **"Drop applet here"** and give it the matching endpoint.
   **The three applets do not share a response format** — using the wrong endpoint
   plays silence:

   | Applet | Endpoint to enter | Server returns |
   |---|---|---|
   | **Voicebot** (full conversation) | `wss://<tunnel>/api/v1/telephony/exotel/stream` | live audio stream |
   | **Greeting** (one-way smoke test) | `https://<tunnel>/api/v1/telephony/exotel/greeting` | `text/plain`, bare audio URL |
   | **Connect** (dynamic playback) | `https://<tunnel>/api/v1/telephony/exotel/incoming` | `application/json` |

4. Copy the app id out of the flow URL into `EXOTEL_FLOW_URL` (or `EXOTEL_APP_ID`)
   in `.env`. The editor URL `.../flows/edit/1325167` means app id `1325167`, so the
   flow URL is `http://my.exotel.com/<account_sid>/exoml/start_voice/1325167`.
5. `python trigger_exotel_call.py`

### Pick the right tunnel

Use **cloudflared**: `cloudflared tunnel --url http://localhost:8000`

localtunnel and ngrok serve an HTML interstitial to clients that do not look like
a browser. Exotel is not a browser — it fetches your applet URL, gets that HTML
instead of your audio URL or JSON, and plays nothing. cloudflared has no
interstitial and passes WebSocket upgrades through for the Voicebot applet.

On a trial account the destination number must be verified in the dashboard first,
otherwise the API returns 403.

### Exotel's hard requirements

| Thing | Requirement | Why it bites |
|---|---|---|
| Flow URL | `my.exotel.com/{sid}/exoml/start_voice/{app_id}` | anything else → call drops on answer |
| Applet response | JSON, `Content-Type: application/json` | XML/ExoML is silently discarded |
| HEAD requests | must return the same headers as GET | Exotel probes before playing |
| Audio | **8 kHz, 16-bit, mono**, under 2 MB | 22 kHz is refused; nothing plays |
| Stream frames | multiples of 320 bytes, raw/slin base64 | ragged frames cause audible gaps |

`/health` checks the audio format for you.

## Why the voice sounded wrong

Sarvam's TTS is a Hindi model. Fed romanized Latin text it guesses from spelling,
so "Namaste Alex ji" came out as "yah must ve vajah hai". Every line is now
transliterated to Devanagari first (`/transliterate` with `spoken_form`, which also
turns `15` into `पंद्रह` and `1.5` into `एक दशमलव पाँच`).

Measured by round-tripping the same sentence back through Sarvam's own STT:

| | intelligibility |
|---|---|
| romanized text, default model | 48% |
| Devanagari + `bulbul:v3` + speaker | 74% |

`test_simulator.py --tts` runs this check on any reply.

Note `bulbul:v1` is retired, and **v2 and v3 accept different speaker sets** — if
you change `SARVAM_TTS_MODEL`, re-check `SARVAM_TTS_SPEAKER` or the API 400s.

## Layout

| File | Role |
|---|---|
| `server.py` | Exotel + Twilio ingress, Voicebot WebSocket, browser demo, `/health` |
| `voice_session.py` | conversation state, LLM calls, tool-calling loop, session registry |
| `tts.py` | Sarvam synthesis + transliteration; run directly to rebuild `greeting.wav` |
| `stt.py` | Sarvam speech recognition for the telephony leg |
| `sales_tools.py` | calendar and WhatsApp tools exposed to the model |
| `contact_gate.py` | Indian phone validation, TRAI 9am–9pm IST window, DND list |
| `trigger_exotel_call.py` | places the outbound call |
| `test_simulator.py` | terminal harness |

## Known limits

- Turn-taking uses an RMS energy gate, not a real VAD. Fine on a clean PSTN leg;
  swap in `webrtcvad` or silero before production.
- Twilio's `<Stream>` is 8 kHz mu-law and is **not** transcoded — the route accepts
  the socket and logs a warning. Exotel is the supported path for India.
- The Voicebot greeting is synthesized per call (~1–2 s to first audio). The
  pre-rendered `greeting.wav` could be reused when the lead name matches.
- The DND list in `contact_gate.py` is an in-memory stub, not the real NDNC registry.

## Real-time browser demo

`/demo` now streams. The browser captures microphone PCM continuously over one
WebSocket (`/api/v1/voice/live`); the server runs VAD, decides when you have
finished a thought, and streams synthesized speech back before the model has
finished writing it. Talk over the agent and it stops mid-sentence.

The old page used the browser's own speech recognition, POSTed a transcript, and
waited for a complete WAV — walkie-talkie, not a phone call.

### Measured latency, caller-stops-talking to first audio

| Stage | Time |
|---|---|
| Endpointing silence | 0.40s |
| Sarvam STT (REST, whole utterance) | 0.85–1.33s |
| LLM first token (streamed) | 0.58–1.12s |
| Transliteration hop | ~0.60s |
| Sarvam TTS, first chunk | 1.0–1.5s |
| **Total** | **~4.3s** (was 7.0s) |

Later chunks are synthesized while earlier ones play, so only the first chunk
counts. That is why the first chunk breaks at the first clause boundary rather
than the first full sentence.

**This pipeline has a floor of roughly 3.5–4.5s** because every stage is a
separate REST round trip. Getting under ~1.5s needs streaming STT
(`saaras:v3-realtime`) or a speech-to-speech model that collapses all three
stages into one connection.

## Engine comparison

`/api/v1/engines` reports which engines can actually run. Switch between them on
the demo page.

| | Sarvam pipeline | Gemini Live |
|---|---|---|
| Shape | STT → LLM → TTS, 3 round trips | one speech-to-speech stream |
| First audio | ~4.3s measured | typically under 1s |
| Interruption | our VAD + explicit clear | model-side |
| Indian-language prosody | purpose-built for Indic | strong but not Indic-specific |
| Status here | working | working |

### Cost per minute of conversation

Assuming a minute of call is roughly 30s of agent speech and 30s of caller speech.

| | Rate | Per call-minute |
|---|---|---|
| Sarvam TTS bulbul:v3 | ₹30 / 10K chars | ~₹1.80 |
| Sarvam TTS bulbul:v2 | ₹15 / 10K chars | ~₹0.90 |
| Sarvam STT | ₹30 / hour | ~₹0.25 |
| LLM (Llama 3.3 70B via OpenRouter) | — | ~₹0.05 |
| **Sarvam total (v3 / v2)** | | **~₹2.10 / ~₹1.20** |
| Gemini 3.1 Flash Live audio in | $0.005/min | ~₹0.22 |
| Gemini 3.1 Flash Live audio out | $0.018/min | ~₹0.79 |
| **Gemini Live total** | | **~₹1.00** |

Rupee figures use ~₹88/USD; check the live rate before quoting. Sarvam gives ₹100
of free credit, Gemini has a free tier.

Switching bulbul:v3 → v2 halves the TTS bill and is the single biggest cost lever
in the Sarvam path, since TTS is ~85% of it.

### Gemini access

Run `python check_gemini.py` (optionally with a key argument) after any change in
AI Studio. It makes real inference calls — listing models returns 200 with the
full catalogue even on a project that cannot run anything, so it proves nothing.

Two traps cost real time here:

1. **`403 PERMISSION_DENIED — "Your project has been denied access"`** despite an
   active paid billing account and credit on it. This is the identity/organization
   **verification** banner in AI Studio → Billing, not a ban. An Organization
   payments profile demands company registration documents; an Individual profile
   asks for personal ID. The profile type cannot be changed after creation.

2. **A model can look broken when the *client* is at fault.** Gemini endpoints a
   turn by observing a silence window inside the incoming stream. A client that
   stops sending audio when the caller stops talking never closes the turn, so the
   model simply never replies. `gemini-2.5-flash-native-audio` tolerates this;
   `gemini-3.1-flash-live-preview` does not. A real microphone streams
   continuously so the browser is unaffected — but it cost two wrong conclusions
   here before the harness was fixed to keep the mic open.

### Choosing a Live model

Head-to-head, identical prompt and audio, thinking off, 600 ms endpoint:

| | `3.1-flash-live-preview` | `2.5-flash-native-audio-latest` |
|---|---|---|
| First audio | **1.32–1.41s** | 3.21–4.46s |
| Heard | "हां, बताइए। यह कितने का पड़ेगा?" | "हां बताइए यह **किसके** का पड़ेगा" |
| Reply style | "Bas 15 minute mein setup ho jayega" | "cost ₹1 to ₹1.5 rupees per minute hogi" |

`3.1-flash-live-preview` is the default: faster, better Hindi recognition, and it
speaks naturally instead of reading `₹` symbols aloud. It supports AUDIO output
only — `response_modalities=["TEXT"]` is rejected with APIError 1007.

### Gemini reply latency

Measured, caller stops talking to first audio:

| Config | First audio |
|---|---|
| thinking on, default endpoint | 5.79s |
| thinking off (`thinking_budget=0`) | 4.48s |
| thinking off + `silence_duration_ms=600` | 3.33s |
| both, 3.1-flash over the live relay | **1.41s** |

Tuned via `GEMINI_THINKING_BUDGET` and `GEMINI_SILENCE_MS`. **Do not drop the
silence window much below 600 ms**: at 300 ms with HIGH end sensitivity the model
endpointed on the caller's first word and then stopped answering entirely.

Note the client must keep streaming audio during silence. Gemini endpoints by
observing a silence window in the incoming stream, so a client that stops sending
when the user stops talking never triggers a reply — that cost an hour of chasing
a bug that did not exist.
