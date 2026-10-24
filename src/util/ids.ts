import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newRunId = (): string => randomUUID();

/** Opaque, URL-safe random token. */
export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Stable fingerprint of any JSON-serialisable value (key order independent). */
export const fingerprint = (value: unknown): string => sha256(stableStringify(value)).slice(0, 16);

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const nowIso = (): string => new Date().toISOString();
