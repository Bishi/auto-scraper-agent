import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import type { Logger } from "pino";
import { ScraperModule } from "../src/shared/modules/base.js";
import type { Listing } from "../src/shared/types.js";

function listing(sourceId: string, price: number): Listing {
  return {
    sourceId,
    moduleName: "test-module",
    sourceUrl: "https://example.com/page",
    listingUrl: `https://example.com/listings/${sourceId}`,
    title: `Listing ${sourceId}`,
    price,
    metadata: {},
    contentHash: `hash-${sourceId}`,
    firstSeenAt: "2026-04-30T10:00:00.000Z",
    lastSeenAt: "2026-04-30T10:00:00.000Z",
  };
}

function page(): Page {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(""),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function logger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

class TestModule extends ScraperModule {
  async scrape(_page: Page, _url: string): Promise<Listing[]> {
    return [listing("kept", 150), listing("filtered", 50)];
  }
}

describe("ScraperModule source attribution", () => {
  it("applies source nicknames before filtering in serial runs", async () => {
    const module = new TestModule({
      name: "test-module",
      displayName: "Test Module",
      urls: [{
        url: "https://example.com/search",
        enabled: true,
        nickname: "Dealer A",
        pagination: false,
        maxPages: 1,
        filters: { priceMin: 100 },
      }],
    }, logger());

    const listings = await module.run(page());

    expect(listings).toHaveLength(1);
    expect(listings[0]?.sourceUrl).toBe("https://example.com/search");
    expect(listings[0]?.sourceUrlNickname).toBe("Dealer A");
    expect(module.lastFilteredListings).toHaveLength(1);
    expect(module.lastFilteredListings[0]?.sourceUrl).toBe("https://example.com/search");
    expect(module.lastFilteredListings[0]?.sourceUrlNickname).toBe("Dealer A");
  });

  it("applies source nicknames before filtering in parallel runs", async () => {
    const module = new TestModule({
      name: "test-module",
      displayName: "Test Module",
      urls: [{
        url: "https://example.com/search",
        enabled: true,
        nickname: "Dealer A",
        pagination: false,
        maxPages: 1,
        filters: { priceMin: 100 },
      }],
      options: { parallelUrls: true },
    }, logger());

    const listings = await module.run(page(), async () => page());

    expect(listings).toHaveLength(1);
    expect(listings[0]?.sourceUrl).toBe("https://example.com/search");
    expect(listings[0]?.sourceUrlNickname).toBe("Dealer A");
    expect(module.lastFilteredListings).toHaveLength(1);
    expect(module.lastFilteredListings[0]?.sourceUrl).toBe("https://example.com/search");
    expect(module.lastFilteredListings[0]?.sourceUrlNickname).toBe("Dealer A");
  });

  it("logs discovered pages with the source nickname in parallel runs", async () => {
    class PaginatedTestModule extends TestModule {
      async discoverPages(_page: Page, url: string, maxPages: number): Promise<string[]> {
        return [url, `${url}?stran=2`].slice(0, maxPages);
      }
    }

    const testLogger = logger();
    const info = vi.mocked(testLogger.info);
    const module = new PaginatedTestModule({
      name: "test-module",
      displayName: "Test Module",
      urls: [{
        url: "https://example.com/search",
        enabled: true,
        nickname: "Dealer A",
        pagination: true,
        maxPages: 2,
      }],
      options: { parallelUrls: true },
    }, testLogger);

    await module.run(page(), async () => page());

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: "Dealer A",
        totalPages: 2,
        maxPages: 2,
      }),
      "Discovered pages",
    );
  });
});
