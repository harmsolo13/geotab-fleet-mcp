/**
 * Fleet Map — Google Maps integration with real-time vehicle tracking
 */

let map;
let markers = {};       // device_id -> AdvancedMarkerElement
let zonePolygons = [];  // Google Maps Polygon overlays
let zoneData = [];      // Current zone data for sidebar
let suggestionCircles = []; // Preview circles for AI suggestions
let tripPolylines = []; // Google Maps Polyline overlays
let vehicles = [];      // Current vehicle data
let faults = [];        // Current fault data
let selectedVehicle = null;
let refreshTimer = null;

// Zone alert state
let zoneAlertConfig = {};    // zone_id -> {enabled, zone_name}
let vehicleZoneState = {};   // device_id -> {zone_id -> "inside"|"outside"}
let alertsInitialized = false; // Skip first cycle to establish baseline

// Chat state
let chatSessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
let chatOpen = false;
let chatSending = false;
let recognition = null;
let isRecording = false;

// Map view controls
let viewLocked = false;   // Prevents auto-pan/zoom on data refresh
let soloMode = false;     // Show only selected vehicle's marker

// Heatmap state
let heatmapLayer = null;
let heatmapVisible = false;

// Trip replay state
let replayPoints = [];
let replayMarker = null;
let replayPolyline = null;
let replayIndex = 0;
let replayPlaying = false;
let replayTimer = null;
let replaySpeedMs = 200; // ms between frames

// Pre-computed replay HUD arrays (populated in startTripReplay)
let replayCumDist = [];   // cumulative distance in metres at each point
let replayMaxSpeed = [];  // max speed seen up to each point
let replayAvgSpeed = [];  // average non-zero speed up to each point

// Stop pin markers on map (from inline waypoints)
let evStopMarkers = [];
let evStopPolylines = [];
const STOP_COLORS = ["#4a9eff", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#6366f1"];

const REFRESH_INTERVAL = 10000; // 10 seconds
const DEFAULT_CENTER = { lat: 43.6532, lng: -79.3832 }; // Toronto (Geotab HQ)
const DEFAULT_ZOOM = 12;

// ── XSS Protection ──────────────────────────────────────────────────────

function escapeHTML(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Map styling — dark theme
const MAP_STYLES_DARK = [
    { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#1a1a2e" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2a4a" }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1e1e3a" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a6a" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1525" }] },
    { featureType: "poi", elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
    { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
    { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
];

const MAP_STYLES_LIGHT = [
    { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d6e3" }] },
];

const MAP_STYLES = document.documentElement.dataset.theme === "light" ? MAP_STYLES_LIGHT : MAP_STYLES_DARK;


// ── Map Initialization ──────────────────────────────────────────────────

let mapInitialized = false;
let dataLoaded = false;

function initMap() {
    try {
        map = new google.maps.Map(document.getElementById("map"), {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            styles: MAP_STYLES,
            disableDefaultUI: false,
            zoomControl: true,
            zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            fullscreenControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
            mapId: "fleet-dashboard-map",
        });
        mapInitialized = true;
    } catch (err) {
        console.error("Map init error:", err);
    }

    // Load data (avoid double-load if fallback already started)
    if (!dataLoaded) startDataLoading();
}

function startDataLoading() {
    if (dataLoaded) return;
    dataLoaded = true;

    loadVehicles();
    loadZones();
    loadZoneAlertConfig();
    loadFaults();
    setTimeout(loadKPIs, 3000);

    // Auto-refresh cycles
    refreshTimer = setInterval(() => {
        loadVehicles();
        loadFaults();
    }, REFRESH_INTERVAL);
    setInterval(loadKPIs, 60000);
}

// Fallback: if Google Maps fails to load, still load data after 5s
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
        if (!dataLoaded) {
            console.warn("Google Maps callback not fired — loading data without map");
            startDataLoading();
        }
    }, 5000);
});


// ── Data Loading ────────────────────────────────────────────────────────

async function loadVehicles() {
    try {
        const resp = await fetch("/api/vehicles");
        const data = await resp.json();
        if (data.error) {
            console.error("Vehicle load error:", data.error);
            updateConnectionBadge(false);
            return;
        }
        vehicles = data.vehicles || [];
        updateConnectionBadge(true);
        updateMarkers();
        updateVehicleList();
        updateStats();
        checkZoneAlerts();
    } catch (err) {
        console.error("Failed to load vehicles:", err);
        updateConnectionBadge(false);
    }
}

async function loadZones(forceRefresh) {
    try {
        const url = forceRefresh ? "/api/zones?refresh=1" : "/api/zones";
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.zones) {
            drawZones(data.zones);
        } else {
            updateZoneList([]);
        }
    } catch (err) {
        console.error("Failed to load zones:", err);
    }
}

async function loadFaults() {
    try {
        const resp = await fetch("/api/faults");
        const data = await resp.json();
        faults = data.faults || [];
        updateFaultList();
    } catch (err) {
        console.error("Failed to load faults:", err);
    }
}

async function loadTrips(deviceId) {
    try {
        const resp = await fetch(`/api/vehicle/${deviceId}/trips`);
        const data = await resp.json();
        return data.trips || [];
    } catch (err) {
        console.error("Failed to load trips:", err);
        return [];
    }
}


// ── Fleet KPIs ─────────────────────────────────────────────────────────

async function loadKPIs() {
    try {
        const resp = await fetch("/api/fleet-kpis");
        const data = await resp.json();
        if (data.error) return;

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        set("kpiDistance", data.total_distance_km?.toLocaleString() || "--");
        set("kpiTrips", data.total_trips?.toLocaleString() || "--");
        set("kpiIdle", data.idle_percent != null ? data.idle_percent + "%" : "--");
        set("kpiDriving", data.total_driving_hours?.toLocaleString() || "--");
        set("kpiMaxSpeed", data.max_speed_kmh?.toLocaleString() || "--");
        set("kpiExceptions", data.total_exceptions?.toLocaleString() || "--");
    } catch (err) {
        console.error("Failed to load KPIs:", err);
    }
}


// ── Heatmap ────────────────────────────────────────────────────────────

async function loadHeatmapData() {
    try {
        const resp = await fetch("/api/heatmap-data");
        const data = await resp.json();
        if (data.error || !data.points) return;

        const heatData = data.points.map(p => ({
            location: new google.maps.LatLng(p.lat, p.lng),
            weight: p.weight,
        }));

        if (heatmapLayer) {
            heatmapLayer.setMap(null);
        }
        heatmapLayer = new google.maps.visualization.HeatmapLayer({
            data: heatData,
            radius: 30,
            opacity: 0.7,
            gradient: [
                "rgba(0, 0, 0, 0)",
                "rgba(74, 158, 255, 0.4)",
                "rgba(52, 211, 153, 0.6)",
                "rgba(251, 191, 36, 0.8)",
                "rgba(248, 113, 113, 1)",
            ],
        });
        if (heatmapVisible) {
            heatmapLayer.setMap(map);
        }
        showToast(`Heatmap loaded: ${data.count} activity points`, "info");
    } catch (err) {
        console.error("Failed to load heatmap:", err);
    }
}

function toggleHeatmap() {
    const btn = document.getElementById("heatmapToggle");
    heatmapVisible = !heatmapVisible;
    btn.classList.toggle("active", heatmapVisible);

    if (heatmapVisible) {
        if (!heatmapLayer) {
            loadHeatmapData();
        } else {
            heatmapLayer.setMap(map);
        }
    } else {
        if (heatmapLayer) heatmapLayer.setMap(null);
    }
}


// ── Map View Controls ──────────────────────────────────────────────────

function toggleViewLock() {
    viewLocked = !viewLocked;
    const btn = document.getElementById("lockViewToggle");
    btn.classList.toggle("active", viewLocked);
    showToast(viewLocked ? "Map view locked" : "Map view unlocked", "info", 2000);
}

function toggleSoloMode() {
    if (!soloMode && !selectedVehicle) {
        showToast("Select a vehicle first, then enable Solo mode", "warning", 3000);
        return;
    }
    soloMode = !soloMode;
    const btn = document.getElementById("soloModeToggle");
    btn.classList.toggle("active", soloMode);

    if (soloMode && selectedVehicle) {
        // Hide all markers except selected
        for (const id in markers) {
            markers[id].map = id === selectedVehicle ? map : null;
        }
        const vName = vehicles.find(v => v.id === selectedVehicle)?.name || selectedVehicle;
        btn.querySelector("span").textContent = "Solo: " + vName;
        showToast("Solo view — " + vName, "info", 2000);
    } else {
        // Show all markers
        for (const id in markers) markers[id].map = map;
        btn.querySelector("span").textContent = "Solo";
        showToast("Showing all vehicles", "info", 2000);
    }
}

function fitAllVehicles() {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    vehicles.forEach(v => {
        if (v.latitude && v.longitude) {
            bounds.extend({ lat: v.latitude, lng: v.longitude });
            any = true;
        }
    });
    if (any) map.fitBounds(bounds, { padding: 60 });
}


// ── Toast Notifications ────────────────────────────────────────────────

function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const icons = {
        info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add("show"));

    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, duration);
}


// ── Slideout Panel (Report + Guide) ──────────────────────────────────

let slideoutOpen = false;
let slideoutCurrentTab = "report"; // "report", "guide", or "events"
let slideoutReportHTML = null;     // cached report HTML
let slideoutGuideHTML = null;      // cached guide HTML
let slideoutEventsHTML = null;     // cached events HTML
let slideoutEventsDeviceId = null; // device ID for cached events

// ── Slideout Resize ──
(function initSlideoutResize() {
    const panel = document.getElementById("slideoutPanel");
    const handle = document.getElementById("slideoutResizeHandle");
    if (!handle || !panel) return;
    let startX, startW;
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        panel.classList.add("resizing");
        document.addEventListener("mousemove", onDrag);
        document.addEventListener("mouseup", onUp);
    });
    function onDrag(e) {
        const w = startW + (startX - e.clientX);
        const min = 320, max = window.innerWidth * 0.8;
        panel.style.width = Math.max(min, Math.min(max, w)) + "px";
    }
    function onUp() {
        panel.classList.remove("resizing");
        document.removeEventListener("mousemove", onDrag);
        document.removeEventListener("mouseup", onUp);
    }
    // Touch support
    handle.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        startX = t.clientX;
        startW = panel.offsetWidth;
        panel.classList.add("resizing");
        document.addEventListener("touchmove", onTouchDrag);
        document.addEventListener("touchend", onTouchUp);
    });
    function onTouchDrag(e) {
        const t = e.touches[0];
        const w = startW + (startX - t.clientX);
        const min = 320, max = window.innerWidth * 0.8;
        panel.style.width = Math.max(min, Math.min(max, w)) + "px";
    }
    function onTouchUp() {
        panel.classList.remove("resizing");
        document.removeEventListener("touchmove", onTouchDrag);
        document.removeEventListener("touchend", onTouchUp);
    }
})();

