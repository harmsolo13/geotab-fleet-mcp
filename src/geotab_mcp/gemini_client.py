"""Google Gemini AI client for fleet data analysis and conversational chat."""

from __future__ import annotations

import json
import os
from datetime import date

from google import genai
from google.genai import types as genai_types

from geotab_mcp import api_tracker
from geotab_mcp.utils import circle_points

SYSTEM_PROMPT = (
    "You are an expert fleet management analyst working with Geotab telematics data. "
    "Analyze the provided fleet data and give actionable insights. "
    "Focus on: efficiency trends, safety concerns, maintenance predictions, "
    "cost optimization, and route improvements. "
    "Be concise but thorough. Use specific numbers from the data. "
    "Structure your response with: Key Findings, Anomalies, and Recommendations."
)

CHAT_SYSTEM_PROMPT = (
    "You are a helpful fleet management assistant for a Geotab-connected fleet. "
    "Today's date is {today}. "
    "You have access to real-time fleet data through function calls. "
    "Use these tools to answer questions about vehicles, trips, faults, drivers, zones, "
    "fuel transactions, and exception events. "
    "Be conversational and concise. Use specific numbers from the data. "
    "Always use metric units — km, km/h, litres, hours. Never use miles, mph, or gallons. "
    "If a question is ambiguous, make reasonable assumptions and state them. "
    "Format responses for easy reading — use short paragraphs, not markdown headers. "
    "IMPORTANT: Use the minimum number of tool calls needed. One tool call is usually enough. "
    "Summarise the data you already have rather than making additional calls."
)

# ── Geotab Tool Declarations for Gemini Function Calling ────────────────

_GEOTAB_TOOLS = [
    genai_types.FunctionDeclaration(
        name="get_vehicles",
        description="Get all vehicles in the fleet with basic info (name, VIN, make, model, year, odometer, engine hours). Use to answer questions about fleet size, vehicle inventory, or to find a specific vehicle.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Max vehicles to return (default 500)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_vehicle_details",
        description="Get detailed information for a single vehicle by its device ID. Use when the user asks about a specific vehicle.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "The Geotab device ID"},
            },
            "required": ["device_id"],
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_vehicle_location",
        description="Get real-time GPS location, speed, and bearing for a single vehicle. Use to answer 'where is vehicle X?'.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "The Geotab device ID"},
            },
            "required": ["device_id"],
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_fleet_status",
        description=(
            "Get ALL vehicles with their real-time GPS location, speed, and communication status in ONE call. "
            "Use this to answer fleet-wide questions like 'which vehicles are moving?', 'how many are idle?', "
            "'show me the fleet status'. Returns every vehicle with lat/lng, speed (km/h), bearing, and whether "
            "it is currently communicating. Much more efficient than calling get_vehicle_location per vehicle."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Max vehicles to return (default 500)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_trips",
        description="Get trip history for a vehicle including distance, duration, speed, and stop points. Defaults to last 7 days.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "The Geotab device ID"},
                "from_date": {"type": "STRING", "description": "Start date ISO format (optional, default 7 days ago)"},
                "to_date": {"type": "STRING", "description": "End date ISO format (optional, default now)"},
                "limit": {"type": "INTEGER", "description": "Max trips to return (default 100)"},
            },
            "required": ["device_id"],
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_faults",
        description="Get fault codes and diagnostic trouble codes (DTCs). Can filter by device. Defaults to last 7 days. Use to check vehicle health or active problems.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "Filter by device ID (optional — omit for all fleet faults)"},
                "from_date": {"type": "STRING", "description": "Start date ISO format (optional)"},
                "to_date": {"type": "STRING", "description": "End date ISO format (optional)"},
                "limit": {"type": "INTEGER", "description": "Max faults to return (default 200)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_drivers",
        description="Get all drivers in the fleet with name, employee number, and driver groups.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Max drivers to return (default 200)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_zones",
        description="Get all geofence zones with name, type, and centroid coordinates.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Max zones to return (default 200)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_fuel_transactions",
        description="Get fuel transaction records including cost, volume, and location. Can filter by device. Defaults to last 30 days.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "Filter by device ID (optional)"},
                "from_date": {"type": "STRING", "description": "Start date ISO format (optional)"},
                "to_date": {"type": "STRING", "description": "End date ISO format (optional)"},
                "limit": {"type": "INTEGER", "description": "Max records to return (default 200)"},
            },
        },
    ),
    genai_types.FunctionDeclaration(
        name="get_exception_events",
        description="Get rule violation / exception events (speeding, harsh braking, after-hours use, etc). Can filter by device. Defaults to last 7 days.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "from_date": {"type": "STRING", "description": "Start date ISO format (optional)"},
                "to_date": {"type": "STRING", "description": "End date ISO format (optional)"},
                "device_id": {"type": "STRING", "description": "Filter by device ID (optional)"},
                "limit": {"type": "INTEGER", "description": "Max events to return (default 200)"},
            },
        },
    ),
    # ace_query removed from chat tools — too slow (30s+), causes timeouts.
    # Still available via /api/ace endpoint for direct use.
    genai_types.FunctionDeclaration(
        name="create_zone",
        description=(
            "Create a new geofence zone on the map. Generates a circular zone polygon "
            "around the specified latitude/longitude. Use when the user asks to create a "
            "geofence, zone, or boundary. Example: 'Create a geofence called Depot at 43.6, -79.4'."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "name": {"type": "STRING", "description": "Name for the new zone"},
                "latitude": {"type": "NUMBER", "description": "Center latitude"},
                "longitude": {"type": "NUMBER", "description": "Center longitude"},
                "radius_m": {"type": "NUMBER", "description": "Radius in meters (default 200)"},
                "comment": {"type": "STRING", "description": "Optional comment/description"},
            },
            "required": ["name", "latitude", "longitude"],
        },
    ),
    genai_types.FunctionDeclaration(
        name="send_text_message",
        description=(
            "Send a text message to a vehicle's in-cab Geotab device. "
            "Use when the user wants to message a driver or send an alert to a vehicle."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "device_id": {"type": "STRING", "description": "The Geotab device ID to message"},
                "message": {"type": "STRING", "description": "The message text to send"},
            },
            "required": ["device_id", "message"],
        },
    ),
]

