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
let demoTimerEl = null;
let demoTimerInterval = null;
let demoStartTime = 0;

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

// ── Demo Timer ───────────────────────────────────────────────────────

function startDemoTimer() {
    if (demoTimerEl) return;
    demoStartTime = Date.now();
    demoTimerEl = document.createElement("div");
    demoTimerEl.id = "demoTimer";
    demoTimerEl.style.cssText = `
        position: fixed; bottom: 12px; right: 12px; z-index: 101;
        padding: 6px 14px; border-radius: 8px;
        background: rgba(10, 14, 26, 0.85); backdrop-filter: blur(8px);
        border: 1px solid rgba(74, 158, 255, 0.3);
        color: #4a9eff; font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 14px; font-weight: 600; pointer-events: none;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
    `;
    demoTimerEl.textContent = "0:00";
    document.body.appendChild(demoTimerEl);
    demoTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - demoStartTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        demoTimerEl.textContent = m + ":" + String(s).padStart(2, "0");
        // Warn if approaching 3 min limit
        if (elapsed >= 170) demoTimerEl.style.color = "#f87171";
        else if (elapsed >= 150) demoTimerEl.style.color = "#fbbf24";
    }, 1000);
}

function stopDemoTimer() {
    if (demoTimerInterval) { clearInterval(demoTimerInterval); demoTimerInterval = null; }
    if (demoTimerEl) {
        // Flash final time for 5 seconds then remove
        setTimeout(() => { if (demoTimerEl) { demoTimerEl.remove(); demoTimerEl = null; } }, 5000);
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
            if (step.resultNarration) {
                const clean = step.resultNarration.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");
                lines.push({ text: clean, voice: "narrator" });
            }
            if (step.voiceQuery) {
                const clean = step.voiceQuery.replace(/\*\*/g, "").replace(/`/g, "").replace(/\n+/g, ". ");
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

    // If placeholder exists (in-flight pre-cache), don't wait — fetch directly
    // The pre-cache will populate for later steps in the background

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

// ── Chat Auto-Scroll (slow reveal for long AI responses) ─────────────

let _demoScrollTimer = null;

function demoScrollChat() {
    // Slowly scroll the chat container so the full AI response is visible
    if (_demoScrollTimer) { clearInterval(_demoScrollTimer); _demoScrollTimer = null; }
    const container = document.getElementById("chatMessages");
    if (!container) return;
    // Find the last assistant bubble
    const bubbles = container.querySelectorAll(".chat-bubble.assistant");
    const lastBubble = bubbles[bubbles.length - 1];
    if (!lastBubble) return;
    // Scroll so the TOP of the response is visible first
    const bubbleTop = lastBubble.offsetTop - container.offsetTop - 10;
    container.scrollTop = Math.max(0, bubbleTop);
    // Then slowly scroll down to reveal the full response
    const targetScroll = container.scrollHeight;
    _demoScrollTimer = setInterval(() => {
        if (!demoRunning || container.scrollTop >= targetScroll - container.clientHeight) {
            clearInterval(_demoScrollTimer);
            _demoScrollTimer = null;
            return;
        }
        container.scrollTop += 2;
    }, 40);
}

function demoStopScrollChat() {
    if (_demoScrollTimer) { clearInterval(_demoScrollTimer); _demoScrollTimer = null; }
}

// ── Voice-Triggered Chat Query ────────────────────────────────────────

function demoVoiceQuery(text, callback) {
    const micBtn = document.getElementById("micBtn");
    const input = document.getElementById("chatInput");
    if (!input) { if (callback) callback(); return; }

    // Add red pulse to mic button
    if (micBtn) micBtn.classList.add("recording");

    // Speak the command text via TTS + typewriter simultaneously
    let typeDone = false;
    let speakDone = false;
    const checkDone = () => {
        if (typeDone && speakDone) {
            if (micBtn) micBtn.classList.remove("recording");
            if (callback) callback();
        }
    };

    // TTS speaks the command (narrator voice)
    demoSpeak(text, () => { speakDone = true; checkDone(); });

    // Typewriter text into input — pace matches ~40ms/char
    let i = 0;
    input.value = "";
    const typeTimer = setInterval(() => {
        if (!demoRunning) { clearInterval(typeTimer); return; }
        if (i < text.length) {
            input.value += text[i];
            i++;
        } else {
            clearInterval(typeTimer);
            typeDone = true;
            checkDone();
        }
    }, 40);
}

// ── Demo Step Runner ──────────────────────────────────────────────────

const DEMO_STEPS = [];

function demoStep(label, narration, action, pauseAfter) {
    // Default 600ms gap after narrated steps for tight pacing (voice unaffected)
    const pause = (pauseAfter != null && pauseAfter > 0) ? pauseAfter : (narration ? 600 : 0);
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
        const advanceAfterWait = () => {
            if (!demoRunning) return;
            // If resultNarration is set, narrator speaks a summary of the AI response
            if (step.resultNarration) {
                showDemoLabel("AI responded");
                // Slowly scroll through the AI response while narrator speaks
                demoScrollChat();
                demoSpeak(step.resultNarration, () => {
                    demoStopScrollChat();
                    if (!demoRunning) return;
                    const t = setTimeout(runNextDemoStep, step.pauseAfter);
                    demoTimeouts.push(t);
                });
                return;
            }
            runNextDemoStep();
        };
        const pollWait = () => {
            if (!demoRunning) return;
            if (step.waitFor() || Date.now() - started > maxWait) {
                advanceAfterWait();
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

    // If step has a voiceQuery, play narration first, then voice query, then advance
    if (step.voiceQuery) {
        const startVoiceQuery = () => {
            if (!demoRunning) return;
            demoVoiceQuery(step.voiceQuery, () => {
                if (!demoRunning) return;
                chatSending = false; // Force-reset in case prior query hasn't fully cleared
                sendMessage();
                const t = setTimeout(runNextDemoStep, step.pauseAfter || 400);
                demoTimeouts.push(t);
            });
        };
        if (step.narration) {
            demoSpeak(step.narration, startVoiceQuery);
        } else {
            startVoiceQuery();
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
        const t = setTimeout(runNextDemoStep, step.pauseAfter || 600);
        demoTimeouts.push(t);
    }
}

// ── Stop Demo ──────────────────────────────────────────────────────

function stopDemo() {
    demoRunning = false;
    demoTimeouts.forEach(clearTimeout);
    demoTimeouts = [];
    demoStopScrollChat();
    stopDemoTimer();
    // Stop Piper audio if playing
    if (demoAudio) { demoAudio.pause(); demoAudio = null; }
    hideDemoLabel();
    setTimeout(removeDemoOverlay, 500);
    demoChatCenter();
    // Reset demo-created visual state
    if (soloMode) toggleSoloMode();
    closeReplay();
    closeDetail();
    // Clear suggestion preview circles
    if (window.suggestionCircles) {
        suggestionCircles.forEach(c => { if (c) c.setMap(null); });
        suggestionCircles = [];
    }
    // Clear map overlays and reload zones
    zonePolygons.forEach(p => p.setMap(null));
    zonePolygons = [];
    loadZones(true);
    fitAllVehicles();
    showToast("Demo ended", "info", 2000);
}

// ── Define Demo Sequence (~3 minutes) ─────────────────────────────────

function buildDemoSteps() {
    DEMO_STEPS.length = 0;

    const getMovingVehicle = () => vehicles.find(v => v.speed && v.speed > 2);
    const getAnyVehicle = () => vehicles.find(v => v.latitude && v.longitude);

    // Opening + Fleet Overview (merged)
    demoStep(
        "Fleet Command Center — Live Dashboard",
        "This is the Geotab Fleet Command Center, built on the Geotab SDK with Google Maps and Gemini AI, it shows a live Geotab fleet — and renders every vehicle on the map in real time.",
        () => fitAllVehicles(),
        0
    );

    // Fleet Assistant — open chat early
    demoStep(
        "Fleet Assistant — AI chat with Gemini",
        "Starting with the Fleet Assistant, it is a conversational AI powered by Gemini with function calling. It has access to 12 Geotab API tools — including vehicles, trips, drivers, Ace AI and more. It also includes an MCP server, allowing any external AI assistant to connect and manage the fleet through natural language.",
        () => { if (!chatOpen) toggleChat(); },
        0
    );

    // Chat Query 1 — which vehicles are moving
    DEMO_STEPS.push({
        label: "Asking: Which vehicles are moving?",
        narration: "Ok, let's look at 2 chat commands. They will trigger a function call to the Geotab API. Gemini retrieves the data and responds conversationally.",
        action: () => {
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
        },
        voiceQuery: "Which vehicles are moving right now?",
        pauseAfter: 0,
    });

    // Wait for response
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            return assistantBubbles.length > (window._demoAssistantCount || 0);
        },
        resultNarration: "The assistant retrieved live fleet data and responded with the vehicles currently in motion, including their names and speeds in kilometres per hour.",
        waitTimeout: 90000
    });

    // Chat Query 2 — send driver message
    DEMO_STEPS.push({
        label: "Action: Send message to driver",
        narration: "The assistant can also send messages directly to in-cab devices, and triggers a text message function call to the vehicle's Geotab GO device.",
        action: () => {
            chatSending = false;
            window._demoAssistantCount = document.querySelectorAll("#chatMessages .chat-bubble.assistant").length;
        },
        voiceQuery: "Send a message to Demo - 01 saying please return to depot",
        pauseAfter: 0,
    });

    // Wait for message response
    DEMO_STEPS.push({
        label: "Waiting for AI response...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const assistantBubbles = document.querySelectorAll("#chatMessages .chat-bubble.assistant");
            return assistantBubbles.length > (window._demoAssistantCount || 0);
        },
        resultNarration: "Message sent successfully. The text was delivered directly to the vehicle's in-cab Geotab device via the API.",
        waitTimeout: 90000
    });

    // Fleet Stats + KPIs
    demoStep(
        "Fleet stats and KPIs",
"Now looking around the dashboard, on the left, you have the light and dark mode toggle, and then you can see fleet stats. Below that, fleet KPIs are aggregated from trip data. These update every 60 seconds. There is also a heatmap toggle for additional insights.",
        null,
        0
    );

    // Vehicle Selection + Detail
    demoStep(
        "Vehicle detail panel",
        "Clicking a vehicle — either on the map or in the sidebar — opens an enriched detail panel with unit info and recent trip history — overlaid on live Geotab API data.",
        () => {
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) selectVehicle(v.id);
        },
        0
    );

    // Solo Mode ON + Trip Replay (merged)
    demoStep(
        "Solo Mode + Trip Replay",
        "Lets quickly enter Solo Mode. Each trip has a replay button. This loads the raw GPS log records and draws a speed-colored path on the map. Green is slow, yellow is cruising, red is high speed.",
        () => {
            if (!soloMode) toggleSoloMode();
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
        "The replay plays at 5 times speed with a heads-up display with real-time trip data. All pre-computed for smooth playback.",
        () => {
            const speedSelect = document.getElementById("replaySpeed");
            if (speedSelect) { speedSelect.value = "5"; setReplaySpeed("5"); }
            playReplay();
        },
        1000
    );

    // Pause + Events Panel (merged step)
    demoStep(
        "Events Panel — vehicle activity timeline",
        "You can pause, scrub, and change playback speed. For a deeper dive, the Events panel shows a full timeline for each vehicle — Safety events like speeding, harsh braking, and collisions are color-coded and nested within their trips. And here we toggle Solo Mode off.",
        () => {
            pauseReplay();
            const v = getMovingVehicle() || getAnyVehicle();
            if (v) openEventsSlideout(v.id);
        },
        500
    );

    // Wait for events to load, scroll through
    DEMO_STEPS.push({
        label: "Loading event timeline...",
        narration: null,
        action: null,
        pauseAfter: 0,
        waitFor: () => {
            const body = document.getElementById("slideoutBody");
            if (!body) return true;
            return !body.querySelector(".loading") && body.querySelector(".ev-trip");
        },
        waitTimeout: 30000
    });

    // Scroll through events panel briefly
    demoStep(
        "Trips, stops, and safety events",
        null,
        () => {
            const body = document.getElementById("slideoutBody");
            if (body) {
                let scrollPos = 0;
                const scrollInterval = setInterval(() => {
                    scrollPos += 5;
                    body.scrollTop = scrollPos;
                    if (scrollPos >= body.scrollHeight - body.clientHeight || !demoRunning) {
                        clearInterval(scrollInterval);
                    }
                }, 25);
            }
        },
        1800
    );

    // Close events + solo mode off (silent transition)
    demoStep(
        null,
        null,
        () => {
            closeSlideout();
            if (soloMode) toggleSoloMode();
        },
        400
    );

    // Fleet Report
    demoStep(
        "Fleet Report — AI-powered analysis",
        "Now let's generate the fleet report. This queries Geotab's Ace AI for fleet insights, then passes the data to Gemini 3 to generate a styled executive report.",
        () => {
            closeReplay();
            closeDetail();
            openSlideout("report");
        },
        500
    );

    // Resize panel silently, then comment
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
        600
    );
    demoStep(
        null,
        "The slide out panel is fully resizable by dragging the left edge. This works for both the report, the guide and the event panel.",
        null,
        0
    );

    // Poll until report is done
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
        "Report: fleet data, AI analysis, recommendations",
        "The report contains detailed fleet data, Ace AI analysis, and actionable recommendations.",
        null,
        0
    );

    // Report Actions — scroll through
    demoStep(
        "Report actions: print, save, export",
        "You can print the report, save it as HTML or PDF — all from the action buttons at the top.",
        () => {
            const body = document.getElementById("slideoutBody");
            if (body) {
                let scrollPos = 0;
                const scrollInterval = setInterval(() => {
                    scrollPos += 4;
                    body.scrollTop = scrollPos;
                    if (scrollPos >= body.scrollHeight - body.clientHeight || !demoRunning) {
                        clearInterval(scrollInterval);
                    }
                }, 30);
            }
        },
        0
    );

    // User Guide + Pop-out (combined)
    demoStep(
        "User Guide — full documentation",
        "Switching to the Guide tab loads the complete user guide inside the same slide out panel. No need to leave the dashboard, however the pop-out button opens either the report or the guide in a standalone browser tab if desired.",
        () => switchSlideoutTab("guide"),
        0
    );

    // Scroll guide
    demoStep(
        "Comprehensive guide",
        null,
        () => {
            const body = document.getElementById("slideoutBody");
            if (body) {
                let scrollPos = 0;
                const maxScroll = body.scrollHeight - body.clientHeight;
                const scrollInterval = setInterval(() => {
                    scrollPos += 8;
                    body.scrollTop = scrollPos;
                    if (scrollPos >= maxScroll || !demoRunning) {
                        clearInterval(scrollInterval);
                    }
                }, 20);
            }
        },
        0
    );

    // Close slideout, transition to zones
    demoStep(
        null,
        null,
        () => closeSlideout(),
        400
    );

    // Zone Intelligence
    demoStep(
        "Zone Intelligence — AI-powered suggestions",
        "The Zone Intelligence panel uses Gemini AI to analyze trip stop-point clusters — generating intelligent zone names, types, and radii. Ace AI then validates the suggestions with fleet intelligence.",
        () => {
            suggestZones();
        },
        0
    );

    // Wait for suggestions
    DEMO_STEPS.push({
        label: "Analyzing trip patterns...",
        narration: null,
        action: null,
        pauseAfter: 500,
        waitFor: () => {
            const items = document.querySelectorAll("#zoneList .zone-suggestion");
            return items.length > 0;
        },
        waitTimeout: 60000
    });

    // Zone Alerts
    demoStep(
        "Zone Alerts — entry and exit monitoring",
        "Risk zones automatically enable alerts when created, otherwise alerts can be set manually. The system checks every 10 seconds whether vehicles have entered or exited a monitored zone — and fires a toast notification on any state change.",
        () => {
            const firstZone = zoneData.find(z => z.id);
            if (firstZone) {
                toggleZoneAlert(firstZone.id, firstZone.name || "Zone", true);
            }
        },
        0
    );

    // Final
    demoStep(
        "Geotab Fleet Command Dashboard",
        "That's Geotab Fleet Command Dashboard — real-time fleet visualization, AI-powered analysis, conversational control, and trip replay — all in one dashboard. All actions were completed live by the AI while recording and running this demo. This demo can be triggered at any time by saying 'play the demo' in the chat. Thank you for watching.",
        () => fitAllVehicles(),
        2000
    );
}

// ── Main Entry Point ──────────────────────────────────────────────────

// demoPrepare: setup that runs DURING the intro speech (overlapped)
function demoPrepare() {
    if (demoRunning) return;
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
}

// demoStart: fires immediately when intro speech ends
function demoStart() {
    startDemoTimer();
    runNextDemoStep();
}

// Legacy entry point (manual trigger / ?demo=1)
function runDemo() {
    if (demoRunning) { stopDemo(); return; }
    demoPrepare();
    demoStart();
}

// ── Auto-start on ?demo=1 ────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    // Pre-load voices
    if (window.speechSynthesis) speechSynthesis.getVoices();

    if (new URLSearchParams(window.location.search).get("demo") === "1") {
        setTimeout(runDemo, 6000);
    }
});
