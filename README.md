# Geotab Fleet MCP Server

**Conversational fleet management powered by Model Context Protocol + Google Maps + Gemini AI**

> Talk to your fleet. Ask questions in plain English, get real-time answers from your Geotab telematics data — with a live Google Maps dashboard and AI-powered fleet analysis.

Built for the [Geotab Vibe Coding Competition 2026](https://luma.com/h6ldbaxp).

## The Problem

Fleet managers juggle multiple dashboards, reports, and interfaces to answer simple questions: *"Which truck has the worst fuel efficiency?"*, *"Are there any active fault codes?"*, *"How did our drivers score on safety this week?"*

Out of 776+ solutions in the Geotab Marketplace, **zero** offer a conversational AI interface. Fleet managers are stuck clicking through menus instead of just asking.

## The Solution

An MCP (Model Context Protocol) server that connects any AI assistant — Claude, GPT, or any MCP-compatible client — directly to your Geotab fleet data. Ask questions in natural language, get instant answers.

Plus: a **live Google Maps dashboard** showing vehicle positions in real-time, and **Google Gemini AI** as a subordinate fleet analyst for deep data insights.

```
You: "Show me all vehicles in my fleet"
AI:  Here are your 47 vehicles... [table with VIN, make, model, odometer]

You: "Which one has the worst fuel efficiency this month?"
AI:  Vehicle 'Truck-23' averaged 4.2 MPG, significantly below fleet average of 6.8 MPG.

You: "Create a geofence around 123 Main St, Toronto"
AI:  Geocoded address → Created zone 'Main St Depot' with 500m radius. ✓

You: "Ask Gemini to analyze the safety data"
AI:  [Gemini analysis] Key findings: 3 drivers with declining scores...
```

## Architecture

```
User ←→ Claude (MCP Client)
              |
         MCP Server (FastMCP, stdio)
              |
    +---------+---------+----------+-----------+
    |         |         |          |           |
 Geotab   OData DC   DuckDB   Gemini AI   Google
  API     (KPIs)     Cache    (analysis)   Geocoding
    |                                        |
    +------------ Flask Web Dashboard -------+
                   (Google Maps JS API)
                   Port 5030
```

## Tools (20 MCP Tools)

| Category | Tool | Description |
|----------|------|-------------|
| **Utility** | `test_connection` | Validate API connectivity |
| **Fleet Overview** | `get_fleet_vehicles` | List all vehicles with status/VIN/odometer |
| | `get_vehicle_details` | Deep dive on one vehicle |
| | `get_fleet_drivers` | List all drivers |
| | `get_zones` | List all geofences |
| **Real-Time** | `get_vehicle_location` | Current GPS + speed |
| | `get_active_faults` | Active DTCs across fleet |
| **History** | `get_trip_history` | Trips with distance/duration/speed |
| | `get_fuel_analysis` | Fuel transactions and costs |
| | `get_exception_events` | Rule violations |
| **KPIs** | `get_safety_scores` | Driver safety via Data Connector |
| | `get_fleet_kpis` | Daily fleet KPIs via Data Connector |
| **Actions** | `create_geofence` | Create zones from coordinates |
| | `send_message` | Text message to in-cab device |
| **Analytics** | `query_fleet_data` | SQL over cached DuckDB data |
| | `list_cached_datasets` | Show cached tables |
| | `export_data` | Export to JSON/CSV |
| **Google AI** | `gemini_analyze` | Delegate fleet data analysis to Gemini AI |
| **Google Maps** | `geocode_address` | Convert address to GPS coordinates |
| | `create_geofence_from_address` | One-shot geofence from street address |

## Quick Start

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/geotab-fleet-mcp.git
cd geotab-fleet-mcp
pip install -e .
```

### 2. Configure Credentials

```bash
cp .env.example .env
# Edit .env with your credentials:
# GEOTAB_DATABASE=your_database
# GEOTAB_USERNAME=your_email@example.com
# GEOTAB_PASSWORD=your_password
# GEOTAB_SERVER=my.geotab.com
# GEMINI_API_KEY=your_gemini_key
# GOOGLE_MAPS_API_KEY=your_maps_key
```

**API keys needed:**
- **Geotab**: MyGeotab account credentials
- **Gemini AI**: Get key at [Google AI Studio](https://aistudio.google.com/apikey)
- **Google Maps**: Get key at [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — enable **Maps JavaScript API** + **Geocoding API**

### 3. Run the MCP Server

```bash
# With Claude Desktop
# Add to claude_desktop_config.json:
{
  "mcpServers": {
    "geotab-fleet": {
      "command": "python",
      "args": ["-m", "geotab_mcp.server"],
      "cwd": "/path/to/geotab-fleet-mcp/src"
    }
  }
}

# With Claude Code
claude mcp add geotab-fleet -- python -m geotab_mcp.server

# With MCP inspector
mcp dev src/geotab_mcp/server.py
```

### 4. Run the Dashboard

```bash
# Start the Google Maps dashboard on port 5030
python -m geotab_mcp.dashboard

# Or use the CLI entry point
geotab-dashboard
```

Open [http://localhost:5030](http://localhost:5030) to see the live fleet map.

## Google Maps Dashboard

The web dashboard provides a live visualization of your fleet:

- **Real-time vehicle markers** on Google Maps with status colors (green=moving, grey=stopped, red=fault)
- **Auto-refresh** every 10 seconds — watch vehicles move in real time
- **Click any vehicle** to see details: VIN, odometer, trips, active faults
- **Geofence overlays** showing configured zones
- **Trip route visualization** with polyline overlays
- **Fleet stats bar**: total vehicles, moving, stopped, fault counts
- **Vehicle search** and fault list in the sidebar
- **Dark theme** with glass-morphism styling

## Gemini AI Integration

The `gemini_analyze` MCP tool enables **multi-AI orchestration**: Claude fetches the data, then delegates analysis to Google Gemini.

Analysis types:
- `efficiency` — fuel efficiency, idle time, driving patterns
- `safety` — driver scores, harsh events, speeding
- `maintenance` — fault codes, predictive maintenance
- `route_optimization` — trip analysis, distance reduction
- `cost` — operating cost analysis, cost reduction
- `general` — comprehensive fleet health overview

Example workflow:
```
1. Claude: get_fleet_vehicles() → 47 vehicles
2. Claude: get_fleet_kpis() → daily KPI data
3. Claude: gemini_analyze(kpi_data, "efficiency") → Gemini's analysis
4. Claude presents combined insights to user
```

## Demo Scenarios

Try these conversations with your AI assistant:

1. **Fleet overview**: *"Show me all vehicles in my fleet and their current status"*
2. **Fuel analysis**: *"Which vehicle has the worst fuel efficiency this month?"*
3. **Safety check**: *"Compare driver safety scores for the past 30 days"*
4. **Diagnostics**: *"What are the active fault codes across my fleet?"*
5. **Natural language geofencing**: *"Create a geofence called 'Depot' around 123 Main St, Toronto"*
6. **AI analysis**: *"Get the fleet KPIs and ask Gemini to analyze efficiency trends"*
7. **SQL analytics**: *"Query the cached trip data — what's the average daily distance per vehicle?"*

## How It Works

1. **MCP Protocol**: The server exposes tools via the Model Context Protocol (stdio transport), making it compatible with any MCP client.

2. **Dual Data Sources**:
   - **MyGeotab JSON-RPC API** via `mygeotab` SDK — real-time vehicle data, trips, faults, zones
   - **Data Connector OData v4** — pre-aggregated KPIs, safety scores, fleet analytics

3. **Auto-Caching**: Every API response is automatically cached in a local DuckDB database. This enables:
   - SQL queries over fleet data for ad-hoc analysis
   - Reduced API calls on follow-up questions
   - Cross-dataset joins (e.g., correlate trips with fuel data)

4. **Google Gemini AI**: Fleet data can be delegated to Gemini for expert analysis — efficiency scoring, safety evaluation, maintenance predictions, and route optimization.

5. **Google Maps Dashboard**: A Flask web app serves a live Google Maps view of the fleet with real-time vehicle positions, geofence overlays, and interactive detail panels.

6. **Google Geocoding**: Natural language geofence creation — say an address, get a zone.

## Tech Stack

- **Python 3.10+**
- **FastMCP** (`mcp` package) — MCP server framework
- **mygeotab** — Official Geotab Python SDK
- **httpx** — HTTP client for Data Connector OData + Google Geocoding APIs
- **DuckDB** — Embedded analytical database for caching
- **Flask** — Web dashboard backend
- **Google Maps JavaScript API** — Live fleet map
- **Google Geocoding API** — Address-to-coordinates conversion
- **Google Gemini AI** (`google-genai`) — Fleet data analysis
- **Pydantic** — Data validation
- **python-dotenv** — Environment configuration

## Development

```bash
# Install in development mode
pip install -e ".[dev]"

# Test the MCP server
python -m geotab_mcp.server

# Test the dashboard
python -m geotab_mcp.dashboard

# Use MCP inspector
mcp dev src/geotab_mcp/server.py
```

## License

MIT

## Competition

Built for the [Geotab Vibe Coding Competition 2026](https://luma.com/h6ldbaxp). Targeting:
- **Vibe Master** ($10K) — Best overall solution
- **Innovator** ($5K) — Technical creativity + AI application
- **Best Use of Google Tools** ($2.5K) — Google Maps dashboard, Gemini AI analysis, Google Geocoding
- **Most Collaborative** ($2.5K) — Open-source community engagement
