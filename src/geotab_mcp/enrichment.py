"""SQLite vehicle enrichment layer for presentation-grade fleet data.

The Demo_VCDataset vehicles are named "Demo - 01" through "Demo - 50" with blank
make/model/year/VIN/odometer/engineHours. This module overlays realistic Canadian
mixed-fleet data from a local SQLite DB, with a clean toggle to fall back to
API-only mode.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

_DB_PATH = Path(__file__).resolve().parent.parent.parent / "fleet_enrichment.db"

# Module-level cache
_enrichment_cache: dict | None = None
_cache_expires: float = 0.0
_CACHE_TTL = 300  # 5 minutes

_enabled: bool | None = None  # lazy-loaded from DB


# ── Fleet Seed Data ──────────────────────────────────────────────────────
# 50 vehicles keyed by Geotab device_id (b1 .. b32 in hex sequence)

_FLEET_DATA = [
    # --- Vans (15) ---
    {"device_id": "b1", "display_name": "Unit 01 — Ford Transit", "make": "Ford", "model": "Transit 250", "year": 2023, "vin": "1FTBW2CM5NKA12345", "odometer_km": 87432.5, "engine_hours": 2841.3, "driver_name": "Mike Chen", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "b2", "display_name": "Unit 02 — Mercedes Sprinter", "make": "Mercedes-Benz", "model": "Sprinter 2500", "year": 2022, "vin": "W1Y4ECHY2NT123456", "odometer_km": 112850.0, "engine_hours": 3640.7, "driver_name": "Sarah Thompson", "fuel_type": "Diesel", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "b3", "display_name": "Unit 03 — RAM ProMaster", "make": "RAM", "model": "ProMaster 2500", "year": 2023, "vin": "3C6LRVDG4NE234567", "odometer_km": 64210.3, "engine_hours": 2105.4, "driver_name": "James Wilson", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "b4", "display_name": "Unit 04 — Ford Transit", "make": "Ford", "model": "Transit 350", "year": 2024, "vin": "1FTBW3CM1PKB34567", "odometer_km": 28415.8, "engine_hours": 945.2, "driver_name": "Priya Patel", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "Blue", "department": "Service"},
    {"device_id": "b5", "display_name": "Unit 05 — Mercedes Sprinter", "make": "Mercedes-Benz", "model": "Sprinter 3500", "year": 2021, "vin": "W1Y4ECHY5MT345678", "odometer_km": 156320.4, "engine_hours": 5032.1, "driver_name": "David Leblanc", "fuel_type": "Diesel", "vehicle_type": "Van", "color": "Silver", "department": "Delivery"},
    {"device_id": "b6", "display_name": "Unit 06 — Ford Transit Connect", "make": "Ford", "model": "Transit Connect", "year": 2023, "vin": "NM0GE9F22P1456789", "odometer_km": 41230.7, "engine_hours": 1380.6, "driver_name": "Lisa Nguyen", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Service"},
    {"device_id": "b7", "display_name": "Unit 07 — RAM ProMaster City", "make": "RAM", "model": "ProMaster City", "year": 2022, "vin": "ZFBHRFAB8N6567890", "odometer_km": 73845.2, "engine_hours": 2410.8, "driver_name": "Ryan O'Brien", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "Grey", "department": "Field Ops"},
    {"device_id": "b8", "display_name": "Unit 08 — Ford Transit", "make": "Ford", "model": "Transit 250", "year": 2022, "vin": "1FTBW2CM7NKB67890", "odometer_km": 98754.1, "engine_hours": 3215.5, "driver_name": "Emma Tremblay", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "b9", "display_name": "Unit 09 — Mercedes Sprinter", "make": "Mercedes-Benz", "model": "Sprinter 2500", "year": 2024, "vin": "W1Y4ECHY3PT678901", "odometer_km": 15230.6, "engine_hours": 498.3, "driver_name": "Alex Kim", "fuel_type": "Diesel", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "bA", "display_name": "Unit 10 — Ford Transit", "make": "Ford", "model": "Transit 350 HD", "year": 2023, "vin": "1FTBW3XM2NKC78901", "odometer_km": 82145.9, "engine_hours": 2678.4, "driver_name": "Marcus Johnson", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "bB", "display_name": "Unit 11 — RAM ProMaster", "make": "RAM", "model": "ProMaster 1500", "year": 2023, "vin": "3C6LRVAG5NE789012", "odometer_km": 55420.3, "engine_hours": 1812.7, "driver_name": "Sophie Gagnon", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "Red", "department": "Service"},
    {"device_id": "bC", "display_name": "Unit 12 — Ford Transit", "make": "Ford", "model": "Transit 250", "year": 2021, "vin": "1FTBW2CM9MKD89012", "odometer_km": 145320.8, "engine_hours": 4705.2, "driver_name": "Daniel Roy", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Field Ops"},
    {"device_id": "bD", "display_name": "Unit 13 — Mercedes Sprinter", "make": "Mercedes-Benz", "model": "Sprinter 2500", "year": 2023, "vin": "W1Y4ECHY1NT890123", "odometer_km": 67890.5, "engine_hours": 2203.6, "driver_name": "Aisha Mohammed", "fuel_type": "Diesel", "vehicle_type": "Van", "color": "White", "department": "Delivery"},
    {"device_id": "bE", "display_name": "Unit 14 — Ford Transit", "make": "Ford", "model": "Transit Connect", "year": 2024, "vin": "NM0GE9F24P1901234", "odometer_km": 19875.4, "engine_hours": 652.1, "driver_name": "Tom Campbell", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "Blue", "department": "Service"},
    {"device_id": "bF", "display_name": "Unit 15 — RAM ProMaster", "make": "RAM", "model": "ProMaster 2500", "year": 2022, "vin": "3C6LRVDG2NE012345", "odometer_km": 91230.7, "engine_hours": 2965.8, "driver_name": "Natalie Bouchard", "fuel_type": "Gasoline", "vehicle_type": "Van", "color": "White", "department": "Delivery"},

    # --- Pickups (12) ---
    {"device_id": "b10", "display_name": "Unit 16 — Ford F-150", "make": "Ford", "model": "F-150 XLT", "year": 2023, "vin": "1FTFW1E84NFA12345", "odometer_km": 52340.6, "engine_hours": 1720.3, "driver_name": "Chris Martin", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Black", "department": "Field Ops"},
    {"device_id": "b11", "display_name": "Unit 17 — GMC Sierra", "make": "GMC", "model": "Sierra 1500 SLE", "year": 2023, "vin": "3GTU9DED5NG234567", "odometer_km": 61845.2, "engine_hours": 2015.7, "driver_name": "Kevin Lavoie", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Red", "department": "Field Ops"},
    {"device_id": "b12", "display_name": "Unit 18 — RAM 1500", "make": "RAM", "model": "1500 Big Horn", "year": 2024, "vin": "1C6SRFFT5PN345678", "odometer_km": 24560.1, "engine_hours": 805.4, "driver_name": "Michelle Wong", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "White", "department": "Service"},
    {"device_id": "b13", "display_name": "Unit 19 — Chevy Silverado", "make": "Chevrolet", "model": "Silverado 1500 LT", "year": 2022, "vin": "3GCUYDED1NG456789", "odometer_km": 89120.4, "engine_hours": 2890.6, "driver_name": "Jason Bergeron", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Blue", "department": "Field Ops"},
    {"device_id": "b14", "display_name": "Unit 20 — Ford F-150", "make": "Ford", "model": "F-150 Lariat", "year": 2024, "vin": "1FTFW1E86PKB56789", "odometer_km": 18230.5, "engine_hours": 598.2, "driver_name": "Andrew Cote", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Silver", "department": "Executive"},
    {"device_id": "b15", "display_name": "Unit 21 — GMC Sierra", "make": "GMC", "model": "Sierra 2500HD", "year": 2023, "vin": "1GT49VEY5NF678901", "odometer_km": 74520.8, "engine_hours": 2430.1, "driver_name": "Steve Pelletier", "fuel_type": "Diesel", "vehicle_type": "Pickup", "color": "White", "department": "Field Ops"},
    {"device_id": "b16", "display_name": "Unit 22 — RAM 1500", "make": "RAM", "model": "1500 Laramie", "year": 2023, "vin": "1C6SRFFT7PN789012", "odometer_km": 45870.3, "engine_hours": 1502.5, "driver_name": "Rachel Simard", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Grey", "department": "Sales"},
    {"device_id": "b17", "display_name": "Unit 23 — Chevy Silverado", "make": "Chevrolet", "model": "Silverado 1500 WT", "year": 2022, "vin": "3GCNWAEF3NG890123", "odometer_km": 105640.2, "engine_hours": 3425.7, "driver_name": "Mark Fortin", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "White", "department": "Service"},
    {"device_id": "b18", "display_name": "Unit 24 — Ford F-250", "make": "Ford", "model": "F-250 XLT", "year": 2023, "vin": "1FT7W2BT5NEC01234", "odometer_km": 68340.9, "engine_hours": 2218.4, "driver_name": "Tyler Gauthier", "fuel_type": "Diesel", "vehicle_type": "Pickup", "color": "White", "department": "Field Ops"},
    {"device_id": "b19", "display_name": "Unit 25 — GMC Sierra", "make": "GMC", "model": "Sierra 1500 AT4", "year": 2024, "vin": "3GTU9FED2PG123456", "odometer_km": 21450.7, "engine_hours": 702.3, "driver_name": "Isabelle Morin", "fuel_type": "Gasoline", "vehicle_type": "Pickup", "color": "Black", "department": "Executive"},
    {"device_id": "b1A", "display_name": "Unit 26 — RAM 2500", "make": "RAM", "model": "2500 Tradesman", "year": 2022, "vin": "3C6UR5DL4NG234567", "odometer_km": 112450.6, "engine_hours": 3648.9, "driver_name": "Patrick Belanger", "fuel_type": "Diesel", "vehicle_type": "Pickup", "color": "White", "department": "Field Ops"},
    {"device_id": "b1B", "display_name": "Unit 27 — Chevy Silverado", "make": "Chevrolet", "model": "Silverado 2500HD", "year": 2023, "vin": "1GC4YREY0NF345678", "odometer_km": 58920.4, "engine_hours": 1925.6, "driver_name": "Greg Ouellet", "fuel_type": "Diesel", "vehicle_type": "Pickup", "color": "Red", "department": "Field Ops"},

    # --- Sedans (8) ---
    {"device_id": "b1C", "display_name": "Unit 28 — Honda Civic", "make": "Honda", "model": "Civic EX", "year": 2023, "vin": "2HGFE2F53PH456789", "odometer_km": 34520.1, "engine_hours": 1130.4, "driver_name": "Jennifer Liu", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Silver", "department": "Sales"},
    {"device_id": "b1D", "display_name": "Unit 29 — Toyota Camry", "make": "Toyota", "model": "Camry LE", "year": 2024, "vin": "4T1C11AK5PU567890", "odometer_km": 18940.8, "engine_hours": 620.5, "driver_name": "Robert Cloutier", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Blue", "department": "Sales"},
    {"device_id": "b1E", "display_name": "Unit 30 — Hyundai Elantra", "make": "Hyundai", "model": "Elantra Preferred", "year": 2023, "vin": "5NPD84LF5PH678901", "odometer_km": 42180.5, "engine_hours": 1378.2, "driver_name": "Amy Desjardins", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "White", "department": "Sales"},
    {"device_id": "b1F", "display_name": "Unit 31 — Honda Civic", "make": "Honda", "model": "Civic Sport", "year": 2022, "vin": "2HGFE2F59NH789012", "odometer_km": 67430.2, "engine_hours": 2198.7, "driver_name": "Brian Girard", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Black", "department": "Executive"},
    {"device_id": "b20", "display_name": "Unit 32 — Toyota Camry", "make": "Toyota", "model": "Camry SE", "year": 2023, "vin": "4T1G11AK3PU890123", "odometer_km": 51240.6, "engine_hours": 1675.3, "driver_name": "Samantha Beaulieu", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Red", "department": "Sales"},
    {"device_id": "b21", "display_name": "Unit 33 — Hyundai Sonata", "make": "Hyundai", "model": "Sonata SEL", "year": 2024, "vin": "5NPE34AF8PH901234", "odometer_km": 15680.4, "engine_hours": 512.6, "driver_name": "Eric Nadeau", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Grey", "department": "Executive"},
    {"device_id": "b22", "display_name": "Unit 34 — Toyota Corolla", "make": "Toyota", "model": "Corolla LE", "year": 2023, "vin": "JTDEPRAE5PJ012345", "odometer_km": 38950.7, "engine_hours": 1272.1, "driver_name": "Melissa Tanguay", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "White", "department": "Sales"},
    {"device_id": "b23", "display_name": "Unit 35 — Honda Accord", "make": "Honda", "model": "Accord EX-L", "year": 2023, "vin": "1HGCY2F90PA123456", "odometer_km": 48720.3, "engine_hours": 1590.8, "driver_name": "Vincent Dube", "fuel_type": "Gasoline", "vehicle_type": "Sedan", "color": "Silver", "department": "Executive"},

    # --- SUVs (8) ---
    {"device_id": "b24", "display_name": "Unit 36 — Toyota RAV4", "make": "Toyota", "model": "RAV4 LE", "year": 2024, "vin": "2T3P1RFV0PW234567", "odometer_km": 22340.5, "engine_hours": 732.4, "driver_name": "Karen St-Pierre", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "Blue", "department": "Service"},
    {"device_id": "b25", "display_name": "Unit 37 — Chevy Equinox", "make": "Chevrolet", "model": "Equinox LT", "year": 2023, "vin": "3GNAXKEV5PL345678", "odometer_km": 45120.8, "engine_hours": 1475.2, "driver_name": "Scott Lefebvre", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "Grey", "department": "Sales"},
    {"device_id": "b26", "display_name": "Unit 38 — Ford Escape", "make": "Ford", "model": "Escape SEL", "year": 2023, "vin": "1FMCU9J95PUA56789", "odometer_km": 52840.3, "engine_hours": 1725.6, "driver_name": "Julie Hebert", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "White", "department": "Service"},
    {"device_id": "b27", "display_name": "Unit 39 — Toyota RAV4 Hybrid", "make": "Toyota", "model": "RAV4 Hybrid XLE", "year": 2024, "vin": "2T3DWRFV5PW678901", "odometer_km": 16450.2, "engine_hours": 538.7, "driver_name": "Derek Poulin", "fuel_type": "Hybrid", "vehicle_type": "SUV", "color": "Silver", "department": "Executive"},
    {"device_id": "b28", "display_name": "Unit 40 — Chevy Equinox", "make": "Chevrolet", "model": "Equinox RS", "year": 2024, "vin": "3GNAXKEV3PL789012", "odometer_km": 19870.6, "engine_hours": 650.3, "driver_name": "Laura Duchesne", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "Black", "department": "Sales"},
    {"device_id": "b29", "display_name": "Unit 41 — Ford Bronco Sport", "make": "Ford", "model": "Bronco Sport Big Bend", "year": 2023, "vin": "3FMCR9B60PRA90123", "odometer_km": 38920.4, "engine_hours": 1272.5, "driver_name": "Matt Savard", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "Green", "department": "Field Ops"},
    {"device_id": "b2A", "display_name": "Unit 42 — Hyundai Tucson", "make": "Hyundai", "model": "Tucson Preferred", "year": 2023, "vin": "5NMJFDAF4PH012345", "odometer_km": 41560.8, "engine_hours": 1358.4, "driver_name": "Christine Lepage", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "White", "department": "Service"},
    {"device_id": "b2B", "display_name": "Unit 43 — Toyota Highlander", "make": "Toyota", "model": "Highlander Limited", "year": 2024, "vin": "5TDKK4GC2PS123456", "odometer_km": 24680.1, "engine_hours": 808.2, "driver_name": "Michael Caron", "fuel_type": "Gasoline", "vehicle_type": "SUV", "color": "Grey", "department": "Executive"},

    # --- EVs (4) ---
    {"device_id": "b2C", "display_name": "Unit 44 — Tesla Model 3", "make": "Tesla", "model": "Model 3 Long Range", "year": 2024, "vin": "5YJ3E1EA5PF234567", "odometer_km": 28340.5, "engine_hours": 925.6, "driver_name": "Nina Fournier", "fuel_type": "Electric", "vehicle_type": "EV Sedan", "color": "White", "department": "Executive"},
    {"device_id": "b2D", "display_name": "Unit 45 — Chevy Bolt", "make": "Chevrolet", "model": "Bolt EUV Premier", "year": 2023, "vin": "1G1FY6S08P4345678", "odometer_km": 35620.8, "engine_hours": 1165.3, "driver_name": "Peter Mercier", "fuel_type": "Electric", "vehicle_type": "EV Crossover", "color": "Blue", "department": "Sales"},
    {"device_id": "b2E", "display_name": "Unit 46 — VW ID.4", "make": "Volkswagen", "model": "ID.4 Pro S", "year": 2024, "vin": "WVWDMEAE3PP456789", "odometer_km": 18950.4, "engine_hours": 620.1, "driver_name": "Helen Bernier", "fuel_type": "Electric", "vehicle_type": "EV SUV", "color": "Grey", "department": "Service"},
    {"device_id": "b2F", "display_name": "Unit 47 — Ford F-150 Lightning", "make": "Ford", "model": "F-150 Lightning XLT", "year": 2024, "vin": "1FTVW1EL6PWG67890", "odometer_km": 21430.2, "engine_hours": 702.4, "driver_name": "Francois Lemieux", "fuel_type": "Electric", "vehicle_type": "EV Pickup", "color": "Blue", "department": "Field Ops"},

    # --- Heavy (3) ---
    {"device_id": "b30", "display_name": "Unit 48 — Hino 195", "make": "Hino", "model": "195 Cab Over", "year": 2022, "vin": "5PVNJ8JV7N4578901", "odometer_km": 132450.6, "engine_hours": 4312.8, "driver_name": "Richard Theriault", "fuel_type": "Diesel", "vehicle_type": "Medium Truck", "color": "White", "department": "Delivery"},
    {"device_id": "b31", "display_name": "Unit 49 — Ford F-550", "make": "Ford", "model": "F-550 XL DRW", "year": 2023, "vin": "1FD0W5HT5PEA89012", "odometer_km": 78940.3, "engine_hours": 2568.5, "driver_name": "Wayne Parent", "fuel_type": "Diesel", "vehicle_type": "Heavy Pickup", "color": "White", "department": "Field Ops"},
    {"device_id": "b32", "display_name": "Unit 50 — Isuzu NPR", "make": "Isuzu", "model": "NPR HD", "year": 2022, "vin": "54DC4W1B4NS690123", "odometer_km": 145820.9, "engine_hours": 4740.2, "driver_name": "Youssef Hamdi", "fuel_type": "Diesel", "vehicle_type": "Medium Truck", "color": "White", "department": "Delivery"},
]


def _get_db() -> sqlite3.Connection:
    """Open (or create) the enrichment database."""
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create tables and seed fleet data if the DB is empty."""
    conn = _get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS vehicles (
            device_id   TEXT PRIMARY KEY,
            display_name TEXT,
            make        TEXT,
            model       TEXT,
            year        INTEGER,
            vin         TEXT,
            odometer_km REAL,
            engine_hours REAL,
            driver_name TEXT,
            fuel_type   TEXT,
            vehicle_type TEXT,
            color       TEXT,
            department  TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.execute(
        "INSERT OR IGNORE INTO config (key, value) VALUES ('enrichment_enabled', '1')"
    )

    # Seed vehicles if table is empty
    count = conn.execute("SELECT COUNT(*) FROM vehicles").fetchone()[0]
    if count == 0:
        conn.executemany(
            """INSERT INTO vehicles
               (device_id, display_name, make, model, year, vin,
                odometer_km, engine_hours, driver_name, fuel_type,
                vehicle_type, color, department)
               VALUES (:device_id, :display_name, :make, :model, :year, :vin,
                       :odometer_km, :engine_hours, :driver_name, :fuel_type,
                       :vehicle_type, :color, :department)""",
            _FLEET_DATA,
        )
    conn.commit()
    conn.close()


def is_enabled() -> bool:
    """Check if enrichment is enabled (cached in module var)."""
    global _enabled
    if _enabled is None:
        conn = _get_db()
        row = conn.execute(
            "SELECT value FROM config WHERE key = 'enrichment_enabled'"
        ).fetchone()
        conn.close()
        _enabled = row[0] == "1" if row else True
    return _enabled


def toggle() -> bool:
    """Flip enrichment on/off, return new state."""
    global _enabled, _enrichment_cache, _cache_expires
    new_val = "0" if is_enabled() else "1"
    conn = _get_db()
    conn.execute(
        "UPDATE config SET value = ? WHERE key = 'enrichment_enabled'", (new_val,)
    )
    conn.commit()
    conn.close()
    _enabled = new_val == "1"
    # Bust cache so next request reflects the change
    _enrichment_cache = None
    _cache_expires = 0.0
    return _enabled


def get_enrichment_map() -> dict[str, dict]:
    """Return {device_id: row_dict} from the vehicles table, cached for 5 min."""
    global _enrichment_cache, _cache_expires
    now = time.monotonic()
    if _enrichment_cache is not None and now < _cache_expires:
        return _enrichment_cache

    conn = _get_db()
    rows = conn.execute("SELECT * FROM vehicles").fetchall()
    conn.close()

    result = {}
    for row in rows:
        result[row["device_id"]] = dict(row)
    _enrichment_cache = result
    _cache_expires = now + _CACHE_TTL
    return result


def enrich_vehicles(vehicles: list[dict]) -> list[dict]:
    """Overlay enrichment data onto API vehicles. API real-time fields always win."""
    if not is_enabled():
        return vehicles

    emap = get_enrichment_map()
    enriched = []
    for v in vehicles:
        v = dict(v)  # don't mutate original
        e = emap.get(v.get("id"))
        if e:
            v["name"] = e["display_name"]
            v["make"] = e["make"]
            v["model"] = e["model"]
            v["year"] = e["year"]
            v["vin"] = e["vin"]
            v["odometer"] = e["odometer_km"]
            v["engineHours"] = e["engine_hours"]
            v["driver_name"] = e["driver_name"]
            v["fuel_type"] = e["fuel_type"]
            v["vehicle_type"] = e["vehicle_type"]
            v["color"] = e["color"]
            v["department"] = e["department"]
        enriched.append(v)
    return enriched
