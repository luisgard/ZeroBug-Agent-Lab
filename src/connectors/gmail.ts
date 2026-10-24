/**
 * Gmail connector (official Gmail REST API v1, OAuth 2.0 refresh token, scope gmail.readonly).
 * Only GET requests are made to Gmail; the token endpoint is the only POST.
 *
 * Endpoints used:
 *   POST https://oauth2.googleapis.com/token                         (refresh_token -> access_token)
 *   GET  https://gmail.googleapis.com/gmail/v1/users/me/profile
 *   GET  https://gmail.googleapis.com/gmail/v1/users/me/messages?q=...
 *   GET  https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full
 */
import { type EmailRecord, type EvidenceSource, type RecordKind, type RecordQuery, SourceError } from "./types.ts";

export type GmailConfig = {
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Which mailbox to read. "me" = the authorized account. */
  userId?: string;
  maxMessages?: number;
  fetch?: typeof fetch;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users";

export class GmailSource implements EvidenceSource {
  readonly kind = "gmail";
  readonly provides: RecordKind[] = ["email"];
  readonly name: string;
  private access?: { token: string; expiresAt: number };
  private readonly f: typeof fetch;

  constructor(private readonly cfg: GmailConfig) {
    this.name = cfg.name;
    this.f = cfg.fetch ?? fetch;
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token;
    const res = await this.f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; scope?: string };
    if (!res.ok || !body.access_token) throw new SourceError(`Gmail OAuth refresh failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (body.scope && /mail\.google\.com\/?($|\s)|gmail\.(modify|send|compose|insert)/.test(body.scope) && !/gmail\.readonly/.test(body.scope)) {
      // Not fatal, but recorded: verification only ever issues GET requests.
      console.warn(`[zerobug] Gmail source "${this.name}" token has write scopes (${body.scope}). Use gmail.readonly.`);
    }
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  private async get(path: string): Promise<any> {
    const res = await this.f(`${API}/${encodeURIComponent(this.cfg.userId ?? "me")}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new SourceError(`Gmail API ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  }

  async health() {
    try {
      const p = await this.get("/profile");
      return { ok: true, detail: `read access to ${p.emailAddress ?? "mailbox"} confirmed (Gmail API profile)` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async fetch(kind: RecordKind, q: RecordQuery): Promise<EmailRecord[]> {
    if (kind !== "email") return [];
    // Gmail search: exact reference, newer than the run start (after: takes epoch seconds).
    const after = Math.floor(q.since.getTime() / 1000) - 60;
    const query = `"${q.ref}" after:${after}${q.to ? ` to:${q.to}` : ""} in:anywhere`;
    const list = await this.get(`/messages?maxResults=${this.cfg.maxMessages ?? 20}&q=${encodeURIComponent(query)}`);
    const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
    const out: EmailRecord[] = [];
    for (const id of ids) out.push(parseGmailMessage(await this.get(`/messages/${encodeURIComponent(id)}?format=full`)));
    return out;
  }
}

/** Converts a Gmail `users.messages.get?format=full` resource to a normalized email record. */
export function parseGmailMessage(m: any): EmailRecord {
  const headers: { name: string; value: string }[] = m?.payload?.headers ?? [];
  const h = (n: string) => headers.filter((x) => x.name.toLowerCase() === n).map((x) => x.value).join(", ");
  return {
    id: String(m.id),
    to: [h("to"), h("cc"), h("delivered-to")].filter(Boolean).join(", "),
    from: h("from"),
    subject: h("subject"),
    body: extractBody(m.payload) || m.snippet || "",
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : h("date"),
  };
}

function extractBody(part: any): string {
  if (!part) return "";
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  const parts: any[] = part.parts ?? [];
  const plain = parts.map((p) => extractBody(p)).find(Boolean);
  if (plain) return plain;
  if (part.mimeType === "text/html" && part.body?.data) return decode(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}
