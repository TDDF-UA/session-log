// Points at the model.json/weights.bin/metadata.json committed in
// this repo's /model folder.
const MODEL_URL = "./model/";

const CONFIDENCE_THRESHOLD = 0.75;   // don't announce low-confidence guesses
const STABLE_FRAMES_NEEDED = 5;      // require a few consistent frames before speaking
const REPEAT_COOLDOWN_MS = 2500;     // don't re-announce the same class too often

const MAX_LOG_ENTRIES = 20;          // cap the visible session log

const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const restartBtn = document.getElementById("restart-btn");
const appEl = document.getElementById("app");
const guessEl = document.getElementById("guess");
const confidenceEl = document.getElementById("confidence");
const statusText = document.getElementById("status-text");
const dot = document.getElementById("dot");
const webcam = document.getElementById("webcam");
const srAnnounce = document.getElementById("sr-announce");
const logList = document.getElementById("log-list");
const logEmpty = document.getElementById("log-empty");
const logCount = document.getElementById("log-count");

let model, running = false, currentStream = null;
let candidateClass = null, candidateStreak = 0;
let lastSpokenClass = null, lastSpokenAt = 0;

// Session log — in-memory only, newest first. Each entry:
// { className, at: <timestamp ms> }
let sessionLog = [];
let logTickInterval = null;

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
  srAnnounce.textContent = text;
}

function describeError(err) {
  if (err && err.name === "NotAllowedError") {
    return "Camera access was blocked. Allow camera access in your browser settings, then try again.";
  }
  if (err && err.name === "NotFoundError") {
    return "No camera was found on this device.";
  }
  if (err && err.name === "NotReadableError") {
    return "The camera is being used by another app. Close it, then try again.";
  }
  return "Something went wrong starting the camera. Try again.";
}

function stopCamera() {
  running = false;
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
}

// ---------- Session log ----------

function relativeTime(fromMs) {
  const seconds = Math.max(0, Math.round((Date.now() - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(remSeconds).padStart(2, "0")} ago`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}:${String(remMinutes).padStart(2, "0")}h ago`;
}

function addLogEntry(className) {
  sessionLog.unshift({ className, at: Date.now() });
  if (sessionLog.length > MAX_LOG_ENTRIES) {
    sessionLog.length = MAX_LOG_ENTRIES;
  }
  renderLog();
}

function renderLog() {
  logCount.textContent = `${sessionLog.length} item${sessionLog.length === 1 ? "" : "s"}`;
  logEmpty.hidden = sessionLog.length > 0;

  // Re-render the whole list. Session logs top out at MAX_LOG_ENTRIES
  // rows, so a full re-render each tick is cheap and keeps the
  // timestamp-refresh logic simple.
  logList.innerHTML = "";
  sessionLog.forEach((entry, index) => {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "log-row";
    row.setAttribute("data-index", String(index));
    row.setAttribute("aria-label", `Say ${entry.className} again`);

    const name = document.createElement("span");
    name.className = "log-row-name";
    name.textContent = entry.className;

    const time = document.createElement("span");
    time.className = "log-row-time";
    time.textContent = relativeTime(entry.at);

    row.appendChild(name);
    row.appendChild(time);
    row.addEventListener("click", () => speak(entry.className));

    li.appendChild(row);
    logList.appendChild(li);
  });
}

function refreshLogTimestamps() {
  // Cheaper than a full re-render: only touch the timestamp text nodes.
  const rows = logList.querySelectorAll(".log-row");
  rows.forEach((row) => {
    const index = Number(row.getAttribute("data-index"));
    const entry = sessionLog[index];
    if (!entry) return;
    const timeEl = row.querySelector(".log-row-time");
    if (timeEl) timeEl.textContent = relativeTime(entry.at);
  });
}

// ---------- Init / loop ----------

async function init() {
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  startError.textContent = "";
  statusText.textContent = "Loading model…";

  try {
    if (!model) {
      model = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
    }

    // "ideal" (not "exact") so this still works on a laptop with only
    // one camera — it just falls back gracefully there.
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }
    });
    webcam.srcObject = currentStream;
    await webcam.play();

    try {
      if ("wakeLock" in navigator) await navigator.wakeLock.request("screen");
    } catch (e) { /* not critical if unsupported — screen may just dim on long use */ }

    running = true;
    dot.classList.add("live");
    statusText.textContent = "Scanning…";
    restartBtn.hidden = false;
    startScreen.hidden = true;
    appEl.hidden = false;

    if (!logTickInterval) {
      logTickInterval = setInterval(refreshLogTimestamps, 1000);
    }

    requestAnimationFrame(loop);
  } catch (err) {
    dot.classList.remove("live");
    statusText.textContent = "Point your camera at an object";
    startBtn.disabled = false;
    startBtn.textContent = "Start scanning";
    startError.textContent = describeError(err);
  }
}

async function loop() {
  if (!running) return;
  const predictions = await model.predict(webcam);
  predictions.sort((a, b) => b.probability - a.probability);
  const top = predictions[0];

  guessEl.textContent = top.probability >= CONFIDENCE_THRESHOLD ? top.className : "…";
  confidenceEl.textContent =
    top.probability >= CONFIDENCE_THRESHOLD
      ? Math.round(top.probability * 100) + "% sure"
      : "Not sure yet — hold it steadier or closer";

  if (top.probability >= CONFIDENCE_THRESHOLD) {
    if (top.className === candidateClass) {
      candidateStreak++;
    } else {
      candidateClass = top.className;
      candidateStreak = 1;
    }

    const now = Date.now();
    const stableEnough = candidateStreak >= STABLE_FRAMES_NEEDED;
    const changedOrCooldownPassed =
      candidateClass !== lastSpokenClass || now - lastSpokenAt > REPEAT_COOLDOWN_MS * 4;

    if (stableEnough && changedOrCooldownPassed) {
      speak(candidateClass);
      lastSpokenClass = candidateClass;
      lastSpokenAt = now;
      candidateStreak = 0;

      // Log only on a fresh, spoken detection — not every frame.
      addLogEntry(candidateClass);
    }
  } else {
    candidateClass = null;
    candidateStreak = 0;
  }

  requestAnimationFrame(loop);
}

startBtn.addEventListener("click", init);

restartBtn.addEventListener("click", () => {
  stopCamera();
  dot.classList.remove("live");
  guessEl.textContent = "—";
  confidenceEl.textContent = "";
  statusText.textContent = "Point your camera at an object";
  appEl.hidden = true;
  startScreen.hidden = false;
  startBtn.disabled = false;
  startBtn.textContent = "Start scanning";
  init();
});

window.addEventListener("DOMContentLoaded", () => startBtn.focus());
