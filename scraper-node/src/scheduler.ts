import { describeAgentApiError, type AgentApiClient } from "./api-client.js";
import { runModule } from "./scraper.js";
import { agentLogger, pushScraperLogs } from "./logger.js";
import type { DbConfig } from "./shared/types.js";
import { RealtimeWatcher } from "./realtime-watcher.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

type Trigger = "startup" | "schedule" | "manual" | "server" | "resume";

export class Scheduler {
  private scrapeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeWatcher: RealtimeWatcher | null = null;
  private _fireImmediateHeartbeat: (() => void) | null = null;
  private _running = false;
  private _paused = false;
  private _stopRequested = false;
  private _started = false;
  private _version = "";
  /** Set when the server sends a check_update command; read+cleared by GET /update/check. */
  private _pendingUpdateCheck = false;
  /**
   * Remaining ms that were left on the timer when pause() was called.
   * Used by resume() to restore the countdown rather than scraping immediately.
   */
  private _pausedRemainingMs: number | null = null;
  /** Outstanding pause/resume command id to ack on the next heartbeat(s) until the server clears pending. */
  private _pendingAckCommandId: string | null = null;
  /** Job ID currently being scraped, or null when idle. Sent in every heartbeat for server reconciliation. */
  private _activeJobId: number | null = null;
  /** True while a scrape cycle is actively executing. */
  get isRunning(): boolean { return this._running; }
  /** True when the scheduler is paused (heartbeat continues but scrapes are suspended). */
  get isPaused(): boolean { return this._paused; }
  /** Returns true (and clears the flag) if the server requested an update check. */
  consumeUpdateCheck(): boolean {
    const pending = this._pendingUpdateCheck;
    this._pendingUpdateCheck = false;
    return pending;
  }
  /** Epoch ms of the next scheduled scrape, or null if not yet scheduled / currently running. */
  nextRunAt: number | null = null;

  start(client: AgentApiClient, version = ""): void {
    this._started = true;
    this._version = version;
    this._paused = false;
    this.startHeartbeat(client);
    void this.runCycle(client, true, "startup");

    // Start Realtime subscription non-blocking - if the server doesn't support
    // it (old deploy, missing env var) the watcher logs a warning and we fall
    // back to the normal 60s heartbeat polling. Never block startup on this.
    client.getRealtimeToken()
      .then((res) => {
        if (this.realtimeWatcher) return; // already started (shouldn't happen)
        this.realtimeWatcher = new RealtimeWatcher(
          res.supabaseUrl,
          res.anonKey,
          client,
          () => { this._fireImmediateHeartbeat?.(); },
        );
        // Seed the initial command ID so the first event doesn't fire a
        // spurious heartbeat for a command that was already delivered.
        void this.realtimeWatcher.start();
      })
      .catch((err: unknown) => {
        agentLogger.warn(`[realtime] Unavailable - falling back to polling: ${String(err)}`);
      });
  }

  stop(): void {
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
    this.scrapeTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatAckTimer = null;
    this.nextRunAt = null;
    this._paused = false;
    this._started = false;
    this._pendingAckCommandId = null;
    this.realtimeWatcher?.stop();
    this.realtimeWatcher = null;
    this._fireImmediateHeartbeat = null;
  }

  /** Request an in-progress scrape to halt after the current module completes. */
  stopScrape(): void {
    if (this._running) {
      this._stopRequested = true;
      agentLogger.info("[agent] Stop requested - will halt after current module completes");
    } else {
      agentLogger.info("[agent] Stop requested but no scrape is in progress");
    }
  }

  /** Suspend scraping without stopping the heartbeat. */
  pause(): void {
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    this.scrapeTimer = null;
    // Save remaining countdown so resume() can restore it instead of scraping immediately.
    this._pausedRemainingMs = this.nextRunAt !== null
      ? Math.max(0, this.nextRunAt - Date.now())
      : null;
    this.nextRunAt = null;
    this._paused = true;
  }

