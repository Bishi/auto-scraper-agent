const SIDECAR = "http://127.0.0.1:9001";
const params = new URLSearchParams(window.location.search);
const isBrowserMock = !window.__TAURI__ || params.get("mock") === "1";
const mockUpdateMode = params.get("mockUpdate") || "available";

function createInitialMockUpdateState(mode) {
  if (mode === "none" || mode === "no-update") {
    return {
      availableUpdate: null,
      updateCheckError: null,
      downloadProgress: "",
      updateCheckDone: true,
    };
  }
  if (mode === "error") {
    return {
      availableUpdate: null,
      updateCheckError: "Unable to reach release server.",
      downloadProgress: "",
      updateCheckDone: true,
    };
  }
  if (mode === "downloading") {
    return {
      availableUpdate: "v0.6.99",
      updateCheckError: null,
      downloadProgress: "47%",
      updateCheckDone: false,
    };
  }
  return {
    availableUpdate: "v0.6.99",
    updateCheckError: null,
    downloadProgress: "",
    updateCheckDone: false,
  };
}

const initialMockUpdateState = createInitialMockUpdateState(mockUpdateMode);

const mockState = {
  serverUrl: "https://local.auto-scraper.test",
  hasApiKey: true,
  apiKeyTail: "55f4",
  version: "0.6.1-mock",
  availableUpdate: initialMockUpdateState.availableUpdate,
  updateCheckError: initialMockUpdateState.updateCheckError,
  downloadProgress: initialMockUpdateState.downloadProgress,
  updateCheckDone: initialMockUpdateState.updateCheckDone,
  paused: false,
  running: false,
  nextRunAt: Date.now() + 29 * 60 * 1000,
  logs: [
    { ts: new Date(Date.now() - 6 * 60 * 1000).toISOString(), level: "info", msg: "[agent] Loaded saved configuration." },
    { ts: new Date(Date.now() - 4 * 60 * 1000).toISOString(), level: "info", msg: "[agent] Sidecar ready on 127.0.0.1:9001." },
    { ts: new Date(Date.now() - 2 * 60 * 1000).toISOString(), level: "warn", msg: "[agent] Mock mode enabled for browser preview." },
  ],
  scraperLogs: [
    { ts: new Date(Date.now() - 90 * 1000).toISOString(), level: "info", msg: "[agent] avto.net: scanned 2 saved searches." },
    { ts: new Date(Date.now() - 80 * 1000).toISOString(), level: "info", msg: "[agent] bolha: 3 new listings detected." },
  ],
};

function mockLog(level, msg, target = "logs") {
  mockState[target].push({ ts: new Date().toISOString(), level, msg: `[agent] ${msg}` });
}

function startMockScrape() {
  if (mockState.running) return;
  mockState.running = true;
  mockState.nextRunAt = null;
  mockLog("info", "Starting scrape run from preview UI.");
  mockLog("info", "Scheduler handed off scrape job.", "scraperLogs");
  setTimeout(() => {
    if (!mockState.running) return;
    mockLog("info", "avto.net: fetched latest result page.", "scraperLogs");
  }, 900);
  setTimeout(() => {
    if (!mockState.running) return;
    mockLog("warn", "bolha: Cloudflare challenge skipped in mock mode.", "scraperLogs");
  }, 1700);
  setTimeout(() => {
    if (!mockState.running) return;
    mockState.running = false;
    mockState.nextRunAt = Date.now() + 43 * 60 * 1000;
    mockLog("info", "Scrape completed successfully.");
    mockLog("info", "proteini.si: 1 price change recorded.", "scraperLogs");
  }, 3200);
}

function startMockUpdateDownload() {
  mockState.availableUpdate = "v0.6.99";
  mockState.updateCheckError = null;
  mockState.updateCheckDone = false;
  mockState.downloadProgress = "12%";
  setTimeout(() => { mockState.downloadProgress = "47%"; }, 600);
  setTimeout(() => { mockState.downloadProgress = "82%"; }, 1200);
  setTimeout(() => {
    mockState.downloadProgress = "";
    mockState.updateCheckDone = true;
  }, 1800);
}

