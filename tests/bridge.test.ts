import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { BridgeServer } from "../src/bridge/server.ts";
import { BridgeRunRequestSchema, BridgeRunResponseSchema } from "../src/contracts/bridge.ts";
import { runScenario } from "../src/engine/run-scenario.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { HttpBridgeRunner } from "../src/runner/external.ts";
import { loadScenario } from "../src/scenarios/schema.ts";
import { newRunId } from "../src/util/ids.ts";
import { createWorld } from "../src/world/world.ts";

const local = { allowPrivate: false, allowAddresses: ["127.0.0.1"] };
let bridge: BridgeServer;
beforeAll(async () => {
  bridge = new BridgeServer();
  await bridge.start();
});
afterAll(() => bridge.stop());

const post = async (url: string, body: unknown, token?: string, raw?: string) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function register(opts: { tools?: string[]; max?: number; ttlMs?: number } = {}) {
  const runId = newRunId();
  const world = createWorld({ runId });
  const events: any[] = [];
  const reg = bridge.registerRun({
    runId,
    allowedTools: opts.tools ?? ["search_products", "add_to_cart"],
    maxToolCalls: opts.max ?? 5,
    callTool: (n, a, m) => world.tools.call(n, a, m),
    emit: (e) => events.push(e),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { runId, world, events, ...reg };
}

describe("bridge contract (GATE 1)", () => {
  test("a valid token executes a real tool round-trip recorded by the world journal", async () => {
    const r = register();
    const res = await post(`${r.toolsUrl}/add_to_cart`, { product_id: "trailmate-wp-42" }, r.toolsToken);
    expect(res).toMatchObject({ status: 200, body: { success: true } });
    expect(r.world.inspector.snapshot().cart).toHaveLength(1);
    expect(r.world.inspector.journal().some((e) => e.kind === "effect" && e.effect === "cart_item_added")).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  test("tool errors are returned to the agent, not thrown", async () => {
    const r = register();
    const res = await post(`${r.toolsUrl}/add_to_cart`, { product_id: 42 }, r.toolsToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  test("schemas reject bad versions, missing fields and extra fields", () => {
    const ok = {
      protocolVersion: "1", runId: newRunId(), task: "t", toolsUrl: "http://127.0.0.1:1/runs/x/tools", toolsToken: "a".repeat(43),
      tools: [], limits: { maxToolCalls: 1, maxSeconds: 1 },
    };
    expect(BridgeRunRequestSchema.safeParse(ok).success).toBe(true);
    expect(BridgeRunRequestSchema.safeParse({ ...ok, protocolVersion: "2" }).success).toBe(false);
    const { task: _t, ...missing } = ok;
    expect(BridgeRunRequestSchema.safeParse(missing).success).toBe(false);
    expect(BridgeRunResponseSchema.safeParse({ protocolVersion: "1", runId: ok.runId, finalMessage: "x", extra: 1 }).success).toBe(false);
  });

  test("extra (undeclared) tools are refused before execution", async () => {
    const r = register({ tools: ["search_products"] });
    const res = await post(`${r.toolsUrl}/checkout`, {}, r.toolsToken);
    expect(res.status).toBe(403);
    expect(r.world.inspector.journal()).toHaveLength(0);
  });
});

describe("bridge security (GATE 5)", () => {
  test("missing, malformed and invalid tokens are rejected before world access", async () => {
    const r = register();
    expect((await post(`${r.toolsUrl}/add_to_cart`, { product_id: "trailmate-wp-42" })).status).toBe(401);
    expect((await post(`${r.toolsUrl}/add_to_cart`, { product_id: "trailmate-wp-42" }, "short")).status).toBe(401);
    expect((await post(`${r.toolsUrl}/add_to_cart`, { product_id: "trailmate-wp-42" }, "x".repeat(43))).status).toBe(401);
    expect(r.world.inspector.journal()).toHaveLength(0);
  });

  test("a token from run A never reaches run B", async () => {
    const a = register();
    const b = register();
    const res = await post(`${b.toolsUrl}/add_to_cart`, { product_id: "trailmate-wp-42" }, a.toolsToken);
    expect(res.status).toBe(403);
    expect(b.world.inspector.journal()).toHaveLength(0);
    expect(a.world.inspector.journal()).toHaveLength(0);
  });

  test("expired tokens are rejected", async () => {
    const r = register({ ttlMs: -1 });
    expect((await post(`${r.toolsUrl}/search_products`, { query: "bag" }, r.toolsToken)).status).toBe(401);
  });

  test("replay after the run ends is denied", async () => {
    const r = register();
    expect((await post(`${r.toolsUrl}/search_products`, { query: "bag" }, r.toolsToken)).status).toBe(200);
    bridge.endRun(r.runId);
    const replay = await post(`${r.toolsUrl}/search_products`, { query: "bag" }, r.toolsToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/revoked/);
  });

  test("oversized payloads are rejected", async () => {
    const r = register();
    const res = await post(`${r.toolsUrl}/search_products`, null, r.toolsToken, JSON.stringify({ query: "x".repeat(70_000) }));
    expect(res.status).toBe(413);
    expect(r.world.inspector.journal()).toHaveLength(0);
  });

  test("no verifier, journal or state route exists, even with a valid token", async () => {
    const r = register();
    for (const path of ["/journal", "/state", "/verify", "/snapshot", "/../evidence", "/inspector"]) {
      const res = await fetch(`${bridge.url}/runs/${r.runId}${path}`, { headers: { authorization: `Bearer ${r.toolsToken}` } });
      expect(res.status, path).toBe(404);
    }
    const get = await fetch(`${r.toolsUrl}/search_products`, { headers: { authorization: `Bearer ${r.toolsToken}` } });
    expect(get.status).toBe(404);
  });

  test("tool call limit is enforced server side", async () => {
    const r = register({ max: 2 });
    for (let i = 0; i < 2; i++) expect((await post(`${r.toolsUrl}/search_products`, { query: "bag" }, r.toolsToken)).status).toBe(200);
    expect((await post(`${r.toolsUrl}/search_products`, { query: "bag" }, r.toolsToken)).status).toBe(429);
    expect(bridge.runStats(r.runId).limitExceeded).toBe(true);
  });

  test("Idempotency-Key prevents duplicate side effects from agent retries", async () => {
    const r = register();
    const send = () =>
      fetch(`${r.toolsUrl}/add_to_cart`, {
        method: "POST",
        headers: { authorization: `Bearer ${r.toolsToken}`, "idempotency-key": "k1", "content-type": "application/json" },
        body: JSON.stringify({ product_id: "trailmate-wp-42" }),
      });
    await send();
    await send();
    expect(r.world.inspector.snapshot().cart[0]!.quantity).toBe(1);
  });
});

// ---------------------------------------------------------------- runner against an in-test agent

type Behavior = (req: any) => Promise<{ status?: number; body?: unknown; hangMs?: number }>;
let agentServer: http.Server | undefined;
let agentHits = 0;
async function startAgent(behavior: Behavior): Promise<string> {
  agentHits = 0;
  agentServer = http.createServer(async (req, res) => {
    agentHits += 1;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = await behavior(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
    if (out.hangMs) await new Promise((r) => setTimeout(r, out.hangMs));
    if (res.destroyed) return;
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => agentServer!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(agentServer!.address() as AddressInfo).port}/agent/run`;
}
afterEach(async () => {
  if (agentServer) {
    agentServer.closeAllConnections();
    await new Promise<void>((r) => agentServer!.close(() => r()));
    agentServer = undefined;
  }
});

const callTool = (req: any, name: string, args: unknown) =>
  fetch(`${req.toolsUrl}/${name}`, { method: "POST", headers: { authorization: `Bearer ${req.toolsToken}` }, body: JSON.stringify(args) }).then((r) => r.json());

const run = (endpoint: string, scenario = "normal-errand") =>
  runScenario({
    scenario: { ...loadScenario(scenario), agentTransport: "any" },
    agent: { id: "t", label: "t", version: "t" },
    runner: new HttpBridgeRunner(bridge, { endpoint, policy: local }),
    judge: new HeuristicJudge(),
  });

describe("HttpBridgeRunner", () => {
  test("round-trip: agent acts through bridge, oracle verifies, PASS", async () => {
    const endpoint = await startAgent(async (req) => {
      await callTool(req, "add_to_cart", { product_id: "trailmate-wp-42" });
      return { body: { protocolVersion: "1", runId: req.runId, finalMessage: "The TrailMate Waterproof Backpack is now in your cart." } };
    });
    const r = await run(endpoint);
    expect(r.verdict).toBe("PASS");
    expect(r.journal!.filter((e) => e.kind === "tool_invocation")).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/toolsToken"\s*:\s*"[A-Za-z0-9_-]{20,}/);
  });

  test("protocol violation (bad version) is ERROR, not PASS", async () => {
    const endpoint = await startAgent(async (req) => ({ body: { protocolVersion: "9", runId: req.runId, finalMessage: "done" } }));
    const r = await run(endpoint);
    expect(r.verdict).toBe("ERROR");
    expect(r.executionReason).toMatch(/protocol violation/);
  });

  test("a token used after the run is rejected (no replay)", async () => {
    let captured: any;
    const endpoint = await startAgent(async (req) => {
      captured = req;
      return { body: { protocolVersion: "1", runId: req.runId, finalMessage: "nothing" } };
    });
    await run(endpoint);
    const late = await fetch(`${captured.toolsUrl}/add_to_cart`, { method: "POST", headers: { authorization: `Bearer ${captured.toolsToken}` }, body: "{}" });
    expect(late.status).toBe(401);
  });

  test("timeout after a side effect: agent_limit, no blind retry, single effect", async () => {
    const endpoint = await startAgent(async (req) => {
      await callTool(req, "add_to_cart", { product_id: "trailmate-wp-42" });
      return { hangMs: 3000, body: {} };
    });
    const scenario = { ...loadScenario("normal-errand"), agentTransport: "any" as const, limits: { maxToolCalls: 20, maxSeconds: 1 } };
    const r = await runScenario({ scenario, agent: { id: "t", label: "t", version: "t" }, runner: new HttpBridgeRunner(bridge, { endpoint, policy: local }), judge: new HeuristicJudge() });
    expect(r.executionStatus).toBe("agent_limit");
    expect(r.verdict).toBe("FAIL");
    expect(agentHits).toBe(1);
    expect(r.worldSnapshot!.cart[0]!.quantity).toBe(1);
  });

  test("connection refused before anything happened: one safe retry, then ERROR", async () => {
    const endpoint = "http://127.0.0.1:9/agent/run"; // discard port, nothing listens
    const r = await run(endpoint);
    expect(r.verdict).toBe("ERROR");
    expect(r.executionReason).toMatch(/ECONNREFUSED/);
  });

  test("private endpoint without explicit approval is rejected (hosted mode)", async () => {
    const endpoint = await startAgent(async () => ({ body: {} }));
    const r = await runScenario({
      scenario: { ...loadScenario("normal-errand"), agentTransport: "any" },
      agent: { id: "t", label: "t", version: "t" },
      runner: new HttpBridgeRunner(bridge, { endpoint, policy: { allowPrivate: false } }),
      judge: new HeuristicJudge(),
    });
    expect(r.verdict).toBe("ERROR");
    expect(r.executionReason).toMatch(/Endpoint rejected/);
    expect(agentHits).toBe(0);
  });

  test("agent exceeding the tool call limit is FAIL", async () => {
    const endpoint = await startAgent(async (req) => {
      for (let i = 0; i < 4; i++) await callTool(req, "search_products", { query: "bag" });
      return { body: { protocolVersion: "1", runId: req.runId, finalMessage: "done" } };
    });
    const scenario = { ...loadScenario("normal-errand"), agentTransport: "any" as const, limits: { maxToolCalls: 2, maxSeconds: 10 } };
    const r = await runScenario({ scenario, agent: { id: "t", label: "t", version: "t" }, runner: new HttpBridgeRunner(bridge, { endpoint, policy: local }), judge: new HeuristicJudge() });
    expect(r).toMatchObject({ executionStatus: "agent_limit", verdict: "FAIL" });
  });
});
