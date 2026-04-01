import http from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfig, writeConfig } from "./store.js";
import { AgentApiClient } from "./api-client.js";
import { Scheduler } from "./scheduler.js";
import { SIDECAR_TOKEN, isAuthorized } from "./auth.js";
import { AGENT_LOG_BUFFER, SCRAPER_LOG_BUFFER, agentLogger } from "./logger.js";

// Announce the token on stdout before the HTTP server starts.
// Written via process.stdout.write (not console.log) to avoid the log buffer
// and to prevent the secret from appearing in log files.
process.stdout.write(`SIDECAR_TOKEN=${SIDECAR_TOKEN}\n`);

// Must match USER_DATA_DIR in shared/browser/context.ts
const BROWSER_PROFILE_DIR = join(homedir(), ".auto-scraper", "browser-profile");

const PORT = 9001;
const AGENT_VERSION = "0.6.13";

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
        return sendJson(res, 200, { logs: AGENT_LOG_BUFFER });
      }

      if (method === "GET" && pathname === "/scraper-logs") {
        return sendJson(res, 200, { logs: SCRAPER_LOG_BUFFER });
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
        if (level === "error") agentLogger.error(msg);
        else if (level === "warn") agentLogger.warn(msg);
        else agentLogger.info(msg);
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/pause") {
        scheduler.pause();
        agentLogger.info("[agent] Scheduler paused by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/resume") {
        if (!client) {
          return sendJson(res, 400, { error: "Not configured. POST /config first." });
        }
        void scheduler.resume(client);
        agentLogger.info("[agent] Scheduler resumed by user");
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
          agentLogger.info(
            `[agent] Config saved (first run): serverUrl=${serverUrl}, apiKey tail ...${keyTail}`,
          );
        } else {
          const urlChanged = previous.serverUrl !== serverUrl;
          const keyChanged = previous.apiKey !== resolvedKey;
          agentLogger.info(
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
        agentLogger.info("[agent] Scrape triggered by user");
        void scheduler.triggerNow(client);
        return sendJson(res, 200, { ok: true, message: "Scrape triggered" });
      }

      if (method === "POST" && pathname === "/scrape/stop") {
        const wasRunning = scheduler.isRunning;
        agentLogger.info(wasRunning ? "[agent] Scrape stopped by user" : "[agent] Stop requested — no scrape in progress");
        scheduler.stopScrape();
        return sendJson(res, 200, {
          ok: true,
          message: wasRunning ? "Stop requested — will halt after current module completes" : "No scrape in progress",
        });
      }

      if (method === "POST" && pathname === "/stop") {
        agentLogger.info("[agent] Application shutdown requested (POST /stop)");
        scheduler.stop();
        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          agentLogger.info("[agent] Application process exiting");
          process.exit(0);
        }, 500);
        return;
      }

      if (method === "POST" && pathname === "/clear-profile") {
        try {
          if (existsSync(BROWSER_PROFILE_DIR)) {
            rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true });
            agentLogger.info("[agent] Browser profile cleared — will start fresh on next scrape");
          } else {
            agentLogger.info("[agent] Browser profile directory not found — nothing to clear");
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          agentLogger.error("[agent] Failed to clear browser profile: " + String(err));
          return sendJson(res, 500, { error: String(err) });
        }
      }

      sendJson(res, 404, { error: `${method} ${pathname} not found` });
    } catch (err) {
      agentLogger.error("[agent] Request error: " + String(err));
      sendJson(res, 500, { error: String(err) });
    }
  })();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    agentLogger.error(`[agent] Port ${PORT} is already in use — another instance may be running. Exiting.`);
  } else {
    agentLogger.error(`[agent] Server error: ${String(err)}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  agentLogger.info(`[agent] Application process started (PID ${process.pid})`);
  agentLogger.info(`[agent] Auto-Scraper agent v${AGENT_VERSION} listening on http://127.0.0.1:${PORT}`);
});

function shutdownFromSignal(signal: string): void {
  agentLogger.info(`[agent] Application shutdown requested (${signal})`);
  scheduler.stop();
  setTimeout(() => {
    agentLogger.info("[agent] Application process exiting");
    process.exit(0);
  }, 300);
}

process.on("SIGINT", () => shutdownFromSignal("SIGINT"));
process.on("SIGTERM", () => shutdownFromSignal("SIGTERM"));

// Auto-start scheduler if already configured from a previous run
const storedConfig = readConfig();
if (storedConfig) {
  agentLogger.info(`[agent] Loaded saved config: serverUrl=${storedConfig.serverUrl}`);
  client = new AgentApiClient(storedConfig.serverUrl, storedConfig.apiKey);
  scheduler.start(client, AGENT_VERSION);
} else {
  agentLogger.info("[agent] No saved config. POST http://127.0.0.1:9001/config with { apiKey, serverUrl } to start.");
}
