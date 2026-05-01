import type { Page } from "playwright";
import type { Listing, DebugSnapshotData } from "../types.js";
import type { NormalizedUrl } from "../config.js";
import type { Logger } from "pino";

function applyPriceFilter(listings: Listing[], filters: NormalizedUrl["filters"]): Listing[] {
  if (!filters || (filters.priceMin == null && filters.priceMax == null)) return listings;
  return listings.filter((l) => {
    if (l.price == null) return true; // keep "Po dogovoru" / negotiable listings
    if (filters.priceMin != null && l.price < filters.priceMin) return false;
    if (filters.priceMax != null && l.price > filters.priceMax) return false;
    return true;
  });
}

function applySourceAttribution(listings: Listing[], urlEntry: NormalizedUrl): void {
  for (const listing of listings) {
    listing.sourceUrl = urlEntry.url;
    if (urlEntry.nickname) {
      listing.sourceUrlNickname = urlEntry.nickname;
    }
  }
}

export interface ScraperModuleConfig {
  name: string;
  displayName: string;
  urls: NormalizedUrl[];
  options?: Record<string, unknown>;
}

export abstract class ScraperModule {
  /** URLs that failed during the last run() call (used by main.ts to avoid false removals) */
  lastFailedUrls: string[] = [];

  /**
   * HTML snapshots captured during ERROR-level parse failures in the last run().
   * Uploaded to the server via POST /api/agent/results so admins can diagnose
   * broken selectors, redirects, and bot blocks from the dashboard.
   */
  lastDebugSnapshots: DebugSnapshotData[] = [];

  protected addDebugSnapshot(snapshot: DebugSnapshotData): void {
    this.lastDebugSnapshots.push(snapshot);
  }

  /**
   * sourceIds of listings excluded by the price filter during the last run().
   * These must NOT be marked as "removed" — the listing is still on the site,
   * it just fell outside the configured priceMin/priceMax range.
   */
  lastFilteredSourceIds: Set<string> = new Set();

  /**
   * Full listing objects that were excluded by the price filter.
   * main.ts uses these to keep their price/metadata current in the DB
   * without changing isActive — so the UI always shows accurate data.
   */
  lastFilteredListings: Listing[] = [];

