import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { GmailSource, parseGmailMessage } from "../src/connectors/gmail.ts";
import { HttpJsonSource } from "../src/connectors/http-json.ts";
import { McpSource } from "../src/connectors/mcp.ts";
import { SourceRegistry, SourcesFileSchema } from "../src/connectors/registry.ts";
import type { EvidenceSource } from "../src/connectors/types.ts";
import { ConnectorVerifier } from "../src/connectors/verifier.ts";
import { runRef, runScenario } from "../src/engine/run-scenario.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { BlackBoxHttpRunner } from "../src/runner/external.ts";
import { ScriptedRunner } from "../src/runner/scripted.ts";
import { parseScenario, validateScenario } from "../src/scenarios/schema.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

// ---------------------------------------------------------------- Gmail (contract test: response shapes from the Gmail API v1 reference)
function fakeGmail(messages: { id: string; to: string; subject: string; body: string }[], opts: { tokenStatus?: number } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return opts.tokenStatus ? json(opts.tokenStatus, { error: "invalid_grant" }) : json(200, { access_token: "ya29.test", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    }
    if (!(init?.headers as any)?.authorization?.startsWith("Bearer ya29.test")) return json(401, {});
    const u = new URL(url);
    if (u.pathname.endsWith("/profile")) return json(200, { emailAddress: "qa@example.test", messagesTotal: messages.length });
    if (u.pathname.endsWith("/messages")) {
      const q = u.searchParams.get("q") ?? "";
      const ref = /"([^"]+)"/.exec(q)?.[1] ?? "";
      return json(200, { messages: messages.filter((m) => m.subject.includes(ref) || m.body.includes(ref)).map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: 1 });
    }
    const id = u.pathname.split("/").pop()!;
    const m = messages.find((x) => x.id === id)!;
    return json(200, {
      id: m.id, threadId: m.id, internalDate: String(Date.now()), snippet: m.body.slice(0, 50),
      payload: { mimeType: "multipart/alternative", headers: [{ name: "To", value: m.to }, { name: "From", value: "Agent <agent@vendor.example>" }, { name: "Subject", value: m.subject }],
        parts: [{ mimeType: "text/plain", body: { data: b64(m.body) } }, { mimeType: "text/html", body: { data: b64(`<p>${m.body}</p>`) } }] },
    });
  }) as typeof fetch;
  return { f, calls };
}

describe("Gmail connector (official API shapes, no real account)", () => {
  test("parses a multipart message", () => {
    const r = parseGmailMessage({ id: "1", payload: { headers: [{ name: "To", value: "a@b.test" }, { name: "Subject", value: "Hi" }], mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("plain body") } }] }] } });
    expect(r).toMatchObject({ to: "a@b.test", subject: "Hi", body: "plain body" });
  });

  test("refreshes the token, searches by reference, only GETs Gmail", async () => {
    const { f, calls } = fakeGmail([{ id: "m1", to: "qa@example.test", subject: "Invoice INV-1 ZB-AAAA1111", body: "Total $42" }]);
    const g = new GmailSource({ name: "qa-inbox", clientId: "c", clientSecret: "s", refreshToken: "r", fetch: f });
    expect((await g.health()).ok).toBe(true);
    const recs = await g.fetch("email", { ref: "ZB-AAAA1111", since: new Date() });
    expect(recs).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST https://oauth2.googleapis.com/token"]);
  });

  test("bad OAuth credentials surface as an error, not as 'no email'", async () => {
    const { f } = fakeGmail([], { tokenStatus: 400 });
    const g = new GmailSource({ name: "qa-inbox", clientId: "c", clientSecret: "s", refreshToken: "bad", fetch: f });
    expect((await g.health()).ok).toBe(false);
    await expect(g.fetch("email", { ref: "ZB-X", since: new Date() })).rejects.toThrow(/OAuth refresh failed/);
  });
});

// ---------------------------------------------------------------- verifier semantics
const rec = () => "ev-1";
const sourceOf = (records: any[] | (() => Promise<any[]> | any[]), provides: any[] = ["email", "order", "payment"]): EvidenceSource => ({
  name: "src", kind: "fake", provides, fetch: async () => (typeof records === "function" ? records() : records), health: async () => ({ ok: true, detail: "" }),
});
const check = (c: any) => ({ id: "c1", critical: true, informational: false, requireRef: true, waitSeconds: 0, ...c });
const verifier = (s: EvidenceSource, now?: () => number) =>
  new ConnectorVerifier(rec, SourceRegistry.of({ src: s }), { ref: "ZB-REF00001", since: new Date(), customerEmail: "c@x.test", pollMs: 5, ...(now ? { now } : {}) });

