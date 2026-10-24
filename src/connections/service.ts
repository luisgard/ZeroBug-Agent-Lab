/**
 * Connections: evidence sources that a person adds from the UI (as opposed to zerobug.sources.json,
 * which an operator edits). Secrets are encrypted at rest and never returned by the API.
 * Every connection is health-checked with a real read when it is added or tested.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { GmailSource } from "../connectors/gmail.ts";
import { HttpJsonSource } from "../connectors/http-json.ts";
import { McpSource } from "../connectors/mcp.ts";
import { type EvidenceSource, FIELD_PATH, type RecordKind, SourceError, WRITE_LIKE } from "../connectors/types.ts";
import { type NetPolicy, guardedFetch, safeFetch, validateUrl } from "../net/safe-fetch.ts";
import { newToken, nowIso } from "../util/ids.ts";
import { CATALOG } from "./catalog.ts";
import type { SecretBox } from "./secret-box.ts";

// ---------------------------------------------------------------- input schemas

const Name = z.string().trim().min(2).max(60);
const Kind = z.enum(["email", "order", "payment"]);
const Fields = z.partialRecord(
  z.enum(["id", "to", "from", "subject", "body", "date", "product", "quantity", "total", "status", "ref", "amount", "currency"]),
  z.string().regex(FIELD_PATH),
);

export const CreateConnectionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gmail"),
    name: Name.optional(),
    clientId: z.string().min(10).max(300),
    clientSecret: z.string().min(5).max(300),
    refreshToken: z.string().min(10).max(2000),
  }),
  z.strictObject({
    type: z.literal("stripe_test"),
    name: Name.default("Stripe test"),
    apiKey: z.string().regex(/^(rk|sk)_test_[A-Za-z0-9]{10,}$/, "Only Stripe TEST keys (rk_test_… or sk_test_…) are accepted"),
  }),
  z.strictObject({
    type: z.literal("http_json"),
    name: Name,
    kind: Kind,
    url: z.string().url().refine((u) => u.includes("{ref}"), "The URL must contain {ref} so each test finds its own record"),
    itemsPath: z.string().regex(FIELD_PATH).optional(),
    fields: Fields,
    headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/).optional(),
    headerValue: z.string().max(2000).optional(),
    healthUrl: z.string().url().optional(),
  }),
  z.strictObject({
    type: z.literal("mcp_http"),
    name: Name,
    url: z.string().url(),
    authorization: z.string().max(2000).optional(),
    kind: Kind,
    tool: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()).default({}),
    parse: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("json"), itemsPath: z.string().regex(FIELD_PATH).optional(), fields: Fields }),
      z.strictObject({ mode: z.literal("text") }),
    ]),
  }),
]);
export type CreateConnection = z.input<typeof CreateConnectionSchema>;

// ---------------------------------------------------------------- persisted shape

export type ConnectionStatus = { state: "VERIFIED" | "UNAVAILABLE"; detail: string; checkedAt: string };

type StoredConnection = {
  id: string;
  slug: string;
  type: "gmail" | "stripe_test" | "http_json" | "mcp_http";
  name: string;
  createdAt: string;
  provides: RecordKind[];
  /** Non-secret settings, safe to show. */
  config: Record<string, unknown>;
  /** Encrypted secrets (SecretBox). */
  secrets: string;
  status: ConnectionStatus;
};

export type PublicConnection = Omit<StoredConnection, "secrets">;

export class ConnectionError extends Error {}

export class ConnectionService {
  private readonly oauthStates = new Map<string, number>();

  constructor(
    private readonly box: SecretBox,
    private readonly opts: {
      file?: string;
      policy: () => NetPolicy;
      env?: NodeJS.ProcessEnv;
      /** Test hook for Google endpoints. */
      googleFetch?: typeof fetch;
    },
  ) {}

  private get file() {
    return this.opts.file ?? "data/connections.json";
  }
  private get env() {
    return this.opts.env ?? process.env;
  }

