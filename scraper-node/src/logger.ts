import pino from "pino";
import type { Logger } from "pino";
import { Writable } from "node:stream";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LogEntry } from "./shared/types.js";

// UiLogEntry is the format the renderer expects: ISO timestamp + string level + plain message.
export interface UiLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

const LOG_DIR        = join(homedir(), ".auto-scraper", "logs");
const AGENT_LOG_FILE = join(LOG_DIR, "agent.log");
const MAX_AGENT_LINES   = 300;
const MAX_FILE_LINES    = 5000;
const MAX_SCRAPER_LINES = 1000;

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

function pinoLevel(n: number): "info" | "warn" | "error" {
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  return "info";
}

// ---------------------------------------------------------------------------
// Agent log buffer — persisted to ~/.auto-scraper/logs/agent.log (NDJSON)
// so history survives agent restarts. In-memory ring capped at MAX_AGENT_LINES.
// ---------------------------------------------------------------------------

export const AGENT_LOG_BUFFER: UiLogEntry[] = (() => {
  try {
    const lines = readFileSync(AGENT_LOG_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_FILE_LINES) {
      const trimmed = lines.slice(-MAX_FILE_LINES);
      writeFileSync(AGENT_LOG_FILE, trimmed.join("\n") + "\n", "utf8");
      return trimmed.slice(-MAX_AGENT_LINES).map((l) => JSON.parse(l) as UiLogEntry);
    }
    return lines.slice(-MAX_AGENT_LINES).map((l) => JSON.parse(l) as UiLogEntry);
  } catch {
    return [];
  }
})();

function pushAgent(entry: UiLogEntry): void {
  AGENT_LOG_BUFFER.push(entry);
  if (AGENT_LOG_BUFFER.length > MAX_AGENT_LINES) AGENT_LOG_BUFFER.shift();
  try {
    appendFileSync(AGENT_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* non-fatal — UI still works via in-memory buffer */ }
}

const agentStream = new Writable({
  write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    try {
      const line = chunk.toString().trim();
      if (line) {
        const raw = JSON.parse(line) as { level: number; time: number; msg?: string };
        if (raw.msg) {
          pushAgent({
            ts: new Date(raw.time).toISOString(),
            level: pinoLevel(raw.level),
            msg: raw.msg,
          });
        }
      }
    } catch { /* non-JSON line — ignore */ }
    cb();
  },
});

// base: null suppresses default pino pid/hostname fields for cleaner output.
export const agentLogger: Logger = pino({ level: "info", base: null }, agentStream) as unknown as Logger;

// ---------------------------------------------------------------------------
// Scraper log buffer — in-memory only, populated by pushScraperLogs() after
// each runModule() call. Not persisted — shows logs from the current session.
// ---------------------------------------------------------------------------

export const SCRAPER_LOG_BUFFER: UiLogEntry[] = [];

function formatScraperMsg(moduleName: string, raw: LogEntry): string {
  const parts: string[] = [`[${moduleName}]`, raw.msg];
  if (typeof raw["nickname"] === "string") {
    parts.push(`(${raw["nickname"]})`);
  } else if (typeof raw["url"] === "string") {
    parts.push(`(${(raw["url"] as string).slice(0, 80)})`);
  }
  if (typeof raw["count"]    === "number") parts.push(`count=${raw["count"]}`);
  if (typeof raw["filtered"] === "number") parts.push(`filtered=${raw["filtered"]}`);
  const errObj = raw["err"];
  if (errObj && typeof errObj === "object" && "message" in errObj) {
    parts.push(`— ${String((errObj as { message: unknown }).message).slice(0, 200)}`);
  }
  return parts.join(" ");
}

export function pushScraperLogs(moduleName: string, entries: LogEntry[]): void {
  for (const raw of entries) {
    if (!raw.msg) continue;
    const entry: UiLogEntry = {
      ts:    new Date(raw.time).toISOString(),
      level: pinoLevel(raw.level),
      msg:   formatScraperMsg(moduleName, raw),
    };
    SCRAPER_LOG_BUFFER.push(entry);
    if (SCRAPER_LOG_BUFFER.length > MAX_SCRAPER_LINES) SCRAPER_LOG_BUFFER.shift();
  }
}
