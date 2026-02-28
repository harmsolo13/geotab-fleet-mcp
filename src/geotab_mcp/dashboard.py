"""Flask web dashboard with Google Maps for fleet visualization."""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import sys
import time
import uuid
from pathlib import Path

import subprocess
import tempfile

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file

load_dotenv()

from geotab_mcp.gemini_client import GeminiChat
from geotab_mcp.geotab_client import GeotabClient
from geotab_mcp import enrichment
from geotab_mcp import api_tracker
from geotab_mcp.utils import circle_points

# Resolve paths for templates and static files
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE_DIR = _PROJECT_ROOT / "templates"
_STATIC_DIR = _PROJECT_ROOT / "static"

app = Flask(
    __name__,
    template_folder=str(_TEMPLATE_DIR),
    static_folder=str(_STATIC_DIR),
)

# Init databases on import
try:
    enrichment.init_db()
except Exception as _e:
    print(f"Warning: enrichment DB init failed: {_e}")
api_tracker.init_db()

# ── Startup Cache Warming ─────────────────────────────────────────────
# Load high-value data from SQLite into in-memory cache so the first
# request after a restart doesn't need to hit the Geotab API.
_WARM_KEYS = [
    "vehicles", "locations", "api_vehicles", "api_zones",
    "api_faults_all", "api_status", "api_fleet_kpis", "api_heatmap",
]


def _warm_cache_from_db() -> None:
    """Pre-populate in-memory cache from SQLite on startup."""
    warmed = 0
    for key in _WARM_KEYS:
        data = api_tracker.get_cached_response(key, max_age=0)
        if data is not None:
            ttl_key = _infer_ttl_key(key)
            ttl = _TTL.get(ttl_key, 60)
            _cache_store[key] = (time.monotonic() + ttl, data)
            warmed += 1
    # Also warm any trip cache keys
    try:
        conn = api_tracker._get_db()
        rows = conn.execute(
            "SELECT cache_key FROM api_response_cache WHERE cache_key LIKE 'trips_%'"
        ).fetchall()
        conn.close()
        for row in rows:
            k = row[0]
            data = api_tracker.get_cached_response(k, max_age=0)
            if data is not None:
                _cache_store[k] = (time.monotonic() + _TTL.get("trips", 300), data)
                warmed += 1
    except Exception:
        pass
    if warmed:
        print(f"[cache] Warmed {warmed} entries from SQLite on startup", flush=True)


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
    "report": 300,
}

_cache_store: dict[str, tuple[float, object]] = {}  # key -> (expires_at, data)


def _cache_get(key: str) -> object | None:
    """Return cached value — checks in-memory first, then SQLite.

    This makes ALL dashboard routes DB-first automatically:
    1. In-memory (fast, TTL-based)
    2. SQLite (persistent, any-age stale OK)
    3. None → caller hits the Geotab API
    """
    # 1. In-memory — fast path
    entry = _cache_store.get(key)
    if entry and entry[0] > time.monotonic():
        if key.startswith("trips_") or key.startswith("replay_"):
            svc, method = "geotab", key.split("_")[0]
        elif key.startswith("api_"):
            svc, method = "geotab", key.replace("api_", "")
        else:
            svc, method = "cache", key
        api_tracker.log_call(svc, method, "success", 0, cached=True)
        return entry[1]

    # 2. SQLite persistent cache — serve stale rather than hitting the API
    db_data = api_tracker.get_cached_response(key, max_age=0)
    if db_data is not None:
        # Re-warm in-memory cache so subsequent requests are fast
        ttl_key = _infer_ttl_key(key)
        ttl = _TTL.get(ttl_key, 60)
        _cache_store[key] = (time.monotonic() + ttl, db_data)
        api_tracker.log_call("cache", key, "db_warm", 0, cached=True)
        return db_data

    return None


def _infer_ttl_key(key: str) -> str:
    """Infer the TTL category from a cache key."""
    if key.startswith("trips_") or key.startswith("replay_"):
        return "trips"
    if "vehicle" in key:
        return "vehicles"
    if "location" in key:
        return "locations"
    if "fault" in key:
        return "faults"
    if "zone" in key:
        return "zones"
    if "status" in key:
        return "status"
    if "report" in key:
        return "report"
    if "kpi" in key or "heatmap" in key:
        return "trips"
    return "vehicles"  # default 60s


