import { createHash } from "node:crypto";

function normalizeStableJson(candidate: unknown): unknown {
  if (Array.isArray(candidate)) return candidate.map(normalizeStableJson);
  if (!candidate || typeof candidate !== "object") return candidate;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
    const next = (candidate as Record<string, unknown>)[key];
    if (next !== undefined) output[key] = normalizeStableJson(next);
  }
  return output;
}

/** Locale-independent canonical JSON used by persisted and portable hashes. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

export function stableJsonSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}
