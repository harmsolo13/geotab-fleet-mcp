"""Flask web dashboard with Google Maps for fleet visualization."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

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


def _get_client() -> GeotabClient:
    global _client
    if _client is None:
        _client = GeotabClient()
        _client.authenticate()
    return _client


# ── Page Routes ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Main dashboard page."""
    maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "")
    return render_template("dashboard.html", maps_api_key=maps_key)


# ── API Routes ───────────────────────────────────────────────────────────

@app.route("/api/vehicles")
def api_vehicles():
    """All vehicles with current GPS positions."""
    try:
        client = _get_client()
        vehicles = client.get_vehicles(limit=500)

        # Enrich with live locations
        for v in vehicles:
            try:
                loc = client.get_vehicle_location(v["id"])
                v["latitude"] = loc.get("latitude")
                v["longitude"] = loc.get("longitude")
                v["speed"] = loc.get("speed")
                v["bearing"] = loc.get("bearing")
                v["lastUpdated"] = loc.get("dateTime")
                v["isCommunicating"] = loc.get("isDeviceCommunicating")
            except Exception:
                v["latitude"] = None
                v["longitude"] = None
        return jsonify({"count": len(vehicles), "vehicles": vehicles})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vehicle/<device_id>/location")
def api_vehicle_location(device_id: str):
    """Single vehicle real-time GPS."""
    try:
        loc = _get_client().get_vehicle_location(device_id)
        return jsonify(loc)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vehicle/<device_id>/trips")
def api_vehicle_trips(device_id: str):
    """Trip history with route points."""
    from_date = request.args.get("from")
    to_date = request.args.get("to")
    try:
        trips = _get_client().get_trips(
            device_id=device_id, from_date=from_date, to_date=to_date, limit=50
        )
        return jsonify({"count": len(trips), "trips": trips})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zones")
def api_zones():
    """All geofence zones."""
    try:
        zones = _get_client().get_zones(limit=500)
        return jsonify({"count": len(zones), "zones": zones})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/faults")
def api_faults():
    """Active fault codes."""
    device_id = request.args.get("device_id")
    try:
        faults = _get_client().get_faults(device_id=device_id, limit=100)
        return jsonify({"count": len(faults), "faults": faults})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/status")
def api_status():
    """Connection status and fleet summary."""
    try:
        client = _get_client()
        conn = client.test_connection()
        vehicles = client.get_vehicles(limit=1000)
        faults = client.get_faults(limit=500)

        # Count vehicles with active communication
        communicating = 0
        for v in vehicles[:50]:  # Check first 50 to avoid API rate limits
            try:
                loc = client.get_vehicle_location(v["id"])
                if loc.get("isDeviceCommunicating"):
                    communicating += 1
            except Exception:
                pass

        return jsonify({
            "connected": conn.get("connected", False),
            "version": conn.get("version"),
            "fleet": {
                "total_vehicles": len(vehicles),
                "communicating": communicating,
                "total_faults": len(faults),
            },
        })
    except Exception as e:
        return jsonify({"connected": False, "error": str(e)}), 500


# ── Entry Point ──────────────────────────────────────────────────────────

def main():
    """Run the dashboard server."""
    port = int(os.getenv("DASHBOARD_PORT", "5001"))
    debug = os.getenv("DASHBOARD_DEBUG", "false").lower() == "true"
    print(f"Fleet Dashboard starting on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)


if __name__ == "__main__":
    # Allow running from project root: python -m geotab_mcp.dashboard
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
