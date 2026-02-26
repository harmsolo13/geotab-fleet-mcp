"""Flask web dashboard with Google Maps for fleet visualization."""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

from geotab_mcp.gemini_client import GeminiChat
from geotab_mcp.geotab_client import GeotabClient
from geotab_mcp import enrichment

# Resolve paths for templates and static files
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE_DIR = _PROJECT_ROOT / "templates"
_STATIC_DIR = _PROJECT_ROOT / "static"

app = Flask(
    __name__,
    template_folder=str(_TEMPLATE_DIR),
    static_folder=str(_STATIC_DIR),
)

# Init enrichment DB on import
enrichment.init_db()

# Shared Geotab client (lazy init)
_client: GeotabClient | None = None

# Chat state
_gemini_chat: GeminiChat | None = None
_chat_sessions: dict[str, list[dict]] = {}  # session_id -> history
_MAX_HISTORY = 40

# ── TTL Cache ────────────────────────────────────────────────────────────
# Avoids hammering the Geotab API on every dashboard page load / refresh.

# TTL in seconds per data type
_TTL = {
    "vehicles": 60,
    "locations": 30,
    "trips": 300,
    "zones": 300,
    "faults": 120,
    "status": 60,
}

_cache_store: dict[str, tuple[float, object]] = {}  # key -> (expires_at, data)


def _cache_get(key: str) -> object | None:
    """Return cached value if still valid, else None."""
    entry = _cache_store.get(key)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    return None


def _cache_set(key: str, data: object, ttl_key: str) -> None:
    """Store data with TTL based on data type."""
    _cache_store[key] = (time.monotonic() + _TTL.get(ttl_key, 60), data)


def _cache_force(key: str) -> bool:
    """Check if request has ?refresh=1 to bypass cache."""
    if request.args.get("refresh") == "1":
        _cache_store.pop(key, None)
        return True
    return False


def _get_client() -> GeotabClient:
    global _client
    if _client is None:
        _client = GeotabClient()
        _client.authenticate()
    return _client


def _get_chat() -> GeminiChat:
    global _gemini_chat
    if _gemini_chat is None:
        _gemini_chat = GeminiChat(_get_client())
    return _gemini_chat


def _fetch_vehicles_with_locations() -> list[dict]:
    """Fetch vehicles + batch locations in 2 API calls (not N+1)."""
    client = _get_client()

    # Vehicles (cached separately so status endpoint can reuse)
    vehicles = _cache_get("vehicles")
    if vehicles is None:
        vehicles = client.get_vehicles(limit=500)
        _cache_set("vehicles", vehicles, "vehicles")

    # Batch locations — 1 API call for ALL vehicles
    loc_map = _cache_get("locations")
    if loc_map is None:
        loc_map = client.get_all_vehicle_locations()
        _cache_set("locations", loc_map, "locations")

    # Enrich vehicles with location data
    enriched = []
    for v in vehicles:
        v = dict(v)  # don't mutate cached copy
        loc = loc_map.get(v["id"], {})
        v["latitude"] = loc.get("latitude")
        v["longitude"] = loc.get("longitude")
        v["speed"] = loc.get("speed")
        v["bearing"] = loc.get("bearing")
        v["lastUpdated"] = loc.get("dateTime")
        v["isCommunicating"] = loc.get("isDeviceCommunicating")
        enriched.append(v)
    return enrichment.enrich_vehicles(enriched)


# ── Page Routes ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Main dashboard page."""
    maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "")
    return render_template("dashboard.html", maps_api_key=maps_key)


# ── API Routes ───────────────────────────────────────────────────────────

