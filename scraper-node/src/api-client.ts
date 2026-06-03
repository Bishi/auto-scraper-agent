import { gzipSync } from "node:zlib";
import type {
  Listing,
  LogEntry,
  DbConfig,
  DiffSummary,
  DebugSnapshotData,
} from "./shared/types.js";
import type { CentralLogEntry } from "./central-log-queue.js";
import { normalizeServerUrl } from "./server-url.js";

function stringifyAgentApiError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isNetworkFetchFailure(raw: string): boolean {
  const normalized = raw.toLowerCase();
  return (
    normalized.includes("typeerror: fetch failed") ||
    normalized.includes("typeerror: failed to fetch")
  );
}

function isServiceUnavailableApiError(raw: string): boolean {
  return /api\s+\w+\s+.+(?:→|->)\s*503:/i.test(raw);
}

export function isTransientAgentApiError(err: unknown): boolean {
  const raw = stringifyAgentApiError(err);
  return isNetworkFetchFailure(raw) || isServiceUnavailableApiError(raw);
}

export function describeAgentApiError(err: unknown): string {
  const raw = stringifyAgentApiError(err);
  if (isNetworkFetchFailure(raw)) {
    return `could not connect to the server (${raw})`;
  }
  if (isServiceUnavailableApiError(raw))
    return "server temporarily unavailable; will retry";

  return raw;
}

async function readableApiError(
  res: Response,
  fallback: string,
): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim().length > 0) {
        return body.error.trim();
      }
    } catch {
      // Fall through to the raw response text below.
    }
    return text;
  }
  return fallback;
}

export interface Schedule {
  intervalMs: number;
  jobs: Array<{ publicId: string; moduleName: string; scheduledAt: string }>;
}

export interface PushResultsParams {
  moduleName: string;
  jobPublicId: string;
  listings: Listing[];
  logs: LogEntry[];
  filteredListings?: Listing[];
  failedUrls?: string[];
  retried?: boolean;
  debugSnapshots?: DebugSnapshotData[];
  startedAt?: string;
}

export interface PushResultsResponse {
  ok: boolean;
  summary: DiffSummary;
}

export interface PushLogsResponse {
  ok: boolean;
  accepted: number;
  duplicates: number;
  invalid: number;
}

export type ScrapeProgressPhase =
  | "job_accepted"
  | "browser_opening"
  | "browser_opened"
  | "page_loading"
  | "page_read"
  | "listings_parsed"
  | "results_uploading"
  | "job_failed";

export class AgentLogUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AgentLogUploadError";
  }
}

export type TerminalAgentCredentialCode =
  | "agent_device_revoked"
  | "agent_pairing_abandoned";

export class TerminalAgentCredentialError extends Error {
  constructor(
    message: string,
    readonly code: TerminalAgentCredentialCode,
    readonly revocationReason: string | null = null,
  ) {
    super(message);
    this.name = "TerminalAgentCredentialError";
  }
}

function isTerminalAgentCredentialCode(
  value: unknown,
): value is TerminalAgentCredentialCode {
  return (
    value === "agent_device_revoked" || value === "agent_pairing_abandoned"
  );
}

function terminalAgentCredentialErrorFromBody(
  body: unknown,
): TerminalAgentCredentialError | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;
  if (record.terminal !== true || !isTerminalAgentCredentialCode(record.code))
    return null;
  const message =
    typeof record.error === "string" && record.error.trim().length > 0
      ? record.error.trim()
      : "Agent credentials are no longer valid.";
  const revocationReason =
    typeof record.revocationReason === "string" &&
    record.revocationReason.length > 0
      ? record.revocationReason
      : null;
  return new TerminalAgentCredentialError(
    message,
    record.code,
    revocationReason,
  );
}

export function isTerminalAgentCredentialError(
  err: unknown,
): err is TerminalAgentCredentialError {
  return err instanceof TerminalAgentCredentialError;
}

export interface WsTokenResponse {
  token: string;
  /** Unix epoch seconds when the token expires. */
  expiresAt: number;
}

export interface AgentRegistrationRequest {
  displayName?: string;
  hostname?: string;
  version?: string;
  platform?: string;
}

export interface AgentRegistrationResponse {
  agentId: string;
  agentSecret: string;
}

export interface PairingConsumeResponse {
  agentId: string;
  agentSecret: string;
}

export type AgentDeviceRevocationReason =
  | "paired_to_another_account"
  | "agent_disconnected";

export interface HeartbeatResponse {
  ok: boolean;
  command?: string | null;
  commandId?: string | null;
  commandPayload?: {
    module: string;
  } | null;
  /**
   * Echo of DB `paused` after the server applies `schedulerPaused`.
   * Kept only for short-term wire compatibility; the scheduler must not use this for state decisions.
   * @deprecated Decision-making must rely on local scheduler state plus explicit commands.
   */
  paused?: boolean;
}

export interface HeartbeatOptions {
  failureMsg?: string;
  failureJobPublicId?: string;
  schedulerPaused: boolean;
  activeJobPublicId?: string | null;
  ackCommandId?: string;
  wakeSource?:
    | "startup"
    | "interval"
    | "ws_connect"
    | "ws_command"
    | "ack_followup"
    | "failure";
}