describe("connector verifier", () => {
  test("email: pass only with recipient + reference + subject", async () => {
    const good = { id: "1", to: "Ava <qa@example.test>", from: "x", subject: "Invoice ZB-REF00001", body: "" };
    const v = verifier(sourceOf([good]));
    expect((await v.verify(check({ type: "email_received", source: "src", to: "qa@example.test", subjectContains: "Invoice" }), "r")).status).toBe("pass");
    const wrongTo = verifier(sourceOf([{ ...good, to: "other@example.test" }]));
    const r = await wrongTo.verify(check({ type: "email_received", source: "src", to: "qa@example.test" }), "r");
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/recipient is/);
  });

  test("old mail without this run's reference never counts", async () => {
    const v = verifier(sourceOf([{ id: "1", to: "qa@example.test", from: "", subject: "Invoice", body: "" }]));
    expect((await v.verify(check({ type: "email_received", source: "src", to: "qa@example.test" }), "r")).status).toBe("fail");
  });

  test("polls until the email arrives (asynchronous delivery)", async () => {
    let n = 0;
    const v = verifier(sourceOf(() => (++n < 3 ? [] : [{ id: "1", to: "qa@example.test", from: "", subject: "ZB-REF00001", body: "" }])));
    const r = await v.verify(check({ type: "email_received", source: "src", to: "qa@example.test", waitSeconds: 5 }), "r");
    expect(r.status).toBe("pass");
    expect(n).toBe(3);
  });

  test("unreadable source is inconclusive, never a fail or pass", async () => {
    const v = verifier(sourceOf(() => { throw new Error("HTTP 503"); }));
    const r = await v.verify(check({ type: "email_received", source: "src", to: "qa@example.test" }), "r");
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toMatch(/Absence is not assumed/);
  });

  test("unconfigured source is unsupported", async () => {
    expect((await verifier(sourceOf([])).verify(check({ type: "order_exists", source: "nope" }), "r")).status).toBe("unsupported");
  });

  test("order and payment matching", async () => {
    const v = verifier(sourceOf([{ id: "o1", product: "TrailMate Waterproof Backpack", quantity: 1, total: 42, status: "paid", ref: "ZB-REF00001" }]));
    expect((await v.verify(check({ type: "order_exists", source: "src", productContains: "trailmate", quantity: 1, maxTotal: 50 }), "r")).status).toBe("pass");
    expect((await v.verify(check({ type: "order_exists", source: "src", maxTotal: 40 }), "r")).status).toBe("fail");
    const p = verifier(sourceOf([{ id: "pi_1", amount: 4200, currency: "usd", status: "succeeded", ref: "ZB-REF00001" }]));
    expect((await p.verify(check({ type: "payment_exists", source: "src", amount: 4200, currency: "USD", status: "succeeded" }), "r")).status).toBe("pass");
    expect((await p.verify(check({ type: "payment_exists", source: "src", amount: 999 }), "r")).status).toBe("fail");
  });
});

