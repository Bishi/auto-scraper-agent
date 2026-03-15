import pino from "pino";
import type { Logger } from "pino";
import { Writable } from "node:stream";
import { BrowserManager } from "./shared/browser/context.js";
import { getModule } from "./shared/modules/registry.js";
import { normalizeUrlEntry } from "./shared/config.js";
import type { UrlEntry } from "./shared/config.js";
import type { Listing, LogEntry, DbModuleConfig } from "./shared/types.js";

interface LogBuffer {
  logger: Logger;
  flush(): LogEntry[];
}

function createLogBuffer(): LogBuffer {
  const entries: LogEntry[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      try {
        const line = chunk.toString().trim();
        if (line) {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.msg) entries.push(entry);
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
}

export async function runModule(
  moduleName: string,
  moduleConfig: DbModuleConfig,
  browserOptions?: { headless?: boolean; slowMo?: number; timeout?: number },
): Promise<ScrapeResult> {
  const { logger, flush } = createLogBuffer();

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

  // When running as a bundled .exe, the Tauri shell sets CHROMIUM_PATH to the
  // chromium-headless-shell sidecar so Playwright doesn't look for its own browser.
  const chromiumPath = process.env["CHROMIUM_PATH"];

  const browser = new BrowserManager({
    headless: browserOptions?.headless ?? true,
    slowMo: browserOptions?.slowMo,
    timeout: browserOptions?.timeout ?? 30000,
    executablePath: chromiumPath,
  });

  await browser.launch();

  try {
    const page = await browser.newPage();
    const listings = await module.run(page, () => browser.newPage());
    const logs = flush();

    return {
      listings,
      logs,
      filteredListings: module.lastFilteredListings,
      failedUrls: module.lastFailedUrls,
    };
  } finally {
    await browser.close();
  }
}
