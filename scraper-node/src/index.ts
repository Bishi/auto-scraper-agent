import http from "node:http";
import { rmSync, existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfig, writeConfig } from "./store.js";
import { AgentApiClient } from "./api-client.js";
import { Scheduler } from "./scheduler.js";
import { SIDECAR_TOKEN, isAuthorized } from "./auth.js";

// Announce the token on stdout before the HTTP server starts.
// Written via process.stdout.write (not console.log) to avoid the log-intercept
// prefix and to prevent the secret from appearing in the log buffer or log file.
process.stdout.write(`SIDECAR_TOKEN=${SIDECAR_TOKEN}\n`);

// Must match USER_DATA_DIR in shared/browser/context.ts
const BROWSER_PROFILE_DIR = join(homedir(), ".auto-scraper", "browser-profile");

const PORT = 9001;
const AGENT_VERSION = "0.5.36";

// ---------------------------------------------------------------------------
// Log buffer — persisted to ~/.auto-scraper/agent.log (NDJSON) so history
// survives agent restarts. In-memory ring kept at MAX_LOG_LINES for the UI.
// ---------------------------------------------------------------------------

interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const LOG_DIR  = join(homedir(), ".auto-scraper", "logs");
const LOG_FILE = join(LOG_DIR, "agent.log");
const MAX_LOG_LINES      = 300;  // in-memory ring shown in UI
const MAX_LOG_FILE_LINES = 5000; // rotate file when it exceeds this

// Ensure the logs directory exists before reading or writing.
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

// Load existing log history from disk into the ring buffer on startup.
const LOG_BUFFER: LogEntry[] = (() => {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    // Trim the file if it has grown too large.
    if (lines.length > MAX_LOG_FILE_LINES) {
      const trimmed = lines.slice(-MAX_LOG_FILE_LINES);
      writeFileSync(LOG_FILE, trimmed.join("\n") + "\n", "utf8");
      return trimmed.slice(-MAX_LOG_LINES).map((l) => JSON.parse(l) as LogEntry);
    }
    return lines.slice(-MAX_LOG_LINES).map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
})();

function pushLog(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg: args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") };
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > MAX_LOG_LINES) LOG_BUFFER.shift();
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* non-fatal — UI still works via in-memory buffer */ }
}

