"""Voice — the outbound-calling engine, native to nanoagent.

Ported from a standalone FastAPI prototype (a server, a dashboard, a login and a
forever-polling dialer worker). What is here is only the part that was ever a
library; the process-shaped pieces were dropped rather than carried, because an
agent cycle runs `--rm`, is capped at 30 minutes, and publishes no ports.

Reachable from a real run (`tools/voice_call.py` drives these — grep for the call
site before trusting this list):

- Origination against the tenant's own carrier account   (telephony.py)
- TRAI calling-window + DND + number validation gate      (contact_gate.py)
- Per-tenant persona, voice and language                  (voice_session.py)
- Gemini Live speech-to-speech engine                     (engines.py)
- In-call tools: calendar slots, demo booking             (sales_tools.py)
- Post-call outcome extraction                            (outcomes.py)

NOT reachable from a cycle, and listed separately rather than quietly among the
rest:

- The live media loop. Exotel streams call audio to the Voicebot flow's WebSocket,
  which is a public inbound endpoint an agent container cannot host. `engines.py`
  is a complete, working speech-to-speech client, but nothing in a cycle feeds it
  audio — a call placed here is handled by whatever the tenant's flow URL points
  at, and its transcript is read back afterwards via `get_call_result`.

That asymmetry is inherent to telephony rather than a gap to close: a phone call
outlives the cycle that dialled it. Treat "the agent placed a call" and "the agent
had a conversation" as two different claims, and only the first happens here.

Two credentials are the TENANT's, never the operator's — an unconfigured tenant
gets an explicit error, never someone else's identity:
  * the carrier account (their number is what the prospect sees, and their
    account carries the DND/TRAI liability)
  * SMTP (a demo invite must come from them, so replies reach them)
The Gemini key is deliberately NOT per-tenant: NanoCrew provides that capacity.
What a tenant controls is how the agent sounds and what it says.
"""

from nanoagent.agent.voice.runner import get_call_result, run_voice_call
from nanoagent.agent.voice.telephony import place_call, tenant_telephony

__all__ = [
    "run_voice_call",
    "get_call_result",
    "place_call",
    "tenant_telephony",
]
