# AI Prompts Used During Development

This document captures the key AI prompts and conversations used to build GeotabVibe — Fleet Command Center, as required by the Geotab Vibe Coding Competition 2026.

## Development Approach

All development was done using **Claude Code** (Anthropic's CLI for Claude), powered by **Claude Opus 4.6**. Claude Code acts as an autonomous software engineering agent — reading files, writing code, running tests, debugging, and iterating based on results. Two developers worked together with Claude as the vibe coding partner, describing features in natural language and iterating conversationally through every decision.

The project evolved through 8 phases over approximately 2 weeks, from initial MCP server architecture through to a fully automated, narrated demo. Every feature was built by describing what we wanted, reviewing Claude's output, and refining through conversation.

## Phase 1: Core MCP Server + Dashboard

### Initial Architecture
> "Build an MCP server that connects to the Geotab MyGeotab API. I need tools for getting vehicles, locations, trips, faults, zones, drivers, and fuel data. Use the mygeotab Python SDK. Also add DuckDB caching so data can be queried with SQL."

This established the FastMCP server with the mygeotab SDK wrapper. We iterated on error handling, authentication flow, and the tool schema definitions.

### Google Maps Dashboard
> "Add a Flask web dashboard with Google Maps showing all vehicle positions in real-time. Dark theme, glass morphism styling. Auto-refresh every 10 seconds. Click a vehicle to see details. Show fleet stats in a sidebar."

The dashboard went through several styling iterations — the glass morphism was tricky to get right without visual ghosting on overlapping panels (fixed later in Phase 4).

### Gemini AI Integration
> "Add a Gemini AI client that can analyze fleet data. Support efficiency, safety, maintenance, route optimization, and cost analysis types. Also add a chat interface with function calling so Gemini can call Geotab tools directly from the chat."

### Chat Function Calling
> "The Gemini chat should support function calling — when a user says 'create a geofence around the warehouse' or 'send a message to truck 5', Gemini should call the appropriate Geotab API function (create_zone, send_text_message) and report the result back."

This was one of the most satisfying features to build — watching Gemini autonomously decide which Geotab API to call, execute it, and report back in natural language.

## Phase 2: Fleet Command Features

### Geotab Ace AI
> "Add Geotab Ace AI integration. Ace AI is Geotab's native fleet analytics AI — we need it for judging criteria. Add an /api/ace endpoint that forwards natural language questions to the Ace AI and returns the answer."

Ace AI uses a 3-step async pattern (submit → poll → get results) which required careful polling logic.

### Fleet KPI Dashboard
> "Add fleet KPI cards to the dashboard — total distance, trips, idle %, driving hours, max speed, exceptions. Use trip data sampled from 5 vehicles to avoid rate limits, then scale up estimates to the full fleet."

### Activity Heatmap
> "Add a heatmap toggle to the map. Use Google Maps HeatmapLayer. The trip stop points all land at the same depot — instead, generate dense activity clusters from actual vehicle GPS positions with gaussian spread, corridor points between vehicle pairs, and hot-spot hubs. Zero extra API calls. Deterministic seed for stable rendering."

### Executive Report
> "Add a Report button that generates an executive fleet report. Query Ace AI for fleet insights, then send all data to Gemini with a prompt to generate styled HTML. Sections: Executive Summary, Fleet Overview, Top Performers, Anomalies, Ace AI Insights, Recommendations. Show in a slideout panel."

### Trip Replay
> "Add animated trip replay. When you click a trip's play button, fetch GPS LogRecords for that time range, draw a speed-colored polyline path, and animate a marker along it. Add play/pause/speed controls and a slider. Show a live telemetry HUD with speed, acceleration, distance, elapsed time."

The pre-computed HUD arrays (cumulative distance, max speed, avg speed) were added after noticing the HUD was recalculating at every frame — Claude suggested pre-computing once at load time.

### Toast Notifications
> "Add a toast notification system for user feedback. Show success/error/info/warning toasts when zones are created, messages are sent, reports generate, heatmap loads, etc. Stack them, auto-dismiss after 4 seconds."

## Phase 3: Caching + Rate Limits

We hit Geotab API rate limits hard during development. This phase was entirely reactive — debugging 429 errors and iterating on caching strategies.

### TTL Cache Layer
> "I'm hitting Geotab API rate limits. Add a TTL-based in-memory cache to all dashboard API routes. Vehicles 60s, locations 30s, trips 5min, zones 5min, faults 2min. Add a batch location fetcher that gets ALL DeviceStatusInfo in 1 API call instead of N+1 per vehicle. Cross-endpoint cache sharing so /api/status reuses vehicle/location/fault caches."

### Rate Limit Sampling
> "The KPI and heatmap endpoints are calling get_trips for all 50 vehicles — that's 50 API calls instantly. Sample only 5 random vehicles and scale up estimates. Delay KPI load by 3 seconds after page load."

## Phase 4: Polish + Enrichment

### SQLite Vehicle Enrichment
> "The Demo_VCDataset vehicles are named 'Demo - 01' through 'Demo - 50' with blank make/model/year/VIN. Create a SQLite enrichment layer that overlays realistic Canadian mixed fleet data — 15 vans (Ford Transit, Mercedes Sprinter, RAM ProMaster), 12 pickups (F-150, Sierra, Silverado), 8 sedans (Civic, Camry), 8 SUVs (RAV4, Equinox), 4 EVs (Tesla Model 3, Bolt, ID.4, Lightning), 3 heavy trucks (Hino, F-550, Isuzu NPR). Include driver names, departments, odometers, engine hours, VINs. Toggle on/off via API."

### Detail Panel Ghosting Fix
> "There's visual ghosting when the vehicle detail panel opens over the KPI cards. The backdrop-filter blur on both the sidebar and detail panel creates overlapping compositing layers."

Resolution: Replaced semi-transparent background with fully opaque `--bg-panel`, added `isolation: isolate` and `will-change: transform`. This was a lesson in browser compositing — Claude identified the root cause immediately.

### Map View Controls
> "Add Lock View (prevent auto-pan on data refresh), Solo Mode (show only selected vehicle's marker), and Fit All (zoom to show entire fleet) buttons to the map controls."

### Report Export + Slideout Panel
> "The report modal has no save or export. Add Print, Save HTML, and Save PDF buttons. Save HTML should download a standalone file with embedded styles. Save PDF uses window.print(). Also replace the modal with a resizable slide-out panel that has drag handle, Report and Guide tabs, and a pop-out button."

### Voice Input
> "Add voice input to the chat using Web Speech API. Show interim transcription, auto-send on final result. Add TTS for short AI responses."

## Phase 5: Observability

### API Call Tracker
> "We burned through the Gemini free tier (20 req/day) without knowing it. No API call logging exists anywhere. Need a SQLite tracker that records every external API call so we can see quota usage, debug failures, and monitor response times. New api_tracker.py with init_db, log_call, track context manager, get_summary, get_recent. Instrument geotab_client.py (13 methods), gemini_client.py (3 methods), and _ace_call. Log cache hits in dashboard.py. Add GET /api/tracker endpoint."

## Phase 6: Persistent Cache + DB-First Architecture

After observing that every page load hammered the Geotab API, we built a persistent cache layer.

### SQLite Response Cache
> "Add a persistent SQLite response cache in api_tracker.db. All API responses should be dual-written to memory + DB. On startup, warm the in-memory cache from SQLite. Make all dashboard routes DB-first — check SQLite before hitting the Geotab API. When rate-limited or timed out, serve stale data from the DB."

### DB-First Chat Tool Dispatch
> "Chat tool dispatch should also be DB-first. When Gemini calls get_vehicles or get_faults, check SQLite cache before making a Geotab API call. Add fuzzy prefix matching for varying date argument formats."

This reduced first-page-load from ~15 API calls to zero. All 14 cached entries load from SQLite on startup.

### Cache Force Refresh
> "The ?refresh=1 param clears in-memory cache but the DB-first path still returns stale SQLite data. Fix _cache_force to also clear the DB cache entry so force refresh actually works."

## Phase 7: Demo Automation + TTS Narration

This was the most ambitious phase — building a fully automated, narrated demo for the competition video.

### Demo Script Engine
> "Build a demo automation system. I need a step runner that plays narration, shows overlay labels, executes UI actions, and advances through steps. Support waitFor conditions that poll until an AI response arrives. Include result narration where the narrator summarises what the AI returned."

### Gemini Native Audio TTS
> "Use Gemini 2.5 Flash Native Audio via the Live API for text-to-speech narration. Pre-record all narrator lines as MP3s using a /api/tts/warmup endpoint. Cache MP3s on disk with MD5 hash filenames. Use a 'narrator' voice for the demo guide and 'assistant' voice for AI responses. Browser speechSynthesis as fallback for dynamic chat responses."

We learned that Gemini's Native Audio requires a system instruction like "Read this exactly: {text}" for verbatim reading — without it, the model paraphrases.

### Demo Sequence
> "Build the full demo sequence covering: opening, fleet overview, KPIs, vehicle selection, detail panel, trip replay with HUD, speed coloring, activity heatmap, fleet report generation (wait for completion), report actions, user guide, pop-out, fleet assistant chat with 4 live queries (moving vehicles, speeding violations, send message, create geofence), solo mode, theme toggle, final view."

### Client-Side Audio Pre-Caching
> "Pre-cache all narrator audio blobs in the browser on demo start. Fetch from server in parallel — pre-recorded lines return instantly from disk. Use a placeholder map to track in-flight requests and poll until they resolve."

## Phase 8: Demo Polish for Competition Video

The final iteration focused on making the demo video-ready.

### Voice-Triggered Chat Queries
> "Add a demoVoiceQuery helper. When the demo sends a chat query, it should: add a red pulse recording class to the mic button, typewriter the text into the chat input at ~40ms per character, then remove the pulse and send. Apply to all 4 chat queries."

### MCP Server Mention
> "Update the opening narration to mention the MCP server: 'It also includes an MCP server, allowing any AI assistant to connect and manage the fleet through natural language.'"

### Solo Mode Restructure
> "Move Solo Mode into the replay section. Toggle ON before trip replay starts, toggle OFF after speed coloring. Add narration for both transitions. Remove the standalone Solo Mode step later in the demo."

### Geofence Fix (4 bugs)
> "The demo geofence isn't showing on the map. Bug 1: wrong coordinates — fleet is at 43.52, -79.69 but demo creates at 43.65, -79.38. Bug 2: 200m radius too small to see. Bug 3: loadZones fetches without ?refresh=1 so DB cache returns old zone list. Bug 4: drawZones renders all zones at hardcoded 300m regardless of actual size. Fix all four."

This required changes across 4 files: demo.js (coords + radius), fleet-map.js (drawZones + loadZones), geotab_client.py (compute radius from polygon points), dashboard.py (fix cache force to clear DB too), api_tracker.py (add delete_cached_response).

### Natural Pacing
> "Add a dash for natural TTS pause in the fleet overview line. Add a transition line before the chat section: 'Ok, let's try it and take a look at the responses.'"

## Key Design Decisions Made via AI Prompts

1. **Batch location fetching** instead of per-vehicle API calls — prompted by rate limit errors
2. **5-vehicle sampling with scale-up** for KPIs/heatmap — balance between data accuracy and API limits
3. **Deterministic RNG seed** for heatmap — stable rendering across page refreshes
4. **Enrichment toggle** — clean fallback to API-only mode for honesty/transparency
5. **Function calling in chat** — Gemini can create zones and send messages, not just answer questions
6. **Opaque panel backgrounds** — eliminated glassmorphism ghosting on compositing layers
7. **DB-first cache architecture** — zero API calls on cached data, stale-serve on rate limits
8. **Pre-recorded TTS** — generate once, serve from disk forever, zero latency on playback
9. **Voice-triggered chat** — typewriter + mic pulse makes the demo feel human-driven

## Tools and Models Used

| Tool | Purpose |
|------|---------|
| Claude Code (Claude Opus 4.6) | Primary vibe coding partner — architecture, code, debugging, iteration |
| Google Gemini 3 Flash | Fleet data analysis, executive report generation, chat function calling |
| Google Gemini 2.5 Flash Native Audio | Text-to-speech narration for automated demo |
| Geotab Ace AI | Fleet-native natural language analytics |
| Google Maps JavaScript API | Vehicle tracking, heatmap, zone overlays, trip replay |
| Google Geocoding API | Address-to-coordinates for geofence creation |
| Web Speech API | Voice input + browser TTS fallback |
