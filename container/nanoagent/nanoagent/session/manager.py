"""Session management for conversation history."""

import json
import shutil
from pathlib import Path
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from loguru import logger

from nanoagent.utils.helpers import ensure_dir, safe_filename


@dataclass
class Session:
    """
    A conversation session.

    Stores messages in JSONL format for easy reading and persistence.

    Important: Messages are append-only for LLM cache efficiency.
    The consolidation process writes summaries to MEMORY.md/HISTORY.md
    but does NOT modify the messages list or get_history() output.
    """

    key: str  # channel:chat_id
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    last_consolidated: int = 0  # Number of messages already consolidated to files
    
    def add_message(self, role: str, content: str, **kwargs: Any) -> None:
        """Add a message to the session."""
        msg = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            **kwargs
        }
        self.messages.append(msg)
        self.updated_at = datetime.now()
    
    def get_history(self, max_messages: int = 500) -> list[dict[str, Any]]:
        """Return unconsolidated messages for LLM input, aligned to a user turn."""
        unconsolidated = self.messages[self.last_consolidated:]
        sliced = unconsolidated[-max_messages:]

        # Drop leading non-user messages to avoid orphaned tool_result blocks
        for i, m in enumerate(sliced):
            if m.get("role") == "user":
                sliced = sliced[i:]
                break

        out: list[dict[str, Any]] = []
        seen_reasoning = False
        for m in sliced:
            entry: dict[str, Any] = {"role": m["role"], "content": m.get("content", "")}
            for k in ("tool_calls", "tool_call_id", "name", "reasoning_content"):
                if k in m:
                    entry[k] = m[k]
            if m.get("role") == "assistant":
                if "reasoning_content" in entry:
                    seen_reasoning = True
                elif seen_reasoning:
                    # Once thinking mode is active, all assistant messages need the field
                    entry["reasoning_content"] = ""
            out.append(entry)
        return out
    
    def clear(self) -> None:
        """Clear all messages and reset session to initial state."""
        self.messages = []
        self.last_consolidated = 0
        self.updated_at = datetime.now()


_ROTATION_BYTES = 256 * 1024  # rotate session file at 256 KiB


