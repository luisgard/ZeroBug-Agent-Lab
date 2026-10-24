/**
 * MCP connector: ZeroBug acts as an MCP client of any connector server (Gmail, Outlook, Shopify,
 * Stripe…) and calls ONLY operator-allow-listed, read-only-looking tools. Results are parsed
 * deterministically (JSON field mapping, or plain text with stricter matching); no model involved.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type ExternalRecord, type EvidenceSource, type RecordKind, type RecordQuery, SourceError, WRITE_LIKE, getPath, mapItems } from "./types.ts";

export type McpQuery = {
  tool: string;
  /** Tool arguments. String values may contain {ref}, {to} and {sinceIso}; nothing else is substituted. */
  args: Record<string, unknown>;
  parse: { mode: "json"; itemsPath?: string; fields: Record<string, string> } | { mode: "text" };
};

export type McpConfig = {
  name: string;
  transport:
    | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
    | { type: "http"; url: string; headers: Record<string, string>; fetch?: typeof fetch };
  allowTools: string[];
  queries: Partial<Record<RecordKind, McpQuery>>;
  /** Optional read-only tool used to prove access (VERIFIED capability). */
  healthTool?: { tool: string; args: Record<string, unknown> };
  /** Test hook: provide a ready transport (e.g. in-memory). */
  transportFactory?: () => Transport;
};

export class McpSource implements EvidenceSource {
  readonly kind = "mcp";
  readonly name: string;
  readonly provides: RecordKind[];
  private client?: Client;

  constructor(private readonly cfg: McpConfig) {
    this.name = cfg.name;
    this.provides = Object.keys(cfg.queries) as RecordKind[];
    const used = [...Object.values(cfg.queries).map((q) => q!.tool), ...(cfg.healthTool ? [cfg.healthTool.tool] : [])];
    for (const t of used) {
      if (!cfg.allowTools.includes(t)) throw new SourceError(`${cfg.name}: tool "${t}" is not in allowTools`);
    }
    for (const t of cfg.allowTools) {
      if (WRITE_LIKE.test(t)) throw new SourceError(`${cfg.name}: tool "${t}" looks state-changing; verification sources must be read-only`);
    }
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const t = this.cfg.transport;
    const transport: Transport = this.cfg.transportFactory
      ? this.cfg.transportFactory()
      : t.type === "stdio"
        ? new StdioClientTransport({ command: t.command, args: t.args, env: { PATH: process.env.PATH ?? "", ...t.env }, ...(t.cwd ? { cwd: t.cwd } : {}), stderr: "ignore" })
        : new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers }, ...(t.fetch ? { fetch: t.fetch } : {}) });
    const client = new Client({ name: "zerobug-verifier", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((x) => x.name));
    const missing = this.cfg.allowTools.filter((x) => !names.has(x));
    if (missing.length) {
      await client.close();
      throw new SourceError(`${this.name}: server does not expose ${missing.join(", ")}`);
    }
    this.client = client;
    return client;
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; structured?: unknown }> {
    if (!this.cfg.allowTools.includes(tool)) throw new SourceError(`${this.name}: tool "${tool}" not allowed`);
    const client = await this.connect();
    const res = await client.callTool({ name: tool, arguments: args });
    if (res.isError) throw new SourceError(`${this.name}: tool ${tool} returned an error`);
    const text = ((res.content as { type: string; text?: string }[]) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    return { text, structured: res.structuredContent };
  }

  async health() {
    if (!this.cfg.healthTool) {
      try {
        await this.connect();
        return { ok: true, detail: `MCP server reachable; allowed read tools present (${this.cfg.allowTools.join(", ")})` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    }
    try {
      await this.call(this.cfg.healthTool.tool, this.cfg.healthTool.args);
      return { ok: true, detail: `read tool ${this.cfg.healthTool.tool} answered` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async fetch(kind: RecordKind, q: RecordQuery): Promise<ExternalRecord[]> {
    const query = this.cfg.queries[kind];
    if (!query) return [];
    const args = substitute(query.args, { ref: q.ref, to: q.to ?? "", sinceIso: q.since.toISOString() });
    const { text, structured } = await this.call(query.tool, args);
    if (query.parse.mode === "text") {
      // Whole tool output as one record; matching then requires every expected value to appear in it.
      return text.trim() ? [textRecord(kind, text)] : [];
    }
    let json: unknown = structured;
    if (json === undefined) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new SourceError(`${this.name}: ${query.tool} did not return JSON; use parse.mode "text"`);
      }
    }
    return mapItems(kind, getPath(json, query.parse.itemsPath), query.parse.fields);
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}

function substitute(v: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const sub = (x: unknown): unknown =>
    typeof x === "string" ? x.replace(/\{(ref|to|sinceIso)\}/g, (_, k: string) => vars[k] ?? "") : Array.isArray(x) ? x.map(sub) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, sub(y)])) : x;
  return sub(v) as Record<string, unknown>;
}

function textRecord(kind: RecordKind, text: string): ExternalRecord {
  if (kind === "email") return { raw: text, id: "text", to: text, from: text, subject: text, body: text };
  if (kind === "order") return { raw: text, id: "text", product: text, ref: text };
  return { raw: text, id: "text", ref: text };
}
