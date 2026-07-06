import type { JsonObject } from "../types/workspace.js";

export const PROJECT_REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(^|[^a-z0-9])(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credential|credentials|authorization|auth[-_]?header|cookie|session[-_]?token|npmrc|database[-_]?url|connection[-_]?string|dsn)([^a-z0-9]|$)/i;

const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=:.~\-]+/gi;
const CLI_SECRET_FLAG_PATTERN =
  /((?:^|[\s,;])--?(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credential|credentials|authorization|auth[-_]?header|cookie|session[-_]?token|npmrc|database[-_]?url|connection[-_]?string|dsn)(?:=|\s+))([^\s"'`,;]+)/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const KNOWN_SECRET_VALUE_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const ENV_ASSIGNMENT_PATTERN =
  /(^|[\s,;])([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|COOKIE|DSN|DATABASE_URL|CONNECTION_STRING)[A-Za-z0-9_]*)=([^\s"'`,;]+)/g;
const MAYBE_SECRET_TEXT_PATTERN =
  /:\/\/|PRIVATE KEY|Bearer\s|Basic\s|TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|COOKIE|DSN|DATABASE_URL|CONNECTION_STRING|sk-|ghp_|github_pat_|npm_|xox[baprs]-|AKIA/i;

export function isSensitiveProjectKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}

export function redactProjectText(value: string): string {
  if (!MAYBE_SECRET_TEXT_PATTERN.test(value)) return value;
  return value
    .replace(PRIVATE_KEY_PATTERN, PROJECT_REDACTED_VALUE)
    .replace(URL_CREDENTIAL_PATTERN, `$1${PROJECT_REDACTED_VALUE}@`)
    .replace(AUTH_HEADER_PATTERN, `$1 ${PROJECT_REDACTED_VALUE}`)
    .replace(CLI_SECRET_FLAG_PATTERN, `$1${PROJECT_REDACTED_VALUE}`)
    .replace(KNOWN_SECRET_VALUE_PATTERN, PROJECT_REDACTED_VALUE)
    .replace(ENV_ASSIGNMENT_PATTERN, `$1$2=${PROJECT_REDACTED_VALUE}`);
}

export function redactProjectValue<T>(value: T): T {
  return redactUnknown(value, undefined, new WeakSet<object>()) as T;
}

export function redactProjectJsonObject(value: JsonObject | null | undefined): JsonObject {
  return redactProjectValue(value ?? {}) as JsonObject;
}

function redactUnknown(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && isSensitiveProjectKey(key)) return PROJECT_REDACTED_VALUE;
  if (typeof value === "string") return redactProjectText(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactUnknown(item, key, seen));
    seen.delete(value);
    return redactedArray;
  }

  const redacted: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    redacted[childKey] = redactUnknown(childValue, childKey, seen);
  }
  seen.delete(value);
  return redacted;
}