  /**
   * Resume scraping. Restores the countdown that was active when pause() was called
   * so the user isn't hit with an immediate scrape just for toggling pause.
   * Enforces a 60-second minimum so a pause-immediately-unpause can't trigger a run.
   */
  resume(client: AgentApiClient): void {
    this._paused = false;
    if (this._running) return;

    const MIN_DELAY_MS = 60_000; // never run sooner than 1 min after resuming
    const delay = Math.max(MIN_DELAY_MS, this._pausedRemainingMs ?? 30 * 60 * 1000);
    this._pausedRemainingMs = null;

    this.nextRunAt = Date.now() + delay;
    agentLogger.info(`[agent] Resumed - next scrape in ${Math.round(delay / 60_000)} min`);
    this.scrapeTimer = setTimeout(() => void this.runCycle(client, true, "schedule"), delay);
  }

  async triggerNow(client: AgentApiClient, trigger: "manual" | "server" = "manual"): Promise<void> {
    if (this._running) {
      agentLogger.info("[agent] Scrape already in progress - skipping manual trigger");
      return;
    }
    // Clear existing timer so the 30-min clock resets from now
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    this.scrapeTimer = null;
    await this.runCycle(client, true, trigger);
  }

  private currentHeartbeatOptions(extra: {
    failureMsg?: string;
    failureJobId?: number;
  } = {}): {
    schedulerPaused: boolean;
    activeJobId: number | null;
    ackCommandId?: string;
    failureMsg?: string;
    failureJobId?: number;
  } {
    return {
      schedulerPaused: this._paused,
      activeJobId: this._activeJobId,
      ...(this._pendingAckCommandId ? { ackCommandId: this._pendingAckCommandId } : {}),
      ...(extra.failureMsg ? { failureMsg: extra.failureMsg } : {}),
      ...(extra.failureJobId !== undefined ? { failureJobId: extra.failureJobId } : {}),
    };
  }

  private stageAck(commandId: string | null | undefined): void {
    if (commandId) this._pendingAckCommandId = commandId;
  }

  private applyServerCommand(
    client: AgentApiClient,
    command: string | null | undefined,
    commandId: string | null | undefined,
  ): void {
    if (!command || !commandId || commandId === this._pendingAckCommandId) return;

    if (command === "scrape_now") {
      if (!this._running) {
        agentLogger.info("[agent] Server command: scrape_now");
        void this.triggerNow(client, "server");
        this.stageAck(commandId);
      }
      return;
    }

    if (command === "stop_scrape") {
      this.stopScrape();
      this.stageAck(commandId);
      return;
    }

    if (command === "check_update") {
      agentLogger.info("[agent] Server command: check_update");
      this._pendingUpdateCheck = true;
      this.stageAck(commandId);
      return;
    }

    if (command === "pause") {
      try {
        if (!this._paused) {
          this.pause();
          agentLogger.info("[agent] Server command: pause");
        }
        this.stageAck(commandId);
      } catch (err) {
        agentLogger.error("[agent] Failed to apply pause command: " + String(err));
      }
      return;
    }

    if (command === "resume") {
      try {
        if (this._paused) {
          agentLogger.info("[agent] Server command: resume");
          this.resume(client);
        }
        this.stageAck(commandId);
      } catch (err) {
        agentLogger.error("[agent] Failed to apply resume command: " + String(err));
      }
    }
  }

