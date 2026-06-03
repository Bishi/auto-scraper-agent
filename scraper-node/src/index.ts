import http from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import {
  clearAgentCredentials,
  hasUsableAgentCredentials,
  readConfig,
  updateConfig,
  writeConfig,
  type AgentConfig,
} from "./store.js";
import {
  AgentApiClient,
  consumePairingCode,
  registerAgent,
  type AgentDeviceRevocationReason,
} from "./api-client.js";
import { Scheduler } from "./scheduler.js";
import { SIDECAR_TOKEN, isAuthorized } from "./auth.js";
import { AGENT_LOG_BUFFER, SCRAPER_LOG_BUFFER, agentLogger } from "./logger.js";
import {
  configureCentralLogUpload,
  stopCentralLogUpload,
} from "./central-log-queue.js";

// Announce the token on stdout before the HTTP server starts.
// Written via process.stdout.write (not console.log) to avoid the log buffer
// and to prevent the secret from appearing in log files.
process.stdout.write(`SIDECAR_TOKEN=${SIDECAR_TOKEN}\n`);

// Must match USER_DATA_DIR in shared/browser/context.ts
const BROWSER_PROFILE_DIR = join(homedir(), ".auto-scraper", "browser-profile");

const PORT = 9001;
const AGENT_VERSION = "0.8.0";
const REGISTRATION_RETRY_BASE_MS = 5_000;
const REGISTRATION_RETRY_MAX_MS = 5 * 60_000;
const REVOKE_PREVIOUS_CREDENTIALS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let client: AgentApiClient | null = null;
let registrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let configStartGeneration = 0;
const scheduler = new Scheduler(
  (paused) => {
    updateConfig({ schedulerPaused: paused });
  },
  () => {
    clearRegistrationRetry();
    configStartGeneration += 1;
    clearAgentCredentials();
    client = null;
    stopCentralLogUpload();
  },
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sidecar-Token",
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ensureAgentClient(config: AgentConfig): Promise<{
  client: AgentApiClient;
  config: AgentConfig & { agentId: string; agentSecret: string };
  registered: boolean;
}> {
  if (hasUsableAgentCredentials(config)) {
    return {
      client: new AgentApiClient(
        config.serverUrl,
        config.agentId,
        config.agentSecret,
      ),
      config,
      registered: false,
    };
  }

  if (!config.apiKey) {
    throw new Error(
      "No device credentials found. Pair this agent from Mission Control or enter a legacy API key.",
    );
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
    client: new AgentApiClient(
      nextConfig.serverUrl,
      nextConfig.agentId,
      nextConfig.agentSecret,
    ),
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

async function revokeExistingAgentCredentials(
  previous: AgentConfig | null,
  reason: AgentDeviceRevocationReason,
): Promise<void> {
  if (!previous || !hasUsableAgentCredentials(previous)) return;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REVOKE_PREVIOUS_CREDENTIALS_TIMEOUT_MS,
  );
  try {
    await new AgentApiClient(
      previous.credentialServerUrl ?? previous.serverUrl,
      previous.agentId,
      previous.agentSecret,
    ).revokeCurrentDevice(reason, { signal: controller.signal });
    agentLogger.info(
      `[config] Revoked previous device credentials (${reason})`,
    );
  } catch (err) {
    agentLogger.warn(
      `[config] Could not revoke previous device credentials after switching pairing: ${errorMessage(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function registrationRetryDelay(attempt: number): number {
  return Math.min(
    REGISTRATION_RETRY_BASE_MS * 2 ** attempt,
    REGISTRATION_RETRY_MAX_MS,
  );
}

async function startConfiguredAgent(
  config: AgentConfig,
  generation: number,
): Promise<boolean> {
  const ensured = await ensureAgentClient(config);
  if (!isCurrentConfigStart(generation)) {
    agentLogger.info(
      "[config] Ignoring stale registration result after config changed",
    );
    return false;
  }
  writeConfig(ensured.config);
  client = ensured.client;
  configureCentralLogUpload(client);
  if (ensured.registered) {
    agentLogger.info(`[config] Registered device ${ensured.config.agentId}`);
  }
  scheduler.stop();
  scheduler.start(
    client,
    AGENT_VERSION,
    ensured.config.schedulerPaused ?? false,
  );
  return true;
}

function startSavedConfigWithRetry(
  config: AgentConfig,
  attempt = 0,
  generation = beginConfigStart(),
): void {
  void startConfiguredAgent(config, generation)
    .then((started) => {
      if (!started || !isCurrentConfigStart(generation)) return;
      clearRegistrationRetry();
    })
    .catch((err: unknown) => {
      if (!isCurrentConfigStart(generation)) return;
      const delay = registrationRetryDelay(attempt);
      agentLogger.error(
        `[config] Failed to register saved config: ${String(err)}; retrying in ${Math.round(delay / 1000)}s`,
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
        return sendJson(res, 200, {
          hasApiKey: !!config?.apiKey,
          version: AGENT_VERSION,
        });
      }

      // All other routes require the shared secret generated at startup.
      if (!isAuthorized(req.headers)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (method === "GET" && pathname === "/config") {
        const config = readConfig();
        const key = config?.apiKey;
        // Never expose the full key — same tail convention as admin Fleet (last 4 chars).
        const apiKeyTail = key && key.length >= 4 ? key.slice(-4) : null;
        return sendJson(res, 200, {
          serverUrl: config?.serverUrl ?? null,
          hasApiKey: !!key,
          apiKeyTail,
          hasAgentCredentials: !!config && hasUsableAgentCredentials(config),
        });
      }

      if (method === "GET" && pathname === "/logs") {
        return sendJson(res, 200, { logs: AGENT_LOG_BUFFER });
      }

      if (method === "GET" && pathname === "/scraper-logs") {
        return sendJson(res, 200, { logs: SCRAPER_LOG_BUFFER });
      }

      if (method === "GET" && pathname === "/schedule") {
        return sendJson(res, 200, {
          nextRunAt: scheduler.nextRunAt,
          paused: scheduler.isPaused,
          running: scheduler.isRunning,
        });
      }

      if (method === "GET" && pathname === "/update/check") {
        return sendJson(res, 200, { pending: scheduler.consumeUpdateCheck() });
      }

      if (method === "POST" && pathname === "/log") {
        const body = (await readBody(req)) as { level?: string; msg?: string };
        const level =
          body.level === "error"
            ? "error"
            : body.level === "warn"
              ? "warn"
              : "info";
        const msg =
          typeof body.msg === "string" ? body.msg : String(body.msg ?? "");
        if (level === "error") agentLogger.error(msg);
        else if (level === "warn") agentLogger.warn(msg);
        else agentLogger.info(msg);
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/pause") {
        scheduler.pause();
        agentLogger.info("[scheduler] Scheduler paused by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scheduler/resume") {
        if (!client) {
          return sendJson(res, 400, {
            error: "Not configured. POST /config first.",
          });
        }
        void scheduler.resume(client);
        agentLogger.info("[scheduler] Scheduler resumed by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/config") {
        const body = (await readBody(req)) as Record<string, unknown>;
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
            return sendJson(res, 400, {
              error: "apiKey is required (no saved key found)",
            });
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
          : {
              apiKey: resolvedKey,
              serverUrl,
              schedulerPaused: previous?.schedulerPaused,
            };
        const generation = beginConfigStart();
        const ensured = await ensureAgentClient(nextConfig);
        if (!isCurrentConfigStart(generation)) {
          return sendJson(res, 409, {
            error: "Configuration superseded by a newer request",
          });
        }
        writeConfig(ensured.config);
        client = ensured.client;
        configureCentralLogUpload(client);
        scheduler.stop();
        scheduler.start(
          client,
          AGENT_VERSION,
          ensured.config.schedulerPaused ?? false,
        );

        const keyTail =
          resolvedKey.length >= 4 ? resolvedKey.slice(-4) : "????";
        if (!previous) {
          agentLogger.info(
            `[config] Config saved (first run): serverUrl=${serverUrl}, apiKey tail ...${keyTail}`,
          );
        } else {
          const urlChanged = previous.serverUrl !== serverUrl;
          const keyChanged = previous.apiKey !== resolvedKey;
          agentLogger.info(
            `[config] Config saved: serverUrl=${serverUrl}` +
              (urlChanged
                ? ` (URL changed from ${previous.serverUrl})`
                : " (URL unchanged)") +
              (keyChanged
                ? `, apiKey updated (tail ...${keyTail})`
                : `, apiKey unchanged (tail ...${keyTail})`),
          );
        }
        if (ensured.registered)
          agentLogger.info(
            `[config] Registered device ${ensured.config.agentId}`,
          );
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/pairing/consume") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const serverUrl =
          typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!serverUrl || !code) {
          return sendJson(res, 400, {
            error: "serverUrl and code are required",
          });
        }
        const generation = beginConfigStart();
        const paired = await consumePairingCode(serverUrl, code, {
          displayName: hostname(),
          hostname: hostname(),
          version: AGENT_VERSION,
          platform: process.platform,
        });
        if (!isCurrentConfigStart(generation)) {
          return sendJson(res, 409, {
            error: "Configuration superseded by a newer request",
          });
        }
        const previous = readConfig();
        const nextConfig: AgentConfig = {
          serverUrl,
          agentId: paired.agentId,
          agentSecret: paired.agentSecret,
          credentialServerUrl: serverUrl,
          schedulerPaused: previous?.schedulerPaused,
        };
        writeConfig(nextConfig);
        client = new AgentApiClient(
          serverUrl,
          paired.agentId,
          paired.agentSecret,
        );
        configureCentralLogUpload(client);
        scheduler.stop();
        scheduler.start(
          client,
          AGENT_VERSION,
          nextConfig.schedulerPaused ?? false,
          { runStartupScrape: false },
        );
        agentLogger.info(`[config] Paired device ${paired.agentId}`);
        void revokeExistingAgentCredentials(
          previous,
          "paired_to_another_account",
        );
        return sendJson(res, 200, { ok: true, agentId: paired.agentId });
      }

      if (method === "POST" && pathname === "/pairing/revoke") {
        const previous = readConfig();
        if (!previous || !hasUsableAgentCredentials(previous)) {
          return sendJson(res, 400, {
            error: "No paired device credentials found.",
          });
        }
        await revokeExistingAgentCredentials(previous, "agent_disconnected");
        clearAgentCredentials();
        client = null;
        stopCentralLogUpload();
        scheduler.stop();
        agentLogger.info("[config] Local device pairing revoked by user");
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/scrape/now") {
        if (!client) {
          return sendJson(res, 400, {
            error: "Not configured. POST /config first.",
          });
        }
        agentLogger.info("[scrape] Scrape triggered by user");
        void scheduler.triggerNow(client);
        return sendJson(res, 200, { ok: true, message: "Scrape triggered" });
      }

      if (method === "POST" && pathname === "/scrape/stop") {
        const wasRunning = scheduler.isRunning;
        agentLogger.info(
          wasRunning
            ? "[scrape] Scrape stopped by user"
            : "[scrape] Stop requested — no scrape in progress",
        );
        scheduler.stopScrape();
        return sendJson(res, 200, {
          ok: true,
          message: wasRunning
            ? "Stop requested — will halt after current module completes"
            : "No scrape in progress",
        });
      }

      if (method === "POST" && pathname === "/stop") {
        agentLogger.info(
          "[system] Application shutdown requested (POST /stop)",
        );
        stopCentralLogUpload();
        scheduler.stop();
        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          agentLogger.info("[system] Application process exiting");
          process.exit(0);
        }, 500);
        return;
      }

      if (method === "POST" && pathname === "/clear-profile") {
        try {
          if (existsSync(BROWSER_PROFILE_DIR)) {
            rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true });
            agentLogger.info(
              "[system] Browser profile cleared — will start fresh on next scrape",
            );
          } else {
            agentLogger.info(
              "[system] Browser profile directory not found — nothing to clear",
            );
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          agentLogger.error(
            "[system] Failed to clear browser profile: " + String(err),
          );
          return sendJson(res, 500, { error: errorMessage(err) });
        }
      }

      sendJson(res, 404, { error: `${method} ${pathname} not found` });
    } catch (err) {
      agentLogger.error("[system] Request error: " + errorMessage(err));
      sendJson(res, 500, { error: errorMessage(err) });
    }
  })();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    agentLogger.error(
      `[system] Port ${PORT} is already in use — another instance may be running. Exiting.`,
    );
  } else {
    agentLogger.error(`[system] Server error: ${String(err)}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  agentLogger.info(`[system] Application process started (PID ${process.pid})`);
  agentLogger.info(
    `[system] Auto-Scraper agent v${AGENT_VERSION} listening on http://127.0.0.1:${PORT}`,
  );
});

function shutdownFromSignal(signal: string): void {
  agentLogger.info(`[system] Application shutdown requested (${signal})`);
  stopCentralLogUpload();
  scheduler.stop();
  setTimeout(() => {
    agentLogger.info("[system] Application process exiting");
    process.exit(0);
  }, 300);
}

process.on("SIGINT", () => shutdownFromSignal("SIGINT"));
process.on("SIGTERM", () => shutdownFromSignal("SIGTERM"));

// Auto-start scheduler if already configured from a previous run
const storedConfig = readConfig();
if (storedConfig) {
  agentLogger.info(
    `[config] Loaded saved config: serverUrl=${storedConfig.serverUrl}`,
  );
  startSavedConfigWithRetry(storedConfig);
} else {
  agentLogger.info(
    "[config] No saved config. POST http://127.0.0.1:9001/config with { apiKey, serverUrl } to start.",
  );
}
