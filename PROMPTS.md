# AI Prompts Used During Development

This document captures the key AI prompts and conversations used to build Fleet Command Center, as required by the Geotab Vibe Coding Competition 2026.

## Development Tool

All development was done using **Claude Code** (Anthropic's CLI for Claude), powered by **Claude Opus 4.6**. Claude Code acts as an autonomous software engineering agent — reading files, writing code, running tests, and iterating based on results.

## Phase 1: Core MCP Server + Dashboard

### Initial Architecture
> "Build an MCP server that connects to the Geotab MyGeotab API. I need tools for getting vehicles, locations, trips, faults, zones, drivers, and fuel data. Use the mygeotab Python SDK. Also add DuckDB caching so data can be queried with SQL."

### Google Maps Dashboard
> "Add a Flask web dashboard with Google Maps showing all vehicle positions in real-time. Dark theme, glass morphism styling. Auto-refresh every 10 seconds. Click a vehicle to see details. Show fleet stats in a sidebar."

### Gemini AI Integration
> "Add a Gemini AI client that can analyze fleet data. Support efficiency, safety, maintenance, route optimization, and cost analysis types. Also add a chat interface with function calling so Gemini can call Geotab tools directly from the chat."

### Chat Function Calling
> "The Gemini chat should support function calling — when a user says 'create a geofence around the warehouse' or 'send a message to truck 5', Gemini should call the appropriate Geotab API function (create_zone, send_text_message) and report the result back."

## Phase 2: Fleet Command Features

### Geotab Ace AI
> "Add Geotab Ace AI integration. Ace AI is Geotab's native fleet analytics AI — we need it for judging criteria. Add an /api/ace endpoint that forwards natural language questions to the Ace AI and returns the answer."

### Fleet KPI Dashboard
> "Add fleet KPI cards to the dashboard — total distance, trips, idle %, driving hours, max speed, exceptions. Use trip data sampled from 5 vehicles to avoid rate limits, then scale up estimates to the full fleet."

### Activity Heatmap
> "Add a heatmap toggle to the map. Use Google Maps HeatmapLayer. The trip stop points all land at the same depot — instead, generate dense activity clusters from actual vehicle GPS positions with gaussian spread, corridor points between vehicle pairs, and hot-spot hubs. Zero extra API calls. Deterministic seed for stable rendering."

### Executive Report
> "Add a Report button that generates an executive fleet report. Query Ace AI for fleet insights, then send all data to Gemini with a prompt to generate styled HTML. Sections: Executive Summary, Fleet Overview, Top Performers, Anomalies, Ace AI Insights, Recommendations. Show in a modal."

### Trip Replay
> "Add animated trip replay. When you click a trip's play button, fetch GPS LogRecords for that time range, draw a speed-colored polyline path, and animate a marker along it. Add play/pause/speed controls and a slider. Show a live telemetry HUD with speed, acceleration, distance, elapsed time."

### Toast Notifications
> "Add a toast notification system for user feedback. Show success/error/info/warning toasts when zones are created, messages are sent, reports generate, heatmap loads, etc. Stack them, auto-dismiss after 4 seconds."

## Phase 3: Caching + Rate Limits

### TTL Cache Layer
> "I'm hitting Geotab API rate limits. Add a TTL-based in-memory cache to all dashboard API routes. Vehicles 60s, locations 30s, trips 5min, zones 5min, faults 2min. Add a batch location fetcher that gets ALL DeviceStatusInfo in 1 API call instead of N+1 per vehicle. Cross-endpoint cache sharing so /api/status reuses vehicle/location/fault caches."

### Rate Limit Sampling
> "The KPI and heatmap endpoints are calling get_trips for all 50 vehicles — that's 50 API calls instantly. Sample only 5 random vehicles and scale up estimates. Delay KPI load by 3 seconds after page load."

## Phase 4: Polish + Enrichment

### SQLite Vehicle Enrichment
> "The Demo_VCDataset vehicles are named 'Demo - 01' through 'Demo - 50' with blank make/model/year/VIN. Create a SQLite enrichment layer that overlays realistic Canadian mixed fleet data — 15 vans (Ford Transit, Mercedes Sprinter, RAM ProMaster), 12 pickups (F-150, Sierra, Silverado), 8 sedans (Civic, Camry), 8 SUVs (RAV4, Equinox), 4 EVs (Tesla Model 3, Bolt, ID.4, Lightning), 3 heavy trucks (Hino, F-550, Isuzu NPR). Include driver names, departments, odometers, engine hours, VINs. Toggle on/off via API."

### Detail Panel Ghosting Fix
> "There's visual ghosting when the vehicle detail panel opens over the KPI cards. The backdrop-filter blur on both the sidebar and detail panel creates overlapping compositing layers."

Resolution: Replaced semi-transparent background with fully opaque `--bg-panel`, added `isolation: isolate` and `will-change: transform`.

### Map View Controls
> "Add Lock View (prevent auto-pan on data refresh), Solo Mode (show only selected vehicle's marker), and Fit All (zoom to show entire fleet) buttons to the map controls."

### Report Export
> "The report modal has no save or export. Add Print, Save HTML, and Save PDF buttons. Save HTML should download a standalone file with embedded styles. Save PDF uses window.print() with a clean print-friendly layout."

### Voice Input
> "Add voice input to the chat using Web Speech API. Show interim transcription, auto-send on final result. Add TTS for short AI responses."

## Key Design Decisions Made via AI Prompts

1. **Batch location fetching** instead of per-vehicle API calls — prompted by rate limit errors
2. **5-vehicle sampling with scale-up** for KPIs/heatmap — balance between data accuracy and API limits
3. **Deterministic RNG seed** for heatmap — stable rendering across page refreshes
4. **Enrichment toggle** — clean fallback to API-only mode for honesty/transparency
5. **Function calling in chat** — Gemini can create zones and send messages, not just answer questions
6. **Opaque panel backgrounds** — eliminated glassmorphism ghosting on compositing layers

## Tools and Models Used

| Tool | Purpose |
|------|---------|
| Claude Code (Claude Opus 4.6) | Primary development agent — architecture, code, debugging, iteration |
| Google Gemini AI | Fleet data analysis, executive report generation, chat function calling |
| Geotab Ace AI | Fleet-native natural language analytics |
| Google Maps JavaScript API | Vehicle tracking, heatmap, zone overlays, trip replay |
| Google Geocoding API | Address-to-coordinates for geofence creation |
