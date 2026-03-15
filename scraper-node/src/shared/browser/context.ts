import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "../config.js";

// Stealth plugin bypasses Cloudflare's managed challenge bot detection
chromium.use(StealthPlugin());

// Persist browser profile so Cloudflare cookies accumulate trust over runs
const USER_DATA_DIR = join(homedir(), ".auto-scraper", "browser-profile");

export type BrowserConfig = AppConfig["browser"] & {
  /** Path to a Chromium executable. When running as a bundled .exe, set to the
   *  chromium-headless-shell sidecar path via the CHROMIUM_PATH env var. */
  executablePath?: string;
};

export class BrowserManager {
  private context: BrowserContext | null = null;

  constructor(private config: BrowserConfig) {}

  async launch(): Promise<void> {
    // playwright-extra's launchPersistentContext is compatible with playwright's BrowserContext
    this.context = (await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      executablePath: this.config.executablePath,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "sl-SI",
      timezoneId: "Europe/Ljubljana",
      viewport: { width: 1280, height: 800 },
    })) as unknown as BrowserContext;

    this.context.setDefaultTimeout(this.config.timeout);
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser not launched. Call launch() first.");
    return this.context.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }
}