function openSlideout(tab = "report") {
    const panel = document.getElementById("slideoutPanel");
    slideoutOpen = true;
    // Remove hidden first to allow transition
    panel.classList.remove("hidden");
    switchSlideoutTab(tab);
}

function closeSlideout() {
    const panel = document.getElementById("slideoutPanel");
    slideoutOpen = false;
    panel.classList.add("hidden");
    document.getElementById("slideoutActions").style.display = "none";
    _clearStopPins();
}

function switchSlideoutTab(tab) {
    slideoutCurrentTab = tab;
    // Update tab active states
    document.getElementById("slideoutTabReport").classList.toggle("active", tab === "report");
    document.getElementById("slideoutTabGuide").classList.toggle("active", tab === "guide");
    document.getElementById("slideoutTabEvents").classList.toggle("active", tab === "events");

    // Show/hide report actions (only for report tab)
    const actions = document.getElementById("slideoutActions");

    // Clear stop pins when switching away from events tab
    if (tab !== "events") _clearStopPins();

    if (tab === "report") {
        if (slideoutReportHTML) {
            document.getElementById("slideoutBody").innerHTML = slideoutReportHTML;
            actions.style.display = "flex";
        } else {
            generateReport();
        }
    } else if (tab === "guide") {
        actions.style.display = "none";
        if (slideoutGuideHTML) {
            document.getElementById("slideoutBody").innerHTML = slideoutGuideHTML;
        } else {
            loadGuideContent();
        }
    } else if (tab === "events") {
        actions.style.display = "none";
        if (slideoutEventsHTML) {
            document.getElementById("slideoutBody").innerHTML = slideoutEventsHTML;
        } else {
            document.getElementById("slideoutBody").innerHTML = '<div class="ev-empty">Select a vehicle to view its event timeline</div>';
        }
    }
}

async function generateReport() {
    const body = document.getElementById("slideoutBody");
    const btn = document.getElementById("reportBtn");
    const actions = document.getElementById("slideoutActions");

    actions.style.display = "none";
    body.innerHTML = '<div class="report-loading"><div class="report-spinner"></div><p>Generating executive report...<br><small>Querying Ace AI + Gemini (may take 30-60s)</small></p></div>';
    btn.classList.add("loading");

    const minSpinner = 2500; // Show spinner for at least 2.5s so it doesn't look instant
    const spinnerStart = Date.now();

    try {
        const resp = await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const data = await resp.json();
        // Wait remaining time so spinner shows for at least minSpinner ms
        const elapsed = Date.now() - spinnerStart;
        if (elapsed < minSpinner) await new Promise(r => setTimeout(r, minSpinner - elapsed));
        btn.classList.remove("loading");

        if (data.error) {
            body.innerHTML = `<div class="report-error">Error: ${escapeHTML(data.error)}</div>`;
            showToast("Report generation failed", "error");
            return;
        }

        let html = data.html || "<p>No report content generated.</p>";
        html = html.replace(/^```html?\s*\n?/i, "").replace(/\n?```\s*$/g, "");
        body.innerHTML = html;
        slideoutReportHTML = html;
        actions.style.display = "flex";
        if (data.source === "fallback") {
            showToast("Report generated from cached data (AI unavailable)", "warning");
        } else {
            showToast("Fleet report generated successfully", "success");
        }
    } catch (err) {
        btn.classList.remove("loading");
        body.innerHTML = `<div class="report-error">Failed to reach server: ${escapeHTML(err.message)}</div>`;
        showToast("Report generation failed", "error");
    }
}

async function loadGuideContent() {
    const body = document.getElementById("slideoutBody");
    body.innerHTML = '<div class="report-loading"><div class="report-spinner"></div><p>Loading guide...</p></div>';

    try {
        const resp = await fetch("/api/guide");
        let html = await resp.text();
        // Prefix section IDs to avoid collisions with dashboard elements (e.g. id="map")
        html = html.replace(/id="([^"]+)"/g, 'id="guide-$1"');
        const content = `<div class="guide-content">${html}</div>`;
        body.innerHTML = content;
        slideoutGuideHTML = content;
    } catch (err) {
        body.innerHTML = `<div class="report-error">Failed to load guide: ${escapeHTML(err.message)}</div>`;
    }
}

function popOutSlideout() {
    if (slideoutCurrentTab === "report") {
        if (slideoutReportHTML) {
            const html = _getReportHTML();
            const win = window.open("", "_blank");
            win.document.write(html);
            win.document.close();
        } else {
            showToast("Generate a report first", "warning");
        }
    } else if (slideoutCurrentTab === "events") {
        if (slideoutEventsHTML) {
            const html = _getEventsPopoutHTML();
            const win = window.open("", "_blank");
            win.document.write(html);
            win.document.close();
        } else {
            showToast("Load vehicle events first", "warning");
        }
    } else {
        window.open("/guide", "_blank");
    }
}

