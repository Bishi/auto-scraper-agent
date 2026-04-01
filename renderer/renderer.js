const SIDECAR = "http://127.0.0.1:9001";
const params = new URLSearchParams(window.location.search);
const isBrowserMock = !window.__TAURI__ || params.get("mock") === "1";

const mockState = {
  serverUrl: "https://local.auto-scraper.test",
  hasApiKey: true,
  apiKeyTail: "55f4",
  version: "0.6.1-mock",
  availableUpdate: "v0.6.2",
  updateCheckError: null,
  downloadProgress: "",
  updateCheckDone: false,
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
      startMockUpdateDownload();
      return null;
    case "get_download_progress":
      return mockState.downloadProgress;
    case "is_update_check_done":
      return mockState.updateCheckDone;
    case "get_update_check_error":
      return mockState.updateCheckError;
    default:
      return null;
  }
}

const invoke = isBrowserMock ? mockInvoke : window.__TAURI__.core.invoke;
const appApi = isBrowserMock ? { getVersion: async () => mockState.version } : window.__TAURI__.app;
const currentWindow = isBrowserMock ? null : window.__TAURI__.window.getCurrentWindow();

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
invoke("get_sidecar_token").then((t) => { if (t) sidecarToken = t; }).catch(() => {}).finally(() => { loadConfig(); });

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

if (chromeMinimizeBtn) {
  chromeMinimizeBtn.addEventListener("click", async () => {
    if (!currentWindow) return;
    try { await currentWindow.minimize(); } catch {}
  });
}

if (chromeMaximizeBtn) {
  chromeMaximizeBtn.addEventListener("click", async () => {
    if (!currentWindow) return;
    try { await currentWindow.toggleMaximize(); } catch {}
  });
}