@app.route("/api/vehicles")
def api_vehicles():
    """All vehicles with current GPS positions (cached, 2 API calls max)."""
    cache_key = "api_vehicles"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        vehicles = _fetch_vehicles_with_locations()
        result = {"count": len(vehicles), "vehicles": vehicles}
        _cache_set(cache_key, result, "vehicles")
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vehicle/<device_id>/location")
def api_vehicle_location(device_id: str):
    """Single vehicle real-time GPS (uses batch cache when available)."""
    try:
        # Try batch cache first — avoids a per-vehicle API call
        loc_map = _cache_get("locations")
        if loc_map and device_id in loc_map:
            return jsonify(loc_map[device_id])
        loc = _get_client().get_vehicle_location(device_id)
        return jsonify(loc)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vehicle/<device_id>/trips")
def api_vehicle_trips(device_id: str):
    """Trip history with route points (cached per vehicle+date range)."""
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    cache_key = f"trips_{device_id}_{from_date}_{to_date}"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        trips = _get_client().get_trips(
            device_id=device_id, from_date=from_date, to_date=to_date, limit=50
        )
        result = {"count": len(trips), "trips": trips}
        _cache_set(cache_key, result, "trips")
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zones")
def api_zones():
    """All geofence zones (cached)."""
    cache_key = "api_zones"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        zones = _get_client().get_zones(limit=500)
        result = {"count": len(zones), "zones": zones}
        _cache_set(cache_key, result, "zones")
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/faults")
def api_faults():
    """Active fault codes (cached, keyed by device filter)."""
    device_id = request.args.get("device_id")
    cache_key = f"api_faults_{device_id or 'all'}"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        faults = _get_client().get_faults(device_id=device_id, limit=100)
        result = {"count": len(faults), "faults": faults}
        _cache_set(cache_key, result, "faults")
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/status")
def api_status():
    """Connection status and fleet summary (cached, reuses vehicle/location cache)."""
    cache_key = "api_status"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        client = _get_client()
        conn = client.test_connection()

        # Reuse cached vehicles if available (avoids duplicate fetch)
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=1000)
            _cache_set("vehicles", vehicles, "vehicles")

        # Reuse cached faults
        faults_result = _cache_get("api_faults_all")
        if faults_result is None:
            faults = client.get_faults(limit=500)
            faults_result = {"count": len(faults), "faults": faults}
            _cache_set("api_faults_all", faults_result, "faults")

        # Count communicating from batch locations (1 API call, not 50)
        loc_map = _cache_get("locations")
        if loc_map is None:
            loc_map = client.get_all_vehicle_locations()
            _cache_set("locations", loc_map, "locations")

        communicating = sum(
            1 for v in vehicles
            if loc_map.get(v["id"], {}).get("isDeviceCommunicating")
        )

        result = {
            "connected": conn.get("connected", False),
            "version": conn.get("version"),
            "fleet": {
                "total_vehicles": len(vehicles),
                "communicating": communicating,
                "total_faults": faults_result["count"],
            },
        }
        _cache_set(cache_key, result, "status")
        return jsonify(result)
    except Exception as e:
        return jsonify({"connected": False, "error": str(e)}), 500


# ── Helpers ──────────────────────────────────────────────────────────

def _parse_duration(value) -> float:
    """Parse a timedelta string like '1:23:45' or '0:05:30' into total seconds.

    Also handles plain numeric (already seconds) and timedelta-repr strings.
    """
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s or s == "None":
        return 0.0
    # Try H:MM:SS or HH:MM:SS
    m = re.match(r"^(\d+):(\d{2}):(\d{2})(?:\..*)?$", s)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    # Try seconds only
    try:
        return float(s)
    except ValueError:
        return 0.0


def _circle_points(lat: float, lng: float, radius_m: float = 200, n: int = 8) -> list[dict]:
    """Generate n points forming a circle polygon around (lat, lng)."""
    points = []
    for i in range(n):
        angle = 2 * math.pi * i / n
        dlat = (radius_m / 111320) * math.cos(angle)
        dlng = (radius_m / (111320 * math.cos(math.radians(lat)))) * math.sin(angle)
        points.append({"x": lng + dlng, "y": lat + dlat})
    return points