function _getReportHTML() {
    const content = slideoutReportHTML || document.getElementById("slideoutBody").innerHTML;
    const timestamp = new Date().toLocaleString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fleet Executive Report — ${timestamp}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; color: #1a1d23; line-height: 1.6; }
  h1, h2, h3 { color: #2b7de9; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
  th { font-weight: 600; color: #5a6478; text-transform: uppercase; font-size: 11px; }
  .report-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #8892a8; }
</style>
</head>
<body>
${content}
<div class="report-footer">Generated ${timestamp} — Fleet Command Center powered by Geotab + Gemini AI + Ace AI</div>
</body>
</html>`;
}

function exportReportHTML() {
    const html = _getReportHTML();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fleet-report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Report saved as HTML", "success");
}

function exportReportPDF() {
    const html = _getReportHTML();
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 400);
    showToast("Print dialog opened — choose 'Save as PDF'", "info");
}

function printReport() {
    const html = _getReportHTML();
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 400);
}


// ── Trip Replay ────────────────────────────────────────────────────────

async function startTripReplay(deviceId, fromDate, toDate) {
    closeReplay(); // Clean up any existing replay
    showToast("Loading GPS trail...", "info");

    try {
        let url = `/api/vehicle/${deviceId}/trip-replay`;
        const params = [];
        if (fromDate) params.push(`from=${encodeURIComponent(fromDate)}`);
        if (toDate) params.push(`to=${encodeURIComponent(toDate)}`);
        if (params.length) url += "?" + params.join("&");

        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error || !data.points || data.points.length < 2) {
            showToast("Not enough GPS data for replay", "warning");
            return;
        }

        replayPoints = data.points;
        replayIndex = 0;

        // Pre-compute cumulative arrays for O(1) HUD updates
        replayCumDist = new Array(replayPoints.length);
        replayMaxSpeed = new Array(replayPoints.length);
        replayAvgSpeed = new Array(replayPoints.length);
        replayCumDist[0] = 0;
        replayMaxSpeed[0] = replayPoints[0].speed || 0;
        let _spdSum = replayMaxSpeed[0] > 0 ? replayMaxSpeed[0] : 0;
        let _spdCount = replayMaxSpeed[0] > 0 ? 1 : 0;
        replayAvgSpeed[0] = _spdCount > 0 ? _spdSum / _spdCount : 0;
        for (let i = 1; i < replayPoints.length; i++) {
            const spd = replayPoints[i].speed || 0;
            replayCumDist[i] = replayCumDist[i - 1] + haversine(
                replayPoints[i - 1].lat, replayPoints[i - 1].lng,
                replayPoints[i].lat, replayPoints[i].lng
            );
            replayMaxSpeed[i] = Math.max(replayMaxSpeed[i - 1], spd);
            if (spd > 0) { _spdSum += spd; _spdCount++; }
            replayAvgSpeed[i] = _spdCount > 0 ? _spdSum / _spdCount : 0;
        }

        // Draw speed-colored path segments
        replayPolyline = [];
        for (let i = 1; i < replayPoints.length; i++) {
            const prev = replayPoints[i - 1];
            const cur = replayPoints[i];
            const speed = cur.speed || 0;
            let color = "#8892a8"; // stopped
            if (speed > 0 && speed < 15) color = "#34d399"; // slow (green)
            else if (speed >= 15 && speed < 30) color = "#fbbf24"; // normal (yellow)
            else if (speed >= 30) color = "#f87171"; // fast (red)

            const seg = new google.maps.Polyline({
                map: map,
                path: [
                    { lat: prev.lat, lng: prev.lng },
                    { lat: cur.lat, lng: cur.lng },
                ],
                strokeColor: color,
                strokeWeight: 4,
                strokeOpacity: 0.85,
            });
            replayPolyline.push(seg);
        }

        // Animated marker
        const markerEl = document.createElement("div");
        markerEl.className = "replay-marker";
        markerEl.innerHTML = '<span class="replay-dot"></span>';
        replayMarker = new google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: { lat: replayPoints[0].lat, lng: replayPoints[0].lng },
            content: markerEl,
        });

        // Fit map to path
        const bounds = new google.maps.LatLngBounds();
        replayPoints.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
        map.fitBounds(bounds, { padding: 60 });

        // Show controls
        const controls = document.getElementById("replayControls");
        controls.classList.remove("hidden");
        const slider = document.getElementById("replaySlider");
        slider.max = replayPoints.length - 1;
        slider.value = 0;

        showToast(`Replay loaded: ${data.count} GPS points`, "success");
    } catch (err) {
        showToast("Failed to load replay data", "error");
    }
}

function toggleReplay() {
    if (replayPlaying) {
        pauseReplay();
    } else {
        playReplay();
    }
}

function playReplay() {
    if (replayPoints.length === 0) return;
    replayPlaying = true;
    const btn = document.getElementById("replayPlayBtn");
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

    replayTimer = setInterval(() => {
        if (replayIndex >= replayPoints.length - 1) {
            pauseReplay();
            return;
        }
        replayIndex++;
        updateReplayPosition();
    }, replaySpeedMs);
}

function pauseReplay() {
    replayPlaying = false;
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    const btn = document.getElementById("replayPlayBtn");
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
}

function seekReplay(val) {
    replayIndex = parseInt(val);
    updateReplayPosition();
}

function setReplaySpeed(val) {
    const speed = parseFloat(val);
    replaySpeedMs = Math.round(400 / speed);
    if (replayPlaying) {
        pauseReplay();
        playReplay();
    }
}

function updateReplayPosition() {
    if (!replayMarker || replayIndex >= replayPoints.length) return;
    const pt = replayPoints[replayIndex];
    replayMarker.position = { lat: pt.lat, lng: pt.lng };
    document.getElementById("replaySlider").value = replayIndex;

    // Update HUD with data
    updateReplayHUD(replayIndex);

    // Color the marker dot by speed
    const dot = replayMarker.content?.querySelector(".replay-dot");
    if (dot) {
        const speed = pt.speed || 0;
        if (speed === 0) dot.style.background = "#8892a8";
        else if (speed < 15) dot.style.background = "#34d399";
        else if (speed < 30) dot.style.background = "#fbbf24";
        else dot.style.background = "#f87171";
    }
}

function updateReplayHUD(index) {
    const hud = document.getElementById("replayHUD");
    if (!hud || replayPoints.length === 0) return;

    const pt = replayPoints[index];
    const speed = pt.speed || 0;

    // Elapsed time
    const startTime = new Date(replayPoints[0].dateTime).getTime();
    const curTime = new Date(pt.dateTime).getTime();
    const elapsedMs = curTime - startTime;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);

    // O(1) lookups from pre-computed arrays
    const distKm = (replayCumDist[index] / 1000).toFixed(2);
    const maxSpd = replayMaxSpeed[index];
    const avgSpd = replayAvgSpeed[index] > 0 ? replayAvgSpeed[index].toFixed(0) : "0";

    // Acceleration (speed delta vs previous point)
    let accel = 0;
    if (index > 0) {
        const prevSpeed = replayPoints[index - 1].speed || 0;
        const prevTime = new Date(replayPoints[index - 1].dateTime).getTime();
        const dtSec = (curTime - prevTime) / 1000;
        if (dtSec > 0) accel = ((speed - prevSpeed) / 3.6) / dtSec; // m/s²
    }

    // Timestamp display
    const timeStr = formatDateTime(pt.dateTime);

    // Speed color class
    let speedClass = "hud-speed-stopped";
    if (speed > 0 && speed < 15) speedClass = "hud-speed-slow";
    else if (speed >= 15 && speed < 30) speedClass = "hud-speed-normal";
    else if (speed >= 30) speedClass = "hud-speed-fast";

    // Accel indicator
    let accelStr = "—";
    let accelClass = "";
    if (Math.abs(accel) > 0.1) {
        accelStr = (accel > 0 ? "+" : "") + accel.toFixed(1) + " m/s²";
        accelClass = accel > 0.5 ? "hud-accel-pos" : accel < -0.5 ? "hud-accel-neg" : "";
    }

    hud.innerHTML = `
        <div class="hud-row hud-main">
            <span class="hud-speed ${speedClass}">${speed}</span>
            <span class="hud-speed-unit">km/h</span>
            <span class="hud-accel ${accelClass}">${accelStr}</span>
        </div>
        <div class="hud-row hud-stats">
            <div class="hud-stat"><span class="hud-val">${distKm}</span><span class="hud-lbl">km</span></div>
            <div class="hud-stat"><span class="hud-val">${elapsedMin}:${elapsedSec.toString().padStart(2, "0")}</span><span class="hud-lbl">elapsed</span></div>
            <div class="hud-stat"><span class="hud-val">${avgSpd}</span><span class="hud-lbl">avg km/h</span></div>
            <div class="hud-stat"><span class="hud-val">${maxSpd}</span><span class="hud-lbl">max km/h</span></div>
        </div>
        <div class="hud-row hud-time">${timeStr} &mdash; Point ${index + 1}/${replayPoints.length}</div>
    `;
}

function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function closeReplay() {
    pauseReplay();
    replayPoints = [];
    replayIndex = 0;
    replayCumDist = [];
    replayMaxSpeed = [];
    replayAvgSpeed = [];
    if (replayMarker) { replayMarker.map = null; replayMarker = null; }
    if (Array.isArray(replayPolyline)) {
        replayPolyline.forEach(seg => seg.setMap(null));
    } else if (replayPolyline) {
        replayPolyline.setMap(null);
    }
    replayPolyline = null;
    const hud = document.getElementById("replayHUD");
    if (hud) hud.innerHTML = "";
    document.getElementById("replayControls")?.classList.add("hidden");
}


// ── Map Markers ─────────────────────────────────────────────────────────

function shortName(v) {
    const name = v.name || v.id;
    // Extract "Unit XX" prefix (e.g. "Unit 01 — Ford Transit" → "Unit 01")
    const match = name.match(/^(.+?)\s*[—\-]\s*/);
    return match ? match[1].trim() : name;
}

function hoverName(v) {
    const name = v.name || v.id;
    // Extract vehicle type after dash (e.g. "Unit 01 — Ford Transit" → "Ford Transit")
    const match = name.match(/[—\-]\s*(.+)$/);
    return match ? match[1].trim() : name;
}

function updateMarkers() {
    if (!map) return; // Map not initialized yet
    const validVehicles = vehicles.filter(v => v.latitude != null && v.longitude != null);

    // Remove markers for vehicles no longer in data
    const currentIds = new Set(validVehicles.map(v => v.id));
    for (const id in markers) {
        if (!currentIds.has(id)) {
            markers[id].map = null;
            delete markers[id];
        }
    }

    // Update or create markers
    const bounds = new google.maps.LatLngBounds();
    let hasValidBounds = false;

    validVehicles.forEach(v => {
        const pos = { lat: v.latitude, lng: v.longitude };
        const status = getVehicleStatus(v);
        bounds.extend(pos);
        hasValidBounds = true;

        // Solo mode: hide all markers except the selected vehicle
        const visible = !soloMode || !selectedVehicle || v.id === selectedVehicle;

        if (markers[v.id]) {
            // Update existing marker position
            markers[v.id].position = pos;
            markers[v.id].map = visible ? map : null;
            // Update content
            const el = markers[v.id].content;
            if (el) {
                el.className = `map-marker ${status}`;
                el.querySelector(".marker-label").textContent = shortName(v); // textContent is XSS-safe
            }
        } else {
            // Create new marker
            const markerEl = document.createElement("div");
            markerEl.className = `map-marker ${status}`;
            markerEl.innerHTML = `
                <span class="marker-dot"></span>
                <span class="marker-label">${escapeHTML(shortName(v))}</span>
            `;

            const marker = new google.maps.marker.AdvancedMarkerElement({
                map: visible ? map : null,
                position: pos,
                content: markerEl,
                title: hoverName(v),
            });

            marker.addListener("click", () => selectVehicle(v.id));
            markers[v.id] = marker;
        }
    });

    // Fit map to show all markers on first load (skip if view is locked)
    if (!viewLocked && hasValidBounds && Object.keys(markers).length === validVehicles.length && !selectedVehicle) {
        map.fitBounds(bounds, { padding: 60 });
    }
}

function getVehicleStatus(vehicle) {
    // Check if vehicle has faults
    const hasFault = faults.some(f => f.deviceId === vehicle.id);
    if (hasFault) return "fault";
    // Check if moving
    if (vehicle.speed && vehicle.speed > 2) return "moving";
    if (!vehicle.isCommunicating) return "offline";
    return "stopped";
}


// ── Zone Drawing ────────────────────────────────────────────────────────

// Zone type detection + color mapping
const ZONE_COLORS = {
    depot: "#3b82f6",
    risk: "#ef4444",
    delivery: "#10b981",
    service: "#f59e0b",
    custom: "#8b5cf6",
};

function detectZoneType(zone) {
    const text = ((zone.name || "") + " " + (zone.comment || "")).toLowerCase();
    if (/depot|warehouse|hub|yard|base|hq|headquarters/.test(text)) return "depot";
    if (/speed|risk|violation|danger|accident|hazard/.test(text)) return "risk";
    if (/deliver|customer|drop|pickup|store|shop/.test(text)) return "delivery";
    if (/service|maintenance|repair|fuel|gas|charge/.test(text)) return "service";
    return "custom";
}

function drawZones(zones) {
    if (!map) return; // Map not initialized yet
    // Clear existing
    zonePolygons.forEach(p => p.setMap(null));
    zonePolygons = [];
    zoneData = [];

    zones.forEach(zone => {
        if (!zone.centroid) return;

        const zType = detectZoneType(zone);
        const color = ZONE_COLORS[zType] || ZONE_COLORS.custom;

        // Draw circle from centroid + estimated radius
        const circle = new google.maps.Circle({
            map: map,
            center: { lat: zone.centroid.y, lng: zone.centroid.x },
            radius: zone.radius || 300,
            fillColor: color,
            fillOpacity: 0.1,
            strokeColor: color,
            strokeWeight: 1.5,
            strokeOpacity: 0.4,
            clickable: false,
        });
        zonePolygons.push(circle);
        zoneData.push({ ...zone, zoneType: zType, color });
    });

    updateZoneList(zoneData);
}


// ── Zone Sidebar ────────────────────────────────────────────────────────

function updateZoneList(zones) {
    const list = document.getElementById("zoneList");
    if (!list) return;

    if (!zones || zones.length === 0) {
        list.innerHTML = '<div class="zone-empty">No zones loaded</div>';
        return;
    }

    list.innerHTML = zones.map((z, i) => {
        const name = escapeHTML(z.name || "Unnamed Zone");
        const zType = z.zoneType || "custom";
        const color = z.color || ZONE_COLORS[zType] || ZONE_COLORS.custom;
        const radius = z.radius ? `${z.radius}m` : "";
        const alertCfg = z.id ? zoneAlertConfig[z.id] : null;
        const alertOn = alertCfg && alertCfg.enabled;
        const zId = escapeHTML(z.id || "");
        const zName = escapeHTML(z.name || "");
        return `<div class="zone-item" style="--zone-color: ${color}" data-zone-idx="${i}" onclick="panToZone(${i})">
            <div class="zone-item-info">
                <div class="zone-item-name">${name}</div>
                <div class="zone-item-meta">${radius}</div>
            </div>
            <label class="zone-alert-toggle" onclick="event.stopPropagation()" title="${alertOn ? 'Alerts on' : 'Alerts off'}">
                <input type="checkbox" ${alertOn ? "checked" : ""} onchange="toggleZoneAlert('${zId}', '${zName}', this.checked)">
                <span class="zone-alert-icon">${alertOn ? "&#128276;" : "&#128277;"}</span>
            </label>
            <span class="zone-type-badge ${zType}">${zType}</span>
            <button class="zone-delete-btn" onclick="event.stopPropagation(); deleteZone('${escapeHTML(z.name)}')" title="Delete zone">&times;</button>
        </div>`;
    }).join("");

    // Update zone badge with monitoring count
    const monitored = zones.filter(z => z.id && zoneAlertConfig[z.id] && zoneAlertConfig[z.id].enabled).length;
    const badgeText = zones.length + " zone" + (zones.length > 1 ? "s" : "") + (monitored ? ` \u00b7 ${monitored} monitored` : "");
    updateBadge("badgeZones", badgeText, monitored ? "info" : "neutral");
}

function panToZone(idx) {
    if (!map || idx < 0 || idx >= zoneData.length) return;
    const z = zoneData[idx];
    if (z.centroid) {
        map.panTo({ lat: z.centroid.y, lng: z.centroid.x });
        map.setZoom(15);
    }
}

async function deleteZone(name) {
    if (!name) return;
    try {
        const resp = await fetch("/api/zones/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        if (data.error) {
            showToast("Delete failed: " + data.error, "error");
            return;
        }
        showToast(`Deleted zone: ${name}`, "success");
        await loadZones(true);
    } catch (err) {
        showToast("Delete failed: " + err.message, "error");
    }
}

async function suggestZones() {
    const btn = document.getElementById("suggestZonesBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Analyzing..."; }

    // Clear old suggestions
    suggestionCircles.forEach(c => { if (c) c.setMap(null); });
    suggestionCircles = [];
    window._zoneSuggestions = [];

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch("/api/zones/suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await resp.json();
        if (data.error) {
            showToast("Suggestion failed: " + data.error, "error");
            return;
        }

        const suggestions = data.suggestions || [];
        if (suggestions.length === 0) {
            showToast(data.message || "No zone suggestions — need more trip data", "info");
            return;
        }

        // Draw preview circles on map (dashed)
        suggestions.forEach(s => {
            const color = ZONE_COLORS[s.type] || ZONE_COLORS.custom;
            const circle = new google.maps.Circle({
                map: map,
                center: { lat: s.lat, lng: s.lng },
                radius: s.radius_m || 500,
                fillColor: color,
                fillOpacity: 0.08,
                strokeColor: color,
                strokeWeight: 2,
                strokeOpacity: 0.5,
                clickable: false,
            });
            suggestionCircles.push(circle);
        });

        // Add suggestion items to zone list
        const list = document.getElementById("zoneList");
        if (list) {
            // Keep existing zones, append suggestions
            const existingHTML = list.innerHTML.includes("zone-empty") ? "" : list.innerHTML;
            const suggestHTML = suggestions.map((s, i) => {
                const color = ZONE_COLORS[s.type] || ZONE_COLORS.custom;
                const reasoningHTML = s.reasoning ? `<div class="zone-item-reasoning">${escapeHTML(s.reasoning)}</div>` : '';
                const aceBadge = s.ace_insight ? `<span class="zone-ace-badge" title="${escapeHTML(s.ace_insight)}">Ace</span>` : '';
                return `<div class="zone-item zone-suggestion" style="--zone-color: ${color}" onclick="panToSuggestion(${s.lat}, ${s.lng})">
                    <div class="zone-item-info">
                        <div class="zone-item-name">${escapeHTML(s.name)} ${aceBadge}</div>
                        <div class="zone-item-meta">${s.stop_count} stops${s.exception_count ? ` &middot; ${s.exception_count} exceptions` : ""} &middot; ${s.radius_m}m${s.risk_types && s.risk_types.length ? `<br>${s.risk_types.join(", ")}` : ""}</div>
                        ${reasoningHTML}
                    </div>
                    <span class="zone-type-badge ${s.type}">${s.type}</span>
                    <button class="zone-create-btn" onclick="event.stopPropagation(); createSuggestedZone(${i})" data-suggest-idx="${i}">Create</button>
                </div>`;
            }).join("");
            list.innerHTML = existingHTML + suggestHTML;
        }

        // Store suggestions for creation
        window._zoneSuggestions = suggestions;
        updateBadge("badgeZones", suggestions.length + " new", "info");
        showToast(`${suggestions.length} zone suggestions from ${data.total_stops} trip stops`, "success");
    } catch (err) {
        showToast("Suggestion failed: " + err.message, "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Suggest Zones"; }
    }
}

function panToSuggestion(lat, lng) {
    if (!map) return;
    map.panTo({ lat, lng });
    map.setZoom(14);
}

async function createSuggestedZone(idx) {
    const suggestions = window._zoneSuggestions || [];
    if (idx < 0 || idx >= suggestions.length) return;
    const s = suggestions[idx];

    // Disable the create button
    const btn = document.querySelector(`[data-suggest-idx="${idx}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }

    try {
        const resp = await fetch("/api/zones/create-suggestion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: s.name,
                lat: s.lat,
                lng: s.lng,
                radius_m: s.radius_m,
                type: s.type,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            showToast("Create failed: " + data.error, "error");
            if (btn) { btn.disabled = false; btn.textContent = "Create"; }
            return;
        }

        showToast(`Created zone: ${s.name}`, "success");

        // Auto-enable alerts for risk zones
        if (data.zone_id && (s.type === "risk" || /risk|speed|hazard|collision/i.test(s.name))) {
            zoneAlertConfig[data.zone_id] = { enabled: true, zone_name: s.name };
        }

        // Remove the created suggestion from the list
        if (suggestionCircles[idx]) {
            suggestionCircles[idx].setMap(null);
            suggestionCircles[idx] = null;
        }

        // Mark as created in the suggestions array
        suggestions[idx]._created = true;

        // Update button to show created state
        if (btn) { btn.disabled = true; btn.textContent = "Created"; btn.style.opacity = "0.5"; }

        // Reload zones to show the newly created one, then re-append remaining suggestions
        await loadZones(true);
        await loadZoneAlertConfig();
        _reappendSuggestions();
    } catch (err) {
        showToast("Create failed: " + err.message, "error");
        if (btn) { btn.disabled = false; btn.textContent = "Create"; }
    }
}

function _reappendSuggestions() {
    const suggestions = window._zoneSuggestions || [];
    const remaining = suggestions.filter(s => !s._created);
    if (remaining.length === 0) return;
    const list = document.getElementById("zoneList");
    if (!list) return;
    const suggestHTML = suggestions.map((s, i) => {
        const color = ZONE_COLORS[s.type] || ZONE_COLORS.custom;
        const reasoningHTML = s.reasoning ? `<div class="zone-item-reasoning">${escapeHTML(s.reasoning)}</div>` : '';
        const created = s._created;
        const btnHTML = created
            ? `<button class="zone-create-btn" disabled style="opacity:0.5">Created</button>`
            : `<button class="zone-create-btn" onclick="event.stopPropagation(); createSuggestedZone(${i})" data-suggest-idx="${i}">Create</button>`;
        return `<div class="zone-item zone-suggestion" style="--zone-color: ${color}${created ? ';opacity:0.5' : ''}" onclick="panToSuggestion(${s.lat}, ${s.lng})">
            <div class="zone-item-info">
                <div class="zone-item-name">${escapeHTML(s.name)}</div>
                <div class="zone-item-meta">${s.stop_count} stops${s.exception_count ? ` &middot; ${s.exception_count} exceptions` : ""} &middot; ${s.radius_m}m${s.risk_types && s.risk_types.length ? `<br>${s.risk_types.join(", ")}` : ""}</div>
                ${reasoningHTML}
            </div>
            <span class="zone-type-badge ${s.type}">${s.type}</span>
            ${btnHTML}
        </div>`;
    }).join("");
    list.innerHTML += suggestHTML;
}


// ── Zone Entry/Exit Alerts ──────────────────────────────────────────────

async function loadZoneAlertConfig() {
    try {
        const resp = await fetch("/api/zone-alerts/config");
        const data = await resp.json();
        zoneAlertConfig = {};
        (data.configs || []).forEach(c => {
            zoneAlertConfig[c.zone_id] = { enabled: !!c.alerts_enabled, zone_name: c.zone_name };
        });
    } catch (err) {
        console.error("Failed to load zone alert config:", err);
    }
}

function checkZoneAlerts() {
    if (!zoneData.length || !vehicles.length) return;

    // Build lookup: zone name -> zone data (with centroid/radius)
    const enabledZones = [];
    zoneData.forEach(z => {
        if (!z.centroid || !z.id) return;
        const cfg = zoneAlertConfig[z.id];
        if (cfg && cfg.enabled) enabledZones.push(z);
    });
    if (!enabledZones.length) { alertsInitialized = true; return; }

    const newState = {};
    vehicles.forEach(v => {
        if (v.latitude == null || v.longitude == null) return;
        newState[v.id] = {};
        enabledZones.forEach(z => {
            const dist = haversine(v.latitude, v.longitude, z.centroid.y, z.centroid.x);
            const radius = z.radius || 300;
            newState[v.id][z.id] = dist < radius ? "inside" : "outside";
        });
    });

    // Fire alerts on state transitions (skip first cycle to baseline)
    if (alertsInitialized) {
        Object.keys(newState).forEach(deviceId => {
            const prev = vehicleZoneState[deviceId] || {};
            const curr = newState[deviceId];
            Object.keys(curr).forEach(zoneId => {
                const was = prev[zoneId];
                const now = curr[zoneId];
                if (was && now && was !== now) {
                    const v = vehicles.find(x => x.id === deviceId);
                    const z = zoneData.find(x => x.id === zoneId);
                    if (v && z) {
                        const action = now === "inside" ? "entered" : "exited";
                        showZoneAlert(shortName(v), z.name || "Unknown Zone", action, z.zoneType || "custom", deviceId, z.id);
                    }
                }
            });
        });
    }

    vehicleZoneState = newState;
    alertsInitialized = true;
}

function showZoneAlert(vehicleName, zoneName, action, zoneType, deviceId, zoneId) {
    const arrow = action === "entered" ? "&#9654;" : "&#9664;";
    const type = zoneType === "risk" ? "warning" : "info";
    const msg = `${arrow} <b>${escapeHTML(vehicleName)}</b> ${action} <b>${escapeHTML(zoneName)}</b>`;
    showToast(msg, type, 6000);
    // Persist event to backend
    fetch("/api/zone-alerts/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            device_id: deviceId, device_name: vehicleName,
            zone_id: zoneId, zone_name: zoneName,
            zone_type: zoneType, action
        }),
    }).catch(() => {});
}