  private load(): StoredConnection[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, "utf8")).connections ?? [];
  }

  private save(list: StoredConnection[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, connections: list }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  catalog() {
    const googleReady = Boolean(this.env.ZB_GOOGLE_CLIENT_ID && this.env.ZB_GOOGLE_CLIENT_SECRET);
    return { entries: CATALOG, googleOAuthConfigured: googleReady };
  }

  list(): PublicConnection[] {
    return this.load().map(({ secrets: _s, ...pub }) => pub);
  }

  async create(input: unknown): Promise<PublicConnection> {
    const parsed = CreateConnectionSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionError(parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
    const c = parsed.data;
    const list = this.load();
    let stored: StoredConnection;
    const base = { id: newToken(9), createdAt: nowIso(), status: { state: "UNAVAILABLE" as const, detail: "not tested yet", checkedAt: nowIso() } };
    if (c.type === "gmail") {
      stored = { ...base, slug: "", type: "gmail", name: c.name ?? "Gmail", provides: ["email"], config: {}, secrets: this.box.seal({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken }) };
    } else if (c.type === "stripe_test") {
      stored = { ...base, slug: "", type: "stripe_test", name: c.name, provides: ["payment"], config: { account: "Stripe test mode", key: `${c.apiKey.slice(0, 8)}…` }, secrets: this.box.seal({ apiKey: c.apiKey }) };
    } else if (c.type === "http_json") {
      await this.checkUrl(c.url.replaceAll("{ref}", "ZB-TEST"));
      if (c.healthUrl) await this.checkUrl(c.healthUrl);
      stored = {
        ...base, slug: "", type: "http_json", name: c.name, provides: [c.kind],
        config: { kind: c.kind, url: c.url, itemsPath: c.itemsPath, fields: c.fields, headerName: c.headerName, healthUrl: c.healthUrl },
        secrets: this.box.seal({ headerValue: c.headerValue ?? "" }),
      };
    } else {
      await this.checkUrl(c.url);
      if (WRITE_LIKE.test(c.tool)) throw new ConnectionError(`Tool "${c.tool}" looks state-changing; verification tools must be read-only`);
      stored = {
        ...base, slug: "", type: "mcp_http", name: c.name, provides: [c.kind],
        config: { url: c.url, kind: c.kind, tool: c.tool, args: c.args, parse: c.parse },
        secrets: this.box.seal({ authorization: c.authorization ?? "" }),
      };
    }
    stored.slug = uniqueSlug(stored.name, list.map((x) => x.slug));
    stored.status = await this.health(stored);
    if (stored.type === "gmail" && stored.status.state === "VERIFIED") {
      const email = /access to (\S+)/.exec(stored.status.detail)?.[1];
      if (email && !c.name) {
        stored.name = `Gmail (${email})`;
        stored.slug = uniqueSlug(`gmail-${email.split("@")[0]}`, list.map((x) => x.slug));
      }
      stored.config = { account: email ?? "unknown" };
    }
    this.save([...list, stored]);
    const { secrets: _s, ...pub } = stored;
    return pub;
  }

  async test(id: string): Promise<PublicConnection> {
    const list = this.load();
    const conn = list.find((x) => x.id === id);
    if (!conn) throw new ConnectionError("Connection not found");
    conn.status = await this.health(conn);
    this.save(list);
    const { secrets: _s, ...pub } = conn;
    return pub;
  }

  remove(id: string): { removed: boolean } {
    const list = this.load();
    const next = list.filter((x) => x.id !== id);
    this.save(next);
    return { removed: next.length !== list.length };
  }

  /** Evidence sources for runs, keyed by slug (what scenarios use as `source:`). */
  sources(): Record<string, EvidenceSource> {
    const out: Record<string, EvidenceSource> = {};
    for (const c of this.load()) {
      try {
        out[c.slug] = this.build(c);
      } catch {
        /* a broken connection simply stays unavailable */
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Google OAuth (gmail.readonly)

  googleAuthUrl(redirectUri: string): string {
    const clientId = this.env.ZB_GOOGLE_CLIENT_ID;
    if (!clientId || !this.env.ZB_GOOGLE_CLIENT_SECRET) {
      throw new ConnectionError("Google sign-in is not configured on this server (ZB_GOOGLE_CLIENT_ID / ZB_GOOGLE_CLIENT_SECRET). See docs/CONNECTORS.md.");
    }
    const state = newToken(18);
    const now = Date.now();
    for (const [k, exp] of this.oauthStates) if (exp < now) this.oauthStates.delete(k);
    this.oauthStates.set(state, now + 10 * 60_000);
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }

  async googleCallback(params: { code?: string | null; state?: string | null; error?: string | null }, redirectUri: string): Promise<PublicConnection> {
    if (params.error) throw new ConnectionError(`Google sign-in was cancelled or failed: ${params.error}`);
    const exp = params.state ? this.oauthStates.get(params.state) : undefined;
    if (!params.state || !exp || exp < Date.now()) throw new ConnectionError("Sign-in link expired or invalid. Please try again.");
    this.oauthStates.delete(params.state);
    if (!params.code) throw new ConnectionError("Google did not return an authorization code");
    const f = this.opts.googleFetch ?? fetch;
    const res = await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.code,
        client_id: this.env.ZB_GOOGLE_CLIENT_ID!,
        client_secret: this.env.ZB_GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string };
    if (!res.ok) throw new ConnectionError(`Google token exchange failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (!body.refresh_token) throw new ConnectionError("Google did not return a refresh token. Remove ZeroBug's access in your Google account and connect again.");
    if (body.scope && !body.scope.includes("gmail.readonly")) throw new ConnectionError("The read-only Gmail permission was not granted.");
    return this.create({ type: "gmail", clientId: this.env.ZB_GOOGLE_CLIENT_ID!, clientSecret: this.env.ZB_GOOGLE_CLIENT_SECRET!, refreshToken: body.refresh_token });
  }

  // ---------------------------------------------------------------- internals

  private async checkUrl(url: string) {
    try {
      await validateUrl(url, this.opts.policy());
    } catch (err) {
      throw new ConnectionError(`URL not allowed: ${(err as Error).message}`);
    }
  }

  private async health(c: StoredConnection): Promise<ConnectionStatus> {
    let src: EvidenceSource | undefined;
    try {
      src = this.build(c);
      const h = await src.health();
      return { state: h.ok ? "VERIFIED" : "UNAVAILABLE", detail: h.detail, checkedAt: nowIso() };
    } catch (err) {
      return { state: "UNAVAILABLE", detail: (err as Error).message, checkedAt: nowIso() };
    } finally {
      await src?.close?.();
    }
  }

  private build(c: StoredConnection): EvidenceSource {
    const s = this.box.open<Record<string, string>>(c.secrets);
    const cfg = c.config as any;
    const guardedFetch = policyFetch(this.opts.policy);
    if (c.type === "gmail") {
      return new GmailSource({ name: c.slug, clientId: s.clientId!, clientSecret: s.clientSecret!, refreshToken: s.refreshToken!, ...(this.opts.googleFetch ? { fetch: this.opts.googleFetch } : {}) });
    }
    if (c.type === "stripe_test") {
      const q = encodeURIComponent("metadata['zb_ref']:'");
      return new HttpJsonSource({
        name: c.slug,
        headers: { Authorization: `Bearer ${s.apiKey}` },
        healthUrl: "https://api.stripe.com/v1/balance",
        queries: {
          payment: {
            url: `https://api.stripe.com/v1/payment_intents/search?query=${q}{ref}${encodeURIComponent("'")}`,
            itemsPath: "data",
            fields: { id: "id", amount: "amount", currency: "currency", status: "status", ref: "metadata.zb_ref" },
          },
        },
      });
    }
    if (c.type === "http_json") {
      return new HttpJsonSource({
        name: c.slug,
        headers: cfg.headerName && s.headerValue ? { [cfg.headerName]: s.headerValue } : {},
        ...(cfg.healthUrl ? { healthUrl: cfg.healthUrl } : {}),
        queries: { [cfg.kind]: { url: cfg.url, ...(cfg.itemsPath ? { itemsPath: cfg.itemsPath } : {}), fields: cfg.fields ?? {} } },
        fetch: guardedFetch,
      });
    }
    return new McpSource({
      name: c.slug,
      allowTools: [cfg.tool],
      queries: { [cfg.kind]: { tool: cfg.tool, args: cfg.args ?? {}, parse: cfg.parse } },
      transport: {
        type: "http",
        url: cfg.url,
        headers: s.authorization ? { Authorization: s.authorization } : {},
        fetch: (async (input: any, init?: any) => {
          await validateUrl(String(input instanceof Request ? input.url : input), this.opts.policy());
          return fetch(input, { ...init, redirect: "error" });
        }) as typeof fetch,
      },
    });
  }
}

/** fetch() that goes through the SSRF-safe client: validated, pinned, no redirects, bounded. */
export const policyFetch = (policy: () => NetPolicy): typeof fetch => guardedFetch(policy);

function uniqueSlug(name: string, taken: string[]): string {
  let base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "source";
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  let slug = base;
  for (let i = 2; taken.includes(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export { SourceError };
