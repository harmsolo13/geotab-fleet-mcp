"""Geotab MyGeotab API client wrapper."""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone

import math

import httpx
import mygeotab
from mygeotab import AuthenticationException, MyGeotabException

from geotab_mcp import api_tracker


class GeotabClient:
    """Wrapper around the mygeotab SDK for fleet data access."""

    def __init__(self) -> None:
        self._api: mygeotab.API | None = None
        self._server: str = ""
        self._database: str = ""
        self._username: str = ""
        self._session_id: str = ""

    @property
    def api(self) -> mygeotab.API:
        if self._api is None:
            raise RuntimeError("Not authenticated. Call authenticate() first.")
        return self._api

    def authenticate(self) -> dict:
        """Authenticate with MyGeotab using .env credentials."""
        self._database = os.getenv("GEOTAB_DATABASE", "")
        self._username = os.getenv("GEOTAB_USERNAME", "")
        password = os.getenv("GEOTAB_PASSWORD", "")
        server = os.getenv("GEOTAB_SERVER", "my.geotab.com")

        if not all([self._database, self._username, password]):
            raise ValueError(
                "Missing credentials. Set GEOTAB_DATABASE, GEOTAB_USERNAME, "
                "and GEOTAB_PASSWORD environment variables."
            )

        self._api = mygeotab.API(
            username=self._username,
            password=password,
            database=self._database,
            server=server,
            timeout=60,
        )
        credentials = self._api.authenticate()
        self._server = credentials.server
        self._session_id = credentials.session_id
        return {
            "database": credentials.database,
            "server": credentials.server,
            "username": self._username,
            "status": "authenticated",
        }

    def test_connection(self) -> dict:
        """Test API connectivity by fetching the server version."""
        try:
            version = self.api.call("GetVersion")
            return {"connected": True, "version": version}
        except Exception as e:
            return {"connected": False, "error": str(e)}

    def get_vehicles(self, limit: int = 500) -> list[dict]:
        """Get all vehicles (Device objects) in the fleet."""
        with api_tracker.track("geotab", "get_vehicles"):
            devices = self.api.get("Device", resultsLimit=limit)
        results = []
        for d in devices:
            results.append({
                "id": d.get("id"),
                "name": d.get("name"),
                "serialNumber": d.get("serialNumber"),
                "vin": d.get("vehicleIdentificationNumber"),
                "licensePlate": d.get("licensePlate"),
                "make": d.get("make", ""),
                "model": d.get("model", ""),
                "year": d.get("year", ""),
                "odometer": d.get("odometer"),
                "engineHours": d.get("engineHours"),
                "deviceType": d.get("deviceType"),
                "groups": [g.get("id") for g in d.get("groups", [])],
            })
        return results

    def get_vehicle_details(self, device_id: str) -> dict:
        """Get detailed info for a single vehicle."""
        devices = self.api.get("Device", search={"id": device_id})
        if not devices:
            return {"error": f"Device {device_id} not found"}
        d = devices[0]
        return {
            "id": d.get("id"),
            "name": d.get("name"),
            "serialNumber": d.get("serialNumber"),
            "vin": d.get("vehicleIdentificationNumber"),
            "licensePlate": d.get("licensePlate"),
            "make": d.get("make", ""),
            "model": d.get("model", ""),
            "year": d.get("year", ""),
            "odometer": d.get("odometer"),
            "engineHours": d.get("engineHours"),
            "deviceType": d.get("deviceType"),
            "comment": d.get("comment", ""),
            "groups": [g.get("id") for g in d.get("groups", [])],
            "activeTo": str(d.get("activeTo", "")),
            "activeFrom": str(d.get("activeFrom", "")),
        }

    def get_all_vehicle_locations(self) -> dict[str, dict]:
        """Batch-fetch GPS positions for ALL vehicles in one API call.

        Returns a dict keyed by device ID for O(1) lookup.
        """
        with api_tracker.track("geotab", "get_all_vehicle_locations"):
            statuses = self.api.get("DeviceStatusInfo")
        result = {}
        for s in statuses:
            device = s.get("device")
            device_id = device.get("id") if isinstance(device, dict) else device
            if device_id:
                result[device_id] = {
                    "deviceId": device_id,
                    "latitude": s.get("latitude"),
                    "longitude": s.get("longitude"),
                    "speed": s.get("speed"),
                    "bearing": s.get("bearing"),
                    "dateTime": str(s.get("dateTime", "")),
                    "isDeviceCommunicating": s.get("isDeviceCommunicating"),
                    "currentStateDuration": str(s.get("currentStateDuration", "")),
                }
        return result

    def get_vehicle_location(self, device_id: str) -> dict:
        """Get real-time GPS position for a vehicle via DeviceStatusInfo."""
        with api_tracker.track("geotab", "get_vehicle_location"):
            statuses = self.api.get(
                "DeviceStatusInfo",
                search={"deviceSearch": {"id": device_id}},
            )
        if not statuses:
            return {"error": f"No status info for device {device_id}"}
        s = statuses[0]
        return {
            "deviceId": device_id,
            "latitude": s.get("latitude"),
            "longitude": s.get("longitude"),
            "speed": s.get("speed"),
            "bearing": s.get("bearing"),
            "dateTime": str(s.get("dateTime", "")),
            "isDeviceCommunicating": s.get("isDeviceCommunicating"),
            "currentStateDuration": str(s.get("currentStateDuration", "")),
            "isDriverChangeEnabled": s.get("isDriverChangeEnabled"),
        }

    def get_trips(
        self,
        device_id: str,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Get trip history for a vehicle."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=7)).isoformat()
        if to_date is None:
            to_date = now.isoformat()

        with api_tracker.track("geotab", "get_trips"):
            trips = self.api.get(
                "Trip",
                search={
                    "deviceSearch": {"id": device_id},
                    "fromDate": from_date,
                    "toDate": to_date,
                },
                resultsLimit=limit,
            )
        results = []
        for t in trips:
            results.append({
                "id": t.get("id"),
                "deviceId": device_id,
                "start": str(t.get("start", "")),
                "stop": str(t.get("stop", "")),
                "distance": t.get("distance"),
                "drivingDuration": str(t.get("drivingDuration", "")),
                "stopDuration": str(t.get("stopDuration", "")),
                "idlingDuration": str(t.get("idlingDuration", "")),
                "maximumSpeed": t.get("maximumSpeed"),
                "averageSpeed": t.get("averageSpeed"),
                "stopPoint": {
                    "x": t.get("stopPoint", {}).get("x"),
                    "y": t.get("stopPoint", {}).get("y"),
                } if t.get("stopPoint") else None,
                "nextTripStart": str(t.get("nextTripStart", "")),
            })
        return results

    def get_fuel_transactions(
        self,
        device_id: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Get fuel transaction data."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=30)).isoformat()
        if to_date is None:
            to_date = now.isoformat()

        search: dict = {"fromDate": from_date, "toDate": to_date}
        if device_id:
            search["deviceSearch"] = {"id": device_id}

        with api_tracker.track("geotab", "get_fuel_transactions"):
            transactions = self.api.get(
                "FuelTransaction", search=search, resultsLimit=limit
            )
        results = []
        for f in transactions:
            results.append({
                "id": f.get("id"),
                "dateTime": str(f.get("dateTime", "")),
                "deviceId": f["device"].get("id") if isinstance(f.get("device"), dict) else f.get("device"),
                "driverName": f["driver"].get("name") if isinstance(f.get("driver"), dict) else f.get("driver"),
                "cost": f.get("cost"),
                "currencyCode": f.get("currencyCode"),
                "volume": f.get("volume"),
                "odometer": f.get("odometer"),
                "location": f.get("location"),
                "productType": f.get("productType"),
            })
        return results

    def get_faults(
        self,
        device_id: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Get fault/DTC data for a vehicle or fleet."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=7)).isoformat()
        if to_date is None:
            to_date = now.isoformat()

        search: dict = {"fromDate": from_date, "toDate": to_date}
        if device_id:
            search["deviceSearch"] = {"id": device_id}

        with api_tracker.track("geotab", "get_faults"):
            faults = self.api.get("FaultData", search=search, resultsLimit=limit)
        results = []
        for f in faults:
            diag = f.get("diagnostic")
            device = f.get("device")
            results.append({
                "id": f.get("id"),
                "dateTime": str(f.get("dateTime", "")),
                "deviceId": device.get("id") if isinstance(device, dict) else device,
                "diagnosticId": diag.get("id") if isinstance(diag, dict) else diag,
                "diagnosticName": diag.get("name") if isinstance(diag, dict) else str(diag) if diag else None,
                "failureMode": _safe_name(f.get("failureMode")),
                "faultState": f.get("faultState"),
                "controller": _safe_name(f.get("controller")),
                "count": f.get("count"),
            })
        return results

    def get_drivers(self, limit: int = 200) -> list[dict]:
        """Get all users flagged as drivers."""
        with api_tracker.track("geotab", "get_drivers"):
            users = self.api.get("User", search={"isDriver": True}, resultsLimit=limit)
        results = []
        for u in users:
            results.append({
                "id": u.get("id"),
                "name": u.get("name"),
                "firstName": u.get("firstName"),
                "lastName": u.get("lastName"),
                "employeeNo": u.get("employeeNo"),
                "driverGroups": [g.get("id") for g in u.get("driverGroups", [])],
                "keys": [k.get("serialNumber") for k in u.get("keys", [])],
                "activeTo": str(u.get("activeTo", "")),
                "activeFrom": str(u.get("activeFrom", "")),
            })
        return results

    def get_zones(self, limit: int = 200) -> list[dict]:
        """Get all geofence zones."""
        with api_tracker.track("geotab", "get_zones"):
            zones = self.api.get("Zone", resultsLimit=limit)
        results = []
        for z in zones:
            points = z.get("points", [])
            centroid = _centroid(points) if points else None
            radius = _estimate_radius(points, centroid) if points and centroid else None
            results.append({
                "id": z.get("id"),
                "name": z.get("name"),
                "comment": z.get("comment", ""),
                "externalReference": z.get("externalReference", ""),
                "zoneTypes": [zt.get("id") if isinstance(zt, dict) else str(zt) for zt in z.get("zoneTypes", [])],
                "groups": [g.get("id") if isinstance(g, dict) else str(g) for g in z.get("groups", [])],
                "pointCount": len(points),
                "centroid": centroid,
                "radius": radius,
            })
        return results

    # Well-known Geotab rule ID → human-readable name mapping
    _RULE_NAMES: dict[str, str] = {
        "RulePostedSpeedingId": "Speeding",
        "atGqTXUrP9EusU9OvWXRIVg": "Max Speed",
        "RuleHarshBrakingId": "Harsh Braking",
        "RuleJackrabbitStartsId": "Hard Acceleration",
        "RuleHarshCorneringId": "Harsh Cornering",
        "RuleEnhancedMajorCollisionId": "Major Collision",
        "RuleEnhancedMinorCollisionId": "Minor Collision",
        "RuleAccidentId": "Possible Collision",
        "RuleSeatbeltId": "Seat Belt",
        "RuleEngineLightOnId": "Engine Light On",
        "RuleApplicationExceptionId": "Application Exception",
        "a6ewYX-gcLUyL01olqgUQBw": "Engine Fault",
    }

    def get_exception_events(
        self,
        from_date: str | None = None,
        to_date: str | None = None,
        device_id: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Get exception/rule violation events."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=7)).isoformat()
        if to_date is None:
            to_date = now.isoformat()

        search: dict = {"fromDate": from_date, "toDate": to_date}
        if device_id:
            search["deviceSearch"] = {"id": device_id}

        with api_tracker.track("geotab", "get_exception_events"):
            events = self.api.get(
                "ExceptionEvent", search=search, resultsLimit=limit
            )
        results = []
        for e in events:
            rule_id = e["rule"].get("id") if isinstance(e.get("rule"), dict) else e.get("rule")
            results.append({
                "id": e.get("id"),
                "deviceId": e["device"].get("id") if isinstance(e.get("device"), dict) else e.get("device"),
                "driverId": e["driver"].get("id") if isinstance(e.get("driver"), dict) else e.get("driver"),
                "ruleId": rule_id,
                "ruleName": self._RULE_NAMES.get(rule_id, rule_id),
                "activeFrom": str(e.get("activeFrom", "")),
                "activeTo": str(e.get("activeTo", "")),
                "duration": str(e.get("duration", "")),
                "distance": e.get("distance"),
                "state": e.get("state"),
            })
        return results

    def get_gps_for_exceptions(self, exceptions: list[dict]) -> list[dict]:
        """Batch-fetch GPS coordinates for exception events using multi_call.

        For each exception, fetches 1 LogRecord within a ±2 min window around
        activeFrom. Uses a single multi_call API roundtrip for all devices.
        Returns the same list with lat/lng populated where GPS data exists.
        """
        if not exceptions:
            return exceptions

        # Group exceptions by deviceId
        by_device: dict[str, list[dict]] = {}
        for evt in exceptions:
            did = evt.get("deviceId")
            if did:
                by_device.setdefault(did, []).append(evt)

        # Build one LogRecord Get call per exception (±2 min window, limit 1)
        calls: list[tuple[str, dict]] = []
        call_index: list[dict] = []  # parallel list mapping call index -> exception
        for device_id, evts in by_device.items():
            for evt in evts:
                active_from = evt.get("activeFrom", "")
                if not active_from:
                    continue
                try:
                    t = datetime.fromisoformat(active_from.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue
                from_dt = (t - timedelta(minutes=2)).isoformat()
                to_dt = (t + timedelta(minutes=2)).isoformat()
                calls.append(("Get", {
                    "typeName": "LogRecord",
                    "search": {
                        "deviceSearch": {"id": device_id},
                        "fromDate": from_dt,
                        "toDate": to_dt,
                    },
                    "resultsLimit": 5,
                }))
                call_index.append(evt)

        if not calls:
            return exceptions

        # Single API roundtrip for all exceptions
        try:
            with api_tracker.track("geotab", "multi_call_gps_exceptions"):
                results = self.api.multi_call(calls)
        except Exception as e:
            print(f"[exceptions] multi_call GPS batch failed: {e}", flush=True)
            return exceptions

        # Match closest LogRecord to each exception by timestamp
        located = 0
        for i, records in enumerate(results):
            evt = call_index[i]
            if not records:
                continue
            evt_time = evt.get("activeFrom", "")
            best_rec = None
            best_diff = float("inf")
            for r in records:
                lat = r.get("latitude")
                lng = r.get("longitude")
                if lat is None or lng is None or (lat == 0 and lng == 0):
                    continue
                try:
                    rt = datetime.fromisoformat(
                        str(r.get("dateTime", "")).replace("Z", "+00:00")
                    )
                    et = datetime.fromisoformat(evt_time.replace("Z", "+00:00"))
                    diff = abs((rt - et).total_seconds())
                except (ValueError, TypeError):
                    diff = 0
                if diff < best_diff:
                    best_diff = diff
                    best_rec = r
            if best_rec:
                evt["lat"] = best_rec.get("latitude")
                evt["lng"] = best_rec.get("longitude")
                located += 1

        print(f"[exceptions] Batch GPS enrichment: {located}/{len(call_index)} located", flush=True)
        return exceptions

    def create_zone(
        self,
        name: str,
        points: list[dict],
        zone_types: list[str] | None = None,
        comment: str = "",
    ) -> str:
        """Create a geofence zone. Points: [{"x": lon, "y": lat}, ...]."""
        zone = {
            "name": name,
            "points": points,
            "comment": comment,
            "externalReference": "",
            "groups": [{"id": "GroupCompanyId"}],
        }
        if zone_types:
            zone["zoneTypes"] = [{"id": zt} for zt in zone_types]

        with api_tracker.track("geotab", "create_zone"):
            zone_id = self.api.add("Zone", zone)
        return zone_id

    def delete_zone(self, zone_id: str) -> None:
        """Delete a geofence zone by ID."""
        with api_tracker.track("geotab", "delete_zone"):
            self.api.remove("Zone", {"id": zone_id})

    def delete_zones_by_name(self, name: str) -> int:
        """Delete all zones matching a name. Returns count deleted."""
        zones = self.get_zones(limit=500)
        deleted = 0
        for z in zones:
            if z["name"] and z["name"].lower() == name.lower():
                self.delete_zone(z["id"])
                deleted += 1
        return deleted

    def send_text_message(self, device_id: str, message: str) -> str:
        """Send a text message to an in-cab device."""
        text_message = {
            "device": {"id": device_id},
            "messageContent": {
                "contentType": "Normal",
                "message": message,
            },
            "isDirectionToVehicle": True,
        }
        with api_tracker.track("geotab", "send_text_message"):
            msg_id = self.api.add("TextMessage", text_message)
        return msg_id


    def get_log_records(
        self,
        device_id: str,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 500,
    ) -> list[dict]:
        """Get GPS log records (breadcrumb trail) for trip replay."""
        now = datetime.now(timezone.utc)
        if from_date is None:
            from_date = (now - timedelta(days=1)).isoformat()
        if to_date is None:
            to_date = now.isoformat()

        with api_tracker.track("geotab", "get_log_records"):
            records = self.api.get(
                "LogRecord",
                search={
                    "deviceSearch": {"id": device_id},
                    "fromDate": from_date,
                    "toDate": to_date,
                },
                resultsLimit=limit,
            )
        results = []
        for r in records:
            lat = r.get("latitude")
            lng = r.get("longitude")
            if lat is not None and lng is not None and (lat != 0 or lng != 0):
                results.append({
                    "lat": lat,
                    "lng": lng,
                    "speed": r.get("speed"),
                    "dateTime": str(r.get("dateTime", "")),
                })
        return results

    # ── Geotab Ace AI ────────────────────────────────────────────────

    def _ace_call(self, function_name: str, function_params: dict | None = None) -> dict:
        """Make a GetAceResults API call."""
        base = f"https://{self._server}"
        payload = {
            "method": "GetAceResults",
            "params": {
                "serviceName": "dna-planet-orchestration",
                "functionName": function_name,
                "customerData": True,
                "functionParameters": function_params or {},
                "credentials": {
                    "database": self._database,
                    "sessionId": self._session_id,
                    "userName": self._username,
                },
            },
        }
        with api_tracker.track("ace", f"ace_{function_name}"):
            resp = httpx.post(f"{base}/apiv1", json=payload, timeout=30)
            data = resp.json()
            if "error" in data:
                raise RuntimeError(data["error"].get("message", str(data["error"])))
            return data.get("result", {})

    def ace_query(self, question: str, timeout: int = 120) -> dict:
        """Ask Geotab Ace a natural language question about fleet data.

        Uses the 3-step async pattern: create-chat -> send-prompt -> poll get-message-group.
        """
        try:
            # Step 1: Create chat session
            chat_result = self._ace_call("create-chat")
            api_result = chat_result.get("apiResult", {})
            results = api_result.get("results", [{}])
            chat_id = results[0].get("chat_id") if results else None

            if not chat_id:
                return {"status": "error", "error": "Failed to create Ace chat session", "raw": chat_result}

            # Step 2: Send prompt
            time.sleep(1)
            prompt_result = self._ace_call("send-prompt", {
                "chat_id": chat_id,
                "prompt": question,
            })
            api_result = prompt_result.get("apiResult", {})
            results = api_result.get("results", [{}])
            msg_group = results[0].get("message_group", {}) if results else {}
            msg_group_id = msg_group.get("id")

            if not msg_group_id:
                return {"status": "error", "error": "Failed to send Ace prompt", "raw": prompt_result}

            # Step 3: Poll for results
            time.sleep(8)  # Ace needs time to process
            deadline = time.time() + timeout
            while time.time() < deadline:
                poll_result = self._ace_call("get-message-group", {
                    "chat_id": chat_id,
                    "message_group_id": msg_group_id,
                })
                api_result = poll_result.get("apiResult", {})
                results = api_result.get("results", [{}])
                msg_group = results[0].get("message_group", {}) if results else {}
                status = msg_group.get("status", {}).get("status", "").upper()

                if status == "DONE":
                    messages = msg_group.get("messages", {})
                    answer_parts = []
                    preview_data = []
                    for msg in messages.values() if isinstance(messages, dict) else messages:
                        if isinstance(msg, dict):
                            if msg.get("reasoning"):
                                answer_parts.append(msg["reasoning"])
                            if msg.get("preview_array"):
                                preview_data.extend(msg["preview_array"])
                    return {
                        "status": "complete",
                        "answer": "\n\n".join(answer_parts) if answer_parts else "Ace returned data but no reasoning text.",
                        "data": preview_data[:20] if preview_data else None,
                        "chat_id": chat_id,
                    }

                if status in ("ERROR", "FAILED"):
                    return {"status": "error", "error": msg_group.get("status", {}).get("message", "Ace query failed")}

                time.sleep(5)

            return {"status": "timeout", "error": f"Ace did not respond within {timeout}s"}

        except Exception as e:
            return {"status": "error", "error": str(e)}


def _safe_name(value) -> str | None:
    """Extract name from a value that may be a dict, string, or None."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("name", str(value.get("id", "")))
    return str(value)


def _centroid(points: list[dict]) -> dict:
    """Calculate centroid of a list of points."""
    if not points:
        return {"x": 0, "y": 0}
    avg_x = sum(p.get("x", 0) for p in points) / len(points)
    avg_y = sum(p.get("y", 0) for p in points) / len(points)
    return {"x": round(avg_x, 6), "y": round(avg_y, 6)}


def _estimate_radius(points: list[dict], centroid: dict) -> float:
    """Estimate zone radius in metres from max point distance to centroid."""
    if not points or not centroid:
        return 300.0
    cx, cy = centroid["x"], centroid["y"]
    max_dist = 0.0
    for p in points:
        dx = (p.get("x", 0) - cx) * math.cos(math.radians(cy)) * 111320
        dy = (p.get("y", 0) - cy) * 111320
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > max_dist:
            max_dist = dist
    return round(max_dist, 1) if max_dist > 0 else 300.0