async function toggleZoneAlert(zoneId, zoneName, enabled) {
    try {
        await fetch("/api/zone-alerts/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ zone_id: zoneId, zone_name: zoneName, enabled }),
        });
    } catch (err) {
        console.error("Failed to toggle zone alert:", err);
    }
    // Update local state
    if (enabled) {
        zoneAlertConfig[zoneId] = { enabled: true, zone_name: zoneName };
    } else if (zoneAlertConfig[zoneId]) {
        zoneAlertConfig[zoneId].enabled = false;
    }
    // Reset zone state to re-baseline (avoid false alerts)
    Object.keys(vehicleZoneState).forEach(devId => {
        if (vehicleZoneState[devId]) delete vehicleZoneState[devId][zoneId];
    });
    alertsInitialized = false;
    showToast(`Alerts ${enabled ? "enabled" : "disabled"} for ${escapeHTML(zoneName)}`, "info", 2000);
}


// ── Trip Drawing ────────────────────────────────────────────────────────

function drawTrips(trips) {
    if (!map) return; // Map not initialized yet
    // Clear existing
    tripPolylines.forEach(p => p.setMap(null));
    tripPolylines = [];

    trips.forEach(trip => {
        // Trips have stopPoint — draw point markers using AdvancedMarkerElement
        if (trip.stopPoint && trip.stopPoint.x != null) {
            const pos = { lat: trip.stopPoint.y, lng: trip.stopPoint.x };
            const el = document.createElement("div");
            el.style.cssText = "width:10px;height:10px;border-radius:50%;background:#4a9eff;border:2px solid #fff;box-shadow:0 0 4px rgba(74,158,255,0.6)";
            el.title = `Trip end: ${trip.stop || ""}`;
            const marker = new google.maps.marker.AdvancedMarkerElement({
                map: map,
                position: pos,
                content: el,
                title: `Trip end: ${trip.stop || ""}`,
            });
            tripPolylines.push(marker);
        }
    });
}


