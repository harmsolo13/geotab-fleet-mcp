/**
 * Fleet Map — Google Maps integration with real-time vehicle tracking
 */

let map;
let markers = {};       // device_id -> AdvancedMarkerElement
let zonePolygons = [];  // Google Maps Polygon overlays
let tripPolylines = []; // Google Maps Polyline overlays
let vehicles = [];      // Current vehicle data
let faults = [];        // Current fault data
let selectedVehicle = null;
let refreshTimer = null;

// Chat state
let chatSessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
let chatOpen = false;
let chatSending = false;
let recognition = null;
let isRecording = false;

const REFRESH_INTERVAL = 10000; // 10 seconds
const DEFAULT_CENTER = { lat: 43.6532, lng: -79.3832 }; // Toronto (Geotab HQ)
const DEFAULT_ZOOM = 12;

// Map styling — dark theme
const MAP_STYLES = [
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


// ── Map Initialization ──────────────────────────────────────────────────

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        styles: MAP_STYLES,
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        mapId: "fleet-dashboard-map",
    });

    // Load initial data
    loadVehicles();
    loadZones();
    loadFaults();

    // Start auto-refresh
    refreshTimer = setInterval(() => {
        loadVehicles();
        loadFaults();
    }, REFRESH_INTERVAL);
}


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
    } catch (err) {
        console.error("Failed to load vehicles:", err);
        updateConnectionBadge(false);
    }
}