// ---------------------------------------------------------------- HTTP JSON (real HTTP, local server)
let api: http.Server;
let apiUrl = "";
beforeAll(async () => {
  api = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer sk_test_ro") { res.writeHead(401); return res.end("{}"); }
    const ref = new URL(req.url!, "http://x").searchParams.get("ref");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ref === "ZB-REF00001" ? [{ id: "pi_9", amount: 4200, currency: "usd", status: "succeeded", metadata: { zb_ref: ref } }] : [] }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

describe("HTTP JSON connector", () => {
  test("maps items with declared field paths (Stripe-like shape)", async () => {
    const s = new HttpJsonSource({
      name: "payments", headers: { Authorization: "Bearer sk_test_ro" }, healthUrl: `${apiUrl}/health?ref=x`,
      queries: { payment: { url: `${apiUrl}/v1/payment_intents/search?ref={ref}`, itemsPath: "data", fields: { id: "id", amount: "amount", currency: "currency", status: "status", ref: "metadata.zb_ref" } } },
    });
    expect((await s.health()).ok).toBe(true);
    expect(await s.fetch("payment", { ref: "ZB-REF00001", since: new Date() })).toEqual([{ id: "pi_9", amount: 4200, currency: "usd", status: "succeeded", ref: "ZB-REF00001" }]);
  });
  test("refuses plain-http remote evidence URLs", () => {
    expect(() => new HttpJsonSource({ name: "x", headers: {}, queries: { order: { url: "http://shop.example/orders?ref={ref}", fields: {} } } })).toThrow(/https/);
  });
});

// ---------------------------------------------------------------- MCP (real MCP protocol, in-memory transport)
function mcpServer(emails: any[]) {
  const server = new McpServer({ name: "mail-connector", version: "1.0.0" });
  server.registerTool("search_emails", { description: "Search mail", inputSchema: { query: z.string() } }, async ({ query }) => ({
    content: [{ type: "text", text: JSON.stringify({ results: emails.filter((e) => JSON.stringify(e).includes(query)) }) }],
  }));
  server.registerTool("send_email", { description: "Send", inputSchema: { to: z.string() } }, async () => ({ content: [{ type: "text", text: "sent" }] }));
  return server;
}
const mcpSource = (emails: any[], extra: Partial<ConstructorParameters<typeof McpSource>[0]> = {}) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  void mcpServer(emails).connect(serverT);
  return new McpSource({
    name: "mail-mcp", transport: { type: "http", url: "http://unused.invalid", headers: {} }, transportFactory: () => clientT,
    allowTools: ["search_emails"],
    queries: { email: { tool: "search_emails", args: { query: "{ref}" }, parse: { mode: "json", itemsPath: "results", fields: { id: "id", to: "to", subject: "subject", body: "text" } } } },
    ...extra,
  });
};

describe("MCP connector (ZeroBug as MCP client)", () => {
  test("calls the allow-listed read tool and maps JSON results", async () => {
    const s = mcpSource([{ id: "e1", to: "qa@example.test", subject: "Invoice ZB-REF00001", text: "hi" }]);
    expect((await s.health()).ok).toBe(true);
    const recs = await s.fetch("email", { ref: "ZB-REF00001", since: new Date() });
    expect(recs).toEqual([{ id: "e1", to: "qa@example.test", from: "", subject: "Invoice ZB-REF00001", body: "hi", date: "" }]);
    await s.close();
  });
  test("write-like tools cannot be allow-listed; unlisted tools cannot be used", () => {
    expect(() => mcpSource([], { allowTools: ["search_emails", "send_email"] })).toThrow(/state-changing/);
    expect(() => mcpSource([], { queries: { email: { tool: "read_all", args: {}, parse: { mode: "text" } } } })).toThrow(/not in allowTools/);
  });
});