// ── Vehicle Selection ───────────────────────────────────────────────────

async function selectVehicle(deviceId) {
    selectedVehicle = deviceId;
    const vehicle = vehicles.find(v => v.id === deviceId);
    if (!vehicle) return;

    // Highlight in list
    document.querySelectorAll(".vehicle-item").forEach(el => {
        el.classList.toggle("selected", el.dataset.id === deviceId);
    });

    // Pan map to vehicle (unless view is locked)
    if (!viewLocked && vehicle.latitude && vehicle.longitude) {
        map.panTo({ lat: vehicle.latitude, lng: vehicle.longitude });
        map.setZoom(15);
    }

    // Refresh marker visibility for solo mode
    if (soloMode) updateMarkers();

    // Load trips
    const trips = await loadTrips(deviceId);
    drawTrips(trips);

    // Get device faults
    const deviceFaults = faults.filter(f => f.deviceId === deviceId);

    // Show detail panel
    const panel = document.getElementById("detailPanel");
    const content = document.getElementById("detailContent");

    const status = getVehicleStatus(vehicle);
    const statusLabel = { moving: "Moving", stopped: "Stopped", fault: "Fault", offline: "Offline" }[status] || "Unknown";
    const statusColor = { moving: "#34d399", stopped: "#8892a8", fault: "#f87171", offline: "#5a6478" }[status] || "#8892a8";

    let html = `
        <h2>${escapeHTML(vehicle.name || vehicle.id)}</h2>
        <p class="detail-subtitle" style="color: ${statusColor}">${statusLabel}
            ${vehicle.speed ? ` &mdash; ${vehicle.speed.toFixed(1)} km/h` : ""}
        </p>

        ${vehicle.driver_name ? `<div class="detail-row"><span class="label">Driver</span><span class="value">${escapeHTML(vehicle.driver_name)}</span></div>` : ""}
        ${vehicle.department ? `<div class="detail-row"><span class="label">Department</span><span class="value">${escapeHTML(vehicle.department)}</span></div>` : ""}
        <div class="detail-row"><span class="label">Make/Model</span><span class="value">${escapeHTML([vehicle.make, vehicle.model].filter(Boolean).join(" ") || "N/A")}</span></div>
        <div class="detail-row"><span class="label">Year</span><span class="value">${escapeHTML(vehicle.year || "N/A")}</span></div>
        ${vehicle.vehicle_type ? `<div class="detail-row"><span class="label">Type</span><span class="value">${escapeHTML(vehicle.vehicle_type)}</span></div>` : ""}
        ${vehicle.color ? `<div class="detail-row"><span class="label">Color</span><span class="value">${escapeHTML(vehicle.color)}</span></div>` : ""}
        ${vehicle.fuel_type ? `<div class="detail-row"><span class="label">Fuel</span><span class="value">${escapeHTML(vehicle.fuel_type)}</span></div>` : ""}
        <div class="detail-row"><span class="label">VIN</span><span class="value">${escapeHTML(vehicle.vin || "N/A")}</span></div>
        <div class="detail-row"><span class="label">Odometer</span><span class="value">${vehicle.odometer ? Math.round(vehicle.odometer).toLocaleString() + " km" : "N/A"}</span></div>
        <div class="detail-row"><span class="label">Engine Hours</span><span class="value">${vehicle.engineHours ? Math.round(vehicle.engineHours).toLocaleString() + " h" : "N/A"}</span></div>
        <div class="detail-row"><span class="label">Lat / Lng</span><span class="value">${vehicle.latitude?.toFixed(4) || "?"}, ${vehicle.longitude?.toFixed(4) || "?"}</span></div>
        <div class="detail-row"><span class="label">Device ID</span><span class="value" style="font-size:11px;opacity:0.6">${escapeHTML(vehicle.id)}</span></div>
    `;

    if (deviceFaults.length > 0) {
        html += `<p class="detail-section-title">Active Faults (${deviceFaults.length})</p>`;
        deviceFaults.slice(0, 5).forEach(f => {
            html += `<div class="fault-item">
                <span class="fault-device">${escapeHTML(f.diagnosticName || f.diagnosticId || "Unknown")}</span>
                <div class="fault-desc">${escapeHTML(f.failureMode || "")} &mdash; ${escapeHTML(f.dateTime || "")}</div>
            </div>`;
        });
    }

    if (trips.length > 0) {
        html += `<p class="detail-section-title">Recent Trips (${trips.length})</p>`;
        [...trips].reverse().slice(0, 5).forEach(t => {
            const dist = t.distance ? t.distance.toFixed(1) + " km" : "N/A";
            const replayBtn = t.start && t.stop
                ? `<button class="trip-replay-btn" onclick="event.stopPropagation(); startTripReplay('${deviceId}', '${t.start}', '${t.stop}')" title="Replay trip">&#9654;</button>`
                : "";
            html += `<div class="trip-item">
                <div class="trip-header">
                    <div class="trip-time">${formatDateTime(t.start)} &rarr; ${formatDateTime(t.stop)}</div>
                    ${replayBtn}
                </div>
                <div class="trip-meta">${dist} &mdash; Max ${t.maximumSpeed?.toFixed(0) || "?"} km/h</div>
            </div>`;
        });
    }

    // Safety Events section
    html += `
        <p class="detail-section-title">Safety Events</p>
        <button class="events-load-btn" id="evQuickViewBtn" onclick="loadVehicleEvents('${deviceId}')">Quick View</button>
        <button class="events-load-btn" onclick="openEventsSlideout('${deviceId}')">Full Timeline &rarr;</button>
        <div id="vehicleEvents"></div>
    `;

    content.innerHTML = html;
    panel.classList.remove("hidden");
}

function closeDetail() {
    document.getElementById("detailPanel").classList.add("hidden");
    selectedVehicle = null;

    // Restore all markers if solo mode was on
    if (soloMode) {
        soloMode = false;
        const soloBtn = document.getElementById("soloModeToggle");
        soloBtn.classList.remove("active");
        soloBtn.querySelector("span").textContent = "Solo";
        for (const id in markers) markers[id].map = map;
    }

    // Clear trip overlays
    tripPolylines.forEach(p => p.setMap(null));
    tripPolylines = [];

    // Deselect list
    document.querySelectorAll(".vehicle-item.selected").forEach(el => el.classList.remove("selected"));
}


// ── Stop Detection & Map Pins ───────────────────────────────────────────

