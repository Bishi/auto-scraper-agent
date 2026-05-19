import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentApiClient, PushLogsResponse } from "./api-client.js";
import { redactCentralLogContext, redactCentralLogText } from "./central-log-redaction.js";

// Duplicated deliberately from the server contract. Keep in sync with auto-scrapper/src/lib/agent-logs.ts.
export const AGENT_LOG_LEVELS = [20, 30, 40, 50, 60] as const;
export const AGENT_LOG_COMPONENTS = [
  "agent",
  "setup",
  "config",
  "scheduler",
  "heartbeat",
  "ws",
  "command",
  "update",
  "scrape",
  "system",
] as const;
export const AGENT_LOG_WAKE_SOURCES = [
  "startup",
  "interval",
  "ws_connect",
  "ws_command",
  "ack_followup",
  "failure",
] as const;

type AgentLogLevel = (typeof AGENT_LOG_LEVELS)[number];
type AgentLogComponent = (typeof AGENT_LOG_COMPONENTS)[number];
type AgentLogWakeSource = (typeof AGENT_LOG_WAKE_SOURCES)[number];

export interface CentralLogEntry {
  clientLogId: string;
  occurredAt: string;
  level: AgentLogLevel;
  component: AgentLogComponent;
  event?: string;
  message: string;
  context?: unknown;
  commandId?: string;
  agentJobPublicId?: string;
  scrapeRunPublicId?: string;
  wakeSource?: AgentLogWakeSource;
}

interface UploadErrorLike extends Error {
  status?: number;
  retryAfterMs?: number;
}

const LOG_DIR = join(homedir(), ".auto-scraper", "logs");
const SPOOL_FILE = join(LOG_DIR, "central-agent-logs.ndjson");
const MAX_SPOOL_ENTRIES = 5_000;
const MAX_SPOOL_BYTES = 2 * 1024 * 1024;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 15_000;

let client: AgentApiClient | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let startupFlushTimer: ReturnType<typeof setTimeout> | null = null;
let spoolPersistTimer: ReturnType<typeof setTimeout> | null = null;
let spoolDirty = false;
let disabledForSession = false;
let flushing = false;
let backoffUntil = 0;
let backoffMs = 5_000;
let overflowEpisodeCount = 0;
let localWarningSink: ((message: string) => void) | null = null;
let entries: CentralLogEntry[] = loadSpool();

export function configureCentralLogWarningSink(sink: ((message: string) => void) | null): void {
  localWarningSink = sink;
}

function isComponent(value: unknown): value is AgentLogComponent {
  return typeof value === "string" && AGENT_LOG_COMPONENTS.includes(value as AgentLogComponent);
}

function isWakeSource(value: unknown): value is AgentLogWakeSource {
  return typeof value === "string" && AGENT_LOG_WAKE_SOURCES.includes(value as AgentLogWakeSource);
}

function normalizeLevel(level: number): AgentLogLevel {
  if (level >= 60) return 60;
  if (level >= 50) return 50;
  if (level >= 40) return 40;
  if (level >= 30) return 30;
  return 20;
}

function safeJsonLine(entry: CentralLogEntry): string {
  return JSON.stringify(entry);
}

function loadSpool(): CentralLogEntry[] {
  try {
    if (!existsSync(SPOOL_FILE)) return [];
    return readFileSync(SPOOL_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CentralLogEntry];
        } catch {
          return [];
        }
      })
      .slice(-MAX_SPOOL_ENTRIES);
  } catch {
    return [];
  }
}

function persistSpool(): void {
  spoolDirty = false;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    let next = entries.slice(-MAX_SPOOL_ENTRIES);
    while (Buffer.byteLength(next.map(safeJsonLine).join("\n"), "utf8") > MAX_SPOOL_BYTES && next.length > 1) {
      next = next.slice(1);
    }
    entries = next;
    writeFileSync(SPOOL_FILE, `${next.map(safeJsonLine).join("\n")}${next.length ? "\n" : ""}`, "utf8");
  } catch {
    // Local UI/file logging is independent; central log persistence is best effort.
  }
}

