import type { Page } from "playwright";
import type { Listing } from "../../types.js";
import { ScraperModule, type ScraperModuleConfig } from "../base.js";
import { parseListings } from "./parser.js";
import { SELECTORS } from "./selectors.js";

export class AvtoNetModule extends ScraperModule {
  constructor(config: ScraperModuleConfig, logger: import("pino").Logger) {
    super({ ...config, name: "avto-net", displayName: "Avto.net" }, logger);
  }

  async scrape(page: Page, url: string): Promise<Listing[]> {
    const ready = await page
      .waitForSelector(SELECTORS.listingRow, { timeout: 15000 })
      .then(() => true)
      .catch(async () => {
        // Check if we're stuck on a Cloudflare managed challenge page
        const isChallenge = await page
          .evaluate(
            () =>
              document.title.toLowerCase().includes("just a moment") ||
              !!document.querySelector("#cf-wrapper, #challenge-form, .cf-browser-verification"),
          )
          .catch(() => false);

        if (isChallenge) {
          this.logger.info({ url }, "Cloudflare challenge detected — waiting up to 90s for resolution");
          // This throws if unresolved, which propagates to base.ts as a failed URL
          await page.waitForSelector(SELECTORS.listingRow, { timeout: 90000 });
          return true;
        }

        return false; // genuinely empty results page
      });

    if (!ready) {
      const { pageTitle, pageUrl, onResultsPage, hasActualRows } = await page
        .evaluate(() => ({
          pageTitle: document.title,
          pageUrl: window.location.href,
          // avto.net search results always stay on /Ads/results.asp.
          // A redirect away (to homepage, 404, Cloudflare error) means something's wrong.
          onResultsPage: window.location.href.includes("avto.net") &&
                         window.location.pathname.toLowerCase().includes("results"),
          // Check for actual listing rows using the known-correct selector.
          // If rows ARE present, our SELECTORS.listingRow name is wrong (HTML changed).
          // If rows are absent, the search genuinely returned no results.
          hasActualRows: !!document.querySelector(".GO-Results-Row"),
        }))
        .catch(() => ({ pageTitle: "unknown", pageUrl: url, onResultsPage: false, hasActualRows: false }));

      if (!onResultsPage) {
        // Wrong page entirely — redirect, 404, bot block, or completely broken URL
        this.logger.error(
          { url, pageTitle, pageUrl },
          "Not on results page — URL redirected unexpectedly, wrong URL, or bot block",
        );
      } else if (hasActualRows) {
        // Right page, rows exist in the DOM, but our selector didn't match — class name changed
        this.logger.error(
          { url, pageTitle, pageUrl },
          "Item selector (.GO-Results-Row) not found by configured selector — avto.net may have changed their HTML",
        );
      } else {
        // Right page, no rows at all — genuine empty search
        this.logger.warn({ url, pageTitle, pageUrl }, "Empty search results — no listings matched this query");
      }
      return [];
    }

    const html = await page.content();
    return parseListings(html, url);
  }

  async discoverPages(page: Page, url: string, maxPages: number): Promise<string[]> {
    const pages = [url];

    try {
      await page.waitForSelector(SELECTORS.listingRow, { timeout: 15000 });
    } catch {
      return pages;
    }

    // Find all pagination links to determine total pages
    const pageLinks = await page.$$(SELECTORS.pageLinks);
    const pageUrls = new Set<string>([url]);

    for (const link of pageLinks) {
      if (pageUrls.size >= maxPages) break;

      const href = await link.getAttribute("href");
      if (!href) continue;

      const fullUrl = href.startsWith("http")
        ? href
        : `https://www.avto.net${href.startsWith("/") ? "" : "/"}${href}`;

      if (!pageUrls.has(fullUrl)) {
        pageUrls.add(fullUrl);
        pages.push(fullUrl);
      }
    }

    this.logger.info({ totalPages: pages.length, maxPages }, "Discovered pages");
    return pages.slice(0, maxPages);
  }
}
