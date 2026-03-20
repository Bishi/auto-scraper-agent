import type { AgentApiClient } from "./api-client.js";
import { runModule } from "./scraper.js";
import type { DbConfig } from "./shared/types.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

type Trigger = "startup" | "schedule" | "manual" | "server" | "resume";

export class Scheduler {
  private scrapeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _paused = false;
  private _stopRequested = false;
  private _version = "";
  /** Set when the server sends a check_update command; read+cleared by GET /update/check. */
  private _pendingUpdateCheck = false;
  /**
   * Remaining ms that were left on the timer when pause() was called.
   * Used by resume() to restore the countdown rather than scraping immediately.
   */
  private _pausedRemainingMs: number | null = null;
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
    this._version = version;
    this._paused = false;
    this.startHeartbeat(client);
    void this.runCycle(client, true, "startup");
  }

  stop(): void {
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.scrapeTimer = null;
    this.heartbeatTimer = null;
    this.nextRunAt = null;
    this._paused = false;
  }

  /** Request an in-progress scrape to halt after the current module completes. */
  stopScrape(): void {
    if (this._running) {
      this._stopRequested = true;
      console.log("[agent] Stop requested — will halt after current module completes");
    } else {
      console.log("[agent] Stop requested but no scrape is in progress");
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
   * Resume scraping.  Restores the countdown that was active when pause() was called
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
    console.log(`[agent] Resumed — next scrape in ${Math.round(delay / 60_000)} min`);
    this.scrapeTimer = setTimeout(() => void this.runCycle(client, true, "schedule"), delay);
  }

  async triggerNow(client: AgentApiClient, trigger: "manual" | "server" = "manual"): Promise<void> {
    if (this._running) {
      console.log("[agent] Scrape already in progress — skipping manual trigger");
      return;
    }
    // Clear existing timer so the 30-min clock resets from now
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    this.scrapeTimer = null;
    await this.runCycle(client, true, trigger);
  }

  private startHeartbeat(client: AgentApiClient): void {
    const beat = (): void => {
      client.heartbeat(this._version, process.platform)
        .then((res) => {
          // Act on server-side command (one-shot, already cleared server-side)
          if (res.command === "scrape_now" && !this._running) {
            console.log("[agent] Server command: scrape_now");
            void this.triggerNow(client, "server");
          }
          if (res.command === "stop_scrape") {
            this.stopScrape();
          }
          if (res.command === "check_update") {
            console.log("[agent] Server command: check_update");
            this._pendingUpdateCheck = true;
          }
          // Sync pause state from server
          if (res.paused === true && !this._paused) {
            this.pause();
            console.log("[agent] Scheduler paused by server");
          } else if (res.paused === false && this._paused) {
            console.log("[agent] Scheduler resumed by server");
            this.resume(client);
          }
        })
        .catch((err: unknown) => {
          console.error("[agent] Heartbeat failed:", err);
        });
    };
    beat(); // immediate first beat
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  private async runCycle(client: AgentApiClient, scheduleNext = true, trigger: Trigger = "startup"): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._stopRequested = false;
    this.nextRunAt = null; // clear while running
    let intervalMs = 30 * 60 * 1000; // default 30 min

    try {
      const [schedule, config] = await Promise.all([
        client.getSchedule(),
        client.getConfig(),
      ]);

      intervalMs = schedule.intervalMs;
      const jobMap = new Map(schedule.jobs.map((j) => [j.moduleName, j.id]));

      await this.scrapeAll(client, config, jobMap, trigger);
    } catch (err) {
      console.error("[agent] Scrape cycle failed:", err);
    } finally {
      this._running = false;
    }

    // Only schedule the next run if not paused
    if (scheduleNext && !this._paused) {
      this.nextRunAt = Date.now() + intervalMs;
      console.log(`[agent] Next scrape in ${Math.round(intervalMs / 60000)} min`);
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
      console.log("[agent] No modules enabled — nothing to scrape");
      return;
    }

    const triggerLabel =
      trigger === "startup" ? "startup"
      : trigger === "schedule" ? "scheduled"
      : trigger === "manual" ? "manual (agent UI)"
      : trigger === "server" ? "server command"
      : "resume";

    const startedAt = new Date().toLocaleTimeString();
    console.log(`[agent] ──────────── Scrape started @ ${startedAt} [${triggerLabel}] ────────────`);

    const browserOptions = config.browser
      ? { headless: config.browser.headless ?? true, timeout: config.browser.timeout }
      : undefined;

    for (const [moduleName, moduleConfig] of enabled) {
      if (this._stopRequested) {
        this._stopRequested = false;
        console.log("[agent] ──────────── Scrape halted by user request ────────────");
        break;
      }
      console.log(`[agent] Scraping ${moduleName}...`);
      const moduleStartedAt = new Date();
      try {
        let result = await runModule(moduleName, moduleConfig, browserOptions);
        let wasRetried = false;

        // If CF issued a Managed Challenge, the profile has been cleared.
        // Retry once immediately with the fresh profile instead of waiting
        // until the next scheduled cycle.
        if (result.hadManagedChallenge) {
          console.log(`[agent] Retrying ${moduleName} with fresh browser profile…`);
          // Preserve snapshots from the original (failed) run so the dashboard
          // can show what Cloudflare returned, even if the retry succeeds.
          const originalSnapshots = result.debugSnapshots.map((s) => ({ ...s, preRetry: true }));
          result = await runModule(moduleName, moduleConfig, browserOptions);
          wasRetried = true;
          result = { ...result, debugSnapshots: [...originalSnapshots, ...result.debugSnapshots] };
        }

        const response = await client.pushResults({
          moduleName,
          jobId: jobMap.get(moduleName),
          listings: result.listings,
          logs: result.logs,
          filteredListings: result.filteredListings,
          failedUrls: result.failedUrls,
          retried: wasRetried,
          debugSnapshots: result.debugSnapshots,
          startedAt: moduleStartedAt.toISOString(),
        });
        const s = response.summary;
        console.log(
          `[agent] ${moduleName}: total=${s.total} new=${s.new} changed=${s.changed} removed=${s.removed}`,
        );
      } catch (err) {
        console.error(`[agent] Failed to scrape/push ${moduleName}:`, err);
        client.heartbeat(this._version, process.platform, String(err)).catch(() => {});
      }
    }

    const finishedAt = new Date().toLocaleTimeString();
    console.log(`[agent] ──────────── Scrape complete @ ${finishedAt} ────────────`);
  }
}
