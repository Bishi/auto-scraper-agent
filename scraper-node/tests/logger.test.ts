import { describe, expect, it, beforeEach } from "vitest";
import { pushScraperLogs, sanitizeScraperLogEntry, SCRAPER_LOG_BUFFER } from "../src/logger.js";

describe("scraper UI log formatting", () => {
  beforeEach(() => {
    SCRAPER_LOG_BUFFER.length = 0;
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
