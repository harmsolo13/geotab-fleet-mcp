/**
 * Demo Automation Script — GeotabVibe Fleet Command Center
 * Orchestrates a ~3-minute automated tour with TTS narration.
 * Each step speaks the narration, shows it in chat, then executes the action.
 * Trigger: say "play the demo" in chat, ?demo=1 URL param, or runDemo().
 */

let demoRunning = false;
let demoTimeouts = [];
let demoOverlayEl = null;
let demoStepIndex = 0;
let demoChatShifted = false;

// ── Chat Position Helper ──────────────────────────────────────────────

function demoChatLeft() {
    if (demoChatShifted) return;
    const panel = document.querySelector(".chat-panel");
    if (panel) {
        panel.style.transition = "left 0.4s ease, transform 0.4s ease, bottom 0.4s ease, top 0.4s ease";
        panel.style.left = "380px";
        panel.style.transform = "translateX(0)";
        panel.style.bottom = "auto";
        panel.style.top = "80px";
        panel.style.maxHeight = "calc(100vh - 160px)";
        demoChatShifted = true;
    }
}

function demoChatCenter() {
    if (!demoChatShifted) return;
    const panel = document.querySelector(".chat-panel");
    if (panel) {
        panel.style.left = "50%";
        panel.style.transform = "translateX(-50%)";
        panel.style.bottom = "20px";
        panel.style.top = "";
        panel.style.maxHeight = "";
        setTimeout(() => { panel.style.transition = ""; }, 400);
        demoChatShifted = false;
    }
}

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

// ── TTS Narration (Piper via /api/tts, fallback to browser) ───────────

let demoAudio = null;
let demoPiperAvailable = null; // null = unknown, true/false after first call

function demoSpeak(text, onEnd) {
    const clean = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");

    // Try Piper first (unless we know it's unavailable)
    if (demoPiperAvailable !== false) {
        // Stop any playing audio
        if (demoAudio) { demoAudio.pause(); demoAudio = null; }
        if (window.speechSynthesis) speechSynthesis.cancel();

        fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean, speed: 1.0 }),
        })
        .then(resp => {
            if (!resp.ok) throw new Error("TTS unavailable");
            demoPiperAvailable = true;
            return resp.blob();
        })
        .then(blob => {
            const url = URL.createObjectURL(blob);
            demoAudio = new Audio(url);
            demoAudio.onended = () => {
                URL.revokeObjectURL(url);
                demoAudio = null;
                if (onEnd) onEnd();
            };
            demoAudio.onerror = () => {
                URL.revokeObjectURL(url);
                demoAudio = null;
                if (onEnd) onEnd();
            };
            demoAudio.play();
        })
        .catch(() => {
            // Piper not available — fall back to browser TTS
            demoPiperAvailable = false;
            demoSpeakBrowser(clean, onEnd);
        });
    } else {
        demoSpeakBrowser(clean, onEnd);
    }
}

function demoSpeakBrowser(text, onEnd) {
    if (!window.speechSynthesis) {
        if (onEnd) setTimeout(onEnd, 100);
        return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1;
    utterance.volume = 0.9;

    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v =>
        v.lang.startsWith("en") && (v.name.includes("Google") || v.name.includes("Natural") || v.name.includes("Samantha"))
    ) || voices.find(v => v.lang.startsWith("en") && !v.localService) || voices.find(v => v.lang.startsWith("en"));
    if (preferred) utterance.voice = preferred;

    utterance.onend = () => { if (onEnd) onEnd(); };
    utterance.onerror = () => { if (onEnd) onEnd(); };
    speechSynthesis.speak(utterance);
}

// ── Demo Step Runner ──────────────────────────────────────────────────

const DEMO_STEPS = [];

function demoStep(label, narration, action, pauseAfter) {
    DEMO_STEPS.push({ label, narration, action, pauseAfter: pauseAfter || 0 });
}

function runNextDemoStep() {
    if (!demoRunning || demoStepIndex >= DEMO_STEPS.length) {
        // Let the last speech finish before stopping
        if (window.speechSynthesis && speechSynthesis.speaking) {
            setTimeout(() => stopDemo(), 500);
        } else {
            stopDemo();
        }
        return;
    }

    const step = DEMO_STEPS[demoStepIndex];
    demoStepIndex++;

    // Show label overlay
    if (step.label) showDemoLabel(step.label);

    // Show narration in chat and open chat panel if not open
    if (step.narration) {
        if (!chatOpen) toggleChat();
        appendMessage("assistant", step.narration);
    }

    // Execute the action
    if (step.action) step.action();

    // Narrate, then after speech ends + pauseAfter, run next step
    if (step.narration) {
        demoSpeak(step.narration, () => {
            if (!demoRunning) return;
            const t = setTimeout(runNextDemoStep, step.pauseAfter);
            demoTimeouts.push(t);
        });
    } else {
        const t = setTimeout(runNextDemoStep, step.pauseAfter || 1000);
        demoTimeouts.push(t);
    }
}