ANALYSIS_PROMPTS = {
    "efficiency": "Analyze fuel efficiency, idle time, and driving patterns. Identify the least efficient vehicles and suggest improvements.",
    "safety": "Evaluate driver safety scores, harsh events, speeding incidents, and rule violations. Flag high-risk drivers or vehicles.",
    "maintenance": "Review fault codes, diagnostic data, and vehicle health. Predict upcoming maintenance needs and prioritize urgent issues.",
    "route_optimization": "Analyze trip routes, distances, durations, and stop patterns. Suggest route optimizations to reduce distance (km) and time.",
    "cost": "Calculate fleet operating costs from fuel, maintenance, and utilization data. Identify cost reduction opportunities.",
    "general": "Provide a comprehensive fleet health overview covering efficiency, safety, maintenance, and utilization.",
}


class GeminiClient:
    """Wrapper around the Google Gemini API for fleet analytics."""

    def __init__(self) -> None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is required")
        self._client = genai.Client(api_key=api_key)
        self._model = "gemini-3-flash-preview"

    def analyze_fleet(
        self,
        data: str | dict | list,
        analysis_type: str = "general",
        question: str = "",
        max_tokens: int = 8192,
    ) -> dict:
        """Send fleet data to Gemini for analysis.

        Args:
            data: Fleet data as JSON string, dict, or list
            analysis_type: One of efficiency|safety|maintenance|route_optimization|cost|general
            question: Optional specific question to answer about the data

        Returns:
            Dict with analysis text, model used, and analysis_type
        """
        if isinstance(data, (dict, list)):
            data_str = json.dumps(data, indent=2, default=str)
        else:
            data_str = str(data)

        type_prompt = ANALYSIS_PROMPTS.get(analysis_type, ANALYSIS_PROMPTS["general"])

        user_msg = f"{type_prompt}\n\n"
        if question:
            user_msg += f"Specific question: {question}\n\n"
        user_msg += f"Fleet data:\n```json\n{data_str}\n```"

        import time as _time
        for attempt in range(3):
            try:
                t0 = _time.monotonic()
                response = self._client.models.generate_content(
                    model=self._model,
                    contents=user_msg,
                    config=genai.types.GenerateContentConfig(
                        system_instruction=SYSTEM_PROMPT,
                        temperature=0.3,
                        max_output_tokens=max_tokens,
                    ),
                )
                ms = int((_time.monotonic() - t0) * 1000)
                api_tracker.log_call("gemini", "analyze_fleet", "success", ms)
                return {
                    "analysis": response.text,
                    "model": self._model,
                    "analysis_type": analysis_type,
                    "status": "success",
                }
            except Exception as e:
                ms = int((_time.monotonic() - t0) * 1000)
                api_tracker.log_call("gemini", "analyze_fleet", "error", ms, error=str(e))
                if "429" in str(e) and attempt < 2:
                    _time.sleep(4 * (attempt + 1))
                    continue
                return {
                    "error": str(e),
                    "model": self._model,
                    "analysis_type": analysis_type,
                    "status": "error",
                }

    def summarize_fleet(self, data: str | dict | list) -> dict:
        """Quick fleet health summary."""
        if isinstance(data, (dict, list)):
            data_str = json.dumps(data, indent=2, default=str)
        else:
            data_str = str(data)

        user_msg = (
            "Give a brief fleet health summary (3-5 bullet points) covering: "
            "vehicle count & utilization, top concerns, and one actionable recommendation.\n\n"
            f"Fleet data:\n```json\n{data_str}\n```"
        )

        try:
            import time as _time
            t0 = _time.monotonic()
            response = self._client.models.generate_content(
                model=self._model,
                contents=user_msg,
                config=genai.types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.2,
                    max_output_tokens=512,
                ),
            )
            ms = int((_time.monotonic() - t0) * 1000)
            api_tracker.log_call("gemini", "summarize_fleet", "success", ms)
            return {
                "summary": response.text,
                "model": self._model,
                "status": "success",
            }
        except Exception as e:
            ms = int((_time.monotonic() - t0) * 1000)
            api_tracker.log_call("gemini", "summarize_fleet", "error", ms, error=str(e))
            return {
                "error": str(e),
                "model": self._model,
                "status": "error",
            }