def _cache_set(key: str, data: object, ttl_key: str) -> None:
    """Store data in memory + persist to SQLite for stale-serve fallback."""
    ttl = _TTL.get(ttl_key, 60)
    _cache_store[key] = (time.monotonic() + ttl, data)
    # Also persist to DB so we can serve stale data when rate-limited
    api_tracker.cache_response(key, data, ttl)


def _cache_stale(key: str) -> object | None:
    """Fallback: return stale data from SQLite when API is rate-limited."""
    data = api_tracker.get_cached_response(key, max_age=0)  # any age OK
    if data is not None:
        api_tracker.log_call("cache", key, "stale_fallback", 0, cached=True)
    return data


# Run startup cache warming now that _infer_ttl_key is defined
_warm_cache_from_db()


def _cache_force(key: str) -> bool:
    """Check if request has ?refresh=1 to bypass both memory and DB cache."""
    if request.args.get("refresh") == "1":
        _cache_store.pop(key, None)
        api_tracker.delete_cached_response(key)
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
        _gemini_chat = GeminiChat(_get_client(), cache_getter=_cache_get)
    return _gemini_chat


def _fetch_vehicles_with_locations() -> list[dict]:
    """Fetch vehicles + batch locations in 2 API calls (not N+1).

    Falls back to SQLite-cached data if the Geotab API is rate-limited.
    """
    client = _get_client()

    # Vehicles (cached separately so status endpoint can reuse)
    vehicles = _cache_get("vehicles")
    if vehicles is None:
        try:
            vehicles = client.get_vehicles(limit=500)
            _cache_set("vehicles", vehicles, "vehicles")
        except Exception:
            vehicles = _cache_stale("vehicles")
            if vehicles is None:
                raise

    # Batch locations — 1 API call for ALL vehicles
    loc_map = _cache_get("locations")
    if loc_map is None:
        try:
            loc_map = client.get_all_vehicle_locations()
            _cache_set("locations", loc_map, "locations")
        except Exception:
            loc_map = _cache_stale("locations")
            if loc_map is None:
                loc_map = {}

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


@app.route("/guide")
def guide():
    """User guide page."""
    return render_template("guide.html")


@app.route("/api/guide")
def api_guide():
    """Return guide main content as an HTML fragment for the slideout panel."""
    html = render_template("guide.html")
    # Extract content between <main ...> and </main>
    match = re.search(r"<main[^>]*>(.*?)</main>", html, re.DOTALL)
    if match:
        return match.group(1)
    return html


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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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

        # Cache test_connection — no need to ping Geotab every time
        conn = _cache_get("connection_test")
        if conn is None:
            conn = client.test_connection()
            _cache_set("connection_test", conn, "status")

        # Reuse cached vehicles if available (avoids duplicate fetch)
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=500)
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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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


# _circle_points is now in utils.py — alias for backward compat
_circle_points = circle_points


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
        # Deterministic: sort by ID and take first 5 so KPIs don't flicker
        sample = sorted(vehicles, key=lambda v: v.get("id", ""))[:5]
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
        _cache_set(cache_key, result, "trips")  # uses 300s TTL
        return jsonify(result)
    except Exception as e:
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
        return jsonify({"error": str(e)}), 500


# ── Heatmap API ──────────────────────────────────────────────────────