if (chromeCloseBtn) {
  chromeCloseBtn.addEventListener("click", async () => {
    if (!currentWindow) return;
    try { await currentWindow.close(); } catch {}
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
  invoke("get_sidecar_token").then((t) => { if (t) sidecarToken = t; }).catch(() => {});
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

runScrapeBtn.addEventListener("click", async () => {
  runScrapeBtn.disabled = true;
  runScrapeBtn.textContent = "Starting...";
  try {
    await fetchTimeout(`${SIDECAR}/scrape/now`, 4000, { method: "POST" });
  } catch {}
  setTimeout(() => {
    runScrapeBtn.disabled = false;
    runScrapeBtn.innerHTML = "&#9654; Run Scrape";
  }, 2000);
});

const logBox = document.getElementById("log-box");
const logCount = document.getElementById("log-count");
const clearBtn = document.getElementById("clear-btn");

let localLogs = [];
let autoScroll = true;
let lastLogKey = "";

logBox.addEventListener("scroll", () => {
  const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
  autoScroll = atBottom;
});

function esc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLogs() {
  if (localLogs.length === 0) {
    lastLogKey = "";
    logBox.innerHTML = '<div class="log-empty">No logs yet.</div>';
    logCount.textContent = "0 entries";
    return;
  }
  const newKey = `${localLogs.length}:${localLogs[localLogs.length - 1].ts}`;
  if (newKey === lastLogKey) return;
  lastLogKey = newKey;

  logBox.innerHTML = localLogs
    .map((e) => {
      const ts = new Date(e.ts).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      const lvl = e.level === "error" ? "ERR" : e.level === "warn" ? "WRN" : "INF";
      const msg = e.msg.replace(/^\[agent\]\s*/, "");
      return `<div class="log-entry ${e.level}">` +
        `<span class="log-ts">${ts}</span> ` +
        `<span class="log-level">${lvl}</span> ` +
        `<span class="log-msg">${esc(msg)}</span>` +
        `</div>`;
    })
    .join("");
  logCount.textContent = `${localLogs.length} entries`;
  if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
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

clearBtn.addEventListener("click", () => {
  clearedAt = Date.now();
  localLogs = [];
  renderLogs();
});

pollLogs();
setInterval(pollLogs, 3000);

const scraperLogBox = document.getElementById("scraper-log-box");
const scraperLogCount = document.getElementById("scraper-log-count");
const scraperClearBtn = document.getElementById("scraper-clear-btn");

let scraperLogs = [];
let scraperAutoScroll = true;
let scraperLastKey = "";
let scraperClearedAt = 0;

scraperLogBox.addEventListener("scroll", () => {
  const atBottom = scraperLogBox.scrollHeight - scraperLogBox.scrollTop - scraperLogBox.clientHeight < 40;
  scraperAutoScroll = atBottom;
});

function renderScraperLogs() {
  if (scraperLogs.length === 0) {
    scraperLastKey = "";
    scraperLogBox.innerHTML = '<div class="log-empty">No scraper logs yet. Logs appear here after a scrape runs.</div>';
    scraperLogCount.textContent = "0 entries";
    return;
  }
  const newKey = `${scraperLogs.length}:${scraperLogs[scraperLogs.length - 1].ts}`;
  if (newKey === scraperLastKey) return;
  scraperLastKey = newKey;

  scraperLogBox.innerHTML = scraperLogs
    .map((e) => {
      const ts = new Date(e.ts).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      const lvl = e.level === "error" ? "ERR" : e.level === "warn" ? "WRN" : "INF";
      const msg = e.msg.replace(/^\[agent\]\s*/, "");
      return `<div class="log-entry ${e.level}">` +
        `<span class="log-ts">${ts}</span> ` +
        `<span class="log-level">${lvl}</span> ` +
        `<span class="log-msg">${esc(msg)}</span>` +
        `</div>`;
    })
    .join("");
  scraperLogCount.textContent = `${scraperLogs.length} entries`;
  if (scraperAutoScroll) scraperLogBox.scrollTop = scraperLogBox.scrollHeight;
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

scraperClearBtn.addEventListener("click", () => {
  scraperClearedAt = Date.now();
  scraperLogs = [];
  renderScraperLogs();
});

pollScraperLogs();
setInterval(pollScraperLogs, 3000);

const scheduleText = document.getElementById("schedule-text");
const pauseBtn = document.getElementById("pause-btn");
let schedulerPaused = false;

function updatePauseBtn(paused) {
  schedulerPaused = paused;
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
  }
}

pollSchedule();
setInterval(pollSchedule, 10000);

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

const stopScrapeBtn = document.getElementById("stop-scrape-btn");
const stopScrapeSettingsBtn = document.getElementById("stop-scrape-settings-btn");

async function doStopScrape(btn) {
  btn.disabled = true;
  btn.textContent = "Stopping...";
  try {
    await fetchTimeout(`${SIDECAR}/scrape/stop`, 4000, { method: "POST" });
  } catch {}
  setTimeout(() => {
    btn.innerHTML = "&#9632; Stop" + (btn.id === "stop-scrape-settings-btn" ? " Scrape" : "");
  }, 1500);
}

stopScrapeBtn.addEventListener("click", () => doStopScrape(stopScrapeBtn));
stopScrapeSettingsBtn.addEventListener("click", () => doStopScrape(stopScrapeSettingsBtn));

const clearProfileBtn = document.getElementById("clear-profile-btn");
const clearProfileError = document.getElementById("clear-profile-error");
const clearProfileSuccess = document.getElementById("clear-profile-success");

function updateRunningState(running) {
  document.getElementById("run-scrape-btn").disabled = running;
  document.getElementById("run-scrape-settings-btn").disabled = running;
  stopScrapeBtn.disabled = !running;
  stopScrapeSettingsBtn.disabled = !running;
  clearProfileBtn.disabled = running;
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

setInterval(async () => {
  try {
    const progress = await invoke("get_download_progress");
    if (progress) {
      downloadProgress.textContent = "Downloading update: " + progress;
      downloadProgress.style.display = "block";
    } else {
      downloadProgress.style.display = "none";
    }
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

const runScrapeSettingsBtn = document.getElementById("run-scrape-settings-btn");

runScrapeSettingsBtn.addEventListener("click", async () => {
  runScrapeSettingsBtn.disabled = true;
  runScrapeSettingsBtn.textContent = "Starting...";
  switchTab("logs");
  try {
    await fetchTimeout(`${SIDECAR}/scrape/now`, 4000, { method: "POST" });
  } catch {}
  setTimeout(() => {
    runScrapeSettingsBtn.disabled = false;
    runScrapeSettingsBtn.innerHTML = "&#9654; Run Scrape";
  }, 2000);
});
