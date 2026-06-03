// Keep this list in sync with server `PII_METADATA_KEYS` in auto-scrapper/src/lib/pii-purge.ts.
export const PII_METADATA_KEYS = [
  "phone",
  "email",
  "sellerPhone",
  "contactEmail",
  "tel",
  "mobile",
  "contactPhone",
  "sellerEmail",
] as const;

const REDACTED = "[REDACTED]";
const TOKEN_QUERY_RE = /([?&](?:access_token|auth|api_key|apikey|api-key|x-api-key|key|password|secret|token)=)[^&\s]+/gi;
const SENSITIVE_QUERY_KEY_RE = /^(?:access_token|auth|api_key|apikey|api-key|x-api-key|key|password|secret|token|signature)$/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AGENT_SECRET_RE = /\bas_[A-Za-z0-9_-]{16,}\b/g;
const COOKIE_RE = /\b(cookie|set-cookie)\s*:\s*[^\r\n;]+(?:;[^\r\n]*)?/gi;
const AUTH_HEADER_RE = /\b(authorization|x-api-key|x-agent-secret)\s*:\s*[^\r\n]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\d)(?!\d{4}-\d{2}-\d{2})(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g;
function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const PII_KEY_SET = new Set<string>([
  ...PII_METADATA_KEYS,
  "authorization",
  "cookie",
  "setCookie",
  "set-cookie",
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "apikey",
  "x-api-key",
  "agentSecret",
  "agent_secret",
].map(normalizeSensitiveKey));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function redactCentralLogText(value: string): string {
  return redactUrl(value)
    .replace(AUTH_HEADER_RE, (_match, key: string) => `${key}: ${REDACTED}`)
    .replace(COOKIE_RE, (_match, key: string) => `${key}: ${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(AGENT_SECRET_RE, REDACTED)
    .replace(TOKEN_QUERY_RE, `$1${REDACTED}`)
    .replace(EMAIL_RE, REDACTED)
    .replace(PHONE_RE, REDACTED);
}

export function redactCentralLogContext(value: unknown): unknown {
  if (typeof value === "string") return redactCentralLogText(value);
  if (Array.isArray(value)) return value.map((entry) => redactCentralLogContext(entry));
  if (!isRecord(value)) return value ?? null;

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (PII_KEY_SET.has(normalizeSensitiveKey(key))) {
      out[key] = REDACTED;
    } else {
      out[key] = redactCentralLogContext(entryValue);
    }
  }
  return out;
}