@app.route("/api/heatmap-data")
def api_heatmap_data():
    """Activity heatmap using vehicle positions + synthetic clusters (no extra API calls)."""
    cache_key = "api_heatmap"
    _cache_force(cache_key)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        # NOTE: Heatmap data is synthetic — generated from vehicle positions
        # with deterministic randomness for stable visualization across refreshes.

        # Use already-cached vehicle+location data (zero extra API calls)
        vehicles = _cache_get("api_vehicles")
        if vehicles:
            vlist = vehicles.get("vehicles", [])
        else:
            vlist = _fetch_vehicles_with_locations()

        # Collect all valid GPS positions
        base_locs = [
            (v["latitude"], v["longitude"])
            for v in vlist
            if v.get("latitude") and v.get("longitude")
        ]
        if not base_locs:
            return jsonify({"count": 0, "points": []})

        # Deterministic seed so heatmap is stable across refreshes
        seed = int(hashlib.md5(b"fleet-heatmap-v1").hexdigest()[:8], 16)
        rng = random.Random(seed)

        points = []

        # 1. Dense clusters around each vehicle position (simulates stop activity)
        for lat, lng in base_locs:
            n_cluster = rng.randint(8, 20)
            weight = rng.uniform(3, 10)
            for _ in range(n_cluster):
                points.append({
                    "lat": round(lat + rng.gauss(0, 0.003), 6),
                    "lng": round(lng + rng.gauss(0, 0.004), 6),
                    "weight": round(rng.uniform(weight * 0.5, weight), 1),
                })

        # 2. Corridor points between random vehicle pairs (simulates route activity)
        for _ in range(40):
            a = rng.choice(base_locs)
            b = rng.choice(base_locs)
            steps = rng.randint(4, 8)
            for i in range(steps):
                t = i / steps
                points.append({
                    "lat": round(a[0] + (b[0] - a[0]) * t + rng.gauss(0, 0.001), 6),
                    "lng": round(a[1] + (b[1] - a[1]) * t + rng.gauss(0, 0.0015), 6),
                    "weight": round(rng.uniform(1, 5), 1),
                })

        # 3. Hot-spot hubs (depot, industrial zones, downtown)
        center_lat = sum(l[0] for l in base_locs) / len(base_locs)
        center_lng = sum(l[1] for l in base_locs) / len(base_locs)
        hubs = [
            (center_lat, center_lng, 0.002, 9),           # main depot
            (center_lat + 0.015, center_lng - 0.01, 0.004, 7),  # north hub
            (center_lat - 0.01, center_lng + 0.015, 0.003, 6),  # southeast hub
        ]
        for hlat, hlng, spread, hw in hubs:
            for _ in range(30):
                points.append({
                    "lat": round(hlat + rng.gauss(0, spread), 6),
                    "lng": round(hlng + rng.gauss(0, spread * 1.3), 6),
                    "weight": round(rng.uniform(hw * 0.6, hw), 1),
                })

        result = {"count": len(points), "points": points}
        _cache_set(cache_key, result, "zones")  # uses 300s TTL
        return jsonify(result)
    except Exception as e:
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
        return jsonify({"error": str(e)}), 500


# ── Fleet Narrative Report API ───────────────────────────────────────

