import http from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { hasUsableAgentCredentials, readConfig, updateConfig, writeConfig, type AgentConfig } from "./store.js";
import { AgentApiClient, registerAgent } from "./api-client.js";
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
const AGENT_VERSION = "0.7.10";
const REGISTRATION_RETRY_BASE_MS = 5_000;
const REGISTRATION_RETRY_MAX_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let client: AgentApiClient | null = null;
let registrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let configStartGeneration = 0;
const scheduler = new Scheduler((paused) => {
  updateConfig({ schedulerPaused: paused });
});

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

async function ensureAgentClient(config: AgentConfig): Promise<{
  client: AgentApiClient;
  config: AgentConfig & { agentId: string; agentSecret: string };
  registered: boolean;
}> {
  if (hasUsableAgentCredentials(config)) {
    return {
      client: new AgentApiClient(config.serverUrl, config.agentId, config.agentSecret),
      config,
      registered: false,
    };
  }

  const registration = await registerAgent(config.serverUrl, config.apiKey, {
    displayName: hostname(),
    hostname: hostname(),
    version: AGENT_VERSION,
    platform: process.platform,
  });
  const nextConfig = {
    ...config,
    agentId: registration.agentId,
    agentSecret: registration.agentSecret,
    credentialServerUrl: config.serverUrl,
    credentialApiKey: config.apiKey,
  };
  return {
    client: new AgentApiClient(nextConfig.serverUrl, nextConfig.agentId, nextConfig.agentSecret),
    config: nextConfig,
    registered: true,
  };
}

function clearRegistrationRetry(): void {
  if (registrationRetryTimer) clearTimeout(registrationRetryTimer);
  registrationRetryTimer = null;
}

function beginConfigStart(): number {
  clearRegistrationRetry();
  configStartGeneration += 1;
  return configStartGeneration;
}

function isCurrentConfigStart(generation: number): boolean {
  return generation === configStartGeneration;
}

function registrationRetryDelay(attempt: number): number {
  return Math.min(REGISTRATION_RETRY_BASE_MS * 2 ** attempt, REGISTRATION_RETRY_MAX_MS);
}

async function startConfiguredAgent(config: AgentConfig, generation: number): Promise<boolean> {
  const ensured = await ensureAgentClient(config);
  if (!isCurrentConfigStart(generation)) {
    agentLogger.info("[agent] Ignoring stale registration result after config changed");
    return false;
  }
  writeConfig(ensured.config);
  client = ensured.client;
  if (ensured.registered) {
    agentLogger.info(`[agent] Registered device ${ensured.config.agentId}`);
  }
  scheduler.stop();
  scheduler.start(client, AGENT_VERSION, ensured.config.schedulerPaused ?? false);
  return true;
}

function startSavedConfigWithRetry(config: AgentConfig, attempt = 0, generation = beginConfigStart()): void {
  void startConfiguredAgent(config, generation)
    .then((started) => {
      if (!started || !isCurrentConfigStart(generation)) return;
      clearRegistrationRetry();
    })
    .catch((err: unknown) => {
      if (!isCurrentConfigStart(generation)) return;
      const delay = registrationRetryDelay(attempt);
      agentLogger.error(
        `[agent] Failed to register saved config: ${String(err)}; retrying in ${Math.round(delay / 1000)}s`,
      );
      registrationRetryTimer = setTimeout(() => {
        if (!isCurrentConfigStart(generation)) return;
        const latest = readConfig();
        if (!latest) return;
        startSavedConfigWithRetry(latest, attempt + 1, generation);
      }, delay);
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
        const keepExistingCredentials =
          previous?.serverUrl === serverUrl &&
          previous.apiKey === resolvedKey &&
          hasUsableAgentCredentials(previous);
        const nextConfig: AgentConfig = keepExistingCredentials
          ? { ...previous, apiKey: resolvedKey, serverUrl }
          : { apiKey: resolvedKey, serverUrl, schedulerPaused: previous?.schedulerPaused };
        const generation = beginConfigStart();
        const ensured = await ensureAgentClient(nextConfig);
        if (!isCurrentConfigStart(generation)) {
          return sendJson(res, 409, { error: "Configuration superseded by a newer request" });
        }
        writeConfig(ensured.config);
        client = ensured.client;
        scheduler.stop();
        scheduler.start(client, AGENT_VERSION, ensured.config.schedulerPaused ?? false);

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
        if (ensured.registered) agentLogger.info(`[agent] Registered device ${ensured.config.agentId}`);
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
  startSavedConfigWithRetry(storedConfig);
} else {
  agentLogger.info("[agent] No saved config. POST http://127.0.0.1:9001/config with { apiKey, serverUrl } to start.");
}