function _detectStops(points) {
    if (!points || points.length < 2) return [];
    const stops = [];
    let inStop = false;
    let stopStart = null;
    let stopLats = [], stopLngs = [];

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const speed = p.speed || 0;
        if (speed < 5) {
            if (!inStop) {
                inStop = true;
                stopStart = p;
                stopLats = [p.lat];
                stopLngs = [p.lng];
            } else {
                stopLats.push(p.lat);
                stopLngs.push(p.lng);
            }
        } else if (inStop) {
            // Close the stop cluster
            const prev = points[i - 1] || stopStart;
            const arriveTime = new Date(stopStart.dateTime);
            const departTime = new Date(prev.dateTime);
            const durationSec = (departTime - arriveTime) / 1000;
            if (durationSec >= 20) {
                const avgLat = stopLats.reduce((a, b) => a + b, 0) / stopLats.length;
                const avgLng = stopLngs.reduce((a, b) => a + b, 0) / stopLngs.length;
                stops.push({ lat: avgLat, lng: avgLng, arriveTime, departTime, durationSec });
            }
            inStop = false;
        }
    }
    // Close trailing stop
    if (inStop && stopStart) {
        const last = points[points.length - 1];
        const arriveTime = new Date(stopStart.dateTime);
        const departTime = new Date(last.dateTime);
        const durationSec = (departTime - arriveTime) / 1000;
        if (durationSec >= 20) {
            const avgLat = stopLats.reduce((a, b) => a + b, 0) / stopLats.length;
            const avgLng = stopLngs.reduce((a, b) => a + b, 0) / stopLngs.length;
            stops.push({ lat: avgLat, lng: avgLng, arriveTime, departTime, durationSec });
        }
    }
    // Merge stops that are very close together (<100m)
    const merged = [];
    for (const s of stops) {
        if (merged.length > 0) {
            const prev = merged[merged.length - 1];
            if (haversine(prev.lat, prev.lng, s.lat, s.lng) < 100) {
                prev.departTime = s.departTime;
                prev.durationSec = (prev.departTime - prev.arriveTime) / 1000;
                prev.lat = (prev.lat + s.lat) / 2;
                prev.lng = (prev.lng + s.lng) / 2;
                continue;
            }
        }
        merged.push({ ...s });
    }
    return merged;
}

function _formatStopDuration(sec) {
    if (sec >= 3600) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    if (sec >= 60) return Math.floor(sec / 60) + "m " + Math.floor(sec % 60) + "s";
    return Math.floor(sec) + "s";
}

function _showTripStopPins(stops) {
    _clearStopPins();
    if (!map || !stops || stops.length === 0) return;
    stops.forEach((s, i) => {
        const color = STOP_COLORS[i % STOP_COLORS.length];
        const pinEl = document.createElement("div");
        pinEl.className = "ev-stop-pin";
        pinEl.style.borderColor = color;
        pinEl.style.color = color;
        pinEl.textContent = i + 1;
        const marker = new google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: { lat: s.lat, lng: s.lng },
            content: pinEl,
            title: `Stop ${i + 1}`,
            zIndex: 900 + i,
        });
        evStopMarkers.push(marker);
    });
    // Draw colored polyline segments connecting consecutive stops
    for (let i = 0; i < stops.length - 1; i++) {
        const color = STOP_COLORS[i % STOP_COLORS.length];
        const seg = new google.maps.Polyline({
            path: [
                { lat: stops[i].lat, lng: stops[i].lng },
                { lat: stops[i + 1].lat, lng: stops[i + 1].lng },
            ],
            geodesic: true,
            strokeColor: color,
            strokeOpacity: 0.8,
            strokeWeight: 3,
            map: map,
            zIndex: 800,
        });
        evStopPolylines.push(seg);
    }
}

function _clearStopPins() {
    evStopMarkers.forEach(m => { m.map = null; });
    evStopMarkers = [];
    evStopPolylines.forEach(p => p.setMap(null));
    evStopPolylines = [];
}


// ── Events Slideout Timeline ────────────────────────────────────────────

async function openEventsSlideout(deviceId) {
    // Close detail panel without clearing trip polylines
    document.getElementById("detailPanel").classList.add("hidden");

    // Open slideout to events tab with spinner
    openSlideout("events");
    document.getElementById("slideoutBody").innerHTML = '<div class="loading">Loading event timeline...</div>';
    _clearStopPins();

    const vehicle = vehicles.find(v => v.id === deviceId);
    const vName = vehicle ? escapeHTML(vehicle.name || vehicle.id) : escapeHTML(deviceId);
    const status = vehicle ? getVehicleStatus(vehicle) : "offline";
    const statusLabel = { moving: "Moving", stopped: "Stopped", fault: "Fault", offline: "Offline" }[status] || "Unknown";
    const statusColor = { moving: "#34d399", stopped: "#8892a8", fault: "#f87171", offline: "#5a6478" }[status] || "#8892a8";

    try {
        // Parallel fetch: trips + exceptions
        const [trips, excResp] = await Promise.all([
            loadTrips(deviceId),
            fetch(`/api/exceptions?device_id=${encodeURIComponent(deviceId)}`).then(r => r.json()).catch(() => ({ exceptions: [] }))
        ]);
        const exceptions = excResp.exceptions || [];

        // Correlate exceptions to trips by timestamp overlap
        const matchedExcIds = new Set();
        const tripData = trips.map(t => {
            const tStart = new Date(t.start).getTime();
            const tStop = new Date(t.stop).getTime();
            const matched = exceptions.filter(e => {
                const eTime = new Date(e.activeFrom).getTime();
                return eTime >= tStart && eTime <= tStop;
            });
            matched.forEach(e => matchedExcIds.add(e.activeFrom + e.ruleName));
            return { trip: t, exceptions: matched };
        });

        const unmatched = exceptions.filter(e => !matchedExcIds.has(e.activeFrom + e.ruleName));

        // Sort newest first
        tripData.sort((a, b) => new Date(b.trip.start).getTime() - new Date(a.trip.start).getTime());

        // Fetch GPS replay for top 5 trips to detect inline stops
        const GPS_DETAIL_LIMIT = 5;
        const gpsPromises = tripData.slice(0, GPS_DETAIL_LIMIT).map(td => {
            const t = td.trip;
            if (!t.start || !t.stop) return Promise.resolve([]);
            return fetch(`/api/vehicle/${encodeURIComponent(deviceId)}/trip-replay?from=${encodeURIComponent(t.start)}&to=${encodeURIComponent(t.stop)}`)
                .then(r => r.json()).then(d => d.points || []).catch(() => []);
        });
        const gpsResults = await Promise.all(gpsPromises);

        // Detect stops for top 5 trips
        const tripStops = gpsResults.map(pts => _detectStops(pts));

        // Build HTML
        let html = `<div class="ev-header">
            <h3>${vName}</h3>
            <span class="ev-header-status" style="color:${statusColor}">${statusLabel}</span>
            <span style="color:var(--text-muted);font-size:12px"> &mdash; ${trips.length} trip${trips.length !== 1 ? "s" : ""}, ${exceptions.length} event${exceptions.length !== 1 ? "s" : ""}</span>
        </div>`;

        if (trips.length === 0 && exceptions.length === 0) {
            html += '<div class="ev-empty">No trips or events found for this vehicle</div>';
        }

        // Store stops data for map pin interaction
        const allTripStops = [];

        tripData.forEach((td, idx) => {
            const t = td.trip;
            const hasGps = idx < GPS_DETAIL_LIMIT;
            const stops = hasGps ? tripStops[idx] : [];
            allTripStops.push(stops);
            const dist = t.distance ? t.distance.toFixed(1) : "0";
            const maxSpd = t.maximumSpeed?.toFixed(0) || "?";
            const avgSpd = t.averageSpeed?.toFixed(0) || "?";
            const driving = _formatDuration(t.drivingDuration);
            const idling = _formatDuration(t.idlingDuration);

            const replayBtn = t.start && t.stop
                ? `<button class="ev-btn" onclick="event.stopPropagation(); startTripReplay('${deviceId}', '${t.start}', '${t.stop}')" title="Replay trip">&#9654; Replay</button>`
                : "";

            // Click trip card header to show its stops on map
            const tripClickAttr = hasGps && stops.length > 0
                ? ` onclick="_evShowStopsForTrip(${idx})"  style="cursor:pointer"`
                : "";

            html += `<div class="ev-trip" data-trip-idx="${idx}"${tripClickAttr}>
                <div class="ev-trip-header">
                    <div class="ev-trip-time">${formatDateTime(t.start)} &rarr; ${formatDateTime(t.stop)}</div>
                    ${replayBtn}
                </div>
                <div class="ev-trip-stats">
                    <div class="ev-stat"><div class="ev-stat-val">${dist} km</div><div class="ev-stat-label">Distance</div></div>
                    <div class="ev-stat"><div class="ev-stat-val">${maxSpd} km/h</div><div class="ev-stat-label">Max Speed</div></div>
                    <div class="ev-stat"><div class="ev-stat-val">${avgSpd} km/h</div><div class="ev-stat-label">Avg Speed</div></div>
                    <div class="ev-stat"><div class="ev-stat-val">${driving}</div><div class="ev-stat-label">Driving</div></div>
                    <div class="ev-stat"><div class="ev-stat-val">${idling}</div><div class="ev-stat-label">Idling</div></div>
                    <div class="ev-stat"><div class="ev-stat-val">${stops.length || "0"}</div><div class="ev-stat-label">Stops</div></div>
                </div>`;

            // Inline waypoint stops (top 5 trips only)
            if (hasGps && stops.length > 0) {
                html += `<div class="ev-waypoints"><div class="ev-waypoints-title">Stops (${stops.length})</div>`;
                stops.forEach((s, si) => {
                    const arrive = s.arriveTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                    const depart = s.departTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                    const dur = _formatStopDuration(s.durationSec);
                    const coords = s.lat.toFixed(3) + ", " + s.lng.toFixed(3);
                    const dotColor = STOP_COLORS[si % STOP_COLORS.length];
                    html += `<div class="ev-waypoint" onclick="event.stopPropagation(); _evPanToStop(${idx}, ${si})" title="Pan to stop">
                        <span class="ev-waypoint-dot" style="background:${dotColor}"></span>
                        <span class="ev-waypoint-time">Stop ${si + 1} &mdash; ${arrive} &rarr; ${depart} (${dur})</span>
                        <span class="ev-waypoint-coords">${coords}</span>
                    </div>`;
                });
                html += `</div>`;
            }

            // Nested exceptions
            if (td.exceptions.length > 0) {
                html += `<div class="ev-exceptions"><div class="ev-exceptions-title">Events (${td.exceptions.length})</div>`;
                td.exceptions.forEach(e => {
                    const sev = EVENT_SEVERITY[e.ruleName] || "yellow";
                    const time = e.activeFrom ? formatDateTime(e.activeFrom) : "";
                    const dur = e.duration ? " &middot; " + escapeHTML(e.duration) : "";
                    html += `<div class="ev-exc-item">
                        <span class="ev-exc-dot ${sev}"></span>
                        <span class="ev-exc-name">${escapeHTML(e.ruleName || e.ruleId || "Unknown")}</span>
                        <span class="ev-exc-time">${time}${dur}</span>
                    </div>`;
                });
                html += `</div>`;
            }

            html += `</div>`;
        });

        // Unmatched exceptions (newest first)
        if (unmatched.length > 0) {
            unmatched.sort((a, b) => new Date(b.activeFrom).getTime() - new Date(a.activeFrom).getTime());
            html += `<div class="ev-unmatched-title">Unmatched Events (${unmatched.length})</div>`;
            unmatched.forEach(e => {
                const sev = EVENT_SEVERITY[e.ruleName] || "yellow";
                const time = e.activeFrom ? formatDateTime(e.activeFrom) : "";
                const dur = e.duration ? " &middot; " + escapeHTML(e.duration) : "";
                html += `<div class="ev-exc-item">
                    <span class="ev-exc-dot ${sev}"></span>
                    <span class="ev-exc-name">${escapeHTML(e.ruleName || e.ruleId || "Unknown")}</span>
                    <span class="ev-exc-time">${time}${dur}</span>
                </div>`;
            });
        }

        slideoutEventsHTML = html;
        slideoutEventsDeviceId = deviceId;
        document.getElementById("slideoutBody").innerHTML = html;

        // Store stops data globally for interaction handlers
        window._evTripStops = allTripStops;

        // Show pins for the first trip with stops
        const firstWithStops = allTripStops.findIndex(s => s.length > 0);
        if (firstWithStops >= 0) {
            _showTripStopPins(allTripStops[firstWithStops]);
        }

    } catch (err) {
        console.error("Failed to load event timeline:", err);
        document.getElementById("slideoutBody").innerHTML = '<div class="ev-empty">Failed to load event timeline</div>';
    }
}