# ── Fleet KPI API ────────────────────────────────────────────────────

@app.route("/api/fleet-kpis")
def api_fleet_kpis():
    """Aggregated fleet KPIs from trip data (heavily cached, rate-limit safe)."""
    cache_key = "api_fleet_kpis"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        client = _get_client()
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=500)
            _cache_set("vehicles", vehicles, "vehicles")

        total_distance = 0.0
        total_trips = 0
        total_driving_s = 0.0
        total_idle_s = 0.0
        max_speed = 0.0
        vehicles_with_trips = 0

        # Sample trips from only 5 vehicles to stay within rate limits
        # (50 vehicles × get_trips = 50 API calls = instant rate limit hit)
        import random
        sample = random.sample(vehicles, min(5, len(vehicles)))
        for v in sample:
            # Reuse per-vehicle trip cache if available
            trip_cache_key = f"trips_{v['id']}_None_None"
            trips = _cache_get(trip_cache_key)
            if trips is None:
                try:
                    trips_raw = client.get_trips(device_id=v["id"], limit=20)
                    trips = {"trips": trips_raw}
                    _cache_set(trip_cache_key, trips, "trips")
                except Exception:
                    continue
            trip_list = trips.get("trips", trips) if isinstance(trips, dict) else trips
            if trip_list:
                vehicles_with_trips += 1
                total_trips += len(trip_list)
                for t in trip_list:
                    total_distance += t.get("distance") or 0
                    total_driving_s += _parse_duration(t.get("drivingDuration"))
                    total_idle_s += _parse_duration(t.get("idlingDuration"))
                    ms = t.get("maximumSpeed") or 0
                    if ms > max_speed:
                        max_speed = ms

        # Scale up estimates to full fleet
        scale = len(vehicles) / max(vehicles_with_trips, 1)
        total_active_s = total_driving_s + total_idle_s
        idle_pct = (total_idle_s / total_active_s * 100) if total_active_s > 0 else 0

        # Reuse cached faults for exception count
        faults_result = _cache_get("api_faults_all")
        exception_count = faults_result["count"] if faults_result else 0

        result = {
            "total_distance_km": round(total_distance * scale / 1000, 1),
            "total_trips": round(total_trips * scale),
            "idle_percent": round(idle_pct, 1),
            "total_driving_hours": round(total_driving_s * scale / 3600, 1),
            "max_speed_kmh": round(max_speed, 1),
            "vehicles_with_trips": len(vehicles),
            "total_exceptions": exception_count,
            "avg_trips_per_vehicle": round(total_trips / max(vehicles_with_trips, 1), 1),
        }
        # Long TTL — KPIs don't need to refresh often
        _cache_store[cache_key] = (time.monotonic() + 300, result)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Heatmap API ──────────────────────────────────────────────────────

@app.route("/api/heatmap-data")
def api_heatmap_data():
    """Trip stop points with duration weights for heatmap visualization (rate-limit safe)."""
    cache_key = "api_heatmap"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        client = _get_client()
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=500)
            _cache_set("vehicles", vehicles, "vehicles")

        points = []
        # Sample 5 vehicles to stay within rate limits
        import random
        sample = random.sample(vehicles, min(5, len(vehicles)))
        for v in sample:
            trip_cache_key = f"trips_{v['id']}_None_None"
            trips_data = _cache_get(trip_cache_key)
            if trips_data is None:
                try:
                    trips_raw = client.get_trips(device_id=v["id"], limit=20)
                    trips_data = {"trips": trips_raw}
                    _cache_set(trip_cache_key, trips_data, "trips")
                except Exception:
                    continue
            trip_list = trips_data.get("trips", trips_data) if isinstance(trips_data, dict) else trips_data
            for t in trip_list:
                sp = t.get("stopPoint")
                if sp and sp.get("x") is not None and sp.get("y") is not None:
                    stop_s = _parse_duration(t.get("stopDuration"))
                    weight = max(1, min(10, stop_s / 600))
                    points.append({
                        "lat": sp["y"],
                        "lng": sp["x"],
                        "weight": round(weight, 1),
                    })

        result = {"count": len(points), "points": points}
        # Long TTL
        _cache_store[cache_key] = (time.monotonic() + 300, result)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Fleet Narrative Report API ───────────────────────────────────────

