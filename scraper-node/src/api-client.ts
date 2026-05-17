import { gzipSync } from "node:zlib";
import type { Listing, LogEntry, DbConfig, DiffSummary, DebugSnapshotData } from "./shared/types.js";

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
  if (isServiceUnavailableApiError(raw)) return "server temporarily unavailable; will retry";

  return raw;
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
  wakeSource?: "startup" | "interval" | "ws_connect" | "ws_command" | "ack_followup" | "failure";
}

export class AgentApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly agentId: string,
    private readonly agentSecret: string,
  ) {}

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
      if (res.status === 429) {
        throw new Error(`Rate limited (429) — ${options?.method ?? "GET"} ${path} quota exceeded. Will retry next scheduled run.`);
      }
      throw new Error(`API ${options?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getConfig(): Promise<DbConfig> {
    return this.request<DbConfig>("/api/agent/config");
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
    return this.request<Schedule>(suffix ? `/api/agent/schedule?${suffix}` : "/api/agent/schedule");
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

  async pushResults(params: PushResultsParams): Promise<PushResultsResponse> {
    const compressedBody = gzipSync(JSON.stringify(params));
    return this.request<PushResultsResponse>("/api/agent/results", {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: compressedBody,
    });
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
    if (opts?.failureJobPublicId !== undefined) body.failureJobPublicId = opts.failureJobPublicId;
    if ("activeJobPublicId" in (opts ?? {})) body.activeJobPublicId = opts?.activeJobPublicId ?? null;
    if (opts?.ackCommandId) body.ackCommandId = opts.ackCommandId;
    if (opts?.wakeSource) body.wakeSource = opts.wakeSource;
    return this.request<HeartbeatResponse>("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export async function registerAgent(
  serverUrl: string,
  apiKey: string,
  body: AgentRegistrationRequest,
): Promise<AgentRegistrationResponse> {
  const res = await fetch(`${serverUrl}/api/agent/register`, {
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
