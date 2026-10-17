"""Where an agent's tokens actually went.

Stage 42 #14, the idea from Hermes Agent's ``agent/insights.py``
(NousResearch/hermes-agent @ a7cd15e), which reads their session SQLite and reports
token consumption, cost, tool-usage patterns and activity trends.

We read a different source, for a reason worth writing down: **per-cycle token
counts are not persisted anywhere queryable.** ``agent_cycles.cost`` holds a single
number computed at cycle end, ``episode_log`` is empty and ``cycle_steps`` carries no
usage block — so a reader pointed at the database could only ever repeat a figure the
dashboard already shows.

What *is* on disk is the telemetry JSONL the agent already writes on every turn
(``JsonlSink`` → ``<workspace>/.nanocrew/telemetry/session-*.jsonl``, wired in
``loop.py``). ``turn_completed`` events carry prompt/completion/cache tokens and the
tools used. That is the real per-turn record, and it is what this reads.

Why it matters here specifically: we run on DeepSeek's peak/off-peak pricing where a
cache hit costs ~1/30th of a miss. "This agent spent $2 today" is not actionable;
"87% of its input was cache misses, and 60% of its turns were one tool" is.

Pure reader — it never writes, and a malformed or missing log yields an empty report
rather than an error.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

TELEMETRY_SUBDIR = Path(".nanocrew") / "telemetry"

TURN_COMPLETED = "turn_completed"


@dataclass
class Insights:
    """Aggregated view of an agent's turns."""

    turns: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    compactions: int = 0
    tool_counts: Counter = field(default_factory=Counter)
    sessions: set = field(default_factory=set)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def cache_hit_rate(self) -> float:
        """Share of input tokens served from cache, 0.0–1.0.

        The single most actionable number we have: on DeepSeek off-peak a cached
        input token is $0.007/M against $0.22/M for a miss, so this moves spend by
        more than an order of magnitude while the token count looks identical.
        """
        if self.prompt_tokens <= 0:
            return 0.0
        return min(1.0, self.cache_read_tokens / self.prompt_tokens)

    @property
    def tools_per_turn(self) -> float:
        return (sum(self.tool_counts.values()) / self.turns) if self.turns else 0.0

    def format(self, top_tools: int = 8) -> str:
        """A short human-readable report. Empty input gets an honest empty answer."""
        if not self.turns:
            return "No completed turns recorded."

        lines = [
            f"{self.turns} turns across {len(self.sessions)} session(s)",
            f"  input      {self.prompt_tokens:,} tokens "
            f"({self.cache_hit_rate:.0%} served from cache)",
            f"  output     {self.completion_tokens:,} tokens",
            f"  per turn   {self.total_tokens // self.turns:,} tokens, "
            f"{self.tools_per_turn:.1f} tool calls",
        ]
        if self.compactions:
            lines.append(f"  compacted  {self.compactions} turn(s)")
        if self.tool_counts:
            lines.append("  tools:")
            for name, count in self.tool_counts.most_common(top_tools):
                share = count / max(1, sum(self.tool_counts.values()))
                lines.append(f"    {name:<24} {count:>5}  ({share:.0%})")
        return "\n".join(lines)


def telemetry_dir(workspace: Path) -> Path:
    return Path(workspace) / TELEMETRY_SUBDIR


def collect(workspace: Path, *, session: str | None = None) -> Insights:
    """Read the telemetry logs and aggregate every completed turn.

    ``session`` filters to one session id. Rotated files (``*.1.jsonl``) are included
    — dropping them would silently under-report exactly the busiest agents.
    """
    out = Insights()
    root = telemetry_dir(workspace)
    if not root.exists():
        return out

    for path in sorted(root.glob("session-*.jsonl")):
        for event in _read_events(path):
            if event.get("event") != TURN_COMPLETED:
                continue
            sid = _session_id(path)
            if session is not None and sid != session:
                continue
            out.turns += 1
            out.sessions.add(sid)
            out.prompt_tokens += _int(event.get("prompt_tokens"))
            out.completion_tokens += _int(event.get("completion_tokens"))
            out.cache_read_tokens += _int(event.get("cache_read_tokens"))
            out.cache_creation_tokens += _int(event.get("cache_creation_tokens"))
            if event.get("compacted"):
                out.compactions += 1
            for tool in event.get("tools_used") or []:
                if isinstance(tool, str):
                    out.tool_counts[tool] += 1
    return out


def _read_events(path: Path) -> list[dict]:
    """Parse one JSONL file, skipping unparsable lines.

    A telemetry log can be truncated mid-write (the sink is line-buffered and a
    container can die at any moment), so a bad final line is expected, not
    exceptional — and must never cost the whole report.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _session_id(path: Path) -> str:
    """``session-cli_default.jsonl`` / ``session-cli_default.1.jsonl`` → ``cli_default``."""
    name = path.name[len("session-"):]
    for suffix in (".jsonl",):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    # Strip a rotation index so a rotated file aggregates with its live sibling.
    head, _, tail = name.rpartition(".")
    return head if head and tail.isdigit() else name


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
