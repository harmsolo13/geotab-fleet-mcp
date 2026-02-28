# GeotabVibe Demo Narration Script

**Total runtime: ~3 minutes**
The demo is fully automated with TTS narration. Each step speaks, shows an overlay label, executes the UI action, and advances automatically. Chat queries are voice-triggered with mic pulse and typewriter animation.

---

## How to Run

**Recommended (on camera):** Open the chat panel, click the mic button, and say **"Play the demo"**.
The assistant responds and the demo launches — this showcases voice control as the very first thing.

**Alternatives:**
- Type "play the demo" in the chat input
- URL: `http://localhost:5030/?demo=1`
- Console: `runDemo()`

**To stop:** Say or type "stop demo", or call `stopDemo()` in console.

**Pre-record voices:** Run `demoWarmUp()` in console before first demo to pre-record all narrator MP3s (takes ~60 seconds). Lines persist on disk across restarts.

---

## Script

### [Before 0:00] Trigger (you do this on camera)
> *Click the mic button on the chat panel, then say:*
> "Play the demo"
> *The assistant responds: "Starting the Fleet Command Center demo..."*
> *Wait for the demo to begin (~1.5 seconds)*

### [0:00] Opening — Fleet Command Center
> "Thank you. This is GeotabVibe — a Fleet Command Center built on the Geotab SDK with Google Maps and Gemini AI. It also includes an MCP server, allowing any AI assistant to connect and manage the fleet through natural language. As you just saw, we can control everything by voice. Let's take a tour."

*Map fits all vehicles into view.*

### [0:10] Fleet Overview
> "The dashboard connects to a live Geotab fleet — and renders every vehicle on the map in real time. On the left, you can see fleet stats — total vehicles, how many are moving, stopped, and active faults."

### [0:18] KPIs
> "Below that, fleet KPIs are aggregated from trip data — total distance, trip count, idle percentage, driving hours, top speed, and exception events. These update every 60 seconds."

### [0:25] Vehicle Selection
> "Clicking a vehicle — either on the map or in the sidebar — opens a detail panel with driver info, department, make and model, VIN, odometer, engine hours, and recent trip history."

*Selects a moving vehicle.*

### [0:32] Detail Panel
> "The detail panel shows enriched data — driver names, departments, vehicle types — overlaid on live Geotab API data. Active faults for this vehicle are listed with diagnostic codes."

### [0:38] Solo Mode ON
> "We're entering Solo Mode to focus on this single vehicle during replay. Solo Mode hides all other fleet markers, but we can toggle it off at any time to see the full fleet."

*Solo Mode activates — all other markers disappear.*

### [0:45] Trip Replay
> "Each trip has a replay button. This loads the raw GPS log records and draws a speed-colored path on the map. Green is slow, yellow is cruising, red is high speed."

*Trip replay loads and pauses at start.*

### [0:50] Replay HUD
> "The replay plays at 5 times speed with a heads-up display — real-time speed, acceleration, cumulative distance, elapsed time, average and max speed. All pre-computed for smooth playback."

*Playback starts at 5x speed with HUD visible.*

### [1:00] Speed Coloring
> "You can pause, scrub, and change playback speed. The marker and path segments update color instantly based on the vehicle's speed at each GPS point."

*Replay pauses.*

### [1:05] Solo Mode OFF
> "And here we toggle Solo Mode off, bringing all fleet vehicles back into view."

*Solo Mode deactivates — all fleet markers reappear.*

### [1:10] Activity Heatmap
> "The activity heatmap visualizes fleet density using vehicle positions with weighted clusters — showing depot areas, route corridors, and hotspot hubs across the fleet's operating area."

*Replay closes, heatmap activates.*

### [1:18] Heatmap Commentary
> "Bright spots indicate depot areas and frequent stops. The gradient trails reveal common route corridors and delivery clusters. This uses real trip stop data from the fleet."

### [1:25] Fleet Report
> "Now let's generate the fleet report. This queries Geotab's Ace AI for fleet insights, then passes the data to Gemini 3 to generate a styled executive report."

*Heatmap off, slideout panel opens with report loading.*

### [1:30] Resizable Panel
> "Note we have resized the panel to allow the report to be viewed easier. The slide out panel is fully resizable by dragging the left edge. This works for both the report and the guide."

*Panel resizes to 650px.*

