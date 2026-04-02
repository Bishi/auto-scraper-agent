import { createClient } from "@supabase/supabase-js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { AgentApiClient } from "./api-client.js";
import { agentLogger } from "./logger.js";

const REFRESH_BEFORE_EXPIRY_S = 600;   // refresh 10 min before token expires
const BACKOFF_BASE_MS          = 1_000;
const BACKOFF_MAX_MS           = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const COOLDOWN_MS              = 5 * 60_000; // 5 min after 5 consecutive failures

type AgentSessionCommandEnvelope = {
  pending_command?: string | null;
  pending_command_id?: string | null;
};

export function shouldTriggerCommandHint(
  nextRow: AgentSessionCommandEnvelope,
  prevRow: AgentSessionCommandEnvelope,
  lastSeenCommandId: string | null,
): boolean {
  const nextCommand = nextRow.pending_command ?? null;
  const nextId = nextRow.pending_command_id ?? null;
  const prevCommand = prevRow.pending_command ?? null;
  const prevId = prevRow.pending_command_id ?? null;

  if (nextCommand == null || nextId == null) {
    return false;
  }

  if (nextCommand === prevCommand && nextId === prevId) {
    return false;
  }

  return nextId !== lastSeenCommandId;
}

/**
 * Maintains a Supabase Realtime subscription to `agent_sessions` so the agent
 * receives an instant push when a new command is enqueued (command envelope changes).
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
  /**
   * Incremented at the start of every connect() call. Any async operation
   * (token fetch, cooldown timer, reconnect timer) checks this before
   * proceeding so stale chains from a previous connect() bail out silently.
   * This prevents the token-refresh timer and the error-reconnect timer from
   * running as two concurrent connect() chains, which caused double cooldown
   * logs and shared consecutiveFailures corruption after wake-from-sleep.
   */
  private connectGeneration = 0;
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
    this.connectGeneration++; // invalidate any in-flight connect()
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

    // Claim this generation. Any timer or async op from a previous connect()
    // chain that checks gen will see a mismatch and bail — prevents concurrent
    // chains when token-refresh and error-reconnect fire at the same time.
    const gen = ++this.connectGeneration;

    // Cancel any pending timer from a previous chain so only this chain runs.
    this.clearTimers();

    // Cooldown after too many consecutive failures.
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      agentLogger.warn(
        `[realtime] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — cooling down for 5 min`,
      );
      this.reconnectTimer = setTimeout(() => {
        if (this.connectGeneration !== gen) return; // superseded
        this.consecutiveFailures = 0;
        void this.connect(0);
      }, COOLDOWN_MS);
      return;
    }

    let token: string;
    let expiresAt: number;

    try {
      const res = await this.client.getRealtimeToken();
      if (this.connectGeneration !== gen) return; // superseded during async fetch
      token = res.token;
      expiresAt = res.expiresAt;
    } catch (err) {
      if (this.connectGeneration !== gen) return; // superseded during async fetch
      this.consecutiveFailures++;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      agentLogger.warn(
        `[realtime] Failed to get token (attempt ${attempt + 1}): ${String(err)} — retrying in ${delay / 1000}s`,
      );
      this.reconnectTimer = setTimeout(() => {
        if (this.connectGeneration !== gen) return; // superseded
        void this.connect(attempt + 1);
      }, delay);
      return;
    }

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
          const nextRow = payload.new as AgentSessionCommandEnvelope;
          const prevRow = payload.old as AgentSessionCommandEnvelope;

          // React only to command-envelope changes.
          // Heartbeat writes touch other columns (last_heartbeat, etc.) but
          // don't change pending_command_id — this prevents a feedback loop.
          if (shouldTriggerCommandHint(nextRow, prevRow, this.lastSeenCommandId)) {
            agentLogger.info("[realtime] New command detected — firing immediate heartbeat");
            this.lastSeenCommandId = nextRow.pending_command_id ?? null;
            this.onCommandHint();
          }
        },
      )
      .subscribe((status, err) => {
        // Guard against stale callbacks. Setting this.channel = null in the error
        // branch below makes all subsequent callbacks from this channel instance
        // no-ops — prevents spurious re-SUBSCRIBED events after unsubscribe() and
        // duplicate connect() calls when Supabase internally retries the socket.
        if (this.channel !== channel) return;

        if (status === "SUBSCRIBED") {
          // Only reset failure counter on a real successful connection.
          this.consecutiveFailures = 0;
          agentLogger.info("[realtime] Subscribed to agent_sessions — instant command delivery active");
          this.scheduleTokenRefresh(expiresAt, gen);
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
          // Null out this.channel first — makes this callback a no-op for any
          // future invocations from this channel instance (Supabase internal retry).
          this.channel = null;
          channel.unsubscribe().catch(() => undefined);
          this.clearTimers();
          if (!this.stopped) {
            const nextAttempt = attempt + 1;
            const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
            this.consecutiveFailures++;
            const errDetail = err ? `: ${String(err)}` : "";
            agentLogger.warn(
              `[realtime] Channel ${status}${errDetail} — reconnecting in ${delay / 1000}s (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
            );
            this.reconnectTimer = setTimeout(() => {
              if (this.connectGeneration !== gen) return; // superseded
              void this.connect(nextAttempt);
            }, delay);
          }
        }
      });

    this.channel = channel;
  }

  private scheduleTokenRefresh(expiresAt: number, gen: number): void {
    const nowS = Math.floor(Date.now() / 1000);
    const refreshInMs = Math.max(0, (expiresAt - nowS - REFRESH_BEFORE_EXPIRY_S) * 1000);

    this.refreshTimer = setTimeout(() => {
      if (this.connectGeneration !== gen) return; // superseded
      // Reset failures — the previous connection was healthy (we were SUBSCRIBED).
      this.consecutiveFailures = 0;
      agentLogger.info("[realtime] Refreshing Realtime token");
      void this.connect(0);
    }, refreshInMs);
  }
}
