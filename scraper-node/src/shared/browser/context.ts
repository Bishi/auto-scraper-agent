// Use playwright-extra's `addExtra` named export instead of the default
// `chromium` re-export.  The default export tries to locate playwright via a
// dynamic require('playwright-core') / require('playwright') at runtime — in
// a Node.js SEA those calls go through embedderRequire which only handles
// built-ins → crash.  `addExtra` lets us hand playwright's chromium in
// directly, so playwright-extra never needs to auto-detect it.
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// Import every evasion sub-plugin statically so esbuild bundles them.
// The stealth plugin otherwise loads them via dynamic require() at launch time,
// which fails in a Node.js SEA (embedderRequire only handles built-ins).
// We pre-register each one via setDependencyResolution so playwright-extra's
// bundler-unfriendly dependency loader is bypassed entirely.
import EvasionChromeApp             from "puppeteer-extra-plugin-stealth/evasions/chrome.app/index.js";
import EvasionChromeCsi             from "puppeteer-extra-plugin-stealth/evasions/chrome.csi/index.js";
import EvasionChromeLoadTimes       from "puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes/index.js";
import EvasionChromeRuntime         from "puppeteer-extra-plugin-stealth/evasions/chrome.runtime/index.js";
import EvasionDefaultArgs           from "puppeteer-extra-plugin-stealth/evasions/defaultArgs/index.js";
import EvasionIframeContentWindow   from "puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow/index.js";
import EvasionMediaCodecs           from "puppeteer-extra-plugin-stealth/evasions/media.codecs/index.js";
import EvasionNavigatorHardware     from "puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency/index.js";
import EvasionNavigatorLanguages    from "puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js";
import EvasionNavigatorPermissions  from "puppeteer-extra-plugin-stealth/evasions/navigator.permissions/index.js";
import EvasionNavigatorPlugins      from "puppeteer-extra-plugin-stealth/evasions/navigator.plugins/index.js";
import EvasionNavigatorVendor       from "puppeteer-extra-plugin-stealth/evasions/navigator.vendor/index.js";
import EvasionNavigatorWebdriver    from "puppeteer-extra-plugin-stealth/evasions/navigator.webdriver/index.js";
import EvasionSourceurl             from "puppeteer-extra-plugin-stealth/evasions/sourceurl/index.js";
// user-agent-override is intentionally excluded: its dependency chain
// (user-preferences → user-data-dir) cannot be resolved in a Node.js SEA,
// and it is redundant because we already set userAgent in launchPersistentContext.
import EvasionWebglVendor           from "puppeteer-extra-plugin-stealth/evasions/webgl.vendor/index.js";
import EvasionWindowOuterdimensions from "puppeteer-extra-plugin-stealth/evasions/window.outerdimensions/index.js";
import playwright from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "../config.js";
import { agentLogger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Build the stealth-patched chromium once at module load.
// ---------------------------------------------------------------------------

const chromium = addExtra(playwright.chromium);

// Disable user-agent-override: its dep chain (user-preferences → user-data-dir)
// cannot be resolved in a Node.js SEA, and the evasion is redundant since we
// set userAgent directly in launchPersistentContext options.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("user-agent-override");
chromium.use(stealth);

// Pre-register every evasion dependency so playwright-extra never falls back
// to dynamic require() (which crashes in Node.js SEA mode).
const EVASION_DEPS: Array<[string, unknown]> = [
  ["stealth/evasions/chrome.app",                    EvasionChromeApp],
  ["stealth/evasions/chrome.csi",                    EvasionChromeCsi],
  ["stealth/evasions/chrome.loadTimes",              EvasionChromeLoadTimes],
  ["stealth/evasions/chrome.runtime",                EvasionChromeRuntime],
  ["stealth/evasions/defaultArgs",                   EvasionDefaultArgs],
  ["stealth/evasions/iframe.contentWindow",          EvasionIframeContentWindow],
  ["stealth/evasions/media.codecs",                  EvasionMediaCodecs],
  ["stealth/evasions/navigator.hardwareConcurrency", EvasionNavigatorHardware],
  ["stealth/evasions/navigator.languages",           EvasionNavigatorLanguages],
  ["stealth/evasions/navigator.permissions",         EvasionNavigatorPermissions],
  ["stealth/evasions/navigator.plugins",             EvasionNavigatorPlugins],
  ["stealth/evasions/navigator.vendor",              EvasionNavigatorVendor],
  ["stealth/evasions/navigator.webdriver",           EvasionNavigatorWebdriver],
  ["stealth/evasions/sourceurl",                     EvasionSourceurl],
  ["stealth/evasions/webgl.vendor",                  EvasionWebglVendor],
  ["stealth/evasions/window.outerdimensions",        EvasionWindowOuterdimensions],
];

for (const [path, mod] of EVASION_DEPS) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chromium.plugins as any).setDependencyResolution(path, mod);
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