### [1:35] Generating Report...
*Waits silently for report to complete (up to 90 seconds).*

### [1:45] Report Content
> "The report includes an executive summary, fleet overview with KPIs, top performers, anomalies and concerns, Ace AI analysis, and actionable recommendations."

### [1:52] Report Actions
> "You can print the report, save it as HTML, or export to PDF — all from the action buttons at the top."

*Report scrolls through.*

### [2:00] User Guide
> "Switching to the Guide tab loads the complete user guide inside the same slide out panel — covering every feature, control, and keyboard shortcut. No need to leave the dashboard."

### [2:07] Guide Sections
> "The guide covers fleet stats, KPIs, map controls, vehicle detail panel, trip replay, reports, the chat assistant, themes, and tips. Everything stays in context."

*Guide scrolls through.*

### [2:14] Pop-out
> "The pop-out button opens either the report or the guide in a standalone browser tab for sharing or printing separately."

### [2:18] Transition
> "Ok, let's try it and take a look at the responses."

*Slideout closes.*

### [2:22] Fleet Assistant
> "The Fleet Assistant is a conversational AI powered by Gemini with function calling. It has access to 12 Geotab API tools — vehicles, trips, faults, drivers, zones, fuel transactions, exceptions, and Ace AI."

*Chat panel opens.*

### [2:28] Chat Query 1: Moving Vehicles
> "Asking 'which vehicles are moving right now' triggers a function call to the Geotab API. Gemini retrieves the data and responds conversationally with specific vehicle names and speeds."

*Mic button pulses red. Text typewriters into input: "Which vehicles are moving right now?" Then sends.*

**[Waiting for AI response...]**

> *Result narration:* "The assistant retrieved live fleet data and responded with the vehicles currently in motion, including their names and speeds in kilometres per hour."

### [2:40] Chat Query 2: Speeding Violations
> "Now asking about speeding violations. This calls the exception events API to retrieve rule violations from the fleet."

*Mic pulses. Typewriter: "Any speeding violations this week?" Sends.*

**[Waiting for AI response...]**

> *Result narration:* "The assistant queried exception events and returned the speeding violations found this week, including the rule names and vehicle details."

### [2:52] Chat Query 3: Send Message
> "The assistant can send messages directly to in-cab devices. This triggers a text message function call to the vehicle's Geotab GO device."

*Mic pulses. Typewriter: "Send a message to Demo - 01 saying please return to depot" Sends.*

**[Waiting for AI response...]**

> *Result narration:* "Message sent successfully. The text was delivered directly to the vehicle's in-cab Geotab device via the API."

### [3:04] Chat Query 4: Create Geofence
> "Finally, asking it to create a geofence triggers a zone creation function call. The zone appears on the map immediately."

*Mic pulses. Typewriter: "Create a geofence called Fleet Operations Zone at 43.52, -79.69 with a 2km radius" Sends.*

**[Waiting for AI response...]**

> *Result narration:* "The geofence was created and is now visible on the map as a large red zone boundary covering the fleet's operating area. This was a live API call to the Geotab platform."

### [3:16] Theme Toggle
> "The dashboard supports light and dark themes. The map styles, sidebar, panels, and all components adapt seamlessly."

*Toggles to light theme, pauses, toggles back to dark.*

### [3:25] Final View
> "That's GeotabVibe — real-time fleet visualization, AI-powered analysis, conversational control, and trip replay — all in one dashboard. All actions were completed live by the AI while recording and running this demo. This demo can be triggered at any time by saying 'play the demo' in the chat. Thank you for watching."

*Map fits all vehicles.*

---

## Tips for Recording

1. **Screen resolution**: Record at 1920x1080 for best quality
2. **Browser**: Chrome with no extensions visible (use incognito or a clean profile)
3. **Pre-warm**: Run `demoWarmUp()` in console first to pre-record all TTS lines
4. **Pre-cache API**: Load the dashboard and let it run for ~30 seconds before starting — this warms the SQLite cache so demo queries are instant
5. **Timing**: The demo is fully automated — narration drives the pace. Total runtime depends on AI response times (~3-4 minutes)
6. **Fallback**: If a Gemini API call fails, the demo advances after the timeout (90 seconds max per waitFor)
7. **Stop anytime**: Call `stopDemo()` in console or refresh the page
8. **Multiple takes**: The demo is idempotent — run it multiple times. Note: each run creates a new geofence zone
