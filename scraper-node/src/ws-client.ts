import type { AgentApiClient } from "./api-client.js";
import { agentLogger } from "./logger.js";

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

export class AgentWebSocketClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private lastCommandHintId: string | null = null;

  constructor(
    private readonly client: AgentApiClient,
    private readonly onCommandAvailable: (commandId: string) => void = () => {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.socket?.close(1000, "stopped");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      const { token, expiresAt } = await this.client.getWsToken();
      if (this.stopped) return;

      const socket = new WebSocket(this.client.wsUrl(token));
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        agentLogger.info("[ws] Connected to agent WebSocket");
        this.scheduleTokenRefresh(expiresAt);
        this.fireImmediateHeartbeat("connect");
      });

      socket.addEventListener("message", (event) => {
        this.logMessage(event.data);
      });

      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        agentLogger.warn(`[ws] Closed code=${event.code} reason=${event.reason || "none"}`);
        this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        agentLogger.warn("[ws] Connection error");
      });
    } catch (err) {
      if (!this.stopped) {
        agentLogger.warn(`[ws] Failed to connect: ${String(err)}`);
        this.scheduleReconnect();
      }
    }
  }

  private scheduleTokenRefresh(expiresAt: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(30_000, expiresAt * 1000 - Date.now() - TOKEN_REFRESH_SKEW_MS);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.stopped) return;
      agentLogger.info("[ws] Refreshing WebSocket token");
      this.socket?.close(4001, "token refresh");
      this.scheduleReconnect(0);
    }, delay);
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const backoff = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const delay = delayOverride ?? jitter(backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private logMessage(data: unknown): void {
    if (typeof data !== "string") return;
    try {
      const parsed = JSON.parse(data) as { type?: unknown };
      if (parsed.type === "connected") {
        agentLogger.info("[ws] Server accepted connection");
        return;
      }

      if (parsed.type === "command.available") {
        const commandId = (parsed as { commandId?: unknown }).commandId;
        if (typeof commandId !== "string" || commandId.length === 0) return;
        if (commandId === this.lastCommandHintId) return;
        this.lastCommandHintId = commandId;
        agentLogger.info("[ws] Command available - firing immediate heartbeat");
        this.fireImmediateHeartbeat(commandId);
      }
    } catch {
      agentLogger.warn("[ws] Ignoring non-JSON message");
    }
  }

  private fireImmediateHeartbeat(commandId: string): void {
    try {
      this.onCommandAvailable(commandId);
    } catch (err) {
      agentLogger.warn(`[ws] Command wake callback failed: ${String(err)}`);
    }
  }
}
