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

export interface DbConfig {
  browser?: { headless?: boolean; slowMo?: number; timeout?: number };
  logging?: { level?: string; pretty?: boolean };
  modules?: Record<string, DbModuleConfig>;
}
