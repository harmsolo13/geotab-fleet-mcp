/**
 * Demo Automation Script — GeotabVibe Fleet Command Center
 * Orchestrates a ~3-minute automated tour showcasing all features.
 * Trigger: ?demo=1 URL param or call runDemo() from console.
 */

let demoRunning = false;
let demoTimeouts = [];
let demoOverlayEl = null;

// ── Demo Overlay ──────────────────────────────────────────────────────

function createDemoOverlay() {
    if (demoOverlayEl) return;
    demoOverlayEl = document.createElement("div");
    demoOverlayEl.id = "demoOverlay";
    demoOverlayEl.style.cssText = `
        position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
        z-index: 100; padding: 12px 28px; border-radius: 12px;
        background: rgba(10, 14, 26, 0.85); backdrop-filter: blur(12px);
        border: 1px solid rgba(74, 158, 255, 0.3);
        color: #e8ecf4; font-family: 'Inter', sans-serif; font-size: 15px;
        font-weight: 600; text-align: center; opacity: 0;
        transition: opacity 0.4s ease; pointer-events: none;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
        max-width: 600px; white-space: nowrap;
    `;
    document.body.appendChild(demoOverlayEl);
}

function showDemoLabel(text) {
    if (!demoOverlayEl) createDemoOverlay();
    demoOverlayEl.textContent = text;
    demoOverlayEl.style.opacity = "1";
}

function hideDemoLabel() {
    if (demoOverlayEl) demoOverlayEl.style.opacity = "0";
}

function removeDemoOverlay() {
    if (demoOverlayEl) {
        demoOverlayEl.remove();
        demoOverlayEl = null;
    }
}

// ── Demo Step Scheduler ──────────────────────────────────────────────

function demoAt(delayMs, label, action) {
    const t = setTimeout(() => {
        if (!demoRunning) return;
        if (label) showDemoLabel(label);
        if (action) action();
    }, delayMs);
    demoTimeouts.push(t);
}

// ── Stop Demo ──────────────────────────────────────────────────────

function stopDemo() {
    demoRunning = false;
    demoTimeouts.forEach(clearTimeout);
    demoTimeouts = [];
    hideDemoLabel();
    setTimeout(removeDemoOverlay, 500);
    showToast("Demo ended", "info", 2000);
}

// ── Main Demo Sequence (~3 minutes) ──────────────────────────────────