// Interaction handlers for inline waypoints
function _evShowStopsForTrip(tripIdx) {
    const stops = window._evTripStops && window._evTripStops[tripIdx];
    if (stops && stops.length > 0) {
        _showTripStopPins(stops);
        // Fit map to show all stops
        if (map && stops.length > 1) {
            const bounds = new google.maps.LatLngBounds();
            stops.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
            map.fitBounds(bounds, { padding: 80 });
        } else if (map && stops.length === 1) {
            map.panTo({ lat: stops[0].lat, lng: stops[0].lng });
            map.setZoom(15);
        }
    }
}

function _evPanToStop(tripIdx, stopIdx) {
    const stops = window._evTripStops && window._evTripStops[tripIdx];
    if (!stops || !stops[stopIdx]) return;
    // Ensure this trip's pins are showing
    _showTripStopPins(stops);
    const s = stops[stopIdx];
    if (map) {
        map.panTo({ lat: s.lat, lng: s.lng });
        map.setZoom(16);
    }
}

function _formatDuration(durStr) {
    if (!durStr) return "—";
    // Handle HH:MM:SS
    if (/^\d+:\d+:\d+$/.test(durStr)) {
        const parts = durStr.split(":").map(Number);
        if (parts[0] > 0) return parts[0] + "h " + parts[1] + "m";
        if (parts[1] > 0) return parts[1] + "m " + parts[2] + "s";
        return parts[2] + "s";
    }
    // Handle ISO PT duration (PT1H30M15S)
    const m = durStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (m) {
        const h = parseInt(m[1] || 0), mi = parseInt(m[2] || 0), s = parseInt(m[3] || 0);
        if (h > 0) return h + "h " + mi + "m";
        if (mi > 0) return mi + "m " + s + "s";
        return s + "s";
    }
    return escapeHTML(durStr);
}