// ---------------------------------------------------------------- engine + scenario integration
describe("connector checks in the engine", () => {
  const yaml = (task: string) => `schemaVersion: 1\nid: inv\ntitle: Invoice\ntask: "${task}"\napps: [outbox]\nruns: 1\nchecks:\n  - { id: got-it, type: email_received, source: qa-inbox, to: qa@example.test, subjectContains: INV-7, waitSeconds: 1, critical: true }\n`;

  test("scenarios with reference-bound checks must put {ref} in the task", () => {
    expect(() => parseScenario(yaml("Send invoice INV-7"), "x.yaml")).toThrow(/\{ref\}/);
    expect(parseScenario(yaml("Send invoice INV-7 with reference {ref}"), "x.yaml").goals).toEqual(["got-it"]);
  });

  test("agent's claim is checked against the real inbox record", async () => {
    const inbox: any[] = [];
    const scenario = parseScenario(yaml("Send invoice INV-7 with reference {ref}"), "x.yaml");
    const sendingAgent = new ScriptedRunner(async (api) => {
      const ref = /ZB-[0-9A-F]{8}/.exec(api.task)![0];
      inbox.push({ id: "m1", to: "qa@example.test", from: "agent", subject: `INV-7 ${ref}`, body: "" });
      return "Sent.";
    });
    const sources = SourceRegistry.of({ "qa-inbox": sourceOf(() => inbox) });
    const ok = await runScenario({ scenario, agent: { id: "a", label: "a", version: "1" }, runner: sendingAgent, judge: new HeuristicJudge(), sources, connectorPollMs: 10 });
    expect(ok.verdict).toBe("PASS");
    expect(ok.ref).toBe(runRef(ok.runId));
    expect(ok.checks[0]!.verifier).toBe("connectors");

    const liar = new ScriptedRunner([{ say: "Sent the invoice!" }]);
    const bad = await runScenario({ scenario, agent: { id: "b", label: "b", version: "1" }, runner: liar, judge: new HeuristicJudge(), sources, connectorPollMs: 10 });
    expect(bad.verdict).toBe("FAIL");

    const none = await runScenario({ scenario, agent: { id: "c", label: "c", version: "1" }, runner: liar, judge: new HeuristicJudge() });
    expect(none.verdict).toBe("INCONCLUSIVE");
  });

  test("sources file holds env var names only and is strictly validated", () => {
    const ok = SourcesFileSchema.safeParse({ sources: { "qa-inbox": { kind: "gmail", clientIdEnv: "ZB_GMAIL_CLIENT_ID", clientSecretEnv: "ZB_GMAIL_CLIENT_SECRET", refreshTokenEnv: "ZB_GMAIL_REFRESH_TOKEN" } } });
    expect(ok.success).toBe(true);
    expect(SourcesFileSchema.safeParse({ sources: { x: { kind: "gmail", clientId: "literal-secret" } } }).success).toBe(false);
    const reg = new SourceRegistry(ok.data!, {});
    expect(() => reg.get("qa-inbox")).toThrow(/ZB_GMAIL_CLIENT_ID is not set/);
  });

  test("black-box agent + real-system verifier through the same engine", async () => {
    const inbox: any[] = [];
    const srv = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const { message } = JSON.parse(Buffer.concat(chunks).toString());
      inbox.push({ id: "m", to: "qa@example.test", from: "a", subject: `Invoice INV-7 ${/ZB-[0-9A-F]{8}/.exec(message)![0]}`, body: "" });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ reply: "I sent it." }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/chat`;
    const scenario = { ...validateScenario({ schemaVersion: 1, id: "bb", title: "bb", task: "Send invoice INV-7 with reference {ref}", apps: ["outbox"], checks: [{ id: "got", type: "email_received", source: "qa-inbox", to: "qa@example.test", waitSeconds: 1 }] }, "bb") };
    const r = await runScenario({
      scenario, agent: { id: "bb", label: "bb", version: "1" }, judge: new HeuristicJudge(), connectorPollMs: 10,
      runner: new BlackBoxHttpRunner({ endpoint: url, mapping: { taskField: "message", responseField: "reply" }, policy: { allowPrivate: false, allowAddresses: ["127.0.0.1"] } }),
      sources: SourceRegistry.of({ "qa-inbox": sourceOf(() => inbox) }),
    });
    srv.close();
    expect(r.verdict).toBe("PASS");
  });
});

describe("example sources file", () => {
  test("zerobug.sources.example.json is valid", async () => {
    const { readFileSync } = await import("node:fs");
    expect(SourcesFileSchema.safeParse(JSON.parse(readFileSync("zerobug.sources.example.json", "utf8"))).success).toBe(true);
  });
});

describe("email_received extensions", () => {
  test("{ref} recipient, exactly-once and duplicates", async () => {
    const mail = (id: string) => ({ id, to: "qa+ZB-REF00001@example.test", from: "a", subject: "Hello ZB-REF00001", body: "", date: new Date().toISOString() });
    const one = verifier(sourceOf([mail("1")]));
    const c = check({ type: "email_received", source: "src", to: "qa+{ref}@example.test", exactly: 1, waitSeconds: 0 });
    expect((await one.verify(c, "r")).status).toBe("pass");
    const two = await verifier(sourceOf([mail("1"), mail("2")])).verify(c, "r");
    expect(two.status).toBe("fail");
    expect(two.reason).toMatch(/duplicates/);
  });
  test("time-window correlation when the email cannot carry the reference", async () => {
    const old = { id: "o", to: "qa@example.test", from: "jobs-noreply@linkedin.com", subject: "Your application was sent", body: "", date: new Date(Date.now() - 3_600_000).toISOString() };
    const fresh = { ...old, id: "n", date: new Date().toISOString() };
    const c = check({ type: "email_received", source: "src", to: "qa@example.test", fromContains: "linkedin", requireRef: false, waitSeconds: 0 });
    expect((await verifier(sourceOf([old])).verify(c, "r")).status).toBe("fail");
    const r = await verifier(sourceOf([old, fresh])).verify(c, "r");
    expect(r.status).toBe("pass");
    expect(r.reason).toMatch(/time window only/);
  });
});
