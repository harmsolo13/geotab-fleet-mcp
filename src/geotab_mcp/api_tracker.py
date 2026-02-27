"""SQLite API call tracker for monitoring external API usage and quotas.

Also provides a persistent response cache so stale data can be served when
the upstream Geotab API is rate-limited or unreachable.
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

_DB_PATH = Path(__file__).resolve().parent.parent.parent / "api_tracker.db"


def _get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Create the api_calls and api_response_cache tables if they don't exist."""
    conn = _get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_calls (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp   TEXT NOT NULL,
            service     TEXT NOT NULL,
            method      TEXT NOT NULL,
            status      TEXT NOT NULL,
            response_ms INTEGER NOT NULL,
            error       TEXT,
            cached      INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls (timestamp)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_api_calls_service ON api_calls (service)
    """)
    # Persistent response cache — survives restarts, serves stale when rate-limited
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_response_cache (
            cache_key   TEXT PRIMARY KEY,
            response    TEXT NOT NULL,
            cached_at   REAL NOT NULL,
            ttl_seconds INTEGER NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def log_call(
    service: str,
    method: str,
    status: str = "success",
    response_ms: int = 0,
    error: str | None = None,
    cached: bool = False,
) -> None:
    """Insert a single API call record."""
    conn = _get_db()
    conn.execute(
        "INSERT INTO api_calls (timestamp, service, method, status, response_ms, error, cached) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            datetime.now(timezone.utc).isoformat(),
            service,
            method,
            status,
            response_ms,
            error,
            1 if cached else 0,
        ),
    )
    conn.commit()
    conn.close()


@contextmanager
def track(service: str, method: str):
    """Context manager that times a call and logs the result."""
    t0 = time.monotonic()
    try:
        yield
        ms = int((time.monotonic() - t0) * 1000)
        log_call(service, method, "success", ms)
    except Exception as exc:
        ms = int((time.monotonic() - t0) * 1000)
        log_call(service, method, "error", ms, error=str(exc))
        raise


def get_summary(hours: int = 24) -> list[dict]:
    """Counts grouped by service + status for the last N hours."""
    conn = _get_db()
    cutoff = datetime.now(timezone.utc).isoformat()[: -(len("2026-01-01T00:00:00") - 10)]
    # Use a simpler approach: fetch all and filter in Python isn't needed,
    # SQLite datetime works fine with ISO strings.
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = conn.execute(
        "SELECT service, status, cached, COUNT(*) as cnt, "
        "AVG(response_ms) as avg_ms, MAX(response_ms) as max_ms "
        "FROM api_calls WHERE timestamp >= ? "
        "GROUP BY service, status, cached ORDER BY cnt DESC",
        (cutoff,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_recent(limit: int = 50) -> list[dict]:
    """Last N calls for debugging."""
    conn = _get_db()
    rows = conn.execute(
        "SELECT * FROM api_calls ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Persistent Response Cache ────────────────────────────────────────────

def cache_response(key: str, data: object, ttl: int = 60) -> None:
    """Persist an API response to SQLite for stale-serve fallback."""
    try:
        conn = _get_db()
        conn.execute(
            "INSERT OR REPLACE INTO api_response_cache "
            "(cache_key, response, cached_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (key, json.dumps(data, default=str), time.time(), ttl),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass  # Never let cache persistence break the main flow


def get_cached_response(key: str, max_age: int = 0) -> object | None:
    """Retrieve a cached response from SQLite.

    Args:
        key: The cache key to look up.
        max_age: Maximum age in seconds. 0 = any age (stale OK).
    Returns:
        Deserialized response data, or None if not found / too old.
    """
    try:
        conn = _get_db()
        row = conn.execute(
            "SELECT response, cached_at FROM api_response_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()
        conn.close()
        if row is None:
            return None
        if max_age > 0 and (time.time() - row["cached_at"]) > max_age:
            return None
        return json.loads(row["response"])
    except Exception:
        return None


def get_cached_response_like(prefix: str) -> object | None:
    """Retrieve the most recent cached response matching a key prefix.

    Useful when exact args hash won't match (e.g. different date formats
    for the same logical query like get_exception_events).
    """
    try:
        conn = _get_db()
        row = conn.execute(
            "SELECT response, cached_at FROM api_response_cache "
            "WHERE cache_key LIKE ? ORDER BY cached_at DESC LIMIT 1",
            (prefix + "%",),
        ).fetchone()
        conn.close()
        if row is None:
            return None
        return json.loads(row["response"])
    except Exception:
        return None


def clear_response_cache() -> int:
    """Remove all cached responses. Returns count deleted."""
    conn = _get_db()
    cursor = conn.execute("DELETE FROM api_response_cache")
    count = cursor.rowcount
    conn.commit()
    conn.close()
    return count
