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

  async pushResults(params: PushResultsParams): Promise<PushResultsResponse> {
    return this.request<PushResultsResponse>("/api/agent/results", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async heartbeat(
    version: string,
    platform: string,
    failureMsg?: string,
  ): Promise<{ ok: boolean; command?: string | null; paused?: boolean }> {
    return this.request<{ ok: boolean; command?: string | null; paused?: boolean }>("/api/agent/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        version,
        platform,
        ...(failureMsg ? { failureMsg } : {}),
      }),
    });
  }
}
