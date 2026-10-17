"""BM25-based persistent memory store for semantic search over past cycle work."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _tokenize(text: str) -> list[str]:
    """Lowercase word tokenizer — strip punctuation, split on whitespace."""
    return re.findall(r"[a-z0-9]+", text.lower())


class VectorMemoryStore:
    """
    Persistent BM25 memory store.

    Entries are stored as JSONL at <memory_dir>/memories.jsonl.
    On each search the index is rebuilt from the JSONL file (files are small
    in practice — hundreds of entries at most — so rebuild is fast).
    """

    def __init__(self, memory_dir: str | Path) -> None:
        self._dir = Path(memory_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._jsonl = self._dir / "memories.jsonl"

    # ── Write ────────────────────────────────────────────────────────────────

    def add(self, text: str, metadata: dict[str, Any]) -> None:
        """Append a new memory entry."""
        entry = {"text": text, **metadata}
        with self._jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # ── Read ─────────────────────────────────────────────────────────────────

    def _load(self) -> list[dict[str, Any]]:
        if not self._jsonl.exists():
            return []
        entries = []
        for line in self._jsonl.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return entries

    def search(self, query: str, top_k: int = 5) -> list[dict[str, Any]]:
        """Return the top-k most relevant entries for the query using BM25."""
        entries = self._load()
        if not entries:
            return []

        try:
            from rank_bm25 import BM25Okapi  # type: ignore[import-untyped]
        except ImportError:
            # Fallback: token overlap scoring when rank-bm25 is not installed
            q_tokens = set(_tokenize(query))
            if not q_tokens:
                return []
            scored = []
            for e in entries:
                e_tokens = set(_tokenize(e.get("text", "")))
                overlap = len(q_tokens & e_tokens) / len(q_tokens)
                if overlap > 0:
                    scored.append((overlap, e))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [{"score": s, **e} for s, e in scored[:top_k]]

        corpus = [_tokenize(e.get("text", "")) for e in entries]
        bm25 = BM25Okapi(corpus)
        scores = bm25.get_scores(_tokenize(query))

        # Pair scores with entries, sort descending, return top-k with score > 0
        ranked = sorted(
            [(float(s), e) for s, e in zip(scores, entries) if s > 0],
            key=lambda x: x[0],
            reverse=True,
        )
        return [{"score": s, **e} for s, e in ranked[:top_k]]

    @property
    def entry_count(self) -> int:
        return len(self._load())
