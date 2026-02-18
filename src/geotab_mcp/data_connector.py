"""Geotab Data Connector (OData v4) client for pre-aggregated fleet KPIs."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import httpx


# Data Connector OData server base URLs
DC_SERVERS = [
    "https://dataconnector{n}.geotab.com/odata/v4/{database}",
]


class DataConnector:
    """Client for Geotab Data Connector OData v4 API."""

    def __init__(self) -> None:
        self._base_url: str | None = None
        self._client: httpx.Client | None = None

    def _get_credentials(self) -> tuple[str, str, str]:
        """Get Data Connector credentials from env."""
        database = os.getenv("GEOTAB_DC_DATABASE", os.getenv("GEOTAB_DATABASE", ""))
        username = os.getenv("GEOTAB_DC_USERNAME", os.getenv("GEOTAB_USERNAME", ""))
        password = os.getenv("GEOTAB_DC_PASSWORD", os.getenv("GEOTAB_PASSWORD", ""))
        return database, username, password

    def detect_server(self) -> dict:
        """Find the correct OData server (1-7) for this database.

        Geotab distributes databases across 7 Data Connector servers.
        We probe each until we get a successful auth response.
        """
        database, username, password = self._get_credentials()
        if not all([database, username, password]):
            return {"error": "Missing Data Connector credentials"}

        for n in range(1, 8):
            base_url = f"https://dataconnector{n}.geotab.com/odata/v4/{database}"
            try:
                client = httpx.Client(
                    base_url=base_url,
                    auth=(username, password),
                    timeout=15,
                )
                resp = client.get("/")
                if resp.status_code == 200:
                    self._base_url = base_url
                    self._client = client
                    return {
                        "server": f"dataconnector{n}.geotab.com",
                        "database": database,
                        "status": "connected",
                    }
                client.close()
            except httpx.RequestError:
                continue

        return {"error": "Could not find Data Connector server for this database"}

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            result = self.detect_server()
            if "error" in result:
                raise RuntimeError(result["error"])
        return self._client  # type: ignore

    def _odata_get(self, entity: str, params: dict | None = None) -> list[dict]:
        """Execute an OData GET request."""
        resp = self.client.get(f"/{entity}", params=params or {})
        resp.raise_for_status()
        data = resp.json()
        return data.get("value", [])

    def get_vehicle_kpis(
        self,
        from_date: str | None = None,
        to_date: str | None = None,
        device_id: str | None = None,
    ) -> list[dict]:
        """Get vehicle KPIs (distance, fuel, idle time, etc.) from Data Connector.

        Uses the DeviceStatisticsDaily entity set.
        """
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if to_date is None:
            to_date = now.strftime("%Y-%m-%d")

        filters = [
            f"Date ge {from_date}",
            f"Date le {to_date}",
        ]
        if device_id:
            filters.append(f"DeviceId eq '{device_id}'")

        params = {
            "$filter": " and ".join(filters),
            "$top": "1000",
            "$orderby": "Date desc",
        }
        return self._odata_get("DeviceStatisticsDaily", params)

    def get_driver_safety(
        self,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict]:
        """Get driver safety scores and events."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if to_date is None:
            to_date = now.strftime("%Y-%m-%d")

        params = {
            "$filter": f"Date ge {from_date} and Date le {to_date}",
            "$top": "1000",
            "$orderby": "Date desc",
        }
        return self._odata_get("DriverSafetyScoreDaily", params)

    def get_fleet_safety(
        self,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict]:
        """Get fleet-level safety analytics."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if to_date is None:
            to_date = now.strftime("%Y-%m-%d")

        params = {
            "$filter": f"Date ge {from_date} and Date le {to_date}",
            "$top": "1000",
            "$orderby": "Date desc",
        }
        return self._odata_get("FleetSafetyEventDaily", params)

    def get_fault_monitoring(
        self,
        device_id: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict]:
        """Get fault monitoring data with lifecycle tracking."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if to_date is None:
            to_date = now.strftime("%Y-%m-%d")

        filters = [
            f"Date ge {from_date}",
            f"Date le {to_date}",
        ]
        if device_id:
            filters.append(f"DeviceId eq '{device_id}'")

        params = {
            "$filter": " and ".join(filters),
            "$top": "1000",
            "$orderby": "Date desc",
        }
        return self._odata_get("FaultMonitoringDaily", params)

    def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None
