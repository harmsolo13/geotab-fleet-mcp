"""Geotab Fleet MCP Server — conversational fleet management via Model Context Protocol."""

from __future__ import annotations

from dotenv import load_dotenv

load_dotenv()

from mcp.server.fastmcp import FastMCP

from geotab_mcp.cache import FleetCache
from geotab_mcp.data_connector import DataConnector
from geotab_mcp.geotab_client import GeotabClient
from geotab_mcp.gemini_client import GeminiClient
from geotab_mcp.google_maps import (
    address_to_geofence_points as _geo_address_to_points,
    geocode_address as _geo_geocode,
)

# Initialize FastMCP server
mcp = FastMCP(
    "Geotab Fleet Manager",
    instructions=(
        "You are a fleet management assistant connected to a Geotab telematics system. "
        "You can query real-time vehicle locations, trip history, fuel data, driver safety "
        "scores, fault codes, and fleet KPIs. You can also create geofences and send "
        "messages to in-cab devices. Use the tools below to answer fleet management questions. "
        "After fetching data, it is automatically cached in DuckDB for follow-up SQL analysis. "
        "You can delegate fleet data analysis to Google Gemini AI using gemini_analyze, and "
        "create geofences from street addresses using geocode_address and create_geofence_from_address."
    ),
)

# Shared clients (initialized lazily on first use)
_geotab: GeotabClient | None = None
_dc: DataConnector | None = None
_cache: FleetCache | None = None
_gemini: GeminiClient | None = None


def _get_geotab() -> GeotabClient:
    global _geotab
    if _geotab is None:
        _geotab = GeotabClient()
        _geotab.authenticate()
    return _geotab


def _get_dc() -> DataConnector:
    global _dc
    if _dc is None:
        _dc = DataConnector()
    return _dc


def _get_cache() -> FleetCache:
    global _cache
    if _cache is None:
        _cache = FleetCache()
    return _cache


def _get_gemini() -> GeminiClient:
    global _gemini
    if _gemini is None:
        _gemini = GeminiClient()
    return _gemini


def _auto_cache(name: str, data: list[dict], description: str = "") -> None:
    """Auto-cache API results for subsequent SQL analysis."""
    if data:
        _get_cache().cache_dataset(name, data, description=description)