class GeminiChat:
    """Conversational fleet assistant with Gemini function calling."""

    MAX_TOOL_ROUNDS = 4
    MAX_ITEMS = 20
    MAX_BYTES = 30_000

    def __init__(self, geotab_client, cache_getter=None) -> None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is required")
        self._client = genai.Client(api_key=api_key)
        self._model = "gemini-3-flash-preview"
        self._geotab = geotab_client
        self._cache_getter = cache_getter  # function(key) -> cached data or None
        self._tool_config = genai_types.Tool(function_declarations=_GEOTAB_TOOLS)

    def _get_fleet_status(self, args: dict) -> list[dict]:
        """Get all vehicles with their real-time location and speed."""
        # Reuse dashboard cache if available (avoids slow Geotab API calls)
        vehicles = None
        loc_map = None
        if self._cache_getter:
            vehicles = self._cache_getter("vehicles")
            loc_map = self._cache_getter("locations")
        if vehicles is None:
            try:
                vehicles = self._geotab.get_vehicles(limit=args.get("limit", 500))
            except Exception:
                # Fall back to DB cache when rate-limited
                vehicles = api_tracker.get_cached_response("vehicles", max_age=0)
                if vehicles is None:
                    raise
        if loc_map is None:
            try:
                loc_map = self._geotab.get_all_vehicle_locations()
            except Exception:
                loc_map = api_tracker.get_cached_response("locations", max_age=0) or {}
        result = []
        for v in vehicles:
            loc = loc_map.get(v["id"], {})
            result.append({
                "name": v.get("name", ""),
                "id": v["id"],
                "latitude": loc.get("latitude"),
                "longitude": loc.get("longitude"),
                "speed": loc.get("speed", 0),
                "bearing": loc.get("bearing"),
                "isMoving": (loc.get("speed") or 0) > 2,
                "isCommunicating": loc.get("isDeviceCommunicating", False),
            })
        return result

    def _create_zone_helper(self, args: dict) -> dict:
        """Create a geofence zone from chat — generates circle polygon."""
        lat = args["latitude"]
        lng = args["longitude"]
        radius = args.get("radius_m", 200)
        points = circle_points(lat, lng, radius_m=radius)

        zone_id = self._geotab.create_zone(
            name=args["name"],
            points=points,
            comment=args.get("comment", "Created via Fleet Assistant"),
        )
        return {
            "status": "created",
            "zone_id": zone_id,
            "name": args["name"],
            "center": {"lat": lat, "lng": lng},
            "radius_m": radius,
            "action": "zone_created",
        }

    def _truncate(self, data: list | dict) -> list | dict:
        """Truncate large results to fit within Gemini context.

        Truncates the Python list/dict *before* serializing to avoid
        slicing JSON mid-string which would produce malformed data.
        """
        if isinstance(data, list) and len(data) > self.MAX_ITEMS:
            data = data[: self.MAX_ITEMS]
        # Progressively trim list items until under byte limit
        if isinstance(data, list):
            while len(data) > 1 and len(json.dumps(data, default=str)) > self.MAX_BYTES:
                data = data[: len(data) // 2]
        elif isinstance(data, dict):
            serialized = json.dumps(data, default=str)
            if len(serialized) > self.MAX_BYTES:
                # For dicts, trim list-valued fields first
                for k, v in data.items():
                    if isinstance(v, list) and len(v) > 5:
                        data[k] = v[:5]
        return data

    def _execute_tool(self, name: str, args: dict):
        """Dispatch a function call to the GeotabClient.

        DB-first strategy for read operations: check SQLite cache before
        hitting the Geotab API.  Write operations (create_zone, send_text_message)
        always go to the API directly.
        """
        import hashlib as _hl

        # Write operations — no caching, always live
        _WRITE_OPS = {"create_zone", "send_text_message", "ace_query"}

        dispatch = {
            "get_vehicles": lambda a: self._geotab.get_vehicles(limit=a.get("limit", 500)),
            "get_vehicle_details": lambda a: self._geotab.get_vehicle_details(a["device_id"]),
            "get_vehicle_location": lambda a: self._geotab.get_vehicle_location(a["device_id"]),
            "get_fleet_status": lambda a: self._get_fleet_status(a),
            "get_trips": lambda a: self._geotab.get_trips(
                device_id=a["device_id"],
                from_date=a.get("from_date"),
                to_date=a.get("to_date"),
                limit=a.get("limit", 100),
            ),
            "get_faults": lambda a: self._geotab.get_faults(
                device_id=a.get("device_id"),
                from_date=a.get("from_date"),
                to_date=a.get("to_date"),
                limit=a.get("limit", 200),
            ),
            "get_drivers": lambda a: self._geotab.get_drivers(limit=a.get("limit", 200)),
            "get_zones": lambda a: self._geotab.get_zones(limit=a.get("limit", 200)),
            "get_fuel_transactions": lambda a: self._geotab.get_fuel_transactions(
                device_id=a.get("device_id"),
                from_date=a.get("from_date"),
                to_date=a.get("to_date"),
                limit=a.get("limit", 200),
            ),
            "get_exception_events": lambda a: self._geotab.get_exception_events(
                from_date=a.get("from_date"),
                to_date=a.get("to_date"),
                device_id=a.get("device_id"),
                limit=a.get("limit", 200),
            ),
            # ace_query removed — too slow, causes timeouts
            "create_zone": lambda a: self._create_zone_helper(a),
            "send_text_message": lambda a: self._geotab.send_text_message(
                device_id=a["device_id"],
                message=a["message"],
            ),
        }
        fn = dispatch.get(name)
        if not fn:
            return {"error": f"Unknown tool: {name}"}

        # Build a cache key for this specific tool call
        _cache_key = f"tool_{name}_{_hl.md5(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()}"

        # DB-first for read operations: return cached data instantly
        if name not in _WRITE_OPS:
            cached = api_tracker.get_cached_response(_cache_key, max_age=0)
            if cached is None:
                # Fuzzy match: same tool name, any args (different date formats etc.)
                cached = api_tracker.get_cached_response_like(f"tool_{name}_")
            if cached is not None:
                api_tracker.log_call("cache", name, "db_hit", 0, cached=True)
                return cached

        # Cache miss or write op — call the live API
        try:
            result = fn(args)
            # Wrap list results with total count before truncation
            if isinstance(result, list):
                total = len(result)
                truncated = self._truncate(result)
                final = {
                    "total_count": total,
                    "returned_count": len(truncated) if isinstance(truncated, list) else total,
                    "data": truncated,
                    "truncated": total > (len(truncated) if isinstance(truncated, list) else total),
                }
                if name not in _WRITE_OPS:
                    api_tracker.cache_response(_cache_key, final, 300)
                return final
            if isinstance(result, dict):
                result = self._truncate(result)
            if name not in _WRITE_OPS:
                api_tracker.cache_response(_cache_key, result, 300)
            return result
        except Exception as e:
            return {"error": str(e)}

    def chat(self, message: str, history: list[dict]) -> str:
        """Send a message with conversation history, returning the assistant response.

        Args:
            message: The user's new message
            history: List of {"role": "user"|"assistant", "content": str} dicts

        Returns:
            The assistant's text response
        """
        system = CHAT_SYSTEM_PROMPT.format(today=date.today().isoformat())

        # Build Gemini contents from history
        contents = []
        for entry in history:
            role = "user" if entry["role"] == "user" else "model"
            contents.append(genai_types.Content(
                role=role,
                parts=[genai_types.Part.from_text(text=entry["content"])],
            ))
        # Append the new user message
        contents.append(genai_types.Content(
            role="user",
            parts=[genai_types.Part.from_text(text=message)],
        ))

        # Function calling loop
        import time as _time
        for round_num in range(self.MAX_TOOL_ROUNDS):
            print(f"[chat] round {round_num + 1}/{self.MAX_TOOL_ROUNDS} — calling Gemini...", flush=True)
            t0 = _time.monotonic()
            response = self._client.models.generate_content(
                model=self._model,
                contents=contents,
                config=genai_types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.3,
                    max_output_tokens=2048,
                    tools=[self._tool_config],
                ),
            )
            ms = int((_time.monotonic() - t0) * 1000)
            api_tracker.log_call("gemini", "chat", "success", ms)
            print(f"[chat] round {round_num + 1} Gemini responded in {ms}ms", flush=True)

            # Check if the response contains function calls
            candidate = response.candidates[0]
            function_calls = [
                p for p in candidate.content.parts
                if p.function_call is not None
            ]

            if not function_calls:
                # No function calls — return the text response
                txt = response.text or "I couldn't generate a response."
                fr = getattr(candidate, "finish_reason", "unknown")
                print(f"[chat] done — text response ({len(txt)} chars, finish={fr})", flush=True)
                return txt

            # Append the model's response (with function calls) to contents
            contents.append(candidate.content)

            # Execute each function call and build responses
            function_responses = []
            for part in function_calls:
                fc = part.function_call
                print(f"[chat]   tool: {fc.name}({dict(fc.args) if fc.args else {}})", flush=True)
                t_tool = _time.monotonic()
                result = self._execute_tool(fc.name, dict(fc.args) if fc.args else {})
                t_tool_ms = int((_time.monotonic() - t_tool) * 1000)
                result_size = len(json.dumps(result, default=str)) if result else 0
                print(f"[chat]   tool done: {t_tool_ms}ms, {result_size} bytes", flush=True)
                function_responses.append(
                    genai_types.Part.from_function_response(
                        name=fc.name,
                        response={"result": result},
                    )
                )

            # Send function results back to Gemini
            contents.append(genai_types.Content(
                role="user",
                parts=function_responses,
            ))

        # If we exhausted iterations, return whatever text we have
        return response.text or "I retrieved the data but couldn't summarize it. Please try a more specific question."
