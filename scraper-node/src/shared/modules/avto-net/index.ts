import type { Page } from "playwright";
import type { Listing } from "../../types.js";
import { ScraperModule, type ScraperModuleConfig } from "../base.js";
import { parseListings } from "./parser.js";
import { SELECTORS } from "./selectors.js";

const AVTO_NET_PAGE_SIZE = 48;
const AVTO_NET_INTER_PAGE_DELAY_MS = 10_000;

function normalizeAvtoNetPageUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function buildStranPageUrl(baseUrl: string, pageNumber: number): string | null {
  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.set("stran", String(pageNumber));
    return parsed.toString();
  } catch {
    return null;
  }
}

function getStranPageNumber(pageUrl: string): number {
  try {
    const raw = new URL(pageUrl).searchParams.get("stran");
    if (!raw) return 1;
    const pageNumber = Number.parseInt(raw, 10);
    return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  } catch {
    return 1;
  }
}

export function extractAvtoNetResultCount(text: string): number | null {
  const match = text.match(/Prikazano\s+([\d.]+)\s+oglasov/i);
  if (!match?.[1]) return null;
  const count = Number.parseInt(match[1].replace(/\./g, ""), 10);
  return Number.isFinite(count) ? count : null;
}

export function buildSequentialStranPageUrls(
  baseUrl: string,
  maxPages: number,
  totalResults: number | null,
): string[] {
  const pages = [baseUrl];
  const seen = new Set<string>(pages);
  const currentPageNumber = getStranPageNumber(baseUrl);
  const totalPages = totalResults == null
    ? currentPageNumber + maxPages - 1
    : Math.max(1, Math.ceil(totalResults / AVTO_NET_PAGE_SIZE));
  const pageLimit = Math.min(currentPageNumber + maxPages - 1, totalPages);

  for (let pageNumber = currentPageNumber + 1; pageNumber <= pageLimit; pageNumber++) {
    if (pages.length >= maxPages) break;
    const pageUrl = buildStranPageUrl(baseUrl, pageNumber);
    if (pageUrl && !seen.has(pageUrl)) {
      seen.add(pageUrl);
      pages.push(pageUrl);
    }
  }

  return pages;
}

export class AvtoNetModule extends ScraperModule {
  constructor(config: ScraperModuleConfig, logger: import("pino").Logger) {
    super({ ...config, name: "avto-net", displayName: "Avto.net" }, logger);
  }

  protected override async navigateToPage(
    page: Page,
    url: string,
    options?: { referer?: string; logId?: Record<string, unknown> },
  ): Promise<void> {
    if (this.isInterPageNavigation(options?.logId)) {
      this.logger.info(options?.logId ?? {}, "Waiting before avto.net pagination");
      await page.waitForTimeout(AVTO_NET_INTER_PAGE_DELAY_MS);
    }

    const clicked = await this.clickPaginationLink(page, url, options?.referer, options?.logId);
    if (clicked) return;
    await super.navigateToPage(page, url, options);
  }

  private isInterPageNavigation(logId?: Record<string, unknown>): boolean {
    return typeof logId?.["pageIndex"] === "number" && logId["pageIndex"] > 1;
  }

  private async clickPaginationLink(
    page: Page,
    url: string,
    referer?: string,
    logId?: Record<string, unknown>,
  ): Promise<boolean> {
    const targetUrl = normalizeAvtoNetPageUrl(url, referer ?? url);
    if (!targetUrl) return false;

    const links = await page.$$(SELECTORS.pageLinks).catch(() => []);
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => null);
      if (!href) continue;

      const linkUrl = normalizeAvtoNetPageUrl(href, referer ?? url);
      if (linkUrl !== targetUrl) continue;

