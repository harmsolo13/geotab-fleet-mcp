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

// ── TTS Narration (Gemini via /api/tts, fallback to browser) ───────────

let demoAudio = null;
const _ttsCache = new Map(); // "voice:text" → Blob

function _ttsCacheKey(text, voice) {
    return voice + ":" + text;
}

// Collect all demo narration lines for pre-caching
function _collectDemoLines(extraLines) {
    const lines = [...(extraLines || [])];
    if (DEMO_STEPS.length) {
        for (const step of DEMO_STEPS) {
            if (step.narration) {
                const clean = step.narration.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");
                lines.push({ text: clean, voice: "narrator" });
            }
        }
    }
    return lines;
}

// Pre-cache audio into client-side blob cache (for lines already on server disk)
function demoPreCacheAudio(extraLines) {
    const lines = _collectDemoLines(extraLines);
    // Fetch all from server — pre-recorded lines return instantly from disk
    for (const { text, voice } of lines) {
        const key = _ttsCacheKey(text, voice);
        if (_ttsCache.has(key)) continue;
        _ttsCache.set(key, null); // placeholder
        fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice }),
        })
        .then(resp => resp.ok ? resp.blob() : null)
        .then(blob => { if (blob) _ttsCache.set(key, blob); })
        .catch(() => { _ttsCache.delete(key); });
    }
}

// Pre-record all narrator lines to server disk via warmup endpoint
// Call this once before demo — lines persist across restarts
function demoWarmUp() {
    if (!DEMO_STEPS.length) buildDemoSteps();
    const lines = _collectDemoLines([]);
    // Add the AI intro line
    const introClean = "Starting the Fleet Command Center demo. Sit back and enjoy the tour! Leda from Google Gemini will run you through the functions of the system.";
    lines.push({ text: introClean, voice: "assistant" });

    showToast("Pre-recording demo voices...", "info", 60000);
    fetch("/api/tts/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
    })
    .then(resp => resp.json())
    .then(data => {
        showToast(`Voices ready: ${data.cached} cached, ${data.generated} generated, ${data.failed} failed`, "success", 5000);
    })
    .catch(err => {
        showToast("Warmup failed: " + err.message, "error", 5000);
    });
}

function demoSpeak(text, onEnd, voice) {
    const clean = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");
    const voiceName = voice || "narrator";

    // Stop any playing audio
    if (demoAudio) { demoAudio.pause(); demoAudio = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();

    // Check pre-cache first for instant playback
    const key = _ttsCacheKey(clean, voiceName);
    const cached = _ttsCache.get(key);
    if (cached) {
        _playBlob(cached, onEnd);
        return;
    }

    // If placeholder exists (in-flight), wait up to 15s for it
    if (_ttsCache.has(key) && cached === null) {
        let waited = 0;
        const pollCache = () => {
            const blob = _ttsCache.get(key);
            if (blob) { _playBlob(blob, onEnd); return; }
            waited += 300;
            if (waited < 15000) { setTimeout(pollCache, 300); return; }
            // Timed out — fetch directly
            _fetchAndPlay(clean, voiceName, key, onEnd);
        };
        setTimeout(pollCache, 300);
        return;
    }

    // Not cached — fetch and play
    _fetchAndPlay(clean, voiceName, key, onEnd);
}

function _fetchAndPlay(text, voice, key, onEnd) {
    fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
    })
    .then(resp => {
        if (!resp.ok) throw new Error("TTS unavailable");
        return resp.blob();
    })
    .then(blob => {
        _ttsCache.set(key, blob);
        _playBlob(blob, onEnd);
    })
    .catch(() => {
        demoSpeakBrowser(text, onEnd);
    });
}

function _playBlob(blob, onEnd) {
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
}

