import { describe, expect, it, beforeEach } from "vitest";
import { pushScraperLogs, SCRAPER_LOG_BUFFER } from "../src/logger.js";

describe("scraper UI log formatting", () => {
  beforeEach(() => {
    SCRAPER_LOG_BUFFER.length = 0;
  });

  it("renders pagination and page breadcrumbs from structured scraper log fields", () => {
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
      "[avto-net] Failed to scrape URL (Clio) page=2/3 pageUrl=https://www.avto.net/Ads/results.asp?znamka=Renault&model=Clio&stran=2",
    );
    expect(SCRAPER_LOG_BUFFER[1]?.msg).toContain(
      "Cloudflare Managed Challenge blocked scrape",
    );
  });
});
