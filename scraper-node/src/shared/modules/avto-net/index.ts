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
    // Cloudflare challenge titles, keyed to the locale set in context.ts (sl-SI).
    // The Slovenian title "Počakajte trenutek..." is the localised equivalent of
    // the English "Just a moment..." — both indicate a CF managed challenge page.
    const CF_CHALLENGE_TITLES = ["just a moment", "počakajte trenutek", "un moment"];

    const isChallengeTitle = (title: string) =>
      CF_CHALLENGE_TITLES.some((t) => title.toLowerCase().includes(t));

    const ready = await page
      .waitForSelector(SELECTORS.listingRow, { timeout: 15000 })
      .then(() => true)
      .catch(async () => {
        // Check if we're stuck on a Cloudflare managed challenge page.
        // Cloudflare localises the page title — check both the DOM and a set of
        // known titles (English + Slovenian, matching our locale: "sl-SI").
        const isChallenge = await page
          .evaluate(
            ({ titles, domCheck }: { titles: string[]; domCheck: string }) => {
              const titleMatch = titles.some((t) => document.title.toLowerCase().includes(t));
              const domMatch = !!document.querySelector(domCheck);
              return titleMatch || domMatch;
            },
            {
              titles: CF_CHALLENGE_TITLES,
              domCheck: "#challenge-stage, #cf-wrapper, #challenge-form, .cf-browser-verification",
            },
          )
          .catch(() => false);

        if (isChallenge) {
          // Distinguish between two CF challenge types:
          //  - Managed Challenge (Turnstile): has a Turnstile widget/iframe — NEVER auto-resolves
          //    in headless mode. Fail immediately instead of wasting time.
          //  - JS Challenge: auto-executing scripts that resolve in seconds if at all.
          //    Give it up to 30s (the old 90s was always overkill — JS challenges
          //    either resolve quickly or not at all).
          const isManagedChallenge = await page.evaluate(() =>
            !!document.querySelector('[id^="cf-chl-widget-"]') ||
            !!document.querySelector('.cf-turnstile') ||
            Array.from(document.querySelectorAll('iframe')).some(
              (f) => (f as HTMLIFrameElement).src.includes('challenges.cloudflare.com'),
            )
          ).catch(() => false);

          if (isManagedChallenge) {
            this.logger.error(
              { url },
              "Cloudflare Managed Challenge (Turnstile) — cannot auto-solve in headless mode. " +
              "Fix: set browser.headless=false in Settings, or clear the browser profile " +
              "(POST http://127.0.0.1:9001/clear-profile) to reset CF trust.",
            );
            // Throw so base.ts adds this URL to lastFailedUrls (avoids false "removed" detections)
            throw new Error("Cloudflare Managed Challenge blocked scrape");
          }

          this.logger.info({ url }, "Cloudflare JS challenge — waiting up to 30s for auto-resolution");
          // Throws on timeout → propagates to base.ts as a failed URL (same as before)
          await page.waitForSelector(SELECTORS.listingRow, { timeout: 30000 });
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

      // A Cloudflare managed challenge keeps the browser on the original
      // results.asp URL, so onResultsPage stays true even though we're blocked.
      // Detect this before the onResultsPage/hasActualRows three-way check so
      // it routes as ERROR (bot block) instead of WARN (empty search).
      if (isChallengeTitle(pageTitle)) {
        this.logger.error(
          { url, pageTitle, pageUrl },
          "Cloudflare challenge page — bot detection blocked the scrape (locale-localised title detected)",
        );
        return [];
      }

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