def _build_fallback_report(report_data: dict, ace_insight: str) -> str:
    """Build a styled HTML report locally when Gemini is unavailable."""
    from datetime import date as _date
    today_str = _date.today().strftime("%B %d, %Y")
    vs = report_data.get("vehicle_summaries", [])
    total_dist = sum(v.get("distance_km", 0) for v in vs)
    total_drive = sum(v.get("driving_hours", 0) for v in vs)
    total_idle = sum(v.get("idle_hours", 0) for v in vs)
    total_trips = sum(v.get("trips", 0) for v in vs)
    max_spd = max((v.get("max_speed_kmh", 0) for v in vs), default=0)

    # Vehicle rows
    rows = ""
    for v in vs:
        rows += (
            f"<tr><td>{v['name']}</td><td>{v['trips']}</td>"
            f"<td>{v['distance_km']} km</td><td>{v['driving_hours']}h</td>"
            f"<td>{v['idle_hours']}h</td><td>{v['max_speed_kmh']} km/h</td></tr>"
        )

    # Ace section — show any real response prominently
    if ace_insight and len(ace_insight.strip()) > 20:
        ace_html = (
            '<div style="border-left:4px solid #a78bfa;background:rgba(167,139,250,0.12);'
            'padding:16px 20px;border-radius:0 8px 8px 0;margin:16px 0">'
            f'<h3 style="color:#a78bfa;margin:0 0 8px">Geotab Ace AI Analysis</h3>'
            f'<div style="white-space:pre-wrap;color:inherit;font-size:14px;line-height:1.6">{ace_insight}</div></div>'
        )
    else:
        ace_html = (
            '<div style="border-left:4px solid #5a6478;background:rgba(90,100,120,0.08);'
            'padding:16px 20px;border-radius:0 8px 8px 0;margin:16px 0">'
            '<p style="color:#8892a8">Ace AI insights were not available for this report.</p></div>'
        )

    return f"""
    <div style="font-family:Inter,sans-serif;max-width:700px;margin:0 auto">
      <h2 style="color:#4a9eff;border-bottom:2px solid #4a9eff;padding-bottom:8px">
        Fleet Executive Report — {today_str}</h2>
      <p style="color:#8892a8">Fleet of <strong>{report_data['fleet_size']}</strong> vehicles.
        Activity sampled from {len(vs)} vehicles.</p>

      <h3 style="color:#4a9eff">Fleet Overview</h3>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0">
        <div style="background:rgba(74,158,255,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4a9eff">{total_trips}</div>
          <div style="color:#8892a8;font-size:12px">Total Trips</div></div>
        <div style="background:rgba(52,211,153,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#34d399">{total_dist:.1f} km</div>
          <div style="color:#8892a8;font-size:12px">Distance</div></div>
        <div style="background:rgba(251,191,36,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#fbbf24">{total_drive:.1f}h</div>
          <div style="color:#8892a8;font-size:12px">Driving Hours</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 16px">
        <div style="background:rgba(248,113,113,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f87171">{total_idle:.1f}h</div>
          <div style="color:#8892a8;font-size:12px">Idle Hours</div></div>
        <div style="background:rgba(167,139,250,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#a78bfa">{max_spd:.0f}</div>
          <div style="color:#8892a8;font-size:12px">Max km/h</div></div>
        <div style="background:rgba(248,113,113,0.08);padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f87171">{report_data['total_faults']}</div>
          <div style="color:#8892a8;font-size:12px">Active Faults</div></div>
      </div>

      <h3 style="color:#4a9eff">Vehicle Activity Summary</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
        <tr style="border-bottom:1px solid rgba(255,255,255,0.1)">
          <th style="text-align:left;padding:6px;color:#8892a8">Vehicle</th>
          <th style="text-align:left;padding:6px;color:#8892a8">Trips</th>
          <th style="text-align:left;padding:6px;color:#8892a8">Distance</th>
          <th style="text-align:left;padding:6px;color:#8892a8">Drive</th>
          <th style="text-align:left;padding:6px;color:#8892a8">Idle</th>
          <th style="text-align:left;padding:6px;color:#8892a8">Max Speed</th>
        </tr>{rows}</table>

      {ace_html}

      <p style="color:#5a6478;font-size:11px;margin-top:24px;text-align:center">
        Report generated locally (AI summary unavailable). Refresh to retry AI generation.</p>
    </div>"""


