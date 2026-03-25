import type { Listing, LogEntry, DbConfig, DiffSummary, DebugSnapshotData } from "./shared/types.js";

export interface Schedule {
  intervalMs: number;
  jobs: Array<{ id: number; moduleName: string; scheduledAt: string }>;
}

export interface PushResultsParams {
  moduleName: string;
  jobId?: number;
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

export interface HeartbeatResponse {
  ok: boolean;
  command?: string | null;
  commandId?: string | null;
  /**
   * Echo of DB `paused` after the server applies `schedulerPaused` — redundant with what the agent
   * already sent. Kept for backward compatibility and secondary sanity checks.
   * @deprecated Prefer local scheduler state (`schedulerPaused` / `isPaused`); may be removed in a future release.
   */
  paused?: boolean;
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
      throw new Error(`API ${options?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getConfig(): Promise<DbConfig> {
    return this.request<DbConfig>("/api/agent/config");
  }

  async getSchedule(): Promise<Schedule> {
    return this.request<Schedule>("/api/agent/schedule");
  }

  async cancelJobs(jobIds: number[]): Promise<void> {
    if (jobIds.length === 0) return;
    await this.request<{ ok: boolean }>("/api/agent/jobs/cancel", {
      method: "POST",
      body: JSON.stringify({ jobIds }),
    });
  }

  async startJob(jobId: number, startedAt: string): Promise<void> {
    await this.request<{ ok: boolean }>(`/api/agent/jobs/${jobId}/start`, {
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
    opts?: {
      failureMsg?: string;
      schedulerPaused: boolean;
      ackCommandId?: string;
    },
  ): Promise<HeartbeatResponse> {
    const body: Record<string, unknown> = {
      version,
      platform,
      schedulerPaused: opts?.schedulerPaused ?? false,
    };
    if (opts?.failureMsg) body.failureMsg = opts.failureMsg;
    if (opts?.ackCommandId) body.ackCommandId = opts.ackCommandId;
    return this.request<HeartbeatResponse>("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