// Intercept all console output so every module's logs are captured.
const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);
const hhmm = () => new Date().toTimeString().slice(0, 8);
console.log  = (...args: unknown[]) => { pushLog("info",  ...args); _origLog(`[${hhmm()}]`,  ...args); };
console.warn = (...args: unknown[]) => { pushLog("warn",  ...args); _origWarn(`[${hhmm()}]`, ...args); };
console.error = (...args: unknown[]) => { pushLog("error", ...args); _origErr(`[${hhmm()}]`, ...args); };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let client: AgentApiClient | null = null;
const scheduler = new Scheduler();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sidecar-Token",
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;

  void (async () => {
    try {
      // Handle CORS preflight — WebView2 sends OPTIONS before cross-origin POSTs.
      // Must bypass token check: browsers never include custom headers in preflights.
      if (method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      // Public health endpoint — used by the Rust shell to detect sidecar readiness
      // before the token has been captured from stdout.
      if (method === "GET" && pathname === "/health") {
        const config = readConfig();
        return sendJson(res, 200, { hasApiKey: !!config?.apiKey, version: AGENT_VERSION });
      }

      // All other routes require the shared secret generated at startup.
      if (!isAuthorized(req.headers)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (method === "GET" && pathname === "/config") {
        const config = readConfig();
        const key = config?.apiKey;
        // Never expose the full key — same tail convention as admin Fleet (last 4 chars).
        const apiKeyTail =
          key && key.length >= 4 ? key.slice(-4) : null;
        return sendJson(res, 200, {
          serverUrl: config?.serverUrl ?? null,
          hasApiKey: !!key,
          apiKeyTail,
        });
      }

      if (method === "GET" && pathname === "/logs") {
        return sendJson(res, 200, { logs: LOG_BUFFER });
      }

      if (method === "GET" && pathname === "/schedule") {
        return sendJson(res, 200, { nextRunAt: scheduler.nextRunAt, paused: scheduler.isPaused, running: scheduler.isRunning });
      }

      if (method === "GET" && pathname === "/update/check") {
        return sendJson(res, 200, { pending: scheduler.consumeUpdateCheck() });
      }

      if (method === "POST" && pathname === "/log") {
        const body = await readBody(req) as { level?: string; msg?: string };
        const level = body.level === "error" ? "error" : body.level === "warn" ? "warn" : "info";
        const msg = typeof body.msg === "string" ? body.msg : String(body.msg ?? "");
        if (level === "error") console.error(msg);
        else if (level === "warn") console.warn(msg);
        else console.log(msg);
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/pause") {
        scheduler.pause();
        console.log("[agent] Scheduler paused by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/resume") {
        if (!client) {
          return sendJson(res, 400, { error: "Not configured. POST /config first." });
        }
        void scheduler.resume(client);
        console.log("[agent] Scheduler resumed by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/config") {
        const body = await readBody(req) as Record<string, unknown>;
        const { apiKey, serverUrl } = body;

        if (typeof serverUrl !== "string") {
          return sendJson(res, 400, { error: "serverUrl is required" });
        }

        // apiKey is optional when a key is already saved — reuse the existing one.
        let resolvedKey: string;
        if (typeof apiKey === "string" && apiKey.length > 0) {
          resolvedKey = apiKey;
        } else {
          const existing = readConfig();
          if (!existing?.apiKey) {
            return sendJson(res, 400, { error: "apiKey is required (no saved key found)" });
          }
          resolvedKey = existing.apiKey;
        }

        const previous = readConfig();
        writeConfig({ apiKey: resolvedKey, serverUrl });
        client = new AgentApiClient(serverUrl, resolvedKey);
        scheduler.stop();
        scheduler.start(client, AGENT_VERSION);

        const keyTail =
          resolvedKey.length >= 4 ? resolvedKey.slice(-4) : "????";
        if (!previous) {
          console.log(
            `[agent] Config saved (first run): serverUrl=${serverUrl}, apiKey tail ...${keyTail}`,
          );
        } else {
          const urlChanged = previous.serverUrl !== serverUrl;
          const keyChanged = previous.apiKey !== resolvedKey;
          console.log(
            `[agent] Config saved: serverUrl=${serverUrl}` +
              (urlChanged
                ? ` (URL changed from ${previous.serverUrl})`
                : " (URL unchanged)") +
              (keyChanged
                ? `, apiKey updated (tail ...${keyTail})`
                : `, apiKey unchanged (tail ...${keyTail})`),
          );
        }
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scrape/now") {
        if (!client) {
          return sendJson(res, 400, { error: "Not configured. POST /config first." });
        }
        console.log("[agent] Scrape triggered by user");
        void scheduler.triggerNow(client);
        return sendJson(res, 200, { ok: true, message: "Scrape triggered" });
      }

      if (method === "POST" && pathname === "/scrape/stop") {
        const wasRunning = scheduler.isRunning;
        console.log(wasRunning ? "[agent] Scrape stopped by user" : "[agent] Stop requested — no scrape in progress");
        scheduler.stopScrape();
        return sendJson(res, 200, {
          ok: true,
          message: wasRunning ? "Stop requested — will halt after current module completes" : "No scrape in progress",
        });
      }

      if (method === "POST" && pathname === "/stop") {
        console.log("[agent] Application shutdown requested (POST /stop)");
        scheduler.stop();
        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          console.log("[agent] Application process exiting");
          process.exit(0);
        }, 500);
        return;
      }

      if (method === "POST" && pathname === "/clear-profile") {
        try {
          if (existsSync(BROWSER_PROFILE_DIR)) {
            rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true });
            console.log("[agent] Browser profile cleared — will start fresh on next scrape");
          } else {
            console.log("[agent] Browser profile directory not found — nothing to clear");
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          console.error("[agent] Failed to clear browser profile:", err);
          return sendJson(res, 500, { error: String(err) });
        }
      }

      sendJson(res, 404, { error: `${method} ${pathname} not found` });
    } catch (err) {
      console.error("[agent] Request error:", err);
      sendJson(res, 500, { error: String(err) });
    }
  })();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[agent] Port ${PORT} is already in use — another instance may be running. Exiting.`);
  } else {
    console.error(`[agent] Server error:`, err);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agent] Application process started (PID ${process.pid})`);
  console.log(`[agent] Auto-Scraper agent v${AGENT_VERSION} listening on http://127.0.0.1:${PORT}`);
});

function shutdownFromSignal(signal: string): void {
  console.log(`[agent] Application shutdown requested (${signal})`);
  scheduler.stop();
  setTimeout(() => {
    console.log("[agent] Application process exiting");
    process.exit(0);
  }, 300);
}

process.on("SIGINT", () => shutdownFromSignal("SIGINT"));
process.on("SIGTERM", () => shutdownFromSignal("SIGTERM"));

// Auto-start scheduler if already configured from a previous run
const storedConfig = readConfig();
if (storedConfig) {
  console.log(`[agent] Loaded saved config: serverUrl=${storedConfig.serverUrl}`);
  client = new AgentApiClient(storedConfig.serverUrl, storedConfig.apiKey);
  scheduler.start(client, AGENT_VERSION);
} else {
  console.log("[agent] No saved config. POST http://127.0.0.1:9001/config with { apiKey, serverUrl } to start.");
}
