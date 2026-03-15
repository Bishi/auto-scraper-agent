import { z } from "zod/v4";

const FiltersSchema = z.object({
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
});

const UrlEntrySchema = z.union([
  z.string().url(),
  z.object({
    url: z.string().url(),
    enabled: z.boolean().default(true),
    nickname: z.string().optional(),
    pagination: z.boolean().default(true),
    maxPages: z.number().int().positive().default(5),
    filters: FiltersSchema.optional(),
  }),
]);

const SchedulerSchema = z.object({
  enabled: z.boolean().default(false),
  /** Run interval. Supports: "30m", "1h", "2h30m", "90m" */
  interval: z.string().default("1h"),
});

/**
 * Controls which event types trigger a notification.
 * `priceDropped` is a subset of `changed` — only "changed" events where the price decreased.
 * If both `changed` and `priceDropped` are true, all changed events are included.
 * `availabilityChanged` fires when `metadata.inStock` flips (useful for product monitors).
 */
const NotifyOnSchema = z.object({
  new: z.boolean().default(true),
  priceDropped: z.boolean().default(true),
  changed: z.boolean().default(false),
  removed: z.boolean().default(true),
  reappeared: z.boolean().default(false),
  availabilityChanged: z.boolean().default(false),
});

const ModuleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  urls: z.array(UrlEntrySchema),
  options: z.record(z.string(), z.unknown()).optional(),
  notifyOn: NotifyOnSchema.optional(),
  /** Override the global Discord webhook to post this module's alerts to a different channel */
  discordWebhookUrl: z.string().url().optional(),
});

const SmtpAuthSchema = z.object({
  user: z.string(),
  pass: z.string(),
});

const EmailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  smtp: z.object({
    host: z.string(),
    port: z.number().int(),
    secure: z.boolean().default(false),
    auth: SmtpAuthSchema,
  }),
  from: z.string(),
  to: z.array(z.string().email()),
  notifyOn: NotifyOnSchema.default({ new: true, priceDropped: true, changed: false, removed: true, reappeared: false, availabilityChanged: false }),
});

const DiscordConfigSchema = z.object({
  enabled: z.boolean().default(false),
  webhookUrl: z.string().url(),
  notifyOn: NotifyOnSchema.default({ new: true, priceDropped: true, changed: false, removed: true, reappeared: false, availabilityChanged: false }),
  /** Separate webhook for error/timeout alerts (different Discord channel) */
  errorWebhookUrl: z.string().url().optional(),
  /** Separate webhook for scrape warnings (empty results, unexpected page) */
  warnWebhookUrl: z.string().url().optional(),
});

const NotificationsSchema = z.object({
  email: EmailConfigSchema.optional(),
  discord: DiscordConfigSchema.optional(),
});

const AppConfigSchema = z.object({
  browser: z.object({
    headless: z.boolean().default(true),
    slowMo: z.number().optional(),
    timeout: z.number().default(30000),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    pretty: z.boolean().default(true),
  }),
  scheduler: SchedulerSchema.optional(),
  notifications: NotificationsSchema.optional(),
  modules: z.record(z.string(), ModuleConfigSchema),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ModuleConfig = z.infer<typeof ModuleConfigSchema>;
export type UrlEntry = z.infer<typeof UrlEntrySchema>;
export type NotifyOnConfig = z.infer<typeof NotifyOnSchema>;

export interface NormalizedUrl {
  url: string;
  /** Whether this URL is active — disabled URLs are skipped during scraping */
  enabled: boolean;
  /** Optional human-readable label shown in output instead of the full URL */
  nickname?: string;
  pagination: boolean;
  maxPages: number;
  filters?: {
    priceMin?: number;
    priceMax?: number;
  };
}

export function normalizeUrlEntry(entry: UrlEntry): NormalizedUrl {
  if (typeof entry === "string") {
    return { url: entry, enabled: true, pagination: true, maxPages: 5 };
  }
  return {
    url: entry.url,
    enabled: entry.enabled,
    nickname: entry.nickname,
    pagination: entry.pagination,
    maxPages: entry.maxPages,
    filters: entry.filters,
  };
}