async function mockInvoke(command, args = {}) {
  switch (command) {
    case "get_sidecar_token":
      return "mock-token";
    case "save_config":
      mockState.serverUrl = args.serverUrl;
      if (args.apiKey) {
        mockState.hasApiKey = true;
        mockState.apiKeyTail = args.apiKey.slice(-4) || "mock";
      }
      mockLog("info", "Configuration saved from preview UI.");
      return null;
    case "get_update_version":
      return mockState.availableUpdate;
    case "install_update":
      mockLog("info", "Update check triggered.");
      if (mockUpdateMode === "none" || mockUpdateMode === "no-update") {
        mockState.availableUpdate = null;
        mockState.updateCheckError = null;
        mockState.downloadProgress = "";
        mockState.updateCheckDone = true;
      } else if (mockUpdateMode === "error") {
        mockState.availableUpdate = null;
        mockState.updateCheckError = "Unable to reach release server.";
        mockState.downloadProgress = "";
        mockState.updateCheckDone = true;
      } else {
        startMockUpdateDownload();
      }
      return null;
    case "get_download_progress":
      return mockState.downloadProgress;
    case "is_update_check_done":
      return mockState.updateCheckDone;
    case "get_update_check_error":
      return mockState.updateCheckError;
    case "app_ready":
      return null;
    default:
      return null;
  }
}

const invoke = isBrowserMock ? mockInvoke : window.__TAURI__.core.invoke;
const appApi = isBrowserMock ? { getVersion: async () => mockState.version } : window.__TAURI__.app;

async function mockFetch(url, opts = {}) {
  const pathname = new URL(url, window.location.href).pathname;
  const method = (opts.method || "GET").toUpperCase();

  if (pathname === "/health") {
    return { ok: true, status: 200, json: async () => ({ hasApiKey: mockState.hasApiKey, version: mockState.version }) };
  }
  if (pathname === "/config") {
    return { ok: true, status: 200, json: async () => ({ serverUrl: mockState.serverUrl, hasApiKey: mockState.hasApiKey, apiKeyTail: mockState.apiKeyTail }) };
  }
  if (pathname === "/logs") {
    return { ok: true, status: 200, json: async () => ({ logs: mockState.logs }) };
  }
  if (pathname === "/scraper-logs") {
    return { ok: true, status: 200, json: async () => ({ logs: mockState.scraperLogs }) };
  }
  if (pathname === "/schedule") {
    return { ok: true, status: 200, json: async () => ({ paused: mockState.paused, running: mockState.running, nextRunAt: mockState.nextRunAt }) };
  }
  if (pathname === "/scrape/now" && method === "POST") {
    startMockScrape();
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (pathname === "/scrape/stop" && method === "POST") {
    mockState.running = false;
    mockState.nextRunAt = Date.now() + 60 * 60 * 1000;
    mockLog("warn", "Scrape stopped from preview UI.");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (pathname === "/scheduler/pause" && method === "POST") {
    mockState.paused = true;
    mockLog("warn", "Scheduler paused.");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (pathname === "/scheduler/resume" && method === "POST") {
    mockState.paused = false;
    mockState.nextRunAt = Date.now() + 25 * 60 * 1000;
    mockLog("info", "Scheduler resumed.");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (pathname === "/clear-profile" && method === "POST") {
    mockLog("info", "Browser profile cleared from preview UI.");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }

  return { ok: false, status: 404, json: async () => ({ error: "Mock route not found" }) };
}

let sidecarToken = "";
let configLoadStarted = false;
let schedulePollingStarted = false;

function startConfigLoad() {
  if (configLoadStarted) return;
  configLoadStarted = true;
  void loadConfig();
}

invoke("get_sidecar_token").then((t) => { if (t) sidecarToken = t; }).catch(() => {}).finally(() => {
  if (sidecarToken && !schedulePollingStarted) {
    startConfigLoad();
    schedulePollingStarted = true;
    void pollSchedule();
  }
});

appApi.getVersion().then((v) => {
  document.getElementById("version-badge").textContent = "v" + v;
}).catch(() => {});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const tabEl = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tabEl) {
    tabEl.classList.add("active");
    document.getElementById("panel-" + name).classList.add("active");
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

const initialTab = new URLSearchParams(window.location.search).get("tab");
if (initialTab) switchTab(initialTab);

const chromeMinimizeBtn = document.getElementById("chrome-minimize");
const chromeMaximizeBtn = document.getElementById("chrome-maximize");
const chromeCloseBtn = document.getElementById("chrome-close");
const titlebarDrag = document.getElementById("titlebar-drag");

async function toggleWindowMaximize() {
  try { await invoke("window_toggle_maximize"); } catch {}
}

if (titlebarDrag && !isBrowserMock) {
  titlebarDrag.addEventListener("mousedown", async (event) => {
    if (event.buttons !== 1) return;
    if (event.target instanceof HTMLElement && event.target.closest(".chrome-btn")) return;
    try { await invoke("window_start_dragging"); } catch {}
  });
}

if (chromeMinimizeBtn) {
  chromeMinimizeBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  chromeMinimizeBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try { await invoke("window_minimize"); } catch {}
  });
}

if (chromeMaximizeBtn) {
  chromeMaximizeBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  chromeMaximizeBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleWindowMaximize();
  });
}