  private startHeartbeat(client: AgentApiClient): void {
    const beat = (): void => {
      if (!this._started) return;
      client
        .heartbeat(this._version, process.platform, this.currentHeartbeatOptions())
        .then((res) => {
          if (!this._started) return;
          // Drop local ack target once the server clears pending (same commandId no longer returned).
          if (this._pendingAckCommandId) {
            const stillPending = res.commandId === this._pendingAckCommandId;
            if (!stillPending) {
              this._pendingAckCommandId = null;
            }
          }
          this.applyServerCommand(client, res.command, res.commandId);

          // Keep the Realtime watcher's dedupe state in sync so it doesn't
          // fire a spurious immediate heartbeat for a command we just picked up.
          this.realtimeWatcher?.seedCommandId(res.commandId ?? null);

          // If this beat just set a pending ACK, fire a follow-up beat after a
          // short delay so the ACK reaches the server in ~500 ms rather than
          // waiting up to 60 s for the next scheduled heartbeat. This clears
          // "Pausing..." / "Resuming..." on the dashboard almost immediately.
          if (this._pendingAckCommandId === res.commandId && res.commandId) {
            if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
            this.heartbeatAckTimer = setTimeout(() => {
              this.heartbeatAckTimer = null;
              beat();
            }, 500);
          }
        })
        .catch((err: unknown) => {
          agentLogger.error("[agent] Heartbeat failed: " + describeAgentApiError(err));
        });
    };
    // Expose beat so RealtimeWatcher can fire an immediate heartbeat when a
    // new pending_command_id is detected on the agent_sessions row.
    this._fireImmediateHeartbeat = beat;
    beat(); // immediate first beat
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  private async sendCycleVisibilityHint(client: AgentApiClient, trigger: Trigger): Promise<void> {
    if (trigger !== "manual" && trigger !== "schedule") return;
    try {
      await client.signalCycleVisibilityHint();
    } catch (err: unknown) {
      agentLogger.warn(`[agent] Failed to send cycle visibility hint: ${describeAgentApiError(err)}`);
    }
  }

  private async runCycle(client: AgentApiClient, scheduleNext = true, trigger: Trigger = "startup"): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._stopRequested = false;
    this.nextRunAt = null; // clear while running
    let intervalMs = 30 * 60 * 1000; // default 30 min

    try {
      await this.sendCycleVisibilityHint(client, trigger);
      const [schedule, config] = await Promise.all([
        client.getSchedule(),
        client.getConfig(),
      ]);

      intervalMs = schedule.intervalMs;
      const jobMap = new Map(schedule.jobs.map((j) => [j.moduleName, j.id]));

      await this.scrapeAll(client, config, jobMap, trigger);
    } catch (err) {
      const errMsg = String(err);
      agentLogger.error("[agent] Scrape cycle failed: " + errMsg);
      Promise.resolve(client.heartbeat(
        this._version,
        process.platform,
        this.currentHeartbeatOptions({ failureMsg: errMsg }),
      )).catch(() => {});
    } finally {
      this._running = false;
    }

    // Only schedule the next run if not paused
    if (scheduleNext && !this._paused) {
      this.nextRunAt = Date.now() + intervalMs;
      agentLogger.info(`[agent] Next scrape in ${Math.round(intervalMs / 60000)} min`);
      this.scrapeTimer = setTimeout(() => void this.runCycle(client, true, "schedule"), intervalMs);
    }
  }

