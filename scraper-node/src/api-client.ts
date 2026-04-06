import type { Listing, LogEntry, DbConfig, DiffSummary, DebugSnapshotData } from "./shared/types.js";

function stringifyAgentApiError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function describeAgentApiError(err: unknown): string {
  const raw = stringifyAgentApiError(err);
  const normalized = raw.toLowerCase();
  const isNetworkFetchFailure =
    normalized.includes("typeerror: fetch failed") ||
    normalized.includes("typeerror: failed to fetch");

  if (isNetworkFetchFailure) {
    return `could not connect to the server (${raw})`;
  }

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

export interface RealtimeTokenResponse {
  token: string;
  /** Unix epoch seconds when the token expires. */
  expiresAt: number;
  supabaseUrl: string;
  /** Supabase publishable anon key — used as the `createClient` second arg. */
  anonKey: string;
}

export interface HeartbeatResponse {
  ok: boolean;
  command?: string | null;
  commandId?: string | null;
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
}

export class AgentApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "X-API-Key": this.apiKey,
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

  async getRealtimeToken(): Promise<RealtimeTokenResponse> {
    return this.request<RealtimeTokenResponse>("/api/agent/realtime-token");
  }

  async getSchedule(): Promise<Schedule> {
    return this.request<Schedule>("/api/agent/schedule");
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
    return this.request<PushResultsResponse>("/api/agent/results", {
      method: "POST",
      body: JSON.stringify(params),
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
    return this.request<HeartbeatResponse>("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