// ── Stop Demo ──────────────────────────────────────────────────────

function stopDemo() {
    demoRunning = false;
    demoTimeouts.forEach(clearTimeout);
    demoTimeouts = [];
    // Stop Piper audio if playing
    if (demoAudio) { demoAudio.pause(); demoAudio = null; }
    hideDemoLabel();
    setTimeout(removeDemoOverlay, 500);
    demoChatCenter();
    showToast("Demo ended", "info", 2000);
}

// ── Define Demo Sequence (~3 minutes) ─────────────────────────────────

function buildDemoSteps() {
    DEMO_STEPS.length = 0;

    const getMovingVehicle = () => vehicles.find(v => v.speed && v.speed > 2);
    const getAnyVehicle = () => vehicles.find(v => v.latitude && v.longitude);

    // Opening
    demoStep(
        "Fleet Command Center — Live Dashboard",
        "This is GeotabVibe — a Fleet Command Center built on the Geotab SDK with Google Maps and Gemini AI. As you just saw, we can control everything by voice. Let's take a tour.",
        null,
        500
    );

    // Fleet Overview
    demoStep(
        "Fleet overview — all vehicles on map",
        "The dashboard connects to a live Geotab fleet and renders every vehicle on the map in real time. On the left, you can see fleet stats — total vehicles, how many are moving, stopped, and active faults.",
        () => fitAllVehicles(),
        500
    );

    // KPIs
    demoStep(
        "Real-time fleet stats and KPIs",
        "Below that, fleet KPIs are aggregated from trip data — total distance, trip count, idle percentage, driving hours, top speed, and exception events. These update every 60 seconds.",
        null,
        500
    );

    // Vehicle Selection
    demoStep(
        "Selecting a vehicle for detailed view",
        "Clicking a vehicle — either on the map or in the sidebar — opens a detail panel with driver info, department, make and model, VIN, odometer, engine hours, and recent trip history.",
        () => {
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) selectVehicle(v.id);
        },
        500
    );

    // Detail Panel
    demoStep(
        "Vehicle detail: driver, department, trips, faults",
        "The detail panel shows enriched data — driver names, departments, vehicle types — overlaid on live Geotab API data. Active faults for this vehicle are listed with diagnostic codes.",
        null,
        500
    );

    // Trip Replay
    demoStep(
        "Trip Replay — animated GPS trail",
        "Each trip has a replay button. This loads the raw GPS log records and draws a speed-colored path on the map. Green is slow, yellow is cruising, red is high speed.",
        () => {
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) {
                const now = new Date().toISOString();
                const week = new Date(Date.now() - 7 * 86400000).toISOString();
                startTripReplay(v.id, week, now);
            }
        },
        1000
    );

    // Replay HUD
    demoStep(
        "Replay HUD — speed, distance, time",
        "The replay plays at 5x speed with a heads-up display — real-time speed, acceleration, cumulative distance, elapsed time, average and max speed. All pre-computed for smooth playback.",
        () => {
            const speedSelect = document.getElementById("replaySpeed");
            if (speedSelect) { speedSelect.value = "5"; setReplaySpeed("5"); }
            playReplay();
        },
        8000
    );

    // Speed Coloring
    demoStep(
        "Speed-colored path visualization",
        "You can pause, scrub, and change playback speed. The marker and path segments update color instantly based on the vehicle's speed at each GPS point.",
        () => pauseReplay(),
        500
    );

    // Activity Heatmap
    demoStep(
        "Activity Heatmap — fleet density",
        "The activity heatmap visualizes fleet density using vehicle positions with weighted clusters — showing depot areas, route corridors, and hotspot hubs across the fleet's operating area.",
        () => {
            closeReplay();
            closeDetail();
            toggleHeatmap();
        },
        500
    );

    // Fleet Report — close chat, open slide out
    demoStep(
        "Fleet Report — AI-powered analysis",
        "The Report button opens a resizable slide out panel. It queries Geotab's Ace AI for fleet insights, then passes the data to Gemini 3 to generate a styled executive report. This takes a few moments while the AI processes the fleet data.",
        () => {
            if (heatmapVisible) toggleHeatmap();
            openSlideout("report");
        },
        2000
    );

    // Show resize while report loads
    demoStep(
        "Resizable slide out panel",
        "The slide out panel is resizable — drag the left edge to adjust the width. This works for both the report and the guide. Let's wait for the AI to finish generating the report.",
        () => {
            // Animate resize to demonstrate
            const panel = document.getElementById("slideoutPanel");
            if (panel) {
                const origWidth = panel.offsetWidth;
                panel.style.transition = "width 0.6s ease";
                panel.style.width = "650px";
                setTimeout(() => {
                    panel.style.width = origWidth + "px";
                    setTimeout(() => { panel.style.transition = ""; }, 700);
                }, 1500);
            }
        },
        8000
    );

    // Report Content
    demoStep(
        "Report: KPIs, analysis, recommendations",
        "The report includes an executive summary, fleet overview with KPIs, top performers, anomalies and concerns, Ace AI analysis, and actionable recommendations.",
        null,
        500
    );

    // Report Actions — scroll through
    demoStep(
        "Report actions: print, save, export",
        "You can print the report, save it as HTML, or export to PDF — all from the action buttons at the top.",
        () => {
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
        },
        500
    );

    // User Guide
    demoStep(
        "User Guide — full documentation",
        "Switching to the Guide tab loads the complete user guide inside the same slide out panel — covering every feature, control, and keyboard shortcut. No need to leave the dashboard.",
        () => switchSlideoutTab("guide"),
        1000
    );

    // Scroll guide
    demoStep(
        "Comprehensive guide: 10 sections",
        "The guide covers fleet stats, KPIs, map controls, vehicle detail panel, trip replay, reports, the chat assistant, themes, and tips. Everything stays in context.",
        () => {
            const body = document.getElementById("slideoutBody");
            if (body) {
                let scrollPos = 0;
                const scrollInterval = setInterval(() => {
                    scrollPos += 4;
                    body.scrollTop = scrollPos;
                    if (scrollPos >= 600 || !demoRunning) {
                        clearInterval(scrollInterval);
                    }
                }, 30);
            }
        },
        500
    );

    // Pop-out
    demoStep(
        "Pop-out: standalone tab for sharing",
        "The pop-out button opens either the report or the guide in a standalone browser tab for sharing or printing separately.",
        null,
        500
    );

    // Fleet Assistant — close slide out, open chat
    demoStep(
        "Fleet Assistant — AI chat with Gemini",
        "The Fleet Assistant is a conversational AI powered by Gemini with function calling. It has access to 12 Geotab API tools — vehicles, trips, faults, drivers, zones, fuel transactions, exceptions, and Ace AI.",
        () => {
            closeSlideout();
            if (!chatOpen) toggleChat();
        },
        500
    );

    // Chat Query
    demoStep(
        "Asking: Which vehicles are moving?",
        "Asking 'which vehicles are moving right now' triggers a function call to the Geotab API. Gemini retrieves the data and responds conversationally with specific vehicle names and speeds.",
        () => {
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Which vehicles are moving right now?";
                sendMessage();
            }
        },
        10000
    );

    // Action Commands
    demoStep(
        "Action: Create a geofence zone",
        "The assistant can also take actions. Asking it to create a geofence triggers a zone creation function call. The zone appears on the map immediately.",
        () => {
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Create a geofence called Demo Zone at 43.65, -79.38";
                sendMessage();
            }
        },
        10000
    );

    // Solo Mode
    demoStep(
        "Solo Mode — isolate a single vehicle",
        "Solo mode isolates a single vehicle — hiding all other markers from the map. Useful for focused tracking during operations or incident review.",
        () => {
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) {
                selectVehicle(v.id);
                setTimeout(() => toggleSoloMode(), 500);
            }
        },
        500
    );

    // Theme Toggle
    demoStep(
        "Theme Toggle — light and dark modes",
        "The dashboard supports light and dark themes. The map styles, sidebar, panels, and all components adapt seamlessly.",
        () => {
            if (soloMode) toggleSoloMode();
            closeDetail();
            toggleTheme();
        },
        3000
    );

    // Toggle back
    demoStep(
        null,
        null,
        () => toggleTheme(),
        1000
    );

    // Final View — this is the last narrated step
    demoStep(
        "GeotabVibe — Fleet Command Center",
        "Fit All brings every vehicle back into view. That's GeotabVibe — real-time fleet visualization, AI-powered analysis, conversational control, and trip replay — all in one dashboard. Thank you for watching.",
        () => fitAllVehicles(),
        5000
    );
}

// ── Main Entry Point ──────────────────────────────────────────────────

function runDemo() {
    if (demoRunning) { stopDemo(); return; }
    demoRunning = true;
    demoStepIndex = 0;
    demoTimeouts = [];
    createDemoOverlay();
    showToast("Demo starting — sit back and watch!", "info", 3000);

    // Ensure voices are loaded (some browsers load async)
    if (window.speechSynthesis) {
        speechSynthesis.getVoices();
    }

    buildDemoSteps();

    // Open chat panel and shift left so map features stay visible
    if (!chatOpen) toggleChat();
    demoChatLeft();

    // Start first step after a beat
    const t = setTimeout(runNextDemoStep, 2000);
    demoTimeouts.push(t);
}

// ── Auto-start on ?demo=1 ────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    // Pre-load voices
    if (window.speechSynthesis) speechSynthesis.getVoices();

    if (new URLSearchParams(window.location.search).get("demo") === "1") {
        setTimeout(runDemo, 6000);
    }
});