  private async scrapeAll(
    client: AgentApiClient,
    config: DbConfig,
    jobMap: Map<string, number>,
    trigger: Trigger,
  ): Promise<void> {
    const modules = config.modules ?? {};
    const enabled = Object.entries(modules).filter(([, m]) => m.enabled);

    if (enabled.length === 0) {
      agentLogger.info("[agent] No modules enabled - nothing to scrape");
      return;
    }

    const triggerLabel =
      trigger === "startup"  ? "startup"
      : trigger === "schedule" ? "scheduled"
      : trigger === "manual"   ? "manual (agent UI)"
      : trigger === "server"   ? "server command"
      : "resume";

    const startedAt = new Date().toLocaleTimeString();
    agentLogger.info(`[agent] ------------ Scrape started @ ${startedAt} [${triggerLabel}] ------------`);

    const browserOptions = config.browser
      ? { headless: config.browser.headless ?? true, timeout: config.browser.timeout }
      : undefined;

    const startedJobIds = new Set<number>();

    for (const [moduleName, moduleConfig] of enabled) {
      if (this._stopRequested) {
        this._stopRequested = false;
        agentLogger.info("[agent] ------------ Scrape halted by user request ------------");
        const cancelIds = [...jobMap.values()].filter((id) => !startedJobIds.has(id));
        client.cancelJobs(cancelIds).catch((err: unknown) => {
          agentLogger.warn("[agent] Failed to cancel skipped jobs: " + String(err));
        });
        break;
      }
      agentLogger.info(`[agent] Scraping ${moduleName}...`);
      const moduleStartedAt = new Date();
      const jobId = jobMap.get(moduleName);
      if (jobId !== undefined) {
        startedJobIds.add(jobId);
        this._activeJobId = jobId;
        try {
          await client.startJob(jobId, moduleStartedAt.toISOString());
        } catch (err: unknown) {
          const errMsg = describeAgentApiError(err);
          agentLogger.error(`[agent] Failed to mark job ${jobId} as running: ${errMsg}`);
          Promise.resolve(client.heartbeat(
            this._version,
            process.platform,
            this.currentHeartbeatOptions({
              failureMsg: `Failed to start job ${jobId}: ${errMsg}`,
              failureJobId: jobId,
            }),
          )).catch(() => {});
          this._activeJobId = null;
          continue;
        }
      }
      try {
        let result = await runModule(moduleName, moduleConfig, browserOptions);
        let wasRetried = false;

        // If CF issued a Managed Challenge, the profile has been cleared.
        // Retry once immediately with the fresh profile instead of waiting
        // until the next scheduled cycle.
        if (result.hadManagedChallenge) {
          agentLogger.info(`[agent] Retrying ${moduleName} with fresh browser profile...`);
          // Preserve snapshots from the original (failed) run so the dashboard
          // can show what Cloudflare returned, even if the retry succeeds.
          const originalSnapshots = result.debugSnapshots.map((s) => ({ ...s, preRetry: true }));
          result = await runModule(moduleName, moduleConfig, browserOptions);
          wasRetried = true;
          result = { ...result, debugSnapshots: [...originalSnapshots, ...result.debugSnapshots] };
        }

        // Push scraper module logs into the Scraper tab buffer.
        pushScraperLogs(moduleName, result.logs);

        if (jobId === undefined) {
          throw new Error(`Missing scheduled job id for module ${moduleName}`);
        }

        let response;
        try {
          response = await client.pushResults({
            moduleName,
            jobId,
            listings: result.listings,
            logs: result.logs,
            filteredListings: result.filteredListings,
            failedUrls: result.failedUrls,
            retried: wasRetried,
            debugSnapshots: result.debugSnapshots,
            startedAt: moduleStartedAt.toISOString(),
          });
        } catch (err) {
          const errMsg = describeAgentApiError(err);
          const isRateLimited = errMsg.includes("Rate limited (429)");
          if (isRateLimited) {
            agentLogger.warn(`[agent] Rate limited by server - results not delivered for ${moduleName}. Will retry next scheduled run.`);
          } else {
            agentLogger.error(`[agent] Failed to push results for ${moduleName}: ${errMsg}`);
          }
          Promise.resolve(client.heartbeat(
            this._version,
            process.platform,
            this.currentHeartbeatOptions({
              failureMsg: errMsg,
              failureJobId: jobId,
            }),
          )).catch(() => {});
          this._activeJobId = null;
          continue;
        }

        this._activeJobId = null;
        const s = response.summary;
        agentLogger.info(
          `[agent] ${moduleName}: total=${s.total} new=${s.new} changed=${s.changed} removed=${s.removed}`,
        );
      } catch (err) {
        const errMsg = String(err);
        agentLogger.error(`[agent] Failed to scrape ${moduleName}: ` + errMsg);
        Promise.resolve(client.heartbeat(
          this._version,
          process.platform,
          this.currentHeartbeatOptions({
            failureMsg: errMsg,
            ...(jobId !== undefined ? { failureJobId: jobId } : {}),
          }),
        )).catch(() => {});
        this._activeJobId = null;
      }
    }

    const finishedAt = new Date().toLocaleTimeString();
    agentLogger.info(`[agent] ------------ Scrape complete @ ${finishedAt} ------------`);
  }
}
