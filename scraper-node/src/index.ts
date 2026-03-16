import http from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfig, writeConfig } from "./store.js";
import { AgentApiClient } from "./api-client.js";
import { Scheduler } from "./scheduler.js";

// Must match USER_DATA_DIR in shared/browser/context.ts
const BROWSER_PROFILE_DIR = join(homedir(), ".auto-scraper", "browser-profile");

const PORT = 9001;
const AGENT_VERSION = "0.2.6";

// ---------------------------------------------------------------------------
// In-memory log ring buffer — captured from all console.log/error calls
// so the renderer can display them in the Logs tab.
// ---------------------------------------------------------------------------

interface LogEntry {
  ts: string;
  level: "info" | "error";
  msg: string;
}

const LOG_BUFFER: LogEntry[] = [];
const MAX_LOG_LINES = 300;

function pushLog(level: "info" | "error", ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  LOG_BUFFER.push({ ts: new Date().toISOString(), level, msg });
  if (LOG_BUFFER.length > MAX_LOG_LINES) LOG_BUFFER.shift();
}

// Intercept all console output so every module's logs are captured.
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const hhmm = () => new Date().toTimeString().slice(0, 8);
console.log = (...args: unknown[]) => { pushLog("info", ...args); _origLog(`[${hhmm()}]`, ...args); };
console.error = (...args: unknown[]) => { pushLog("error", ...args); _origErr(`[${hhmm()}]`, ...args); };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let client: AgentApiClient | null = null;
const scheduler = new Scheduler();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
      if (method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/health") {
        const config = readConfig();
        return sendJson(res, 200, { hasApiKey: !!config?.apiKey, version: AGENT_VERSION });
      }

      if (method === "GET" && pathname === "/config") {
        const config = readConfig();
        // Never expose the API key — return serverUrl + a flag so the UI
        // can show "key saved" without revealing the actual value.
        return sendJson(res, 200, {
          serverUrl: config?.serverUrl ?? null,
          hasApiKey: !!config?.apiKey,
        });
      }

      if (method === "GET" && pathname === "/logs") {
        return sendJson(res, 200, { logs: LOG_BUFFER });
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

        writeConfig({ apiKey: resolvedKey, serverUrl });
        client = new AgentApiClient(serverUrl, resolvedKey);
        scheduler.stop();
        scheduler.start(client);
        console.log(`[agent] Configured: serverUrl=${serverUrl}`);
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scrape/now") {
        if (!client) {
          return sendJson(res, 400, { error: "Not configured. POST /config first." });
        }
        void scheduler.triggerNow(client);
        return sendJson(res, 200, { ok: true, message: "Scrape triggered" });
      }

      if (method === "POST" && pathname === "/stop") {
        scheduler.stop();
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 500);
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
  console.log(`[agent] Auto-Scraper agent v${AGENT_VERSION} listening on http://127.0.0.1:${PORT}`);
});

// Auto-start scheduler if already configured from a previous run
const storedConfig = readConfig();
if (storedConfig) {
  console.log(`[agent] Loaded saved config: serverUrl=${storedConfig.serverUrl}`);
  client = new AgentApiClient(storedConfig.serverUrl, storedConfig.apiKey);
  scheduler.start(client);
} else {
  console.log("[agent] No saved config. POST http://127.0.0.1:9001/config with { apiKey, serverUrl } to start.");
}