class SessionManager:
    """
    Manages conversation sessions.

    Sessions are stored as JSONL files in the sessions directory.
    Writes are append-only (crash-safe): new messages are appended per save,
    metadata updates are also appended. On load the last metadata line wins.
    Files are rotated to .1.jsonl at 256 KiB so no file grows unbounded.
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.sessions_dir = ensure_dir(self.workspace / "sessions")
        self.legacy_sessions_dir = Path.home() / ".nanoagent" / "sessions"
        self._cache: dict[str, Session] = {}
        # Append-only tracking: how many messages are already on disk per session
        self._disk_msg_count: dict[str, int] = {}
        self._disk_consolidated: dict[str, int] = {}  # last_consolidated written to disk
    
    def _get_session_path(self, key: str) -> Path:
        """Get the file path for a session."""
        safe_key = safe_filename(key.replace(":", "_"))
        return self.sessions_dir / f"{safe_key}.jsonl"

    def _get_legacy_session_path(self, key: str) -> Path:
        """Legacy global session path (~/.nanoagent/sessions/)."""
        safe_key = safe_filename(key.replace(":", "_"))
        return self.legacy_sessions_dir / f"{safe_key}.jsonl"
    
    def get_or_create(self, key: str) -> Session:
        """
        Get an existing session or create a new one.
        
        Args:
            key: Session key (usually channel:chat_id).
        
        Returns:
            The session.
        """
        if key in self._cache:
            return self._cache[key]
        
        session = self._load(key)
        if session is None:
            session = Session(key=key)
        
        self._cache[key] = session
        return session
    
    def _load(self, key: str) -> Session | None:
        """Load a session from disk.

        Metadata: the LAST metadata line wins (supports append-only updates).
        Malformed JSONL lines are skipped rather than raising.
        """
        path = self._get_session_path(key)
        if not path.exists():
            legacy_path = self._get_legacy_session_path(key)
            if legacy_path.exists():
                try:
                    shutil.move(str(legacy_path), str(path))
                    logger.info("Migrated session {} from legacy path", key)
                except Exception:
                    logger.exception("Failed to migrate session {}", key)

        if not path.exists():
            return None

        try:
            messages: list[dict] = []
            last_meta: dict | None = None

            with open(path, encoding="utf-8") as f:
                for lineno, raw in enumerate(f, 1):
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        logger.debug("Skipping malformed JSONL line {} in {}", lineno, path)
                        continue
                    if data.get("_type") == "metadata":
                        last_meta = data  # last metadata line wins
                    else:
                        messages.append(data)

            meta_dict = last_meta.get("metadata", {}) if last_meta else {}
            created_at = (
                datetime.fromisoformat(last_meta["created_at"])
                if last_meta and last_meta.get("created_at") else None
            )
            last_consolidated = last_meta.get("last_consolidated", 0) if last_meta else 0

            session = Session(
                key=key,
                messages=messages,
                created_at=created_at or datetime.now(),
                metadata=meta_dict,
                last_consolidated=last_consolidated,
            )
            # Initialise disk-tracking so the first save after load is incremental
            self._disk_msg_count[key] = len(messages)
            self._disk_consolidated[key] = last_consolidated
            return session
        except Exception as e:
            logger.warning("Failed to load session {}: {}", key, e)
            return None
    
    def save(self, session: Session) -> None:
        """Save a session to disk using append-only writes.

        Strategy:
        - First save (file absent or disk_count == 0): full atomic write via temp+rename.
        - Subsequent saves: append new messages + metadata update (if changed).
        - Rotation: if file exceeds _ROTATION_BYTES, rename to .1.jsonl and start fresh.
        """
        key = session.key
        path = self._get_session_path(key)
        disk_count = self._disk_msg_count.get(key, 0)
        disk_consolidated = self._disk_consolidated.get(key, -1)

        # --- Rotation --------------------------------------------------------
        if path.exists() and path.stat().st_size > _ROTATION_BYTES:
            rotation_path = path.with_suffix("").with_suffix(".1.jsonl")
            try:
                path.rename(rotation_path)
            except OSError as e:
                logger.warning("Session rotation failed for {}: {}", key, e)
            disk_count = 0
            self._disk_msg_count[key] = 0

        def _meta_line() -> str:
            return json.dumps({
                "_type": "metadata",
                "key": key,
                "created_at": session.created_at.isoformat(),
                "updated_at": session.updated_at.isoformat(),
                "metadata": session.metadata,
                "last_consolidated": session.last_consolidated,
            }, ensure_ascii=False)

        # --- Full write (first save or after rotation) -----------------------
        if disk_count == 0 or not path.exists():
            tmp = path.with_suffix(".tmp")
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(_meta_line() + "\n")
                    for msg in session.messages:
                        f.write(json.dumps(msg, ensure_ascii=False) + "\n")
                tmp.replace(path)  # atomic on POSIX; best-effort on Windows
            except OSError as e:
                logger.error("Failed to write session {}: {}", key, e)
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return
            self._disk_msg_count[key] = len(session.messages)
            self._disk_consolidated[key] = session.last_consolidated
            self._cache[key] = session
            return

        # --- Incremental append ----------------------------------------------
        new_messages = session.messages[disk_count:]
        meta_changed = disk_consolidated != session.last_consolidated

        if not new_messages and not meta_changed:
            self._cache[key] = session
            return

        try:
            with open(path, "a", encoding="utf-8") as f:
                for msg in new_messages:
                    f.write(json.dumps(msg, ensure_ascii=False) + "\n")
                if meta_changed:
                    f.write(_meta_line() + "\n")
        except OSError as e:
            logger.error("Failed to append to session {}: {}", key, e)
            return

        self._disk_msg_count[key] = len(session.messages)
        if meta_changed:
            self._disk_consolidated[key] = session.last_consolidated
        self._cache[key] = session
    
    def invalidate(self, key: str) -> None:
        """Remove a session from the in-memory cache."""
        self._cache.pop(key, None)
    
    def list_sessions(self) -> list[dict[str, Any]]:
        """
        List all sessions.
        
        Returns:
            List of session info dicts.
        """
        sessions = []
        
        for path in self.sessions_dir.glob("*.jsonl"):
            try:
                # Read just the metadata line
                with open(path, encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if first_line:
                        data = json.loads(first_line)
                        if data.get("_type") == "metadata":
                            key = data.get("key") or path.stem.replace("_", ":", 1)
                            sessions.append({
                                "key": key,
                                "created_at": data.get("created_at"),
                                "updated_at": data.get("updated_at"),
                                "path": str(path)
                            })
            except Exception:
                continue
        
        return sorted(sessions, key=lambda x: x.get("updated_at", ""), reverse=True)
