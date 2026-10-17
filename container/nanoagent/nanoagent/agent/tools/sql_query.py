"""sql_query — SQL tool for SQLite files and PostgreSQL databases."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from nanoagent.agent.tools.base import Tool

_DEFAULT_DB   = "/workspace/group/workspace/agent.db"
_MAX_ROWS     = 500
_DEFAULT_ROWS = 100


def _inject_limit(query: str, limit: int) -> str:
    q = query.strip().rstrip(";")
    if q.upper().lstrip().startswith("SELECT") and "LIMIT" not in q.upper():
        return f"{q} LIMIT {limit}"
    return q


class SqlQueryTool(Tool):
    """Run SQL queries against a SQLite file or PostgreSQL database."""

    @property
    def name(self) -> str:
        return "sql_query"

    @property
    def description(self) -> str:
        return (
            "Run a SQL query against a SQLite file or a PostgreSQL database. "
            "Returns results as JSON rows. Use for data analysis, reporting, and "
            "any structured data work. The default database is a SQLite file at "
            "/workspace/group/workspace/agent.db (auto-created on first use). "
            "For PostgreSQL, pass a connection string or set DATABASE_URL in your env."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "SQL statement to execute (SELECT, INSERT, UPDATE, CREATE TABLE, …).",
                },
                "db": {
                    "type": "string",
                    "description": (
                        "Database path or connection string. "
                        "SQLite: file path like /workspace/group/workspace/data.db. "
                        "PostgreSQL: postgresql://user:pass@host:5432/dbname. "
                        "Omit to use the default agent.db SQLite file."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": f"Max rows returned for SELECT queries (default {_DEFAULT_ROWS}, max {_MAX_ROWS}).",
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str, db: str = _DEFAULT_DB, limit: int = _DEFAULT_ROWS, **kwargs: Any) -> str:
        import os
        # Allow DATABASE_URL env var to override default db
        if db == _DEFAULT_DB:
            db = os.environ.get("DATABASE_URL", _DEFAULT_DB)

        limit = min(int(limit), _MAX_ROWS)

        if db.startswith("postgresql://") or db.startswith("postgres://"):
            return await self._run_postgres(query, db, limit)
        return self._run_sqlite(query, db, limit)

    # ── SQLite ────────────────────────────────────────────────────────────────

    def _run_sqlite(self, query: str, db_path: str, limit: int) -> str:
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(_inject_limit(query, limit))

            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = [dict(zip(cols, row)) for row in cur.fetchall()]
                conn.close()
                return json.dumps(
                    {"columns": cols, "rows": rows, "count": len(rows)},
                    default=str,
                    indent=2,
                )
            # Write query (INSERT / UPDATE / CREATE / …)
            conn.commit()
            affected = cur.rowcount
            conn.close()
            return json.dumps({"status": "ok", "affected_rows": affected})
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    # ── PostgreSQL ────────────────────────────────────────────────────────────

    async def _run_postgres(self, query: str, conn_str: str, limit: int) -> str:
        try:
            import asyncpg  # type: ignore[import-untyped]
        except ImportError:
            return json.dumps({
                "error": "asyncpg not installed — PostgreSQL support requires: pip install asyncpg"
            })

        try:
            conn = await asyncpg.connect(conn_str)
            q = _inject_limit(query, limit)
            rows = await conn.fetch(q)
            await conn.close()

            if rows:
                cols = list(rows[0].keys())
                data = [dict(r) for r in rows]
                return json.dumps(
                    {"columns": cols, "rows": data, "count": len(data)},
                    default=str,
                    indent=2,
                )
            return json.dumps({"rows": [], "count": 0})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