  constructor(
    protected readonly config: ScraperModuleConfig,
    protected readonly logger: Logger,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get displayName(): string {
    return this.config.displayName;
  }

  abstract scrape(page: Page, url: string): Promise<Listing[]>;

  async discoverPages(_page: Page, url: string, _maxPages: number): Promise<string[]> {
    return [url];
  }

  async run(page: Page, createPage?: () => Promise<Page>): Promise<Listing[]> {
    this.lastFailedUrls = [];
    this.lastFilteredSourceIds = new Set();
    this.lastFilteredListings = [];
    this.lastDebugSnapshots = [];
    const allListings: Listing[] = [];

    const activeUrls = this.config.urls.filter((u) => u.enabled !== false);
    const parallel = this.config.options?.["parallelUrls"] === true && !!createPage;

    if (parallel) {
      await Promise.all(activeUrls.map(async (urlEntry) => {
        const logId = urlEntry.nickname
          ? { nickname: urlEntry.nickname }
          : { url: urlEntry.url };

        this.logger.info(logId, "Scraping (parallel)");

        const p = await createPage!();
        let currentPageUrl = urlEntry.url;
        let currentPageIndex = 1;
        let currentPageCount = 1;
        try {
          let pages: string[];
          if (urlEntry.pagination) {
            await p.goto(urlEntry.url, { waitUntil: "domcontentloaded" });
            pages = await this.discoverPages(p, urlEntry.url, urlEntry.maxPages);
            this.logger.info(
              { ...logId, discoveredPages: pages.length, maxPages: urlEntry.maxPages },
              "Discovered pages",
            );
          } else {
            pages = [urlEntry.url];
          }

          currentPageCount = pages.length;
          for (let pageOffset = 0; pageOffset < pages.length; pageOffset++) {
            const pageUrl = pages[pageOffset]!;
            currentPageUrl = pageUrl;
            currentPageIndex = pageOffset + 1;
            const pageLogId = {
              ...logId,
              pageIndex: currentPageIndex,
              pageCount: currentPageCount,
              pageUrl,
            };

            this.logger.info(pageLogId, "Scraping page");

            if (pageUrl !== urlEntry.url || !urlEntry.pagination) {
              await p.goto(pageUrl, { waitUntil: "domcontentloaded" });
            }

            const delay = 1000 + Math.random() * 2000;
            await p.waitForTimeout(delay);

            const scraped = await this.scrape(p, pageUrl);
            // Always associate listings with the base monitoring URL, not the
            // paginated page URL. Parsers receive the page URL for context but
            // the server matches listings to config URLs via sourceUrl — using
            // a page-specific URL breaks disabled/failed URL exclusion.
            applySourceAttribution(scraped, urlEntry);
            const listings = applyPriceFilter(scraped, urlEntry.filters);
            const filteredOut = scraped.length - listings.length;

            if (filteredOut > 0) {
              const keptIds = new Set(listings.map((l) => l.sourceId));
              for (const l of scraped) {
                if (!keptIds.has(l.sourceId)) {
                  this.lastFilteredSourceIds.add(l.sourceId);
                  this.lastFilteredListings.push(l);
                }
              }
            }

            this.logger.info(
              { ...pageLogId, count: listings.length, ...(filteredOut > 0 ? { filtered: filteredOut } : {}) },
              "Parsed listings from page",
            );
            allListings.push(...listings);
          }
        } catch (error) {
          this.logger.error(
            {
              ...logId,
              pageIndex: currentPageIndex,
              pageCount: currentPageCount,
              pageUrl: currentPageUrl,
              err: error,
            },
            "Failed to scrape URL",
          );
          this.lastFailedUrls.push(urlEntry.url);
          // Capture a fallback snapshot when the module-level code didn't already
          // record one (e.g. unexpected Playwright timeout / navigation error).
          // Only add if there's no snapshot for this URL yet — module-specific
          // paths (CF challenge, redirect, selector_broken) add their own first.
          const alreadyCaptured = this.lastDebugSnapshots.some((s) => s.sourceUrl === urlEntry.url);
          if (!alreadyCaptured) {
            const html = await p.content().catch(() => "");
            this.addDebugSnapshot({
              moduleName: this.name,
              sourceUrl: urlEntry.url,
              errorType: "redirect",
              errorMsg: `Unexpected error: ${String(error).slice(0, 500)}`,
              html: html.length > 2_000_000 ? html.slice(0, 2_000_000) : html,
              capturedAt: new Date().toISOString(),
            });
          }
        } finally {
          await p.close();
        }
      }));
    } else {
      for (let urlIndex = 0; urlIndex < activeUrls.length; urlIndex++) {
        const urlEntry = activeUrls[urlIndex]!;

        // Polite gap between URL visits (skip before the first active URL)
        if (urlIndex > 0) {
          await page.waitForTimeout(3000 + Math.random() * 4000);
        }

        // Use nickname as the log label when set — avoids printing a 300-char URL on every line
        const logId = urlEntry.nickname
          ? { nickname: urlEntry.nickname }
          : { url: urlEntry.url };

        this.logger.info(logId, "Scraping");

        let currentPageUrl = urlEntry.url;
        let currentPageIndex = 1;
        let currentPageCount = 1;
        try {
          let pages: string[];
          if (urlEntry.pagination) {
            await page.goto(urlEntry.url, { waitUntil: "domcontentloaded" });
            pages = await this.discoverPages(page, urlEntry.url, urlEntry.maxPages);
            this.logger.info(
              { ...logId, discoveredPages: pages.length, maxPages: urlEntry.maxPages },
              "Discovered pages",
            );
          } else {
            pages = [urlEntry.url];
          }

          currentPageCount = pages.length;
          for (let pageOffset = 0; pageOffset < pages.length; pageOffset++) {
            const pageUrl = pages[pageOffset]!;
            currentPageUrl = pageUrl;
            currentPageIndex = pageOffset + 1;
            const pageLogId = {
              ...logId,
              pageIndex: currentPageIndex,
              pageCount: currentPageCount,
              pageUrl,
            };

            this.logger.info(pageLogId, "Scraping page");

            if (pageUrl !== urlEntry.url || !urlEntry.pagination) {
              await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
            }

            const delay = 1000 + Math.random() * 2000;
            await page.waitForTimeout(delay);

            const scraped = await this.scrape(page, pageUrl);
            // Always associate listings with the base monitoring URL, not the
            // paginated page URL. Parsers receive the page URL for context but
            // the server matches listings to config URLs via sourceUrl — using
            // a page-specific URL breaks disabled/failed URL exclusion.
            applySourceAttribution(scraped, urlEntry);
            const listings = applyPriceFilter(scraped, urlEntry.filters);
            const filteredOut = scraped.length - listings.length;

            // Track price-filtered listings so main.ts can:
            //  1. exclude them from "removed" detection (still live on site)
            //  2. persist their current price/metadata so the UI stays accurate
            if (filteredOut > 0) {
              const keptIds = new Set(listings.map((l) => l.sourceId));
              for (const l of scraped) {
                if (!keptIds.has(l.sourceId)) {
                  this.lastFilteredSourceIds.add(l.sourceId);
                  this.lastFilteredListings.push(l);
                }
              }
            }

            this.logger.info(
              { ...pageLogId, count: listings.length, ...(filteredOut > 0 ? { filtered: filteredOut } : {}) },
              "Parsed listings from page",
            );
            allListings.push(...listings);
          }
        } catch (error) {
          this.logger.error(
            {
              ...logId,
              pageIndex: currentPageIndex,
              pageCount: currentPageCount,
              pageUrl: currentPageUrl,
              err: error,
            },
            "Failed to scrape URL",
          );
          this.lastFailedUrls.push(urlEntry.url);
          // Capture a fallback snapshot when the module-level code didn't already
          // record one (e.g. unexpected Playwright timeout / navigation error).
          // Only add if there's no snapshot for this URL yet — module-specific
          // paths (CF challenge, redirect, selector_broken) add their own first.
          const alreadyCaptured = this.lastDebugSnapshots.some((s) => s.sourceUrl === urlEntry.url);
          if (!alreadyCaptured) {
            const html = await page.content().catch(() => "");
            this.addDebugSnapshot({
              moduleName: this.name,
              sourceUrl: urlEntry.url,
              errorType: "redirect",
              errorMsg: `Unexpected error: ${String(error).slice(0, 500)}`,
              html: html.length > 2_000_000 ? html.slice(0, 2_000_000) : html,
              capturedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return allListings;
  }
}
