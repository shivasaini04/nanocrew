"""Placing the outbound call — the origination half of the voice engine.

Extracted from the prototype's `dialer.py`, which was a standalone worker process
that polled a queue forever. That shape was wrong for a library: nothing here runs
a loop or owns a process. `place_call` does one thing, once, and returns — the same
contract `run_voice_call` and every other entry point in this package follows.

The credentials are the tenant's own, with NO operator fallback. See
`tenant_telephony` for why that matters more here than anywhere else in the package.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict

from nanoagent.agent.voice import db

# Exotel trial accounts reject unverified destinations, and a bad key is a bad key
# on every retry. Treat these as terminal rather than burning attempts on a call
# that can never succeed.
TERMINAL_HTTP = {400, 401, 403}


def tenant_telephony(tenant_id: int) -> Dict[str, str]:
    """The tenant's OWN Exotel credentials. No shared fallback, deliberately.

    This used to fall back to the install's .env credentials when a tenant had
    none of its own. That is the wrong default for a multi-tenant product and
    was actively unsafe: a tenant who never configured telephony would silently
    dial on the operator's Exotel account, so the prospect saw the OPERATOR's
    ExoPhone, and every DND complaint and TRAI liability landed on the operator
    for calls they did not place or approve.

    Telephony is the one thing a user must bring themselves: their account,
    their number, their liability. Unlike the AI capacity (NanoCrew provides the
    Gemini key), there is no sensible way to lend someone a phone identity. A
    tenant with no credentials gets an explicit "not configured" error from
    place_call(), never someone else's line.

    Only `subdomain` still reads the environment: it is Exotel's API hostname
    (a region/deployment constant), not a credential or an identity.
    """
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM tenant WHERE id = ?", (tenant_id,)).fetchone()
    cfg = {
        "account_sid": row["exotel_account_sid"] if row else "",
        "api_key": row["exotel_api_key"] if row else "",
        "api_token": row["exotel_api_token"] if row else "",
        "caller_id": row["exotel_caller_id"] if row else "",
        "flow_url": row["exotel_flow_url"] if row else "",
        "subdomain": os.getenv("EXOTEL_SUBDOMAIN", "api.exotel.com"),
    }
    return {k: (v or "").strip() for k, v in cfg.items()}


def place_call(cfg: Dict[str, str], phone_e164: str,
               custom: Dict[str, Any]) -> Dict[str, Any]:
    """Ask Exotel to dial. Returns {ok, sid|error, http, terminal}."""
    missing = [k for k in ("account_sid", "api_key", "api_token", "caller_id", "flow_url")
               if not cfg.get(k)]
    if missing:
        return {"ok": False, "error": f"telephony not configured: {', '.join(missing)}",
                "http": None, "terminal": True}

    national = "0" + phone_e164[3:] if phone_e164.startswith("+91") else phone_e164
    url = f"https://{cfg['subdomain']}/v1/Accounts/{cfg['account_sid']}/Calls/connect.json"
    auth = base64.b64encode(f"{cfg['api_key']}:{cfg['api_token']}".encode()).decode()

    # Custom params ride along to the Voicebot applet, which forwards them in the
    # start event -- that is how the agent learns who it is calling and why.
    fields = {
        "From": national,
        "CallerId": cfg["caller_id"],
        "CallType": "trans",
        "Url": cfg["flow_url"],
        "CustomField": json.dumps(custom)[:800],
    }
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(),
                                 method="POST")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            call = json.loads(resp.read().decode()).get("Call", {})
            return {"ok": True, "sid": call.get("Sid"), "status": call.get("Status"),
                    "http": resp.status}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:300]
        return {"ok": False, "error": f"HTTP {exc.code}: {detail}", "http": exc.code,
                "terminal": exc.code in TERMINAL_HTTP}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "http": None,
                "terminal": False}
