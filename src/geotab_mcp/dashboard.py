"""Flask web dashboard with Google Maps for fleet visualization."""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

from geotab_mcp.gemini_client import GeminiChat
from geotab_mcp.geotab_client import GeotabClient

# Resolve paths for templates and static files
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE_DIR = _PROJECT_ROOT / "templates"
_STATIC_DIR = _PROJECT_ROOT / "static"

app = Flask(
    __name__,
    template_folder=str(_TEMPLATE_DIR),
    static_folder=str(_STATIC_DIR),
)

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
    return enriched


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


# ── Entry Point ──────────────────────────────────────────────────────────

def main():
    """Run the dashboard server."""
    port = int(os.getenv("DASHBOARD_PORT", "5030"))
    debug = os.getenv("DASHBOARD_DEBUG", "false").lower() == "true"
    print(f"Fleet Dashboard starting on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)


if __name__ == "__main__":
    # Allow running from project root: python -m geotab_mcp.dashboard
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