// Speak with the AI assistant voice (used for chat responses during demo)
function demoSpeakAI(text, onEnd) {
    demoSpeak(text, onEnd, "assistant");
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
    // Default 1s gap after narrated steps for natural pacing
    const pause = (pauseAfter != null && pauseAfter > 0) ? pauseAfter : (narration ? 1000 : 0);
    DEMO_STEPS.push({ label, narration, action, pauseAfter: pause });
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

    // If step has a waitFor condition, poll until it's met before advancing
    if (step.waitFor) {
        const started = Date.now();
        const maxWait = step.waitTimeout || 45000;
        const pollWait = () => {
            if (!demoRunning) return;
            if (step.waitFor() || Date.now() - started > maxWait) {
                runNextDemoStep();
            } else {
                const t = setTimeout(pollWait, 1000);
                demoTimeouts.push(t);
            }
        };
        // Start polling after narration finishes (or immediately if no narration)
        if (step.narration) {
            demoSpeak(step.narration, () => {
                if (!demoRunning) return;
                const t = setTimeout(pollWait, step.pauseAfter);
                demoTimeouts.push(t);
            });
        } else {
            const t = setTimeout(pollWait, 500);
            demoTimeouts.push(t);
        }
        return;
    }

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
        "Thank you. This is GeotabVibe — a Fleet Command Center built on the Geotab SDK with Google Maps and Gemini AI. As you just saw, we can control everything by voice. Let's take a tour.",
        null,
        0
    );

    // Fleet Overview
    demoStep(
        "Fleet overview — all vehicles on map",
        "The dashboard connects to a live Geotab fleet and renders every vehicle on the map in real time. On the left, you can see fleet stats — total vehicles, how many are moving, stopped, and active faults.",
        () => fitAllVehicles(),
        0
    );

    // KPIs
    demoStep(
        "Real-time fleet stats and KPIs",
        "Below that, fleet KPIs are aggregated from trip data — total distance, trip count, idle percentage, driving hours, top speed, and exception events. These update every 60 seconds.",
        null,
        0
    );

    // Vehicle Selection
    demoStep(
        "Selecting a vehicle for detailed view",
        "Clicking a vehicle — either on the map or in the sidebar — opens a detail panel with driver info, department, make and model, VIN, odometer, engine hours, and recent trip history.",
        () => {
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) selectVehicle(v.id);
        },
        0
    );

    // Detail Panel
    demoStep(
        "Vehicle detail: driver, department, trips, faults",
        "The detail panel shows enriched data — driver names, departments, vehicle types — overlaid on live Geotab API data. Active faults for this vehicle are listed with diagnostic codes.",
        null,
        0
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
        500
    );

    // Replay HUD
    demoStep(
        "Replay HUD — speed, distance, time",
        "The replay plays at 5 times speed with a heads-up display — real-time speed, acceleration, cumulative distance, elapsed time, average and max speed. All pre-computed for smooth playback.",
        () => {
            const speedSelect = document.getElementById("replaySpeed");
            if (speedSelect) { speedSelect.value = "5"; setReplaySpeed("5"); }
            playReplay();
        },
        1500
    );

    // Speed Coloring
    demoStep(
        "Speed-colored path visualization",
        "You can pause, scrub, and change playback speed. The marker and path segments update color instantly based on the vehicle's speed at each GPS point.",
        () => pauseReplay(),
        0
    );

    // Activity Heatmap — before report so map is visible
    demoStep(
        "Activity Heatmap — fleet density",
        "The activity heatmap visualizes fleet density using vehicle positions with weighted clusters — showing depot areas, route corridors, and hotspot hubs across the fleet's operating area.",
        () => {
            closeReplay();
            closeDetail();
            toggleHeatmap();
        },
        0
    );

    // Heatmap commentary
    demoStep(
        "Heatmap: depots, corridors, hotspots",
        "Bright spots indicate depot areas and frequent stops. The gradient trails reveal common route corridors and delivery clusters. This uses real trip stop data from the fleet.",
        null,
        0
    );

    // Fleet Report — open slideout, keep it open, show resize while it generates
    demoStep(
        "Fleet Report — AI-powered analysis",
        "Now let's generate the fleet report. This queries Geotab's Ace AI for fleet insights, then passes the data to Gemini 3 to generate a styled executive report.",
        () => {
            if (heatmapVisible) toggleHeatmap();
            openSlideout("report");
        },
        500
    );

    // Resize the panel silently, then comment on it
    demoStep(
        "Resizable slide out panel",
        null,
        () => {
            const panel = document.getElementById("slideoutPanel");
            if (panel) {
                panel.style.transition = "width 0.6s ease";
                panel.style.width = "650px";
                setTimeout(() => { panel.style.transition = ""; }, 700);
            }
        },
        800
    );
    demoStep(
        null,
        "Note we have resized the panel to allow the report to be viewed easier. The slide out panel is fully resizable by dragging the left edge. This works for both the report and the guide.",
        null,
        0
    );

    // Poll until report is actually done
    DEMO_STEPS.push({
        label: "Generating report...",
        narration: null,
        action: null,
        pauseAfter: 0,
        waitFor: () => {
            const body = document.getElementById("slideoutBody");
            if (!body) return true;
            return !body.querySelector(".report-spinner");
        },
        waitTimeout: 90000
    });

    // Report Content
    demoStep(
        "Report: KPIs, analysis, recommendations",
        "The report includes an executive summary, fleet overview with KPIs, top performers, anomalies and concerns, Ace AI analysis, and actionable recommendations.",
        null,
        0
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
        0
    );

    // User Guide
    demoStep(
        "User Guide — full documentation",
        "Switching to the Guide tab loads the complete user guide inside the same slide out panel — covering every feature, control, and keyboard shortcut. No need to leave the dashboard.",
        () => switchSlideoutTab("guide"),
        0
    );

    // Scroll guide — scroll all the way to the bottom
    demoStep(
        "Comprehensive guide: 10 sections",
        "The guide covers fleet stats, KPIs, map controls, vehicle detail panel, trip replay, reports, the chat assistant, themes, and tips. Everything stays in context.",
        () => {
            const body = document.getElementById("slideoutBody");
            if (body) {
                let scrollPos = 0;
                const maxScroll = body.scrollHeight - body.clientHeight;
                const scrollInterval = setInterval(() => {
                    scrollPos += 6;
                    body.scrollTop = scrollPos;
                    if (scrollPos >= maxScroll || !demoRunning) {
                        clearInterval(scrollInterval);
                    }
                }, 20);
            }
        },
        0
    );

    // Pop-out
    demoStep(
        "Pop-out: standalone tab for sharing",
        "The pop-out button opens either the report or the guide in a standalone browser tab for sharing or printing separately.",
        null,
        0
    );

    // Fleet Assistant — close slide out, open chat
    demoStep(
        "Fleet Assistant — AI chat with Gemini",
        "The Fleet Assistant is a conversational AI powered by Gemini with function calling. It has access to 12 Geotab API tools — vehicles, trips, faults, drivers, zones, fuel transactions, exceptions, and Ace AI.",
        () => {
            closeSlideout();
            if (!chatOpen) toggleChat();
        },
        0
    );

    // Chat Query — send and wait for response
    // Track ASSISTANT bubble count to detect when AI responds (not user bubbles)
    demoStep(
        "Asking: Which vehicles are moving?",
        "Asking 'which vehicles are moving right now' triggers a function call to the Geotab API. Gemini retrieves the data and responds conversationally with specific vehicle names and speeds.",
        () => {
            // Reset chatSending guard in case a prior call is stuck
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Which vehicles are moving right now?";
                sendMessage();
            }
        },
        0
    );

    // Wait for a new ASSISTANT message + AI voice to finish
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            const hasNewResponse = assistantBubbles.length > (window._demoAssistantCount || 0);
            const audioFinished = !demoAudio && !(window.speechSynthesis && speechSynthesis.speaking);
            return hasNewResponse && audioFinished;
        },
        waitTimeout: 90000
    });

    // Safety query — exception events
    demoStep(
        "Asking: Any speeding violations?",
        "Now asking about speeding violations. This calls the exception events API to retrieve rule violations from the fleet.",
        () => {
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Any speeding violations this week?";
                sendMessage();
            }
        },
        0
    );

    // Wait for safety response
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            const hasNewResponse = assistantBubbles.length > (window._demoAssistantCount || 0);
            const audioFinished = !demoAudio && !(window.speechSynthesis && speechSynthesis.speaking);
            return hasNewResponse && audioFinished;
        },
        waitTimeout: 90000
    });

    // Send driver message — action command
    demoStep(
        "Action: Send message to driver",
        "The assistant can send messages directly to in-cab devices. This triggers a text message function call to the vehicle's Geotab GO device.",
        () => {
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Send a message to Demo - 01 saying please return to depot";
                sendMessage();
            }
        },
        0
    );

    // Wait for message response
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            const hasNewResponse = assistantBubbles.length > (window._demoAssistantCount || 0);
            const audioFinished = !demoAudio && !(window.speechSynthesis && speechSynthesis.speaking);
            return hasNewResponse && audioFinished;
        },
        waitTimeout: 90000
    });

    // Geofence creation — action command
    demoStep(
        "Action: Create a geofence zone",
        "Finally, asking it to create a geofence triggers a zone creation function call. The zone appears on the map immediately.",
        () => {
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
            const input = document.getElementById("chatInput");
            if (input) {
                input.value = "Create a geofence called Demo Zone at 43.65, -79.38";
                sendMessage();
            }
        },
        0
    );

    // Wait for geofence response + AI voice to finish
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            const hasNewResponse = assistantBubbles.length > (window._demoAssistantCount || 0);
            const audioFinished = !demoAudio && !(window.speechSynthesis && speechSynthesis.speaking);
            return hasNewResponse && audioFinished;
        },
        waitTimeout: 90000
    });

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
        0
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
        1500
    );

    // Toggle back
    demoStep(
        null,
        null,
        () => toggleTheme(),
        500
    );

    // Final View — this is the last narrated step
    demoStep(
        "GeotabVibe — Fleet Command Center",
        "That's GeotabVibe — real-time fleet visualization, AI-powered analysis, conversational control, and trip replay — all in one dashboard. All actions were completed live by the AI while recording and running this demo. This demo can be triggered at any time by saying 'play the demo' in the chat. Thank you for watching.",
        () => fitAllVehicles(),
        3000
    );
}

// ── Main Entry Point ──────────────────────────────────────────────────

function runDemo() {
    if (demoRunning) { stopDemo(); return; }
    demoRunning = true;
    demoStepIndex = 0;
    demoTimeouts = [];
    createDemoOverlay();

    // Build steps if not already built by pre-cache
    if (!DEMO_STEPS.length) buildDemoSteps();

    // Pre-warm API caches so chat queries are instant
    fetch("/api/vehicles").catch(() => {});
    fetch("/api/faults").catch(() => {});
    fetch("/api/fleet-kpis").catch(() => {});

    // Open chat panel and shift left so map features stay visible
    if (!chatOpen) toggleChat();
    demoChatLeft();

    // Start immediately — the AI intro voice has already played
    runNextDemoStep();
}

// ── Auto-start on ?demo=1 ────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    // Pre-load voices
    if (window.speechSynthesis) speechSynthesis.getVoices();

    if (new URLSearchParams(window.location.search).get("demo") === "1") {
        setTimeout(runDemo, 6000);
    }
});