@app.route("/api/report", methods=["POST"])
def api_report():
    """Generate executive fleet report using Gemini + Ace AI."""
    try:
        client = _get_client()
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=500)
            _cache_set("vehicles", vehicles, "vehicles")

        # Gather trip summaries per vehicle (sample 5 to respect rate limits)
        vehicle_summaries = []
        import random
        sample = random.sample(vehicles, min(5, len(vehicles)))
        for v in sample:
            trip_cache_key = f"trips_{v['id']}_None_None"
            trips_data = _cache_get(trip_cache_key)
            if trips_data is None:
                try:
                    trips_raw = client.get_trips(device_id=v["id"], limit=20)
                    trips_data = {"trips": trips_raw}
                    _cache_set(trip_cache_key, trips_data, "trips")
                except Exception:
                    continue
            trips = trips_data.get("trips", trips_data) if isinstance(trips_data, dict) else trips_data
            if not trips:
                continue
            total_dist = sum(t.get("distance") or 0 for t in trips)
            total_drive = sum(_parse_duration(t.get("drivingDuration")) for t in trips)
            total_idle = sum(_parse_duration(t.get("idlingDuration")) for t in trips)
            max_spd = max((t.get("maximumSpeed") or 0) for t in trips)
            vehicle_summaries.append({
                "name": v.get("name", v["id"]),
                "trips": len(trips),
                "distance_km": round(total_dist / 1000, 1),
                "driving_hours": round(total_drive / 3600, 1),
                "idle_hours": round(total_idle / 3600, 1),
                "max_speed_kmh": round(max_spd, 1),
            })

        # Get faults
        faults_data = _cache_get("api_faults_all")
        if faults_data is None:
            try:
                fault_list = client.get_faults(limit=200)
                faults_data = {"count": len(fault_list), "faults": fault_list[:20]}
                _cache_set("api_faults_all", faults_data, "faults")
            except Exception:
                faults_data = {"count": 0, "faults": []}

        # Query Ace AI for fleet insights
        ace_insight = ""
        try:
            ace_result = client.ace_query(
                "Summarize the fleet's overall performance, top concerns, and key recommendations.",
                timeout=60,
            )
            if ace_result.get("status") == "complete":
                ace_insight = ace_result.get("answer", "")
        except Exception:
            ace_insight = "Ace AI was unavailable for this report."

        # Build data payload for Gemini
        report_data = {
            "fleet_size": len(vehicles),
            "vehicles_with_activity": len(vehicle_summaries),
            "vehicle_summaries": vehicle_summaries[:20],
            "total_faults": faults_data["count"],
            "sample_faults": faults_data.get("faults", [])[:10],
            "ace_insights": ace_insight,
        }

        # Ask Gemini to generate the report
        from geotab_mcp.gemini_client import GeminiClient
        gemini = GeminiClient()
        prompt = (
            "Generate a professional HTML executive fleet report. "
            "Use the following structure with styled HTML (inline CSS, modern look, no external deps):\n"
            "1. Executive Summary (2-3 sentences)\n"
            "2. Fleet Overview (vehicle count, total distance, trips, driving hours)\n"
            "3. Top Performers (highest distance, most trips)\n"
            "4. Anomalies & Concerns (high idle, faults, excessive speed)\n"
            "5. Ace AI Insights (include the Ace analysis below)\n"
            "6. Recommendations (3-5 actionable items)\n\n"
            "Use a clean, modern style. Return ONLY the HTML body content (no <html>/<head> tags). "
            "Use colors: blue #4a9eff for headers, green #34d399 for positive, red #f87171 for alerts."
        )
        analysis = gemini.analyze_fleet(report_data, question=prompt)

        return jsonify({
            "status": "ok",
            "html": analysis.get("analysis", "Report generation failed."),
            "data": report_data,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Trip Replay API ──────────────────────────────────────────────────

@app.route("/api/vehicle/<device_id>/trip-replay")
def api_trip_replay(device_id: str):
    """Get GPS log records for animated trip replay."""
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    cache_key = f"replay_{device_id}_{from_date}_{to_date}"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        records = _get_client().get_log_records(
            device_id=device_id, from_date=from_date, to_date=to_date, limit=500
        )
        result = {"count": len(records), "points": records}
        _cache_set(cache_key, result, "trips")
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Ace AI API ───────────────────────────────────────────────────────

@app.route("/api/ace", methods=["POST"])
def api_ace():
    """Ask Geotab Ace AI a natural language question about fleet data.

    Body: {"question": "Which vehicles have the worst fuel efficiency?"}
    """
    try:
        body = request.get_json(force=True)
        question = (body.get("question") or "").strip()
        if not question:
            return jsonify({"error": "Missing question"}), 400

        result = _get_client().ace_query(question, timeout=90)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Chat API ─────────────────────────────────────────────────────────────

@app.route("/api/chat", methods=["POST"])
def api_chat():
    """Conversational chat with Gemini + Geotab function calling."""
    try:
        body = request.get_json(force=True)
        message = (body.get("message") or "").strip()
        session_id = body.get("session_id") or str(uuid.uuid4())

        if not message:
            return jsonify({"error": "Empty message"}), 400

        history = _chat_sessions.get(session_id, [])
        chat = _get_chat()
        response_text = chat.chat(message, history)

        # Update history
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": response_text})
        # Cap history length
        if len(history) > _MAX_HISTORY:
            history = history[-_MAX_HISTORY:]
        _chat_sessions[session_id] = history

        return jsonify({
            "response": response_text,
            "session_id": session_id,
            "status": "ok",
        })
    except Exception as e:
        err = str(e)
        if "429" in err or "RESOURCE_EXHAUSTED" in err:
            return jsonify({
                "error": "Gemini AI is temporarily rate limited (free tier: 20 requests/day). Please try again in a few minutes.",
                "status": "rate_limited",
            }), 429
        return jsonify({"error": err, "status": "error"}), 500


@app.route("/api/chat/clear", methods=["POST"])
def api_chat_clear():
    """Clear chat session history."""
    body = request.get_json(force=True) if request.is_json else {}
    session_id = body.get("session_id", "")
    if session_id in _chat_sessions:
        del _chat_sessions[session_id]
    return jsonify({"status": "cleared", "session_id": session_id})


# ── Enrichment Toggle API ────────────────────────────────────────────────

@app.route("/api/enrichment/status")
def api_enrichment_status():
    """Check if vehicle enrichment is enabled."""
    return jsonify({"enabled": enrichment.is_enabled()})


@app.route("/api/enrichment/toggle", methods=["POST"])
def api_enrichment_toggle():
    """Toggle vehicle enrichment on/off. Busts the vehicle cache."""
    new_state = enrichment.toggle()
    # Bust vehicle caches so next load reflects the change
    _cache_store.pop("api_vehicles", None)
    _cache_store.pop("vehicles", None)
    return jsonify({"enabled": new_state})


# ── Entry Point ──────────────────────────────────────────────────────────

def main():
    """Run the dashboard server."""
    port = int(os.getenv("DASHBOARD_PORT", "5030"))
    debug = os.getenv("DASHBOARD_DEBUG", "false").lower() == "true"
    print(f"Fleet Dashboard starting on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)


if __name__ == "__main__":
    # Allow running from project root: python -m geotab_mcp.dashboard
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
