"""DuckDB caching layer for fleet data analytics."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone

import duckdb


class FleetCache:
    """Local analytical cache using DuckDB for SQL queries over fleet data."""

    def __init__(self, db_path: str | None = None) -> None:
        self._db_path = db_path or os.getenv("DUCKDB_PATH", "fleet_cache.duckdb")
        self._conn: duckdb.DuckDBPyConnection | None = None

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            self._conn = duckdb.connect(self._db_path)
            self._init_metadata()
        return self._conn

    def _init_metadata(self) -> None:
        """Create metadata table to track cached datasets."""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS _cache_metadata (
                dataset_name VARCHAR PRIMARY KEY,
                row_count INTEGER,
                cached_at TIMESTAMP,
                source VARCHAR,
                description VARCHAR
            )
        """)

    def cache_dataset(
        self,
        name: str,
        data: list[dict],
        source: str = "mygeotab",
        description: str = "",
    ) -> dict:
        """Cache a list of dicts as a DuckDB table.

        Replaces the table if it already exists.
        """
        if not data:
            return {"dataset": name, "rows": 0, "status": "empty - nothing cached"}

        table_name = _sanitize_table_name(name)

        # Write JSON to temp file for DuckDB to read
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as tmp:
            json.dump(data, tmp)
            tmp_path = tmp.name

        try:
            self.conn.execute(f"DROP TABLE IF EXISTS {table_name}")
            self.conn.execute(
                f"CREATE TABLE {table_name} AS SELECT * FROM read_json_auto('{tmp_path}')"
            )
        finally:
            os.unlink(tmp_path)

        row_count = self.conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]

        # Update metadata
        self.conn.execute(
            """
            INSERT OR REPLACE INTO _cache_metadata
            (dataset_name, row_count, cached_at, source, description)
            VALUES (?, ?, ?, ?, ?)
            """,
            [table_name, row_count, datetime.now(timezone.utc), source, description],
        )

        return {"dataset": table_name, "rows": row_count, "status": "cached"}

    def query(self, sql: str) -> dict:
        """Run a SQL query over cached data. Returns results as list of dicts."""
        try:
            result = self.conn.execute(sql)
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()
            data = [dict(zip(columns, row)) for row in rows]
            return {
                "columns": columns,
                "row_count": len(data),
                "data": data,
            }
        except Exception as e:
            return {"error": str(e)}

    def list_datasets(self) -> list[dict]:
        """List all cached datasets with metadata."""
        try:
            result = self.conn.execute(
                "SELECT * FROM _cache_metadata ORDER BY cached_at DESC"
            )
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()
            return [dict(zip(columns, row)) for row in rows]
        except Exception:
            return []

    def export_dataset(self, name: str, format: str = "json") -> dict:
        """Export a cached dataset to JSON or CSV string."""
        table_name = _sanitize_table_name(name)
        try:
            result = self.conn.execute(f"SELECT * FROM {table_name}")
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()

            if format == "csv":
                lines = [",".join(columns)]
                for row in rows:
                    lines.append(",".join(str(v) for v in row))
                return {"format": "csv", "data": "\n".join(lines)}
            else:
                data = [dict(zip(columns, row)) for row in rows]
                return {"format": "json", "data": data}
        except Exception as e:
            return {"error": str(e)}

    def close(self) -> None:
        """Close the DuckDB connection."""
        if self._conn:
            self._conn.close()
            self._conn = None


def _sanitize_table_name(name: str) -> str:
    """Sanitize a string for use as a DuckDB table name."""
    clean = "".join(c if c.isalnum() or c == "_" else "_" for c in name)
    if clean[0].isdigit():
        clean = "t_" + clean
    return clean.lower()
