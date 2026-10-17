"""
SQLite storage for the multi-tenant product.

Every business table carries tenant_id. Retrofitting that column later is the
single most expensive mistake available here, so it goes in now while there is
one tenant and the cost is zero.

The schema mirrors the loop every commercial voice-sales platform uses:

    CONTACT -> CAMPAIGN -> CALL -> OUTCOME -> back to the CRM

Telephony credentials live on the tenant, not in .env. A pilot company should
dial with their own Exotel account and ExoPhone, which also puts DND liability
on the business that owns the customer relationship.
"""
import os
import json
import sqlite3
import secrets
from typing import Optional, Any, Dict, List

DB_PATH = os.getenv("VOICE_DB", os.path.join(os.path.dirname(__file__), "voice_agent.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenant (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name    TEXT NOT NULL,
    website         TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    -- Telephony belongs to the tenant: their account, their ExoPhone, their
    -- DND liability. Null means this tenant CANNOT dial -- there is deliberately
    -- no .env fallback, because inheriting the operator's carrier account put the
    -- operator's number in front of the prospect and the operator's name on the
    -- DND complaint.
    exotel_account_sid TEXT,
    exotel_api_key     TEXT,
    exotel_api_token   TEXT,
    exotel_caller_id   TEXT,
    exotel_flow_url    TEXT,
    -- Authenticates POST /api/v1/trigger for this tenant.
    api_key            TEXT
);

CREATE TABLE IF NOT EXISTS agent (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    voice         TEXT NOT NULL DEFAULT 'Puck',
    language      TEXT NOT NULL DEFAULT 'hi-IN',
    -- What the company sells, in the company's own words. Composed into the
    -- system prompt at call time rather than stored pre-rendered, so a prompt
    -- template change reaches every existing agent.
    company_blurb TEXT,
    key_facts     TEXT,
    goal          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    agent_id      INTEGER REFERENCES agent(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    goal          TEXT,
    allowed_tools TEXT NOT NULL DEFAULT '[]',
    -- TRAI restricts promotional calls; transactional calls to a whitelisted
    -- customer are treated differently. The gate needs to know which this is.
    call_type     TEXT NOT NULL DEFAULT 'transactional',
    window_start  TEXT NOT NULL DEFAULT '09:00',
    window_end    TEXT NOT NULL DEFAULT '21:00',
    max_attempts  INTEGER NOT NULL DEFAULT 2,
    status        TEXT NOT NULL DEFAULT 'draft',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    campaign_id   INTEGER REFERENCES campaign(id) ON DELETE CASCADE,
    name          TEXT,
    phone_e164    TEXT NOT NULL,
    -- Whatever the company knows about this person: plan, invoice, cart value.
    -- This is what makes a call specific rather than generic.
    custom_fields TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    campaign_id   INTEGER REFERENCES campaign(id) ON DELETE SET NULL,
    contact_id    INTEGER REFERENCES contact(id) ON DELETE SET NULL,
    provider_sid  TEXT,
    direction     TEXT NOT NULL DEFAULT 'outbound',
    channel       TEXT NOT NULL DEFAULT 'phone',
    status        TEXT NOT NULL DEFAULT 'queued',
    started_at    TEXT,
    ended_at      TEXT,
    duration_s    REAL,
    recording_dir TEXT,
    tools_used    INTEGER NOT NULL DEFAULT 0,
    echo_suppressed INTEGER NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS turn (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id   INTEGER NOT NULL REFERENCES call(id) ON DELETE CASCADE,
    t_offset  REAL NOT NULL,
    speaker   TEXT NOT NULL,
    text      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcome (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id     INTEGER NOT NULL REFERENCES call(id) ON DELETE CASCADE,
    disposition TEXT,
    booked_slot TEXT,
    notes       TEXT,
    next_action TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    campaign_id   INTEGER REFERENCES campaign(id) ON DELETE SET NULL,
    contact_id    INTEGER REFERENCES contact(id) ON DELETE SET NULL,
    phone_e164    TEXT NOT NULL,
    lead_name     TEXT,
    -- Why this call is happening, and anything the script should reference.
    reason        TEXT,
    context       TEXT NOT NULL DEFAULT '{}',
    source        TEXT NOT NULL DEFAULT 'trigger',
    -- Webhook retries are normal. The same event must never dial twice, so the
    -- caller supplies a key and a repeat is a no-op rather than a second call.
    trigger_key   TEXT,
    status        TEXT NOT NULL DEFAULT 'queued',
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 2,
    not_before    TEXT NOT NULL DEFAULT (datetime('now')),
    last_error    TEXT,
    call_id       INTEGER REFERENCES call(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant_id, trigger_key)
);

CREATE INDEX IF NOT EXISTS idx_queue_ready ON call_queue(status, not_before);

CREATE TABLE IF NOT EXISTS booking (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    call_id       INTEGER REFERENCES call(id) ON DELETE SET NULL,
    contact_name  TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    slot_start    TEXT NOT NULL,
    slot_end      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'confirmed',
    email_sent    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_booking_slot   ON booking(tenant_id, slot_start);
CREATE INDEX IF NOT EXISTS idx_contact_tenant  ON contact(tenant_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_call_tenant     ON call(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_provider   ON call(provider_sid);
CREATE INDEX IF NOT EXISTS idx_turn_call       ON turn(call_id);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


# Columns added after a table already existed. CREATE TABLE IF NOT EXISTS will
# not add them, so they are applied explicitly on every start. This is idempotent
# because the live table is inspected first.
MIGRATIONS = [
    ("tenant", "api_key", "TEXT"),
    ("tenant", "exotel_account_sid", "TEXT"),
    ("tenant", "exotel_api_key", "TEXT"),
    ("tenant", "exotel_api_token", "TEXT"),
    ("tenant", "exotel_caller_id", "TEXT"),
    ("tenant", "exotel_flow_url", "TEXT"),
    ("call", "queue_id", "INTEGER"),
    ("call", "contact_name", "TEXT"),
    ("call", "contact_phone", "TEXT"),
    ("tenant", "outcome_webhook_url", "TEXT"),
    ("tenant", "onboarded", "INTEGER"),
    ("agent", "website", "TEXT"),
    # Per-tenant SMTP for demo invites. The prototype read the operator's own
    # nanocrew-main/.env, so every tenant's invite was sent FROM the operator's
    # address; a prospect replying to it reached the wrong company. A tenant with
    # none of these configured simply does not send invites (the booking is still
    # recorded) rather than borrowing someone else's identity.
    ("tenant", "smtp_host", "TEXT"),
    ("tenant", "smtp_port", "INTEGER"),
    ("tenant", "smtp_user", "TEXT"),
    ("tenant", "smtp_password", "TEXT"),
    ("tenant", "smtp_from", "TEXT"),
    # The NanoCrew user this voice tenant belongs to. Voice keeps its own SQLite
    # tenant table (calls, campaigns, carrier credentials), but identity is
    # NanoCrew's — this is the join between the two, and what lets a cycle resolve
    # "which tenant am I" from the agent's owner rather than a hardcoded id.
    ("tenant", "owner_id", "TEXT"),
    ("agent", "one_liner", "TEXT"),
    ("agent", "who_they_sell_to", "TEXT"),
    ("agent", "tone", "TEXT"),
    ("agent", "profile_json", "TEXT"),
    ("outcome", "objection", "TEXT"),
    ("outcome", "callback_at", "TEXT"),
    ("outcome", "confidence", "REAL"),
    ("outcome", "contact_email", "TEXT"),
]


def init_db() -> str:
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, column, coltype in MIGRATIONS:
            existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
        # Indexes over MIGRATED columns must come after the loop above, not in
        # SCHEMA: SCHEMA runs first, when owner_id may not exist yet, and the whole
        # executescript fails with "no such column".
        # Unique so one NanoCrew user cannot end up with two voice tenants, which
        # would make "whose carrier account is this" resolve arbitrarily.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_owner ON tenant(owner_id) "
            "WHERE owner_id IS NOT NULL")
    return DB_PATH


# -- tenants ---------------------------------------------------------------
# Identity, passwords and login sessions are NanoCrew's job, not this service's.
# The prototype carried its own user/session tables and a PBKDF2 login; both were
# removed when this became a NanoCrew service. A "tenant" here is just the owner
# of a set of credentials, agents and calls — NanoCrew authenticates the caller
# and passes the tenant down.
def create_tenant(company_name: str, website: str = "") -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO tenant (company_name, website) VALUES (?, ?)",
            (company_name, website))
        return cur.lastrowid


def provision_tenant(company_name: str, agent_name: str, goal: str,
                     company_blurb: str = "", website: str = "",
                     allowed_tools: Optional[List[str]] = None) -> Dict[str, Any]:
    """Create a tenant plus its first agent and campaign, from the USER's values.

    Every field the agent speaks with is a parameter. The prototype's signup()
    hardcoded the agent name ("Aarav"), invented a company blurb, and assumed the
    goal was "Book a 15-minute demo" — fine while this dialled for one company,
    wrong the moment a user brings their own. Nothing here has a persona default:
    a caller that does not say who the agent is does not get an agent.
    """
    company_name = (company_name or "").strip()
    agent_name = (agent_name or "").strip()
    goal = (goal or "").strip()
    missing = [n for n, v in (("company_name", company_name),
                              ("agent_name", agent_name),
                              ("goal", goal)) if not v]
    if missing:
        return {"ok": False, "error": f"missing required field(s): {', '.join(missing)}"}

    tenant_id = create_tenant(company_name, website)
    with connect() as conn:
        agent_id = conn.execute(
            "INSERT INTO agent (tenant_id, name, company_blurb, goal) VALUES (?,?,?,?)",
            (tenant_id, agent_name, company_blurb, goal)).lastrowid
        conn.execute(
            "INSERT INTO campaign (tenant_id, agent_id, name, goal, allowed_tools) "
            "VALUES (?,?,?,?,?)",
            (tenant_id, agent_id, "First campaign", goal,
             json.dumps(allowed_tools if allowed_tools is not None else [])))
    return {"ok": True, "tenant_id": tenant_id, "agent_id": agent_id}


# -- calls -----------------------------------------------------------------
def start_call(tenant_id: int, **fields) -> int:
    cols = ["tenant_id"] + list(fields)
    vals = [tenant_id] + [fields[k] for k in fields]
    with connect() as conn:
        cur = conn.execute(
            f"INSERT INTO call ({','.join(cols)}, started_at) "
            f"VALUES ({','.join('?' * len(cols))}, datetime('now'))", vals)
        return cur.lastrowid


def finish_call(call_id: int, close: bool = True, **fields) -> None:
    """Update a call row. close=False for mid-call detail (the prospect's name),
    which must not stamp ended_at on a call still in progress."""
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    tail = ", ended_at = datetime('now')" if close else ""
    with connect() as conn:
        conn.execute(f"UPDATE call SET {sets}{tail} WHERE id = ?",
                     list(fields.values()) + [call_id])


def merge_turns(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Join consecutive fragments from the same speaker into one utterance.

    Gemini streams transcription a word at a time, so a 93-second call arrived as
    147 rows reading "Namaste ji" / "ji!" / "Main Aarav" / "bol" / "raha" — one
    word per line, unreadable as a conversation. Tool events always stand alone.
    """
    merged: List[Dict[str, Any]] = []
    for turn in turns:
        speaker = turn.get("speaker", "agent")
        text = (turn.get("text") or "").strip()
        if not text:
            continue
        if (merged and speaker != "tool" and merged[-1]["speaker"] == speaker):
            joiner = "" if merged[-1]["text"].endswith(("-", "—")) else " "
            merged[-1]["text"] = (merged[-1]["text"] + joiner + text).strip()
        else:
            merged.append({"t": turn.get("t", 0), "speaker": speaker, "text": text})
    return merged


def add_turns(call_id: int, turns: List[Dict[str, Any]]) -> None:
    turns = merge_turns(turns)
    if not turns:
        return
    with connect() as conn:
        conn.executemany(
            "INSERT INTO turn (call_id, t_offset, speaker, text) VALUES (?,?,?,?)",
            [(call_id, t.get("t", 0), t.get("speaker", "agent"), t.get("text", ""))
             for t in turns])


def recent_calls(tenant_id: int, limit: int = 50) -> List[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT c.*, COALESCE(c.contact_name, ct.name) AS contact_name, "
            "       COALESCE(c.contact_phone, ct.phone_e164) AS phone_e164, "
            "       cp.name AS campaign_name, o.disposition "
            "FROM call c "
            "LEFT JOIN contact ct  ON ct.id = c.contact_id "
            "LEFT JOIN campaign cp ON cp.id = c.campaign_id "
            "LEFT JOIN outcome o   ON o.call_id = c.id "
            "WHERE c.tenant_id = ? ORDER BY c.id DESC LIMIT ?",
            (tenant_id, limit)).fetchall()


def call_detail(tenant_id: int, call_id: int):
    with connect() as conn:
        call = conn.execute("SELECT * FROM call WHERE id = ? AND tenant_id = ?",
                            (call_id, tenant_id)).fetchone()
        if not call:
            return None, [], None
        turns = conn.execute(
            "SELECT * FROM turn WHERE call_id = ? ORDER BY t_offset", (call_id,)).fetchall()
        outcome = conn.execute("SELECT * FROM outcome WHERE call_id = ?",
                               (call_id,)).fetchone()
        return call, turns, outcome


def stats(tenant_id: int) -> Dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS total, "
            "  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, "
            "  SUM(tools_used) AS tools, "
            "  AVG(duration_s) AS avg_duration "
            "FROM call WHERE tenant_id = ?", (tenant_id,)).fetchone()
        booked = conn.execute(
            "SELECT COUNT(*) AS n FROM outcome o JOIN call c ON c.id = o.call_id "
            "WHERE c.tenant_id = ? AND o.disposition = 'demo_booked'",
            (tenant_id,)).fetchone()
        contacts = conn.execute(
            "SELECT COUNT(*) AS n FROM contact WHERE tenant_id = ?",
            (tenant_id,)).fetchone()
    return {"calls": row["total"] or 0,
            "completed": row["completed"] or 0,
            "tools_used": row["tools"] or 0,
            "avg_duration": round(row["avg_duration"] or 0, 1),
            "demos_booked": booked["n"] or 0,
            "contacts": contacts["n"] or 0}


if __name__ == "__main__":
    print("initialised", init_db())


# -- bookings --------------------------------------------------------------
def booked_slots(tenant_id: int) -> List[str]:
    """Slot starts already taken, so the agent never offers one twice."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT slot_start FROM booking WHERE tenant_id = ? "
            "AND status = 'confirmed' AND slot_start >= datetime('now')",
            (tenant_id,)).fetchall()
    return [r["slot_start"] for r in rows]


def create_booking(tenant_id: int, slot_start: str, slot_end: str,
                   **fields) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO booking (tenant_id, slot_start, slot_end, call_id, "
            "contact_name, contact_email, contact_phone) VALUES (?,?,?,?,?,?,?)",
            (tenant_id, slot_start, slot_end, fields.get("call_id"),
             fields.get("contact_name"), fields.get("contact_email"),
             fields.get("contact_phone")))
        return cur.lastrowid


def mark_booking_emailed(booking_id: int) -> None:
    with connect() as conn:
        conn.execute("UPDATE booking SET email_sent = 1 WHERE id = ?", (booking_id,))


def upcoming_bookings(tenant_id: int, limit: int = 50) -> List[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM booking WHERE tenant_id = ? AND status = 'confirmed' "
            "ORDER BY slot_start LIMIT ?", (tenant_id, limit)).fetchall()


# -- API keys --------------------------------------------------------------
def tenant_for_owner(owner_id: str) -> Optional[sqlite3.Row]:
    """The voice tenant belonging to a NanoCrew user, or None.

    Voice tenants are local to this package's database; NanoCrew owns identity.
    Returning None (rather than falling back to tenant 1, which is what a bare
    auto-increment id invites) is what keeps an unprovisioned user from dialling
    on somebody else's carrier account.
    """
    if not owner_id:
        return None
    with connect() as conn:
        return conn.execute("SELECT * FROM tenant WHERE owner_id = ?",
                            (owner_id.strip(),)).fetchone()


def ensure_api_key(tenant_id: int) -> str:
    with connect() as conn:
        row = conn.execute("SELECT api_key FROM tenant WHERE id = ?",
                           (tenant_id,)).fetchone()
        if row and row["api_key"]:
            return row["api_key"]
        key = "vsa_" + secrets.token_urlsafe(24)
        conn.execute("UPDATE tenant SET api_key = ? WHERE id = ?", (key, tenant_id))
        return key


def tenant_by_api_key(api_key: str) -> Optional[sqlite3.Row]:
    if not api_key:
        return None
    with connect() as conn:
        return conn.execute("SELECT * FROM tenant WHERE api_key = ?",
                            (api_key.strip(),)).fetchone()


# -- call queue ------------------------------------------------------------
def enqueue_call(tenant_id: int, phone_e164: str, **fields) -> Dict[str, Any]:
    """Add one call. A repeated trigger_key is a no-op, not a second call."""
    key = fields.get("trigger_key")
    if key:
        with connect() as conn:
            existing = conn.execute(
                "SELECT id, status FROM call_queue WHERE tenant_id = ? AND trigger_key = ?",
                (tenant_id, key)).fetchone()
        if existing:
            return {"queued": False, "duplicate": True, "id": existing["id"],
                    "status": existing["status"]}
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO call_queue (tenant_id, phone_e164, lead_name, reason, "
            "context, source, trigger_key, campaign_id, max_attempts, not_before) "
            "VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now')))",
            (tenant_id, phone_e164, fields.get("lead_name"), fields.get("reason"),
             json.dumps(fields.get("context") or {}), fields.get("source", "trigger"),
             key, fields.get("campaign_id"), fields.get("max_attempts", 2),
             fields.get("not_before")))
        return {"queued": True, "duplicate": False, "id": cur.lastrowid,
                "status": "queued"}


def claim_next_call(now_ok: bool = True) -> Optional[sqlite3.Row]:
    """Atomically take the next due item so two workers cannot dial the same row."""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM call_queue WHERE status = 'queued' "
            "AND not_before <= datetime('now') ORDER BY id LIMIT 1").fetchone()
        if not row:
            return None
        changed = conn.execute(
            "UPDATE call_queue SET status = 'dialing', attempts = attempts + 1, "
            "updated_at = datetime('now') WHERE id = ? AND status = 'queued'",
            (row["id"],)).rowcount
        if not changed:
            return None
        return conn.execute("SELECT * FROM call_queue WHERE id = ?",
                            (row["id"],)).fetchone()


def finish_queued(queue_id: int, status: str, **fields) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    sql = f"UPDATE call_queue SET status = ?{', ' + sets if sets else ''}, "           f"updated_at = datetime('now') WHERE id = ?"
    with connect() as conn:
        conn.execute(sql, [status] + list(fields.values()) + [queue_id])


def retry_later(queue_id: int, minutes: int, error: str) -> None:
    """Put a failed attempt back with backoff, unless it is out of attempts."""
    with connect() as conn:
        row = conn.execute("SELECT attempts, max_attempts FROM call_queue WHERE id = ?",
                           (queue_id,)).fetchone()
        if not row or row["attempts"] >= row["max_attempts"]:
            conn.execute("UPDATE call_queue SET status = 'failed', last_error = ?, "
                         "updated_at = datetime('now') WHERE id = ?", (error, queue_id))
        else:
            conn.execute(
                "UPDATE call_queue SET status = 'queued', last_error = ?, "
                "not_before = datetime('now', ?), updated_at = datetime('now') "
                "WHERE id = ?", (error, f"+{minutes} minutes", queue_id))


def queue_rows(tenant_id: int, limit: int = 100) -> List[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM call_queue WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
            (tenant_id, limit)).fetchall()


def save_outcome(call_id: int, data: Dict[str, Any]) -> int:
    with connect() as conn:
        conn.execute("DELETE FROM outcome WHERE call_id = ?", (call_id,))
        cur = conn.execute(
            "INSERT INTO outcome (call_id, disposition, notes, next_action, "
            "objection, callback_at, confidence, contact_email, booked_slot) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (call_id, data.get("disposition"), data.get("summary"),
             data.get("next_action"), data.get("objection"), data.get("callback_at"),
             data.get("confidence"), data.get("contact_email"),
             data.get("booked_slot")))
        return cur.lastrowid


def tenant_row(tenant_id: int) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM tenant WHERE id = ?", (tenant_id,)).fetchone()


def outcome_counts(tenant_id: int) -> List[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT o.disposition, COUNT(*) AS n FROM outcome o "
            "JOIN call c ON c.id = o.call_id WHERE c.tenant_id = ? "
            "GROUP BY o.disposition ORDER BY n DESC", (tenant_id,)).fetchall()


# -- company profile -------------------------------------------------------
def save_company_profile(tenant_id: int, profile: Dict[str, Any],
                         goal: str = "", agent_name: str = "") -> None:
    """Store what the agent knows about the business it is calling for.

    `agent_name` names the persona only when this call CREATES the agent row; an
    existing agent keeps the name its owner chose. It used to be hardcoded to
    "Aarav", which silently overrode the user's choice on first profile save.
    """
    facts = profile.get("key_facts") or []
    with connect() as conn:
        row = conn.execute("SELECT id FROM agent WHERE tenant_id = ? LIMIT 1",
                           (tenant_id,)).fetchone()
        values = (profile.get("company_name") or "",
                  profile.get("source_url") or "",
                  profile.get("one_liner") or "",
                  profile.get("what_they_sell") or "",
                  "; ".join(facts) if isinstance(facts, list) else str(facts),
                  profile.get("who_they_sell_to") or "",
                  profile.get("tone") or "",
                  json.dumps(profile, ensure_ascii=False),
                  goal or "Book a short demo.")
        if row:
            conn.execute(
                "UPDATE agent SET company_blurb=?, website=?, one_liner=?, "
                "key_facts=?, who_they_sell_to=?, tone=?, profile_json=?, goal=? "
                "WHERE id=?",
                (values[2], values[1], values[2], values[4], values[5], values[6],
                 values[7], values[8], row["id"]))
            conn.execute("UPDATE agent SET company_blurb=? WHERE id=?",
                         (values[3], row["id"]))
        else:
            conn.execute(
                "INSERT INTO agent (tenant_id, name, company_blurb, website, "
                "one_liner, key_facts, who_they_sell_to, tone, profile_json, goal) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (tenant_id, (agent_name or "").strip() or "Agent",
                 values[3], values[1], values[2], values[4],
                 values[5], values[6], values[7], values[8]))
        if profile.get("company_name"):
            conn.execute("UPDATE tenant SET company_name=?, website=?, onboarded=1 "
                         "WHERE id=?",
                         (profile["company_name"], values[1], tenant_id))
        else:
            conn.execute("UPDATE tenant SET onboarded=1 WHERE id=?", (tenant_id,))


def agent_row(tenant_id: int) -> Optional[sqlite3.Row]:
    with connect() as conn:
        return conn.execute("SELECT * FROM agent WHERE tenant_id = ? LIMIT 1",
                            (tenant_id,)).fetchone()


def is_onboarded(tenant_id: int) -> bool:
    row = tenant_row(tenant_id)
    return bool(row and row["onboarded"])


def queue_row_by_id(queue_id: int) -> Optional[sqlite3.Row]:
    """Look one queue entry up by id.

    Exotel's applet URL is a single global address with no tenant in it, so a
    phone call cannot say who it belongs to. The dialer passes queue_id through
    as a custom parameter; this is how the call is attributed back to the tenant
    that asked for it, instead of always landing on tenant 1.
    """
    try:
        qid = int(queue_id)
    except (TypeError, ValueError):
        return None
    with connect() as conn:
        return conn.execute("SELECT * FROM call_queue WHERE id = ?", (qid,)).fetchone()


def adopt_queued_call(queue_id: int, provider_sid: str,
                      recording_dir: str) -> Optional[int]:
    """Claim the row the dialer already opened for this queue entry.

    The dialer inserts a 'ringing' row the moment Exotel accepts the request; the
    stream handler used to insert a second one when the audio socket opened. That
    left every real call as two rows -- one stuck on 'ringing' forever, one with
    the actual conversation. One call is one row.
    """
    try:
        qid = int(queue_id)
    except (TypeError, ValueError):
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM call WHERE queue_id = ? AND duration_s IS NULL "
            "ORDER BY id DESC LIMIT 1", (qid,)).fetchone()
        if not row:
            return None
        conn.execute("UPDATE call SET status='in_progress', provider_sid=?, "
                     "recording_dir=?, started_at=datetime('now') WHERE id=?",
                     (provider_sid, recording_dir, row["id"]))
        return row["id"]


def recent_queue_for_phone(phone_e164: str, minutes: int = 15) -> Optional[sqlite3.Row]:
    """Find the queue entry a live call almost certainly belongs to.

    Exotel's `CustomField` on connect.json does NOT reach the Voicebot start
    event -- its custom_parameters come from the applet URL instead. So a real
    call arrives with no queue_id, no lead name and no reason, and every call
    landed on tenant 1 as "Unknown". Matching the number we just dialled recovers
    all three without the tenant having to reconfigure anything in Exotel.
    """
    digits = "".join(c for c in (phone_e164 or "") if c.isdigit())[-10:]
    if len(digits) != 10:
        return None
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM call_queue WHERE phone_e164 LIKE ? "
            "AND updated_at >= datetime('now', ?) "
            "ORDER BY id DESC LIMIT 1",
            (f"%{digits}", f"-{int(minutes)} minutes")).fetchone()


def call_detail_any(call_id: int):
    """Same as call_detail but without a tenant scope -- for internal
    post-processing that already knows which call it is working on."""
    with connect() as conn:
        call = conn.execute("SELECT * FROM call WHERE id = ?", (call_id,)).fetchone()
        turns = conn.execute("SELECT * FROM turn WHERE call_id = ? ORDER BY t_offset",
                             (call_id,)).fetchall()
        outcome = conn.execute("SELECT * FROM outcome WHERE call_id = ?",
                               (call_id,)).fetchone()
    return call, turns, outcome