async function loadZones() {
    try {
        const resp = await fetch("/api/zones");
        const data = await resp.json();
        if (data.zones) {
            drawZones(data.zones);
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


// ── Map Markers ─────────────────────────────────────────────────────────

function updateMarkers() {
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

        if (markers[v.id]) {
            // Update existing marker position
            markers[v.id].position = pos;
            // Update content
            const el = markers[v.id].content;
            if (el) {
                el.className = `map-marker ${status}`;
                el.querySelector(".marker-label").textContent = v.name || v.id;
            }
        } else {
            // Create new marker
            const markerEl = document.createElement("div");
            markerEl.className = `map-marker ${status}`;
            markerEl.innerHTML = `
                <span class="marker-dot"></span>
                <span class="marker-label">${v.name || v.id}</span>
            `;

            const marker = new google.maps.marker.AdvancedMarkerElement({
                map: map,
                position: pos,
                content: markerEl,
                title: v.name || v.id,
            });

            marker.addListener("click", () => selectVehicle(v.id));
            markers[v.id] = marker;
        }
    });

    // Fit map to show all markers on first load
    if (hasValidBounds && Object.keys(markers).length === validVehicles.length && !selectedVehicle) {
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

function drawZones(zones) {
    // Clear existing
    zonePolygons.forEach(p => p.setMap(null));
    zonePolygons = [];

    zones.forEach(zone => {
        if (!zone.centroid) return;

        // We only have centroids, draw a circle marker
        const circle = new google.maps.Circle({
            map: map,
            center: { lat: zone.centroid.y, lng: zone.centroid.x },
            radius: 300, // approximate
            fillColor: "#f87171",
            fillOpacity: 0.1,
            strokeColor: "#f87171",
            strokeWeight: 1.5,
            strokeOpacity: 0.4,
            clickable: false,
        });
        zonePolygons.push(circle);
    });
}


// ── Trip Drawing ────────────────────────────────────────────────────────

function drawTrips(trips) {
    // Clear existing
    tripPolylines.forEach(p => p.setMap(null));
    tripPolylines = [];

    trips.forEach(trip => {
        const points = [];
        // Trips have stopPoint — draw point-to-point lines
        if (trip.stopPoint && trip.stopPoint.x != null) {
            points.push({ lat: trip.stopPoint.y, lng: trip.stopPoint.x });
        }

        if (points.length > 0) {
            const marker = new google.maps.Marker({
                map: map,
                position: points[0],
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 5,
                    fillColor: "#4a9eff",
                    fillOpacity: 0.8,
                    strokeColor: "#4a9eff",
                    strokeWeight: 1,
                },
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

    // Pan map to vehicle
    if (vehicle.latitude && vehicle.longitude) {
        map.panTo({ lat: vehicle.latitude, lng: vehicle.longitude });
        map.setZoom(15);
    }

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
        <h2>${vehicle.name || vehicle.id}</h2>
        <p class="detail-subtitle" style="color: ${statusColor}">${statusLabel}
            ${vehicle.speed ? ` &mdash; ${vehicle.speed.toFixed(1)} km/h` : ""}
        </p>

        <div class="detail-row"><span class="label">Device ID</span><span class="value">${vehicle.id}</span></div>
        <div class="detail-row"><span class="label">VIN</span><span class="value">${vehicle.vin || "N/A"}</span></div>
        <div class="detail-row"><span class="label">Make/Model</span><span class="value">${[vehicle.make, vehicle.model].filter(Boolean).join(" ") || "N/A"}</span></div>
        <div class="detail-row"><span class="label">Year</span><span class="value">${vehicle.year || "N/A"}</span></div>
        <div class="detail-row"><span class="label">Odometer</span><span class="value">${vehicle.odometer ? Math.round(vehicle.odometer).toLocaleString() + " km" : "N/A"}</span></div>
        <div class="detail-row"><span class="label">Engine Hours</span><span class="value">${vehicle.engineHours ? Math.round(vehicle.engineHours).toLocaleString() + " h" : "N/A"}</span></div>
        <div class="detail-row"><span class="label">Lat / Lng</span><span class="value">${vehicle.latitude?.toFixed(4) || "?"}, ${vehicle.longitude?.toFixed(4) || "?"}</span></div>
    `;

    if (deviceFaults.length > 0) {
        html += `<p class="detail-section-title">Active Faults (${deviceFaults.length})</p>`;
        deviceFaults.slice(0, 5).forEach(f => {
            html += `<div class="fault-item">
                <span class="fault-device">${f.diagnosticName || f.diagnosticId || "Unknown"}</span>
                <div class="fault-desc">${f.failureMode || ""} &mdash; ${f.dateTime || ""}</div>
            </div>`;
        });
    }

    if (trips.length > 0) {
        html += `<p class="detail-section-title">Recent Trips (${trips.length})</p>`;
        trips.slice(0, 5).forEach(t => {
            const dist = t.distance ? (t.distance / 1000).toFixed(1) + " km" : "N/A";
            html += `<div class="trip-item">
                <div class="trip-time">${formatDateTime(t.start)} &rarr; ${formatDateTime(t.stop)}</div>
                <div class="trip-meta">${dist} &mdash; Max ${t.maximumSpeed?.toFixed(0) || "?"} km/h</div>
            </div>`;
        });
    }

    content.innerHTML = html;
    panel.classList.remove("hidden");
}

function closeDetail() {
    document.getElementById("detailPanel").classList.add("hidden");
    selectedVehicle = null;

    // Clear trip overlays
    tripPolylines.forEach(p => p.setMap(null));
    tripPolylines = [];

    // Deselect list
    document.querySelectorAll(".vehicle-item.selected").forEach(el => el.classList.remove("selected"));
}


// ── Sidebar Updates ─────────────────────────────────────────────────────

function updateVehicleList() {
    const list = document.getElementById("vehicleList");
    const search = document.getElementById("vehicleSearch").value.toLowerCase();

    const filtered = vehicles.filter(v =>
        !search || (v.name || "").toLowerCase().includes(search) || (v.id || "").toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
        list.innerHTML = '<div class="loading">No vehicles found</div>';
        return;
    }

    list.innerHTML = filtered.map(v => {
        const status = getVehicleStatus(v);
        const speed = v.speed ? `${v.speed.toFixed(0)} km/h` : "";
        const meta = [v.make, v.model].filter(Boolean).join(" ") || v.vin || v.id;
        return `
            <div class="vehicle-item ${selectedVehicle === v.id ? "selected" : ""}"
                 data-id="${v.id}"
                 onclick="selectVehicle('${v.id}')">
                <span class="vehicle-dot ${status}"></span>
                <div class="vehicle-info">
                    <div class="vehicle-name">${v.name || v.id}</div>
                    <div class="vehicle-meta">${meta}</div>
                </div>
                <span class="vehicle-speed">${speed}</span>
            </div>
        `;
    }).join("");
}

function updateFaultList() {
    const list = document.getElementById("faultList");
    if (faults.length === 0) {
        list.innerHTML = '<div class="loading" style="color: #34d399">No active faults</div>';
        return;
    }

    list.innerHTML = faults.slice(0, 20).map(f => `
        <div class="fault-item">
            <span class="fault-device">${f.deviceId || "Unknown"}</span>
            <div class="fault-desc">${f.diagnosticName || f.diagnosticId || "Unknown"} &mdash; ${f.failureMode || ""}</div>
        </div>
    `).join("");
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
    setTypingIndicator(true);
    chatSending = true;

    try {
        const resp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, session_id: chatSessionId }),
        });
        const data = await resp.json();
        setTypingIndicator(false);

        if (data.error) {
            appendMessage("error", "Error: " + data.error);
        } else {
            appendMessage("assistant", data.response);
            // Update session ID if server assigned one
            if (data.session_id) chatSessionId = data.session_id;
            // Optional TTS for short responses
            speakResponse(data.response);
        }
    } catch (err) {
        setTypingIndicator(false);
        appendMessage("error", "Failed to reach the server. Please try again.");
    } finally {
        chatSending = false;
    }
}

async function clearChat() {
    const container = document.getElementById("chatMessages");
    // Keep only the welcome message
    container.innerHTML = `
        <div class="chat-bubble assistant">
            <p>Hi! I'm your fleet assistant. Ask me anything about your vehicles, trips, faults, drivers, or zones. You can also use the mic button to speak.</p>
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
});
