import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Ephemeral shared secret generated once per sidecar process.
 * Written to stdout on startup so the Rust watchdog can capture it.
 * Required as X-Sidecar-Token on all HTTP requests (except OPTIONS and /health).
 */
export const SIDECAR_TOKEN = randomBytes(32).toString("hex");

/**
 * Returns true when the request headers contain the correct sidecar token.
 * Case-sensitive exact match — no timing-safe compare needed for a localhost
 * secret that is regenerated on every process start.
 */
export function isAuthorized(headers: IncomingHttpHeaders): boolean {
  return headers["x-sidecar-token"] === SIDECAR_TOKEN;
}
