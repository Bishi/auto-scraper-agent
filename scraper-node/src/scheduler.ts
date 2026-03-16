import type { AgentApiClient } from "./api-client.js";
import { runModule } from "./scraper.js";
import type { DbConfig } from "./shared/types.js";

const AGENT_VERSION = "0.1.0";
const HEARTBEAT_INTERVAL_MS = 60_000;

export class Scheduler {
  private scrapeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(client: AgentApiClient): void {
    this.startHeartbeat(client);
    void this.runCycle(client);
  }

  stop(): void {
    if (this.scrapeTimer) clearTimeout(this.scrapeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.scrapeTimer = null;
    this.heartbeatTimer = null;
  }

  async triggerNow(client: AgentApiClient): Promise<void> {
    if (this.running) {
      console.log("[agent] Scrape already in progress — skipping manual trigger");
      return;
    }
    await this.runCycle(client, false);
  }

  private startHeartbeat(client: AgentApiClient): void {
    const beat = (): void => {
      client.heartbeat(AGENT_VERSION, process.platform).catch((err: unknown) => {
        console.error("[agent] Heartbeat failed:", err);
      });
    };
    beat(); // immediate first beat
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  private async runCycle(client: AgentApiClient, scheduleNext = true): Promise<void> {
    this.running = true;
    let intervalMs = 30 * 60 * 1000; // default 30 min

    try {
      const [schedule, config] = await Promise.all([
        client.getSchedule(),
        client.getConfig(),
      ]);

      intervalMs = schedule.intervalMs;
      const jobMap = new Map(schedule.jobs.map((j) => [j.moduleName, j.id]));

      await this.scrapeAll(client, config, jobMap);
    } catch (err) {
      console.error("[agent] Scrape cycle failed:", err);
    } finally {
      this.running = false;
    }

    if (scheduleNext) {
      console.log(`[agent] Next scrape in ${Math.round(intervalMs / 60000)} min`);
      this.scrapeTimer = setTimeout(() => void this.runCycle(client), intervalMs);
    }
  }

  private async scrapeAll(
    client: AgentApiClient,
    config: DbConfig,
    jobMap: Map<string, number>,
  ): Promise<void> {
    const modules = config.modules ?? {};
    const enabled = Object.entries(modules).filter(([, m]) => m.enabled);

    if (enabled.length === 0) {
      console.log("[agent] No modules enabled — nothing to scrape");
      return;
    }

    const startedAt = new Date().toLocaleTimeString();
    console.log(`[agent] ──────────── Scrape started @ ${startedAt} ────────────`);

    const browserOptions = config.browser
      ? { headless: config.browser.headless ?? true, timeout: config.browser.timeout }
      : undefined;

    for (const [moduleName, moduleConfig] of enabled) {
      console.log(`[agent] Scraping ${moduleName}...`);
      try {
        const result = await runModule(moduleName, moduleConfig, browserOptions);
        const response = await client.pushResults({
          moduleName,
          jobId: jobMap.get(moduleName),
          listings: result.listings,
          logs: result.logs,
          filteredListings: result.filteredListings,
          failedUrls: result.failedUrls,
        });
        const s = response.summary;
        console.log(
          `[agent] ${moduleName}: total=${s.total} new=${s.new} changed=${s.changed} removed=${s.removed}`,
        );
      } catch (err) {
        console.error(`[agent] Failed to scrape/push ${moduleName}:`, err);
        client.heartbeat(AGENT_VERSION, process.platform, String(err)).catch(() => {});
      }
    }

    const finishedAt = new Date().toLocaleTimeString();
    console.log(`[agent] ──────────── Scrape complete @ ${finishedAt} ────────────`);
  }
}