function schedulePersistSpool(delayMs = 250): void {
  spoolDirty = true;
  if (spoolPersistTimer) return;
  spoolPersistTimer = setTimeout(() => {
    spoolPersistTimer = null;
    if (spoolDirty) persistSpool();
  }, delayMs);
}

function flushSpoolPersist(): void {
  if (spoolPersistTimer) {
    clearTimeout(spoolPersistTimer);
    spoolPersistTimer = null;
  }
  if (spoolDirty) persistSpool();
}

function appendOverflowSummary(): void {
  overflowEpisodeCount += 1;
  const existingIndex = entries.findIndex((entry) => entry.event === "central_log_overflow");
  const summary: CentralLogEntry = {
    clientLogId: randomUUID(),
    occurredAt: new Date().toISOString(),
    level: 40,
    component: "system",
    event: "central_log_overflow",
    message: `Central log spool overflowed; older entries were dropped (${overflowEpisodeCount} episode${overflowEpisodeCount === 1 ? "" : "s"}).`,
    context: { overflowEpisodeCount },
  };
  if (existingIndex >= 0) {
    entries[existingIndex] = summary;
  } else {
    entries.push(summary);
  }
}

function enforceCap(): void {
  let overflowed = false;
  while (entries.length > MAX_SPOOL_ENTRIES) {
    entries.shift();
    overflowed = true;
  }
  while (Buffer.byteLength(entries.map(safeJsonLine).join("\n"), "utf8") > MAX_SPOOL_BYTES && entries.length > 1) {
    entries.shift();
    overflowed = true;
  }
  if (overflowed) appendOverflowSummary();
}

export function enqueueCentralAgentLog(raw: {
  level: number;
  time: number;
  msg: string;
  component?: unknown;
  event?: unknown;
  wakeSource?: unknown;
  commandId?: unknown;
  agentJobPublicId?: unknown;
  scrapeRunPublicId?: unknown;
  [key: string]: unknown;
}): void {
  if (disabledForSession || !raw.msg) return;
  const {
    level,
    time,
    msg,
    component,
    event,
    wakeSource,
    commandId,
    agentJobPublicId,
    scrapeRunPublicId,
    ...context
  } = raw;
  const entry: CentralLogEntry = {
    clientLogId: randomUUID(),
    occurredAt: new Date(time).toISOString(),
    level: normalizeLevel(level),
    component: isComponent(component) ? component : "agent",
    ...(typeof event === "string" && event ? { event } : {}),
    message: redactCentralLogText(msg).slice(0, 2_000),
    context: redactCentralLogContext(context),
    ...(typeof commandId === "string" ? { commandId } : {}),
    ...(typeof agentJobPublicId === "string" ? { agentJobPublicId } : {}),
    ...(typeof scrapeRunPublicId === "string" ? { scrapeRunPublicId } : {}),
    ...(isWakeSource(wakeSource) ? { wakeSource } : {}),
  };
  entries.push(entry);
  enforceCap();
  schedulePersistSpool();
  if (entries.length >= BATCH_SIZE) void flushCentralLogs();
}

export function configureCentralLogUpload(nextClient: AgentApiClient): void {
  client = nextClient;
  disabledForSession = false;
  if (timer) clearInterval(timer);
  if (startupFlushTimer) clearTimeout(startupFlushTimer);
  timer = setInterval(() => void flushCentralLogs(), FLUSH_INTERVAL_MS);
  startupFlushTimer = setTimeout(() => {
    startupFlushTimer = null;
    void flushCentralLogs();
  }, 1_000);
}

export function stopCentralLogUpload(): void {
  client = null;
  if (timer) clearInterval(timer);
  if (startupFlushTimer) clearTimeout(startupFlushTimer);
  timer = null;
  startupFlushTimer = null;
  flushSpoolPersist();
}

