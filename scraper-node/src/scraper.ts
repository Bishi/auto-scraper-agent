import pino from "pino";
import type { Logger } from "pino";
import { Writable } from "node:stream";
import { existsSync, rmSync } from "node:fs";
import { agentLogger, sanitizeScraperLogEntry } from "./logger.js";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { BrowserManager } from "./shared/browser/context.js";
import { getModule } from "./shared/modules/registry.js";
import { normalizeUrlEntry } from "./shared/config.js";
import type { UrlEntry } from "./shared/config.js";
import type { Listing, LogEntry, DbModuleConfig, DebugSnapshotData } from "./shared/types.js";

const BROWSER_PROFILE_DIR = join(homedir(), ".auto-scraper", "browser-profile");

interface LogBuffer {
  logger: Logger;
  flush(): LogEntry[];
}

function createLogBuffer(onLog?: (entry: LogEntry) => void): LogBuffer {
  const entries: LogEntry[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      try {
        const line = chunk.toString().trim();
        if (line) {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.msg) {
            const sanitized = sanitizeScraperLogEntry(entry);
            entries.push(sanitized);
            onLog?.(sanitized);
          }
        }
      } catch {
        // non-JSON line — ignore
      }
      cb();
    },
  });

  // pino() without custom levels infers Logger<never>; cast to Logger (= Logger<string>)
  // so it matches what ScraperModule constructors expect.
  const logger = pino({ level: "debug" }, stream) as unknown as Logger;

  return {
    logger,
    flush(): LogEntry[] {
      const all = [...entries];
      entries.length = 0;
      return all;
    },
  };
}

export interface ScrapeResult {
  listings: Listing[];
  logs: LogEntry[];
  filteredListings: Listing[];
  failedUrls: string[];
  hadManagedChallenge: boolean;
  debugSnapshots: DebugSnapshotData[];
}

function isHeadlessShellPath(path: string | undefined): boolean {
  return path?.toLowerCase().includes("headless-shell") ?? false;
}

function firstExistingPath(paths: Array<string | undefined>): string | undefined {
  return paths.find((path) => path != null && existsSync(path));
}

function headedBrowserPath(): string | undefined {
  const envPath = firstExistingPath([
    process.env["CHROMIUM_HEADED_PATH"],
    process.env["CHROME_PATH"],
    process.env["GOOGLE_CHROME_SHIM"],
  ]);
  if (envPath) return envPath;

  if (platform() === "darwin") {
    return firstExistingPath([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]);
  }

  if (platform() === "win32") {
    return firstExistingPath([
      process.env["LOCALAPPDATA"]
        ? join(process.env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe")
        : undefined,
      process.env["PROGRAMFILES"]
        ? join(process.env["PROGRAMFILES"], "Google/Chrome/Application/chrome.exe")
        : undefined,
      process.env["PROGRAMFILES(X86)"]
        ? join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe")
        : undefined,
      process.env["PROGRAMFILES"]
        ? join(process.env["PROGRAMFILES"], "Microsoft/Edge/Application/msedge.exe")
        : undefined,
    ]);
  }

  return firstExistingPath([
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]);
}

function resolveBrowserExecutablePath(headless: boolean): string | undefined {
  const chromiumPath = process.env["CHROMIUM_PATH"];
  if (headless) return chromiumPath;
  if (chromiumPath && !isHeadlessShellPath(chromiumPath) && existsSync(chromiumPath)) {
    return chromiumPath;
  }
  if (isHeadlessShellPath(chromiumPath)) {
    agentLogger.warn(
      "[system] Browser launch requested headless=false; ignoring bundled chromium-headless-shell",
    );
  }
  const headedPath = headedBrowserPath();
  if (!headedPath) {
    agentLogger.warn(
      "[system] Browser launch requested headless=false but no headed Chrome/Chromium path was found",
    );
  }
  return headedPath;
}

export async function runModule(
  moduleName: string,
  moduleConfig: DbModuleConfig,
  browserOptions?: { headless?: boolean; slowMo?: number; timeout?: number },
  onLog?: (entry: LogEntry) => void,
): Promise<ScrapeResult> {
  const { logger, flush } = createLogBuffer(onLog);

  const normalizedUrls = (moduleConfig.urls ?? []).map((u) =>
    normalizeUrlEntry(u as UrlEntry),
  );

  const scraperModuleConfig = {
    name: moduleName,
    displayName: moduleName,
    urls: normalizedUrls,
    options: moduleConfig.options,
  };

  const module = getModule(scraperModuleConfig, logger);

  const headless = browserOptions?.headless ?? true;
  const chromiumPath = resolveBrowserExecutablePath(headless);

  const browser = new BrowserManager({
    headless,
    slowMo: browserOptions?.slowMo,
    timeout: browserOptions?.timeout ?? 30000,
    executablePath: chromiumPath,
  });

  await browser.launch();

  let hadManagedChallenge = false;
  try {
    const page = await browser.newPage();
    const listings = await module.run(page, () => browser.newPage());
    const logs = flush();

    hadManagedChallenge = logs.some(
      (e) => typeof e.msg === "string" && e.msg.includes("Managed Challenge"),
    );

    return {
      listings,
      logs,
      filteredListings: module.lastFilteredListings,
      failedUrls: module.lastFailedUrls,
      hadManagedChallenge,
      debugSnapshots: module.lastDebugSnapshots,
    };
  } finally {
    await browser.close();
    // Auto-clear the browser profile if a Managed Challenge was detected.
    // The profile was flagged by CF during this run — wiping it gives the
    // next run a clean slate so CF re-evaluates without prior bad signals.
    if (hadManagedChallenge) {
      try {
        rmSync(BROWSER_PROFILE_DIR, { recursive: true, force: true });
        agentLogger.info("[scrape] Browser profile auto-cleared after Managed Challenge — retrying immediately");
      } catch (_) { /* non-fatal */ }
    }
  }
}