function runDemo() {
    if (demoRunning) { stopDemo(); return; }
    demoRunning = true;
    demoTimeouts = [];
    createDemoOverlay();
    showToast("Demo starting — sit back and watch!", "info", 3000);

    // Helper: find first moving vehicle
    const getMovingVehicle = () => vehicles.find(v => v.speed && v.speed > 2);
    const getAnyVehicle = () => vehicles.find(v => v.latitude && v.longitude);

    // 0:00 — Dashboard loads (already loaded)
    demoAt(0, "Fleet Command Center — Live Dashboard", null);

    // 0:05 — Fit all vehicles
    demoAt(5000, "Fleet overview — all vehicles on map", () => {
        fitAllVehicles();
    });

    // 0:12 — Highlight stats
    demoAt(12000, "Real-time fleet stats: vehicles, faults, KPIs", null);

    // 0:18 — Select a vehicle (moving first, else any)
    demoAt(18000, "Selecting a vehicle for detailed view", () => {
        const v = getMovingVehicle() || getAnyVehicle();
        if (v) selectVehicle(v.id);
    });

    // 0:25 — Show detail panel content
    demoAt(25000, "Vehicle detail: driver, department, trips, faults", null);

    // 0:33 — Start trip replay
    demoAt(33000, "Trip Replay — animated GPS trail with speed colors", () => {
        const v = getMovingVehicle() || getAnyVehicle();
        if (v) {
            // Use last 7 days of trips
            const now = new Date().toISOString();
            const week = new Date(Date.now() - 7 * 86400000).toISOString();
            startTripReplay(v.id, week, now);
        }
    });

    // 0:38 — Start playing replay
    demoAt(38000, "Playing trip at 5x speed — watch the HUD", () => {
        const speedSelect = document.getElementById("replaySpeed");
        if (speedSelect) { speedSelect.value = "5"; setReplaySpeed("5"); }
        playReplay();
    });

    // 0:55 — Pause replay, show HUD
    demoAt(55000, "Speed-colored path: green=slow, yellow=normal, red=fast", () => {
        pauseReplay();
    });

    // 1:02 — Close replay, toggle heatmap
    demoAt(62000, "Activity Heatmap — fleet density visualization", () => {
        closeReplay();
        closeDetail();
        toggleHeatmap();
    });

    // 1:12 — Disable heatmap, open report
    demoAt(72000, "Fleet Report — AI-powered executive analysis", () => {
        if (heatmapVisible) toggleHeatmap();
        openSlideout("report");
    });

    // 1:25 — Show report loaded
    demoAt(85000, "Report includes KPIs, vehicle activity, Ace AI insights", null);

    // 1:38 — Scroll report body
    demoAt(98000, "Scrolling through report content", () => {
        const body = document.getElementById("slideoutBody");
        if (body) {
            let scrollPos = 0;
            const scrollInterval = setInterval(() => {
                scrollPos += 3;
                body.scrollTop = scrollPos;
                if (scrollPos >= body.scrollHeight - body.clientHeight || !demoRunning) {
                    clearInterval(scrollInterval);
                }
            }, 30);
        }
    });

    // 1:48 — Switch to guide tab
    demoAt(108000, "User Guide — in-panel documentation", () => {
        switchSlideoutTab("guide");
    });

    // 1:55 — Pop out
    demoAt(115000, "Pop-out opens content in a new browser tab", () => {
        // Don't actually pop out in demo — just show the button
        hideDemoLabel();
        setTimeout(() => showDemoLabel("Pop-out button: opens report or guide standalone"), 300);
    });

    // 2:00 — Close slideout, open chat
    demoAt(120000, "Fleet Assistant — AI chat with function calling", () => {
        closeSlideout();
        if (!chatOpen) toggleChat();
    });

    // 2:08 — Send a chat message
    demoAt(128000, "Asking: Which vehicles are moving right now?", () => {
        const input = document.getElementById("chatInput");
        if (input) {
            input.value = "Which vehicles are moving right now?";
            sendMessage();
        }
    });

    // 2:22 — Send zone creation command
    demoAt(142000, "Action command: Create a geofence zone", () => {
        const input = document.getElementById("chatInput");
        if (input) {
            input.value = "Create a geofence called Demo Zone at 43.65, -79.38";
            sendMessage();
        }
    });

    // 2:35 — Toggle solo mode
    demoAt(155000, "Solo Mode — isolate a single vehicle", () => {
        const v = getMovingVehicle() || getAnyVehicle();
        if (v) {
            selectVehicle(v.id);
            setTimeout(() => toggleSoloMode(), 500);
        }
    });

    // 2:42 — Toggle theme
    demoAt(162000, "Theme Toggle — light mode", () => {
        if (!soloMode) {} // solo might have been toggled off
        toggleSoloMode(); // disable solo
        closeDetail();
        toggleTheme();
    });

    // 2:48 — Toggle back to dark
    demoAt(168000, "Theme Toggle — back to dark mode", () => {
        toggleTheme();
    });

    // 2:52 — Fit all
    demoAt(172000, "Fit All — complete fleet overview", () => {
        fitAllVehicles();
    });

    // 2:57 — End
    demoAt(177000, "GeotabVibe — Fleet Command Center", () => {
        hideDemoLabel();
    });

    // 3:02 — Cleanup
    demoAt(182000, null, () => {
        stopDemo();
    });
}

// ── Auto-start on ?demo=1 ────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
        // Wait for data to load before starting demo
        setTimeout(runDemo, 6000);
    }
});