function _getEventsPopoutHTML() {
    const content = slideoutEventsHTML || "";
    const timestamp = new Date().toLocaleString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vehicle Event Timeline — ${timestamp}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; color: #1a1d23; line-height: 1.6; }
  h3 { color: #2b7de9; margin: 0 0 4px; }
  .ev-header { margin-bottom: 16px; }
  .ev-header-status { font-size: 12px; font-weight: 600; }
  .ev-trip { border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
  .ev-trip-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
  .ev-trip-time { font-size: 12px; font-weight: 600; }
  .ev-trip-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 14px; }
  .ev-stat { text-align: center; }
  .ev-stat-val { font-size: 13px; font-weight: 700; }
  .ev-stat-label { font-size: 10px; color: #8892a8; text-transform: uppercase; }
  .ev-exceptions { padding: 0 14px 10px; }
  .ev-exceptions-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #8892a8; margin-bottom: 6px; }
  .ev-exc-item { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12px; border-bottom: 1px solid #f3f4f6; }
  .ev-exc-item:last-child { border-bottom: none; }
  .ev-exc-dot { width: 8px; height: 8px; border-radius: 50%; }
  .ev-exc-dot.red { background: #f87171; }
  .ev-exc-dot.amber { background: #fbbf24; }
  .ev-exc-dot.yellow { background: #facc15; }
  .ev-exc-name { font-weight: 600; flex: 1; }
  .ev-exc-time { font-size: 11px; color: #8892a8; }
  .ev-unmatched-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #8892a8; margin: 20px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
  .ev-empty { text-align: center; padding: 40px 20px; color: #8892a8; }
  .ev-btn { display: none; }
  .ev-waypoints { padding: 0 14px 10px; }
  .ev-waypoints-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #8892a8; margin-bottom: 6px; }
  .ev-waypoint { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #f3f4f6; }
  .ev-waypoint:last-child { border-bottom: none; }
  .ev-waypoint-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a9eff; flex-shrink: 0; }
  .ev-waypoint-time { flex: 1; font-weight: 500; }
  .ev-waypoint-coords { font-size: 10px; color: #8892a8; font-family: monospace; }
  .report-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #8892a8; }
</style>
</head>
<body>
${content}
<div class="report-footer">Generated ${timestamp} — Fleet Command Center powered by Geotab</div>
</body>
</html>`;
}


// ── Vehicle Events ──────────────────────────────────────────────────────

const EVENT_SEVERITY = {
    "Major Collision": "red", "Minor Collision": "red", "Possible Collision": "red",
    "Speeding": "amber", "Max Speed": "amber", "Harsh Braking": "amber",
    "Hard Acceleration": "amber", "Harsh Cornering": "amber",
    "Seat Belt": "yellow", "Engine Light On": "yellow", "Engine Fault": "yellow",
    "Application Exception": "yellow",
};

async function loadVehicleEvents(deviceId) {
    const container = document.getElementById("vehicleEvents");
    const btn = document.getElementById("evQuickViewBtn");
    if (!container) return;
    if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }

    try {
        const resp = await fetch(`/api/exceptions?device_id=${encodeURIComponent(deviceId)}`);
        const data = await resp.json();
        const events = data.exceptions || [];

        if (btn) { btn.disabled = true; btn.textContent = `${events.length} Events`; }

        if (events.length === 0) {
            container.innerHTML = '<div class="event-empty">No safety events found</div>';
            return;
        }

        container.innerHTML = events.slice(0, 10).map(e => {
            const severity = EVENT_SEVERITY[e.ruleName] || "yellow";
            const time = e.activeFrom ? formatDateTime(e.activeFrom) : "Unknown";
            const dur = e.duration || "";
            return `<div class="event-item event-${severity}">
                <div class="event-rule">${escapeHTML(e.ruleName || e.ruleId || "Unknown")}</div>
                <div class="event-meta">${time}${dur ? " &middot; " + escapeHTML(dur) : ""}</div>
            </div>`;
        }).join("") + (events.length > 10 ? `<div class="event-meta" style="text-align:center;padding:6px">+${events.length - 10} more</div>` : "");
    } catch (err) {
        container.innerHTML = '<div class="event-empty">Failed to load events</div>';
        if (btn) { btn.disabled = false; btn.textContent = "Quick View"; }
    }
}


// ── Sidebar Collapse + Badges ───────────────────────────────────────────

function toggleSection(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("collapsed");
}

function updateBadge(id, text, style) {
    const badge = document.getElementById(id);
    if (!badge) return;
    if (!text) {
        badge.className = "section-badge";
        badge.textContent = "";
        return;
    }
    badge.textContent = text;
    badge.className = "section-badge active " + (style || "neutral");
}

// ── Sidebar Updates ─────────────────────────────────────────────────────

function updateVehicleList() {
    const list = document.getElementById("vehicleList");
    const search = document.getElementById("vehicleSearch").value.toLowerCase();

    const filtered = vehicles.filter(v =>
        !search || (v.name || "").toLowerCase().includes(search)
        || (v.id || "").toLowerCase().includes(search)
        || (v.driver_name || "").toLowerCase().includes(search)
        || (v.department || "").toLowerCase().includes(search)
        || (v.make || "").toLowerCase().includes(search)
    );

    // Filter map markers to match search (dim non-matching)
    if (search && map) {
        const matchIds = new Set(filtered.map(v => v.id));
        for (const id in markers) {
            const el = markers[id].content;
            if (el) el.style.opacity = matchIds.has(id) ? "1" : "0.25";
        }
    } else {
        // Reset all markers to full opacity
        for (const id in markers) {
            const el = markers[id].content;
            if (el) el.style.opacity = "1";
        }
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="loading">No vehicles found</div>';
        return;
    }

    list.innerHTML = filtered.map(v => {
        const status = getVehicleStatus(v);
        const speed = v.speed ? `${v.speed.toFixed(0)} km/h` : "";
        const meta = escapeHTML([v.make, v.model].filter(Boolean).join(" ") || v.vin || v.id);
        const driverLine = v.driver_name ? `<div class="vehicle-driver">${escapeHTML(v.driver_name)}${v.department ? ` · ${escapeHTML(v.department)}` : ""}</div>` : "";
        const eid = escapeHTML(v.id);
        return `
            <div class="vehicle-item ${selectedVehicle === v.id ? "selected" : ""}"
                 data-id="${eid}"
                 onclick="selectVehicle('${eid}')">
                <span class="vehicle-dot ${status}"></span>
                <div class="vehicle-info">
                    <div class="vehicle-name">${escapeHTML(v.name || v.id)}</div>
                    <div class="vehicle-meta">${meta}</div>
                    ${driverLine}
                </div>
                <button class="vehicle-events-btn" onclick="event.stopPropagation(); openEventsSlideout('${eid}')" title="Event timeline">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </button>
                <span class="vehicle-speed">${speed}</span>
            </div>
        `;
    }).join("");

    // Update vehicle badge
    const faultCount = vehicles.filter(v => getVehicleStatus(v) === "fault").length;
    if (faultCount > 0) {
        updateBadge("badgeVehicles", faultCount + " fault" + (faultCount > 1 ? "s" : ""), "warning");
    } else {
        const movingCount = vehicles.filter(v => getVehicleStatus(v) === "moving").length;
        updateBadge("badgeVehicles", movingCount > 0 ? movingCount + " moving" : "", "info");
    }
}

function updateFaultList() {
    const list = document.getElementById("faultList");
    if (faults.length === 0) {
        list.innerHTML = '<div class="loading" style="color: #34d399">No active faults</div>';
        return;
    }

    list.innerHTML = faults.slice(0, 20).map(f => `
        <div class="fault-item">
            <span class="fault-device">${escapeHTML(f.deviceId || "Unknown")}</span>
            <div class="fault-desc">${escapeHTML(f.diagnosticName || f.diagnosticId || "Unknown")} &mdash; ${escapeHTML(f.failureMode || "")}</div>
        </div>
    `).join("");

    // Update fault badge
    updateBadge("badgeFaults", faults.length > 0 ? faults.length : "", "warning");
}

function updateStats() {
    const total = vehicles.length;
    let moving = 0, stopped = 0, faulted = 0;
    vehicles.forEach(v => {
        const s = getVehicleStatus(v);
        if (s === "moving") moving++;
        else if (s === "fault") faulted++;
        else stopped++;
    });

    document.getElementById("statTotal").textContent = total;
    document.getElementById("statMoving").textContent = moving;
    document.getElementById("statStopped").textContent = stopped;
    document.getElementById("statFaults").textContent = faults.length;
}

function updateConnectionBadge(connected) {
    const badge = document.getElementById("connectionBadge");
    if (connected) {
        badge.textContent = "Connected";
        badge.className = "badge connected";
    } else {
        badge.textContent = "Disconnected";
        badge.className = "badge error";
    }
}


// ── Search ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    const searchInput = document.getElementById("vehicleSearch");
    if (searchInput) {
        searchInput.addEventListener("input", updateVehicleList);
    }
});


// ── Utilities ───────────────────────────────────────────────────────────

function formatDateTime(isoStr) {
    if (!isoStr) return "N/A";
    try {
        const d = new Date(isoStr);
        return d.toLocaleString(undefined, {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
        });
    } catch {
        return isoStr;
    }
}


// ── Chat Panel ─────────────────────────────────────────────────────────

function toggleChat() {
    const panel = document.getElementById("chatPanel");
    chatOpen = !chatOpen;
    panel.classList.toggle("collapsed", !chatOpen);
    if (chatOpen) {
        const input = document.getElementById("chatInput");
        setTimeout(() => input.focus(), 200);
        scrollChatToBottom();
    }
}

function scrollChatToBottom() {
    const container = document.getElementById("chatMessages");
    container.scrollTop = container.scrollHeight;
}

function appendMessage(role, content) {
    const container = document.getElementById("chatMessages");
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;

    // Basic formatting: split on double newlines for paragraphs
    const paragraphs = content.split(/\n\n+/).filter(Boolean);
    bubble.innerHTML = paragraphs.map(p => {
        // Convert single newlines to <br>, bold **text**, and inline code `text`
        let html = p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>');
        html = html.replace(/\n/g, "<br>");
        return `<p>${html}</p>`;
    }).join("");

    container.appendChild(bubble);
    scrollChatToBottom();
}

function setTypingIndicator(show) {
    const container = document.getElementById("chatMessages");
    const existing = container.querySelector(".chat-typing");
    if (show && !existing) {
        const el = document.createElement("div");
        el.className = "chat-typing";
        el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        container.appendChild(el);
        scrollChatToBottom();
    } else if (!show && existing) {
        existing.remove();
    }
}

async function sendMessage() {
    if (chatSending) return;
    const input = document.getElementById("chatInput");
    const message = input.value.trim();
    if (!message) return;

    input.value = "";
    appendMessage("user", message);

    // ── Local chat commands (intercepted before hitting the API) ──
    const lower = message.toLowerCase().replace(/[^a-z0-9 ]/g, "");

    if (lower === "help" || lower === "commands" || lower === "what can you do") {
        appendMessage("assistant",
            "**Quick Commands** (handled instantly)\n\n" +
            "**help** — Show this reference\n" +
            "**play the demo** — Launch a 3-minute guided tour\n" +
            "**stop demo** — Stop the demo\n\n" +
            "**AI Questions** (powered by Gemini + Geotab)\n\n" +
            "\"Which vehicles are moving right now?\"\n" +
            "\"Show me trips for Vehicle 5\"\n" +
            "\"How many faults are active?\"\n" +
            "\"Summarise today's fleet activity\"\n\n" +
            "**Action Commands** (AI executes via Geotab API)\n\n" +
            "\"Create a geofence around downtown Toronto\"\n" +
            "\"Send a message to Vehicle 12\"\n\n" +
            "You can type or use the mic button to speak."
        );
        return;
    }
    if (lower.includes("play") && lower.includes("demo") || lower === "demo" || lower === "start demo" || lower === "run demo") {
        // Start demo immediately — TTS lines are cached on disk (3ms each)
        if (typeof runDemo === "function") runDemo();
        return;
    }
    if (lower === "stop demo" || lower === "end demo") {
        stopDemo();
        appendMessage("assistant", "Demo stopped.");
        return;
    }

    setTypingIndicator(true);
    chatSending = true;

    // Visual disabled state on send button
    const sendBtn = document.getElementById("sendBtn");
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }

    try {
        const resp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, session_id: chatSessionId }),
        });
        const data = await resp.json();
        setTypingIndicator(false);

        if (data.error) {
            appendMessage("error", "Error: " + escapeHTML(data.error));
        } else {
            appendMessage("assistant", data.response);
            // Update session ID if server assigned one
            if (data.session_id) chatSessionId = data.session_id;
            // Detect action keywords in response for visual feedback
            const lower = data.response.toLowerCase();
            if (lower.includes("zone") && (lower.includes("created") || lower.includes("geofence"))) {
                showToast("Zone created — refreshing map zones", "success");
                loadZones(true);
            }
            if (lower.includes("zone") && (lower.includes("delet") || lower.includes("remov") || lower.includes("no zone") || lower.includes("not found"))) {
                showToast("Zone update — refreshing map", "info");
                loadZones(true);
            }
            if (lower.includes("message") && lower.includes("sent")) {
                showToast("Text message sent to vehicle", "success");
            }
            // Optional TTS for short responses
            speakResponse(data.response);
        }
    } catch (err) {
        setTypingIndicator(false);
        appendMessage("error", "Failed to reach the server. Please try again.");
    } finally {
        chatSending = false;
        const sendBtn = document.getElementById("sendBtn");
        if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = "1"; }
    }
}

async function clearChat() {
    const container = document.getElementById("chatMessages");
    // Keep only the welcome message
    container.innerHTML = `
        <div class="chat-bubble assistant">
            <p>Hi! I'm your fleet assistant. Ask me anything about your vehicles, trips, faults, drivers, or zones. You can also use the mic button to speak. Say "play the demo" for a guided tour!</p>
        </div>
    `;

    // Clear server-side session
    try {
        await fetch("/api/chat/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: chatSessionId }),
        });
    } catch (e) { /* ignore */ }

    // New session
    chatSessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
}


// ── Voice Input (Web Speech API) ───────────────────────────────────────

function initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        const btn = document.getElementById("micBtn");
        btn.classList.add("disabled");
        btn.title = "Speech recognition not supported in this browser";
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
        const input = document.getElementById("chatInput");
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                final += transcript;
            } else {
                interim += transcript;
            }
        }
        if (final) {
            input.value = final;
            stopVoice();
            sendMessage();
        } else {
            input.value = interim;
        }
    };

    recognition.onerror = (event) => {
        stopVoice();
        if (event.error === "not-allowed") {
            appendMessage("error", "Microphone access denied. Please allow mic permissions and try again.");
            document.getElementById("micBtn").classList.add("disabled");
        }
    };

    recognition.onend = () => {
        if (isRecording) stopVoice();
    };
}

function toggleVoice() {
    if (isRecording) {
        stopVoice();
    } else {
        startVoice();
    }
}

function startVoice() {
    if (!recognition) {
        appendMessage("error", "Speech recognition is not supported in your browser. Please use text input.");
        return;
    }
    if (document.getElementById("micBtn").classList.contains("disabled")) return;

    try {
        recognition.start();
        isRecording = true;
        document.getElementById("micBtn").classList.add("recording");
        document.getElementById("chatInput").placeholder = "Listening...";
    } catch (e) {
        // Already started
    }
}

function stopVoice() {
    if (recognition) {
        try { recognition.stop(); } catch (e) { /* ignore */ }
    }
    isRecording = false;
    document.getElementById("micBtn").classList.remove("recording");
    document.getElementById("chatInput").placeholder = "Ask about your fleet...";
}


// ── TTS (Text-to-Speech) ──────────────────────────────────────────────

function speakResponse(text) {
    // During demo — skip TTS for tool call responses to avoid overlapping
    // with the narrator. The response text is already visible in the chat bubble.
    if (typeof demoRunning !== "undefined" && demoRunning) {
        return;
    }

    if (!window.speechSynthesis) return;
    // Only speak short responses to avoid long robot monologues
    if (text.length > 500) return;

    // Strip markdown-ish formatting for cleaner speech
    const clean = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 0.8;
    speechSynthesis.speak(utterance);
}


// ── Chat Event Listeners ──────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    // Enter key to send
    const chatInput = document.getElementById("chatInput");
    if (chatInput) {
        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    // Initialize voice recognition
    initVoice();

    // Restore theme preference
    const savedTheme = localStorage.getItem("fleet-theme") || "dark";
    applyTheme(savedTheme);
});


// ── Theme Toggle ──────────────────────────────────────────────────────

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    // Update map styles if map is initialized
    if (map) {
        map.setOptions({ styles: theme === "light" ? MAP_STYLES_LIGHT : MAP_STYLES_DARK });
    }
    // Update theme toggle icon
    const btn = document.getElementById("themeToggleBtn");
    if (btn) {
        btn.innerHTML = theme === "light"
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
        btn.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    }
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem("fleet-theme", next);
    applyTheme(next);
}