if (chromeCloseBtn) {
  chromeCloseBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  chromeCloseBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try { await invoke("window_close"); } catch {}
  });
}

function fetchTimeout(url, ms = 2000, opts = {}) {
  if (isBrowserMock) {
    return mockFetch(url, opts);
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const headers = { ...(sidecarToken ? { "X-Sidecar-Token": sidecarToken } : {}), ...(opts.headers ?? {}) };
  return fetch(url, { signal: controller.signal, ...opts, headers }).finally(() => clearTimeout(id));
}

const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const statusDivider = document.getElementById("status-divider");

async function pollHealth() {
  try {
    const res = await fetchTimeout(`${SIDECAR}/health`);
    if (res.ok) {
      dot.className = "status-dot online";
      statusText.textContent = "Online";
    } else {
      dot.className = "status-dot offline";
      statusText.textContent = "Error " + res.status;
    }
  } catch {
    dot.className = "status-dot offline";
    statusText.textContent = "Offline";
  }
  invoke("get_sidecar_token").then((t) => {
    if (!t) return;
    sidecarToken = t;
    startConfigLoad();
    if (!schedulePollingStarted) {
      schedulePollingStarted = true;
      void pollSchedule();
    }
  }).catch(() => {});
}

pollHealth();
setInterval(pollHealth, 5000);

const serverInput = document.getElementById("server-url");
const keyInput = document.getElementById("api-key");
const keyHint = document.getElementById("key-hint");

function setSavedKeyPlaceholder(apiKeyTail) {
  keyInput.value = "";
  if (typeof apiKeyTail === "string" && apiKeyTail.length >= 4) {
    keyInput.placeholder = "...." + apiKeyTail.slice(-4) + " (saved)";
  } else {
    keyInput.placeholder = "........ (saved)";
  }
  keyHint.style.display = "block";
}

async function loadConfig() {
  try {
    const res = await fetchTimeout(`${SIDECAR}/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.serverUrl) serverInput.value = data.serverUrl;
    if (data.hasApiKey) {
      setSavedKeyPlaceholder(data.apiKeyTail);
    } else {
      keyHint.style.display = "none";
      keyInput.placeholder = "as_live_...";
    }
  } catch {}
}

const saveBtn = document.getElementById("save-btn");
const errorEl = document.getElementById("error-msg");
const successEl = document.getElementById("success-msg");

saveBtn.addEventListener("click", async () => {
  errorEl.style.display = "none";
  successEl.style.display = "none";

  const serverUrl = serverInput.value.trim();
  const apiKey = keyInput.value.trim();

  if (!serverUrl) {
    errorEl.textContent = "Server URL is required.";
    errorEl.style.display = "block";
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    await invoke("save_config", { apiKey, serverUrl });
    successEl.style.display = "block";
    await loadConfig();
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.style.display = "block";
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
});

const runScrapeBtn = document.getElementById("run-scrape-btn");
const stopScrapeBtn = document.getElementById("stop-scrape-btn");
const clearProfileBtn = document.getElementById("clear-profile-btn");
let scraperRunning = false;
let scrapeStartPending = false;
let scrapeStopPending = false;
let schedulePollTimer = null;

function renderScrapeButtons() {
  runScrapeBtn.disabled = scraperRunning || scrapeStartPending;
  stopScrapeBtn.disabled = !scraperRunning || scrapeStopPending;
  clearProfileBtn.disabled = scraperRunning;

  runScrapeBtn.innerHTML = "&#9654; Run Scrape";
  stopScrapeBtn.innerHTML = "&#9632; Stop";
}

renderScrapeButtons();

function getSchedulePollIntervalMs() {
  return scraperRunning || scrapeStartPending || scrapeStopPending ? 1_000 : 10_000;
}

function scheduleNextSchedulePoll(delay = getSchedulePollIntervalMs()) {
  if (schedulePollTimer) clearTimeout(schedulePollTimer);
  schedulePollTimer = setTimeout(() => {
    schedulePollTimer = null;
    void pollSchedule();
  }, delay);
}

async function refreshScheduleSoon(attempts = 6, delayMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await pollSchedule();
    if ((scrapeStartPending && scraperRunning) || (scrapeStopPending && !scraperRunning)) {
      break;
    }
    if (!scrapeStartPending && !scrapeStopPending) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

runScrapeBtn.addEventListener("click", async () => {
  if (scraperRunning || scrapeStartPending) return;
  scrapeStartPending = true;
  renderScrapeButtons();
  scheduleNextSchedulePoll(250);
  try {
    await fetchTimeout(`${SIDECAR}/scrape/now`, 4000, { method: "POST" });
    await refreshScheduleSoon();
  } catch {} finally {
    if (!scraperRunning) scrapeStartPending = false;
    renderScrapeButtons();
    scheduleNextSchedulePoll();
  }
});

const logBox = document.getElementById("log-box");

let localLogs = [];
let autoScroll = true;
let lastLogKey = "";

logBox.addEventListener("scroll", () => {
  const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
  autoScroll = atBottom;
});
attachLogCopyNormalizer(logBox);

function esc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatLogTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatLogLevel(level) {
  return level === "error" ? "ERR" : level === "warn" ? "WRN" : "INF";
}

function formatLogMessage(msg) {
  return String(msg || "").replace(/^\[agent\]\s*/, "");
}

function createLogEntry(log) {
  const entry = document.createElement("div");
  const ts = formatLogTime(log.ts);
  const lvl = formatLogLevel(log.level);
  const msg = formatLogMessage(log.msg);

  entry.className = `log-entry ${log.level}`;
  entry.dataset.ts = ts;
  entry.dataset.level = lvl;
  entry.dataset.msg = msg;

  const tsEl = document.createElement("span");
  tsEl.className = "log-ts";
  tsEl.textContent = ts;

  const levelEl = document.createElement("span");
  levelEl.className = "log-level";
  levelEl.textContent = lvl;

  const msgEl = document.createElement("span");
  msgEl.className = "log-msg";
  msgEl.textContent = msg;

  entry.append(tsEl, levelEl, msgEl);
  return entry;
}

function renderLogList(box, logs, emptyMessage, getLastKey, setLastKey, shouldAutoScroll) {
  if (logs.length === 0) {
    setLastKey("");
    box.innerHTML = `<div class="log-empty">${esc(emptyMessage)}</div>`;
    return;
  }

  const newest = logs[logs.length - 1];
  const newKey = `${logs.length}:${newest.ts}:${newest.level}:${newest.msg}`;
  if (newKey === getLastKey()) return;
  setLastKey(newKey);

  box.replaceChildren(...logs.map(createLogEntry));
  if (shouldAutoScroll()) box.scrollTop = box.scrollHeight;
}

function getSelectedLogLines(box) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];

  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  return Array.from(box.querySelectorAll(".log-entry"))
    .filter((entry) => ranges.some((range) => range.intersectsNode(entry)))
    .map((entry) => `${entry.dataset.ts} ${entry.dataset.level} ${entry.dataset.msg}`);
}

function attachLogCopyNormalizer(box) {
  box.addEventListener("copy", (event) => {
    const lines = getSelectedLogLines(box);
    if (lines.length === 0 || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", lines.join("\n"));
  });
}

function renderLogs() {
  renderLogList(
    logBox,
    localLogs,
    "No logs yet.",
    () => lastLogKey,
    (value) => { lastLogKey = value; },
    () => autoScroll,
  );
}

let clearedAt = 0;

async function pollLogs() {
  try {
    const res = await fetchTimeout(`${SIDECAR}/logs`);
    if (!res.ok) return;
    const data = await res.json();
    const all = data.logs ?? [];
    localLogs = clearedAt ? all.filter((e) => new Date(e.ts).getTime() >= clearedAt) : all;
    renderLogs();
  } catch {}
}

pollLogs();
setInterval(pollLogs, 3000);

const scraperLogBox = document.getElementById("scraper-log-box");

let scraperLogs = [];
let scraperAutoScroll = true;
let scraperLastKey = "";
let scraperClearedAt = 0;

scraperLogBox.addEventListener("scroll", () => {
  const atBottom = scraperLogBox.scrollHeight - scraperLogBox.scrollTop - scraperLogBox.clientHeight < 40;
  scraperAutoScroll = atBottom;
});
attachLogCopyNormalizer(scraperLogBox);

function renderScraperLogs() {
  renderLogList(
    scraperLogBox,
    scraperLogs,
    "No scraper logs yet. Logs appear here after a scrape runs.",
    () => scraperLastKey,
    (value) => { scraperLastKey = value; },
    () => scraperAutoScroll,
  );
}

async function pollScraperLogs() {
  try {
    const res = await fetchTimeout(`${SIDECAR}/scraper-logs`);
    if (!res.ok) return;
    const data = await res.json();
    const all = data.logs ?? [];
    scraperLogs = scraperClearedAt ? all.filter((e) => new Date(e.ts).getTime() >= scraperClearedAt) : all;
    renderScraperLogs();
  } catch {}
}

pollScraperLogs();
setInterval(pollScraperLogs, 3000);

const scheduleText = document.getElementById("schedule-text");
const pauseBtn = document.getElementById("pause-btn");
let schedulerPaused = false;
let appReadySent = false;

function updatePauseBtn(paused) {
  schedulerPaused = paused;
  pauseBtn.disabled = false;
  if (paused) {
    pauseBtn.innerHTML = "&#9654; Resume Schedule";
    pauseBtn.classList.add("paused");
  } else {
    pauseBtn.textContent = "|| Pause Schedule";
    pauseBtn.classList.remove("paused");
  }
}

async function pollSchedule() {
  try {
    const res = await fetchTimeout(`${SIDECAR}/schedule`);
    if (!res.ok) {
      scheduleText.textContent = "";
      statusDivider.style.display = "none";
      return;
    }
    const data = await res.json();
    updatePauseBtn(!!data.paused);
    updateRunningState(!!data.running);
    if (!appReadySent) {
      appReadySent = true;
      void invoke("app_ready").catch(() => {
        appReadySent = false;
      });
    }
    if (data.paused) {
      scheduleText.textContent = "paused";
      statusDivider.style.display = "";
    } else if (data.running) {
      scheduleText.textContent = "scrape running...";
      statusDivider.style.display = "";
    } else if (data.nextRunAt) {
      const diffMin = Math.max(0, Math.round((data.nextRunAt - Date.now()) / 60000));
      const nextTime = new Date(data.nextRunAt).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
      scheduleText.textContent = `next: ${nextTime} (${diffMin} min)`;
      statusDivider.style.display = "";
    } else {
      scheduleText.textContent = "";
      statusDivider.style.display = "none";
    }
  } catch {
    scheduleText.textContent = "";
    statusDivider.style.display = "none";
  } finally {
    scheduleNextSchedulePoll();
  }
}

pauseBtn.addEventListener("click", async () => {
  pauseBtn.disabled = true;
  try {
    const endpoint = schedulerPaused ? "/scheduler/resume" : "/scheduler/pause";
    await fetchTimeout(`${SIDECAR}${endpoint}`, 4000, { method: "POST" });
    await pollSchedule();
  } catch {} finally {
    pauseBtn.disabled = false;
  }
});

async function doStopScrape() {
  if (!scraperRunning || scrapeStopPending) return;
  scrapeStopPending = true;
  renderScrapeButtons();
  scheduleNextSchedulePoll(250);
  try {
    await fetchTimeout(`${SIDECAR}/scrape/stop`, 4000, { method: "POST" });
    await refreshScheduleSoon(10, 500);
  } catch {} finally {
    if (scraperRunning) {
      scrapeStopPending = false;
    }
    renderScrapeButtons();
    scheduleNextSchedulePoll();
  }
}

stopScrapeBtn.addEventListener("click", () => doStopScrape());

const clearProfileError = document.getElementById("clear-profile-error");
const clearProfileSuccess = document.getElementById("clear-profile-success");

function updateRunningState(running) {
  scraperRunning = running;
  if (!running) scrapeStartPending = false;
  if (!running) scrapeStopPending = false;
  renderScrapeButtons();
}

clearProfileBtn.addEventListener("click", async () => {
  clearProfileError.style.display = "none";
  clearProfileSuccess.style.display = "none";
  clearProfileBtn.disabled = true;
  clearProfileBtn.textContent = "Clearing...";
  try {
    const res = await fetchTimeout(`${SIDECAR}/clear-profile`, 4000, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      clearProfileSuccess.style.display = "block";
    } else {
      clearProfileError.textContent = data.error ?? `Error ${res.status}`;
      clearProfileError.style.display = "block";
    }
  } catch (err) {
    clearProfileError.textContent = String(err);
    clearProfileError.style.display = "block";
  } finally {
    clearProfileBtn.disabled = false;
    clearProfileBtn.textContent = "Clear Browser Profile";
  }
});

const updateBadge = document.getElementById("update-badge");
const updateVersion = document.getElementById("update-version");
let availableTag = null;

async function pollUpdateVersion() {
  try {
    const tag = await invoke("get_update_version");
    availableTag = tag ?? null;
    if (availableTag) {
      updateVersion.textContent = availableTag;
      updateBadge.style.display = "inline-flex";
    } else {
      updateBadge.style.display = "none";
    }
  } catch {}
}

updateBadge.addEventListener("click", async () => {
  if (!availableTag) return;
  updateBadge.style.opacity = "0.5";
  updateBadge.style.pointerEvents = "none";
  try {
    await invoke("install_update");
  } catch {} finally {
    updateBadge.style.opacity = "";
    updateBadge.style.pointerEvents = "";
  }
});

pollUpdateVersion();
setInterval(pollUpdateVersion, 15 * 1000);

const checkUpdateBtn = document.getElementById("check-update-btn");
const checkUpdateUptodate = document.getElementById("check-update-uptodate");
const checkUpdateError = document.getElementById("check-update-error");
const downloadProgress = document.getElementById("download-progress");
const downloadProgressText = document.getElementById("download-progress-text");
const downloadProgressFill = document.getElementById("download-progress-fill");

function renderDownloadProgress(progress) {
  if (!progress) {
    downloadProgress.style.display = "none";
    downloadProgressText.textContent = "";
    downloadProgressFill.style.width = "0%";
    return;
  }

  const numericProgress = Number.parseInt(String(progress), 10);
  downloadProgressText.textContent = "Downloading update: " + progress;
  downloadProgressFill.style.width = Number.isFinite(numericProgress) ? `${Math.max(0, Math.min(100, numericProgress))}%` : "0%";
  downloadProgress.style.display = "block";
}

setInterval(async () => {
  try {
    const progress = await invoke("get_download_progress");
    renderDownloadProgress(progress);
  } catch {}
}, 1000);

checkUpdateBtn.addEventListener("click", async () => {
  checkUpdateUptodate.style.display = "none";
  checkUpdateError.style.display = "none";
  checkUpdateBtn.disabled = true;
  checkUpdateBtn.textContent = "Checking...";

  invoke("install_update").catch(() => {});

  const poll = setInterval(async () => {
    try {
      const done = await invoke("is_update_check_done");
      if (!done) return;
      clearInterval(poll);
      checkUpdateBtn.disabled = false;
  checkUpdateBtn.innerHTML = "&#8593; Check for Updates";
      const [tag, err] = await Promise.all([
        invoke("get_update_version"),
        invoke("get_update_check_error"),
      ]);
      if (tag) {
        availableTag = tag;
        updateVersion.textContent = tag;
        updateBadge.style.display = "inline-flex";
      } else if (err) {
        checkUpdateError.textContent = "Update check failed: " + err;
        checkUpdateError.style.display = "block";
      } else {
        checkUpdateUptodate.style.display = "block";
      }
    } catch {}
  }, 500);
});

if (isBrowserMock && mockUpdateMode === "downloading" && mockState.downloadProgress) {
  renderDownloadProgress(mockState.downloadProgress);
  setTimeout(() => startMockUpdateDownload(), 250);
}
