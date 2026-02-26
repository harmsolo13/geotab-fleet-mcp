# GeotabVibe Demo Narration Script

**Total runtime: ~3 minutes**
Read each line when the timestamp matches. Pause briefly between sections.
The on-screen demo label will guide your timing — wait for the UI to transition before speaking.

---

## How to Run

**Recommended (on camera):** Open the chat panel, click the mic button, and say **"Play the demo"**.
The assistant responds and the demo launches — this showcases voice control as the very first thing.

**Alternatives:**
- Type "play the demo" in the chat input
- URL: `http://localhost:5030/?demo=1`
- Console: `runDemo()`

**To stop:** Say or type "stop demo", or call `stopDemo()` in console.

---

## Script

### [Before 0:00] Trigger (you do this on camera)
> *Click the mic button on the chat panel, then say:*
> "Play the demo"
> *The assistant responds: "Starting the Fleet Command Center demo..."*
> *Wait for the demo to begin (~1.5 seconds)*

### [0:00] Opening
> "This is GeotabVibe — a Fleet Command Center built on the Geotab SDK with Google Maps and Gemini AI. As you just saw, we can control everything by voice. Let's take a tour."

### [0:05] Fleet Overview
> "The dashboard connects to a live Geotab fleet and renders every vehicle on the map in real time. On the left, you can see fleet stats — total vehicles, how many are moving, stopped, and active faults."

### [0:12] KPIs
> "Below that, fleet KPIs are aggregated from trip data — total distance, trip count, idle percentage, driving hours, top speed, and exception events. These update every 60 seconds."

### [0:18] Vehicle Selection
> "Clicking a vehicle — either on the map or in the sidebar — opens a detail panel with driver info, department, make and model, VIN, odometer, engine hours, and recent trip history."

### [0:25] Detail Panel
> "The detail panel shows enriched data — driver names, departments, vehicle types — overlaid on live Geotab API data. Active faults for this vehicle are listed with diagnostic codes."

### [0:33] Trip Replay
> "Each trip has a replay button. This loads the raw GPS log records and draws a speed-colored path on the map. Green is slow, yellow is cruising, red is high speed."

### [0:38] Replay HUD
> "The replay plays at 5x speed with a heads-up display — real-time speed, acceleration, cumulative distance, elapsed time, average and max speed. All pre-computed for smooth 60fps playback."

### [0:55] Speed Coloring
> "You can pause, scrub, and change playback speed. The marker and path segments update color instantly based on the vehicle's speed at each GPS point."

### [1:02] Activity Heatmap
> "The activity heatmap visualizes fleet density using vehicle positions with weighted clusters — showing depot areas, route corridors, and hotspot hubs across the fleet's operating area."

### [1:12] Fleet Report
> "The Report button opens a slideout panel. It queries Geotab's Ace AI for fleet insights, then passes the data to Gemini to generate a styled HTML executive report."

### [1:25] Report Content
> "The report includes an executive summary, fleet overview with KPIs, top performers, anomalies and concerns, Ace AI analysis displayed verbatim, and actionable recommendations."

### [1:38] Report Actions
> "You can print the report, save it as HTML, or export to PDF — all from the action buttons at the top. The report caches for 5 minutes to avoid repeated API calls."

### [1:48] User Guide
> "Switching to the Guide tab loads the full documentation inside the same slideout panel. No need to leave the dashboard — everything stays in context."

### [1:55] Pop-out
> "The pop-out button opens either the report or the guide in a standalone browser tab for sharing or printing separately."

### [2:00] Fleet Assistant
> "The Fleet Assistant is a conversational AI powered by Gemini with function calling. It has access to 12 Geotab API tools — vehicles, trips, faults, drivers, zones, fuel transactions, exceptions, and Ace AI."

### [2:08] Chat Query
> "Asking 'which vehicles are moving right now' triggers a function call to the Geotab API. Gemini retrieves the data, analyzes it, and responds conversationally with specific vehicle names and speeds."

### [2:22] Action Commands
> "The assistant can also take actions. Asking it to create a geofence triggers a zone creation function call. The zone appears on the map immediately with a toast notification."

### [2:35] Solo Mode
> "Solo mode isolates a single vehicle — hiding all other markers from the map. Useful for focused tracking during operations or incident review."

### [2:42] Theme Toggle
> "The dashboard supports light and dark themes. The map styles, sidebar, panels, and all components adapt seamlessly. Theme preference persists across sessions."

### [2:52] Final View
> "Fit All brings every vehicle back into view. That's GeotabVibe — real-time fleet visualization, AI-powered analysis, conversational control, and trip replay — all in one dashboard. Thank you."

---

## Tips for Recording

1. **Screen resolution**: Record at 1920x1080 for best quality
2. **Browser**: Chrome with no extensions visible (use incognito or a clean profile)
3. **Audio**: Record narration separately if possible, then sync in editing
4. **Timing**: The demo labels on screen will guide your pace — if you're ahead, pause; if behind, skip a sentence
5. **Fallback**: If the Gemini API is rate-limited, the report will use a fallback template — still looks good
6. **Stop anytime**: Call `stopDemo()` in console or refresh the page
