/**
 * Removes bearer tokens and known secret-shaped values before anything is logged or persisted.
 * Raw tool tokens must never reach logs or evidence files.
 */
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/=-]+/g;
const OPENAI_KEY = /sk-[A-Za-z0-9_-]{10,}/g;

export function redactText(text: string, extraSecrets: string[] = []): string {
  let out = text.replace(BEARER, "Bearer [REDACTED]").replace(OPENAI_KEY, "sk-[REDACTED]");
  for (const s of extraSecrets) if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out;
}

const SECRET_KEYS = /^(authorization|toolsToken|tools_token|token|apiKey|api_key|password|secret|readToken)$/i;

export function redactValue<T>(value: T, extraSecrets: string[] = []): T {
  if (typeof value === "string") return redactText(value, extraSecrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extraSecrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redactValue(v, extraSecrets);
    }
    return out as T;
  }
  return value;
}