export function centralLogQueueSize(): number {
  return entries.length;
}

export function resetCentralLogQueueForTests(): void {
  entries = [];
  client = null;
  disabledForSession = false;
  flushing = false;
  backoffUntil = 0;
  backoffMs = 5_000;
  overflowEpisodeCount = 0;
  if (timer) clearInterval(timer);
  if (startupFlushTimer) clearTimeout(startupFlushTimer);
  if (spoolPersistTimer) clearTimeout(spoolPersistTimer);
  timer = null;
  startupFlushTimer = null;
  spoolPersistTimer = null;
  spoolDirty = false;
  persistSpool();
}

function dropBatch(batchSize: number): void {
  entries = entries.slice(batchSize);
  persistSpool();
}

function warnDroppedLogs(reason: string, count: number): void {
  if (count <= 0) return;
  const message = `[central-logs] Dropped ${count} queued central log${count === 1 ? "" : "s"}: ${reason}.`;
  if (localWarningSink) {
    localWarningSink(message);
    return;
  }
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Best effort only; central upload failures must not affect the agent loop.
  }
}

function dropBatchWithWarning(batchSize: number, reason: string): void {
  const count = Math.min(batchSize, entries.length);
  dropBatch(count);
  warnDroppedLogs(reason, count);
}

function markRetry(error: UploadErrorLike): void {
  const retryAfter = error.retryAfterMs ?? 0;
  const delay = retryAfter > 0 ? retryAfter : backoffMs;
  backoffUntil = Date.now() + delay;
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

function isRetryableUploadError(error: UploadErrorLike): boolean {
  return error.status == null || error.status === 429 || error.status >= 500;
}

async function uploadBatch(batch: CentralLogEntry[]): Promise<PushLogsResponse> {
  if (!client) throw new Error("Central log upload is not configured");
  return client.pushLogs(batch);
}

export async function flushCentralLogs(): Promise<void> {
  if (!client || disabledForSession || flushing || entries.length === 0) return;
  if (Date.now() < backoffUntil) return;
  flushing = true;
  const batch = entries.slice(0, BATCH_SIZE);
  try {
    const response = await uploadBatch(batch);
    const removeCount = Math.min(batch.length, response.accepted + response.duplicates + response.invalid);
    dropBatch(removeCount);
    backoffMs = 5_000;
  } catch (error) {
    const uploadError = error as UploadErrorLike;
    if (uploadError.status === 400) {
      dropBatchWithWarning(batch.length, "server rejected the central log batch as invalid");
    } else if (uploadError.status === 401 || uploadError.status === 403 || uploadError.status === 404) {
      disabledForSession = true;
    } else if (uploadError.status === 413) {
      if (batch.length > 1) {
        const half = Math.max(1, Math.floor(batch.length / 2));
        try {
          const response = await uploadBatch(batch.slice(0, half));
          dropBatch(Math.min(half, response.accepted + response.duplicates + response.invalid));
          backoffMs = 5_000;
        } catch (splitError) {
          const splitUploadError = splitError as UploadErrorLike;
          if (isRetryableUploadError(splitUploadError)) {
            markRetry(splitUploadError);
          } else if (
            splitUploadError.status === 401 ||
            splitUploadError.status === 403 ||
            splitUploadError.status === 404
          ) {
            disabledForSession = true;
          } else if (splitUploadError.status === 400) {
            dropBatchWithWarning(half, "server rejected split central log payload as invalid");
          } else if (splitUploadError.status === 413) {
            dropBatchWithWarning(1, "central log entry was too large to upload");
          } else {
            markRetry(splitUploadError);
          }
        }
      } else {
        dropBatchWithWarning(1, "central log entry was too large to upload");
      }
    } else {
      markRetry(uploadError);
    }
  } finally {
    flushing = false;
  }
}