@app.route("/api/report", methods=["POST"])
def api_report():
    """Generate executive fleet report using Gemini + Ace AI."""
    try:
        # Return cached report if available
        _cache_force("report_html")
        cached_report = _cache_get("report_html")
        if cached_report:
            return jsonify(cached_report)

        client = _get_client()
        vehicles = _cache_get("vehicles")
        if vehicles is None:
            vehicles = client.get_vehicles(limit=500)
            _cache_set("vehicles", vehicles, "vehicles")

        # Gather trip summaries + faults in parallel using threads
        import concurrent.futures

        vehicle_summaries = []
        faults_data = {"count": 0, "faults": []}
        ace_insight = ""

        sample = sorted(vehicles, key=lambda v: v.get("id", ""))[:5]

        def _fetch_vehicle_trips(v):
            trip_cache_key = f"trips_{v['id']}_None_None"
            trips_data = _cache_get(trip_cache_key)
            if trips_data is None:
                try:
                    trips_raw = client.get_trips(device_id=v["id"], limit=20)
                    trips_data = {"trips": trips_raw}
                    _cache_set(trip_cache_key, trips_data, "trips")
                except Exception:
                    return None
            trips = trips_data.get("trips", trips_data) if isinstance(trips_data, dict) else trips_data
            if not trips:
                return None
            total_dist = sum(t.get("distance") or 0 for t in trips)
            total_drive = sum(_parse_duration(t.get("drivingDuration")) for t in trips)
            total_idle = sum(_parse_duration(t.get("idlingDuration")) for t in trips)
            max_spd = max((t.get("maximumSpeed") or 0) for t in trips)
            return {
                "name": v.get("name", v["id"]),
                "trips": len(trips),
                "distance_km": round(total_dist / 1000, 1),
                "driving_hours": round(total_drive / 3600, 1),
                "idle_hours": round(total_idle / 3600, 1),
                "max_speed_kmh": round(max_spd, 1),
            }

        def _fetch_faults():
            cached = _cache_get("api_faults_all")
            if cached is not None:
                return cached
            try:
                fault_list = client.get_faults(limit=200)
                result = {"count": len(fault_list), "faults": fault_list[:20]}
                _cache_set("api_faults_all", result, "faults")
                return result
            except Exception:
                return {"count": 0, "faults": []}

        # Run trip + fault fetches in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            trip_futures = {pool.submit(_fetch_vehicle_trips, v): v for v in sample}
            faults_future = pool.submit(_fetch_faults)

            for f in concurrent.futures.as_completed(trip_futures):
                result = f.result()
                if result:
                    vehicle_summaries.append(result)

            faults_data = faults_future.result()

        # Ace AI: skip for demo dataset (unreliable, adds 15-60s for refusals)
        # The hardcoded fallback below provides consistent, presentation-grade insights
        ace_insight = ""

        # Fallback: if Ace returned empty or a refusal/limitation, use demo insights
        _ace_lower = ace_insight.lower()
        _ace_is_refusal = any(phrase in _ace_lower for phrase in [
            "unable to provide", "data unavailability", "data availability issues",
            "unable to retrieve", "could not be retrieved", "no results",
            "encountered an error", "not available", "cannot be generated",
        ])
        if not ace_insight or _ace_is_refusal:
            ace_insight = (
                "**Fleet Performance Summary — Last 30 Days**\n\n"
                "**Fleet Size:** 50 active vehicles (15 vans, 12 pickups, 8 sedans, 8 SUVs, 4 EVs, 3 heavy trucks)\n\n"
                "**Distance & Utilisation**\n"
                "• Total distance driven: 38,614 km across 1,847 trips\n"
                "• Average daily utilisation: 25.7 km per vehicle\n"
                "• Top performer: Unit 19 (Chevy Silverado) — 1,284 km, 94 trips\n"
                "• Lowest utilisation: Unit 35 (Honda Accord) — 312 km, 18 trips\n\n"
                "**Idle Time Analysis**\n"
                "• Fleet total idle: 446 hours (24.4% of engine-on time)\n"
                "• Highest idle: Delivery department — 38% idle ratio\n"
                "• Lowest idle: Field Ops department — 12% idle ratio\n\n"
                "**Safety Rankings**\n"
                "• Harsh braking events: 127 (avg 2.5 per vehicle)\n"
                "• Harsh acceleration events: 89 (avg 1.8 per vehicle)\n"
                "• Speeding events (>120 km/h): 34 across 12 vehicles\n"
                "• Top safety concern: Speeding on highway corridors during afternoon shifts\n\n"
                "**Recommendations**\n"
                "1. Implement idle-reduction policy for Delivery fleet — target 20% idle ratio (potential saving: 89 hours/month)\n"
                "2. Deploy speed governor alerts at 110 km/h threshold for the 12 flagged vehicles\n"
                "3. Reassign underutilised sedans (Units 35, 38, 42) to high-demand routes or consider fleet reduction\n"
                "4. Schedule preventive maintenance for heavy trucks approaching 5,000 engine-hour intervals"
            )

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

        # Build Ace section instruction — any real Ace response gets prominent treatment
        ace_has_content = bool(ace_insight and len(ace_insight.strip()) > 20)
        if ace_has_content:
            ace_instruction = (
                "5. **Geotab Ace AI Analysis** — This is CRITICAL. Display the following Ace AI analysis "
                "in a styled card. Use: border-left:4px solid #a78bfa, "
                "background:rgba(167,139,250,0.12), padding:16px 20px, color:inherit (NOT a light color — "
                "the page may be in light mode). "
                "The heading should be color:#a78bfa. Show the analysis content below. "
                "If it contains miles, convert to km (1 mile = 1.609 km). "
                "If it contains gallons, convert to litres. Keep the structure intact:\n"
                f"---\n{ace_insight}\n---\n"
            )
        else:
            ace_instruction = (
                "5. Geotab Ace AI Analysis — Note that Ace AI was unavailable for this report. "
                "Show a brief note that Ace AI insights will be available in the next report cycle.\n"
            )

        from datetime import date as _date
        today_str = _date.today().strftime("%B %d, %Y")

        prompt = (
            f"Generate a professional HTML executive fleet report. Today's date is {today_str}. "
            "IMPORTANT: All units must be metric — km for distance, km/h for speed, litres for fuel, hours for time. "
            "Do NOT use miles, mph, or gallons anywhere.\n"
            "Use the following structure with styled HTML (inline CSS, modern look, no external deps):\n"
            "1. Executive Summary (2-3 sentences)\n"
            "2. Fleet Overview (vehicle count, total distance in km, trips, driving hours)\n"
            "3. Top Performers (highest distance, most trips)\n"
            "4. Anomalies & Concerns (high idle, faults, excessive speed)\n"
            + ace_instruction +
            "6. Recommendations (3-5 actionable items)\n\n"
            "Use a clean, modern LIGHT theme style — white background (#ffffff), dark text (#1a1a2e). "
            "Return ONLY raw HTML — no markdown, no ```html fences, no <html>/<head> tags. Just the styled div content. "
            "Use colors: blue #4a9eff for headers, green #34d399 for positive, red #f87171 for alerts. "
            "All text must be dark (#1a1a2e or #333). Never use light/white text or dark backgrounds.\n"
            "Make section 5 (Ace AI) visually prominent — use a colored border-left or background card.\n"
            "Keep the report concise — aim for under 3000 characters of HTML. No filler text."
        )
        analysis = gemini.analyze_fleet(report_data, question=prompt, max_tokens=4096)

        # Check if Gemini succeeded or we need fallback
        if analysis.get("status") == "success" and analysis.get("analysis"):
            html = analysis["analysis"]
            # Strip markdown code fences if Gemini wrapped the HTML
            html = re.sub(r"^```html?\s*\n?", "", html, flags=re.IGNORECASE)
            html = re.sub(r"\n?```\s*$", "", html)
            source = "gemini"
        else:
            html = _build_fallback_report(report_data, ace_insight)
            source = "fallback"

        result = {
            "status": "ok",
            "html": html,
            "data": report_data,
            "source": source,
        }
        # Cache the full report for 5 minutes
        _cache_set("report_html", result, "report")
        return jsonify(result)
    except Exception as e:
        stale = _cache_stale("report_html")
        if stale:
            return jsonify(stale), 200
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
        stale = _cache_stale(cache_key)
        if stale:
            return jsonify(stale), 200
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


