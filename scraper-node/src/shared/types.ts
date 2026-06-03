export interface Listing {
  sourceId: string;
  moduleName: string;
  sourceUrl: string;
  /** Optional human-readable label for the source URL, set from config `nickname` */
  sourceUrlNickname?: string;
  listingUrl: string;
  title: string;
  price: number | null;
  metadata: Record<string, string | number | boolean | null>;
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: unknown;
}

export interface DiffSummary {
  new: number;
  changed: number;
  removed: number;
  reappeared: number;
  repost?: number;
  total: number;
}

export interface DbModuleConfig {
  enabled: boolean;
  urls: Array<
    | string
    | {
        url: string;
        enabled?: boolean;
        nickname?: string;
        pagination?: boolean;
        maxPages?: number;
        filters?: { priceMin?: number; priceMax?: number };
      }
  >;
  options?: Record<string, unknown>;
}

export interface DebugSnapshotData {
  moduleName: string;
  sourceUrl: string;
  /** "redirect" | "selector_broken" | "bot_block" */
  errorType: "redirect" | "selector_broken" | "bot_block";
  errorMsg: string;
  /** Raw page HTML, truncated to 2 MB before upload. */
  html: string;
  capturedAt: string; // ISO 8601
  /** True when this snapshot was captured before a CF managed-challenge retry. */
  preRetry?: boolean;
}

export interface DbConfig {
  browser?: { headless?: boolean; slowMo?: number; timeout?: number };
  logging?: { level?: string; pretty?: boolean };
  modules?: Record<string, DbModuleConfig>;
}
