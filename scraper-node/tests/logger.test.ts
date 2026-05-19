import { describe, expect, it, beforeEach, vi } from "vitest";
import { AGENT_LOG_BUFFER, pushScraperLogs, sanitizeScraperLogEntry, SCRAPER_LOG_BUFFER } from "../src/logger.js";
import { redactCentralLogContext, redactCentralLogText } from "../src/central-log-redaction.js";
import {
  AGENT_LOG_COMPONENTS,
  AGENT_LOG_LEVELS,
  AGENT_LOG_WAKE_SOURCES,
  centralLogQueueSize,
  configureCentralLogUpload,
  enqueueCentralAgentLog,
  flushCentralLogs,
  configureCentralLogWarningSink,
  resetCentralLogQueueForTests,
} from "../src/central-log-queue.js";

describe("scraper UI log formatting", () => {
  beforeEach(() => {
    SCRAPER_LOG_BUFFER.length = 0;
    resetCentralLogQueueForTests();
  });

  it("renders pagination breadcrumbs without raw page URLs", () => {
    pushScraperLogs("avto-net", [{
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "Discovered pages",
      nickname: "Clio",
      discoveredPages: 3,
      maxPages: 3,
    }]);

    expect(SCRAPER_LOG_BUFFER[0]?.msg).toBe(
      "[avto-net] Discovered pages (Clio) pages=3 maxPages=3",
    );

    pushScraperLogs("avto-net", [{
      level: 50,
      time: Date.UTC(2026, 4, 1, 9, 4, 27),
      msg: "Failed to scrape URL",
      nickname: "Clio",
      pageIndex: 2,
      pageCount: 3,
      pageUrl: "https://www.avto.net/Ads/results.asp?znamka=Renault&model=Clio&stran=2",
      err: { message: "Cloudflare Managed Challenge blocked scrape" },
    }]);

    expect(SCRAPER_LOG_BUFFER[1]?.msg).toContain(
      "[avto-net] Failed to scrape URL (Clio) page=2/3",
    );
    expect(SCRAPER_LOG_BUFFER[1]?.msg).not.toContain("pageUrl=");
    expect(SCRAPER_LOG_BUFFER[1]?.msg).not.toContain("https://www.avto.net");
    expect(SCRAPER_LOG_BUFFER[1]?.msg).toContain(
      "Cloudflare Managed Challenge blocked scrape",
    );
  });

  it("strips URL fields before logs are stored or uploaded", () => {
    const sanitized = sanitizeScraperLogEntry({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "Scraping page",
      nickname: "Clio",
      url: "https://www.avto.net/Ads/results.asp?model=Clio",
      pageUrl: "https://www.avto.net/Ads/results.asp?model=Clio&stran=2",
    });

    expect(sanitized["url"]).toBeUndefined();
    expect(sanitized["pageUrl"]).toBeUndefined();
    expect(sanitized["nickname"]).toBe("Clio");
  });
});

describe("central agent log redaction and spool", () => {
  beforeEach(() => {
    resetCentralLogQueueForTests();
    configureCentralLogWarningSink((message) => {
      AGENT_LOG_BUFFER.push({
        ts: new Date(Date.UTC(2026, 4, 1, 9, 3, 54)).toISOString(),
        level: "warn",
        msg: message,
      });
    });
    AGENT_LOG_BUFFER.length = 0;
  });

  it("keeps duplicated enums explicit for server contract parity", () => {
    expect(AGENT_LOG_LEVELS).toEqual([20, 30, 40, 50, 60]);
    expect(AGENT_LOG_COMPONENTS).toContain("heartbeat");
    expect(AGENT_LOG_WAKE_SOURCES).toContain("ack_followup");
  });

  it("redacts secrets and PII before entries reach the spool", () => {
    expect(redactCentralLogText("Authorization: Bearer abc.def.ghi token=secret me@example.com +386 40 123 456"))
      .not.toContain("secret");
    expect(redactCentralLogContext({
      email: "me@example.com",
      apikey: "secret",
      "x-api-key": "secret",
      sellerphone: "+38640123456",
      nested: { url: "https://example.test/path?token=abc&x-api-key=def" },
    })).toEqual({
      email: "[REDACTED]",
      apikey: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      sellerphone: "[REDACTED]",
      nested: { url: "https://example.test/path?token=[REDACTED]&x-api-key=[REDACTED]" },
    });
  });

  it("queues bounded central agent logs without scraper progress logs", () => {
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "Heartbeat ok",
      component: "heartbeat",
      wakeSource: "interval",
    });

    expect(centralLogQueueSize()).toBe(1);
  });

  it("removes accepted, duplicate, and invalid entries after upload", async () => {
    const pushLogs = vi.fn().mockResolvedValue({ ok: true, accepted: 1, duplicates: 0, invalid: 1 });
    configureCentralLogUpload({ pushLogs } as unknown as Parameters<typeof configureCentralLogUpload>[0]);
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "one",
    });
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 53),
      msg: "two",
    });

    await flushCentralLogs();

    expect(centralLogQueueSize()).toBe(0);
  });

  it("keeps entries when a 413 split retry fails transiently", async () => {
    const tooLarge = Object.assign(new Error("too large"), { status: 413 });
    const networkError = new Error("network");
    const pushLogs = vi.fn()
      .mockRejectedValueOnce(tooLarge)
      .mockRejectedValueOnce(networkError);
    configureCentralLogUpload({ pushLogs } as unknown as Parameters<typeof configureCentralLogUpload>[0]);
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "one",
    });
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 53),
      msg: "two",
    });

    await flushCentralLogs();

    expect(pushLogs).toHaveBeenCalledTimes(2);
    expect(centralLogQueueSize()).toBe(2);
  });

  it("warns locally when invalid central log batches are dropped", async () => {
    const invalidBatch = Object.assign(new Error("invalid"), { status: 400 });
    const pushLogs = vi.fn().mockRejectedValueOnce(invalidBatch);
    configureCentralLogUpload({ pushLogs } as unknown as Parameters<typeof configureCentralLogUpload>[0]);
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "one",
    });

    await flushCentralLogs();

    expect(centralLogQueueSize()).toBe(0);
    expect(AGENT_LOG_BUFFER.at(-1)?.level).toBe("warn");
    expect(AGENT_LOG_BUFFER.at(-1)?.msg).toContain("Dropped 1 queued central log");
  });

  it("warns locally when an unsplittable central log entry is too large", async () => {
    const tooLarge = Object.assign(new Error("too large"), { status: 413 });
    const pushLogs = vi.fn().mockRejectedValueOnce(tooLarge);
    configureCentralLogUpload({ pushLogs } as unknown as Parameters<typeof configureCentralLogUpload>[0]);
    enqueueCentralAgentLog({
      level: 30,
      time: Date.UTC(2026, 4, 1, 9, 3, 52),
      msg: "one",
    });

    await flushCentralLogs();

    expect(centralLogQueueSize()).toBe(0);
    expect(AGENT_LOG_BUFFER.at(-1)?.msg).toContain("too large to upload");
  });
});
