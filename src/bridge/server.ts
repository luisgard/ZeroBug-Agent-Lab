/**
 * ZeroBug test host: run-scoped tool endpoints for instrumented external agents.
 *
 * The only route is `POST /runs/<runId>/tools/<toolName>`. It authenticates the bearer token
 * BEFORE reading the body or touching world state. Tokens are opaque, stored hashed, scoped to one
 * run, an allow-list of tools and a TTL, and revoked when the run ends. There is no verifier,
 * journal or state route on this server: the agent can act, never inspect.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Emit, ToolOutcome } from "../contracts/index.ts";
import { newToken, nowIso, sha256 } from "../util/ids.ts";

type Grant = {
  runId: string;
  allowedTools: Set<string>;
  expiresAt: number;
  revoked: boolean;
  maxToolCalls: number;
  calls: number;
  limitExceeded: boolean;
  callTool: (name: string, args: unknown, meta: { callId: string }) => Promise<ToolOutcome>;
  emit: Emit;
  idempotent: Map<string, ToolOutcome>;
};

export type AuthFailure = { status: 401 | 403; reason: string };

export class RunTokenStore {
  private readonly byHash = new Map<string, Grant>();

  issue(grant: Omit<Grant, "revoked" | "calls" | "limitExceeded" | "idempotent">): string {
    const token = newToken();
    this.byHash.set(sha256(token), { ...grant, revoked: false, calls: 0, limitExceeded: false, idempotent: new Map() });
    return token;
  }

  authenticate(rawAuth: string | undefined, runId: string, tool: string, now = Date.now()): Grant | AuthFailure {
    const m = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(rawAuth ?? "");
    if (!m) return { status: 401, reason: "Missing or malformed bearer token" };
    const grant = this.byHash.get(sha256(m[1]!));
    if (!grant) return { status: 401, reason: "Invalid token" };
    if (grant.revoked) return { status: 401, reason: "Token revoked: run has ended" };
    if (now > grant.expiresAt) return { status: 401, reason: "Token expired" };
    if (grant.runId !== runId) return { status: 403, reason: "Token is not valid for this run" };
    if (!grant.allowedTools.has(tool)) return { status: 403, reason: `Tool not allowed for this run: ${tool}` };
    return grant;
  }

  forRun(runId: string): Grant | undefined {
    for (const g of this.byHash.values()) if (g.runId === runId && !g.revoked) return g;
    return undefined;
  }

  revoke(runId: string): void {
    for (const g of this.byHash.values()) if (g.runId === runId) g.revoked = true;
  }
}

export type BridgeServerOptions = {
  host?: string;
  port?: number;
  /** Base URL the agent must use to reach this server (e.g. a TLS tunnel). Defaults to http://host:port. */
  publicBaseUrl?: string;
  maxBodyBytes?: number;
  tokenTtlMs?: number;
};

export type RegisteredRun = { toolsUrl: string; toolsToken: string };

export class BridgeServer {
  readonly tokens = new RunTokenStore();
  private server?: http.Server;
  private baseUrl = "";
  private callSeq = 0;

  constructor(private readonly opts: BridgeServerOptions = {}) {}

  async start(): Promise<string> {
    const host = this.opts.host ?? "127.0.0.1";
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 0, host, r));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = this.opts.publicBaseUrl ?? `http://${host}:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  get url(): string {
    return this.baseUrl;
  }

  registerRun(r: {
    runId: string;
    allowedTools: string[];
    maxToolCalls: number;
    callTool: Grant["callTool"];
    emit: Emit;
    ttlMs?: number;
  }): RegisteredRun {
    if (!this.baseUrl) throw new Error("Bridge server is not started");
    const toolsToken = this.tokens.issue({
      runId: r.runId,
      allowedTools: new Set(r.allowedTools),
      expiresAt: Date.now() + (r.ttlMs ?? this.opts.tokenTtlMs ?? 10 * 60_000),
      maxToolCalls: r.maxToolCalls,
      callTool: r.callTool,
      emit: r.emit,
    });
    return { toolsUrl: `${this.baseUrl}/runs/${r.runId}/tools`, toolsToken };
  }

  runStats(runId: string): { calls: number; limitExceeded: boolean } {
    const g = this.tokens.forRun(runId);
    return { calls: g?.calls ?? 0, limitExceeded: g?.limitExceeded ?? false };
  }

  endRun(runId: string): { calls: number; limitExceeded: boolean } {
    const stats = this.runStats(runId);
    this.tokens.revoke(runId);
    return stats;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url ?? "/", "http://bridge.invalid").pathname;
      const m = /^\/runs\/([0-9a-f-]{36})\/tools\/([a-z][a-z0-9_]{0,63})$/.exec(path);
      if (!m || req.method !== "POST") {
        req.resume();
        return send(404, { success: false, error: "Not found" });
      }
      const [, runId, tool] = m as unknown as [string, string, string];
      // Authenticate before reading the body or touching any world state.
      const auth = this.tokens.authenticate(req.headers.authorization, runId, tool);
      if ("status" in auth) {
        req.resume();
        return send(auth.status, { success: false, error: auth.reason });
      }
      const grant = auth;
      const max = this.opts.maxBodyBytes ?? 64 * 1024;
      if (Number(req.headers["content-length"] ?? 0) > max) {
        req.resume();
        return send(413, { success: false, error: `Payload exceeds ${max} bytes` });
      }
      const raw = await readBody(req, max);
      if (raw === null) return send(413, { success: false, error: `Payload exceeds ${max} bytes` });
      let args: unknown;
      try {
        args = raw.length ? JSON.parse(raw) : {};
      } catch {
        return send(400, { success: false, error: "Body must be JSON tool arguments" });
      }

      const idemKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 128) : undefined;
      if (idemKey && grant.idempotent.has(`${tool}:${idemKey}`)) {
        return send(200, grant.idempotent.get(`${tool}:${idemKey}`));
      }

      grant.calls += 1;
      const callId = `bridge-${++this.callSeq}`;
      grant.emit({ type: "tool_call", timestamp: nowIso(), runId, callId, tool, args });
      let outcome: ToolOutcome;
      if (grant.calls > grant.maxToolCalls) {
        grant.limitExceeded = true;
        outcome = { success: false, error: `Tool call limit exceeded (${grant.maxToolCalls})` };
        grant.emit({ type: "tool_result", timestamp: nowIso(), runId, callId, ok: false, error: outcome.error });
        return send(429, outcome);
      }
      outcome = await grant.callTool(tool, args, { callId });
      grant.emit({
        type: "tool_result",
        timestamp: nowIso(),
        runId,
        callId,
        ok: outcome.success,
        ...(outcome.success ? { result: outcome.output } : { error: outcome.error }),
      });
      if (idemKey) grant.idempotent.set(`${tool}:${idemKey}`, outcome);
      return send(200, outcome);
    } catch (err) {
      return send(500, { success: false, error: "Internal bridge error" });
    }
  }
}

function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
