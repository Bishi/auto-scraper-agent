import type { Page } from "playwright";
import type { Listing } from "../../types.js";
import { ScraperModule, type ScraperModuleConfig } from "../base.js";
import { parseListings, parsePaginationLinks } from "./parser.js";
import { SELECTORS } from "./selectors.js";

export class BolhaModule extends ScraperModule {
  constructor(config: ScraperModuleConfig, logger: import("pino").Logger) {
    super({ ...config, name: "bolha", displayName: "Bolha.com" }, logger);
  }

  async scrape(page: Page, url: string): Promise<Listing[]> {
    const ready = await page
      .waitForSelector(SELECTORS.listingItem, { timeout: 15000 })
      .then(() => true)
      .catch(async () => {
        // Check for Radware Bot Manager / captcha challenge
        const isChallenge = await page
          .evaluate(
            () =>
              document.title.toLowerCase().includes("captcha") ||
              document.title.toLowerCase().includes("bot manager") ||
              !!document.querySelector("#px-captcha, .px-captcha, iframe[src*='captcha']"),
          )
          .catch(() => false);

        if (isChallenge) {
          this.logger.info({ url }, "Bot challenge detected — waiting up to 90s for resolution");
          await page.waitForSelector(SELECTORS.listingItem, { timeout: 90000 });
          return true;
        }

        return false;
      });

    if (!ready) {
      const { pageTitle, pageUrl, hasResultsContainer, isNoResults } = await page
        .evaluate((noResultsText) => ({
          pageTitle: document.title,
          pageUrl: window.location.href,
          // .EntityList--Regular is always rendered on a search results page,
          // even when the query returns zero listings. Its absence means we
          // landed on the wrong page (404, redirect, bot block, selector drift).
          hasResultsContainer: !!document.querySelector(".EntityList--Regular"),
          // bolha shows this text when the search has zero real matches.
          isNoResults: document.body.innerText.includes(noResultsText),
        }), SELECTORS.noResultsText)
        .catch(() => ({ pageTitle: "unknown", pageUrl: url, hasResultsContainer: false, isNoResults: false }));

      const captureHtml = async (): Promise<string> => {
        const raw = await page.content().catch(() => "");
        return raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;
      };

      if (!hasResultsContainer) {
        // Wrong page entirely — redirect, 404, bot block, or completely broken selector
        const errorMsg = "Results container (.EntityList--Regular) not found — selector may be broken, URL redirected, or unexpected page";
        this.logger.error({ url, pageTitle, pageUrl }, errorMsg);
        this.addDebugSnapshot({ moduleName: this.name, sourceUrl: url, errorType: "redirect", errorMsg, html: await captureHtml(), capturedAt: new Date().toISOString() });
      } else if (isNoResults) {
        // Right page, bolha explicitly says no results (WARN only, no snapshot needed)
        this.logger.warn({ url, pageTitle, pageUrl }, "Empty search results — no listings matched this query");
      } else {
        // Right page, no "no results" message, but item selector matched nothing —
        // bolha likely changed their HTML class names
        const errorMsg = "Item selector (.EntityList-item) not found inside results container — bolha may have changed their HTML";
        this.logger.error({ url, pageTitle, pageUrl }, errorMsg);
        this.addDebugSnapshot({ moduleName: this.name, sourceUrl: url, errorType: "selector_broken", errorMsg, html: await captureHtml(), capturedAt: new Date().toISOString() });
      }
      return [];
    }

    // Guard: when a bolha search returns zero real matches, bolha still renders
    // .EntityList--Regular with unrelated "suggested" listings alongside the
    // "ni rezultatov za iskanje" message. waitForSelector above would have
    // succeeded on those filler items — detect the message and bail out early.
    const isNoResults = await page
      .evaluate((text) => document.body.innerText.includes(text), SELECTORS.noResultsText)
      .catch(() => false);

    if (isNoResults) {
      this.logger.warn({ url }, "Empty search results — 'ni rezultatov za iskanje' detected (filler suggestions ignored)");
      return [];
    }

    const html = await page.content();
    return parseListings(html, url);
  }

  async discoverPages(page: Page, url: string, maxPages: number): Promise<string[]> {
    const pages = [url];

    try {
      await page.waitForSelector(SELECTORS.listingItem, { timeout: 15000 });
    } catch {
      return pages;
    }

    const html = await page.content();
    const pageLinks = parsePaginationLinks(html, url);
    for (const link of pageLinks) {
      if (pages.length >= maxPages) break;
      if (!pages.includes(link)) {
        pages.push(link);
      }
    }

    this.logger.info({ totalPages: pages.length, maxPages }, "Discovered pages");
    return pages.slice(0, maxPages);
  }
}