// Persist browser profile so Cloudflare cookies accumulate trust over runs
const USER_DATA_DIR = join(homedir(), ".auto-scraper", "browser-profile");

export type BrowserConfig = AppConfig["browser"] & {
  /** Optional Chromium executable override from CHROMIUM_PATH.
   *  Bundled builds currently use Playwright's default browser discovery unless this is set. */
  executablePath?: string;
};

function configuredBrowserRuntime(config: BrowserConfig): string {
  return config.executablePath ? `CHROMIUM_PATH:${config.executablePath}` : "default";
}

function browserVersion(browser: Pick<Browser, "version"> | null): string {
  try {
    return browser?.version() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private browserPid: number | null = null;

  constructor(private config: BrowserConfig) {}

  async launch(): Promise<void> {
    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      executablePath: this.config.executablePath,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "sl-SI",
      timezoneId: "Europe/Ljubljana",
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    // Playwright's Browser type doesn't expose process() in its public typings,
    // but the underlying object does have it at runtime for locally-launched browsers.
    const browser = this.context.browser() as
      | (Browser & { process?(): { pid?: number } })
      | null;
    this.browserPid = browser?.process?.()?.pid ?? null;
    agentLogger.info(
      `[agent] Browser launch headless=${this.config.headless} ` +
      `configured=${configuredBrowserRuntime(this.config)} version=${browserVersion(browser)}`,
    );
    this.context.setDefaultTimeout(this.config.timeout);

    // Inject fingerprint fixes directly on the context so they apply to every
    // page regardless of whether the stealth plugin's onPageCreated hook fires
    // correctly for launchPersistentContext.
    //
    // NOTE: the user-agent-override stealth evasion is disabled (its dep chain
    // can't resolve in Node.js SEA), so we replicate its two key fixes here:
    //   1. navigator.webdriver → undefined  (stealth navigator.webdriver also does this)
    //   2. navigator.userAgentData          (only user-agent-override did this — gap!)
    //
    // Without #2, CF sees navigator.userAgent claiming "Chrome 131" while
    // navigator.userAgentData.brands reveals the actual Chromium build —
    // a strong bot-detection signal.
    await this.context.addInitScript(() => {
      // 1. Hide webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // 2. Align userAgentData with our spoofed userAgent (Chrome 131, Windows)
      try {
        const brands = [
          { brand: "Google Chrome", version: "131" },
          { brand: "Chromium",      version: "131" },
          { brand: "Not_A Brand",   version: "24"  },
        ];
        const fullList = [
          { brand: "Google Chrome", version: "131.0.0.0" },
          { brand: "Chromium",      version: "131.0.0.0" },
          { brand: "Not_A Brand",   version: "24.0.0.0"  },
        ];
        const hintValues = {
          architecture: "x86", bitness: "64", brands,
          fullVersionList: fullList, mobile: false, model: "",
          platform: "Windows", platformVersion: "15.0.0",
          uaFullVersion: "131.0.0.0",
        };
        const uaData = {
          brands,
          mobile: false,
          platform: "Windows",
          getHighEntropyValues(hints: string[]) {
            const out: Record<string, unknown> = {};
            for (const h of hints) { if (h in hintValues) out[h] = (hintValues as Record<string, unknown>)[h]; }
            return Promise.resolve(out);
          },
          toJSON() { return { brands, mobile: false, platform: "Windows" }; },
        };
        Object.defineProperty(navigator, "userAgentData", { get: () => uaData });
      } catch (_) { /* browser may not support userAgentData */ }
    });
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser not launched. Call launch() first.");
    return this.context.newPage();
  }

  async close(): Promise<void> {
    if (!this.context) return;

    const ctx = this.context;
    const pid = this.browserPid;
    this.context = null;
    this.browserPid = null;

    try {
      await Promise.race([
        ctx.close(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("browser.close() timed out after 10s")), 10_000)
        ),
      ]);
    } catch {
      if (pid) {
        if (process.platform === "win32") {
          try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" }); } catch { /* already gone */ }
        } else {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
  }
}
