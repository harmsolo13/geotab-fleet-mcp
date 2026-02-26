"""Shared utility functions for the GeotabVibe fleet dashboard."""

from __future__ import annotations

import math


def circle_points(lat: float, lng: float, radius_m: float = 200, n: int = 8) -> list[dict]:
    """Generate n points forming a circle polygon around (lat, lng).

    Returns a list of {"x": lng, "y": lat} dicts suitable for Geotab zone creation.
    """
    points = []
    for i in range(n):
        angle = 2 * math.pi * i / n
        dlat = (radius_m / 111320) * math.cos(angle)
        dlng = (radius_m / (111320 * math.cos(math.radians(lat)))) * math.sin(angle)
        points.append({"x": lng + dlng, "y": lat + dlat})
    return points