      this.logger.info({ ...logId, pageUrl: targetUrl }, "Clicking pagination link");
      const [navigationError] = await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).then(
          () => null,
          (err: unknown) => err,
        ),
        link.click({ delay: 50 + Math.random() * 100 }),
      ]);
      if (navigationError) {
        this.logger.warn(
          {
            ...logId,
            pageUrl: targetUrl,
            err: navigationError,
          },
          "Pagination click did not confirm navigation",
        );
      }
      return true;
    }

    return false;
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
            const errorMsg =
              "Cloudflare Managed Challenge (Turnstile) — cannot auto-solve in headless mode. " +
              "Fix: set browser.headless=false in Settings, or clear the browser profile " +
              "(POST http://127.0.0.1:9001/clear-profile) to reset CF trust.";
            this.logger.error({ url }, errorMsg);
            // Capture the challenge page HTML before throwing so the dashboard
            // can show exactly what Cloudflare returned.
            const html = await page.content().catch(() => "");
            this.addDebugSnapshot({
              moduleName: this.name,
              sourceUrl: url,
              errorType: "bot_block",
              errorMsg,
              html: html.length > 2_000_000 ? html.slice(0, 2_000_000) : html,
              capturedAt: new Date().toISOString(),
            });
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

      const captureHtml = async (): Promise<string> => {
        const raw = await page.content().catch(() => "");
        return raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;
      };

      // A Cloudflare managed challenge keeps the browser on the original
      // results.asp URL, so onResultsPage stays true even though we're blocked.
      // Detect this before the onResultsPage/hasActualRows three-way check so
      // it routes as ERROR (bot block) instead of WARN (empty search).
      if (isChallengeTitle(pageTitle)) {
        const errorMsg = "Cloudflare challenge page — bot detection blocked the scrape (locale-localised title detected)";
        this.logger.error({ url, pageTitle, pageUrl }, errorMsg);
        this.addDebugSnapshot({ moduleName: this.name, sourceUrl: url, errorType: "bot_block", errorMsg, html: await captureHtml(), capturedAt: new Date().toISOString() });
        return [];
      }

      if (!onResultsPage) {
        // Wrong page entirely — redirect, 404, bot block, or completely broken URL
        const errorMsg = "Not on results page — URL redirected unexpectedly, wrong URL, or bot block";
        this.logger.error({ url, pageTitle, pageUrl }, errorMsg);
        this.addDebugSnapshot({ moduleName: this.name, sourceUrl: url, errorType: "redirect", errorMsg, html: await captureHtml(), capturedAt: new Date().toISOString() });
      } else if (hasActualRows) {
        // Right page, rows exist in the DOM, but our selector didn't match — class name changed
        const errorMsg = "Item selector (.GO-Results-Row) not found by configured selector — avto.net may have changed their HTML";
        this.logger.error({ url, pageTitle, pageUrl }, errorMsg);
        this.addDebugSnapshot({ moduleName: this.name, sourceUrl: url, errorType: "selector_broken", errorMsg, html: await captureHtml(), capturedAt: new Date().toISOString() });
      } else {
        // Right page, no rows at all — genuine empty search (WARN only, no snapshot needed)
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
    const currentPageNumber = getStranPageNumber(url);

    for (const link of pageLinks) {
      if (pageUrls.size >= maxPages) break;

      const href = await link.getAttribute("href");
      if (!href) continue;

      const fullUrl = normalizeAvtoNetPageUrl(href, url);
      if (fullUrl && getStranPageNumber(fullUrl) <= currentPageNumber) continue;
      if (fullUrl && !pageUrls.has(fullUrl)) {
        pageUrls.add(fullUrl);
        pages.push(fullUrl);
      }
    }

    if (pages.length < maxPages && maxPages > 1) {
      const listingCount = await page.$$(SELECTORS.listingRow).then((rows) => rows.length).catch(() => 0);
      const bodyText = await page.textContent("body").catch(() => "");
      const totalResults = bodyText ? extractAvtoNetResultCount(bodyText) : null;
      if (listingCount >= AVTO_NET_PAGE_SIZE || (totalResults ?? 0) > AVTO_NET_PAGE_SIZE) {
        for (const pageUrl of buildSequentialStranPageUrls(url, maxPages, totalResults)) {
          if (pages.length >= maxPages) break;
          if (!pageUrls.has(pageUrl)) {
            pageUrls.add(pageUrl);
            pages.push(pageUrl);
          }
        }
      }
    }

    return pages.slice(0, maxPages);
  }
}
