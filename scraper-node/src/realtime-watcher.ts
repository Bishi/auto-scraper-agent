import { createClient } from "@supabase/supabase-js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { AgentApiClient } from "./api-client.js";
import { agentLogger } from "./logger.js";

const REFRESH_BEFORE_EXPIRY_S = 600;   // refresh 10 min before token expires
const BACKOFF_BASE_MS          = 1_000;
const BACKOFF_MAX_MS           = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const COOLDOWN_MS              = 5 * 60_000; // 5 min after 5 consecutive failures

/**
 * Maintains a Supabase Realtime subscription to `agent_sessions` so the agent
 * receives an instant push when a new command is enqueued (pending_command_id changes).
 *
 * This is a wake-up hint only — the heartbeat + ACK flow is the source of truth.
 * If the watcher cannot connect (old server, missing env var, network error), it
 * logs a warning and does nothing. The scheduler continues on its 60s heartbeat.
 */
export class RealtimeWatcher {
  private channel: RealtimeChannel | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private consecutiveFailures = 0;
  /** Last pending_command_id the watcher has seen — used to dedupe events. */
  private lastSeenCommandId: string | null = null;

  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
    private readonly client: AgentApiClient,
    private readonly onCommandHint: () => void,
  ) {}

  /**
   * Sync the last-seen command ID after each heartbeat response so we don't
   * fire a spurious wake-up when we first connect and the row already has a
   * pending command (which the heartbeat already delivered).
   */
  seedCommandId(id: string | null): void {
    this.lastSeenCommandId = id;
  }

  /** Start the watcher: fetch a token and open the Realtime channel. */
  async start(): Promise<void> {
    if (this.stopped) return;
    await this.connect(0);
  }

  /** Clean teardown — unsubscribes and clears all timers. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.channel) {
      this.channel.unsubscribe().catch(() => undefined);
      this.channel = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private clearTimers(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private async connect(attempt: number): Promise<void> {
    if (this.stopped) return;

    // Cooldown after too many consecutive failures.
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      agentLogger.warn(
        `[realtime] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — cooling down for 5 min`,
      );
      this.reconnectTimer = setTimeout(() => {
        this.consecutiveFailures = 0;
        void this.connect(0);
      }, COOLDOWN_MS);
      return;
    }

    let token: string;
    let expiresAt: number;

    try {
      const res = await this.client.getRealtimeToken();
      token = res.token;
      expiresAt = res.expiresAt;
    } catch (err) {
      this.consecutiveFailures++;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      agentLogger.warn(
        `[realtime] Failed to get token (attempt ${attempt + 1}): ${String(err)} — retrying in ${delay / 1000}s`,
      );
      this.reconnectTimer = setTimeout(() => void this.connect(attempt + 1), delay);
      return;
    }

    // Token acquired — reset failure counter.
    this.consecutiveFailures = 0;

    // Tear down any existing channel before creating a new one.
    if (this.channel) {
      this.channel.unsubscribe().catch(() => undefined);
      this.channel = null;
    }

    // createClient takes the public anon key as the second argument.
    // The user JWT goes only to setAuth() — passing it as the anon key would
    // cause the initial WebSocket handshake to fail with CHANNEL_ERROR.
    const supabase = createClient(this.supabaseUrl, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { apikey: this.anonKey } },
    });
    supabase.realtime.setAuth(token);

    const channel = supabase
      .channel("agent-commands")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "agent_sessions",
        },
        (payload) => {
          const newId = (payload.new as Record<string, unknown>)["pending_command_id"] as string | null | undefined;
          const oldId = (payload.old as Record<string, unknown>)["pending_command_id"] as string | null | undefined;

          // Only fire if pending_command_id changed to a new non-null value.
          // Heartbeat writes touch other columns (last_heartbeat, etc.) but
          // don't change pending_command_id — this prevents a feedback loop.
          if (
            newId != null &&
            newId !== oldId &&
            newId !== this.lastSeenCommandId
          ) {
            agentLogger.info("[realtime] New command detected — firing immediate heartbeat");
            this.lastSeenCommandId = newId;
            this.onCommandHint();
          }
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          agentLogger.info("[realtime] Subscribed to agent_sessions — instant command delivery active");
          this.scheduleTokenRefresh(expiresAt);
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
          agentLogger.warn(`[realtime] Channel ${status} — reconnecting`);
          this.channel = null;
          this.clearTimers();
          if (!this.stopped) {
            const nextAttempt = attempt + 1;
            const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
            this.consecutiveFailures++;
            this.reconnectTimer = setTimeout(() => void this.connect(nextAttempt), delay);
          }
        }
      });

    this.channel = channel;
  }

  private scheduleTokenRefresh(expiresAt: number): void {
    const nowS = Math.floor(Date.now() / 1000);
    const refreshInMs = Math.max(0, (expiresAt - nowS - REFRESH_BEFORE_EXPIRY_S) * 1000);

    this.refreshTimer = setTimeout(() => {
      agentLogger.info("[realtime] Refreshing Realtime token");
      void this.connect(0);
    }, refreshInMs);
  }
}
