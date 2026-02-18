"""Google Maps utilities — geocoding and geofence generation."""

from __future__ import annotations

import math
import os

import httpx

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"


def _get_api_key() -> str:
    key = os.getenv("GOOGLE_MAPS_API_KEY", "")
    if not key:
        raise ValueError("GOOGLE_MAPS_API_KEY environment variable is required")
    return key


def geocode_address(address: str) -> dict:
    """Convert a street address to latitude/longitude.

    Args:
        address: Human-readable address (e.g. "123 Main St, Toronto, ON")

    Returns:
        Dict with lat, lng, formatted_address, place_id
    """
    resp = httpx.get(
        GEOCODE_URL,
        params={"address": address, "key": _get_api_key()},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != "OK" or not data.get("results"):
        return {"error": f"Geocoding failed: {data.get('status')}", "address": address}

    result = data["results"][0]
    location = result["geometry"]["location"]
    return {
        "latitude": location["lat"],
        "longitude": location["lng"],
        "formatted_address": result["formatted_address"],
        "place_id": result["place_id"],
        "status": "success",
    }


def reverse_geocode(lat: float, lng: float) -> dict:
    """Convert latitude/longitude to a street address.

    Args:
        lat: Latitude
        lng: Longitude

    Returns:
        Dict with formatted_address
    """
    resp = httpx.get(
        GEOCODE_URL,
        params={"latlng": f"{lat},{lng}", "key": _get_api_key()},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != "OK" or not data.get("results"):
        return {"error": f"Reverse geocoding failed: {data.get('status')}"}

    return {
        "formatted_address": data["results"][0]["formatted_address"],
        "latitude": lat,
        "longitude": lng,
        "status": "success",
    }


def address_to_geofence_points(address: str, radius_m: float = 500) -> dict:
    """Geocode an address and generate polygon points for a Geotab zone.

    Creates an 8-point circle approximation around the geocoded center.
    Points are in Geotab format: {"x": longitude, "y": latitude}.

    Args:
        address: Human-readable address
        radius_m: Radius in meters (default 500)

    Returns:
        Dict with center coordinates, formatted_address, and polygon points
    """
    geo = geocode_address(address)
    if "error" in geo:
        return geo

    lat = geo["latitude"]
    lng = geo["longitude"]

    # Generate 8-point circle approximation
    points = _circle_points(lat, lng, radius_m, num_points=8)

    return {
        "center": {"latitude": lat, "longitude": lng},
        "formatted_address": geo["formatted_address"],
        "radius_m": radius_m,
        "points": points,
        "status": "success",
    }


def _circle_points(
    center_lat: float, center_lng: float, radius_m: float, num_points: int = 8
) -> list[dict]:
    """Generate polygon points approximating a circle.

    Returns points in Geotab zone format: [{"x": lon, "y": lat}, ...].
    """
    # Earth radius in meters
    R = 6_371_000

    points = []
    for i in range(num_points):
        angle = (2 * math.pi * i) / num_points
        # Offset in radians
        d_lat = (radius_m * math.cos(angle)) / R
        d_lng = (radius_m * math.sin(angle)) / (R * math.cos(math.radians(center_lat)))

        point_lat = center_lat + math.degrees(d_lat)
        point_lng = center_lng + math.degrees(d_lng)
        points.append({"x": round(point_lng, 6), "y": round(point_lat, 6)})

    return points