# ---------------------------------------------------------------------------
# Tool 1: Test Connection
# ---------------------------------------------------------------------------
@mcp.tool()
def test_connection() -> dict:
    """Test connectivity to the Geotab API.

    Validates credentials and returns the server version.
    Use this first to verify the connection is working.
    """
    try:
        client = _get_geotab()
        return client.test_connection()
    except Exception as e:
        return {"connected": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Tool 2: Get Fleet Vehicles
# ---------------------------------------------------------------------------
@mcp.tool()
def get_fleet_vehicles(limit: int = 500) -> dict:
    """List all vehicles in the fleet with status, VIN, make/model, and odometer.

    Returns a summary of every vehicle (Device) registered in MyGeotab.
    Results are auto-cached as 'vehicles' for SQL analysis.

    Args:
        limit: Maximum number of vehicles to return (default 500)
    """
    vehicles = _get_geotab().get_vehicles(limit=limit)
    _auto_cache("vehicles", vehicles, "Fleet vehicle inventory")
    return {"count": len(vehicles), "vehicles": vehicles}


# ---------------------------------------------------------------------------
# Tool 3: Get Vehicle Details
# ---------------------------------------------------------------------------
@mcp.tool()
def get_vehicle_details(device_id: str) -> dict:
    """Get detailed information about a specific vehicle.

    Provides full device profile including VIN, serial number, odometer,
    engine hours, groups, and activation dates.

    Args:
        device_id: The Geotab Device ID (e.g. 'b1234')
    """
    return _get_geotab().get_vehicle_details(device_id)


# ---------------------------------------------------------------------------
# Tool 4: Get Fleet Drivers
# ---------------------------------------------------------------------------
@mcp.tool()
def get_fleet_drivers(limit: int = 200) -> dict:
    """List all drivers in the fleet.

    Returns users flagged as drivers with their name, employee number,
    driver groups, and key fob serial numbers.
    Results are auto-cached as 'drivers' for SQL analysis.

    Args:
        limit: Maximum number of drivers to return (default 200)
    """
    drivers = _get_geotab().get_drivers(limit=limit)
    _auto_cache("drivers", drivers, "Fleet driver roster")
    return {"count": len(drivers), "drivers": drivers}


# ---------------------------------------------------------------------------
# Tool 5: Get Vehicle Location
# ---------------------------------------------------------------------------
@mcp.tool()
def get_vehicle_location(device_id: str) -> dict:
    """Get the current real-time GPS position and speed of a vehicle.

    Returns latitude, longitude, speed, bearing, and communication status.

    Args:
        device_id: The Geotab Device ID (e.g. 'b1234')
    """
    return _get_geotab().get_vehicle_location(device_id)


# ---------------------------------------------------------------------------
# Tool 6: Get Active Faults
# ---------------------------------------------------------------------------
@mcp.tool()
def get_active_faults(
    device_id: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 200,
) -> dict:
    """Get active fault codes (DTCs) across the fleet or for a specific vehicle.

    Returns diagnostic trouble codes with failure modes, controllers, and timestamps.
    Results are auto-cached as 'faults' for SQL analysis.

    Args:
        device_id: Optional - filter to a specific vehicle
        from_date: Start date in ISO format (default: 7 days ago)
        to_date: End date in ISO format (default: now)
        limit: Maximum results (default 200)
    """
    faults = _get_geotab().get_faults(
        device_id=device_id, from_date=from_date, to_date=to_date, limit=limit
    )
    _auto_cache("faults", faults, "Vehicle fault/DTC data")
    return {"count": len(faults), "faults": faults}


# ---------------------------------------------------------------------------
# Tool 7: Get Trip History
# ---------------------------------------------------------------------------
@mcp.tool()
def get_trip_history(
    device_id: str,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 100,
) -> dict:
    """Get trip history for a vehicle including distance, duration, and speeds.

    Returns start/stop times, distance driven, driving/idle/stop durations,
    and max/average speeds for each trip.
    Results are auto-cached as 'trips' for SQL analysis.

    Args:
        device_id: The Geotab Device ID
        from_date: Start date in ISO format (default: 7 days ago)
        to_date: End date in ISO format (default: now)
        limit: Maximum trips to return (default 100)
    """
    trips = _get_geotab().get_trips(
        device_id=device_id, from_date=from_date, to_date=to_date, limit=limit
    )
    _auto_cache("trips", trips, f"Trip history for device {device_id}")
    return {"count": len(trips), "trips": trips}


# ---------------------------------------------------------------------------
# Tool 8: Get Fuel Analysis
# ---------------------------------------------------------------------------
@mcp.tool()
def get_fuel_analysis(
    device_id: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 200,
) -> dict:
    """Get fuel transaction data for efficiency analysis and cost tracking.

    Returns fuel purchases with cost, volume, odometer, and product type.
    Results are auto-cached as 'fuel_transactions' for SQL analysis.

    Args:
        device_id: Optional - filter to a specific vehicle
        from_date: Start date in ISO format (default: 30 days ago)
        to_date: End date in ISO format (default: now)
        limit: Maximum results (default 200)
    """
    transactions = _get_geotab().get_fuel_transactions(
        device_id=device_id, from_date=from_date, to_date=to_date, limit=limit
    )
    _auto_cache("fuel_transactions", transactions, "Fuel transaction data")
    return {"count": len(transactions), "transactions": transactions}


# ---------------------------------------------------------------------------
# Tool 9: Get Safety Scores
# ---------------------------------------------------------------------------
@mcp.tool()
def get_safety_scores(
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict:
    """Get driver safety scores from the Geotab Data Connector.

    Returns daily safety scores and event counts per driver.
    Results are auto-cached as 'driver_safety' for SQL analysis.

    Args:
        from_date: Start date as YYYY-MM-DD (default: 30 days ago)
        to_date: End date as YYYY-MM-DD (default: today)
    """
    try:
        data = _get_dc().get_driver_safety(from_date=from_date, to_date=to_date)
        _auto_cache("driver_safety", data, "Driver safety scores")
        return {"count": len(data), "safety_scores": data}
    except Exception as e:
        return {"error": str(e), "hint": "Data Connector may not be available for this database"}


# ---------------------------------------------------------------------------
# Tool 10: Get Fleet KPIs
# ---------------------------------------------------------------------------
@mcp.tool()
def get_fleet_kpis(
    from_date: str | None = None,
    to_date: str | None = None,
    device_id: str | None = None,
) -> dict:
    """Get daily fleet KPIs (distance, fuel, idle time, etc.) from the Data Connector.

    Returns pre-aggregated daily statistics per vehicle from Geotab's Data Connector
    OData API. Much more efficient than calculating from raw trip data.
    Results are auto-cached as 'fleet_kpis' for SQL analysis.

    Args:
        from_date: Start date as YYYY-MM-DD (default: 30 days ago)
        to_date: End date as YYYY-MM-DD (default: today)
        device_id: Optional - filter to a specific vehicle
    """
    try:
        data = _get_dc().get_vehicle_kpis(
            from_date=from_date, to_date=to_date, device_id=device_id
        )
        _auto_cache("fleet_kpis", data, "Fleet KPI data from Data Connector")
        return {"count": len(data), "kpis": data}
    except Exception as e:
        return {"error": str(e), "hint": "Data Connector may not be available for this database"}


# ---------------------------------------------------------------------------
# Tool 11: Create Geofence
# ---------------------------------------------------------------------------
@mcp.tool()
def create_geofence(
    name: str,
    points: list[dict],
    zone_types: list[str] | None = None,
    comment: str = "",
) -> dict:
    """Create a geofence zone in MyGeotab.

    Define a geographic boundary with a name and polygon points.
    The zone can be used for exception rules, reporting, and alerts.

    Args:
        name: Name for the geofence (e.g. 'Warehouse A')
        points: List of polygon vertices as [{"x": longitude, "y": latitude}, ...]
                Minimum 3 points. The polygon is auto-closed.
        zone_types: Optional list of zone type IDs
        comment: Optional description
    """
    try:
        zone_id = _get_geotab().create_zone(
            name=name, points=points, zone_types=zone_types, comment=comment
        )
        return {"status": "created", "zoneId": zone_id, "name": name}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Tool 12: Send Message
# ---------------------------------------------------------------------------
@mcp.tool()
def send_message(device_id: str, message: str) -> dict:
    """Send a text message to a vehicle's in-cab Garmin or GO device.

    The message appears on the driver's in-cab display.

    Args:
        device_id: The Geotab Device ID of the target vehicle
        message: Text message to send to the driver
    """
    try:
        msg_id = _get_geotab().send_text_message(device_id, message)
        return {"status": "sent", "messageId": msg_id, "deviceId": device_id}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Tool 13: Query Fleet Data (SQL)
# ---------------------------------------------------------------------------
@mcp.tool()
def query_fleet_data(sql: str) -> dict:
    """Run a SQL query over cached fleet data in DuckDB.

    Use this for ad-hoc analysis after fetching data with other tools.
    Tables are auto-created when data is fetched (e.g. 'vehicles', 'trips',
    'faults', 'fuel_transactions', 'driver_safety', 'fleet_kpis').

    Use list_cached_datasets first to see available tables and their columns.

    Args:
        sql: SQL query to execute (DuckDB SQL dialect)
    """
    return _get_cache().query(sql)


# ---------------------------------------------------------------------------
# Tool 14: List Cached Datasets
# ---------------------------------------------------------------------------
@mcp.tool()
def list_cached_datasets() -> dict:
    """List all datasets currently cached in the local DuckDB database.

    Shows dataset names, row counts, cache timestamps, and descriptions.
    Use this to know what tables are available for SQL queries.
    """
    datasets = _get_cache().list_datasets()
    return {"count": len(datasets), "datasets": datasets}


# ---------------------------------------------------------------------------
# Tool 15: Export Data
# ---------------------------------------------------------------------------
@mcp.tool()
def export_data(dataset_name: str, format: str = "json") -> dict:
    """Export a cached dataset to JSON or CSV format.

    Args:
        dataset_name: Name of the cached dataset to export
        format: Output format - 'json' or 'csv' (default: json)
    """
    return _get_cache().export_dataset(dataset_name, format=format)


# ---------------------------------------------------------------------------
# Tool 16: Get Exception Events
# ---------------------------------------------------------------------------
@mcp.tool()
def get_exception_events(
    from_date: str | None = None,
    to_date: str | None = None,
    device_id: str | None = None,
    limit: int = 200,
) -> dict:
    """Get exception/rule violation events across the fleet.

    Returns events where vehicles or drivers violated configured rules
    (e.g. speeding, harsh braking, after-hours usage).
    Results are auto-cached as 'exception_events' for SQL analysis.

    Args:
        from_date: Start date in ISO format (default: 7 days ago)
        to_date: End date in ISO format (default: now)
        device_id: Optional - filter to a specific vehicle
        limit: Maximum results (default 200)
    """
    events = _get_geotab().get_exception_events(
        from_date=from_date, to_date=to_date, device_id=device_id, limit=limit
    )
    _auto_cache("exception_events", events, "Exception/rule violation events")
    return {"count": len(events), "events": events}


# ---------------------------------------------------------------------------
# Tool 17: Get Zones/Geofences
# ---------------------------------------------------------------------------
@mcp.tool()
def get_zones(limit: int = 200) -> dict:
    """List all geofence zones configured in MyGeotab.

    Returns zone names, types, groups, point counts, and centroids.
    Results are auto-cached as 'zones' for SQL analysis.

    Args:
        limit: Maximum zones to return (default 200)
    """
    zones = _get_geotab().get_zones(limit=limit)
    _auto_cache("zones", zones, "Geofence zones")
    return {"count": len(zones), "zones": zones}


# ---------------------------------------------------------------------------
# Tool 18: Gemini AI Fleet Analysis
# ---------------------------------------------------------------------------
@mcp.tool()
def gemini_analyze(
    data: str,
    analysis_type: str = "general",
    question: str = "",
) -> dict:
    """Delegate fleet data analysis to Google Gemini AI.

    Send fleet data (previously fetched with other tools) to Gemini for
    expert analysis. Gemini acts as a subordinate analyst — you orchestrate
    what data to send and what type of analysis to request.

    Args:
        data: Fleet data as a JSON string (paste output from other tools)
        analysis_type: Type of analysis — one of:
            efficiency, safety, maintenance, route_optimization, cost, general
        question: Optional specific question to answer about the data
    """
    try:
        return _get_gemini().analyze_fleet(
            data=data, analysis_type=analysis_type, question=question
        )
    except Exception as e:
        return {"error": str(e), "hint": "Check GEMINI_API_KEY is set correctly"}


# ---------------------------------------------------------------------------
# Tool 19: Geocode Address
# ---------------------------------------------------------------------------
@mcp.tool()
def geocode_address(address: str) -> dict:
    """Convert a street address to GPS coordinates using Google Geocoding API.

    Useful for looking up coordinates before creating geofences, or for
    enriching fleet data with location context.

    Args:
        address: Human-readable address (e.g. '123 Main St, Toronto, ON')
    """
    try:
        return _geo_geocode(address)
    except Exception as e:
        return {"error": str(e), "hint": "Check GOOGLE_MAPS_API_KEY is set correctly"}


# ---------------------------------------------------------------------------
# Tool 20: Create Geofence from Address
# ---------------------------------------------------------------------------
@mcp.tool()
def create_geofence_from_address(
    address: str,
    name: str,
    radius_m: float = 500,
    comment: str = "",
) -> dict:
    """Create a geofence zone from a street address in one step.

    Geocodes the address to GPS coordinates, generates an 8-point polygon
    approximating a circle of the given radius, and creates the zone in MyGeotab.

    Example: 'Create a geofence called Warehouse around 123 Main St'

    Args:
        address: Street address to center the geofence on
        name: Name for the geofence zone
        radius_m: Radius in meters (default 500)
        comment: Optional description for the zone
    """
    try:
        geo = _geo_address_to_points(address, radius_m=radius_m)
        if "error" in geo:
            return geo

        zone_id = _get_geotab().create_zone(
            name=name,
            points=geo["points"],
            comment=comment or f"Auto-created from address: {geo['formatted_address']}",
        )
        return {
            "status": "created",
            "zoneId": zone_id,
            "name": name,
            "center": geo["center"],
            "formatted_address": geo["formatted_address"],
            "radius_m": radius_m,
            "point_count": len(geo["points"]),
        }
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    """Run the Geotab Fleet MCP server."""
    mcp.run()


if __name__ == "__main__":
    main()