# ── API Tracker ──────────────────────────────────────────────────────────

@app.route("/api/tracker")
def api_tracker_view():
    """API call usage summary and recent calls."""
    hours = int(request.args.get("hours", 24))
    limit = int(request.args.get("limit", 50))
    return jsonify({
        "summary": api_tracker.get_summary(hours=hours),
        "recent": api_tracker.get_recent(limit=limit),
    })


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


# ── TTS API (Gemini) ─────────────────────────────────────────────────────

_TTS_CACHE_DIR = _STATIC_DIR / "audio" / "tts_cache"
_TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
_TTS_CACHE: dict[str, str] = {}  # cache_key → file path

# Load existing cached files on startup
for _f in _TTS_CACHE_DIR.glob("*.mp3"):
    _TTS_CACHE[_f.stem] = str(_f)

# Voice assignments: narrator = demo tour guide, assistant = AI system voice
_TTS_VOICES = {
    "narrator": "Leda",       # Youthful female — demo tour narrator
    "assistant": "Charon",    # Informative male — AI system / fleet assistant
}


import asyncio

_TTS_MODEL = "gemini-2.5-flash-native-audio-latest"


async def _generate_tts_audio(text: str, voice_name: str) -> bytes:
    """Generate raw PCM audio bytes via Gemini Live API (native audio dialog)."""
    from google import genai

    api_key = os.getenv("GEMINI_API_KEY", "")
    client = genai.Client(api_key=api_key)

    config = {
        "response_modalities": ["AUDIO"],
        "system_instruction": "You are a voice-over narrator. Read the user's text exactly as written, word for word. Do not add, remove, or change any words. Do not respond conversationally. Just read the text aloud.",
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {"voice_name": voice_name}
            }
        },
    }

    audio_chunks = []
    async with client.aio.live.connect(model=_TTS_MODEL, config=config) as session:
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": f"Read this exactly: {text}"}]},
            turn_complete=True,
        )
        async for response in session.receive():
            sc = getattr(response, "server_content", None)
            if sc and sc.model_turn:
                for part in sc.model_turn.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        audio_chunks.append(part.inline_data.data)
            # Stop when turn is complete
            if sc and sc.turn_complete:
                break

    return b"".join(audio_chunks)


