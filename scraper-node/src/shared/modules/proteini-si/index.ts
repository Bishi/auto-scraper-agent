import type { Page } from "playwright";
import type { Listing } from "../../types.js";
import { ScraperModule, type ScraperModuleConfig } from "../base.js";
import { parseProduct } from "./parser.js";

export class ProteiniSiModule extends ScraperModule {
  constructor(config: ScraperModuleConfig, logger: import("pino").Logger) {
    super({ ...config, name: "proteini-si", displayName: "Proteini.si" }, logger);
  }

  // Not used when run() is overridden, but required by the abstract base class.
  async scrape(_page: Page, url: string): Promise<Listing[]> {
    const listing = await this.fetchProduct(url);
    return listing ? [listing] : [];
  }

  // Override to skip Playwright — each URL is a single product page fetched with fetch().
  override async run(_page: Page, _createPage?: () => Promise<Page>): Promise<Listing[]> {
    this.lastFailedUrls = [];
    const allListings: Listing[] = [];
    const parallel = this.config.options?.["parallelUrls"] === true;

    const scrapeOne = async (urlEntry: (typeof this.config.urls)[number]): Promise<void> => {
      const logId = urlEntry.nickname
        ? { nickname: urlEntry.nickname }
        : { url: urlEntry.url };

      this.logger.info(logId, parallel ? "Fetching product page (parallel)" : "Fetching product page");

      try {
        const listing = await this.fetchProduct(urlEntry.url);
        if (!listing) {
          this.logger.warn(logId, "Could not parse product page");
          return;
        }

        if (urlEntry.nickname) {
          listing.sourceUrlNickname = urlEntry.nickname;
        }

        this.logger.info(
          { ...logId, inStock: listing.metadata["inStock"] === 1 },
          "Parsed product",
        );

        allListings.push(listing);
      } catch (error) {
        this.logger.error({ ...logId, error }, "Failed to fetch product");
        this.lastFailedUrls.push(urlEntry.url);
      }
    };

    if (parallel) {
      await Promise.all(this.config.urls.map(scrapeOne));
    } else {
      for (const urlEntry of this.config.urls) {
        await scrapeOne(urlEntry);
      }
    }

    return allListings;
  }

  private async fetchProduct(url: string): Promise<Listing | null> {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sl-SI,sl;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const html = await response.text();
    return parseProduct(html, url);
  }
}
