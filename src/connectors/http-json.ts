/**
 * Read-only JSON API connector for order and payment systems (a store's staging API, Stripe in
 * test mode, a third party's verification endpoint). GET only. The operator declares the URL
 * template (only the {ref} placeholder is substituted, URL-encoded), where the list of items is,
 * and which field holds each normalized value.
 */
import { type ExternalRecord, type EvidenceSource, type RecordKind, type RecordQuery, SourceError, getPath, mapItems } from "./types.ts";

export type HttpJsonQuery = { url: string; itemsPath?: string; fields: Record<string, string> };

export type HttpJsonConfig = {
  name: string;
  headers: Record<string, string>;
  queries: Partial<Record<RecordKind, HttpJsonQuery>>;
  healthUrl?: string;
  fetch?: typeof fetch;
};

export class HttpJsonSource implements EvidenceSource {
  readonly kind = "http_json";
  readonly name: string;
  readonly provides: RecordKind[];
  private readonly f: typeof fetch;

  constructor(private readonly cfg: HttpJsonConfig) {
    this.name = cfg.name;
    this.provides = Object.keys(cfg.queries) as RecordKind[];
    this.f = cfg.fetch ?? fetch;
    for (const q of Object.values(cfg.queries)) {
      const u = new URL(q!.url.replaceAll("{ref}", "ZB-TEST"));
      if (u.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(u.hostname)) {
        throw new SourceError(`${cfg.name}: evidence URLs must use https (got ${u.protocol})`);
      }
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.f(url, { method: "GET", headers: this.cfg.headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new SourceError(`${this.name}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) throw new SourceError(`${this.name}: response too large`);
    return JSON.parse(text);
  }

  async health() {
    const url = this.cfg.healthUrl;
    if (!url) return { ok: false, detail: "no healthUrl configured; access is DECLARED, not verified" };
    try {
      await this.getJson(url);
      return { ok: true, detail: `authenticated GET ${new URL(url).origin} succeeded` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async fetch(kind: RecordKind, q: RecordQuery): Promise<ExternalRecord[]> {
    const query = this.cfg.queries[kind];
    if (!query) return [];
    const json = await this.getJson(query.url.replaceAll("{ref}", encodeURIComponent(q.ref)));
    return mapItems(kind, getPath(json, query.itemsPath), query.fields);
  }
}