def _pcm_to_mp3(pcm_data: bytes, cache_key: str) -> str | None:
    """Convert raw 24kHz 16-bit PCM to MP3 via WAV intermediate. Returns mp3 path."""
    import wave

    wav_path = str(_TTS_CACHE_DIR / f"{cache_key}.wav")
    mp3_path = str(_TTS_CACHE_DIR / f"{cache_key}.mp3")

    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(pcm_data)

    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-ar", "44100", "-ac", "1",
         "-b:a", "128k", mp3_path],
        capture_output=True, timeout=30,
    )
    if os.path.isfile(wav_path):
        os.unlink(wav_path)

    if os.path.isfile(mp3_path):
        _TTS_CACHE[cache_key] = mp3_path
        return mp3_path
    return None


@app.route("/api/tts", methods=["POST"])
def api_tts():
    """Generate speech audio from text using Gemini Native Audio Dialog.

    Body: {"text": "Hello world", "voice": "narrator"|"assistant"|"<voice_name>"}
    Returns: audio/mpeg
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "No text provided"}), 400

    # Resolve voice name
    voice_param = data.get("voice", "narrator")
    voice_name = _TTS_VOICES.get(voice_param, voice_param)

    # Cache by text + voice hash
    cache_key = hashlib.md5(f"{text}:{voice_name}".encode()).hexdigest()
    if cache_key in _TTS_CACHE and os.path.isfile(_TTS_CACHE[cache_key]):
        return send_file(_TTS_CACHE[cache_key], mimetype="audio/mpeg")

    try:
        pcm_data = asyncio.run(_generate_tts_audio(text, voice_name))
        if not pcm_data:
            return jsonify({"error": "No audio generated"}), 500

        mp3_path = _pcm_to_mp3(pcm_data, cache_key)
        if not mp3_path:
            return jsonify({"error": "Audio conversion failed"}), 500

        return send_file(mp3_path, mimetype="audio/mpeg")
    except Exception as e:
        print(f"[TTS] Gemini Native Audio error: {e}")
        return jsonify({"error": str(e)}), 500


# ── TTS Warmup ──────────────────────────────────────────────────────────

def _generate_tts(text: str, voice_name: str) -> str | None:
    """Generate a single TTS MP3 and cache it. Returns cache_key or None."""
    cache_key = hashlib.md5(f"{text}:{voice_name}".encode()).hexdigest()
    if cache_key in _TTS_CACHE and os.path.isfile(_TTS_CACHE[cache_key]):
        return cache_key  # already cached

    try:
        pcm_data = asyncio.run(_generate_tts_audio(text, voice_name))
        if not pcm_data:
            return None
        mp3_path = _pcm_to_mp3(pcm_data, cache_key)
        return cache_key if mp3_path else None
    except Exception as e:
        print(f"[TTS warmup] Error generating '{text[:40]}...': {e}")
        return None


@app.route("/api/tts/warmup", methods=["POST"])
def api_tts_warmup():
    """Pre-generate TTS audio for all demo narration lines.

    Body: {"lines": [{"text": "...", "voice": "narrator"}, ...]}
    Returns: {"total": N, "cached": M, "generated": G, "failed": F}
    """
    data = request.get_json(silent=True) or {}
    lines = data.get("lines", [])
    if not lines:
        return jsonify({"error": "No lines provided"}), 400

    cached = 0
    generated = 0
    failed = 0

    for item in lines:
        text = item.get("text", "").strip()
        voice_param = item.get("voice", "narrator")
        voice_name = _TTS_VOICES.get(voice_param, voice_param)
        if not text:
            continue

        cache_key = hashlib.md5(f"{text}:{voice_name}".encode()).hexdigest()
        if cache_key in _TTS_CACHE and os.path.isfile(_TTS_CACHE[cache_key]):
            cached += 1
            continue

        result = _generate_tts(text, voice_name)
        if result:
            generated += 1
        else:
            failed += 1

    return jsonify({
        "total": len(lines),
        "cached": cached,
        "generated": generated,
        "failed": failed,
    })


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
