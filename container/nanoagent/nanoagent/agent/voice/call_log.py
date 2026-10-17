"""
Durable call logging.

Calls happen on a phone, which nobody debugging this can hear. Everything needed
to reconstruct one afterwards is written to disk:

  logs/server.log              rotating text log of every call
  logs/calls/<sid>_in.wav      exactly what Exotel sent us
  logs/calls/<sid>_out.wav     exactly what we sent Exotel
  logs/calls/<sid>.json        transcript, timings and frame counts

The WAV files are the important part: they can be fed back through STT to find
out what was really on the line, which is how the self-conversation was proved to
be our own audio echoing back rather than the caller speaking.
"""
import os
import json
import time
import wave
import logging
import logging.handlers
from typing import Optional, Dict, Any, List

BASE = os.path.dirname(__file__)
LOG_DIR = os.path.join(BASE, "logs")
CALL_DIR = os.path.join(LOG_DIR, "calls")

RECORD_CALLS = os.getenv("RECORD_CALLS", "1") not in ("0", "false", "False")
KEEP_CALLS = int(os.getenv("KEEP_CALLS", "40"))       # newest N call recordings


def setup_file_logging() -> str:
    """Adds a rotating file handler alongside whatever is already configured."""
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, "server.log")
    root = logging.getLogger()
    if any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        return path
    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=8 * 1024 * 1024, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s | %(message)s"))
    root.addHandler(handler)
    return path


class CallRecorder:
    """Captures both audio directions and the transcript for one call."""

    def __init__(self, call_id: str, sample_rate: int):
        self.call_id = "".join(c for c in call_id if c.isalnum() or c in "-_")[:48]
        self.sample_rate = sample_rate
        self.started = time.time()
        self.events: List[Dict[str, Any]] = []
        self._in: Optional[wave.Wave_write] = None
        self._out: Optional[wave.Wave_write] = None
        self._caller: Optional[wave.Wave_write] = None
        if RECORD_CALLS:
            os.makedirs(CALL_DIR, exist_ok=True)
            self._in = self._open("in")
            self._out = self._open("out")
            # Only the frames that survived the echo gate. _in.wav keeps
            # everything for diagnosing echo; this one is the caller alone, so it
            # can be re-transcribed without picking up our own voice.
            self._caller = self._open("caller")

    def _open(self, tag: str) -> Optional[wave.Wave_write]:
        try:
            fh = wave.open(os.path.join(CALL_DIR, f"{self.call_id}_{tag}.wav"), "wb")
            fh.setnchannels(1)
            fh.setsampwidth(2)
            fh.setframerate(self.sample_rate)
            return fh
        except Exception:
            return None

    def set_rate(self, rate: int) -> None:
        """The real rate is only known once Exotel's start event arrives."""
        if rate == self.sample_rate:
            return
        self.sample_rate = rate
        for tag, attr in (("in", "_in"), ("out", "_out"), ("caller", "_caller")):
            handle = getattr(self, attr)
            if handle:
                try:
                    handle.close()
                except Exception:
                    pass
            setattr(self, attr, self._open(tag))

    def write_in(self, pcm: bytes) -> None:
        if self._in:
            try:
                self._in.writeframes(pcm)
            except Exception:
                self._in = None

    def write_caller(self, pcm: bytes) -> None:
        """Frames the echo gate let through -- the caller, without our echo."""
        if self._caller:
            try:
                self._caller.writeframes(pcm)
            except Exception:
                self._caller = None

    def write_out(self, pcm: bytes) -> None:
        if self._out:
            try:
                self._out.writeframes(pcm)
            except Exception:
                self._out = None

    def note(self, kind: str, **fields) -> None:
        self.events.append({"t": round(time.time() - self.started, 2),
                            "kind": kind, **fields})

    def close(self, summary: Dict[str, Any]) -> None:
        for handle in (self._in, self._out, self._caller):
            if handle:
                try:
                    handle.close()
                except Exception:
                    pass
        if not RECORD_CALLS:
            return
        try:
            path = os.path.join(CALL_DIR, f"{self.call_id}.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"call_id": self.call_id,
                           "started": time.strftime("%Y-%m-%d %H:%M:%S",
                                                    time.localtime(self.started)),
                           "duration_s": round(time.time() - self.started, 1),
                           "sample_rate": self.sample_rate,
                           "summary": summary,
                           "events": self.events}, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass
        _prune()


def _prune() -> None:
    """Keep the newest KEEP_CALLS recordings so this cannot fill the disk."""
    try:
        entries = [os.path.join(CALL_DIR, f) for f in os.listdir(CALL_DIR)]
        stems: Dict[str, float] = {}
        for path in entries:
            stem = os.path.basename(path).split("_")[0].split(".")[0]
            stems[stem] = max(stems.get(stem, 0), os.path.getmtime(path))
        for stem in sorted(stems, key=stems.get, reverse=True)[KEEP_CALLS:]:
            for path in entries:
                if os.path.basename(path).startswith(stem):
                    os.remove(path)
    except Exception:
        pass