export class AgentApiClient {
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    private readonly agentId: string,
    private readonly agentSecret: string,
  ) {
    this.serverUrl = normalizeServerUrl(serverUrl);
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "X-Agent-Id": this.agentId,
        "X-Agent-Secret": this.agentSecret,
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 && text) {
        try {
          const terminalError = terminalAgentCredentialErrorFromBody(
            JSON.parse(text),
          );
          if (terminalError) throw terminalError;
        } catch (err) {
          if (isTerminalAgentCredentialError(err)) throw err;
        }
      }
      if (res.status === 429) {
        throw new Error(
          `Rate limited (429) — ${options?.method ?? "GET"} ${path} quota exceeded. Will retry next scheduled run.`,
        );
      }
      throw new Error(
        `API ${options?.method ?? "GET"} ${path} → ${res.status}: ${text}`,
      );
    }
    return res.json() as Promise<T>;
  }

  async getConfig(): Promise<DbConfig> {
    return this.request<DbConfig>("/api/agent/config");
  }

  async revokeCurrentDevice(
    reason: AgentDeviceRevocationReason,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.request<{ ok: boolean }>("/api/agent/devices/current/revoke", {
      method: "POST",
      body: JSON.stringify({ reason }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  async getWsToken(): Promise<WsTokenResponse> {
    return this.request<WsTokenResponse>("/api/agent/ws-token");
  }

  wsUrl(token: string): string {
    const url = new URL(this.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/agent/ws";
    url.search = "";
    url.searchParams.set("token", token);
    return url.toString();
  }

  async getSchedule(moduleName?: string): Promise<Schedule> {
    const query = new URLSearchParams();
    if (moduleName) query.set("module", moduleName);
    const suffix = query.toString();
    return this.request<Schedule>(
      suffix ? `/api/agent/schedule?${suffix}` : "/api/agent/schedule",
    );
  }

  async cancelJobs(jobPublicIds: string[]): Promise<void> {
    if (jobPublicIds.length === 0) return;
    await this.request<{ ok: boolean }>("/api/agent/jobs/cancel", {
      method: "POST",
      body: JSON.stringify({ jobPublicIds }),
    });
  }

  async startJob(jobPublicId: string, startedAt: string): Promise<void> {
    const enc = encodeURIComponent(jobPublicId);
    await this.request<{ ok: boolean }>(`/api/agent/jobs/${enc}/start`, {
      method: "POST",
      body: JSON.stringify({ startedAt }),
    });
  }

  async pushProgress(params: {
    agentJobPublicId: string;
    phase: ScrapeProgressPhase;
    sourceUrl?: string;
    context?: Record<string, unknown>;
    occurredAt?: string;
  }): Promise<void> {
    await this.request<{ ok: boolean }>("/api/mission-control/progress", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async pushResults(params: PushResultsParams): Promise<PushResultsResponse> {
    const compressedBody = gzipSync(JSON.stringify(params));
    return this.request<PushResultsResponse>("/api/agent/results", {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: compressedBody,
    });
  }

  async pushLogs(entries: CentralLogEntry[]): Promise<PushLogsResponse> {
    const compressedBody = gzipSync(JSON.stringify({ entries }));
    const path = "/api/agent/logs";
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: {
        "X-Agent-Id": this.agentId,
        "X-Agent-Secret": this.agentSecret,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: compressedBody,
    });
    if (!res.ok) {
      const retryAfterSeconds = Number.parseInt(
        res.headers.get("Retry-After") ?? "",
        10,
      );
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : null;
      const text = await res.text().catch(() => "");
      if (res.status === 401 && text) {
        try {
          const terminalError = terminalAgentCredentialErrorFromBody(
            JSON.parse(text),
          );
          if (terminalError) throw terminalError;
        } catch (err) {
          if (isTerminalAgentCredentialError(err)) throw err;
        }
      }
      throw new AgentLogUploadError(
        `API POST ${path} -> ${res.status}: ${text}`,
        res.status,
        retryAfterMs,
      );
    }
    return res.json() as Promise<PushLogsResponse>;
  }

  /**
   * Heartbeat: reports `schedulerPaused` (authoritative for server DB `paused`).
   * Send `ackCommandId` once after applying a pause/resume command so the server can clear pending state.
   */
  async heartbeat(
    version: string,
    platform: string,
    opts?: HeartbeatOptions,
  ): Promise<HeartbeatResponse> {
    const body: Record<string, unknown> = {
      version,
      platform,
      schedulerPaused: opts?.schedulerPaused ?? false,
    };
    if (opts?.failureMsg) body.failureMsg = opts.failureMsg;
    if (opts?.failureJobPublicId !== undefined)
      body.failureJobPublicId = opts.failureJobPublicId;
    if ("activeJobPublicId" in (opts ?? {}))
      body.activeJobPublicId = opts?.activeJobPublicId ?? null;
    if (opts?.ackCommandId) body.ackCommandId = opts.ackCommandId;
    if (opts?.wakeSource) body.wakeSource = opts.wakeSource;
    return this.request<HeartbeatResponse>("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export async function consumePairingCode(
  serverUrl: string,
  code: string,
  body: AgentRegistrationRequest,
): Promise<PairingConsumeResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/auth/agent-pairing/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, ...body }),
  });
  if (!res.ok) {
    throw new Error(
      await readableApiError(res, `Pairing failed with status ${res.status}.`),
    );
  }
  return res.json() as Promise<PairingConsumeResponse>;
}

export async function registerAgent(
  serverUrl: string,
  apiKey: string,
  body: AgentRegistrationRequest,
): Promise<AgentRegistrationResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/agent/register`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API POST /api/agent/register -> ${res.status}: ${text}`);
  }
  return res.json() as Promise<AgentRegistrationResponse>;
}
