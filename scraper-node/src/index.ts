import http from "node:http";
import { readConfig, writeConfig } from "./store.js";
import { AgentApiClient } from "./api-client.js";
import { Scheduler } from "./scheduler.js";

const PORT = 9001;
const AGENT_VERSION = "0.1.0";

let client: AgentApiClient | null = null;
const scheduler = new Scheduler();

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
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

const server = http.createServer((req, res) => {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;

  void (async () => {
    try {
      if (method === "GET" && pathname === "/health") {
        const config = readConfig();
        return sendJson(res, 200, { hasApiKey: !!config?.apiKey, version: AGENT_VERSION });
      }

      if (method === "GET" && pathname === "/config") {
        const config = readConfig();
        // Never expose the API key over the local HTTP interface
        return sendJson(res, 200, config ? { serverUrl: config.serverUrl } : {});
      }

      if (method === "POST" && pathname === "/config") {
        const body = await readBody(req) as Record<string, unknown>;
        const { apiKey, serverUrl } = body;
        if (typeof apiKey !== "string" || typeof serverUrl !== "string") {
          return sendJson(res, 400, { error: "apiKey and serverUrl are required strings" });
        }
        writeConfig({ apiKey, serverUrl });
        client = new AgentApiClient(serverUrl, apiKey);
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

      sendJson(res, 404, { error: `${method} ${pathname} not found` });
    } catch (err) {
      console.error("[agent] Request error:", err);
      sendJson(res, 500, { error: String(err) });
    }
  })();
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
